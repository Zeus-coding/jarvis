// J.A.R.V.I.S. — Rubrica: numeri di telefono, ricerca dei contatti, importazione .vcf, WhatsApp e chiamate.
import { randomUUID } from "node:crypto";
import { db, saveData } from "./store.mjs";

// I numeri restano qui: all'AI arrivano solo i nomi. Il messaggio si invia con un tocco sul pulsante che compare.
export const fold = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
export function normalizePhone(raw) {
  let p = String(raw || "").replace(/[^\d+]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  else if (p.startsWith("00")) p = p.slice(2);
  else if (/^3\d{8,9}$/.test(p) || /^0\d{5,10}$/.test(p)) p = `39${p}`; // numero italiano senza prefisso
  p = p.replace(/\D/g, "");
  return p.length >= 8 && p.length <= 15 ? p : null;
}
export const RELATIVES = { mamma: ["madre", "mami", "mamy", "mia madre"], papa: ["padre", "babbo", "mio padre", "papi"] };
export const contactNames = (c) => [c.name, ...(c.aliases || []), ...(RELATIVES[fold(c.name)] || [])].map(fold).filter(Boolean);
// tutti i contatti che corrispondono, dal più preciso al più vago (se sono più di uno, Jarvis chiede quale)
export function findContacts(name) {
  const q = fold(name).replace(/^(a |al |alla |allo |ad |mia |mio |la |il |lo )+/, "");
  if (!q) return [];
  const tiers = [
    (n) => n === q,
    (n) => n.split(" ")[0] === q || n.startsWith(`${q} `),
    (n) => n.split(" ").includes(q),
    (n) => n.startsWith(q) || q.startsWith(n),
    (n) => n.includes(q) || (n.length > 3 && q.includes(n)),
  ];
  for (const t of tiers) {
    const found = db.contacts.filter((c) => contactNames(c).some(t));
    if (found.length) return found;
  }
  return [];
}
export const findContact = (name) => findContacts(name)[0] || null;
export async function saveContact(name, phone, aliases = [], { save = true } = {}) {
  const p = normalizePhone(phone), n = String(name || "").replace(/\s+/g, " ").trim().slice(0, 60);
  if (!n || !p) return null;
  const existing = db.contacts.find((c) => fold(c.name) === fold(n));
  const c = existing || { id: randomUUID(), name: n, aliases: [] };
  c.phone = p;
  c.aliases = [...new Set([...(c.aliases || []), ...aliases.map((a) => String(a).trim()).filter(Boolean)])].slice(0, 6);
  if (!existing) db.contacts.push(c);
  if (save) await saveData();
  return c;
}
// numero migliore per WhatsApp: il cellulare (italiano: inizia con 3)
export function bestPhone(phones) {
  const list = phones.map((x) => (typeof x === "string" ? { v: x, cell: false } : x)).filter((x) => normalizePhone(x.v));
  return (list.find((x) => x.cell) || list.find((x) => /^3\d{8,9}$/.test(normalizePhone(x.v).replace(/^39/, ""))) || list[0])?.v || null;
}
// rubrica esportata (.vcf: Google Contatti, iPhone, Android)
export function parseVcf(text) {
  const qp = (s) => Buffer.from(s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
  const lines = text.replace(/\r\n[ \t]/g, "").replace(/\n[ \t]/g, "").replace(/=\r?\n/g, "=\n").split(/\r?\n/);
  const out = [];
  let cur = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (/^BEGIN:VCARD/i.test(line)) { cur = { name: "", n: "", phones: [] }; continue; }
    if (/^END:VCARD/i.test(line)) {
      if (cur) { const name = cur.name || cur.n; if (name && cur.phones.length) out.push({ name, phones: cur.phones }); }
      cur = null;
      continue;
    }
    if (!cur) continue;
    while (/ENCODING=QUOTED-PRINTABLE/i.test(line) && line.endsWith("=") && i + 1 < lines.length) line = line.slice(0, -1) + lines[++i];
    const k = line.indexOf(":");
    if (k < 0) continue;
    const head = line.slice(0, k).toUpperCase(), raw = line.slice(k + 1);
    const val = (/QUOTED-PRINTABLE/.test(head) ? qp(raw) : raw).replace(/\\([,;\\])/g, "$1").trim();
    const prop = head.split(";")[0].replace(/^ITEM\d+\./, "");
    if (prop === "FN") cur.name = val;
    else if (prop === "N") cur.n = val.split(";").slice(0, 2).reverse().filter(Boolean).join(" ").trim();
    else if (prop === "TEL") cur.phones.push({ v: val.replace(/^tel:/i, ""), cell: /CELL|MOBILE|IPHONE/.test(head) });
  }
  return out;
}
export async function importContacts(list) {
  let added = 0, updated = 0;
  for (const it of list.slice(0, 5000)) {
    const phone = bestPhone(Array.isArray(it.phones) ? it.phones : [it.phone]);
    const before = db.contacts.length, exists = db.contacts.some((c) => fold(c.name) === fold(it.name));
    const c = await saveContact(it.name, phone, [], { save: false });
    if (!c) continue;
    if (db.contacts.length > before) added++; else if (exists) updated++;
  }
  await saveData();
  return { added, updated, total: db.contacts.length };
}
// "scrivi alla mamma…", "chiama Matteo": richiesta di azione verso qualcuno che è in rubrica
export const ACTION_RE = /(?<!\b(?:si|mi|ti|ci|vi|come)\s)\b(scrivi|scrivile|scrivigli|manda|mandale|mandagli|invia|inviale|inviagli|avvisa|avvisala|avvisalo|chiama|telefona|dille|digli)\b/i;
export function wantsAction(message) {
  if (!ACTION_RE.test(message)) return false;
  const m = ` ${fold(message)} `;
  return db.contacts.some((c) => contactNames(c).some((n) => {
    const first = n.split(" ")[0];
    return m.includes(` ${n} `) || (first.length >= 3 && m.includes(` ${first} `));
  }));
}
export function phoneShown(p) {
  if (/^39\d{9,10}$/.test(p)) { const n = p.slice(2); return `+39 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`; } // 333 123 4567
  return `+${p.slice(0, 2)} ${p.slice(2).replace(/(\d{3})(?=\d{4})/g, "$1 ")}`;
}
