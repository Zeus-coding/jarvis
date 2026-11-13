// Modalità Lezione: registra (fotocamera + trascrizione) e mostra gli appunti scritti da Jarvis in tempo reale.
import { markdownToHtml, esc } from "./markdown.js";

const $ = (s) => document.querySelector(s);
const body = document.body;
let lesson = null, events = null, words = 0;
const params = new URLSearchParams(location.search);

async function api(path, o = {}) {
  const r = await fetch(path, { headers: { "Content-Type": "application/json" }, ...o });
  if (r.status === 401) { location.href = "/login"; throw new Error("Accesso richiesto"); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `Errore ${r.status}`);
  return data;
}
const fmtDate = (iso) => new Date(iso).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "long" });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
function pill(text, kind = "") {
  $("#pillText").textContent = text;
  $("#pill").className = `pill ${kind}`;
}
function status(text = "", err = false) {
  $("#status").textContent = text;
  $("#status").className = err ? "err" : "";
}

// ---------------------------------------------------------------- elenco lezioni
async function showList() {
  body.classList.remove("in-lesson", "recorder");
  pill("PRONTO");
  let data;
  try { data = await api("/api/lessons"); } catch (e) { $("#listWarn").textContent = e.message; return; }
  if (!data.ai) $("#listWarn").textContent = "Serve la chiave Google Gemini: aprila da JARVIS → CONFIGURA.";
  const box = $("#lessons");
  box.innerHTML = "";
  if (!data.lessons.length) box.innerHTML = `<p class="hint" style="padding:16px 0">Nessuna lezione ancora.</p>`;
  for (const l of data.lessons) {
    const row = document.createElement("div");
    row.className = "row";
    row.innerHTML = `<div class="info"><b></b>${l.active ? `<span class="tag">IN CORSO</span>` : ""}<small></small></div>`;
    row.querySelector("b").textContent = l.title;
    row.querySelector("small").textContent = `${fmtDate(l.startedAt)} · ${fmtTime(l.startedAt)} · ${l.words} parole · ${l.photos} foto`;
    const add = (label, fn, cls = "") => { const b = document.createElement("button"); b.textContent = label; b.className = cls; b.onclick = fn; row.appendChild(b); };
    add("APRI", () => openLesson(l.id, false));
    if (l.active) add("REGISTRA DA QUI", () => openLesson(l.id, true));
    const w = document.createElement("a"); w.className = "btn"; w.textContent = "WORD"; w.href = `/api/lesson/${l.id}/export.doc`; row.appendChild(w);
    add("ELIMINA", async () => {
      if (!confirm(`Eliminare definitivamente «${l.title}» con appunti, trascrizione e foto? Non si può annullare.`)) return;
      await api(`/api/lesson/${l.id}`, { method: "DELETE" }).catch((e) => alert(e.message));
      showList();
    }, "danger");
    box.appendChild(row);
  }
}
$("#newForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#listWarn").textContent = "";
  try {
    const l = await api("/api/lesson/start", { method: "POST", body: JSON.stringify({ title: $("#title").value }) });
    openLesson(l.id, true);
  } catch (err) { $("#listWarn").textContent = err.message; }
});

// ---------------------------------------------------------------- lezione aperta
function openLesson(id, asRecorder) {
  history.replaceState(null, "", `/lezione?id=${encodeURIComponent(id)}${asRecorder ? "&rec=1" : ""}`);
  body.classList.add("in-lesson");
  body.classList.toggle("recorder", asRecorder);
  $("#transcript").innerHTML = `<p id="interim"></p>`;
  $("#photos").innerHTML = "";
  $("#notes").innerHTML = "";
  $("#wordBtn").href = `/api/lesson/${id}/export.doc`;
  events?.close();
  events = new EventSource(`/api/lesson/${id}/events`);
  events.onmessage = (m) => handle(JSON.parse(m.data), asRecorder);
  events.onerror = () => pill("RICONNESSIONE…");
  events.onopen = () => setLivePill();
}
function setLivePill() {
  if (!lesson) return;
  if (lesson.endedAt) pill("LEZIONE CONCLUSA");
  else if (rec.active && !rec.paused) pill("REGISTRAZIONE", "live");
  else if (rec.paused) pill("IN PAUSA");
  else pill("IN DIRETTA", "live");
}
function handle(ev, asRecorder) {
  if (ev.type === "snapshot") {
    lesson = ev.lesson;
    $("#lessonTitle").textContent = lesson.title;
    document.title = `${lesson.title} · Lezione`;
    renderNotes(lesson.notes, false);
    $("#transcript").innerHTML = `<p id="interim"></p>`;
    words = 0;
    lesson.transcript.forEach(addTranscript);
    $("#photos").innerHTML = "";
    lesson.photoList.forEach((p) => addPhoto(p.n));
    if (lesson.updatedAt) $("#updatedAt").textContent = `AGG. ${fmtTime(lesson.updatedAt)}`;
    $("#endBtn").style.display = lesson.endedAt ? "none" : "";
    if (lesson.busy) { pill("ELABORAZIONE", "busy"); status("Jarvis sta aggiornando gli appunti…"); }
    if (asRecorder && !lesson.endedAt && !rec.started) startRecorder();
    setLivePill();
  } else if (ev.type === "transcript") {
    addTranscript(ev);
  } else if (ev.type === "notes") {
    renderNotes(ev.notes, true);
    $("#updatedAt").textContent = `AGG. ${fmtTime(ev.updatedAt)}`;
  } else if (ev.type === "photo") {
    addPhoto(ev.n);
  } else if (ev.type === "status") {
    if (ev.busy) { pill("ELABORAZIONE", "busy"); status(`${ev.text.charAt(0)}${ev.text.slice(1).toLowerCase()}…`); }
    else { setLivePill(); if (ev.error) status(ev.error, true); else if (!$("#status").classList.contains("err")) status(""); }
  } else if (ev.type === "ended") {
    lesson.endedAt = ev.endedAt;
    $("#endBtn").style.display = "none";
    stopRecorder();
    setLivePill();
    status("Lezione conclusa: Jarvis sta scrivendo la versione definitiva, il riassunto e gli approfondimenti.");
  }
}

// ---------------------------------------------------------------- appunti (con grafici SVG)
const COLORS = ["#8fd3ff", "#ffb86b", "#9ef0a8", "#ff8fb1", "#c3a6ff", "#ffe27a"];
function chartSvg(c) {
  const W = 560, H = 260, P = { l: 44, r: 12, t: 14, b: 46 };
  const legend = c.series.length > 1 || c.type === "pie"
    ? `<div style="display:flex;flex-wrap:wrap;gap:12px;font-size:12px;margin-top:6px">${(c.type === "pie" ? c.labels : c.series.map((s) => s.name)).map((n, i) => `<span><i style="display:inline-block;width:9px;height:9px;background:${COLORS[i % COLORS.length]};margin-right:5px"></i>${esc(n)}</span>`).join("")}</div>` : "";
  const cap = c.title ? `<figcaption>${esc(c.title)}</figcaption>` : "";
  if (c.type === "pie") {
    const data = c.series[0].data.map((v) => Math.max(0, v || 0)), tot = data.reduce((a, b) => a + b, 0) || 1;
    let a = -Math.PI / 2;
    const cx = 130, cy = 130, r = 110;
    const slices = data.map((v, i) => {
      const a2 = a + (v / tot) * Math.PI * 2, large = a2 - a > Math.PI ? 1 : 0;
      const d = `M${cx},${cy} L${cx + r * Math.cos(a)},${cy + r * Math.sin(a)} A${r},${r} 0 ${large} 1 ${cx + r * Math.cos(a2)},${cy + r * Math.sin(a2)} Z`;
      a = a2;
      return `<path d="${d}" fill="${COLORS[i % COLORS.length]}" stroke="#070707" stroke-width="2"><title>${esc(c.labels[i] || "")}: ${v}</title></path>`;
    }).join("");
    return `<figure>${cap}<svg viewBox="0 0 260 260" width="260" role="img">${slices}</svg>${legend}</figure>`;
  }
  const all = c.series.flatMap((s) => s.data).filter(Number.isFinite);
  const max = Math.max(0, ...all), min = Math.min(0, ...all), span = max - min || 1;
  const x0 = P.l, x1 = W - P.r, y0 = H - P.b, y1 = P.t;
  const y = (v) => y0 - ((v - min) / span) * (y0 - y1);
  const n = c.labels.length, step = (x1 - x0) / Math.max(1, n);
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((f) => min + f * span);
  const fmt = (v) => (Math.abs(v) >= 1000 ? v.toLocaleString("it-IT", { maximumFractionDigits: 0 }) : +v.toFixed(2));
  let marks = "";
  if (c.type === "line") {
    c.series.forEach((s, si) => {
      const pts = s.data.map((v, i) => (Number.isFinite(v) ? `${x0 + step * (i + 0.5)},${y(v)}` : null)).filter(Boolean);
      marks += `<polyline points="${pts.join(" ")}" fill="none" stroke="${COLORS[si % COLORS.length]}" stroke-width="2.5"/>`;
      marks += pts.map((p) => `<circle cx="${p.split(",")[0]}" cy="${p.split(",")[1]}" r="3.5" fill="${COLORS[si % COLORS.length]}"/>`).join("");
    });
  } else {
    const bw = (step * 0.75) / c.series.length;
    c.series.forEach((s, si) => s.data.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const bx = x0 + step * i + step * 0.125 + bw * si, top = Math.min(y(v), y(0)), h = Math.abs(y(v) - y(0));
      marks += `<rect x="${bx}" y="${top}" width="${Math.max(1, bw - 2)}" height="${Math.max(1, h)}" fill="${COLORS[si % COLORS.length]}"><title>${esc(c.labels[i] || "")}: ${v}</title></rect>`;
    }));
  }
  const grid = ticks.map((t) => `<line x1="${x0}" x2="${x1}" y1="${y(t)}" y2="${y(t)}" stroke="rgba(255,255,255,.1)"/><text x="${x0 - 6}" y="${y(t) + 4}" text-anchor="end" font-size="11" fill="rgba(255,255,255,.55)">${fmt(t)}</text>`).join("");
  const labels = c.labels.map((l, i) => `<text x="${x0 + step * (i + 0.5)}" y="${y0 + 18}" text-anchor="middle" font-size="11" fill="rgba(255,255,255,.7)">${esc(l.length > 14 ? `${l.slice(0, 13)}…` : l)}</text>`).join("");
  return `<figure>${cap}<svg viewBox="0 0 ${W} ${H}" role="img">${grid}<line x1="${x0}" x2="${x1}" y1="${y(0)}" y2="${y(0)}" stroke="rgba(255,255,255,.35)"/>${marks}${labels}</svg>${legend}</figure>`;
}
function renderNotes(md, flash) {
  const box = $("#notes");
  const nearBottom = window.innerHeight + window.scrollY > document.body.scrollHeight - 200;
  const before = box.children.length;
  box.innerHTML = md ? markdownToHtml(md, { chart: chartSvg }) : "";
  if (flash) for (const el of [...box.children].slice(Math.max(0, before - 1))) el.classList.add("flash");
  if (flash && nearBottom && body.dataset.tab === "notes") window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
}

// ---------------------------------------------------------------- trascrizione e foto
function addTranscript(t) {
  const p = document.createElement("p");
  p.innerHTML = `<time></time><span></span>`;
  p.querySelector("time").textContent = fmtTime(t.at);
  p.querySelector("span").textContent = t.text;
  const box = $("#transcript"), stick = box.scrollTop + box.clientHeight > box.scrollHeight - 40;
  box.insertBefore(p, $("#interim"));
  words += t.text.split(/\s+/).filter(Boolean).length;
  $("#words").textContent = `${words} PAROLE`;
  if (stick) box.scrollTop = box.scrollHeight;
}
function addPhoto(n) {
  const a = document.createElement("a");
  a.href = `/api/lesson/${lesson.id}/photo/${n}`;
  a.target = "_blank";
  a.innerHTML = `<img alt="Foto lavagna ${n + 1}" loading="lazy">`;
  a.querySelector("img").src = a.href;
  $("#photos").appendChild(a);
}

// ---------------------------------------------------------------- registratore (telefono)
const rec = { started: false, active: false, paused: false, auto: true, stream: null, recog: null, timer: null, sig: null, wake: null, queue: Promise.resolve() };
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const android = /Android/i.test(navigator.userAgent);

async function startRecorder() {
  rec.started = rec.active = true;
  rec.paused = false;
  setLivePill();
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    $("#cam").srcObject = rec.stream;
    $("#camMsg").textContent = "";
  } catch (e) {
    $("#camMsg").textContent = "Fotocamera non disponibile: consenti l'accesso dal lucchetto nella barra degli indirizzi. La trascrizione funziona lo stesso.";
  }
  if (!SR) status("Questo browser non sa trascrivere la voce: usa Chrome su Android o Edge/Chrome sul computer. Le foto funzionano lo stesso.", true);
  else listen();
  keepAwake();
  rec.timer = setInterval(autoShot, 15000);
}
function listen() {
  if (!SR || !rec.active || rec.paused) return;
  const r = new SR();
  r.lang = "it-IT";
  r.continuous = !android; // su Android la modalità continua duplica il testo: meglio frase per frase
  r.interimResults = true;
  r.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) sendText(res[0].transcript);
      else interim += res[0].transcript;
    }
    $("#interim").textContent = interim;
  };
  r.onerror = (e) => {
    if (e.error === "not-allowed" || e.error === "service-not-allowed") {
      rec.active = false;
      status("Microfono bloccato: consentilo dal lucchetto nella barra degli indirizzi e ricarica la pagina.", true);
      setLivePill();
    }
  };
  r.onend = () => { $("#interim").textContent = ""; if (rec.active && !rec.paused) setTimeout(listen, 200); };
  try { r.start(); rec.recog = r; } catch { setTimeout(listen, 1000); }
}
function sendText(text) {
  const t = text.trim();
  if (!t || !lesson) return;
  rec.queue = rec.queue.then(() => api(`/api/lesson/${lesson.id}/text`, { method: "POST", body: JSON.stringify({ text: t }) })).catch(() => status("Connessione persa: la trascrizione riprende appena torna la rete.", true));
}
// "firma" di 32x24 pixel in scala di grigi: serve a capire se la lavagna è cambiata (così non manda foto inutili)
function signature(video) {
  const c = document.createElement("canvas");
  c.width = 32; c.height = 24;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(video, 0, 0, 32, 24);
  const d = g.getImageData(0, 0, 32, 24).data, out = new Uint8Array(32 * 24);
  for (let i = 0; i < out.length; i++) out[i] = (d[i * 4] + d[i * 4 + 1] + d[i * 4 + 2]) / 3;
  return out;
}
function changed(a, b) {
  if (!a || !b) return true;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff += Math.abs(a[i] - b[i]);
  return diff / a.length > 14;
}
function autoShot() {
  const v = $("#cam");
  if (!rec.auto || rec.paused || !rec.active || !v.videoWidth) return;
  const s = signature(v);
  if (changed(s, rec.sig)) takePhoto(s);
}
async function takePhoto(sig) {
  const v = $("#cam");
  if (!v.videoWidth || !lesson) return status("La fotocamera non è attiva.", true);
  const scale = Math.min(1, 1600 / v.videoWidth);
  const c = document.createElement("canvas");
  c.width = Math.round(v.videoWidth * scale);
  c.height = Math.round(v.videoHeight * scale);
  c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
  rec.sig = sig || signature(v);
  $("#shot").classList.remove("go"); void $("#shot").offsetWidth; $("#shot").classList.add("go");
  const blob = await new Promise((ok) => c.toBlob(ok, "image/jpeg", 0.72));
  try {
    const r = await fetch(`/api/lesson/${lesson.id}/photo`, { method: "POST", headers: { "Content-Type": "image/jpeg" }, body: blob });
    if (!r.ok) throw new Error();
  } catch { status("Foto non inviata: controlla la connessione.", true); }
}
async function keepAwake() {
  try { rec.wake = await navigator.wakeLock?.request("screen"); } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && rec.active) { keepAwake(); if (!rec.paused) listen(); }
});
function stopRecorder() {
  rec.active = false;
  clearInterval(rec.timer);
  try { rec.recog?.abort(); } catch {}
  rec.stream?.getTracks().forEach((t) => t.stop());
  rec.wake?.release?.().catch(() => {});
  body.classList.remove("recorder");
}

$("#photoBtn").onclick = () => takePhoto();
$("#autoBtn").onclick = () => { rec.auto = !rec.auto; $("#autoBtn").textContent = `FOTO AUTOMATICHE: ${rec.auto ? "SÌ" : "NO"}`; };
$("#pauseBtn").onclick = () => {
  rec.paused = !rec.paused;
  $("#pauseBtn").textContent = rec.paused ? "RIPRENDI" : "PAUSA";
  if (rec.paused) { try { rec.recog?.abort(); } catch {} } else listen();
  setLivePill();
};
$("#updateBtn").onclick = async () => {
  $("#updateBtn").disabled = true;
  try { const r = await api(`/api/lesson/${lesson.id}/update`, { method: "POST" }); if (!r.ok) status("Niente di nuovo da aggiungere per ora."); }
  catch (e) { status(e.message, true); }
  finally { $("#updateBtn").disabled = false; }
};
$("#endBtn").onclick = async () => {
  if (!confirm("Terminare la lezione? Jarvis scriverà la versione definitiva degli appunti.")) return;
  stopRecorder();
  await api(`/api/lesson/${lesson.id}/end`, { method: "POST" }).catch((e) => status(e.message, true));
};
document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => {
  body.dataset.tab = b.dataset.tab;
  document.querySelectorAll("#tabs button").forEach((x) => x.classList.toggle("on", x === b));
}));
addEventListener("beforeunload", (e) => { if (rec.active && lesson && !lesson.endedAt) e.preventDefault(); });

if (params.get("id")) openLesson(params.get("id"), params.has("rec"));
else showList();
