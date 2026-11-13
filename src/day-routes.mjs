// J.A.R.V.I.S. — API della giornata: attività, revisioni, notifiche push e riepilogo.
import { send, json } from "./http.mjs";
import { listTasks, addTask, setDone, deleteTask } from "./tasks.mjs";
import { draftDayReview, saveDayReview, makeWeekReview, recentReviews, dayKey } from "./reviews.mjs";
import { dayOverview, daySummary } from "./day.mjs";
import { publicKey, subscribe, unsubscribe, notifyAll } from "./push.mjs";
import { provider } from "./store.mjs";

const aiError = (res, e) => send(res, e.status === 429 ? 429 : 502, { error: e.status === 429 ? "Limite gratuito di Google raggiunto per ora: riprova più tardi." : `L'AI non ha risposto: ${e.message.slice(0, 120)}` });

// restituisce false se la richiesta non riguarda questo gruppo di API
export async function dayRoutes(req, res, p) {
  const m = req.method;
  if (p === "/api/day" && m === "GET") return send(res, 200, await dayOverview());
  if (p === "/api/day/summary" && m === "POST") {
    if (!provider()) return send(res, 400, { error: "Serve una chiave per il cervello AI (CONFIGURA)." });
    try { return send(res, 200, { text: await daySummary((await json(req)).force === true) }); } catch (e) { return aiError(res, e); }
  }

  if (p === "/api/tasks" && m === "GET") return send(res, 200, { tasks: listTasks() });
  if (p === "/api/tasks" && m === "POST") {
    const b = await json(req);
    const t = await addTask(b.title, b.due);
    return t ? send(res, 200, { task: t }) : send(res, 400, { error: "Scrivi cosa devi fare." });
  }
  const tm = p.match(/^\/api\/tasks\/([\w-]+)$/);
  if (tm && m === "PATCH") { const t = await setDone(tm[1], (await json(req)).done !== false); return t ? send(res, 200, { task: t }) : send(res, 404, { error: "Attività non trovata" }); }
  if (tm && m === "DELETE") return send(res, 200, { ok: await deleteTask(tm[1]) });

  if (p === "/api/reviews" && m === "GET") return send(res, 200, { reviews: recentReviews(30), today: dayKey() });
  if (p === "/api/reviews/day" && m === "POST") return send(res, 200, { review: await saveDayReview(await json(req)) });
  if (p === "/api/reviews/day/draft" && m === "POST") {
    if (!provider()) return send(res, 400, { error: "Serve una chiave per il cervello AI (CONFIGURA)." });
    try { const d = await draftDayReview(); return send(res, 200, { good: d.good, bad: d.bad, notes: d.notes }); } catch (e) { return aiError(res, e); }
  }
  if (p === "/api/reviews/week" && m === "POST") {
    if (!provider()) return send(res, 400, { error: "Serve una chiave per il cervello AI (CONFIGURA)." });
    try { return send(res, 200, { review: await makeWeekReview() }); } catch (e) { return aiError(res, e); }
  }

  if (p === "/api/push/key" && m === "GET") return send(res, 200, { key: publicKey() });
  if (p === "/api/push/subscribe" && m === "POST") {
    const b = await json(req);
    try { await subscribe(b.subscription, b.device); return send(res, 200, { ok: true }); } catch (e) { return send(res, 400, { error: e.message }); }
  }
  if (p === "/api/push/unsubscribe" && m === "POST") { await unsubscribe((await json(req)).endpoint); return send(res, 200, { ok: true }); }
  if (p === "/api/push/test" && m === "POST") {
    const sent = await notifyAll({ title: "J.A.R.V.I.S.", body: "Le notifiche funzionano. Ti avviserò degli impegni e della revisione serale.", url: "/giornata", tag: "test" });
    return send(res, 200, { sent });
  }
  return false;
}
