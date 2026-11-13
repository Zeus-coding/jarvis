// J.A.R.V.I.S. — Ricerca su internet: Google (con Gemini) oppure fonti gratuite (Wikipedia, Google News, Open-Meteo).
import { geminiCall, pickGemini, textOf } from "./gemini.mjs";
import { json } from "./http.mjs";
import { key } from "./store.mjs";

export const UA = { "User-Agent": "JarvisPersonale/1.0 (assistente personale open source)" };
export async function wikipedia(query, n = 2) {
  const s = await fetch(`https://it.wikipedia.org/w/api.php?action=query&list=search&format=json&srlimit=${n}&srsearch=${encodeURIComponent(query)}`, { headers: UA, signal: AbortSignal.timeout(8000) }).then((r) => r.json());
  const titles = (s.query?.search || []).map((x) => x.title);
  const pages = await Promise.all(titles.map((t) => fetch(`https://it.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(t.replace(/ /g, "_"))}`, { headers: UA, signal: AbortSignal.timeout(8000) }).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
  return pages.filter((p) => p?.extract).map((p) => ({ title: p.title, text: p.extract }));
}
export async function news(query) {
  const xml = await fetch(`https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=it&gl=IT&ceid=IT:it`, { headers: UA, signal: AbortSignal.timeout(8000) }).then((r) => r.text());
  const strip = (s) => s.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  return [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].slice(0, 6).map((m) => {
    const t = strip(m[1].match(/<title>([\s\S]*?)<\/title>/)?.[1] || ""), d = m[1].match(/<pubDate>([\s\S]*?)<\/pubDate>/)?.[1];
    return `${d ? new Date(d).toLocaleDateString("it-IT", { day: "numeric", month: "short" }) + ": " : ""}${t}`;
  });
}
export const WMO = { 0: "sereno", 1: "quasi sereno", 2: "parzialmente nuvoloso", 3: "nuvoloso", 45: "nebbia", 48: "nebbia", 51: "pioviggine", 53: "pioviggine", 55: "pioviggine intensa", 61: "pioggia debole", 63: "pioggia", 65: "pioggia forte", 71: "neve debole", 73: "neve", 75: "neve forte", 80: "rovesci", 81: "rovesci", 82: "rovesci forti", 95: "temporale", 96: "temporale con grandine", 99: "temporale con grandine" };
export async function weather(place) {
  const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=it&name=${encodeURIComponent(place)}`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
  const p = g.results?.[0];
  if (!p) return `Non trovo la località «${place}».`;
  const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&timezone=auto&forecast_days=3&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,precipitation&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`, { signal: AbortSignal.timeout(8000) }).then((r) => r.json());
  const c = w.current, d = w.daily;
  const days = d.time.map((t, i) => `${i === 0 ? "oggi" : i === 1 ? "domani" : new Date(t).toLocaleDateString("it-IT", { weekday: "long" })}: ${WMO[d.weather_code[i]] || "variabile"}, minima ${Math.round(d.temperature_2m_min[i])}°, massima ${Math.round(d.temperature_2m_max[i])}°, pioggia ${d.precipitation_probability_max[i] ?? 0}%`);
  return `Meteo ${p.name}${p.admin1 ? ` (${p.admin1})` : ""}. Adesso: ${WMO[c.weather_code] || "variabile"}, ${Math.round(c.temperature_2m)}° (percepiti ${Math.round(c.apparent_temperature)}°), vento ${Math.round(c.wind_speed_10m)} km/h. ${days.join("; ")}. Fonte: Open-Meteo.`;
}
export async function freeSearch(query) {
  const [wiki, headlines] = await Promise.all([wikipedia(query).catch(() => []), news(query).catch(() => [])]);
  const parts = [];
  if (headlines.length) parts.push(`Ultime notizie (Google News):\n- ${headlines.join("\n- ")}`);
  if (wiki.length) parts.push(`Wikipedia:\n${wiki.map((w) => `- ${w.title}: ${w.text.slice(0, 700)}`).join("\n")}`);
  return parts.length ? `${parts.join("\n\n")}\n(Usa solo ciò che è pertinente; se non basta, dillo.)` : "Nessun risultato trovato.";
}

// Ricerca su internet: prima con Google dentro Gemini; se il piano gratuito non la consente, con le fonti gratuite
export let groundingDown = 0;
export async function webSearch(query) {
  if (!key("GEMINI_API_KEY") || Date.now() < groundingDown) return freeSearch(query);
  try {
    return await googleSearch(query);
  } catch (e) {
    if ([429, 403, 400].includes(e.status)) {
      markGroundingDown();
      console.warn("[mente] ricerca Google non disponibile sul piano attuale: uso Wikipedia e Google News");
    }
    return freeSearch(query);
  }
}
export async function googleSearch(query) {
  const model = await pickGemini("lite");
  const today = new Date().toLocaleDateString("it-IT", { day: "numeric", month: "long", year: "numeric" });
  const { parts, grounding } = await geminiCall(model, {
    contents: [{ role: "user", parts: [{ text: `Oggi è il ${today}. Cerca sul web e rispondi in italiano in modo fattuale e sintetico (massimo 150 parole), con date, numeri e nomi precisi.\nDomanda: ${query}` }] }],
    tools: [{ googleSearch: {} }],
  }, { stream: false });
  const sources = [...new Set((grounding?.groundingChunks || []).map((c) => c.web?.title).filter(Boolean))].slice(0, 5);
  return `${textOf(parts) || "Nessun risultato utile."}${sources.length ? `\nFonti: ${sources.join(", ")}` : ""}`;
}
export function markGroundingDown() { groundingDown = Date.now() + 3 * 3600e3; }
