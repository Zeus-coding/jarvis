// J.A.R.V.I.S. — lettore di calendari iCalendar (.ics, RFC 5545): Google Calendar, iCloud, Outlook.
// Solo lettura. Gestisce fusi orari, giornate intere, eventi annullati, ricorrenze comuni (giornaliere,
// settimanali con giorni specifici, mensili, annuali), eccezioni (EXDATE) e singole occorrenze modificate.

const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
const MAX_STEPS = 4000; // limite di sicurezza per le ricorrenze infinite

// ---------------------------------------------------------------- lettura del file
// Le righe lunghe sono "piegate": una riga che inizia con spazio o tab continua la precedente.
function unfold(text) {
  return text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n");
}
// "DTSTART;TZID=Europe/Rome:20261120T090000" → { name, params: { TZID }, value }
function property(line) {
  const colon = line.indexOf(":");
  if (colon < 0) return null;
  const [name, ...rawParams] = line.slice(0, colon).split(";");
  const params = {};
  for (const p of rawParams) { const eq = p.indexOf("="); if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, ""); }
  return { name: name.toUpperCase(), params, value: line.slice(colon + 1) };
}
const unescapeText = (v) => v.replace(/\\[nN]/g, " ").replace(/\\([\\;,])/g, "$1").trim();

// Data "da orologio": i numeri come sono scritti, più il fuso a cui si riferiscono.
// zone: "utc", "floating" (ora locale di chi legge) oppure un nome IANA come "Europe/Rome".
function clockTime(value, params = {}) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const dateOnly = params.VALUE === "DATE" || m[4] === undefined;
  return {
    y: Number(m[1]), mo: Number(m[2]) - 1, d: Number(m[3]),
    h: dateOnly ? 0 : Number(m[4]), mi: dateOnly ? 0 : Number(m[5]), s: dateOnly ? 0 : Number(m[6] || 0),
    zone: m[7] ? "utc" : dateOnly ? "floating" : params.TZID || "floating",
    dateOnly,
  };
}

// differenza tra l'ora segnata in un fuso e l'UTC, in millisecondi, per un certo istante
function zoneOffset(zone, utcMs) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(utcMs));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second")) - utcMs;
}
// orario "da orologio" → istante reale (Date)
export function toInstant(t) {
  if (!t) return new Date(NaN);
  if (t.zone === "utc") return new Date(Date.UTC(t.y, t.mo, t.d, t.h, t.mi, t.s));
  if (t.zone === "floating") return new Date(t.y, t.mo, t.d, t.h, t.mi, t.s);
  try {
    // due passaggi bastano anche a cavallo del cambio dell'ora legale
    const naive = Date.UTC(t.y, t.mo, t.d, t.h, t.mi, t.s);
    let guess = naive - zoneOffset(t.zone, naive);
    guess = naive - zoneOffset(t.zone, guess);
    return new Date(guess);
  } catch {
    return new Date(t.y, t.mo, t.d, t.h, t.mi, t.s); // fuso sconosciuto: si usa l'ora locale
  }
}
// sposta una data "da orologio" di giorni o mesi lasciando invariata l'ora (giusto anche con l'ora legale)
function shiftDays(t, days) {
  const x = new Date(Date.UTC(t.y, t.mo, t.d + days));
  return { ...t, y: x.getUTCFullYear(), mo: x.getUTCMonth(), d: x.getUTCDate() };
}
function shiftMonths(t, months) {
  const first = new Date(Date.UTC(t.y, t.mo + months, 1));
  const daysInMonth = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0)).getUTCDate();
  if (t.d > daysInMonth) return null; // es. il 31 nei mesi che non ce l'hanno: quell'occorrenza non esiste
  return { ...t, y: first.getUTCFullYear(), mo: first.getUTCMonth() };
}
const weekday = (t) => new Date(Date.UTC(t.y, t.mo, t.d)).getUTCDay();

function parseRule(value) {
  const r = {};
  for (const part of value.split(";")) { const [k, v] = part.split("="); if (k && v) r[k.toUpperCase()] = v; }
  return {
    freq: r.FREQ,
    interval: Math.max(1, Number(r.INTERVAL) || 1),
    count: r.COUNT ? Number(r.COUNT) : Infinity,
    until: r.UNTIL ? clockTime(r.UNTIL) : null,
    byDay: r.BYDAY ? r.BYDAY.split(",").map((d) => DAY_CODES.indexOf(d.slice(-2).toUpperCase())).filter((i) => i >= 0) : null,
  };
}

export function parseICS(text) {
  const events = [];
  let ev = null;
  for (const line of unfold(text)) {
    if (line === "BEGIN:VEVENT") { ev = { exdates: new Set() }; continue; }
    if (line === "END:VEVENT") {
      if (ev?.start && ev.status !== "CANCELLED") events.push(ev);
      ev = null;
      continue;
    }
    if (!ev) continue;
    const p = property(line);
    if (!p) continue;
    if (p.name === "UID") ev.uid = p.value;
    else if (p.name === "SUMMARY") ev.summary = unescapeText(p.value);
    else if (p.name === "LOCATION") ev.location = unescapeText(p.value);
    else if (p.name === "STATUS") ev.status = p.value.toUpperCase();
    else if (p.name === "DTSTART") ev.start = clockTime(p.value, p.params);
    else if (p.name === "DTEND") ev.end = clockTime(p.value, p.params);
    else if (p.name === "RRULE") ev.rule = parseRule(p.value);
    else if (p.name === "RECURRENCE-ID") ev.recurrenceId = clockTime(p.value, p.params);
    else if (p.name === "EXDATE") for (const v of p.value.split(",")) { const t = clockTime(v, p.params); if (t) ev.exdates.add(toInstant(t).getTime()); }
  }
  return events;
}

// ---------------------------------------------------------------- occorrenze in un intervallo
// genera le date "da orologio" di una ricorrenza, in ordine, chiamando visit(t); se visit restituisce false si ferma
function repeat(ev, from, visit) {
  const { rule, start } = ev;
  let k = 0;
  // senza un numero fisso di ripetizioni si può saltare direttamente vicino all'intervallo richiesto
  if (rule.count === Infinity) {
    const daysAway = (from - toInstant(start)) / 864e5;
    const perStep = { DAILY: 1, WEEKLY: 7, MONTHLY: 28, YEARLY: 365 }[rule.freq];
    if (perStep && daysAway > 0) k = Math.max(0, Math.floor(daysAway / perStep / rule.interval) - 1) * rule.interval;
  }
  for (let steps = 0; steps < MAX_STEPS; steps++, k += rule.interval) {
    if (rule.freq === "DAILY") { if (visit(shiftDays(start, k)) === false) return; }
    else if (rule.freq === "WEEKLY") {
      const days = (rule.byDay?.length ? rule.byDay : [weekday(start)]).map((d) => (d + 6) % 7).sort((a, b) => a - b); // 0 = lunedì
      const monday = shiftDays(start, k * 7 - ((weekday(start) + 6) % 7));
      for (const offset of days) {
        const t = shiftDays(monday, offset);
        if (toInstant(t) < toInstant(start)) continue; // giorni prima dell'inizio della serie
        if (visit(t) === false) return;
      }
    } else if (rule.freq === "MONTHLY" || rule.freq === "YEARLY") {
      const t = shiftMonths(start, rule.freq === "MONTHLY" ? k : k * 12);
      if (t && visit(t) === false) return;
    } else { visit(start); return; } // frequenze non gestite: solo la prima occorrenza
  }
}

export function occurrences(events, from, to) {
  // occorrenze modificate singolarmente (RECURRENCE-ID): sostituiscono quelle della serie
  const replaced = new Set(events.filter((e) => e.recurrenceId).map((e) => `${e.uid}@${toInstant(e.recurrenceId).getTime()}`));
  const out = [];
  for (const ev of events) {
    const length = Math.max(0, toInstant(ev.end || ev.start) - toInstant(ev.start));
    const add = (t) => {
      const start = toInstant(t), end = new Date(start.getTime() + length);
      if (ev.exdates.has(start.getTime())) return;
      if (!ev.recurrenceId && replaced.has(`${ev.uid}@${start.getTime()}`)) return;
      if (end > from && start < to) out.push({ title: ev.summary || "Evento", location: ev.location || "", start, end, allDay: ev.start.dateOnly, source: "calendar" });
    };
    if (!ev.rule) { add(ev.start); continue; }
    const last = ev.rule.until ? Math.min(toInstant(ev.rule.until).getTime(), to.getTime()) : to.getTime();
    let left = ev.rule.count;
    repeat(ev, from, (t) => {
      if (left <= 0 || toInstant(t).getTime() > last) return false;
      left--;
      add(t);
      return true;
    });
  }
  return out.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------- scaricamento con cache
// Il calendario si riscarica al massimo ogni 5 minuti; se i dati sono vecchi si risponde subito con quelli
// e si aggiorna in sottofondo, così Jarvis non resta mai in attesa del calendario.
let cache = { url: "", at: 0, events: [], error: null };
let pending = null;

async function download(url, maxAgeMs) {
  try {
    const res = await fetch(url.replace(/^webcal:\/\//i, "https://"), { redirect: "follow", signal: AbortSignal.timeout(12_000) });
    if (!res.ok) throw new Error(`il calendario ha risposto ${res.status}`);
    const text = await res.text();
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error("il link non è un calendario iCal");
    cache = { url, at: Date.now(), events: parseICS(text), error: null };
  } catch (e) {
    // in caso di errore si tengono gli eventi già letti e si riprova tra un minuto
    cache = { url, at: Date.now() - maxAgeMs + 60_000, events: cache.url === url ? cache.events : [], error: e.message };
  }
  return cache;
}

export async function loadCalendar(url, { maxAgeMs = 5 * 60_000 } = {}) {
  if (!url) return { events: [], error: null };
  const fresh = cache.url === url && Date.now() - cache.at < maxAgeMs;
  if (fresh) return cache;
  if (maxAgeMs > 0 && cache.url === url && cache.events.length) {
    pending ??= download(url, maxAgeMs).finally(() => (pending = null));
    return cache;
  }
  return download(url, maxAgeMs);
}
