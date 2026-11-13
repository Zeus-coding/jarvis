// Controlla la sintassi di tutti i file JavaScript del progetto (usato in locale e dalla CI di GitHub).
import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const skip = new Set(["node_modules", ".venv", ".git", "data", "__pycache__"]);
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.(m?js)$/.test(name)) files.push(p);
  }
})(root);

let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) { failed++; console.error(`✖ ${relative(root, f)}\n${r.stderr}`); }
}
console.log(`${files.length - failed}/${files.length} file senza errori di sintassi`);
process.exit(failed ? 1 : 0);
