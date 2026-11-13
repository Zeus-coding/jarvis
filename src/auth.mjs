// J.A.R.V.I.S. — Accesso protetto: password, sessioni, limite ai tentativi, pagine di login.
import { randomBytes, createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { PORT, root } from "./config.mjs";
import { html, json } from "./http.mjs";
import { db, secrets } from "./store.mjs";

// Dal PC stesso (localhost) si entra senza password. Da qualunque altro dispositivo serve la password.
export const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
export const hostName = (h = "") => (h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : h.split(":")[0]).toLowerCase();
export function isLocal(req) {
  const ip = req.socket.remoteAddress || "";
  const loop = ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  // dietro un proxy (server con HTTPS) le richieste arrivano da 127.0.0.1 ma sono remote: X-Forwarded-For lo rivela
  return loop && !req.headers["x-forwarded-for"] && !req.headers["forwarded"] && !process.env.JARVIS_REQUIRE_PASSWORD && LOCAL_HOSTS.has(hostName(req.headers.host));
}
export function clientIp(req) {
  const ip = req.socket.remoteAddress || "";
  const fwd = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  return (ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1") && fwd ? fwd : ip;
}
export function hashPassword(pw, salt = randomBytes(16).toString("hex")) {
  return `${salt}:${scryptSync(pw, salt, 32).toString("hex")}`;
}
export function checkPassword(pw) {
  if (process.env.JARVIS_PASSWORD) {
    const a = createHash("sha256").update(pw).digest(), b = createHash("sha256").update(process.env.JARVIS_PASSWORD).digest();
    return timingSafeEqual(a, b);
  }
  const stored = secrets.ACCESS_PASSWORD_HASH;
  if (!stored) return false;
  const [salt, hex] = stored.split(":");
  const got = scryptSync(pw, salt, 32), want = Buffer.from(hex, "hex");
  return got.length === want.length && timingSafeEqual(got, want);
}
export const passwordSet = () => !!(process.env.JARVIS_PASSWORD || secrets.ACCESS_PASSWORD_HASH);
export const tokenHash = (t) => createHash("sha256").update(t).digest("hex");
export function cookies(req) {
  return Object.fromEntries(String(req.headers.cookie || "").split(";").map((c) => c.trim().split("=")).filter((x) => x.length === 2));
}
export function hasSession(req) {
  const t = cookies(req).jarvis_session;
  if (!t) return false;
  const h = tokenHash(t), now = Date.now();
  return db.sessions.some((s) => s.hash === h && s.exp > now);
}
export const attempts = new Map(); // ip -> { n, reset }: massimo 5 tentativi di password al minuto
export function tooMany(ip) {
  const now = Date.now(), a = attempts.get(ip);
  if (!a || a.reset < now) { attempts.set(ip, { n: 1, reset: now + 60_000 }); return false; }
  return ++a.n > 5;
}
export const LOGIN_PAGE = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#000"><title>J.A.R.V.I.S.</title>
<style>:root{color-scheme:dark}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:15px system-ui,sans-serif;padding:16px;box-sizing:border-box}
form{width:min(360px,100%);display:grid;gap:14px;text-align:center}b{font-weight:300;letter-spacing:.4em;font-size:22px}small{color:#888;letter-spacing:.2em;font-size:10px}
input,button{font:inherit;padding:14px;border:1px solid #444;background:#000;color:#fff}button{background:#fff;color:#000;border-color:#fff;letter-spacing:.2em;font-size:12px;cursor:pointer}p{color:#ff8a8a;min-height:1em;margin:0;font-size:13px}</style></head>
<body><form id="f"><b>J.A.R.V.I.S.</b><small>ACCESSO PROTETTO</small><input id="p" type="password" placeholder="Password" autocomplete="current-password" autofocus><button>ENTRA</button><p id="e"></p></form>
<script>f.onsubmit=async(ev)=>{ev.preventDefault();e.textContent="";const r=await fetch("/api/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:p.value})});if(r.ok)location.href="/";else e.textContent=(await r.json().catch(()=>({}))).error||"Errore";};</script></body></html>`;
export const NO_PASSWORD_PAGE = `<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>J.A.R.V.I.S.</title></head>
<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#000;color:#fff;font:15px system-ui,sans-serif;padding:16px;text-align:center"><div><b style="font-weight:300;letter-spacing:.4em">J.A.R.V.I.S.</b><p style="color:#aaa;max-width:420px;line-height:1.5">L'accesso da altri dispositivi è disattivato finché non imposti una password.<br>Aprilo dal computer su cui gira (http://localhost:${PORT}) → CONFIGURA → Accesso da telefono.</p></div></body></html>`;
