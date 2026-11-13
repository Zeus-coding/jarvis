// J.A.R.V.I.S. — server locale.
// Custodisce chiavi e dati sul tuo computer, collega l'interfaccia al cervello AI (Google Gemini o OpenAI),
// alla voce, al calendario e alla memoria, e protegge con una password l'accesso dagli altri dispositivi.
// La logica sta nei moduli di src/: qui ci sono l'avvio e lo smistamento delle richieste HTTP.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { networkInterfaces } from "node:os";
import { HOST, PORT, TYPES, VOICE_URL, root } from "./src/config.mjs";
import { db, key, loadData, provider, saveData } from "./src/store.mjs";
import { send, html, json, rawBody, SECURITY } from "./src/http.mjs";
import { LOGIN_PAGE, NO_PASSWORD_PAGE, checkPassword, clientIp, cookies, hasSession, isLocal, passwordSet, tokenHash, tooMany } from "./src/auth.mjs";
import { briefing, todayAgenda } from "./src/agenda.mjs";
import { think, pickModel } from "./src/brain.mjs";
import { geminiModel } from "./src/gemini.mjs";
import { logExchange } from "./src/dialog.mjs";
import { reindexMemories } from "./src/memory.mjs";
import { importContacts, parseVcf, phoneShown, saveContact } from "./src/contacts.mjs";
import { applySetup, setupStatus } from "./src/settings.mjs";
import { tts, warmBriefing } from "./src/tts.mjs";
import { qrSvg, startTunnel, phoneUrl, tailscaleUrl } from "./src/tunnel.mjs";
import { lessonRoutes, loadLessons } from "./src/lessons.mjs";
import { dayRoutes } from "./src/day-routes.mjs";
import { startScheduler } from "./src/scheduler.mjs";
import { startVoiceService, stopVoiceService } from "./src/voice-service.mjs";

const SESSION_DAYS = 60;
const PUBLIC_WITHOUT_LOGIN = (p) => p.startsWith("/fonts/") || p.startsWith("/icons/") || p === "/manifest.webmanifest"; // niente di privato
const PAGES = { "/": "index.html", "/lezione": "lezione.html", "/giornata": "giornata.html" };
const STATIC_OK = /^(public\/[\w-]+(\/[\w.-]+)*\.(html|js|css|woff2|png|svg|webmanifest|txt)|music\/[^/]+\.mp3|node_modules\/three\/(build|examples)\/[\w./-]+\.js)$/i;

// ---------------------------------------------------------------- accesso
async function login(req, res) {
  const ip = clientIp(req);
  if (tooMany(ip)) return send(res, 429, { error: "Troppi tentativi: aspetta un minuto." });
  if (!passwordSet()) return send(res, 403, { error: "Nessuna password impostata sul computer di Jarvis." });
  const { password } = await json(req);
  if (typeof password !== "string" || !checkPassword(password)) {
    console.warn(`[accesso] password errata da ${ip}`);
    return send(res, 401, { error: "Password errata." });
  }
  const token = randomBytes(32).toString("base64url");
  db.sessions.push({ hash: tokenHash(token), exp: Date.now() + SESSION_DAYS * 864e5, ip, at: new Date().toISOString() });
  await saveData();
  console.log(`[accesso] nuovo dispositivo collegato (${ip})`);
  const secure = req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted ? "; Secure" : "";
  send(res, 200, { ok: true }, { "Set-Cookie": `jarvis_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_DAYS * 86400}${secure}` });
}
async function logout(req, res) {
  const token = cookies(req).jarvis_session;
  if (token) { const h = tokenHash(token); db.sessions = db.sessions.filter((s) => s.hash !== h); await saveData(); }
  send(res, 200, { ok: true }, { "Set-Cookie": "jarvis_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0" });
}
// chi non è sul computer di Jarvis e non ha fatto il login viene fermato qui
function gate(req, res, p) {
  if (PUBLIC_WITHOUT_LOGIN(p)) return false;
  if (p.startsWith("/api/")) return send(res, 401, { error: "Accesso richiesto" }), true;
  if (!passwordSet()) return html(res, 403, NO_PASSWORD_PAGE), true;
  if (p === "/login") return html(res, 200, LOGIN_PAGE), true;
  res.writeHead(302, { Location: "/login", "Cache-Control": "no-store" });
  res.end();
  return true;
}

// ---------------------------------------------------------------- conversazione (risposta in streaming)
async function chat(req, res) {
  const body = await json(req);
  const message = String(body.message || "").slice(0, 4000);
  const abort = new AbortController();
  res.on("close", () => { if (!res.writableFinished) abort.abort(); });
  res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no", ...SECURITY });
  const emit = (event) => !res.writableEnded && res.write(`data: ${JSON.stringify(event)}\n\n`);
  let reply = "";
  try {
    await think(message, body.history, (event) => { if (event.type === "delta") reply += event.text; emit(event); }, abort.signal);
    if (reply.trim() && message.trim()) logExchange(message, reply.trim());
  } catch (e) {
    if (!abort.signal.aborted) {
      console.warn(`[mente] ${e.message}`);
      if (!reply) emit({ type: "delta", text: brainError(e) });
    }
  }
  emit({ type: "done" });
  res.end();
}
function brainError(e) {
  const s = db.settings.addressAs, google = provider() === "gemini";
  if (e.status === 401 || e.status === 403) return `La chiave ${google ? "Google" : "OpenAI"} non è più valida, ${s}. Aggiornala dalla configurazione.`;
  if (e.status === 429) return google ? `Ho finito le richieste gratuite di Google per ora, ${s}. Riprova più tardi, oppure attiva la fatturazione in Google AI Studio.` : `L'account OpenAI ha esaurito il credito o è sovraccarico, ${s}.`;
  return `Ho perso il contatto con la mia mente, ${s}. Riprova tra un istante.`;
}

// ---------------------------------------------------------------- voce
async function speech(req, res) {
  const { text, quality } = await json(req);
  if (typeof text !== "string" || !text.trim()) return send(res, 400, { error: "testo vuoto" });
  if (db.settings.voiceMode === "browser") return send(res, 503, { error: "scelta la voce del browser" });
  try {
    const audio = await tts(text.trim().slice(0, 1200), quality === "high" ? "high" : "fast");
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": audio.length, "Cache-Control": "no-store", ...SECURITY });
    res.end(audio);
  } catch (e) {
    send(res, 503, { error: e.message }); // il browser userà la sua voce
  }
}
async function voiceHealth(res) {
  const eleven = Boolean(key("ELEVENLABS_API_KEY"));
  try {
    const r = await fetch(`${VOICE_URL}/health`, { signal: AbortSignal.timeout(1500) });
    send(res, 200, { ...(await r.json()), elevenlabs: eleven });
  } catch {
    send(res, 200, { ok: false, tts: false, whisper: false, elevenlabs: eleven });
  }
}
async function transcribe(req, res) {
  const audio = await rawBody(req);
  try {
    const r = await fetch(`${VOICE_URL}/transcribe`, { method: "POST", body: audio, headers: { "Content-Type": req.headers["content-type"] || "audio/webm" } });
    send(res, r.status, await r.json());
  } catch {
    send(res, 503, { error: "servizio vocale non attivo" });
  }
}

// ---------------------------------------------------------------- rubrica
async function contactsImport(req, res) {
  const raw = (await rawBody(req, 8e6)).toString("utf8");
  let list = null;
  if (/BEGIN:VCARD/i.test(raw)) list = parseVcf(raw);
  else {
    // dal selettore dei contatti di Android: [{ name: ["…"], tel: ["…"] }]
    try { list = JSON.parse(raw).contacts; } catch {}
    list = Array.isArray(list) ? list.map((c) => ({ name: [].concat(c.name || [])[0] || "", phones: [].concat(c.tel || c.phones || []) })) : null;
  }
  if (!list?.length) return send(res, 400, { error: "Nessun contatto con numero di telefono trovato." });
  const result = await importContacts(list);
  console.log(`[rubrica] importati ${result.added} nuovi contatti, ${result.updated} aggiornati`);
  send(res, 200, { ok: true, ...result });
}
const withShown = (c) => ({ ...c, shown: phoneShown(c.phone) });

// ---------------------------------------------------------------- API (dopo il controllo di accesso)
async function api(req, res, p, local) {
  const m = req.method;
  if (p === "/api/bootstrap") {
    const [brief, setup] = await Promise.all([briefing(), setupStatus()]);
    return send(res, 200, { settings: { addressAs: db.settings.addressAs }, setup, briefing: brief, local, memories: db.memories.slice(0, 5).map(({ embedding, ...rest }) => rest) });
  }
  if (p === "/api/setup" && m === "GET") return send(res, 200, await setupStatus());
  if (p === "/api/setup" && m === "POST") return send(res, 200, await applySetup(await json(req), { local }));
  if (p === "/api/briefing") return send(res, 200, await briefing());
  if (p === "/api/agenda") return send(res, 200, await todayAgenda());
  if (p === "/api/chat/stream" && m === "POST") return chat(req, res);
  if (p === "/api/tts" && m === "POST") return speech(req, res);
  if (p === "/api/stt" && m === "POST") return transcribe(req, res);
  if (p === "/api/voice/health") return voiceHealth(res);
  if (p === "/api/diag" && m === "POST") {
    const d = await json(req);
    console.log(`[ascolto · ${String(d.device || "?").slice(0, 20)}] ${String(d.kind || "").slice(0, 20)}: ${String(d.value || "").replace(/\s+/g, " ").slice(0, 300)}`);
    return send(res, 200, { ok: true });
  }
  if (p === "/api/memories" && m === "GET") return send(res, 200, { profile: db.profile, memories: db.memories.map(({ embedding, embedTag, ...rest }) => rest) });
  if (p === "/api/phone/qr" && m === "GET") {
    const url = phoneUrl();
    if (!url) return send(res, 404, { error: "Indirizzo per il telefono non attivo" });
    res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "no-store", ...SECURITY });
    return res.end(qrSvg(url));
  }
  if (p === "/api/contacts" && m === "GET") return send(res, 200, { contacts: db.contacts.map(withShown) });
  if (p === "/api/contacts" && m === "POST") {
    const b = await json(req);
    const c = await saveContact(b.name, b.phone);
    return c ? send(res, 200, { ok: true, contact: withShown(c) }) : send(res, 400, { error: "Nome o numero non validi." });
  }
  if (p === "/api/contacts/import" && m === "POST") return contactsImport(req, res);
  if (p === "/api/contacts" && m === "DELETE") { db.contacts = []; await saveData(); return send(res, 200, { ok: true }); }
  if (p.startsWith("/api/contacts/") && m === "DELETE") {
    const id = p.slice("/api/contacts/".length);
    db.contacts = db.contacts.filter((c) => c.id !== id);
    await saveData();
    return send(res, 200, { ok: true });
  }
  if (p.startsWith("/api/lesson") && (await lessonRoutes(req, res, p)) !== false) return;
  if (/^\/api\/(day|tasks|reviews|push)(\/|$)/.test(p) && (await dayRoutes(req, res, p)) !== false) return;
  send(res, 404, { error: "Indirizzo non trovato" });
}

// ---------------------------------------------------------------- file dell'interfaccia
// Solo public/ (interfaccia), three.js e la musica facoltativa: mai dati, chiavi o codice del server.
async function staticFile(res, p) {
  let rel = PAGES[p] ? `public/${PAGES[p]}` : decodeURIComponent(p.slice(1));
  if (!PAGES[p] && !rel.startsWith("node_modules/") && !rel.startsWith("music/")) rel = `public/${rel}`;
  const file = normalize(join(root, rel));
  const inside = file.slice(normalize(root).length).split(sep).join("/").replace(/^\//, "");
  if (!file.startsWith(normalize(root)) || inside.includes("..") || !STATIC_OK.test(inside)) return send(res, 403, { error: "Vietato" });
  const content = await readFile(file);
  res.writeHead(200, { "Content-Type": TYPES[extname(file)] || "application/octet-stream", "Cache-Control": "no-store", ...SECURITY });
  res.end(content);
}

async function handle(req, res) {
  const p = new URL(req.url, "http://localhost").pathname;
  // un altro sito non può mandare comandi a Jarvis dal tuo browser (protezione CSRF)
  const origin = req.headers.origin;
  if (req.method !== "GET" && req.method !== "HEAD" && origin) {
    let sameSite = false;
    try { sameSite = new URL(origin).host === req.headers.host; } catch {}
    if (!sameSite) return send(res, 403, { error: "Origine non consentita" });
  }
  if (p === "/api/login" && req.method === "POST") return login(req, res);
  if (p === "/api/logout" && req.method === "POST") return logout(req, res);
  const local = isLocal(req);
  if (!local && !hasSession(req) && gate(req, res, p)) return;
  if (p === "/login") { res.writeHead(302, { Location: "/" }); return res.end(); }
  if (p.startsWith("/api/")) return api(req, res, p, local);
  return staticFile(res, p);
}

// ---------------------------------------------------------------- avvio
await loadData();
await loadLessons();
startVoiceService();
startScheduler();
setTimeout(warmBriefing, 800); // prepara in anticipo la voce del saluto
setTimeout(() => {
  if (provider() === "gemini") geminiModel().catch(() => {});
  else if (provider() === "openai") pickModel().catch(() => {});
  reindexMemories();
}, 1200);
setInterval(() => { // sessioni scadute
  const before = db.sessions.length;
  db.sessions = db.sessions.filter((s) => s.exp > Date.now());
  if (db.sessions.length !== before) saveData();
}, 3600e3).unref();
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit());
process.on("exit", stopVoiceService);

createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (res.headersSent) return res.end();
    send(res, e.code === "ENOENT" ? 404 : e.code === "TOO_BIG" ? 413 : e instanceof SyntaxError ? 400 : 500, { error: e.message });
  });
})
  .on("error", (e) => {
    if (e.code === "EADDRINUSE") console.error(`\nLa porta ${PORT} è già occupata: probabilmente Jarvis è già acceso. Aprilo su http://localhost:${PORT}\n`);
    else console.error(e);
    process.exit(1);
  })
  .listen(PORT, HOST, () => {
    console.log(`\n  J.A.R.V.I.S. online  →  http://localhost:${PORT}\n`);
    if (HOST === "0.0.0.0")
      for (const list of Object.values(networkInterfaces()))
        for (const a of list || []) if (a.family === "IPv4" && !a.internal) console.log(`  dalla rete di casa  →  http://${a.address}:${PORT}${passwordSet() ? "" : "  (prima imposta una password in CONFIGURA)"}`);
    if (!provider()) console.log("  Prima configurazione: apri la pagina e inserisci la chiave Google Gemini (gratuita).\n");
    startTunnel();
    tailscaleUrl(); // se c'è l'indirizzo fisso di Tailscale lo scrive nel terminale
  });
