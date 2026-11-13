# J.A.R.V.I.S. — guida per gli assistenti AI

Assistente vocale personale che gira sul computer dell'utente e si usa dal browser (anche dal telefono, come app installabile).
Chi ti chiede aiuto spesso non è un programmatore: parla in italiano, in modo semplice e breve, fai tu il lavoro tecnico e spiega solo l'essenziale.

## Installare e avviare
1. **Requisiti**: Node.js 22+ (`node -v`). Python 3.9+ è facoltativo (voce neurale gratuita). Se manca qualcosa, chiedi il permesso prima di installarlo (Windows: `winget install OpenJS.NodeJS.LTS`, `winget install Python.Python.3.12`; Mac: `brew install node python`).
2. **Installa**: `npm run setup` (librerie + voce gratuita). Whisper, il riconoscimento vocale locale di riserva, è pesante: `npm run setup -- --whisper` solo se richiesto.
3. **Avvia**: `npm start`, in background perché resta acceso. Attendi la riga `J.A.R.V.I.S. online → http://localhost:4173`. «Porta già occupata» di solito vuol dire che Jarvis è già acceso.
4. **Spiega all'utente**: aprire http://localhost:4173 con Chrome o Edge, inserire in CONFIGURA la chiave Google Gemini (gratuita, pulsante «Ottieni la chiave»), poi toccare lo schermo, consentire il microfono e dire «Ciao Jarvis». Tutto il resto (voce, calendario, profilo, telefono, contatti) è facoltativo.

## Chiavi e dati personali
- Tutto sta in `data/` (esclusa da git): `jarvis.json` (impostazioni, ricordi, attività, revisioni, contatti, sessioni) e `secrets.json` (chiavi). Non leggerla né mostrarla se non serve davvero.
- Le chiavi si inseriscono dalla pagina CONFIGURA, non in chat. Se l'utente ne incolla una in chat, salvala in `data/secrets.json` (`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ELEVENLABS_API_KEY`, `CALENDAR_ICS_URL`), riavvia e non ripeterla mai.
- La password per gli altri dispositivi è salvata solo come hash (`ACCESS_PASSWORD_HASH`): si può reimpostare, non leggere.
- Costi, da dire con onestà se chiesti: l'API Gemini ha un piano gratuito con limiti giornalieri (visibili in Google AI Studio) e sul piano gratuito Google può usare i dati per migliorare i servizi; l'abbonamento all'app Gemini non vale per le API. OpenAI ed ElevenLabs sono a consumo.

## Cosa sa fare (per rispondere alle domande)
- **Voce**: «Ciao Jarvis» lo sveglia e fa il saluto con gli impegni; poi basta parlare. Risponde dopo una pausa vera (circa 1,4 s; 2,4 s mentre si detta un messaggio; 2,6 s se la frase sembra a metà: `planTurn()` in `public/js/app.js`). Mentre parla non ascolta (anti-eco); «stop» o «basta» lo interrompono. Dopo 45 s di silenzio torna in attesa.
- **Tasti** (computer): D diagnostica, T scrivi, W risveglio, R reset, J modalità registrazione (risponde solo se sente «Jarvis»), F schermo intero. Sul telefono i comandi stanno nella barra in basso.
- **Memoria**: profilo «Chi sei», ricordi fondamentali sempre presenti, diario delle conversazioni vecchie (riassunte oltre 60 messaggi), ricerca per significato con embeddings.
- **Agenda**: calendario iCal collegato (solo lettura) + impegni aggiunti a voce.
- **La mia giornata** (`/giornata`): riepilogo scritto dall'AI, meteo (città in CONFIGURA), agenda, attività con spunte, revisione serale con bozza dell'AI, bilancio settimanale con piano, lezioni recenti.
- **Agente di revisione**: notifica all'ora scelta (predefinita 21:30); a voce «facciamo la revisione della giornata»; domenica sera bilancio della settimana. Le revisioni finiscono in memoria.
- **Modalità Lezione** (`/lezione`): dal telefono trascrive il professore e fotografa la lavagna quando cambia; Gemini aggiorna gli appunti ogni 1-2 minuti; alla fine riassunto, domande d'esame, approfondimenti; esportazione Word.
- **WhatsApp e chiamate**: rubrica in CONFIGURA (a mano, IMPORTA DAL TELEFONO su Chrome Android, file .vcf) o a voce. «Scrivi alla mamma che…» prepara il messaggio e mostra un pulsante: l'utente lo tocca per inviare, perché i browser non permettono di aprire WhatsApp senza un tocco. Jarvis non invia nulla da solo. All'AI arrivano solo i nomi dei contatti.
- **Ricerca**: Google tramite Gemini quando il piano lo consente, altrimenti Wikipedia, Google News e Open-Meteo (gratis, senza chiave).

## Telefono, app e notifiche
- Serve un indirizzo HTTPS. Con Cloudflare Tunnel installato (`winget install --id Cloudflare.cloudflared`, con permesso) e l'opzione «Indirizzo per il telefono» in CONFIGURA, `npm start` avvia da solo il tunnel. L'indirizzo `https://….trycloudflare.com` cambia a ogni avvio e si trova con TELEFONO · QR, nel terminale (riga «📱 Dal telefono») e in `data/telefono.txt`. Il PC deve restare acceso. Dal telefono l'opzione non si può spegnere.
- **Indirizzo fisso (consigliato): Tailscale**. Con Tailscale installato su computer e telefono (stesso account) e `tailscale serve --bg 4173` sul computer, Jarvis risponde sempre su `https://<computer>.<rete>.ts.net`, visibile solo dai dispositivi dell'utente. Jarvis lo rileva da solo (`tailscaleUrl()` in `src/tunnel.mjs`) e lo mostra in CONFIGURA con il QR al posto di quello di Cloudflare. La configurazione di `serve` resta anche dopo il riavvio del PC; Jarvis deve comunque essere acceso. Per toglierlo: `tailscale serve --https=443 off`.
- Errore Cloudflare **1033**: quell'indirizzo non è più attivo (Jarvis spento, riavviato o tunnel disattivato).
- **App installabile**: dal telefono, menu del browser → «Aggiungi a schermata Home». Le **notifiche** si attivano dalla pagina Giornata o in CONFIGURA (su iPhone solo dopo averla aggiunta alla Home).

## Problemi comuni
- **Non sente**: serve Chrome o Edge, microfono consentito (lucchetto nella barra degli indirizzi) e `localhost` oppure HTTPS. Il tasto D mostra cosa sente.
- **Voce lenta o robotica**: se la voce gratuita è lenta, per 5 minuti parla il browser (con Edge è comunque naturale); in CONFIGURA si può scegliere sempre la voce del browser.
- **Errore 429 / limite gratuito**: richieste Gemini finite per oggi (si azzerano a mezzanotte, ora del Pacifico) → aspettare, usare «Veloce» (Flash-Lite) o attivare la fatturazione.
- **401/403**: chiave non valida → CONFIGURA. **Calendario non letto**: serve il link privato iCal (.ics).
- I log sono nel terminale di `npm start` (righe `[mente]`, `[voce]`, `[accesso]`, `[notifiche]`).

## Personalizzare
- Come chiama l'utente, città, orario della revisione: CONFIGURA (`data/jarvis.json` → `settings`).
- Voce gratuita: `settings.ttsVoice`, `ttsRate`, `ttsPitch`. ElevenLabs: `ELEVENLABS_VOICE_ID` in `secrets.json`.
- Cervello: `settings.provider` (`gemini`/`openai`), `settings.modelTier` (`lite` = più richieste gratis, `flash` = più intelligente), modello fisso `settings.model`.
- Carattere e regole: `instructions()` in `src/tools.mjs`. Risposte rapide senza AI: `public/js/replies.js`. Grafica 3D: `public/js/orb.js`.

## Architettura
- `server.mjs`: avvio e smistamento delle richieste; serve solo `public/`, three.js e la musica.
- `src/`: `config` (percorsi; `JARVIS_DATA_DIR` cambia la cartella dati), `store` (dati, chiavi, cervello attivo), `http`, `auth` (password, sessioni, limite tentativi), `gemini` e `brain` (cervello con strumenti, Gemini o OpenAI), `tools` (strumenti e istruzioni), `memory`, `dialog`, `agenda`, `search`, `contacts`, `tasks`, `reviews`, `day` e `day-routes` (giornata), `push` (notifiche Web Push), `scheduler` (promemoria e revisioni), `tts` e `voice-service` (voce), `tunnel` (Cloudflare e QR), `settings`, `lessons`.
- Un modulo non può riassegnare le variabili di un altro: per azzerare stati usa le funzioni dedicate (`resetGemini`, `resetOpenAI`, `resetVoice`, `resetEmbeddings`, `setLiteUntil`, `markGroundingDown`).
- `calendar.mjs`: lettore iCalendar (fusi orari, ricorrenze, eccezioni). `voice_service.py`: voce neurale (edge-tts) e Whisper facoltativo.
- `public/`: `index.html` + `js/app.js` (regia), `orb.js` (sfera 3D), `voice.js` (audio), `setup.js`, `pwa.js`, `replies.js`; `giornata.html`, `lezione.html`; `sw.js` e `manifest.webmanifest` (app installabile).
- Il riconoscimento vocale usa un solo motore alla volta: non aggiungerne altri in parallelo.

## Test e salvataggi
- `npm test` (cartella `test/`, usa una cartella dati temporanea, mai `data/`) e `npm run check` (sintassi di tutti i file). La CI di GitHub li esegue a ogni push. Lanciali dopo ogni modifica.
- Il progetto è in git (ramo `main`). Dopo ogni modifica che funziona, fai un commit con un messaggio in italiano. `data/` e `music/*.mp3` non vanno mai aggiunti. Prima di tornare a una versione precedente chiedi all'utente.
- Non estrarre mai uno zip sopra questa cartella: sovrascriverebbe il lavoro.
