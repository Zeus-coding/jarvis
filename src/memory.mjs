// J.A.R.V.I.S. — Memoria a lungo termine: embeddings, ricerca per significato, ricordi fondamentali.
import { randomUUID } from "node:crypto";
import { GEMINI_URL, OPENAI_URL } from "./config.mjs";
import { gHeaders, geminiModels } from "./gemini.mjs";
import { json } from "./http.mjs";
import { db, key, saveData } from "./store.mjs";

// Tre livelli: il profilo scritto dall'utente ("chi sono"), i ricordi fondamentali (sempre presenti)
// e tutti gli altri ricordi e i diari delle conversazioni passate (ripescati per somiglianza di significato).
export function cosine(a, b) {
  let d = 0, x = 0, y = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) { d += a[i] * b[i]; x += a[i] ** 2; y += b[i] ** 2; }
  return d / (Math.sqrt(x * y) || 1);
}
export let geminiEmbedModel = null;
export async function embedTag() {
  if (key("GEMINI_API_KEY")) {
    if (!geminiEmbedModel) {
      try {
        const ids = (await geminiModels()).filter((m) => m.methods.includes("embedContent")).map((m) => m.id);
        geminiEmbedModel = ids.find((id) => id === "gemini-embedding-001") || ids.find((id) => /^gemini-embedding/.test(id) && !/exp|preview/.test(id)) || ids.find((id) => /embedding/.test(id)) || "gemini-embedding-001";
      } catch { return null; }
    }
    return `gemini:${geminiEmbedModel}`;
  }
  return key("OPENAI_API_KEY") ? "openai:text-embedding-3-small" : null;
}
export const DIMS = 768;
export const round = (v) => v.map((x) => Math.round(x * 1e4) / 1e4); // file più leggero, precisione più che sufficiente
export async function embedMany(texts) {
  const tag = await embedTag();
  if (!tag || !texts.length) return null;
  if (tag.startsWith("gemini:")) {
    const model = tag.slice(7);
    const r = await fetch(`${GEMINI_URL}/models/${model}:batchEmbedContents`, {
      method: "POST", headers: gHeaders(), signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ requests: texts.map((t) => ({ model: `models/${model}`, content: { parts: [{ text: t }] }, outputDimensionality: DIMS })) }),
    });
    if (!r.ok) return null;
    return { tag, vectors: ((await r.json()).embeddings || []).map((e) => round(e.values || [])) };
  }
  const r = await fetch(`${OPENAI_URL}/embeddings`, {
    method: "POST", headers: { Authorization: `Bearer ${key("OPENAI_API_KEY")}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(15000),
    body: JSON.stringify({ model: "text-embedding-3-small", input: texts, dimensions: DIMS }),
  });
  if (!r.ok) return null;
  return { tag, vectors: ((await r.json()).data || []).map((d) => round(d.embedding || [])) };
}
export async function embedOne(text) {
  const r = await embedMany([text]).catch(() => null);
  return r?.vectors?.[0]?.length ? { tag: r.tag, vector: r.vectors[0] } : null;
}
// ricalcola gli "indici" dei ricordi creati con un altro motore (per esempio passando da OpenAI a Gemini)
export let reindexing = false;
export async function reindexMemories() {
  if (reindexing) return;
  reindexing = true;
  try {
    const tag = await embedTag();
    if (!tag) return;
    for (;;) {
      const todo = db.memories.filter((m) => m.embedTag !== tag).slice(0, 50);
      if (!todo.length) break;
      const r = await embedMany(todo.map((m) => m.text)).catch(() => null);
      if (!r || r.vectors.length !== todo.length) break;
      todo.forEach((m, i) => { m.embedding = r.vectors[i]; m.embedTag = r.tag; });
      await saveData();
      console.log(`[memoria] reindicizzati ${todo.length} ricordi`);
    }
  } finally {
    reindexing = false;
  }
}
export async function recall(q) {
  const pool = db.memories.filter((m) => !m.core);
  if (!pool.length) return [];
  const e = await embedOne(q);
  if (e) {
    if (pool.some((m) => m.embedTag !== e.tag)) reindexMemories();
    return pool.filter((m) => m.embedTag === e.tag).map((m) => ({ ...m, score: cosine(e.vector, m.embedding) }))
      .sort((a, b) => b.score - a.score).slice(0, 8).filter((m) => m.score > 0.35);
  }
  const words = q.toLowerCase().split(/\W+/).filter((w) => w.length > 3);
  return pool.filter((m) => words.some((w) => m.text.toLowerCase().includes(w))).slice(0, 6);
}
export async function saveMemory(text, { core = false, kind = "fact" } = {}) {
  const e = await embedOne(text);
  // niente doppioni: se esiste già un ricordo quasi identico lo aggiorna
  if (e) {
    const dup = db.memories.find((m) => m.embedTag === e.tag && m.kind !== "diary" && cosine(e.vector, m.embedding) > 0.93);
    if (dup && kind !== "diary") {
      Object.assign(dup, { text, core: dup.core || core, updatedAt: new Date().toISOString(), embedding: e.vector });
      await saveData();
      return dup;
    }
  }
  const m = { id: randomUUID(), text, kind, core, createdAt: new Date().toISOString(), embedding: e?.vector || [], embedTag: e?.tag || null };
  db.memories.unshift(m);
  await saveData();
  return m;
}
export async function forgetMemory(query) {
  const q = query.toLowerCase();
  let target = db.memories.find((m) => m.text.toLowerCase().includes(q));
  if (!target) {
    const e = await embedOne(query);
    if (e) target = db.memories.filter((m) => m.embedTag === e.tag).map((m) => ({ m, s: cosine(e.vector, m.embedding) })).sort((a, b) => b.s - a.s).find((x) => x.s > 0.6)?.m;
  }
  if (!target) return null;
  db.memories = db.memories.filter((m) => m !== target);
  await saveData();
  return target;
}
export function resetEmbeddings() { geminiEmbedModel = null; }
