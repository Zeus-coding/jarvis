// J.A.R.V.I.S. — Attività da fare: si aggiungono e si spuntano a voce o dalla pagina «La mia giornata».
import { randomUUID } from "node:crypto";
import { db, saveData } from "./store.mjs";
import { fold } from "./contacts.mjs";

const today = () => new Date().toLocaleDateString("sv-SE"); // AAAA-MM-GG nell'ora locale

export function listTasks({ done = true } = {}) {
  const t = db.tasks.filter((x) => done || !x.done);
  // prima le aperte (per scadenza), poi quelle fatte (le più recenti)
  return t.sort((a, b) => Number(a.done) - Number(b.done) || (a.done ? String(b.doneAt).localeCompare(String(a.doneAt)) : String(a.due || "9999").localeCompare(String(b.due || "9999"))));
}
export async function addTask(title, due = null) {
  const t = { id: randomUUID(), title: String(title || "").trim().slice(0, 160), due: /^\d{4}-\d{2}-\d{2}$/.test(due || "") ? due : null, done: false, createdAt: new Date().toISOString(), doneAt: null };
  if (!t.title) return null;
  db.tasks.push(t);
  await saveData();
  return t;
}
export async function setDone(id, done = true) {
  const t = db.tasks.find((x) => x.id === id);
  if (!t) return null;
  t.done = done;
  t.doneAt = done ? new Date().toISOString() : null;
  await saveData();
  return t;
}
// a voce: «ho finito la relazione» → trova l'attività aperta più simile
export async function completeByName(name) {
  const q = fold(name);
  const open = db.tasks.filter((t) => !t.done);
  const t = open.find((x) => fold(x.title) === q) || open.find((x) => fold(x.title).includes(q) || q.includes(fold(x.title))) || open.find((x) => q.split(" ").filter((w) => w.length > 3).some((w) => fold(x.title).includes(w)));
  return t ? setDone(t.id, true) : null;
}
export async function deleteTask(id) {
  const n = db.tasks.length;
  db.tasks = db.tasks.filter((x) => x.id !== id);
  if (db.tasks.length !== n) await saveData();
  return db.tasks.length !== n;
}
// pulizia: le attività fatte da più di 30 giorni non servono più
export async function pruneTasks() {
  const limit = Date.now() - 30 * 864e5, n = db.tasks.length;
  db.tasks = db.tasks.filter((t) => !t.done || Date.parse(t.doneAt) > limit);
  if (db.tasks.length !== n) await saveData();
}
export const doneOn = (day) => db.tasks.filter((t) => t.done && t.doneAt && new Date(t.doneAt).toLocaleDateString("sv-SE") === day);

// per le istruzioni del cervello
export function tasksText() {
  const open = listTasks({ done: false }).slice(0, 15);
  const done = doneOn(today());
  const lines = open.map((t) => `- ${t.title}${t.due ? ` (entro il ${t.due})` : ""}`);
  return `${lines.length ? lines.join("\n") : "- nessuna attività aperta"}${done.length ? `\n- Fatte oggi: ${done.map((t) => t.title).join(", ")}` : ""}`;
}
