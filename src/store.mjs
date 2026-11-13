// J.A.R.V.I.S. — Dati (data/jarvis.json), chiavi (data/secrets.json) e scelta del cervello AI.
import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dataDir, dbFile, secretsFile } from "./config.mjs";

export let db, secrets = {};
export async function loadData() {
  await mkdir(dataDir, { recursive: true });
  try { db = JSON.parse(await readFile(dbFile, "utf8")); } catch { db = {}; }
  db.settings = { addressAs: "signore", ttsVoice: "it-IT-GiuseppeMultilingualNeural", ttsRate: "+4%", ttsPitch: "-3Hz", modelTier: "lite", reviewTime: "21:30", city: "", ...db.settings };
  // ogni raccolta di dati parte vuota se non esiste ancora (così i file vecchi restano compatibili)
  for (const k of ["events", "memories", "dialog", "sessions", "contacts", "tasks", "reviews", "pushSubs", "notified"]) db[k] ??= [];
  db.profile ??= "";
  await saveData();
  try { secrets = JSON.parse(await readFile(secretsFile, "utf8")); } catch { secrets = {}; }
}
// scrittura atomica: un file temporaneo e poi rinomina, così un crash non lascia il JSON a metà
export let saving = Promise.resolve();
export const atomicWrite = (file, text) => (saving = saving.then(async () => {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}).catch((e) => console.warn(`[dati] salvataggio non riuscito: ${e.message}`)));
export const saveData = () => atomicWrite(dbFile, JSON.stringify(db));
export const saveSecrets = () => atomicWrite(secretsFile, JSON.stringify(secrets, null, 2));
export const key = (name) => process.env[name] || secrets[name] || "";

// Quale cervello usare: la scelta dell'utente se ha la chiave, altrimenti quello disponibile (Gemini per primo).
export function provider() {
  const want = db.settings.provider;
  if (want === "gemini" && key("GEMINI_API_KEY")) return "gemini";
  if (want === "openai" && key("OPENAI_API_KEY")) return "openai";
  return key("GEMINI_API_KEY") ? "gemini" : key("OPENAI_API_KEY") ? "openai" : null;
}
