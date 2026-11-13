// J.A.R.V.I.S. — Google Gemini: scelta automatica del modello, chiamate in streaming, gestione del ragionamento.
import { think } from "./brain.mjs";
import { GEMINI_URL } from "./config.mjs";
import { json } from "./http.mjs";
import { db, key } from "./store.mjs";
import { tts } from "./tts.mjs";

export const gHeaders = (k = key("GEMINI_API_KEY")) => ({ "x-goog-api-key": k, "Content-Type": "application/json" });
export let geminiList = null;
export async function geminiModels() {
  if (geminiList) return geminiList;
  const r = await fetch(`${GEMINI_URL}/models?pageSize=1000`, { headers: gHeaders(), signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw Object.assign(new Error(`Gemini ${r.status}`), { status: r.status });
  const list = (await r.json()).models || [];
  geminiList = list.map((m) => ({ id: String(m.name || "").replace(/^models\//, ""), methods: m.supportedGenerationMethods || [] }));
  return geminiList;
}
// "lite" = Flash-Lite (piano gratuito più generoso), "flash" = Flash (più intelligente, pochissime richieste gratis)
export async function pickGemini(tier) {
  const forced = process.env.JARVIS_MODEL || db.settings.model;
  if (forced && forced.startsWith("gemini")) return forced;
  const fallback = tier === "flash" ? "gemini-flash-latest" : "gemini-flash-lite-latest";
  try {
    const ids = (await geminiModels()).filter((m) => m.methods.includes("generateContent")).map((m) => m.id);
    const re = tier === "flash" ? /^gemini-(\d+(?:\.\d+)?)-flash$/ : /^gemini-(\d+(?:\.\d+)?)-flash-lite$/;
    const best = ids.filter((id) => re.test(id)).sort((a, b) => parseFloat(b.match(re)[1]) - parseFloat(a.match(re)[1]))[0];
    return best || (ids.includes(fallback) ? fallback : ids.find((id) => id.includes(tier === "flash" ? "flash" : "flash-lite") && !/image|tts|audio|live|preview|exp/.test(id)) || fallback);
  } catch {
    return fallback;
  }
}
export let liteUntil = 0; // dopo un "limite raggiunto" su Flash si passa a Flash-Lite per un'ora
export let chosenModel = null;
export async function geminiModel() {
  const tier = db.settings.modelTier === "flash" && Date.now() > liteUntil ? "flash" : "lite";
  const m = await pickGemini(tier);
  if (m !== chosenModel) console.log(`[mente] modello: ${m}`);
  return (chosenModel = m);
}

// Ogni modello accetta un modo diverso di limitare il "ragionamento" (più veloce = risposte a voce più pronte).
export const THINKING = [{ thinkingLevel: "minimal" }, { thinkingLevel: "low" }, { thinkingBudget: 0 }, null];
export const thinkingFor = new Map(); // modello -> indice in THINKING che funziona
export async function geminiCall(model, body, { onText, signal, stream = true } = {}) {
  const known = thinkingFor.get(model);
  const tries = known === undefined ? THINKING.map((_, i) => i) : [known];
  for (const i of tries) {
    const tc = THINKING[i];
    const payload = { ...body, generationConfig: { ...(body.generationConfig || {}), ...(tc ? { thinkingConfig: tc } : {}) } };
    const url = `${GEMINI_URL}/models/${model}:${stream ? "streamGenerateContent?alt=sse" : "generateContent"}`;
    let r;
    for (let attempt = 0; attempt < 3; attempt++) {
      r = await fetch(url, { method: "POST", headers: gHeaders(), body: JSON.stringify(payload), signal: signal || AbortSignal.timeout(30000) });
      if (r.status !== 503 && r.status !== 500) break;
      await new Promise((ok) => setTimeout(ok, 700 * (attempt + 1))); // modello sovraccarico: riprova
    }
    if (r.status === 400 && known === undefined) {
      const err = await r.text();
      if (/think/i.test(err)) continue; // questo modello non accetta questa impostazione: prova la successiva
      throw Object.assign(new Error(`Gemini 400: ${err.slice(0, 200)}`), { status: 400 });
    }
    if (!r.ok) {
      const err = await r.text();
      throw Object.assign(new Error(`Gemini ${r.status}: ${err.slice(0, 200)}`), { status: r.status });
    }
    if (known === undefined) { thinkingFor.set(model, i); console.log(`[mente] ragionamento: ${tc ? JSON.stringify(tc) : "standard"}`); }
    const parts = [];
    let grounding = null;
    const take = (chunk) => {
      if (chunk.error) throw new Error(chunk.error.message || "errore Gemini");
      const cand = chunk.candidates?.[0];
      if (chunk.promptFeedback?.blockReason && !cand) throw new Error(`richiesta bloccata (${chunk.promptFeedback.blockReason})`);
      if (cand?.groundingMetadata) grounding = cand.groundingMetadata;
      for (const p of cand?.content?.parts || []) {
        if (p.text && !p.thought) onText?.(p.text);
        parts.push(p);
      }
    };
    if (!stream) take(await r.json());
    else {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let n;
        while ((n = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, n).trim();
          buf = buf.slice(n + 1);
          if (!line.startsWith("data:")) continue;
          let ev;
          try { ev = JSON.parse(line.slice(5)); } catch { continue; }
          take(ev);
        }
      }
    }
    return { parts: mergeParts(parts), grounding };
  }
  throw new Error("nessuna configurazione accettata dal modello");
}
// unisce i pezzi di testo arrivati in streaming (senza toccare quelli con la "firma" del ragionamento)
export function mergeParts(parts) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    const plain = (x) => x && typeof x.text === "string" && !x.thought && !x.thoughtSignature && Object.keys(x).length === 1;
    if (plain(p) && plain(last)) last.text += p.text;
    else out.push({ ...p });
  }
  return out;
}
export const textOf = (parts) => parts.filter((p) => p.text && !p.thought).map((p) => p.text).join("").trim();
// per settings e brain (un modulo non può riassegnare le variabili di un altro)
export function resetGemini() { geminiList = null; chosenModel = null; thinkingFor.clear(); }
export function setLiteUntil(t) { liteUntil = t; }
