// Prepara una cartella dati temporanea: i test non toccano mai i dati veri in data/.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export function useTempData() {
  process.env.JARVIS_DATA_DIR = mkdtempSync(join(tmpdir(), "jarvis-test-"));
  return process.env.JARVIS_DATA_DIR;
}
