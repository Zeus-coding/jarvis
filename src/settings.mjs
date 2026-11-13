// J.A.R.V.I.S. — Configurazione: stato e salvataggio di chiavi, voce, calendario, profilo, password.
import { loadCalendar } from "../calendar.mjs";
import { hashPassword, passwordSet } from "./auth.mjs";
import { openaiModel, resetOpenAI } from "./brain.mjs";
import { GEMINI_URL, OPENAI_URL } from "./config.mjs";
import { chosenModel, gHeaders, resetGemini, setLiteUntil } from "./gemini.mjs";
import { reindexMemories, resetEmbeddings } from "./memory.mjs";
import { db, key, provider, saveData, saveSecrets, secrets } from "./store.mjs";
import { elevenTTS, resetVoice, warmBriefing } from "./tts.mjs";
import { cloudflaredPath, startTunnel, stopTunnel, tunnel, tailscaleUrl } from "./tunnel.mjs";

export const mask = (v) => (v ? `${v.slice(0, 5)}…${v.slice(-4)}` : "");
export async function setupStatus() {
  const cal = key("CALENDAR_ICS_URL") ? await loadCalendar(key("CALENDAR_ICS_URL")) : null;
  return {
    brain: provider(),
    gemini: !!key("GEMINI_API_KEY"), geminiMasked: mask(key("GEMINI_API_KEY")),
    openai: !!key("OPENAI_API_KEY"), openaiMasked: mask(key("OPENAI_API_KEY")),
    elevenlabs: !!key("ELEVENLABS_API_KEY"), elevenlabsMasked: mask(key("ELEVENLABS_API_KEY")),
    voiceMode: db.settings.voiceMode || "neural",
    calendar: !!key("CALENDAR_ICS_URL"), calendarEvents: cal?.events.length || 0, calendarError: cal?.error || null,
    model: provider() === "openai" ? openaiModel : chosenModel,
    modelTier: db.settings.modelTier,
    profile: db.profile,
    city: db.settings.city || "", reviewTime: db.settings.reviewTime || "21:30",
    memories: db.memories.length,
    password: passwordSet(),
    phoneTunnel: !!db.settings.phoneTunnel, tailscaleUrl: tailscaleUrl(), tunnelUrl: tunnel.url, tunnelError: tunnel.error, tunnelInstalled: !!cloudflaredPath(),
  };
}
export async function applySetup(b, { local = true } = {}) {
  // dal telefono non si può spegnere l'indirizzo del telefono: si taglierebbe fuori da solo
  if (!local) delete b.phoneTunnel;
  const errors = {};
  if (b.brain === "gemini" || b.brain === "openai") db.settings.provider = b.brain;
  if (b.modelTier === "lite" || b.modelTier === "flash") { db.settings.modelTier = b.modelTier; setLiteUntil(0); }
  if (typeof b.geminiKey === "string" && b.geminiKey.trim()) {
    const k = b.geminiKey.trim();
    const r = await fetch(`${GEMINI_URL}/models?pageSize=1`, { headers: gHeaders(k), signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (r?.ok) { secrets.GEMINI_API_KEY = k; resetGemini(); resetEmbeddings(); }
    else errors.gemini = r && [400, 401, 403].includes(r.status) ? "Chiave non valida." : "Non riesco a verificare la chiave (controlla la connessione).";
  }
  if (typeof b.openaiKey === "string" && b.openaiKey.trim()) {
    const k = b.openaiKey.trim();
    const r = await fetch(`${OPENAI_URL}/models`, { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(10000) }).catch(() => null);
    if (r?.ok) { secrets.OPENAI_API_KEY = k; resetOpenAI(); }
    else errors.openai = r?.status === 401 ? "Chiave non valida." : "Non riesco a verificare la chiave (controlla la connessione).";
  }
  if (typeof b.elevenlabsKey === "string" && b.elevenlabsKey.trim()) {
    const k = b.elevenlabsKey.trim();
    try { await elevenTTS("Ok.", "fast", k); secrets.ELEVENLABS_API_KEY = k; resetVoice(); }
    catch (e) { errors.elevenlabs = e.status === 401 ? "Chiave non valida." : `ElevenLabs non risponde: ${e.message.slice(0, 120)}`; }
  }
  if (b.useFreeVoice) delete secrets.ELEVENLABS_API_KEY;
  if (b.voiceMode === "browser" || b.voiceMode === "neural") { db.settings.voiceMode = b.voiceMode; resetVoice(); }
  if (typeof b.calendarUrl === "string") {
    const u = b.calendarUrl.trim();
    if (!u) delete secrets.CALENDAR_ICS_URL;
    else if (!/^(https?|webcal):\/\//i.test(u)) errors.calendar = "Link non valido: deve iniziare con https:// o webcal://";
    else {
      const cal = await loadCalendar(u, { maxAgeMs: 0 });
      if (cal.error) errors.calendar = `Link non valido: ${cal.error}`;
      else secrets.CALENDAR_ICS_URL = u;
    }
  }
  if (typeof b.profile === "string") db.profile = b.profile.slice(0, 6000);
  if (typeof b.addressAs === "string" && b.addressAs.trim()) db.settings.addressAs = b.addressAs.trim().slice(0, 40);
  if (typeof b.city === "string") db.settings.city = b.city.trim().slice(0, 60);
  if (typeof b.reviewTime === "string" && /^\d{2}:\d{2}$/.test(b.reviewTime)) db.settings.reviewTime = b.reviewTime;
  if (typeof b.password === "string" && b.password) {
    if (b.password.length < 8) errors.password = "Almeno 8 caratteri.";
    else { secrets.ACCESS_PASSWORD_HASH = hashPassword(b.password); db.sessions = []; } // nuova password: tutti i dispositivi devono rientrare
  }
  if (typeof b.phoneTunnel === "boolean" && b.phoneTunnel !== !!db.settings.phoneTunnel) {
    db.settings.phoneTunnel = b.phoneTunnel;
    console.log(`[telefono] indirizzo per il telefono ${b.phoneTunnel ? "attivato" : "disattivato"} dalla configurazione`);
    if (!b.phoneTunnel) stopTunnel();
  }
  await saveSecrets();
  await saveData();
  if (db.settings.phoneTunnel) startTunnel();
  if (!Object.keys(errors).length) { warmBriefing(); reindexMemories(); }
  return { ok: !Object.keys(errors).length, errors, status: await setupStatus() };
}
