// «La mia giornata»: agenda, attività, revisione serale, bilancio della settimana e riepilogo dell'AI.
import { api, post } from "./api.js";
import { registerWorker, pushStatus, enablePush, testPush } from "./pwa.js";

const $ = (s) => document.querySelector(s);
let data = null, mood = null;

function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("on"), 3000);
}
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };
const fmtDay = (iso) => new Date(iso).toLocaleDateString("it-IT", { weekday: "short", day: "numeric", month: "short" });
const todayKey = () => new Date().toLocaleDateString("sv-SE");

// ---------------------------------------------------------------- caricamento
async function load() {
  data = await api("/api/day");
  $("#hello").textContent = `${data.greeting}, ${data.addressAs}`;
  $("#today").textContent = data.date;
  document.title = `${data.greeting} · La mia giornata`;
  if (data.weather) {
    $("#weather").hidden = false;
    $("#wIcon").textContent = data.weather.icon;
    $("#wTemp").textContent = `${data.weather.now}° ${data.weather.place}`;
    $("#wDesc").textContent = `${data.weather.desc} · ${data.weather.min}°/${data.weather.max}° · pioggia ${data.weather.rain}%`;
  }
  renderEvents($("#eventsToday"), data.today, "Nessun impegno oggi");
  renderEvents($("#eventsTomorrow"), data.tomorrow, "Nessun impegno domani");
  $("#agendaCount").textContent = `${data.today.length} OGGI`;
  renderTasks(data.tasks);
  renderReview(data.review, data.reviewDue);
  renderWeek(data.week);
  renderLessons(data.lessons);
}
function renderEvents(list, events, empty) {
  list.replaceChildren(...(events.length ? events.map((e) => {
    const li = el("li", e.past ? "past" : "");
    li.append(el("time", "", e.time || "giorno"));
    const t = el("div", "", e.title);
    if (e.location) t.append(el("small", "", e.location));
    li.append(t);
    return li;
  }) : [el("li", "empty", empty)]));
}

// ---------------------------------------------------------------- attività
function renderTasks(tasks) {
  const open = tasks.filter((t) => !t.done).length;
  $("#taskCount").textContent = `${open} DA FARE`;
  const today = todayKey();
  $("#tasks").replaceChildren(...(tasks.length ? tasks.map((t) => {
    const li = el("li", t.done ? "done" : "");
    const box = el("input");
    box.type = "checkbox";
    box.checked = t.done;
    box.setAttribute("aria-label", `Segna «${t.title}» come ${t.done ? "da fare" : "fatta"}`);
    box.onchange = async () => { await api(`/api/tasks/${t.id}`, { method: "PATCH", body: JSON.stringify({ done: box.checked }) }); refreshTasks(); };
    li.append(box, el("span", "", t.title));
    if (t.due) li.append(el("small", !t.done && t.due < today ? "late" : "", fmtDay(`${t.due}T12:00:00`)));
    const del = el("button", "", "×");
    del.title = "Elimina";
    del.onclick = async () => { await api(`/api/tasks/${t.id}`, { method: "DELETE" }); refreshTasks(); };
    li.append(del);
    return li;
  }) : [el("li", "empty", "Niente da fare: goditela.")]));
}
async function refreshTasks() {
  const { tasks } = await api("/api/tasks");
  const today = todayKey();
  renderTasks(tasks.filter((t) => !t.done || new Date(t.doneAt).toLocaleDateString("sv-SE") === today));
}
$("#taskForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("#taskTitle").value.trim();
  if (!title) return;
  try { await post("/api/tasks", { title, due: $("#taskDue").value || null }); $("#taskTitle").value = ""; $("#taskDue").value = ""; refreshTasks(); }
  catch (err) { toast(err.message); }
});

// ---------------------------------------------------------------- revisione serale
function setMood(v) {
  mood = v;
  document.querySelectorAll("#mood button").forEach((b) => b.classList.toggle("on", Number(b.dataset.v) === v));
}
document.querySelectorAll("#mood button").forEach((b) => b.addEventListener("click", () => setMood(Number(b.dataset.v))));
function renderReview(r, due) {
  $("#rGood").value = r?.good || "";
  $("#rBad").value = r?.bad || "";
  $("#rNotes").value = r?.notes || "";
  setMood(r?.mood ?? null);
  $("#reviewWhen").textContent = r ? "SALVATA" : due ? "È L'ORA" : `ALLE ${data.reviewTime}`;
  $("#reviewState").textContent = r ? `Salvata alle ${new Date(r.updatedAt).toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" })}. Puoi modificarla quando vuoi.` : "";
  $("#reviewState").className = r ? "state ok" : "state";
}
$("#draftBtn").addEventListener("click", async () => {
  const b = $("#draftBtn");
  b.disabled = true;
  b.textContent = "JARVIS SCRIVE…";
  try {
    const d = await post("/api/reviews/day/draft");
    if (d.good) $("#rGood").value = d.good;
    if (d.bad) $("#rBad").value = d.bad;
    if (d.notes) $("#rNotes").value = d.notes;
    $("#reviewState").textContent = "Bozza pronta: correggila come vuoi, poi salva.";
    $("#reviewState").className = "state";
  } catch (err) { $("#reviewState").textContent = err.message; $("#reviewState").className = "state err"; }
  finally { b.disabled = false; b.textContent = "✳ BOZZA DI JARVIS"; }
});
$("#reviewForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const body = { good: $("#rGood").value, bad: $("#rBad").value, notes: $("#rNotes").value, mood };
  if (!body.good.trim() && !body.bad.trim()) return toast("Scrivi almeno cosa è andato bene o cosa no.");
  const { review } = await post("/api/reviews/day", body);
  renderReview(review, false);
  toast("Revisione salvata: Jarvis se ne ricorderà");
});

// ---------------------------------------------------------------- settimana
function renderWeek(w) {
  const box = $("#week");
  if (!w || !w.summary) return;
  box.replaceChildren();
  box.className = "week";
  box.append(el("p", "", w.summary));
  if (w.improve) { box.append(el("b", "", "Da migliorare")); box.append(el("p", "", w.improve)); }
  if (w.plan?.length) {
    box.append(el("b", "", "Piano per la settimana nuova"));
    const ul = el("ul");
    for (const step of w.plan) {
      const li = el("li");
      li.append(el("span", "", step));
      const add = el("button", "", "+ ATTIVITÀ");
      add.onclick = async () => { await post("/api/tasks", { title: step }); add.textContent = "AGGIUNTA ✓"; add.disabled = true; refreshTasks(); };
      li.append(add);
      ul.append(li);
    }
    box.append(ul);
  }
  box.append(el("small", "", `Settimana dal ${fmtDay(`${w.date}T12:00:00`)} · ${w.stats?.days ?? 0} revisioni · ${w.stats?.done ?? 0} attività completate`));
}
$("#weekBtn").addEventListener("click", async () => {
  const b = $("#weekBtn");
  b.disabled = true;
  b.textContent = "CALCOLO…";
  try { const { review } = await post("/api/reviews/week"); renderWeek(review); toast("Bilancio della settimana pronto"); }
  catch (err) { toast(err.message); }
  finally { b.disabled = false; b.textContent = "GENERA BILANCIO"; }
});

// ---------------------------------------------------------------- lezioni
function renderLessons(list) {
  $("#lessons").replaceChildren(...(list.length ? list.map((l) => {
    const li = el("li");
    const a = el("a", "", l.title);
    a.href = `/lezione?id=${encodeURIComponent(l.id)}`;
    if (l.active) a.append(el("span", "tag", "IN CORSO"));
    li.append(a, el("small", "", fmtDay(l.date)));
    return li;
  }) : [el("li", "empty", "Nessuna lezione registrata.")]));
}

// ---------------------------------------------------------------- riepilogo dell'AI
async function summary(force = false) {
  const p = $("#summary");
  p.classList.add("loading");
  p.textContent = "Sto preparando il riepilogo…";
  try { const { text } = await post("/api/day/summary", { force }); p.textContent = text || "Niente da segnalare."; }
  catch (err) { p.textContent = err.message; }
  finally { p.classList.remove("loading"); }
}
$("#summaryBtn").addEventListener("click", () => summary(true));

// ---------------------------------------------------------------- notifiche
async function notifyBanner() {
  const s = await pushStatus();
  $("#notifyBanner").hidden = !s.supported || s.enabled || s.permission === "denied";
}
$("#notifyOn").addEventListener("click", async () => {
  try { await enablePush(); await testPush(); toast("Notifiche attive: ti ho mandato una prova"); }
  catch (err) { toast(err.message); }
  notifyBanner();
});

registerWorker();
load().then(() => { summary(false); if (location.hash) document.querySelector(location.hash)?.scrollIntoView(); }).catch((e) => toast(e.message));
notifyBanner();
