// J.A.R.V.I.S. — Utilità HTTP: risposte JSON/HTML, lettura del corpo delle richieste, intestazioni di sicurezza.


export const SECURITY = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
export function send(res, status, data, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...SECURITY, ...headers });
  res.end(JSON.stringify(data));
}
export function html(res, status, page) {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", ...SECURITY });
  res.end(page);
}
export async function rawBody(req, limit = 25e6) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw Object.assign(new Error("richiesta troppo grande"), { code: "TOO_BIG" });
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}
export async function json(req) {
  const s = (await rawBody(req, 1e6)).toString("utf8");
  return s ? JSON.parse(s) : {};
}
