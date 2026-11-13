// J.A.R.V.I.S. — regia dell'interfaccia: stati (attesa → risveglio → ascolto → ragionamento → voce), turni di parola,
// risposte in streaming dal cervello, pannelli (numeri, agenda, sottotitoli) e comandi.
import { createScene } from "./orb.js";
import { Speaker, Listener, Music, sfx, audioCtx } from "./voice.js";
import { MUSIC, findReply, linesOf, fixedLines, normalize } from "./replies.js";
import { api, streamChat } from "./api.js";
import { registerWorker } from "./pwa.js";
import { createSetup } from "./setup.js";

const $ = (s) => document.querySelector(s);
const body = document.body;
const nf = new Intl.NumberFormat("it-IT");
const DESKTOP = matchMedia("(min-width: 900px) and (pointer: fine)").matches;

// ---------------------------------------------------------------- stato
const app = { settings: { addressAs: "signore" }, setup: {}, briefing: { lines: [], today: [], upcoming: [] }, memories: [], local: true };
let mode = "boot", greeted = false, briefingDone = false, sleepAfterSpeech = false, recordingMode = readSoloJarvis();
let history = [], streamCtrl = null, lastSpoken = "", lastHandled = { key: "", at: 0 }, lastActivity = 0;
let briefingAudio = null, pendingQuestion = null, thinkStart = 0, thinkBase = 0, party = false;

// "Jarvis" capito male dal riconoscimento vocale (giarvis, gervis, darvis, charvis, jarvi…):
// si riportano le varianti di pronuncia alla stessa forma e si confronta con uno schema.
function isJarvis(word) {
  const w = normalize(word).replace(/\s/g, "").replace(/^(gi|ch|dj|g|d|i|y)(?=[ae]r?v)/, "j").replace(/^je/, "ja");
  return w.length >= 4 && /^jar?vi?s?$/.test(w);
}
// posizione della parola "Jarvis" nel testo (anche spezzata in due: "jar vis"); -1 se non c'è
function findWake(text) {
  const words = text.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    if (isJarvis(words[i])) return { rest: words.slice(i + 1).join(" ") };
    if (i + 1 < words.length && isJarvis(words[i] + words[i + 1])) return { rest: words.slice(i + 2).join(" ") };
  }
  return null;
}
const STOP_WORDS = new Set(["stop", "basta", "fermati", "zitto", "silenzio", "aspetta", "alt"]);
const isStop = (text) => normalize(text).split(" ").some((w) => STOP_WORDS.has(w) || isJarvis(w));
const GOODBYES = ["a dopo", "ci sentiamo dopo", "vai in pausa", "standby", "riposati", "spegniti", "per ora basta", "grazie jarvis", "disattivati"];
const isGoodbye = (text) => { const n = normalize(text); return GOODBYES.some((g) => n.includes(g)); };
const SHORT_ANSWERS = new Set(["si", "no", "ok", "okay", "certo", "esatto", "perfetto", "grazie", "conferma", "confermo", "annulla", "procedi", "continua", "stop", "basta", "vai"]);

// «solo Jarvis»: risponde solo alle frasi con il suo nome (utile se parli con altri o sei in classe); ricordata su questo dispositivo
function readSoloJarvis() { try { return localStorage.getItem("jarvis.soloJarvis") === "1"; } catch { return false; } }
function setSoloJarvis(on) {
  recordingMode = on;
  try { localStorage.setItem("jarvis.soloJarvis", on ? "1" : "0"); } catch {}
  const b = document.querySelector("#soloBtn");
  if (b) { b.classList.toggle("on", on); b.textContent = on ? "SOLO «JARVIS» · SÌ" : "SOLO «JARVIS» · NO"; }
}
const orb = createScene($("#orb"), $("#labels"));
const music = new Music(MUSIC);
const say = (text, meta = {}) => { if (mode !== "speak" && mode !== "wake") setMode("speak"); speaker.say(text, meta); };

// ---------------------------------------------------------------- voce di Jarvis
const speaker = new Speaker({
  onLevel: (v) => orb.setLevel(v),
  onSentence: (text, seconds, meta) => {
    lastSpoken = text;
    caption(text, seconds);
    if (meta.stat) showStat(meta.stat, seconds);
    if (meta.stat2) setTimeout(() => showStat(meta.stat2, seconds * 0.6), seconds * 450);
    if ([meta.stat?.id, meta.stat2?.id].includes("agenda")) setTimeout(showAgenda, meta.stat?.id === "agenda" ? 0 : seconds * 450);
    if (meta.music === "party") { party = true; music.play(1, 1); orb.burstSynapses(80); }
    if (meta.music === "stop") { party = false; setTimeout(() => music.stop(3), 800); }
    if (meta.stat && !["agenda", "week"].includes(meta.stat.id)) body.classList.add("show-stats");
  },
  onIdle: () => {
    if (mode !== "speak" && mode !== "wake") return;
    if (sleepAfterSpeech) { sleepAfterSpeech = false; return setTimeout(goSleep, 400); }
    setTimeout(() => { if (!speaker.busy && (mode === "speak" || mode === "wake")) { setMode("listen"); sfx.listen(); } }, 250);
  },
});

// ---------------------------------------------------------------- il tuo microfono
const listener = new Listener({
  onFinal: heard,
  onInterim: (text, { echo }) => {
    if (echo || mode !== "listen") return;
    $("#heard").textContent = turn.text ? `${turn.text} ${text}` : text;
    $("#heard").classList.add("live");
    lastActivity = performance.now();
    if (turn.text) planTurn(); // stai ancora parlando: Jarvis aspetta
  },
  onLevel: (v) => { orb.setMic(mode === "sleep" || mode === "listen" ? v : 0); $("#micBar").style.transform = `scaleX(${Math.min(1, v * 1.4)})`; },
  onState: (s) => diag("dEngine", s),
  onEvent: (e) => event(e),
  onError: (e) => {
    diag("dNote", e);
    if (/bloccato/.test(e)) { $("#hintText").textContent = "MICROFONO BLOCCATO · CONSENTILO DAL LUCCHETTO · OPPURE SCRIVI"; toast("Microfono bloccato: consentilo dalle impostazioni del sito (lucchetto)"); }
    if (/senza riconoscimento/.test(e)) {
      $("#hintText").textContent = "QUESTO BROWSER NON CAPISCE LA VOCE · APRI JARVIS CON EDGE O CHROME · OPPURE SCRIVI";
      toast("Questo browser (es. Opera, Brave) non supporta il riconoscimento vocale: usa Microsoft Edge o Google Chrome");
    }
  },
});

// ---------------------------------------------------------------- stati
const STATUS = { boot: "AVVIO", sleep: "IN ATTESA · DÌ «CIAO JARVIS»", wake: "CONNESSIONE", listen: "IN ASCOLTO", think: "ELABORAZIONE", speak: "RISPOSTA", paused: "MICROFONO IN PAUSA" };
function setMode(next) {
  if (next !== "listen") dropTurn();
  mode = next;
  body.dataset.mode = next;
  orb.setMode(next === "wake" ? "speak" : next === "paused" ? "sleep" : next);
  listener.mute(next === "speak" || next === "wake");
  $("#status").textContent = next === "listen" && recordingMode ? "IN ASCOLTO · DÌ «JARVIS»" : STATUS[next] || next.toUpperCase();
  diag("dState", next.toUpperCase());
  if (next === "listen") lastActivity = performance.now();
  if (next === "think") { $("#spoken").textContent = ""; thinkStart = performance.now(); thinkBase = orb.synapses; }
  // musica: forte al risveglio, poi sottofondo, più bassa quando Jarvis parla; si ferma in pausa
  const bed = briefingDone ? MUSIC.after : MUSIC.bed;
  if (next === "wake") music.play(music.playing ? bed : MUSIC.intro, 1.2).then((ok) => ok && setTimeout(() => mode === "wake" && music.fade(MUSIC.duck, 0.5), 700));
  else if (!music.playing) return;
  else if (next === "speak") music.fade(party ? 0.45 : MUSIC.duck, 0.4);
  else if (next === "listen") { briefingDone = true; music.fade(party ? 1 : MUSIC.after, 2); }
  else if (next === "sleep") { party = false; music.fade(MUSIC.after, 2); }
  else if (next === "paused") { party = false; music.stop(1.2); }
}
function diag(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
  report(id, value);
}
// diagnostica a distanza: microfono, motore di ascolto, frasi sentite ed errori finiscono anche nel terminale di Jarvis
// (righe [ascolto]), così si può capire cosa non va senza vedere lo schermo del dispositivo
const REPORTED = { dMic: "microfono", dEngine: "ascolto", dHeard: "sentito", dNote: "nota", dState: "stato" };
const DEVICE = /Android/i.test(navigator.userAgent) ? "telefono Android" : /iPhone|iPad/i.test(navigator.userAgent) ? "iPhone" : "computer";
let lastReport = {}, events = 0;
// eventi del riconoscimento (avvio, stop, errori): i primi 60 di ogni pagina, per non riempire il terminale
function event(text) {
  if (++events > 60) return;
  fetch("/api/diag", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: DEVICE, kind: "evento", value: text }), keepalive: true }).catch(() => {});
}
event(`pagina aperta · ${navigator.userAgent.replace(/^Mozilla\/5\.0 /, "").slice(0, 160)} · riconoscimento vocale ${"webkitSpeechRecognition" in window || "SpeechRecognition" in window ? "presente" : "ASSENTE"}`);
function report(id, value) {
  if (!REPORTED[id] || lastReport[id] === value) return;
  lastReport[id] = value;
  fetch("/api/diag", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ device: DEVICE, kind: REPORTED[id], value: String(value).slice(0, 300) }), keepalive: true }).catch(() => {});
}
function toast(text) {
  const el = $("#toast");
  el.textContent = text;
  el.classList.add("on");
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove("on"), 3200);
}

// ---------------------------------------------------------------- pannelli
function caption(text, seconds) {
  const el = $("#spoken"), words = text.split(/\s+/), step = Math.min(0.4, (seconds * 0.9) / words.length);
  el.replaceChildren(...words.map((w, i) => { const s = document.createElement("span"); s.textContent = `${w} `; s.style.animationDelay = `${i * step}s`; return s; }));
}
function countUp(el, target, ms, suffix = "") {
  const t0 = performance.now();
  let tick = 0;
  const step = (now) => {
    const p = Math.min(1, (now - t0) / ms), eased = p === 1 ? 1 : 1 - Math.pow(2, -10 * p);
    el.textContent = nf.format(Math.round(target * eased)) + suffix;
    if (p < 1 && now - tick > 80) { sfx.tick(); tick = now; }
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function showStat(stat, seconds = 1.5) {
  let card = document.querySelector(`.stat[data-id="${stat.id}"]`);
  if (!card) {
    card = document.createElement("div");
    card.className = "stat";
    card.dataset.id = stat.id;
    card.innerHTML = `<span></span><b>0</b><small></small><div class="bar"><i></i></div>`;
    card.querySelector("span").textContent = String($("#stats").children.length + 1).padStart(2, "0");
    card.querySelector("small").textContent = stat.label;
    $("#stats").append(card);
  }
  requestAnimationFrame(() => card.classList.add("on"));
  const ms = Math.max(1200, Math.min(2600, seconds * 850));
  countUp(card.querySelector("b"), stat.value, ms, stat.suffix || "");
  const bar = card.querySelector(".bar i");
  bar.style.transitionDuration = `${ms}ms`;
  requestAnimationFrame(() => (bar.style.transform = `scaleX(${stat.suffix === "%" ? Math.min(1, stat.value / 100) : 1})`));
  orb.burstSynapses(18);
}
function renderAgenda() {
  const items = app.briefing.upcoming || app.briefing.today || [];
  const list = items.length ? items : [{ title: "Nessun impegno in vista", time: "—" }];
  $("#agenda").replaceChildren(...list.slice(0, 7).map((e, i) => {
    const li = document.createElement("li");
    if (i === 0 && e.id !== undefined) li.className = "next";
    li.style.transitionDelay = `${i * 0.1}s`;
    li.innerHTML = `<time></time><span></span>`;
    li.querySelector("time").textContent = e.day && e.day !== "OGGI" ? `${e.day} ${e.time || ""}`.trim() : e.time || (e.allDay ? "GIORNO" : "—");
    li.querySelector("span").textContent = e.title;
    return li;
  }));
}
function showAgenda() { renderAgenda(); body.classList.add("show-agenda"); }
function updateLabels() {
  const up = app.briefing.upcoming || [];
  orb.setLabels([
    ...up.slice(0, 4).map((e) => ({ kind: `AGENDA · ${e.day && e.day !== "OGGI" ? `${e.day} ` : ""}${e.time || "GIORNO"}`, text: e.title.slice(0, 34) })),
    ...app.memories.slice(0, 3).map((m) => ({ kind: "MEMORIA", text: m.text.slice(0, 34) })),
    { kind: "SISTEMA", text: app.setup.calendar ? "Calendario sincronizzato" : "Agenda locale attiva" },
    { kind: "SISTEMA", text: "Rete neurale operativa" },
  ]);
}
setInterval(() => {
  const d = new Date();
  $("#clock").textContent = d.toLocaleTimeString("it-IT");
  $("#date").textContent = d.toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long" });
  if (mode === "think") {
    $("#synapses").textContent = nf.format((orb.synapses - thinkBase) * 37);
    $("#thinkTime").textContent = `${((performance.now() - thinkStart) / 1000).toFixed(1)}s`;
  }
  if (!recordingMode && mode === "listen" && !turn.text && performance.now() - lastActivity > 45000 && !speaker.busy) goSleep();
  if (pendingQuestion && mode === "listen") { const q = pendingQuestion; pendingQuestion = null; respond(q); }
}, 100);

// ---------------------------------------------------------------- risveglio e standby
async function wake(rest = "") {
  lastActivity = performance.now();
  const question = rest.replace(/^[\s,.!?]*(ciao|ehi|hey|ok|buongiorno|salve)?[\s,.!?]*/i, "").trim();
  body.classList.add("awake");
  orb.wake();
  if (greeted) {
    sfx.listen();
    if ($("#stats").children.length) body.classList.add("show-stats", "show-agenda");
    setMode("listen"); // nessuna frase di risposta: coprirebbe la tua voce
    if (question) queueTurn(question, { engine: "browser" });
    return;
  }
  greeted = true;
  setMode("wake");
  sfx.wake();
  updateLabels();
  $("#spoken").textContent = $("#heard").textContent = "";
  setTimeout(() => body.classList.add("show-stats"), 900);
  const lines = app.briefing.lines || [], audio = await (briefingAudio || Promise.resolve([]));
  setTimeout(() => lines.forEach((l, i) => speaker.say(l.text, l, audio[i] || null)), 1000);
  if (question.split(/\s+/).length >= 3) pendingQuestion = question;
}
function goSleep() {
  streamCtrl?.abort();
  speaker.stop();
  setMode("sleep");
  body.classList.remove("awake", "show-stats", "show-agenda");
  $("#spoken").textContent = $("#heard").textContent = "";
  sfx.sleep();
}
function interrupt() {
  streamCtrl?.abort();
  streamCtrl = null;
  speaker.stop();
  $("#spoken").textContent = "";
  setMode("listen");
  sfx.listen();
}

// ---------------------------------------------------------------- turni di parola
// Il riconoscimento vocale chiude una frase a ogni piccola pausa: i pezzi si accumulano e Jarvis risponde
// solo dopo un silenzio vero (più lungo se la frase sembra lasciata a metà o se stai dettando un messaggio).
let turn = { text: "", info: null, timer: 0 };
const UNFINISHED = /(\b(e|ed|ma|o|che|perche|quindi|poi|cioe|tipo|allora|pero|di|a|da|in|con|su|per|tra|fra|il|lo|la|i|gli|le|un|una|uno|del|della|dei|mi|ti|ci|se|come|quando|dove|quanto|sono|ho|hai|vorrei|voglio|puoi|dimmi)|,|\.\.\.)$/i;
const DICTATING = /\b(scrivi|scrivile|scrivigli|manda|mandale|mandagli|messaggio|dille|digli|avvisa|invia)\b/i;
function mergeTurn(prev, next) {
  if (!prev) return next;
  const p = prev.toLowerCase(), n = next.toLowerCase();
  if (n.startsWith(p)) return next; // il riconoscimento ha ripetuto tutto
  if (p.endsWith(n)) return prev;   // pezzo già incluso
  return `${prev} ${next}`;
}
function queueTurn(text, info) {
  turn.text = mergeTurn(turn.text, text.trim());
  turn.info = info;
  lastActivity = performance.now();
  $("#heard").textContent = turn.text;
  $("#heard").classList.add("live");
  planTurn();
}
function planTurn() {
  clearTimeout(turn.timer);
  const t = normalize(turn.text), words = t.split(" ").filter(Boolean).length;
  const wait = UNFINISHED.test(t) ? 2600 : DICTATING.test(t) ? 2400 : words < 3 ? 1800 : 1400;
  turn.timer = setTimeout(endTurn, wait);
}
function endTurn() {
  const { text, info } = turn;
  dropTurn();
  if (text.trim() && mode === "listen") heard(text, { ...info, complete: true });
}
function dropTurn() { clearTimeout(turn.timer); turn = { text: "", info: null, timer: 0 }; }
function looksLikeEcho(text) {
  const words = new Set(normalize(text).split(" ").filter((w) => w.length > 2));
  if (!words.size) return true;
  const spoken = new Set(normalize(lastSpoken).split(" "));
  let common = 0;
  words.forEach((w) => spoken.has(w) && common++);
  return common / words.size > 0.5;
}

// tutto quello che il microfono (o la tastiera) consegna passa da qui
function heard(raw, info = {}) {
  const text = raw.trim();
  if (!text) return;
  diag("dHeard", `${info.engine || "?"}${info.echo ? " (eco)" : ""}: ${text}`);
  if (mode === "sleep") { const w = findWake(text); if (w) wake(w.rest); return; }
  if (mode === "paused" || mode === "boot") return;
  if (info.engine === "tastiera") { if (mode !== "listen") interrupt(); return respond(text); }
  if (info.echo || mode === "think" || mode === "speak" || mode === "wake") {
    if (isStop(text) && !looksLikeEcho(text)) interrupt(); // interruzione solo con un comando vero, non con l'eco
    return;
  }
  if (!info.complete) return queueTurn(text, info);
  if (recordingMode && !findWake(text)) return diag("dNote", `modalità registrazione, ignorato: "${text}"`);
  const key = normalize(text), words = key.split(" ").filter(Boolean);
  if (key === lastHandled.key && Date.now() - lastHandled.at < 4000) return;
  if (text.length < 3 || (words.length < 2 && !SHORT_ANSWERS.has(key) && !findWake(text))) return diag("dNote", `ignorato: "${text}"`);
  // su Android la "sicurezza" del riconoscimento è spesso bassa anche per frasi giuste: si scarta solo il rumore evidente
  if (info.confidence > 0 && info.confidence < 0.15 && words.length < 3) return diag("dNote", `poco chiaro: "${text}"`);
  lastHandled = { key, at: Date.now() };
  $("#heard").textContent = text;
  $("#heard").classList.remove("live");
  const w = findWake(text.split(/\s+/).slice(0, 3).join(" ")) && findWake(text);
  respond((w && w.rest.trim()) || text);
}

// ---------------------------------------------------------------- risposte
async function respond(text) {
  lastActivity = performance.now();
  try {
    if (isGoodbye(text)) { sleepAfterSpeech = true; return say(`A presto, ${app.settings.addressAs}. Resto in ascolto.`); }
    const reply = findReply(text);
    return reply ? quickReply(reply, text) : askMind(text);
  } catch (e) {
    diag("dNote", e.message);
    say(`Si è verificato un problema tecnico, ${app.settings.addressAs}. Puoi ripetere?`);
  }
}
function context() {
  const d = new Date();
  return { addressAs: app.settings.addressAs, today: app.briefing.today || [], hasMusic: Boolean(music.buffer), minutes: d.getHours() * 60 + d.getMinutes() };
}
async function quickReply(reply, text) {
  const lines = linesOf(reply, context());
  setMode("think");
  sfx.think();
  orb.burstSynapses(45);
  $("#thinkLabel").textContent = "ELABORAZIONE";
  const [audio] = await Promise.all([Promise.all(lines.map((l) => speaker.audioFor(l.text))), new Promise((r) => setTimeout(r, 600))]);
  if (mode !== "think") return; // interrotto
  remember(text, lines.map((l) => l.text).join(" "));
  setMode("speak");
  lines.forEach((l, i) => speaker.say(l.text, l, audio[i]));
}
function remember(user, assistant) {
  history.push({ role: "user", content: user }, { role: "assistant", content: assistant });
  history = history.slice(-12);
}
const TOOL_LABELS = {
  add_event: "AGGIORNAMENTO AGENDA", delete_event: "AGGIORNAMENTO AGENDA", save_memory: "CODIFICA MEMORIA", forget_memory: "AGGIORNAMENTO MEMORIA",
  show_number: "ELABORAZIONE DATI", search_web: "RICERCA IN RETE", get_weather: "STAZIONI METEO", send_whatsapp: "COMPOSIZIONE MESSAGGIO",
  call_contact: "PREPARAZIONE CHIAMATA", save_contact: "AGGIORNAMENTO RUBRICA", add_task: "AGGIORNAMENTO ATTIVITÀ", complete_task: "AGGIORNAMENTO ATTIVITÀ",
  save_review: "ARCHIVIAZIONE REVISIONE",
};
async function askMind(text) {
  setMode("think");
  sfx.think();
  orb.burstSynapses(40);
  const phases = ["ANALISI SEMANTICA", "ATTRAVERSAMENTO MEMORIA", "SINTESI RISPOSTA"];
  let phase = 0;
  $("#thinkLabel").textContent = phases[0];
  const ticker = setInterval(() => ($("#thinkLabel").textContent = phases[++phase % phases.length]), 900);
  const ctrl = (streamCtrl = new AbortController());
  let pending = "", full = "", spoke = false;
  const speak = (s) => {
    s = s.trim();
    if (!s || ctrl.signal.aborted) return;
    spoke = true;
    clearInterval(ticker);
    speaker.streaming = true;
    say(s);
  };
  // si parla frase per frase appena una frase è completa (le frasi troppo corte vengono unite alla successiva)
  const flush = (all) => {
    for (;;) {
      const m = pending.match(/^[\s\S]*?[.!?…;](?=\s|$)/);
      if (!m) break;
      let s = m[0];
      if (s.trim().length < 20) { const m2 = pending.slice(s.length).match(/^[\s\S]*?[.!?…;](?=\s|$)/); if (!m2) break; s += m2[0]; }
      pending = pending.slice(s.length);
      speak(s);
    }
    if (all && pending.trim()) { speak(pending); pending = ""; }
  };
  try {
    await streamChat(text, history, (ev) => {
      if (ev.type === "delta") { pending += ev.text; full += ev.text; flush(false); }
      else if (ev.type === "context") { $("#thinkLabel").textContent = "MEMORIA PERTINENTE TROVATA"; orb.highlight(); }
      else if (ev.type === "tool") { $("#thinkLabel").textContent = TOOL_LABELS[ev.name] || "ELABORAZIONE"; orb.burstSynapses(40); }
      else if (ev.type === "agenda") {
        app.briefing.today = ev.today;
        app.briefing.upcoming = ev.upcoming;
        showAgenda();
        for (const [id, v] of [["agenda", ev.today.length], ["week", ev.week]]) { const b = document.querySelector(`.stat[data-id="${id}"] b`); if (b) countUp(b, v, 900); }
        updateLabels();
        orb.highlight();
      } else if (ev.type === "memory") { app.memories.unshift({ text: ev.text }); updateLabels(); orb.highlight(0); }
      else if (ev.type === "stat") { body.classList.add("show-stats"); showStat(ev.stat, 2); }
      else if (ev.type === "action") showAction(ev);
      else if (ev.type === "tasks" || ev.type === "review") { orb.highlight(); toast(ev.type === "tasks" ? "Attività aggiornate · le trovi in GIORNATA" : "Revisione salvata"); }
    }, ctrl.signal);
    flush(true);
  } catch {
    if (!ctrl.signal.aborted) speak("La connessione con la mia mente si è interrotta. Riprova tra un istante.");
  } finally {
    clearInterval(ticker);
    if (streamCtrl === ctrl) streamCtrl = null;
    if (full.trim()) remember(text, full.trim());
    if (!spoke && mode === "think") setMode("listen");
    speaker.finishStream();
  }
}

// ---------------------------------------------------------------- azioni pronte (WhatsApp, chiamate): partono con un tuo tocco
let actionTimer = 0;
function showAction(a) {
  const el = $("#action");
  el.classList.toggle("call", a.kind === "call");
  el.classList.toggle("whatsapp", a.kind === "whatsapp");
  el.dataset.phone = a.phone || "";
  $("#actionKind").textContent = a.kind === "call" ? "CHIAMATA PRONTA" : "MESSAGGIO WHATSAPP · PUOI CORREGGERLO";
  $("#actionTitle").textContent = a.title;
  $("#actionDetail").textContent = a.detail || "";
  $("#actionText").value = a.kind === "whatsapp" ? a.detail || "" : "";
  $("#actionGo").textContent = a.label;
  $("#actionGo").href = a.url;
  el.classList.add("on");
  orb.burstSynapses(30);
  clearTimeout(actionTimer);
  actionTimer = setTimeout(hideAction, 90_000);
}
function hideAction() { clearTimeout(actionTimer); $("#action").classList.remove("on"); }
$("#actionCancel").addEventListener("click", hideAction);
$("#actionText").addEventListener("input", () => clearTimeout(actionTimer));
$("#actionGo").addEventListener("click", () => {
  const el = $("#action");
  if (el.classList.contains("whatsapp") && el.dataset.phone) $("#actionGo").href = `https://wa.me/${el.dataset.phone}?text=${encodeURIComponent($("#actionText").value.trim())}`;
  setTimeout(hideAction, 400);
});

// ---------------------------------------------------------------- avvio
const setup = createSetup({ app, toast, onSaved: async () => { await load(); speaker.cache.clear(); } });
async function load() {
  Object.assign(app, await api("/api/bootstrap"));
  $("#brainDot").classList.toggle("on", Boolean(app.setup.brain));
  diag("dMind", app.setup.brain ? (app.setup.model || app.setup.brain).toUpperCase() : "NON CONFIGURATA");
  renderAgenda();
}
async function boot() {
  registerWorker();
  try {
    await load();
    if (!app.setup.brain) setup.open();
  } catch {
    // server spento o in riavvio: si riprova da soli ogni 3 secondi, finché risponde
    diag("dNote", "server non raggiungibile");
    $("#gateText").textContent = DEVICE === "computer" ? "JARVIS NON RAGGIUNGIBILE · RIPROVO…" : "NON TROVO IL COMPUTER · ACCENDI TAILSCALE SUL TELEFONO · RIPROVO…";
    setTimeout(boot, 3000);
    return;
  }
  $("#gateText").textContent = "TOCCA PER INIZIARE";
  fetch("/api/voice/health").then((r) => r.json()).then((h) => {
    listener.whisperAvailable = Boolean(h.whisper); // senza Whisper l'ascolto del browser non si arrende mai
    diag("dVoice", h.elevenlabs ? "ELEVENLABS" : h.tts ? `NEURALE GRATUITA${h.whisper ? " + WHISPER" : ""}` : "BROWSER");
  }).catch(() => {});
}
async function start() {
  $("#gate").classList.add("hide");
  await audioCtx.resume();
  if (DESKTOP && !document.fullscreenElement && !new URLSearchParams(location.search).has("nofs")) document.documentElement.requestFullscreen?.().catch(() => {});
  briefingAudio = speaker.preload((app.briefing.lines || []).map((l) => l.text));
  briefingAudio.then(() => speaker.preload(fixedLines(context())));
  try {
    await listener.start();
    diag("dMic", listener.label);
    diag("dEngine", listener.engine?.toUpperCase());
  } catch (e) {
    diag("dNote", `microfono: ${e.message}`);
    $("#hintText").textContent = "MICROFONO BLOCCATO · CONSENTILO DAL LUCCHETTO · OPPURE SCRIVI";
  }
  setTimeout(() => setMode("sleep"), 500);
  if (new URLSearchParams(location.search).has("wake")) setTimeout(() => wake(""), 900);
}
$("#gate").addEventListener("click", () => (app.setup.brain ? start() : setup.open()));
$("#gate").addEventListener("keydown", (e) => e.key === "Enter" && $("#gate").click());

// ---------------------------------------------------------------- comandi
let dockTimer = 0;
addEventListener("pointermove", () => {
  body.classList.add("show-dock");
  clearTimeout(dockTimer);
  dockTimer = setTimeout(() => body.classList.remove("show-dock"), 2400);
});
$("#setupBtn").addEventListener("click", () => setup.open());
$("#phoneBtn").addEventListener("click", () => setup.open("phone"));
$("#soloBtn").addEventListener("click", () => {
  setSoloJarvis(!recordingMode);
  sfx.tick();
  if (mode !== "boot") setMode(mode);
  toast(recordingMode ? "Rispondo solo alle frasi con «Jarvis»" : "Rispondo a tutto quello che dici");
});
setSoloJarvis(recordingMode);
$("#diagBtn").addEventListener("click", () => $("#diag").classList.toggle("show"));
$("#typeBtn").addEventListener("click", () => { $("#typeBox").classList.toggle("show"); $("#typeBox input").focus(); });
$("#fsBtn").addEventListener("click", () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()));
$("#pauseBtn").addEventListener("click", () => {
  if (mode === "paused") {
    listener.resume();
    setMode(greeted && body.classList.contains("awake") ? "listen" : "sleep");
    $("#pauseBtn").textContent = "PAUSA";
  } else {
    interrupt();
    listener.pause();
    setMode("paused");
    $("#pauseBtn").textContent = "RIPRENDI";
  }
});
$("#typeBox").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $("#typeBox input").value.trim();
  $("#typeBox input").value = "";
  $("#typeBox").classList.remove("show");
  if (!v) return;
  if (mode === "boot" || mode === "sleep") { pendingQuestion = v; wake(""); } // risponde appena finito il saluto
  else heard(v, { engine: "tastiera" });
});
addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA"].includes(e.target.tagName) || body.classList.contains("show-setup")) return;
  const k = e.key.toLowerCase();
  if (k === "d") $("#diag").classList.toggle("show");
  if (k === "f") $("#fsBtn").click();
  if (k === "w" && mode === "sleep") wake("");
  if (k === "t") { e.preventDefault(); $("#typeBtn").click(); }
  if (k === "escape") $("#typeBox").classList.remove("show");
  if (k === "j") $("#soloBtn").click();
  if (k === "r") { greeted = briefingDone = false; music.stop(1); history = []; $("#stats").replaceChildren(); goSleep(); } // reset completo della scena
});

boot();
