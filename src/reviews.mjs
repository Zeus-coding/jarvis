// J.A.R.V.I.S. — Agente di revisione: ogni sera fa il punto della giornata, la domenica tira le somme della settimana.
// Le revisioni finiscono anche nella memoria, così Jarvis se ne ricorda nelle conversazioni.
import { randomUUID } from "node:crypto";
import { db, saveData } from "./store.mjs";
import { complete } from "./dialog.mjs";
import { saveMemory } from "./memory.mjs";
import { agenda } from "./agenda.mjs";
import { doneOn, listTasks } from "./tasks.mjs";

export const dayKey = (d = new Date()) => d.toLocaleDateString("sv-SE"); // AAAA-MM-GG
const longDate = (key) => new Date(`${key}T12:00:00`).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
// lunedì della settimana di una data (le revisioni settimanali sono identificate così)
export function weekKey(d = new Date()) {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return dayKey(x);
}

export const dayReview = (key = dayKey()) => db.reviews.find((r) => r.type === "day" && r.date === key) || null;
export const weekReview = (key = weekKey()) => db.reviews.find((r) => r.type === "week" && r.date === key) || null;
export function recentReviews(n = 10) {
  return [...db.reviews].sort((a, b) => b.date.localeCompare(a.date) || (a.type === "week" ? -1 : 1)).slice(0, n);
}

const clean = (s, max = 1500) => String(s || "").replace(/\s+\n/g, "\n").trim().slice(0, max);
// le risposte dell'AI in JSON a volte arrivano tra ``` o con testo intorno: si estrae il primo oggetto
function parseJson(text) {
  const m = String(text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// materiale della giornata: attività fatte, impegni, conversazioni con Jarvis
async function dayMaterial(key) {
  const from = new Date(`${key}T00:00:00`), to = new Date(from.getTime() + 864e5);
  const { all } = await agenda(1).catch(() => ({ all: [] }));
  const events = all.filter((e) => e.start >= from && e.start < to).map((e) => e.title);
  const done = doneOn(key).map((t) => t.title);
  const open = listTasks({ done: false }).slice(0, 10).map((t) => t.title);
  const talk = db.dialog.filter((m) => m.role === "user" && m.at && dayKey(new Date(m.at)) === key).map((m) => m.content).slice(-25);
  return { events, done, open, talk };
}

export async function draftDayReview(key = dayKey()) {
  const m = await dayMaterial(key);
  const text = await complete(`Prepara la bozza della revisione serale di ${longDate(key)} per l'utente, in italiano, in seconda persona, concreta e gentile.
Usa SOLO questi dati, senza inventare:
- Impegni della giornata: ${m.events.join("; ") || "nessuno"}
- Attività completate: ${m.done.join("; ") || "nessuna"}
- Attività ancora aperte: ${m.open.join("; ") || "nessuna"}
- Cose dette a Jarvis oggi: ${m.talk.join(" | ") || "nessuna"}
Rispondi solo con un oggetto JSON: {"good": "cosa è andato bene (1-3 frasi)", "bad": "cosa non è andato o si è rimandato (1-3 frasi)", "notes": "un consiglio per domani (1 frase)"}`);
  const j = parseJson(text) || {};
  return { good: clean(j.good, 600), bad: clean(j.bad, 600), notes: clean(j.notes, 400), material: m };
}

export async function saveDayReview({ good = "", bad = "", notes = "", date = dayKey(), mood = null } = {}) {
  const key = /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : dayKey();
  const r = dayReview(key) || { id: randomUUID(), type: "day", date: key, createdAt: new Date().toISOString() };
  Object.assign(r, { good: clean(good, 1200), bad: clean(bad, 1200), notes: clean(notes, 800), mood: Number.isInteger(mood) ? Math.max(1, Math.min(5, mood)) : r.mood ?? null, updatedAt: new Date().toISOString() });
  if (!db.reviews.includes(r)) db.reviews.push(r);
  await saveData();
  const memo = [`Revisione di ${longDate(key)}`, r.good && `andato bene: ${r.good}`, r.bad && `da migliorare: ${r.bad}`, r.notes && `nota: ${r.notes}`].filter(Boolean).join(" — ");
  saveMemory(memo, { kind: "diary" }).catch(() => {});
  return r;
}

export async function makeWeekReview(key = weekKey()) {
  const days = db.reviews.filter((r) => r.type === "day" && r.date >= key).sort((a, b) => a.date.localeCompare(b.date));
  const end = new Date(`${key}T00:00:00`);
  end.setDate(end.getDate() + 7);
  const done = db.tasks.filter((t) => t.done && t.doneAt && new Date(t.doneAt) >= new Date(`${key}T00:00:00`) && new Date(t.doneAt) < end).map((t) => t.title);
  const open = listTasks({ done: false }).slice(0, 12).map((t) => t.title);
  const text = await complete(`Sei l'agente di revisione settimanale dell'utente. Settimana da ${longDate(key)}. Scrivi in italiano, in seconda persona, con tono da coach onesto e concreto.
Dati (non inventare nulla):
- Revisioni serali: ${days.map((d) => `${d.date}: bene ${d.good || "-"}; male ${d.bad || "-"}; nota ${d.notes || "-"}`).join(" | ") || "nessuna"}
- Attività completate: ${done.join("; ") || "nessuna"}
- Attività ancora aperte: ${open.join("; ") || "nessuna"}
Rispondi solo con un oggetto JSON: {"summary": "le somme della settimana (2-4 frasi)", "improve": "cosa migliorare (1-3 frasi)", "plan": ["3-5 azioni concrete per la settimana nuova"]}`);
  const j = parseJson(text) || {};
  const r = weekReview(key) || { id: randomUUID(), type: "week", date: key, createdAt: new Date().toISOString() };
  Object.assign(r, { summary: clean(j.summary, 1200), improve: clean(j.improve, 800), plan: (Array.isArray(j.plan) ? j.plan : []).map((p) => clean(p, 200)).filter(Boolean).slice(0, 6), stats: { days: days.length, done: done.length, open: open.length }, updatedAt: new Date().toISOString() });
  if (!db.reviews.includes(r)) db.reviews.push(r);
  await saveData();
  if (r.summary) saveMemory(`Bilancio della settimana da ${longDate(key)}: ${r.summary} Da migliorare: ${r.improve}`, { kind: "diary" }).catch(() => {});
  return r;
}

// per le istruzioni del cervello: l'ultima revisione dà contesto alle conversazioni
export function reviewsText() {
  const last = recentReviews(3);
  if (!last.length) return "- nessuna revisione ancora";
  return last.map((r) => (r.type === "day" ? `- ${r.date} (sera): bene: ${r.good || "-"}; da migliorare: ${r.bad || "-"}` : `- settimana dal ${r.date}: ${r.summary || "-"}`)).join("\n");
}
