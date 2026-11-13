// J.A.R.V.I.S. — Gestione del servizio vocale Python (voce neurale gratuita e Whisper facoltativo).
// Lo avvia insieme al server, lo riavvia se si chiude per errore e lo spegne quando Jarvis si spegne.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { VOICE_PORT, root, dataDir } from "./config.mjs";

// l'ambiente Python creato da `npm run setup` (cartella .venv)
export function venvPython() {
  return [join(root, ".venv", "Scripts", "python.exe"), join(root, ".venv", "bin", "python")].find((p) => existsSync(p)) || null;
}

let child = null, stopping = false, restarts = 0;

export function startVoiceService() {
  const python = venvPython();
  if (!python) {
    console.log("[voce] ambiente Python non trovato: userò la voce del browser. Per la voce neurale gratuita esegui `npm run setup`.");
    return false;
  }
  const launch = () => {
    child = spawn(python, [join(root, "voice_service.py")], {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, JARVIS_VOICE_PORT: String(VOICE_PORT), JARVIS_DATA_DIR: dataDir, PYTHONIOENCODING: "utf-8" },
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    // dal canale degli errori si mostra solo ciò che è davvero un errore (Python scrive lì anche avvisi innocui)
    child.stderr.on("data", (chunk) => { const s = String(chunk); if (/error|traceback/i.test(s) && !/ConnectionAbortedError|BrokenPipe/.test(s)) process.stderr.write(`[voce] ${s}`); });
    child.on("exit", (code) => {
      child = null;
      if (stopping || restarts >= 5) return;
      restarts++;
      console.warn(`[voce] il servizio vocale si è chiuso (codice ${code}): lo riavvio`);
      setTimeout(launch, 2000 * restarts);
    });
  };
  launch();
  return true;
}

export function stopVoiceService() {
  stopping = true;
  try { child?.kill(); } catch {}
}
