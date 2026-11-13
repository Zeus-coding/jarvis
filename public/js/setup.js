// Configurazione di Jarvis: chiavi, voce, calendario, profilo, accesso dal telefono, notifiche e rubrica.
import { api, post } from "./api.js";
import { pushStatus, enablePush, disablePush, testPush, pushSupported } from "./pwa.js";

const $ = (s) => document.querySelector(s);
const radio = (name) => document.querySelector(`input[name=${name}]:checked`)?.value;
const check = (name, value) => { const el = document.querySelector(`input[name=${name}][value=${value}]`); if (el) el.checked = true; };
function state(id, text = "", kind = "") { const el = $(`#${id}`); el.textContent = text; el.className = `state ${kind}`; }

export function createSetup({ app, onSaved, toast }) {
  const sheet = $("#setup");
  let poll = null, contacts = [];

  function syncClasses() {
    sheet.classList.toggle("brain-openai", radio("brain") === "openai");
    sheet.classList.toggle("voice-eleven", radio("voice") === "eleven");
  }
  document.querySelectorAll("input[name=brain], input[name=voice]").forEach((r) => r.addEventListener("change", syncClasses));

  // ---- apertura: riempie i campi con lo stato attuale (le chiavi non vengono mai rimandate al browser, solo mascherate)
  async function open(section) {
    const st = app.setup;
    document.body.classList.add("show-setup");
    for (const id of ["geminiKey", "openaiKey", "elevenKey", "calendarUrl", "accessPassword", "contactName", "contactPhone"]) $(`#${id}`).value = "";
    check("brain", st.brain || "gemini");
    check("tier", st.modelTier === "flash" ? "flash" : "lite");
    check("voice", st.elevenlabs ? "eleven" : st.voiceMode === "browser" ? "browser" : "free");
    syncClasses();
    $("#geminiKey").placeholder = st.gemini ? `salvata: ${st.geminiMasked} (vuoto = tienila)` : "AIza...";
    $("#openaiKey").placeholder = st.openai ? `salvata: ${st.openaiMasked}` : "sk-...";
    $("#elevenKey").placeholder = st.elevenlabs ? `salvata: ${st.elevenlabsMasked}` : "Chiave ElevenLabs";
    $("#calendarUrl").placeholder = st.calendar ? "collegato (incolla un nuovo link per cambiarlo)" : "Link iCal privato (.ics)";
    state("geminiState", st.gemini ? `Collegata${st.brain === "gemini" && st.model ? ` · ${st.model}` : ""}` : "", st.gemini ? "ok" : "");
    state("openaiState", st.openai ? "Collegata" : "", st.openai ? "ok" : "");
    state("elevenState", st.elevenlabs ? "Voce ElevenLabs attiva" : "", st.elevenlabs ? "ok" : "");
    state("calendarState", st.calendar ? (st.calendarError ? `Errore: ${st.calendarError}` : `Collegato · ${st.calendarEvents} eventi`) : "", st.calendar ? (st.calendarError ? "err" : "ok") : "");
    $("#addressAs").value = app.settings.addressAs || "";
    $("#city").value = st.city || "";
    $("#profile").value = st.profile || "";
    state("profileState", st.memories ? `${st.memories} ricordi in memoria` : "");
    state("passwordState", st.password ? "Password impostata (scrivine una nuova per cambiarla)" : "Senza password Jarvis si apre solo da questo computer", st.password ? "ok" : "");
    $("#phoneTunnel").checked = Boolean(st.phoneTunnel);
    $("#reviewTime").value = st.reviewTime || "21:30";
    $("#setupClose").style.display = st.brain ? "" : "none";
    $("#setupError").textContent = "";
    renderTunnel(st);
    renderNotify();
    loadContacts();
    if (section === "phone") setTimeout(() => $("#phoneBox").closest(".step").scrollIntoView({ behavior: "smooth" }), 80);
    else if (!st.brain) setTimeout(() => $("#geminiKey").focus(), 60);
  }
  function close() { clearTimeout(poll); document.body.classList.remove("show-setup"); }
  $("#setupClose").addEventListener("click", close);

  // ---- telefono: l'indirizzo compare qualche secondo dopo l'attivazione; dal telefono non si può spegnere
  function renderTunnel(st) {
    const remote = app.local === false;
    $("#tunnelLabel").style.display = remote ? "none" : "";
    // indirizzo fisso di Tailscale (consigliato): ha la precedenza su quello di Cloudflare, che cambia a ogni avvio
    const fixed = !remote && st.tailscaleUrl;
    const url = fixed || (!remote && st.phoneTunnel && st.tunnelUrl);
    $("#phoneBox").classList.toggle("on", Boolean(url));
    if (url) { $("#phoneUrl").textContent = $("#phoneUrl").href = url; $("#phoneQr").src = `/api/phone/qr?u=${encodeURIComponent(url)}`; }
    clearTimeout(poll);
    if (remote) return state("tunnelState", "Stai usando Jarvis da un altro dispositivo: l'indirizzo si gestisce dal computer.", "ok");
    if (fixed) return state("tunnelState", "Indirizzo fisso e privato (Tailscale): funziona sui tuoi dispositivi con Tailscale attivo e non cambia mai", "ok");
    if (!st.phoneTunnel) return state("tunnelState", st.tunnelInstalled ? "" : "Serve Cloudflare Tunnel (gratis): chiedi al tuo agente AI di installarlo.");
    if (st.tunnelError) return state("tunnelState", st.tunnelError, "err");
    if (url) return state("tunnelState", "Indirizzo per il telefono attivo", "ok");
    state("tunnelState", "Creo l'indirizzo per il telefono…");
    poll = setTimeout(async () => { try { const s = await api("/api/setup"); app.setup = { ...app.setup, ...s }; renderTunnel(s); } catch {} }, 2000);
  }
  $("#phoneCopy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("#phoneUrl").href); $("#phoneCopy").textContent = "COPIATO ✓"; } catch { getSelection().selectAllChildren($("#phoneUrl")); }
    setTimeout(() => ($("#phoneCopy").textContent = "COPIA LINK"), 1800);
  });

  // ---- notifiche push (per questo dispositivo)
  async function renderNotify() {
    const s = await pushStatus();
    $("#notify").checked = s.enabled;
    $("#notify").disabled = !s.supported;
    state("notifyState", !s.supported ? "Notifiche non disponibili qui (su iPhone: prima «Aggiungi a schermata Home»)" : s.enabled ? "Notifiche attive su questo dispositivo" : s.permission === "denied" ? "Notifiche bloccate: riattivale dal lucchetto nella barra degli indirizzi" : "", s.enabled ? "ok" : s.permission === "denied" ? "err" : "");
  }
  $("#notify").addEventListener("change", async (e) => {
    try {
      if (e.target.checked) { await enablePush(); await testPush(); toast("Notifiche attive: ti ho mandato una prova"); }
      else { await disablePush(); toast("Notifiche disattivate su questo dispositivo"); }
    } catch (err) { toast(err.message); }
    renderNotify();
  });
  if (!pushSupported) $("#notify").disabled = true;

  // ---- rubrica
  async function loadContacts() {
    try { contacts = (await api("/api/contacts")).contacts; } catch { return; }
    renderContacts();
  }
  function renderContacts() {
    const q = $("#contactFilter").value.trim().toLowerCase(), digits = q.replace(/\D/g, "");
    const shown = contacts.filter((c) => !q || c.name.toLowerCase().includes(q) || (digits && c.phone.includes(digits))).slice(0, 80);
    $("#contactFilter").style.display = contacts.length > 8 ? "" : "none";
    const list = $("#contacts");
    list.replaceChildren(...shown.map((c) => {
      const li = document.createElement("li");
      li.innerHTML = `<span></span><small></small><button type="button" title="Elimina">×</button>`;
      li.querySelector("span").textContent = c.name;
      li.querySelector("small").textContent = c.shown;
      li.querySelector("button").onclick = async () => {
        if (!confirm(`Eliminare ${c.name} dalla rubrica?`)) return;
        await api(`/api/contacts/${c.id}`, { method: "DELETE" }).catch(() => {});
        loadContacts();
      };
      return li;
    }));
    if (contacts.length > shown.length && !q) { const li = document.createElement("li"); li.textContent = `…e altri ${contacts.length - shown.length}: usa la ricerca`; list.append(li); }
    if (contacts.length) state("contactState", `${contacts.length} contatti in rubrica`, "ok");
  }
  $("#contactFilter").addEventListener("input", renderContacts);
  async function importContacts(body, type) {
    state("contactState", "Importazione in corso…");
    try {
      const r = await fetch("/api/contacts/import", { method: "POST", headers: { "Content-Type": type }, body });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "Importazione non riuscita");
      await loadContacts();
      state("contactState", `Importati ${j.added} nuovi, ${j.updated} aggiornati · ${j.total} in rubrica`, "ok");
    } catch (e) { state("contactState", e.message, "err"); }
  }
  if (!("contacts" in navigator && "select" in navigator.contacts)) $("#contactPick").style.display = "none"; // solo Chrome su Android
  $("#contactPick").addEventListener("click", async () => {
    try {
      const picked = await navigator.contacts.select(["name", "tel"], { multiple: true });
      if (picked?.length) importContacts(JSON.stringify({ contacts: picked }), "application/json");
    } catch (e) { state("contactState", `Rubrica non disponibile: ${e.message}`, "err"); }
  });
  $("#contactFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (f) importContacts(await f.text(), "text/vcard");
    e.target.value = "";
  });
  $("#contactAdd").addEventListener("click", async () => {
    const name = $("#contactName").value.trim(), phone = $("#contactPhone").value.trim();
    if (!name || !phone) return state("contactState", "Scrivi nome e numero.", "err");
    try { await post("/api/contacts", { name, phone }); $("#contactName").value = $("#contactPhone").value = ""; loadContacts(); }
    catch (e) { state("contactState", e.message, "err"); }
  });

  // ---- salvataggio
  $("#setupForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const brain = radio("brain"), voice = radio("voice");
    const payload = {
      brain, modelTier: radio("tier"),
      geminiKey: brain === "gemini" ? $("#geminiKey").value.trim() : "",
      openaiKey: brain === "openai" ? $("#openaiKey").value.trim() : "",
      elevenlabsKey: voice === "eleven" ? $("#elevenKey").value.trim() : "",
      useFreeVoice: voice !== "eleven",
      voiceMode: voice === "browser" ? "browser" : "neural",
      addressAs: $("#addressAs").value.trim(), city: $("#city").value.trim(), profile: $("#profile").value,
      password: $("#accessPassword").value, reviewTime: $("#reviewTime").value,
      ...(app.local === false ? {} : { phoneTunnel: $("#phoneTunnel").checked }),
      ...($("#calendarUrl").value.trim() ? { calendarUrl: $("#calendarUrl").value.trim() } : {}),
    };
    const st = app.setup;
    if (brain === "gemini" && !st.gemini && !payload.geminiKey) return ($("#setupError").textContent = "Inserisci la chiave Google Gemini: è l'unica obbligatoria.");
    if (brain === "openai" && !st.openai && !payload.openaiKey) return ($("#setupError").textContent = "Inserisci la chiave OpenAI oppure scegli Google Gemini.");
    if (voice === "eleven" && !st.elevenlabs && !payload.elevenlabsKey) return ($("#setupError").textContent = "Inserisci la chiave ElevenLabs oppure scegli un'altra voce.");
    if (payload.password && payload.password.length < 8) return state("passwordState", "Almeno 8 caratteri.", "err");
    if (payload.phoneTunnel && !st.password && !payload.password) return state("tunnelState", "Per il telefono serve prima una password.", "err");
    const btn = $("#setupSave");
    btn.disabled = true;
    btn.textContent = "VERIFICA…";
    $("#setupError").textContent = "";
    try {
      const r = await post("/api/setup", payload);
      for (const [k, id] of [["gemini", "geminiState"], ["openai", "openaiState"], ["elevenlabs", "elevenState"], ["calendar", "calendarState"], ["password", "passwordState"]])
        if (r.errors[k]) state(id, r.errors[k], "err");
      app.setup = r.status;
      if (!r.ok) return ($("#setupError").textContent = "Controlla i campi evidenziati.");
      await onSaved();
      if (payload.phoneTunnel && !r.status.tunnelUrl && app.local !== false) return renderTunnel(r.status); // resta aperta finché compare il QR
      close();
      toast("Configurazione salvata");
    } catch (err) {
      $("#setupError").textContent = err.message;
    } finally {
      btn.disabled = false;
      btn.textContent = "SALVA";
    }
  });

  return { open, close };
}
