// J.A.R.V.I.S. — Pianificatore: ogni minuto controlla se c'è qualcosa da ricordarti
// (impegni in arrivo, revisione serale, bilancio della settimana) e manda una notifica push.
import { db, saveData, provider } from "./store.mjs";
import { agenda } from "./agenda.mjs";
import { notifyAll } from "./push.mjs";
import { dayKey, dayReview, weekKey, weekReview, makeWeekReview } from "./reviews.mjs";
import { pruneTasks } from "./tasks.mjs";

const REMIND_MIN = 15; // minuti di anticipo per gli impegni
const once = (key) => {
  if (db.notified.includes(key)) return false;
  db.notified.push(key);
  if (db.notified.length > 300) db.notified = db.notified.slice(-200);
  saveData();
  return true;
};
const minutesOf = (hhmm) => { const [h, m] = String(hhmm || "").split(":").map(Number); return Number.isFinite(h) ? h * 60 + (m || 0) : null; };

export async function tick(now = new Date()) {
  const nowMin = now.getHours() * 60 + now.getMinutes(), today = dayKey(now);

  // 1. impegni che iniziano entro 15 minuti
  if (db.pushSubs.length) {
    const { all } = await agenda(1).catch(() => ({ all: [] }));
    for (const e of all) {
      if (e.allDay) continue;
      const mins = Math.round((e.start - now) / 60_000);
      if (mins < 0 || mins > REMIND_MIN) continue;
      if (!once(`ev|${e.title}|${e.start.toISOString()}`)) continue;
      await notifyAll({ title: mins <= 1 ? `Adesso: ${e.title}` : `Tra ${mins} minuti: ${e.title}`, body: `${e.start.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}${e.location ? ` · ${e.location}` : ""}`, url: "/giornata", tag: `ev-${e.start.getTime()}` });
    }
  }

  // 2. revisione serale all'ora scelta (se non l'hai già fatta)
  const reviewAt = minutesOf(db.settings.reviewTime);
  if (db.pushSubs.length && reviewAt !== null && nowMin >= reviewAt && nowMin < reviewAt + 120 && !dayReview(today) && once(`review|${today}`)) {
    await notifyAll({ title: "Revisione serale", body: `Com'è andata oggi, ${db.settings.addressAs}? Due minuti per fare il punto.`, url: "/giornata#revisione", tag: "review" });
  }

  // 3. domenica sera: bilancio della settimana (generato dall'AI) e notifica
  const week = weekKey(now);
  if (now.getDay() === 0 && nowMin >= 20 * 60 && provider() && !weekReview(week) && once(`week|${week}`)) {
    try {
      await makeWeekReview(week);
      await notifyAll({ title: "Il bilancio della settimana è pronto", body: "Le somme, cosa migliorare e il piano per la settimana nuova.", url: "/giornata#settimana", tag: "week" });
    } catch (e) { console.warn(`[revisione] bilancio settimanale non riuscito: ${e.message}`); }
  }

  if (nowMin === 4 * 60) pruneTasks(); // alle 4 di notte: pulizia delle attività vecchie
}

export function startScheduler() {
  const run = () => tick().catch((e) => console.warn(`[pianificatore] ${e.message}`));
  setTimeout(run, 20_000);
  setInterval(run, 60_000).unref();
}
