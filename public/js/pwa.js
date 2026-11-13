// App installabile (PWA) e notifiche push: Jarvis può avvisarti anche a pagina chiusa,
// finché il computer su cui gira è acceso.
import { api, post } from "./api.js";

export const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

export async function registerWorker() {
  if (!("serviceWorker" in navigator)) return null;
  try { return await navigator.serviceWorker.register("/sw.js"); } catch { return null; }
}

const b64ToBytes = (b64) => {
  const s = atob((b64 + "=".repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
};

export async function pushStatus() {
  if (!pushSupported) return { supported: false, enabled: false };
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return { supported: true, enabled: Boolean(sub) && Notification.permission === "granted", permission: Notification.permission };
}

export async function enablePush() {
  if (!pushSupported) throw new Error("Questo browser non supporta le notifiche (su iPhone: aggiungi prima Jarvis alla schermata Home).");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error("Notifiche non consentite: abilitale dalle impostazioni del browser.");
  const reg = (await navigator.serviceWorker.getRegistration()) || (await registerWorker());
  await navigator.serviceWorker.ready;
  const { key } = await api("/api/push/key");
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(key) }));
  await post("/api/push/subscribe", { subscription: sub.toJSON(), device: navigator.userAgent.slice(0, 120) });
  return true;
}

export async function disablePush() {
  const reg = await navigator.serviceWorker?.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (sub) { await post("/api/push/unsubscribe", { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
}

export const testPush = () => post("/api/push/test");
