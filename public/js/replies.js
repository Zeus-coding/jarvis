// Risposte rapide di J.A.R.V.I.S.: momenti di carattere che non hanno bisogno dell'AI (immediati e senza consumare richieste).
// Ogni risposta: espressioni che la attivano (testo minuscolo, senza accenti) e frasi da dire.
// Una frase può avere: music ("party" | "stop") per la musica di sottofondo, stat per mostrare un numero.

export const MUSIC = {
  file: "/music/theme.mp3", // facoltativo: metti un tuo mp3 in music/theme.mp3
  start: 0,                 // secondo da cui parte
  intro: 0.85,              // volume al risveglio
  bed: 0.32,                // sottofondo durante il saluto
  duck: 0.12,               // mentre Jarvis parla
  after: 0.16,              // sottofondo dopo il saluto
};

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const time = () => new Date().toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });

const REPLIES = [
  {
    id: "chi-sei",
    match: [/\b(chi sei|presentati|cosa sei|come ti chiami)\b/],
    say: (c) => [
      "Sono J.A.R.V.I.S., il tuo sistema cognitivo personale.",
      `Gestisco la tua agenda, ricordo quello che conta per te, ti aiuto a studiare e a decidere. Il resto lo scopriamo insieme, ${c.addressAs}.`,
    ],
  },
  {
    id: "come-stai",
    match: [/\b(come stai|come va|tutto bene)\b/],
    say: (c) => [pick([`Tutti i sistemi sono in ordine, ${c.addressAs}. E tu?`, `Operativo al cento per cento, ${c.addressAs}. Tu come stai?`, `Meglio di un server in sala climatizzata, ${c.addressAs}.`])],
  },
  {
    id: "grazie",
    match: [/^(grazie|grazie mille|ti ringrazio|perfetto grazie)$/],
    say: (c) => [pick([`Sempre un piacere, ${c.addressAs}.`, `Dovere, ${c.addressAs}.`, `Quando vuoi, ${c.addressAs}.`])],
  },
  {
    id: "ora",
    match: [/\b(che ore sono|che ora e|dimmi l ora)\b/],
    say: (c) => [`Sono le ${time()}, ${c.addressAs}.`],
  },
  {
    id: "data",
    match: [/\b(che giorno e oggi|che data e|quanti ne abbiamo)\b/],
    say: () => [`Oggi è ${new Date().toLocaleDateString("it-IT", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.`],
  },
  {
    id: "buonanotte",
    match: [/\b(buonanotte|notte jarvis)\b/],
    say: (c) => [pick([`Buonanotte, ${c.addressAs}. Domani ripartiamo.`, `Riposa bene, ${c.addressAs}. Io resto di guardia.`])],
  },
  {
    id: "battuta",
    match: [/\b(raccontami una barzelletta|fammi ridere|dimmi una battuta)\b/],
    say: () => [pick([
      "Un programmatore va al supermercato. La moglie gli dice: prendi il latte, e se hanno le uova prendine sei. Torna con sei bottiglie di latte.",
      "Ci sono dieci tipi di persone: quelle che capiscono il binario e quelle che no.",
      "Ho provato a raccontare una battuta sull'UDP. Non so se ti è arrivata.",
    ])],
  },
  {
    id: "party",
    match: [/\b(protocollo festa|metti (la )?musica|alza la musica|party)\b/],
    say: (c) => (c.hasMusic
      ? [{ text: "Protocollo festa attivato.", music: "party" }]
      : [`Volentieri, ${c.addressAs}, ma non ho ancora una colonna sonora: metti un mp3 nella cartella music con il nome theme.`]),
  },
  {
    id: "stop-musica",
    match: [/\b(spegni|ferma|togli|abbassa) (la )?musica\b/],
    say: () => [{ text: "Musica in dissolvenza.", music: "stop" }],
  },
  {
    id: "impegni-oggi",
    match: [/^(cosa ho oggi|che impegni ho oggi|impegni di oggi)$/],
    say: (c) => {
      const t = c.today;
      if (!t.length) return [{ text: `Oggi la tua agenda è libera, ${c.addressAs}.`, stat: { id: "agenda", label: "IMPEGNI OGGI", value: 0 } }];
      const list = t.slice(0, 4).map((e) => `${e.time ? `alle ${e.time} ` : ""}${e.title}`).join(", poi ");
      return [{ text: `Oggi hai ${t.length === 1 ? "un impegno" : `${t.length} impegni`}: ${list}.`, stat: { id: "agenda", label: "IMPEGNI OGGI", value: t.length } }];
    },
  },
];

export const normalize = (t) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

export function findReply(text) {
  const n = normalize(text);
  return REPLIES.find((r) => r.match.some((re) => re.test(n))) || null;
}
export function linesOf(reply, ctx) {
  return reply.say(ctx).map((l) => (typeof l === "string" ? { text: l } : l));
}
// frasi sempre uguali, da preparare in anticipo (voce pronta all'istante)
export function fixedLines(ctx) {
  return REPLIES.filter((r) => ["chi-sei", "stop-musica"].includes(r.id)).flatMap((r) => linesOf(r, ctx).map((l) => l.text));
}
