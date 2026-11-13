// J.A.R.V.I.S. — Indirizzo HTTPS per il telefono con Cloudflare Tunnel e QR code.
import { writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import qrcode from "qrcode-generator";
import { passwordSet } from "./auth.mjs";
import { PORT, dataDir } from "./config.mjs";
import { db } from "./store.mjs";

// Jarvis avvia da solo il tunnel e ricorda l'indirizzo HTTPS (cambia a ogni avvio): lo trovi in CONFIGURA con il QR code.
export const tunnel = { proc: null, url: null, error: null, retry: 0, bin: undefined };
export function cloudflaredPath() {
  if (tunnel.bin !== undefined) return tunnel.bin;
  const known = [process.env.CLOUDFLARED_PATH, "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe", "C:\\Program Files\\cloudflared\\cloudflared.exe", "/opt/homebrew/bin/cloudflared", "/usr/local/bin/cloudflared", "/usr/bin/cloudflared"].filter(Boolean);
  let bin = known.find((p) => existsSync(p)) || null;
  if (!bin) {
    const r = spawnSync(process.platform === "win32" ? "where" : "which", ["cloudflared"], { encoding: "utf8" });
    if (r.status === 0) bin = r.stdout.split(/\r?\n/)[0].trim() || null;
  }
  return (tunnel.bin = bin);
}
export function startTunnel() {
  if (tunnel.proc || !db.settings.phoneTunnel) return;
  if (!passwordSet()) { tunnel.error = "Imposta prima una password."; return; }
  const bin = cloudflaredPath();
  if (!bin) { tunnel.error = "Cloudflare Tunnel non è installato (winget install --id Cloudflare.cloudflared)."; return; }
  tunnel.error = null;
  tunnel.url = null;
  const proc = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${PORT}`], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  tunnel.proc = proc;
  const read = (chunk) => {
    const m = String(chunk).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (!m || m[0] === tunnel.url) return;
    tunnel.url = m[0];
    tunnel.retry = 0;
    console.log(`\n  📱 Dal telefono  →  ${tunnel.url}   (anche in CONFIGURA, con il QR code)\n`);
    writeFile(join(dataDir, "telefono.txt"), `${tunnel.url}\n`).catch(() => {});
  };
  proc.stdout.on("data", read);
  proc.stderr.on("data", read);
  proc.on("error", (e) => { tunnel.error = e.message; });
  proc.on("exit", () => {
    if (tunnel.proc !== proc) return;
    tunnel.proc = null;
    tunnel.url = null;
    if (db.settings.phoneTunnel) setTimeout(startTunnel, Math.min(60_000, 3000 * 2 ** tunnel.retry++)); // si è chiuso: riprova
  });
}
export function stopTunnel() {
  const p = tunnel.proc;
  tunnel.proc = null;
  tunnel.url = null;
  try { p?.kill(); } catch {}
}
process.on("exit", () => { try { tunnel.proc?.kill(); } catch {} });

// ---------------------------------------------------------------- Tailscale (indirizzo fisso e privato)
// Se il computer è nella rete privata Tailscale e `tailscale serve` inoltra la porta di Jarvis,
// l'indirizzo https://<computer>.<rete>.ts.net non cambia mai: è quello da usare per l'app sul telefono.
const TAILSCALE = ["C:\\Program Files\\Tailscale\\tailscale.exe", "/usr/bin/tailscale", "/usr/local/bin/tailscale", "/Applications/Tailscale.app/Contents/MacOS/Tailscale"];
let tailscaleCache = { at: 0, url: null };
export function tailscaleUrl() {
  if (Date.now() - tailscaleCache.at < 60_000) return tailscaleCache.url;
  let url = null;
  const bin = TAILSCALE.find((p) => existsSync(p));
  if (bin) {
    try {
      const status = JSON.parse(spawnSync(bin, ["status", "--json"], { encoding: "utf8", timeout: 4000, windowsHide: true }).stdout || "{}");
      const name = String(status.Self?.DNSName || "").replace(/\.$/, "");
      const serve = spawnSync(bin, ["serve", "status"], { encoding: "utf8", timeout: 4000, windowsHide: true }).stdout || "";
      if (status.BackendState === "Running" && name && serve.includes(`127.0.0.1:${PORT}`)) url = `https://${name}`;
    } catch {}
  }
  if (url && url !== tailscaleCache.url) console.log(`\n  📱 Indirizzo fisso per il telefono (Tailscale)  →  ${url}\n`);
  tailscaleCache = { at: Date.now(), url };
  return url;
}
// l'indirizzo da mostrare per il telefono: quello fisso se c'è, altrimenti quello di Cloudflare
export const phoneUrl = () => tailscaleUrl() || tunnel.url;

export function qrSvg(text) {
  const q = qrcode(0, "M");
  q.addData(text);
  q.make();
  return q.createSvgTag({ cellSize: 6, margin: 3, scalable: true });
}
