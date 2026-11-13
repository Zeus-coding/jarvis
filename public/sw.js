// Service worker di J.A.R.V.I.S.: notifiche push (anche a app chiusa) e caricamento rapido dei file dell'interfaccia.
// Le API non vengono mai salvate in cache: i dati arrivano sempre freschi dal server.
const CACHE = "jarvis-v1";
const SHELL = ["/", "/giornata", "/lezione", "/css/hud.css", "/js/app.js", "/js/orb.js", "/js/voice.js", "/js/replies.js", "/js/api.js", "/js/pwa.js", "/js/setup.js", "/fonts/inter-latin.woff2", "/icons/icon-192.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// rete prima di tutto (così vedi sempre l'ultima versione); la cache serve solo se il server non risponde
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api/") || url.pathname === "/login") return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && res.type === "basic") { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); }
        return res;
      })
      .catch(async () => (await caches.match(e.request)) || new Response(
        `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="background:#000;color:#fff;font:15px system-ui;display:grid;place-items:center;min-height:100vh;text-align:center;padding:16px"><div><b style="letter-spacing:.4em;font-weight:300">J.A.R.V.I.S.</b><p style="color:#999">Non raggiungo il computer su cui gira Jarvis.<br>Controlla che sia acceso e connesso.</p></div>`,
        { headers: { "Content-Type": "text/html; charset=utf-8" } },
      )),
  );
});

self.addEventListener("push", (e) => {
  let data = {};
  try { data = e.data?.json() || {}; } catch { data = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || "J.A.R.V.I.S.", {
    body: data.body || "",
    tag: data.tag || "jarvis",
    renotify: Boolean(data.tag),
    icon: "/icons/icon-192.png",
    badge: "/icons/icon-192.png",
    data: { url: data.url || "/" },
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  const target = new URL(e.notification.data?.url || "/", location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
    const open = list.find((c) => c.url === target) || list.find((c) => new URL(c.url).origin === location.origin);
    if (open) return open.navigate(target).then((c) => (c || open).focus()).catch(() => open.focus());
    return self.clients.openWindow(target);
  }));
});
