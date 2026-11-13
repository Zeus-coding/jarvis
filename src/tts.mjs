// J.A.R.V.I.S. — Sintesi vocale lato server, con tre livelli:
//   1. ElevenLabs (se c'è la chiave): voce britannica molto realistica;
//   2. voce neurale Microsoft gratuita (servizio Python con edge-tts);
//   3. se nessuna risponde, il browser usa la sua voce (lo decide l'interfaccia quando riceve un errore).
// Ogni frase sintetizzata viene salvata su disco: le frasi ricorrenti non costano niente la seconda volta.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { VOICE_URL, ttsDir } from "./config.mjs";
import { db, key } from "./store.mjs";
import { briefing } from "./agenda.mjs";

const ELEVEN_VOICE = () => key("ELEVENLABS_VOICE_ID") || "onwK4e9ZLuTAKqWW03F9"; // "Daniel": britannica, profonda
const ELEVEN_MODEL = (quality) => (quality === "high" ? "eleven_multilingual_v2" : "eleven_flash_v2_5");
const pause = (ms) => new Promise((ok) => setTimeout(ok, ms));

// ---------------------------------------------------------------- ElevenLabs (al massimo 2 richieste insieme)
let elevenPausedUntil = 0, running = 0;
const waiting = [];
async function acquire(urgent) {
  if (running < 2) { running++; return; }
  await new Promise((go) => (urgent ? waiting.unshift(go) : waiting.push(go)));
  running++;
}
function release() { running--; waiting.shift()?.(); }

export async function elevenTTS(text, quality = "fast", apiKey = key("ELEVENLABS_API_KEY")) {
  await acquire(quality !== "high"); // le risposte al momento passano davanti alle frasi preparate in anticipo
  try {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${ELEVEN_VOICE()}?output_format=mp3_44100_128`, {
        method: "POST",
        headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
        body: JSON.stringify({ text, model_id: ELEVEN_MODEL(quality), language_code: "it", voice_settings: { stability: 0.5, similarity_boost: 0.85, style: 0.12, use_speaker_boost: true } }),
        signal: AbortSignal.timeout(20_000),
      }).catch(() => null);
      if (res?.ok) return Buffer.from(await res.arrayBuffer());
      if (res?.status === 429) { await pause(800 * attempt); continue; } // troppe richieste: si aspetta un attimo
      const detail = res ? (await res.text()).slice(0, 200) : "rete non raggiungibile";
      throw Object.assign(new Error(`ElevenLabs ${res?.status || ""} ${detail}`.trim()), { status: res?.status });
    }
    throw new Error("ElevenLabs è occupato");
  } finally {
    release();
  }
}

// ---------------------------------------------------------------- voce neurale gratuita
// Passa dai server Microsoft: se due volte di fila è lenta o fallisce, per 5 minuti si lascia la parola al browser.
let neuralPausedUntil = 0, strikes = 0;
async function neuralTTS(text, quality) {
  if (Date.now() < neuralPausedUntil) throw new Error("voce neurale in pausa (rete lenta)");
  const s = db.settings, started = Date.now();
  try {
    const res = await fetch(`${VOICE_URL}/tts`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice: s.ttsVoice, rate: s.ttsRate, pitch: s.ttsPitch }),
      signal: AbortSignal.timeout(quality === "high" ? 15_000 : 4_000), // le frasi del momento non possono far aspettare
    });
    if (!res.ok) throw new Error(`voce neurale non disponibile (${res.status})`);
    const audio = Buffer.from(await res.arrayBuffer());
    strikes = Date.now() - started > 3000 ? strikes + 1 : 0;
    return audio;
  } catch (e) {
    strikes++;
    throw e;
  } finally {
    if (strikes >= 2) {
      strikes = 0;
      neuralPausedUntil = Date.now() + 5 * 60_000;
      console.warn("[voce] la voce gratuita è lenta o non risponde: per 5 minuti parla il browser");
    }
  }
}

// ---------------------------------------------------------------- frase → audio (con cache in memoria e su disco)
const memory = new Map();
export function tts(text, quality = "fast") {
  const eleven = Boolean(key("ELEVENLABS_API_KEY")) && Date.now() > elevenPausedUntil;
  const s = db.settings;
  const voiceId = eleven ? `eleven|${ELEVEN_VOICE()}|${ELEVEN_MODEL(quality)}` : `neural|${s.ttsVoice}|${s.ttsRate}|${s.ttsPitch}`;
  const id = createHash("sha1").update(`${voiceId}|${text}`).digest("hex");
  if (memory.has(id)) return memory.get(id);
  const file = join(ttsDir, `${id}.mp3`);
  const job = readFile(file).catch(async () => {
    let audio;
    if (eleven) {
      try { audio = await elevenTTS(text, quality); }
      catch (e) {
        console.warn(`[voce] ${e.message} → uso la voce gratuita`);
        if ([401, 402].includes(e.status) || /quota|credit/i.test(e.message)) elevenPausedUntil = Date.now() + 10 * 60_000;
        return neuralTTS(text, quality); // non si salva: è una voce diversa da quella richiesta
      }
    } else audio = await neuralTTS(text, quality);
    await mkdir(ttsDir, { recursive: true }).then(() => writeFile(file, audio)).catch(() => {});
    return audio;
  });
  memory.set(id, job);
  job.catch(() => memory.delete(id));
  if (memory.size > 300) memory.delete(memory.keys().next().value);
  return job;
}

// il saluto viene sintetizzato appena Jarvis si accende, così al risveglio la voce parte subito
export async function warmBriefing(attempt = 0) {
  try { for (const line of (await briefing()).lines) await tts(line.text, "high"); }
  catch { if (attempt < 20) setTimeout(() => warmBriefing(attempt + 1), 1500); }
}

export function resetVoice() { elevenPausedUntil = 0; neuralPausedUntil = 0; strikes = 0; }
