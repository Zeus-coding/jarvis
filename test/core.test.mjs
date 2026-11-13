import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useTempData } from "./helpers.mjs";

const dir = useTempData();
const store = await import("../src/store.mjs");
const { hashPassword } = await import("../src/auth.mjs");
const { mergeParts, textOf } = await import("../src/gemini.mjs");
const { cosine } = await import("../src/memory.mjs");

before(async () => { await store.loadData(); });

test("i dati partono con valori predefiniti e si salvano su disco", async () => {
  assert.equal(store.db.settings.addressAs, "signore");
  assert.deepEqual(store.db.contacts, []);
  store.db.profile = "Studente di ingegneria";
  await store.saveData();
  const onDisk = JSON.parse(readFileSync(join(dir, "jarvis.json"), "utf8"));
  assert.equal(onDisk.profile, "Studente di ingegneria");
});

test("le chiavi si leggono anche dalle variabili d'ambiente", () => {
  process.env.TEST_CHIAVE_FINTA = "abc";
  assert.equal(store.key("TEST_CHIAVE_FINTA"), "abc");
  assert.equal(store.key("CHIAVE_CHE_NON_ESISTE"), "");
});

test("la password è salvata come hash con sale (mai in chiaro)", () => {
  const a = hashPassword("supersegreta1"), b = hashPassword("supersegreta1");
  assert.ok(!a.includes("supersegreta1"));
  assert.notEqual(a, b); // sale diverso ogni volta
  assert.match(a, /^[0-9a-f]{32}:[0-9a-f]{64}$/);
});

test("Gemini: i pezzi di testo in streaming vengono uniti, le firme di ragionamento no", () => {
  const parts = mergeParts([{ text: "Ciao " }, { text: "signore." }, { functionCall: { name: "x" }, thoughtSignature: "S" }, { text: "pensiero", thought: true }]);
  assert.equal(parts.length, 3);
  assert.equal(parts[0].text, "Ciao signore.");
  assert.equal(textOf(parts), "Ciao signore.");
});

test("memoria: somiglianza tra vettori", () => {
  assert.equal(cosine([1, 0], [1, 0]), 1);
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 1], [1, 0]) - Math.SQRT1_2) < 1e-9);
});
