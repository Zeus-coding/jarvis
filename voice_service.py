"""J.A.R.V.I.S. — servizio vocale locale (lo avvia server.mjs, ascolta solo su 127.0.0.1).

  GET  /health      stato del servizio
  POST /tts         {"text", "voice", "rate", "pitch"} -> audio MP3 (voce neurale Microsoft tramite edge-tts)
  POST /transcribe  audio webm/opus -> {"text"} (faster-whisper, facoltativo: npm run setup -- --whisper)
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS = os.path.join(os.environ.get("JARVIS_DATA_DIR") or os.path.join(HERE, "data"), "models")
WHISPER_SIZE = os.environ.get("WHISPER_MODEL", "base")
DEFAULT_VOICE = "it-IT-DiegoNeural"

# Whisper si carica in sottofondo: la voce funziona subito anche se il riconoscimento non è pronto o non c'è.
whisper = {"model": None, "status": "in caricamento"}

# Frasi che Whisper "sente" quando c'è solo silenzio o rumore (residui dei sottotitoli con cui è stato addestrato).
PHANTOMS = re.compile(
    r"sottotitol|amara\.org|iscriviti al canale|grazie (?:a tutti )?per (?:la )?(?:visione|l'attenzione)"
    r"|a cura di|\bmusica\b|\[[^\]]*\]|\([^)]*\)|♪|www\.|\.com\b|alla prossima|benvenuti",
    re.IGNORECASE,
)


def log(message: str) -> None:
    print(f"[voice] {message}", flush=True)


def load_whisper() -> None:
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        whisper["status"] = "non installato (facoltativo)"
        return
    try:
        os.makedirs(MODELS, exist_ok=True)
        whisper["model"] = WhisperModel(WHISPER_SIZE, device="cpu", compute_type="int8", download_root=MODELS)
        whisper["status"] = "pronto"
        log(f"Whisper {WHISPER_SIZE} pronto")
    except Exception as exc:  # pragma: no cover - dipende dall'hardware
        whisper["status"] = f"non disponibile: {exc}"
        log(f"Whisper non disponibile: {exc}")


async def speak(text: str, voice: str, rate: str, pitch: str) -> bytes:
    import edge_tts

    chunks = bytearray()
    async for part in edge_tts.Communicate(text, voice, rate=rate, pitch=pitch).stream():
        if part["type"] == "audio":
            chunks += part["data"]
    return bytes(chunks)


# Voci italiane di riserva, in ordine di preferenza. Microsoft ogni tanto smette di servire una voce
# (è successo con Giuseppe Multilingual): se quella scelta non risponde si passa alla successiva.
FALLBACK_VOICES = ["it-IT-DiegoNeural", "it-IT-IsabellaNeural", "it-IT-ElsaNeural"]
broken_voices: set[str] = set()


def synthesize(text: str, voice: str, rate: str, pitch: str) -> bytes:
    candidates = [v for v in [voice, *FALLBACK_VOICES] if v not in broken_voices]
    candidates = list(dict.fromkeys(candidates)) or FALLBACK_VOICES[:1]
    error: Exception | None = None
    for name in candidates[:3]:
        try:
            audio = asyncio.run(speak(text, name, rate, pitch))
            if audio:
                return audio
            raise RuntimeError("nessun audio generato")
        except Exception as exc:
            error = exc
            # "No audio was received" = voce non servita: non si riprova più per questa sessione
            if "No audio" in str(exc) or "nessun audio" in str(exc):
                if name not in broken_voices:
                    log(f"la voce {name} non risponde: passo a un'altra voce italiana")
                broken_voices.add(name)
            else:
                time.sleep(0.3)  # errore di rete passeggero: si prova la voce successiva
    raise error or RuntimeError("nessun audio generato")


def transcribe(path: str) -> dict:
    segments, info = whisper["model"].transcribe(
        path, language="it", beam_size=1, vad_filter=True, condition_on_previous_text=False,
        vad_parameters={"min_silence_duration_ms": 400, "speech_pad_ms": 200},
        no_speech_threshold=0.5, initial_prompt="Ciao Jarvis.",
    )
    kept = [
        s.text.strip() for s in segments
        if s.text.strip() and s.no_speech_prob <= 0.55 and s.avg_logprob >= -1.0 and not PHANTOMS.search(s.text)
    ]
    return {"text": " ".join(kept).strip(), "language": info.language}


class Handler(BaseHTTPRequestHandler):
    def send(self, status: int, payload, content_type: str = "application/json") -> None:
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        try:
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # il server di Jarvis ha smesso di aspettare (voce troppo lenta): nessun problema

    def read_body(self) -> bytes:
        return self.rfile.read(int(self.headers.get("Content-Length") or 0))

    def do_GET(self) -> None:
        if self.path != "/health":
            return self.send(404, {"error": "non trovato"})
        self.send(200, {"ok": True, "tts": True, "whisper": whisper["model"] is not None, "model": f"whisper-{WHISPER_SIZE}", "error": None if whisper["model"] else whisper["status"]})

    def do_POST(self) -> None:
        if self.path == "/tts":
            return self.handle_tts()
        if self.path == "/transcribe":
            return self.handle_transcribe()
        self.send(404, {"error": "non trovato"})

    def handle_tts(self) -> None:
        try:
            req = json.loads(self.read_body() or b"{}")
            text = (req.get("text") or "").strip()
            if not text:
                return self.send(400, {"error": "testo vuoto"})
            audio = synthesize(text[:1500], req.get("voice") or DEFAULT_VOICE, req.get("rate") or "+0%", req.get("pitch") or "+0Hz")
            self.send(200, audio, "audio/mpeg")
        except Exception as exc:
            log(f"voce non riuscita: {exc}")
            self.send(502, {"error": str(exc)})

    def handle_transcribe(self) -> None:
        if whisper["model"] is None:
            return self.send(503, {"error": f"Whisper {whisper['status']}"})
        audio, path = self.read_body(), None
        try:
            with tempfile.NamedTemporaryFile(delete=False, suffix=".webm") as tmp:
                tmp.write(audio)
                path = tmp.name
            self.send(200, transcribe(path))
        except Exception as exc:
            self.send(500, {"error": str(exc)})
        finally:
            if path and os.path.exists(path):
                os.unlink(path)

    def log_message(self, *_args) -> None:  # niente log per ogni richiesta
        pass


if __name__ == "__main__":
    port = int(os.environ.get("JARVIS_VOICE_PORT", "8765"))
    threading.Thread(target=load_whisper, daemon=True).start()
    log(f"servizio vocale su http://127.0.0.1:{port}")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
