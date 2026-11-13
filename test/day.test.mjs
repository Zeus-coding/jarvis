import { test, before } from "node:test";
import assert from "node:assert/strict";
import { useTempData } from "./helpers.mjs";

useTempData();
const store = await import("../src/store.mjs");
const { addTask, completeByName, listTasks, setDone, deleteTask, tasksText } = await import("../src/tasks.mjs");
const { weekKey, dayKey, saveDayReview, dayReview, reviewsText } = await import("../src/reviews.mjs");
const { tick } = await import("../src/scheduler.mjs");

before(async () => { await store.loadData(); });

test("attività: aggiunta, scadenza valida, titolo vuoto rifiutato", async () => {
  const t = await addTask("Studiare il capitolo 3", "2026-11-20");
  assert.equal(t.due, "2026-11-20");
  assert.equal((await addTask("Senza data valida", "domani")).due, null);
  assert.equal(await addTask("   "), null);
});

test("attività: «ho finito di studiare il capitolo 3» trova quella giusta", async () => {
  const t = await completeByName("studiare il capitolo 3");
  assert.equal(t?.title, "Studiare il capitolo 3");
  assert.equal(t.done, true);
  assert.equal(await completeByName("qualcosa che non esiste"), null);
});

test("attività: le aperte vengono prima delle fatte", async () => {
  const list = listTasks();
  assert.equal(list[0].done, false);
  assert.equal(list.at(-1).done, true);
  assert.match(tasksText(), /Senza data valida/);
  assert.match(tasksText(), /Fatte oggi: Studiare il capitolo 3/);
});

test("attività: riapertura ed eliminazione", async () => {
  const t = listTasks().find((x) => x.done);
  assert.equal((await setDone(t.id, false)).done, false);
  assert.equal(await deleteTask(t.id), true);
  assert.equal(await deleteTask("non-esiste"), false);
});

test("settimane: la chiave è il lunedì", () => {
  assert.equal(weekKey(new Date(2026, 10, 15)), "2026-11-09"); // domenica 15 → lunedì 9
  assert.equal(weekKey(new Date(2026, 10, 9)), "2026-11-09");  // lunedì stesso
  assert.equal(weekKey(new Date(2026, 10, 10)), "2026-11-09");
});

test("revisione serale: si salva una per giorno e si aggiorna", async () => {
  const a = await saveDayReview({ good: "Ho studiato due ore", bad: "Ho saltato la palestra", notes: "", mood: 4 });
  const b = await saveDayReview({ good: "Ho studiato due ore", bad: "Palestra saltata", notes: "Domani palestra", mood: 9 });
  assert.equal(a.id, b.id);
  assert.equal(dayReview(dayKey()).notes, "Domani palestra");
  assert.equal(b.mood, 5); // limitato tra 1 e 5
  assert.match(reviewsText(), /Palestra saltata/);
});

test("pianificatore: senza dispositivi iscritti non fa nulla e non va in errore", async () => {
  await tick(new Date());
  assert.ok(Array.isArray(store.db.notified));
});
