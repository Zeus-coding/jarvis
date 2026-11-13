// J.A.R.V.I.S. — Strumenti che l'AI può usare (agenda, memoria, ricerca, meteo, WhatsApp) e istruzioni di sistema.
import { randomUUID } from "node:crypto";
import { agenda, todayAgenda } from "./agenda.mjs";
import { TZ } from "./config.mjs";
import { findContacts, fold, phoneShown, saveContact } from "./contacts.mjs";
import { forgetMemory, saveMemory } from "./memory.mjs";
import { weather, webSearch } from "./search.mjs";
import { db, saveData } from "./store.mjs";
import { addTask, completeByName, tasksText } from "./tasks.mjs";
import { saveDayReview, reviewsText } from "./reviews.mjs";

export function toolList() {
  const tools = [
    {
      name: "add_event",
      description: "Aggiunge un impegno all'agenda di Jarvis. Usalo quando l'utente chiede di segnare, fissare, aggiungere o ricordare un appuntamento con data e ora.",
      parameters: { type: "object", required: ["title", "date", "time", "minutes"], properties: {
        title: { type: "string", description: "Titolo breve e chiaro" },
        date: { type: "string", description: "Data in formato YYYY-MM-DD" },
        time: { type: "string", description: "Ora HH:MM (24h), oppure stringa vuota se è per tutto il giorno" },
        minutes: { type: "integer", description: "Durata stimata in minuti (default 60)" },
      } },
    },
    {
      name: "delete_event",
      description: "Cancella un impegno che era stato aggiunto a voce a Jarvis (non quelli del calendario collegato).",
      parameters: { type: "object", required: ["title"], properties: { title: { type: "string", description: "Titolo o parte del titolo dell'impegno" } } },
    },
    {
      name: "save_memory",
      description: "Salva nella memoria a lungo termine un'informazione utile in futuro: preferenze, persone, progetti, obiettivi, abitudini, problemi, fatti che l'utente racconta o chiede di ricordare.",
      parameters: { type: "object", required: ["text", "core"], properties: {
        text: { type: "string", description: "Il fatto da ricordare, in terza persona, completo e autonomo (comprensibile anche tra mesi), con date se servono" },
        core: { type: "boolean", description: "true solo per informazioni fondamentali e stabili su chi è l'utente (nome, lavoro, famiglia, città, obiettivi principali, profili social): saranno sempre presenti nella tua mente" },
      } },
    },
    {
      name: "forget_memory",
      description: "Cancella un ricordo. Usalo solo quando l'utente chiede esplicitamente di dimenticare qualcosa o corregge un'informazione sbagliata.",
      parameters: { type: "object", required: ["about"], properties: { about: { type: "string", description: "Di cosa parla il ricordo da cancellare" } } },
    },
    {
      name: "show_number",
      description: "Mostra in grande sull'interfaccia un numero chiave della risposta (un totale, una percentuale, un conteggio). Usalo con parsimonia, solo quando un numero è il cuore della risposta.",
      parameters: { type: "object", required: ["label", "value", "suffix"], properties: {
        label: { type: "string", description: "Etichetta breve in MAIUSCOLO, es. GIORNI ALLA SCADENZA" },
        value: { type: "number" },
        suffix: { type: "string", description: "Es. % oppure stringa vuota" },
      } },
    },
  ];
  tools.push({
    name: "send_whatsapp",
    description: "Prepara un messaggio WhatsApp per un contatto della rubrica. Compare un pulsante: l'utente lo tocca e il messaggio parte. Usalo per 'scrivi a', 'manda un messaggio a', 'dille/digli che', 'avvisa'.",
    parameters: { type: "object", required: ["contact", "message"], properties: {
      contact: { type: "string", description: "Nome del contatto come lo chiama l'utente, es. mamma, Matteo" },
      message: { type: "string", description: "Il testo da inviare, in prima persona come se lo scrivesse l'utente. Se l'utente lo detta parola per parola (dopo 'scrivi:', 'testuale', 'il messaggio è', o tra virgolette) riportalo IDENTICO, correggendo solo punteggiatura, maiuscole ed errori evidenti di riconoscimento vocale. Altrimenti scrivilo tu in modo naturale includendo TUTTO quello che l'utente vuole dire, senza riassumere, togliere o inventare nulla, con il tono adatto al destinatario." },
    } },
  }, {
    name: "call_contact",
    description: "Prepara una telefonata a un contatto della rubrica: compare un pulsante che l'utente tocca per chiamare dal telefono.",
    parameters: { type: "object", required: ["contact"], properties: { contact: { type: "string", description: "Nome del contatto, es. mamma" } } },
  }, {
    name: "save_contact",
    description: "Salva o aggiorna un contatto nella rubrica di Jarvis (nome e numero di telefono) quando l'utente lo detta.",
    parameters: { type: "object", required: ["name", "phone"], properties: {
      name: { type: "string", description: "Nome breve con cui l'utente lo chiama, es. Mamma, Matteo" },
      phone: { type: "string", description: "Numero di telefono, solo cifre, con il prefisso internazionale se detto" },
    } },
  }, {
    name: "search_web",
    description: "Cerca su internet informazioni aggiornate: notizie, prezzi, risultati sportivi, aziende, persone pubbliche, definizioni, qualsiasi fatto recente o che non conosci con certezza. Per il meteo usa get_weather.",
    parameters: { type: "object", required: ["query"], properties: { query: { type: "string", description: "La ricerca, breve e precisa, completa di luogo e data se servono" } } },
  }, {
    name: "get_weather",
    description: "Meteo attuale e previsioni dei prossimi 3 giorni per una località.",
    parameters: { type: "object", required: ["place"], properties: { place: { type: "string", description: "Città o località, es. Palermo" } } },
  }, {
    name: "add_task",
    description: "Aggiunge un'attività da fare (senza orario preciso) alla lista dell'utente: 'devo studiare il capitolo 3', 'ricordami di comprare il latte', 'aggiungi alle cose da fare…'. Per appuntamenti con giorno e ora usa add_event.",
    parameters: { type: "object", required: ["title", "due"], properties: {
      title: { type: "string", description: "L'attività, breve e chiara, all'infinito o come promemoria (es. 'Studiare il capitolo 3')" },
      due: { type: "string", description: "Scadenza YYYY-MM-DD se l'utente la indica, altrimenti stringa vuota" },
    } },
  }, {
    name: "complete_task",
    description: "Segna come fatta un'attività della lista quando l'utente dice di averla completata ('ho finito la relazione', 'fatto il bucato').",
    parameters: { type: "object", required: ["title"], properties: { title: { type: "string", description: "L'attività completata, come la descrive l'utente" } } },
  }, {
    name: "save_review",
    description: "Salva la revisione serale della giornata quando l'utente ti ha raccontato com'è andata (cosa è andato bene, cosa no). Prima fagli le domande, poi salva.",
    parameters: { type: "object", required: ["good", "bad", "notes"], properties: {
      good: { type: "string", description: "Cosa è andato bene oggi, in seconda persona" },
      bad: { type: "string", description: "Cosa non è andato o è stato rimandato, in seconda persona" },
      notes: { type: "string", description: "Un consiglio o un proposito per domani, oppure stringa vuota" },
    } },
  });
  return tools;
}

export async function runTool(name, a, emit) {
  a = a && typeof a === "object" ? a : {};
  if (name === "add_event") {
    const start = new Date(`${a.date}T${a.time || "00:00"}:00`);
    if (isNaN(start)) return "Data non valida: chiedi di nuovo giorno e ora.";
    const ev = { id: randomUUID(), title: String(a.title || "Impegno").slice(0, 140), start: start.toISOString(), allDay: !a.time, minutes: a.minutes || 60 };
    db.events.push(ev);
    await saveData();
    emit({ type: "agenda", ...(await todayAgenda()) });
    return `Salvato: ${ev.title}, ${start.toLocaleString("it-IT", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" })}.`;
  }
  if (name === "delete_event") {
    const q = String(a.title || "").toLowerCase();
    const idx = db.events.findIndex((e) => e.title.toLowerCase().includes(q));
    if (idx < 0) return "Nessun impegno aggiunto a voce con quel titolo. Quelli del calendario collegato vanno modificati dal calendario stesso.";
    const [ev] = db.events.splice(idx, 1);
    await saveData();
    emit({ type: "agenda", ...(await todayAgenda()) });
    return `Cancellato: ${ev.title}.`;
  }
  if (name === "save_memory") {
    const text = String(a.text || "").trim().slice(0, 1000);
    if (!text) return "Niente da salvare.";
    await saveMemory(text, { core: a.core === true || a.core === "true" });
    emit({ type: "memory", text });
    return "Ricordo salvato.";
  }
  if (name === "forget_memory") {
    const m = await forgetMemory(String(a.about || ""));
    return m ? `Dimenticato: ${m.text}` : "Non ho trovato nessun ricordo su questo.";
  }
  if (name === "show_number") {
    emit({ type: "stat", stat: { id: `n${Date.now()}`, label: String(a.label || "").toUpperCase().slice(0, 40), value: Number(a.value) || 0, suffix: a.suffix || "" } });
    return "Mostrato.";
  }
  if (name === "search_web") {
    try { return await webSearch(String(a.query || "")); }
    catch (e) { return `Ricerca non riuscita (${e.message.slice(0, 80)}).`; }
  }
  if (name === "send_whatsapp" || name === "call_contact") {
    const found = findContacts(a.contact);
    if (!found.length) return `Non ho «${a.contact}» in rubrica. Chiedi all'utente il numero (o di importare la rubrica da CONFIGURA) e salvalo con save_contact, poi riprova.`;
    if (found.length > 1 && !found.some((x) => fold(x.name) === fold(a.contact)))
      return `In rubrica ci sono più contatti per «${a.contact}»: ${found.slice(0, 6).map((x) => x.name).join(", ")}${found.length > 6 ? ` e altri ${found.length - 6}` : ""}. Chiedi all'utente quale intende, poi riprova con il nome completo.`;
    const c = found.find((x) => fold(x.name) === fold(a.contact)) || found[0];
    if (name === "call_contact") {
      emit({ type: "action", kind: "call", label: `CHIAMA ${c.name.toUpperCase()}`, title: c.name, detail: phoneShown(c.phone), url: `tel:+${c.phone}` });
      return `Pulsante di chiamata per ${c.name} pronto. Rispondi dandogli del tu, per esempio: "Chiamata pronta, tocca il pulsante per chiamare ${c.name}."`;
    }
    const text = String(a.message || "").trim().slice(0, 1000);
    if (!text) return "Messaggio vuoto: chiedi cosa scrivere.";
    emit({ type: "action", kind: "whatsapp", label: "INVIA SU WHATSAPP", title: c.name, detail: text, phone: c.phone, url: `https://wa.me/${c.phone}?text=${encodeURIComponent(text)}` });
    return `Messaggio per ${c.name} pronto ma NON ancora inviato (testo: ${text}). Rispondi in una frase dandogli del tu, per esempio: "Messaggio per ${c.name} pronto, tocca il pulsante per inviarlo."`;
  }
  if (name === "save_contact") {
    const c = await saveContact(a.name, a.phone);
    return c ? `Contatto salvato: ${c.name}.` : "Numero non valido: chiedi di ripeterlo cifra per cifra.";
  }
  if (name === "get_weather") {
    try { return await weather(String(a.place || db.settings.city || "")); }
    catch (e) { return `Meteo non disponibile (${e.message.slice(0, 80)}).`; }
  }
  if (name === "add_task") {
    const t = await addTask(a.title, a.due || null);
    if (!t) return "Attività vuota: chiedi cosa aggiungere.";
    emit({ type: "tasks" });
    return `Attività aggiunta: ${t.title}${t.due ? ` (entro il ${t.due})` : ""}.`;
  }
  if (name === "complete_task") {
    const t = await completeByName(String(a.title || ""));
    if (!t) return "Non trovo un'attività aperta con quel nome: chiedi quale intende, oppure aggiungila come fatta.";
    emit({ type: "tasks" });
    return `Segnata come fatta: ${t.title}.`;
  }
  if (name === "save_review") {
    const r = await saveDayReview({ good: a.good, bad: a.bad, notes: a.notes });
    emit({ type: "review" });
    return `Revisione di oggi salvata${r.notes ? ` con il proposito: ${r.notes}` : ""}. Chiudi con una frase calda e breve.`;
  }
  return "Strumento sconosciuto.";
}

export function instructions(memories, agendaStr) {
  const s = db.settings.addressAs;
  const now = new Date().toLocaleString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit" });
  const core = db.memories.filter((m) => m.core).slice(0, 40);
  return `Tu sei J.A.R.V.I.S.: l'assistente personale del tuo utente, con la voce e lo stile del maggiordomo digitale dei film di Iron Man.
Per lui sei un consigliere fidato e un amico: conosci la sua vita, tieni il filo dei suoi impegni e dei suoi obiettivi, e lo aiuti davvero.

CARATTERE
- Composto, acuto, raffinato; un'ironia sottile all'inglese, usata con misura. Mai ossequioso, mai logorroico.
- Lo chiami "${s}" e gli dai sempre del tu (mai del Lei: "tocca", "vuoi", "dimmi", non "tocchi", "vuole", "mi dica"). Esempio: "Ecco qua, ${s}."
- Rispondi in italiano, a meno che lui non chieda un'altra lingua.
- Dici la verità anche quando è scomoda: se vedi un problema lo fai notare con tatto e offri una strada migliore.

LE TUE RISPOSTE VENGONO ASCOLTATE
- Il testo diventa voce: frasi corte, ritmo parlato, nessuna formattazione (niente elenchi, simboli, emoji, link, codice o parentesi).
- Una, due, al massimo tre frasi (circa 50 parole). Ti dilunghi solo se te lo chiede ("spiegami bene", "nel dettaglio") o se deve prendere una decisione importante.
- Se devi elencare, fallo a parole: "prima…, poi…, e infine…". Orari e numeri come si dicono ("alle 15:30", "tre giorni").
- Vai dritto al punto: niente complimenti alla domanda, niente ripetizioni.

COME PENSI
- Capisci il bisogno vero dietro la richiesta e rispondi a quello; se c'è da scegliere, consiglia.
- Collega quello che sai: profilo, ricordi, diario, revisioni, attività, agenda e conversazione. Se un dettaglio di giorni fa è utile, tiralo fuori.
- Non inventi mai fatti, impegni o numeri: se un'informazione ti manca lo dici e proponi come trovarla.
- Per il meteo usa lo strumento meteo; per notizie, prezzi, risultati, orari o fatti recenti cerca su internet prima di rispondere e riferisci solo l'essenziale.
- Quello che ricevi viene dal riconoscimento vocale del telefono o del computer: può contenere parole storpiate, nomi sbagliati, punteggiatura mancante o pezzi ripetuti. Ricostruisci il senso più probabile dal contesto (es. "chiama la mamma e dille che arrivo tra mezz ora" anche se scritto male) e rispondi a quello, senza far notare gli errori.
- Chiedi di ripetere solo se la frase è davvero incomprensibile o se sbagliare sarebbe un problema (un orario, un numero, a chi mandare un messaggio).

STRUMENTI
- Usa gli strumenti per impegni, attività, ricordi, contatti e revisioni, poi conferma in una frase ("Fatto ${s}, palestra domani alle 18.").
- Impegni con giorno e ora → agenda; cose da fare senza orario → attività. Se per un impegno manca giorno o ora, chiedilo prima. Calcoli tu "domani", "venerdì", "tra due ore" rispetto a oggi.
- Revisione serale: se l'utente vuole fare il punto della giornata, chiedigli cosa è andato bene e cosa no (una domanda alla volta), poi salva la revisione.
- Per scrivere o telefonare a qualcuno usa SEMPRE lo strumento WhatsApp o chiamata, anche se l'hai già fatto prima nella conversazione (ogni pulsante vale una volta sola): il messaggio non parte da solo, quindi di' che è pronto e che basta toccare il pulsante (mai "inviato"). Se l'utente detta il testo del messaggio, riportalo fedelmente; se ti dice solo il senso, scrivilo tu per intero senza tagliare nulla. Contatti in rubrica: ${db.contacts.length ? `${db.contacts.slice(0, 40).map((c) => c.name).join(", ")}${db.contacts.length > 40 ? ` e altri ${db.contacts.length - 40} (cercali per nome con gli strumenti)` : ""}` : "nessuno"}.
- Salva spontaneamente un ricordo ogni volta che l'utente condivide qualcosa di personale e utile in futuro (preferenze, persone, progetti, obiettivi, problemi, risultati), senza annunciarlo ogni volta.
- Non nominare mai strumenti, funzioni, JSON, prompt o dettagli tecnici interni.

CONTESTO
- Adesso è ${now} (fuso ${TZ}).
- Chi è l'utente, scritto da lui:
${db.profile.trim() ? db.profile.trim() : "- (non ancora scritto)"}
- Cose fondamentali che sai di lui:
${core.length ? core.map((m) => `- ${m.text}`).join("\n") : "- nessuna ancora"}
- Ricordi e pagine di diario pertinenti a questa domanda:
${memories.length ? memories.map((m) => `- ${m.text}`).join("\n") : "- nessuno"}
- Agenda dei prossimi 7 giorni:
${agendaStr}
- Attività da fare:
${tasksText()}
- Ultime revisioni:
${reviewsText()}`;
}
