// Chiamate al server di Jarvis. Se l'accesso è scaduto (dispositivo remoto) si torna alla pagina di login.
export async function api(path, options = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...options });
  if (r.status === 401) { location.href = "/login"; throw new Error("Accesso richiesto"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `Errore ${r.status}`), { status: r.status });
  return data;
}

export const post = (path, body) => api(path, { method: "POST", body: JSON.stringify(body ?? {}) });

// Risposta del cervello in streaming (Server-Sent Events): ogni evento arriva appena pronto.
export async function streamChat(message, history, onEvent, signal) {
  const r = await fetch("/api/chat/stream", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message, history }), signal,
  });
  if (r.status === 401) { location.href = "/login"; return; }
  if (!r.ok || !r.body) throw new Error(`Errore ${r.status}`);
  const reader = r.body.getReader(), dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let cut;
    while ((cut = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, cut).replace(/^data:\s*/, "");
      buf = buf.slice(cut + 2);
      if (!block || block.startsWith(":")) continue;
      try { onEvent(JSON.parse(block)); } catch {}
    }
  }
}
