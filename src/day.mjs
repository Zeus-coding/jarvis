// J.A.R.V.I.S. — «La mia giornata»: agenda, attività, meteo, lezioni e revisioni in un colpo d'occhio, più un riepilogo scritto dall'AI.
import { db } from "./store.mjs";
import { agenda } from "./agenda.mjs";
import { listTasks, doneOn } from "./tasks.mjs";
import { dayKey, dayReview, weekReview, weekKey, recentReviews } from "./reviews.mjs";
import { complete } from "./dialog.mjs";
import { lessons } from "./lessons.mjs";

const CODES = { 0: ["sereno", "☀"], 1: ["quasi sereno", "🌤"], 2: ["parz. nuvoloso", "⛅"], 3: ["nuvoloso", "☁"], 45: ["nebbia", "🌫"], 48: ["nebbia", "🌫"], 51: ["pioviggine", "🌦"], 53: ["pioviggine", "🌦"], 55: ["pioviggine", "🌦"], 61: ["pioggia debole", "🌧"], 63: ["pioggia", "🌧"], 65: ["pioggia forte", "🌧"], 71: ["neve", "🌨"], 73: ["neve", "🌨"], 75: ["neve forte", "🌨"], 80: ["rovesci", "🌦"], 81: ["rovesci", "🌧"], 82: ["rovesci forti", "⛈"], 95: ["temporale", "⛈"], 96: ["temporale", "⛈"], 99: ["temporale", "⛈"] };
let weatherCache = { city: "", at: 0, data: null };

// meteo strutturato (Open-Meteo, gratuito e senza chiave), in cache per 20 minuti
export async function weatherData(city) {
  if (!city) return null;
  if (weatherCache.city === city && Date.now() - weatherCache.at < 20 * 60_000) return weatherCache.data;
  try {
    const g = await fetch(`https://geocoding-api.open-meteo.com/v1/search?count=1&language=it&name=${encodeURIComponent(city)}`, { signal: AbortSignal.timeout(6000) }).then((r) => r.json());
    const p = g.results?.[0];
    if (!p) return null;
    const w = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${p.latitude}&longitude=${p.longitude}&timezone=auto&forecast_days=2&current=temperature_2m,weather_code&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`, { signal: AbortSignal.timeout(6000) }).then((r) => r.json());
    const [desc, icon] = CODES[w.current.weather_code] || ["variabile", "·"];
    const data = {
      place: p.name, now: Math.round(w.current.temperature_2m), desc, icon,
      min: Math.round(w.daily.temperature_2m_min[0]), max: Math.round(w.daily.temperature_2m_max[0]), rain: w.daily.precipitation_probability_max[0] ?? 0,
      tomorrow: { desc: (CODES[w.daily.weather_code[1]] || ["variabile"])[0], min: Math.round(w.daily.temperature_2m_min[1]), max: Math.round(w.daily.temperature_2m_max[1]) },
    };
    weatherCache = { city, at: Date.now(), data };
    return data;
  } catch {
    return weatherCache.city === city ? weatherCache.data : null;
  }
}

const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
function greeting(d = new Date()) {
  const h = d.getHours();
  return h < 5 ? "Buonanotte" : h < 13 ? "Buongiorno" : h < 18 ? "Buon pomeriggio" : "Buonasera";
}

export async function dayOverview() {
  const now = new Date(), key = dayKey(now);
  const [{ all }, weather] = await Promise.all([agenda(2).catch(() => ({ all: [] })), weatherData(db.settings.city)]);
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  const ev = (e) => ({ title: e.title, time: e.allDay ? "" : hhmm(e.start), location: e.location || "", past: e.end < now });
  const [h, m] = String(db.settings.reviewTime || "21:30").split(":").map(Number);
  return {
    greeting: greeting(now), addressAs: db.settings.addressAs, date: now.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" }),
    weather,
    today: all.filter((e) => e.start < tomorrow).map(ev),
    tomorrow: all.filter((e) => e.start >= tomorrow).map(ev),
    tasks: listTasks().filter((t) => !t.done || dayKey(new Date(t.doneAt)) === key).slice(0, 40),
    doneToday: doneOn(key).length,
    lessons: [...lessons.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 3).map((l) => ({ id: l.id, title: l.title, date: l.startedAt, active: !l.endedAt })),
    review: dayReview(key),
    reviewDue: !dayReview(key) && now.getHours() * 60 + now.getMinutes() >= h * 60 + m,
    week: weekReview(weekKey(now)) || recentReviews(20).find((r) => r.type === "week") || null,
    reviewTime: db.settings.reviewTime,
  };
}

// riepilogo scritto: il "briefing" della pagina, rigenerato al massimo ogni 30 minuti (le richieste gratuite sono poche)
let summaryCache = { key: "", at: 0, text: "" };
export async function daySummary(force = false) {
  const o = await dayOverview();
  const key = JSON.stringify([o.today.map((e) => e.title), o.tasks.filter((t) => !t.done).map((t) => t.title), o.doneToday, o.weather?.desc]);
  if (!force && summaryCache.key === key && Date.now() - summaryCache.at < 30 * 60_000) return summaryCache.text;
  const text = await complete(`Sei J.A.R.V.I.S. Scrivi il riepilogo della giornata per l'utente, in italiano, 2-4 frasi, concreto: cosa lo aspetta, cosa conviene fare prima, un consiglio pratico.
Chiamalo "${o.addressAs}" e dagli del TU (es. "hai", "ti conviene", "puoi"), mai del Lei. Non salutare e non ripetere data e ora: vai subito al punto.
Dati (usa solo questi):
- ${o.date}, ora ${hhmm(new Date())}
- Meteo: ${o.weather ? `${o.weather.desc}, ${o.weather.min}-${o.weather.max}°, pioggia ${o.weather.rain}%` : "non disponibile"}
- Impegni di oggi: ${o.today.map((e) => `${e.time} ${e.title}${e.past ? " (passato)" : ""}`).join("; ") || "nessuno"}
- Domani: ${o.tomorrow.map((e) => `${e.time} ${e.title}`).join("; ") || "nessuno"}
- Attività aperte: ${o.tasks.filter((t) => !t.done).map((t) => t.title + (t.due ? ` (entro ${t.due})` : "")).join("; ") || "nessuna"}
- Completate oggi: ${o.doneToday}
Niente elenchi puntati, niente markdown.`);
  summaryCache = { key, at: Date.now(), text: text.trim() };
  return summaryCache.text;
}
