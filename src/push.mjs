// J.A.R.V.I.S. — Notifiche push (Web Push, standard VAPID): arrivano sul telefono anche ad app chiusa,
// finché il computer su cui gira Jarvis è acceso e collegato a internet.
import webpush from "web-push";
import { db, secrets, saveData, saveSecrets } from "./store.mjs";

// le chiavi VAPID identificano questo Jarvis presso i servizi push dei browser: si creano una volta sola
function ensureKeys() {
  if (!secrets.VAPID_PUBLIC || !secrets.VAPID_PRIVATE) {
    const k = webpush.generateVAPIDKeys();
    secrets.VAPID_PUBLIC = k.publicKey;
    secrets.VAPID_PRIVATE = k.privateKey;
    saveSecrets();
  }
  webpush.setVapidDetails("mailto:jarvis@example.com", secrets.VAPID_PUBLIC, secrets.VAPID_PRIVATE);
  return secrets.VAPID_PUBLIC;
}
export const publicKey = () => ensureKeys();

export async function subscribe(subscription, device = "") {
  if (!subscription?.endpoint || !subscription.keys?.p256dh || !subscription.keys?.auth) throw new Error("iscrizione non valida");
  db.pushSubs = db.pushSubs.filter((s) => s.subscription.endpoint !== subscription.endpoint);
  db.pushSubs.push({ subscription, device: String(device).slice(0, 120), at: new Date().toISOString() });
  await saveData();
}
export async function unsubscribe(endpoint) {
  db.pushSubs = db.pushSubs.filter((s) => s.subscription.endpoint !== endpoint);
  await saveData();
}

// invia a tutti i dispositivi iscritti; quelli non più validi (app disinstallata, permesso tolto) vengono rimossi
export async function notifyAll({ title, body = "", url = "/", tag }) {
  if (!db.pushSubs.length) return 0;
  ensureKeys();
  const payload = JSON.stringify({ title, body, url, tag });
  let sent = 0;
  const dead = [];
  await Promise.all(db.pushSubs.map(async (s) => {
    try { await webpush.sendNotification(s.subscription, payload, { TTL: 3600, urgency: "high" }); sent++; }
    catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) dead.push(s.subscription.endpoint);
      else console.warn(`[notifiche] invio non riuscito: ${e.statusCode || ""} ${e.message}`);
    }
  }));
  if (dead.length) { db.pushSubs = db.pushSubs.filter((s) => !dead.includes(s.subscription.endpoint)); await saveData(); }
  return sent;
}
