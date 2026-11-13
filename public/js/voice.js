// Audio di J.A.R.V.I.S.: Speaker (la sua voce), Listener (il tuo microfono), Music (sottofondo), sfx (effetti sintetizzati).
export const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
const out = audioCtx.createGain();
out.connect(audioCtx.destination);
const ANDROID = /Android/i.test(navigator.userAgent);
const PHONE = ANDROID || /iPhone|iPad|iPod/i.test(navigator.userAgent);
// Browser che hanno l'oggetto del riconoscimento vocale ma non lo fanno funzionare (non hanno accesso al servizio di Google)
export const VOICE_UNSUPPORTED = /OPR\/|Opera|Vivaldi|YaBrowser/i.test(navigator.userAgent) || Boolean(navigator.brave);
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;

// ======================================================================== Speaker
// Coda di frasi: ogni frase viene sintetizzata dal server (in anticipo, mentre la precedente suona)
// e riprodotta attraverso un analizzatore che misura il volume per animare la sfera.
export class Speaker {
  constructor({ onLevel, onSentence, onIdle } = {}) {
    this.onLevel = onLevel; this.onSentence = onSentence; this.onIdle = onIdle;
    this.queue = [];
    this.current = null;
    this.streaming = false; // true mentre arrivano ancora frasi dal cervello
    this.epoch = 0;         // cambia a ogni stop(): le frasi di prima vengono scartate
    this.cache = new Map();
    this.analyser = audioCtx.createAnalyser();
    this.analyser.fftSize = 512;
    const gain = audioCtx.createGain();
    gain.gain.value = 1.4;
    const comp = audioCtx.createDynamicsCompressor();
    comp.threshold.value = -16; comp.ratio.value = 3.5;
    gain.connect(comp).connect(this.analyser).connect(out);
    this.input = gain;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.simulated = false;
    this.#meter();
  }
  get busy() { return Boolean(this.current || this.queue.length || this.streaming); }

  // audio di una frase (dal server, con cache); null = usa la voce del browser
  audioFor(text, quality = "fast") {
    if (!this.cache.has(text)) {
      const p = fetch("/api/tts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, quality }) })
        .then((r) => (r.ok ? r.arrayBuffer() : null))
        .then((b) => (b ? audioCtx.decodeAudioData(b) : null))
        .catch(() => null);
      this.cache.set(text, p);
      p.then((b) => { if (!b) this.cache.delete(text); });
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value);
    }
    return this.cache.get(text);
  }
  preload(texts) { return Promise.all(texts.map((t) => this.audioFor(t, "high"))); }

  say(text, meta = {}, audio) {
    const clean = String(text).replace(/[*_#`>[\]()]/g, "").replace(/\s+/g, " ").trim();
    if (!clean) return;
    this.queue.push({ text: clean, meta, audio: audio ? Promise.resolve(audio) : this.audioFor(clean) });
    this.#next();
  }
  finishStream() { this.streaming = false; this.#next(); }

  async #next() {
    if (this.current) return;
    if (!this.queue.length) { if (!this.streaming) this.onIdle?.(); return; }
    const epoch = this.epoch, item = (this.current = this.queue.shift());
    const buffer = await item.audio;
    if (epoch !== this.epoch) return;
    await audioCtx.resume().catch(() => {});
    const done = () => { if (epoch === this.epoch) { this.current = null; this.simulated = false; this.#next(); } };
    if (buffer) {
      const src = audioCtx.createBufferSource();
      src.buffer = buffer;
      src.connect(this.input);
      src.onended = done;
      item.src = src;
      this.onSentence?.(item.text, buffer.duration, item.meta);
      src.start();
    } else {
      // voce del browser: con Microsoft Edge è una voce naturale, altrove più robotica
      const u = new SpeechSynthesisUtterance(item.text);
      u.lang = "it-IT";
      u.rate = 1.03;
      const voices = speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith("it"));
      u.voice = voices.find((v) => /natural|online/i.test(v.name) && /giuseppe|diego/i.test(v.name)) || voices.find((v) => /natural|online|neural/i.test(v.name)) || voices.find((v) => /google/i.test(v.name)) || voices[0] || null;
      this.simulated = true;
      this.onSentence?.(item.text, item.text.split(/\s+/).length / 2.7, item.meta);
      u.onend = u.onerror = done;
      speechSynthesis.speak(u);
    }
  }
  stop() {
    this.epoch++;
    this.queue = [];
    this.streaming = false;
    try { this.current?.src?.stop(); } catch {}
    speechSynthesis.cancel();
    this.current = null;
    this.simulated = false;
  }
  #meter() {
    let fake = 0;
    const tick = () => {
      let level = 0;
      if (this.simulated) level = fake += (Math.random() * 0.85 - fake) * 0.3; // voce del browser: livello simulato
      else if (this.current) {
        this.analyser.getFloatTimeDomainData(this.buf);
        let sum = 0;
        for (const v of this.buf) sum += v * v;
        level = Math.min(1, Math.sqrt(sum / this.buf.length) * 4.5);
      }
      this.onLevel?.(level);
      requestAnimationFrame(tick);
    };
    tick();
  }
}

// ======================================================================== Listener
// Riconoscimento vocale del browser (Chrome/Edge). Mentre Jarvis parla è "sordo" (anti-eco):
// i risultati arrivano marcati come echo e l'app li usa solo per capire un "stop".
// Senza riconoscimento del browser usa Whisper sul server (se installato) registrando a blocchi.
export class Listener {
  constructor({ onFinal, onInterim, onLevel, onState, onError, onEvent } = {}) {
    Object.assign(this, { onFinal, onInterim, onLevel, onState, onError, onEvent });
    this.muted = false;
    this.paused = false;
    this.engine = null;
    this.label = "";
  }
  async start() {
    if (SpeechRec && VOICE_UNSUPPORTED) this.onError?.("browser senza riconoscimento vocale");
    const useBrowser = SpeechRec && !VOICE_UNSUPPORTED && new URLSearchParams(location.search).get("stt") !== "whisper";
    // Sui telefoni il microfono non si può condividere: se lo apriamo noi per misurare il volume,
    // il riconoscimento vocale del sistema non riceve l'audio ("sente" ma non capisce). Lì lo lasciamo tutto a lui
    // e la barra del volume si anima con i segnali del riconoscimento.
    if (useBrowser && PHONE) {
      this.label = "microfono del telefono";
      this.#signalMeter();
      this.#browser();
      return;
    }
    await this.#openMic();
    if (useBrowser) this.#browser();
    else this.#whisper();
  }
  // microfono aperto da noi: serve per il volume e per registrare i pezzi da mandare a Whisper
  async #openMic() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    this.label = this.stream.getAudioTracks()[0]?.label || "microfono";
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(this.stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let smooth = 0;
    const loop = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      this.rms = Math.sqrt(sum / buf.length);
      smooth += (Math.min(1, this.rms * 9) - smooth) * 0.3;
      this.onLevel?.(this.muted || this.paused ? 0 : smooth);
      requestAnimationFrame(loop);
    };
    loop();
  }
  // volume "stimato" dai segnali del riconoscimento vocale (quando il microfono è suo)
  #signalMeter() {
    let level = 0;
    const loop = () => {
      const target = this.hearing && !this.muted && !this.paused ? 0.3 + Math.random() * 0.5 : 0;
      level += (target - level) * 0.25;
      this.onLevel?.(level);
      requestAnimationFrame(loop);
    };
    loop();
  }

  #browser() {
    this.engine = "browser";
    let failures = 0;
    // se dopo 5 secondi il riconoscimento non si è mai avviato, il browser non lo supporta davvero
    let everStarted = false;
    setTimeout(() => { if (!everStarted && this.engine === "browser" && !this.blocked) this.onError?.("browser senza riconoscimento vocale"); }, 5000);
    const rec = (this.rec = new SpeechRec());
    rec.lang = "it-IT";
    rec.continuous = !ANDROID; // su Android la modalità continua ripete le parole: frase per frase (l'app le riunisce)
    rec.interimResults = true;
    rec.onstart = () => { everStarted = true; this.running = true; this.onEvent?.("riconoscimento avviato"); this.onState?.(this.muted ? "ANTI-ECO" : "IN ASCOLTO"); };
    rec.onspeechstart = rec.onsoundstart = () => { this.hearing = true; };
    rec.onspeechend = rec.onsoundend = () => { this.hearing = false; };
    rec.onresult = (e) => {
      failures = 0;
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i], text = r[0].transcript.trim();
        if (r.isFinal) { if (text) this.onFinal?.(text, { echo: this.muted, confidence: r[0].confidence, engine: "browser" }); }
        else interim += `${text} `;
      }
      if (interim.trim()) this.onInterim?.(interim.trim(), { echo: this.muted });
    };
    rec.onerror = (e) => {
      this.onEvent?.(`errore riconoscimento: ${e.error}${e.message ? ` (${e.message})` : ""}`);
      if (e.error === "no-speech" || e.error === "aborted") return;
      if (e.error === "not-allowed") { this.blocked = true; this.onError?.("microfono bloccato"); return; }
      this.onError?.(`riconoscimento vocale: ${e.error}`);
      if (["network", "service-not-allowed", "language-not-supported", "audio-capture"].includes(e.error) && ++failures >= 2) {
        this.rec = null;
        this.#openMic().then(() => this.#whisper()).catch((err) => this.onError?.(`microfono: ${err.message}`));
      }
    };
    rec.onend = () => {
      this.onEvent?.("riconoscimento fermato");
      this.running = false;
      this.hearing = false;
      if (this.rec === rec && !this.paused && !this.blocked) setTimeout(() => this.#restart(), 150);
    };
    this.#restart();
  }
  #restart() { if (this.rec && !this.running && !this.paused) try { this.rec.start(); } catch (e) { this.onEvent?.(`avvio riconoscimento non riuscito: ${e.message}`); } }

  // Rilevatore di voce a tempo: impara il rumore di fondo, inizia a registrare quando il volume lo supera
  // per almeno 90 ms e si ferma dopo 0,8 secondi di silenzio (o dopo 15 secondi). Poi manda il pezzo a Whisper.
  #whisper() {
    this.engine = "whisper";
    this.onState?.("WHISPER");
    const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const START_MS = 90, SILENCE_MS = 800, MAX_MS = 15_000;
    let noise = 0.012, recorder = null, startedAt = 0, loudSince = 0, quietSince = 0;
    const begin = () => {
      const chunks = [], t0 = performance.now();
      recorder = new MediaRecorder(this.stream, { mimeType: mime });
      recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      recorder.onstop = () => this.#transcribe(new Blob(chunks, { type: mime }), performance.now() - t0, mime);
      recorder.start();
      startedAt = t0;
      quietSince = 0;
    };
    const end = (discard) => {
      if (discard) recorder.onstop = null;
      try { recorder.stop(); } catch {}
      recorder = null;
      loudSince = 0;
    };
    const timer = setInterval(() => {
      if (this.engine !== "whisper") return clearInterval(timer);
      const now = performance.now(), level = this.rms || 0, deaf = this.muted || this.paused;
      const threshold = Math.max(0.02, noise * 3);
      if (!recorder) {
        noise = noise * 0.98 + Math.min(level, 0.05) * 0.02; // il rumore di fondo si aggiorna solo quando nessuno parla
        if (deaf || level <= threshold) { loudSince = 0; return; }
        loudSince ||= now;
        if (now - loudSince >= START_MS) begin();
        return;
      }
      if (deaf) return end(true); // Jarvis ha iniziato a parlare: quello registrato sarebbe eco
      if (level < threshold * 0.7) quietSince ||= now; else quietSince = 0;
      if ((quietSince && now - quietSince > SILENCE_MS) || now - startedAt > MAX_MS) end(false);
    }, 20);
  }
  async #transcribe(blob, ms, mime) {
    if (ms < 500 || blob.size < 4000) return; // troppo corto: era un rumore
    try {
      const r = await fetch("/api/stt", { method: "POST", headers: { "Content-Type": mime }, body: blob });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || r.status);
      if (j.text) this.onFinal?.(j.text, { echo: this.muted, engine: "whisper" });
    } catch (e) { this.onError?.(`Whisper: ${e.message}`); }
  }

  // anti-eco: mentre Jarvis parla si scarta quello che il microfono ha sentito
  mute(on) {
    if (this.muted === on) return;
    this.muted = on;
    if (this.rec && this.running) try { this.rec.abort(); } catch {}
    this.onState?.(on ? "ANTI-ECO" : "IN ASCOLTO");
  }
  pause() {
    this.paused = true;
    try { this.rec?.abort(); } catch {}
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = false));
  }
  resume() {
    this.paused = false;
    this.stream?.getAudioTracks().forEach((t) => (t.enabled = true));
    this.#restart();
  }
}

// ======================================================================== Music
export class Music {
  constructor({ file, start = 0 } = {}) {
    this.file = file; this.start = start;
    this.gain = audioCtx.createGain();
    this.gain.gain.value = 0;
    this.gain.connect(out);
    this.buffer = null;
    this.source = null;
    this.ready = file ? fetch(file).then((r) => (r.ok ? r.arrayBuffer() : null)).then((b) => b && audioCtx.decodeAudioData(b)).then((b) => (this.buffer = b)).catch(() => null) : Promise.resolve(null);
  }
  get playing() { return Boolean(this.source); }
  async play(volume = 0.6, fadeSeconds = 1.5) {
    await this.ready;
    if (!this.buffer) return false;
    if (!this.source) {
      this.source = audioCtx.createBufferSource();
      this.source.buffer = this.buffer;
      this.source.loop = true;
      this.source.connect(this.gain);
      this.source.start(0, this.start);
    }
    this.fade(volume, fadeSeconds);
    return true;
  }
  fade(volume, seconds = 1) {
    const t = audioCtx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(volume, t + seconds);
  }
  stop(seconds = 1.5) {
    if (!this.source) return;
    const s = this.source;
    this.source = null;
    this.fade(0, seconds);
    setTimeout(() => { try { s.stop(); } catch {} }, seconds * 1000 + 100);
  }
}

// ======================================================================== effetti sonori (sintetizzati, niente file)
function tone(freq, start, dur, vol, type = "sine", slideTo) {
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, start);
  if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, start + dur);
  g.gain.setValueAtTime(0.0001, start);
  g.gain.exponentialRampToValueAtTime(vol, start + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  o.connect(g).connect(out);
  o.start(start);
  o.stop(start + dur + 0.05);
}
function whoosh(start, dur, from, to, vol) {
  const len = Math.floor(audioCtx.sampleRate * dur), b = audioCtx.createBuffer(1, len, audioCtx.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  const src = audioCtx.createBufferSource(), f = audioCtx.createBiquadFilter(), g = audioCtx.createGain();
  src.buffer = b; f.type = "bandpass"; f.Q.value = 1.2;
  f.frequency.setValueAtTime(from, start); f.frequency.exponentialRampToValueAtTime(to, start + dur * 0.6);
  g.gain.setValueAtTime(0.0001, start); g.gain.exponentialRampToValueAtTime(vol, start + dur * 0.3); g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
  src.connect(f).connect(g).connect(out);
  src.start(start);
}
export const sfx = {
  wake() { // colpo basso, soffio che sale e armonici brillanti
    const t = audioCtx.currentTime;
    tone(95, t, 1.6, 0.8, "sine", 34);
    whoosh(t, 2.2, 200, 5000, 0.2);
    [587.33, 880, 1174.66, 1760].forEach((f, i) => tone(f, t + 0.4 + i * 0.08, 1.6, 0.045 / (i + 1)));
  },
  listen() { const t = audioCtx.currentTime; tone(1320, t, 0.16, 0.05); tone(1980, t + 0.07, 0.18, 0.04); },
  think() { const t = audioCtx.currentTime; tone(220, t, 0.3, 0.03, "triangle", 440); },
  sleep() { const t = audioCtx.currentTime; [988, 659, 440].forEach((f, i) => tone(f, t + i * 0.11, 0.34, 0.04)); },
  tick() { tone(2400, audioCtx.currentTime, 0.03, 0.012, "square"); },
};
