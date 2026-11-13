// J.A.R.V.I.S. — Agenda: unisce il calendario collegato (iCal) e gli impegni aggiunti a voce,
// e prepara il saluto del risveglio con i numeri della giornata.
import { loadCalendar, occurrences } from "../calendar.mjs";
import { db, key } from "./store.mjs";

const DAY = 864e5;
const midnight = (d = new Date()) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const clock = (d) => `${d.getHours()}:${String(d.getMinutes()).padStart(2, "0")}`;

// tutti gli impegni da oggi (a mezzanotte) per i prossimi `days` giorni, in ordine
export async function agenda(days = 7) {
  const from = midnight(), to = new Date(from.getTime() + days * DAY);
  const url = key("CALENDAR_ICS_URL");
  const calendar = await loadCalendar(url);
  const spoken = db.events.map((e) => {
    const start = new Date(e.start);
    return { id: e.id, title: e.title, start, end: new Date(start.getTime() + (e.minutes || 60) * 60_000), allDay: Boolean(e.allDay), source: "local" };
  }).filter((e) => e.end > from && e.start < to);
  const all = [...occurrences(calendar.events, from, to), ...spoken].sort((a, b) => a.start - b.start);
  return { all, error: calendar.error, connected: Boolean(url) };
}

// "OGGI", "DOMANI" oppure il giorno della settimana abbreviato
function dayName(d) {
  const ahead = Math.round((midnight(d) - midnight()) / DAY);
  if (ahead <= 0) return "OGGI";
  if (ahead === 1) return "DOMANI";
  return d.toLocaleDateString("it-IT", { weekday: "short" }).replace(".", "").toUpperCase();
}
const toClient = (e) => ({
  id: e.id, title: e.title, source: e.source, allDay: e.allDay, start: e.start.toISOString(),
  time: e.allDay ? "" : clock(e.start), day: dayName(e.start), minutes: e.allDay ? -1 : e.start.getHours() * 60 + e.start.getMinutes(),
});

// per l'interfaccia: impegni di oggi, prossimi impegni (anche dei giorni dopo) e totale della settimana
export async function todayAgenda() {
  const { all, error, connected } = await agenda(7);
  const tomorrow = new Date(midnight().getTime() + DAY), now = new Date();
  return { today: all.filter((e) => e.start < tomorrow).map(toClient), upcoming: all.filter((e) => e.end > now).slice(0, 7).map(toClient), week: all.length, error, connected };
}

// per le istruzioni del cervello: un elenco leggibile, giorno per giorno
export function agendaText(all) {
  if (!all.length) return "Nessun impegno nei prossimi 7 giorni.";
  const days = new Map();
  for (const e of all.slice(0, 60)) {
    const label = e.start.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
    if (!days.has(label)) days.set(label, []);
    days.get(label).push(`${e.allDay ? "tutto il giorno" : clock(e.start)} ${e.title}${e.location ? ` (${e.location})` : ""}`);
  }
  return [...days].map(([label, items]) => `- ${label}: ${items.join("; ")}`).join("\n");
}

// il saluto del risveglio: tre frasi, con i numeri da mostrare mentre parla
export async function briefing() {
  const a = await todayAgenda(), name = db.settings.addressAs, count = a.today.length;
  const numbers = { stat: { id: "agenda", label: "IMPEGNI OGGI", value: count }, stat2: { id: "week", label: "PROSSIMI 7 GIORNI", value: a.week } };
  const firstTimed = a.today.find((e) => !e.allDay) || a.today[0];
  const nextDay = a.upcoming.find((e) => e.day !== "OGGI");
  const when = (e) => `${e.day === "DOMANI" ? "domani" : new Date(e.start).toLocaleDateString("it-IT", { weekday: "long" })}${e.time ? ` alle ${e.time}` : ""}`;
  const middle = count
    ? `Oggi hai ${count === 1 ? "un impegno" : `${count} impegni`} in calendario${firstTimed?.time ? `, il primo alle ${firstTimed.time}` : ""}.`
    : nextDay ? `Oggi il tuo calendario è libero. Il prossimo impegno è ${when(nextDay)}: ${nextDay.title}.` : "Oggi il tuo calendario è libero.";
  return {
    lines: [{ text: `Ciao ${name}, tutti i sistemi sono attivi.` }, { text: middle, ...numbers }, { text: `Dimmi pure quello che ti serve, ${name}.` }],
    today: a.today, upcoming: a.upcoming,
  };
}
