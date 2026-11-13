// J.A.R.V.I.S. — Modalità Lezione: trascrizione, foto della lavagna, appunti AI in tempo reale, export Word.
import { readFile, writeFile, mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { markdownToHtml, esc } from "../public/js/markdown.js";
import { dataDir } from "./config.mjs";
import { geminiCall, pickGemini, textOf } from "./gemini.mjs";
import { SECURITY, html, json, rawBody, send } from "./http.mjs";
import { saveMemory } from "./memory.mjs";
import { googleSearch, groundingDown, markGroundingDown, wikipedia } from "./search.mjs";
import { atomicWrite, db, key } from "./store.mjs";

// Il telefono manda la trascrizione (riconoscimento vocale del browser) e le foto della lavagna;
// ogni tanto Gemini riscrive gli appunti completi. Chi guarda la pagina li vede aggiornarsi in tempo reale.
export const lessonsDir = join(dataDir, "lessons");
export const lessons = new Map();
export const lessonSubs = new Map(); // id -> Set(res) delle pagine collegate
export const LESSON_PROMPT = `Sei l'assistente di studio di uno studente universitario italiano. Ricevi, un pezzo alla volta, la trascrizione automatica di una lezione in corso (piena di errori di riconoscimento) ed eventuali foto della lavagna o delle slide.
Il tuo compito è mantenere APPUNTI DI STUDIO eccellenti in Markdown, in italiano:
- un titolo "# ..." e sezioni "## ..." per argomento, nell'ordine in cui vengono spiegati; sottosezioni "### ..." se servono;
- frasi brevi ed elenchi puntati; definizioni con il termine in **grassetto**; esempi del professore; collegamenti tra concetti;
- formule e passaggi scritti in modo leggibile su una riga (es. "F = m · a", "x² + 2x + 1 = 0"); tabelle Markdown per confronti;
- quello che è scritto alla lavagna o nelle slide va integrato negli appunti (formule, schemi, dati);
- quando ci sono dati numerici confrontabili o un andamento, aggiungi un grafico come blocco
\`\`\`chart
{"type":"bar","title":"...","labels":["A","B"],"series":[{"name":"...","data":[1,2]}]}
\`\`\`
  (type può essere bar, line o pie; solo dati reali della lezione, mai inventati);
- correggi dal contesto gli errori evidenti della trascrizione (parole storpiate, termini tecnici); se un passaggio è incomprensibile segnalo con (?), non inventare;
- ignora chiacchiere, rumori, pause, battute e frasi organizzative non utili allo studio.
Rispondi SEMPRE e SOLO con gli appunti completi aggiornati (tutto il documento), senza premesse né commenti.`;
export const FINAL_TASK = `\n\nLA LEZIONE È FINITA. Rivedi e rendi gli appunti definitivi: riordina e unisci gli argomenti, completa formule ed esempi, elimina le ripetizioni. In fondo aggiungi le sezioni "## Riassunto" (5-8 frasi) e "## Possibili domande d'esame" (5-8 domande).`;

export async function loadLessons() {
  await mkdir(lessonsDir, { recursive: true });
  for (const d of await readdir(lessonsDir).catch(() => [])) {
    try { const l = JSON.parse(await readFile(join(lessonsDir, d, "lesson.json"), "utf8")); lessons.set(l.id, l); } catch {}
  }
}
export const lessonText = (l) => l.transcript.map((t) => t.text).join(" ");
export function lessonMeta(l) {
  return { id: l.id, title: l.title, startedAt: l.startedAt, endedAt: l.endedAt || null, active: !l.endedAt, words: lessonText(l).split(/\s+/).filter(Boolean).length, photos: l.photos.length, updatedAt: l.updatedAt || null };
}
export const lessonFull = (l) => ({ ...lessonMeta(l), notes: l.notes, transcript: l.transcript, photoList: l.photos.map((p, n) => ({ n, at: p.at })), busy: !!l.busy });
export const saveLesson = (l) => { const { busy, lastRun, cooldown, ...data } = l; return atomicWrite(join(lessonsDir, l.id, "lesson.json"), JSON.stringify(data)); };
export function lessonEmit(id, o) {
  const s = lessonSubs.get(id);
  if (s) for (const res of s) if (!res.writableEnded) res.write(`data: ${JSON.stringify(o)}\n\n`);
}
export async function startLesson(title) {
  const d = new Date();
  const id = `${d.toISOString().slice(0, 10)}-${randomBytes(3).toString("hex")}`;
  const l = { id, title: String(title || "").trim().slice(0, 120) || `Lezione del ${d.toLocaleDateString("it-IT")}`, startedAt: d.toISOString(), endedAt: null, transcript: [], photos: [], notes: "", processedChars: 0, processedPhotos: 0 };
  await mkdir(join(lessonsDir, id), { recursive: true });
  lessons.set(id, l);
  await saveLesson(l);
  console.log(`[lezione] iniziata: ${l.title}`);
  return l;
}
export async function lessonUpdate(l, { final = false } = {}) {
  if (l.busy || !key("GEMINI_API_KEY")) return false;
  const full = lessonText(l), fresh = full.slice(l.processedChars).trim();
  const photos = l.photos.slice(l.processedPhotos).slice(-3); // al massimo le 3 foto più recenti
  if (!final && !fresh && !photos.length) return false;
  l.busy = true;
  l.lastRun = Date.now();
  lessonEmit(l.id, { type: "status", busy: true, text: final ? "REVISIONE FINALE DEGLI APPUNTI" : "AGGIORNAMENTO APPUNTI" });
  const seenChars = full.length, seenPhotos = l.photos.length;
  try {
    const parts = [{ text: `TITOLO DELLA LEZIONE: ${l.title}\n\nAPPUNTI ATTUALI:\n${l.notes || "(ancora vuoti)"}\n\nNUOVA TRASCRIZIONE:\n${fresh || "(nessuna)"}${photos.length ? `\n\nIn allegato ${photos.length} foto della lavagna o delle slide.` : ""}${final ? FINAL_TASK : ""}` }];
    for (const ph of photos) {
      const data = await readFile(join(lessonsDir, l.id, ph.file)).catch(() => null);
      if (data) parts.push({ inlineData: { mimeType: "image/jpeg", data: data.toString("base64") } });
    }
    const model = await pickGemini(final && db.settings.modelTier === "flash" ? "flash" : "lite");
    const { parts: out } = await geminiCall(model, { systemInstruction: { parts: [{ text: LESSON_PROMPT }] }, contents: [{ role: "user", parts }] }, { stream: false, signal: AbortSignal.timeout(90000) });
    const notes = textOf(out).replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/i, "$1").trim();
    if (notes.length > 40) l.notes = notes;
    l.processedChars = seenChars;
    l.processedPhotos = seenPhotos;
    l.updatedAt = new Date().toISOString();
    await saveLesson(l);
    lessonEmit(l.id, { type: "notes", notes: l.notes, updatedAt: l.updatedAt });
    return true;
  } catch (e) {
    console.warn(`[lezione] appunti non aggiornati: ${e.message}`);
    if (e.status === 429) l.cooldown = Date.now() + 5 * 60_000;
    lessonEmit(l.id, { type: "status", busy: false, error: e.status === 429 ? "Limite gratuito di Google raggiunto: riprovo tra 5 minuti. La trascrizione continua." : "Aggiornamento non riuscito, riprovo tra poco." });
    return false;
  } finally {
    l.busy = false;
    lessonEmit(l.id, { type: "status", busy: false });
  }
}
export async function lessonDeepen(l) {
  const model = await pickGemini("lite");
  const ask = `Questi sono gli appunti di una lezione universitaria.\n\n${l.notes.slice(0, 12000)}\n\nScrivi in italiano una sezione di approfondimento in Markdown (usa "### " per ogni concetto) sui 3-5 concetti più importanti: chiarimenti, esempi pratici e collegamenti`;
  const rules = `Massimo 400 parole. Niente premesse e niente titolo principale.`;
  if (Date.now() >= groundingDown) {
    try {
      const { parts, grounding } = await geminiCall(model, { contents: [{ role: "user", parts: [{ text: `${ask}, con informazioni verificate dal web. ${rules}` }] }], tools: [{ googleSearch: {} }] }, { stream: false, signal: AbortSignal.timeout(90000) });
      const text = textOf(parts);
      const sources = [...new Set((grounding?.groundingChunks || []).map((c) => c.web?.title).filter(Boolean))].slice(0, 8);
      if (text) return `${text}${sources.length ? `\n\n*Fonti: ${sources.join(", ")}*` : ""}`;
    } catch (e) {
      if (![429, 403, 400].includes(e.status)) throw e;
      markGroundingDown();
    }
  }
  // senza ricerca Google: le voci di Wikipedia sugli argomenti principali (titoli delle sezioni) come materiale di riferimento
  const topics = [...l.notes.matchAll(/^#{2,3}\s+(.+)$/gm)].map((m) => m[1].replace(/[*`]/g, "").trim())
    .filter((t) => !/riassunto|domande|approfond/i.test(t)).slice(0, 4);
  const pages = (await Promise.all(topics.map((t) => wikipedia(`${t} ${l.title}`, 1).catch(() => [])))).flat();
  const unique = [...new Map(pages.map((p) => [p.title, p])).values()];
  const ref = unique.map((p) => `[${p.title}] ${p.text}`).join("\n\n");
  const { parts } = await geminiCall(model, { contents: [{ role: "user", parts: [{ text: `${ask}.${ref ? ` Usa come riferimento queste voci di Wikipedia, senza copiarle:\n\n${ref}\n\n` : " "}${rules}` }] }] }, { stream: false, signal: AbortSignal.timeout(90000) });
  const text = textOf(parts);
  return text ? `${text}${unique.length ? `\n\n*Fonti: Wikipedia (${unique.map((p) => p.title).join(", ")})*` : ""}` : "";
}
export async function endLesson(l) {
  if (l.endedAt) return;
  l.endedAt = new Date().toISOString();
  await saveLesson(l);
  lessonEmit(l.id, { type: "ended", endedAt: l.endedAt });
  if (!lessonText(l).trim() && !l.photos.length) return;
  for (let i = 0; i < 20 && l.busy; i++) await new Promise((ok) => setTimeout(ok, 1500));
  await lessonUpdate(l, { final: true });
  try {
    lessonEmit(l.id, { type: "status", busy: true, text: "RICERCA DI APPROFONDIMENTI SUL WEB" });
    const extra = await lessonDeepen(l);
    if (extra) { l.notes = `${l.notes}\n\n## Approfondimenti dal web\n\n${extra}`; await saveLesson(l); lessonEmit(l.id, { type: "notes", notes: l.notes, updatedAt: new Date().toISOString() }); }
  } catch (e) {
    console.warn(`[lezione] approfondimenti non riusciti: ${e.message}`);
  } finally {
    lessonEmit(l.id, { type: "status", busy: false });
  }
  // Jarvis si ricorda della lezione (così può interrogarti o riprenderla in seguito)
  const summary = (l.notes.match(/## Riassunto\s*\n([\s\S]*?)(?=\n## |$)/)?.[1] || l.notes.slice(0, 600)).replace(/\s+/g, " ").trim().slice(0, 900);
  if (summary) await saveMemory(`Lezione «${l.title}» del ${new Date(l.startedAt).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" })}: ${summary}`, { kind: "diary" }).catch(() => {});
  console.log(`[lezione] conclusa: ${l.title}`);
}
// controllo periodico: aggiorna gli appunti quando c'è abbastanza materiale nuovo (senza sprecare richieste gratuite)
setInterval(() => {
  const now = Date.now();
  for (const l of lessons.values()) {
    if (l.endedAt || l.busy || (l.cooldown && now < l.cooldown)) continue;
    const fresh = lessonText(l).length - l.processedChars, photos = l.photos.length - l.processedPhotos, since = now - (l.lastRun || 0);
    if ((fresh >= 700 && since >= 60_000) || (fresh >= 120 && since >= 150_000) || (photos > 0 && since >= 60_000)) lessonUpdate(l);
  }
}, 15_000).unref();
setInterval(() => { for (const s of lessonSubs.values()) for (const res of s) if (!res.writableEnded) res.write(": ping\n\n"); }, 25_000).unref();

export function lessonWord(l) {
  const date = new Date(l.startedAt).toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  const transcript = l.transcript.map((t) => esc(t.text)).join(" ");
  return `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word" xmlns="http://www.w3.org/TR/REC-html40">
<head><meta charset="utf-8"><title>${esc(l.title)}</title>
<style>body{font-family:Calibri,Arial,sans-serif;font-size:11pt;line-height:1.4}h1{font-size:22pt;color:#1f3864}h2{font-size:16pt;color:#2f5496;margin-top:18pt}h3{font-size:13pt;color:#2f5496}
table{border-collapse:collapse;margin:6pt 0}td,th{border:1px solid #999;padding:3pt 6pt}th{background:#d9e2f3}code,pre{font-family:Consolas,monospace}blockquote{border-left:3pt solid #2f5496;padding-left:8pt;color:#444}
li.d1{margin-left:18pt}li.d2{margin-left:36pt}li.d3{margin-left:54pt}figcaption{font-weight:bold;margin-bottom:3pt}.meta{color:#666}.transcript{font-size:9pt;color:#555}</style></head>
<body><p class="meta">${esc(date)} · appunti generati da J.A.R.V.I.S.${l.photos.length ? ` · ${l.photos.length} foto della lavagna salvate in Jarvis` : ""}</p>
${l.notes ? markdownToHtml(l.notes) : `<h1>${esc(l.title)}</h1><p>Appunti non ancora disponibili.</p>`}
${transcript ? `<br style="page-break-before:always"><h2>Trascrizione completa</h2><p class="transcript">${transcript}</p>` : ""}
</body></html>`;
}

export async function lessonRoutes(req, res, p) {
  if (p === "/api/lessons" && req.method === "GET") return send(res, 200, { lessons: [...lessons.values()].map(lessonMeta).sort((a, b) => b.startedAt.localeCompare(a.startedAt)), ai: !!key("GEMINI_API_KEY") });
  if (p === "/api/lesson/start" && req.method === "POST") {
    if (!key("GEMINI_API_KEY")) return send(res, 400, { error: "La modalità lezione richiede la chiave Google Gemini (CONFIGURA)." });
    const b = await json(req);
    return send(res, 200, lessonFull(await startLesson(b.title)));
  }
  const m = p.match(/^\/api\/lesson\/([\w-]+)(?:\/([\w.]+))?(?:\/(\d+))?$/);
  if (!m) return false;
  const l = lessons.get(m[1]), action = m[2] || "";
  if (!l) return send(res, 404, { error: "Lezione non trovata" });
  if (!action && req.method === "GET") return send(res, 200, lessonFull(l));
  if (!action && req.method === "DELETE") {
    lessons.delete(l.id);
    await rm(join(lessonsDir, l.id), { recursive: true, force: true });
    return send(res, 200, { ok: true });
  }
  if (action === "events" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Accel-Buffering": "no", ...SECURITY });
    res.write(`data: ${JSON.stringify({ type: "snapshot", lesson: lessonFull(l) })}\n\n`);
    if (!lessonSubs.has(l.id)) lessonSubs.set(l.id, new Set());
    lessonSubs.get(l.id).add(res);
    req.on("close", () => lessonSubs.get(l.id)?.delete(res));
    return true;
  }
  if (action === "text" && req.method === "POST") {
    const { text } = await json(req);
    const t = String(text || "").replace(/\s+/g, " ").trim().slice(0, 3000);
    if (!t || l.endedAt) return send(res, 200, { ok: false });
    const item = { at: new Date().toISOString(), text: t };
    l.transcript.push(item);
    saveLesson(l);
    lessonEmit(l.id, { type: "transcript", ...item });
    return send(res, 200, { ok: true });
  }
  if (action === "photo" && req.method === "POST") {
    const body = await rawBody(req, 8e6);
    if (body[0] !== 0xff || body[1] !== 0xd8) return send(res, 400, { error: "serve un'immagine JPEG" });
    const n = l.photos.length, file = `photo-${n}.jpg`;
    await writeFile(join(lessonsDir, l.id, file), body);
    l.photos.push({ at: new Date().toISOString(), file });
    await saveLesson(l);
    lessonEmit(l.id, { type: "photo", n, at: l.photos[n].at });
    return send(res, 200, { ok: true, n });
  }
  if (action === "photo" && req.method === "GET" && m[3] !== undefined) {
    const ph = l.photos[Number(m[3])];
    if (!ph) return send(res, 404, { error: "Foto non trovata" });
    const img = await readFile(join(lessonsDir, l.id, ph.file));
    res.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": img.length, "Cache-Control": "private, max-age=86400", ...SECURITY });
    return res.end(img);
  }
  if (action === "update" && req.method === "POST") return send(res, 200, { ok: await lessonUpdate(l) });
  if (action === "end" && req.method === "POST") { endLesson(l); return send(res, 200, { ok: true }); }
  if (action === "export.doc" && req.method === "GET") {
    const name = `Lezione - ${l.title}`.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 100);
    res.writeHead(200, { "Content-Type": "application/msword; charset=utf-8", "Content-Disposition": `attachment; filename="lezione.doc"; filename*=UTF-8''${encodeURIComponent(name)}.doc`, "Cache-Control": "no-store", ...SECURITY });
    return res.end(`﻿${lessonWord(l)}`);
  }
  return send(res, 404, { error: "Azione non trovata" });
}
