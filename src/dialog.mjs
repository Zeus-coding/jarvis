// J.A.R.V.I.S. — Conversazione continua tra dispositivi e diario: le parti vecchie diventano riassunti.
import { pickModel } from "./brain.mjs";
import { OPENAI_URL } from "./config.mjs";
import { geminiCall, pickGemini, textOf } from "./gemini.mjs";
import { json } from "./http.mjs";
import { saveMemory } from "./memory.mjs";
import { db, key, provider, saveData } from "./store.mjs";

export const RECENT_MS = 12 * 3600e3;
export function recentDialog() {
  const since = Date.now() - RECENT_MS;
  return db.dialog.filter((m) => Date.parse(m.at) > since).slice(-16).map(({ role, content }) => ({ role, content }));
}
export let summarizing = false;
export async function logExchange(user, assistant) {
  const at = new Date().toISOString();
  db.dialog.push({ role: "user", content: user.slice(0, 4000), at }, { role: "assistant", content: assistant.slice(0, 4000), at });
  await saveData();
  if (db.dialog.length > 60 && !summarizing) summarizeOld();
}
// le parti vecchie della conversazione diventano "pagine di diario": brevi riassunti ripescabili in futuro
export async function summarizeOld() {
  summarizing = true;
  try {
    const chunk = db.dialog.slice(0, 30);
    const day = new Date(chunk[0].at).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const transcript = chunk.map((m) => `${m.role === "user" ? "Utente" : "Jarvis"}: ${m.content}`).join("\n");
    const summary = await complete(`Riassumi in italiano, in terza persona e in 2-6 frasi, questa conversazione tra l'utente e Jarvis.
Conserva fatti, decisioni, nomi, numeri, impegni presi, problemi e stato d'animo dell'utente. Niente elenchi.
Inizia con "Il ${day}".\n\n${transcript}`);
    if (summary) await saveMemory(summary, { kind: "diary" });
    db.dialog = db.dialog.slice(chunk.length);
    await saveData();
    console.log("[memoria] nuova pagina di diario salvata");
  } catch (e) {
    console.warn(`[memoria] riassunto non riuscito: ${e.message}`);
    if (db.dialog.length > 200) { db.dialog = db.dialog.slice(-100); await saveData(); }
  } finally {
    summarizing = false;
  }
}
// una richiesta semplice, senza strumenti (riassunti)
export async function complete(prompt) {
  if (provider() === "gemini") {
    const { parts } = await geminiCall(await pickGemini("lite"), { contents: [{ role: "user", parts: [{ text: prompt }] }] }, { stream: false });
    return textOf(parts);
  }
  if (provider() === "openai") {
    const r = await fetch(`${OPENAI_URL}/responses`, {
      method: "POST", headers: { Authorization: `Bearer ${key("OPENAI_API_KEY")}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(30000),
      body: JSON.stringify({ model: await pickModel(), input: prompt, store: false }),
    });
    if (!r.ok) throw new Error(`OpenAI ${r.status}`);
    const j = await r.json();
    return (j.output || []).flatMap((o) => o.content || []).map((c) => c.text || "").join("").trim();
  }
  return "";
}
