// J.A.R.V.I.S. — installazione guidata.
//   npm run setup                 dipendenze Node + voce neurale gratuita (Python)
//   npm run setup -- --whisper    in più il riconoscimento vocale locale di riserva (circa 200 MB)
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(new URL("./", import.meta.url));
const windows = process.platform === "win32";
const say = { ok: (m) => console.log(`  ✓ ${m}`), warn: (m) => console.log(`  ! ${m}`), fail: (m) => { console.log(`  ✗ ${m}`); process.exit(1); } };
const run = (cmd, args, options = {}) => spawnSync(cmd, args, { cwd: here, stdio: "inherit", shell: windows, ...options }).status === 0;
const ask = (cmd, args) => spawnSync(cmd, args, { encoding: "utf8" });

console.log("\n  Installazione di J.A.R.V.I.S.\n");

// 1. Node.js
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) say.fail(`Serve Node.js 22 o superiore (hai ${process.versions.node}): scaricalo da https://nodejs.org`);
say.ok(`Node.js ${process.versions.node}`);

// 2. librerie JavaScript (three.js per la grafica, web-push per le notifiche, il QR code)
if (!run("npm", ["install", "--no-audit", "--no-fund"])) say.fail("npm install non è riuscito.");
say.ok("librerie installate");

// 3. Python, facoltativo: serve alla voce neurale gratuita
function findPython() {
  const options = windows ? [["py", ["-3"]], ["python", []], ["python3", []]] : [["python3", []], ["python", []]];
  for (const [cmd, prefix] of options) {
    const r = ask(cmd, [...prefix, "-c", "import sys; print(*sys.version_info[:2])"]);
    const [major, minor] = String(r.stdout || "").trim().split(" ").map(Number);
    if (r.status === 0 && major === 3 && minor >= 9) return { cmd, prefix, version: `${major}.${minor}` };
  }
  return null;
}
const venvPython = join(here, ".venv", windows ? "Scripts/python.exe" : "bin/python");
const python = existsSync(venvPython) ? null : findPython();
if (!existsSync(venvPython) && !python) {
  say.warn("Python 3.9+ non trovato: Jarvis userà la voce del browser (con Microsoft Edge è comunque naturale).");
  say.warn("Per la voce neurale gratuita installa Python da https://www.python.org e rilancia `npm run setup`.");
} else {
  if (python) {
    say.ok(`Python ${python.version}`);
    if (!run(python.cmd, [...python.prefix, "-m", "venv", ".venv"], { shell: false })) say.fail("Non riesco a creare l'ambiente Python (.venv).");
  }
  run(venvPython, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], { shell: false });
  if (run(venvPython, ["-m", "pip", "install", "--quiet", "-r", "requirements.txt"], { shell: false })) say.ok("voce neurale gratuita installata");
  else say.warn("Voce neurale non installata: verrà usata la voce del browser.");
  if (process.argv.includes("--whisper")) {
    if (run(venvPython, ["-m", "pip", "install", "--quiet", "-r", "requirements-whisper.txt"], { shell: false })) say.ok("riconoscimento vocale locale (Whisper) installato");
    else say.warn("Whisper non installato: non è indispensabile.");
  }
}

console.log(`
  Fatto. Per accendere Jarvis:

    npm start            poi apri http://localhost:4173 con Chrome o Edge

  La prima volta ti chiede la chiave di Google Gemini (gratuita). Il resto è facoltativo.
`);
