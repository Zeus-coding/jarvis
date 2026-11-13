import { test, before } from "node:test";
import assert from "node:assert/strict";
import { useTempData } from "./helpers.mjs";

useTempData();
const store = await import("../src/store.mjs");
const { normalizePhone, phoneShown, parseVcf, importContacts, findContacts, saveContact, wantsAction } = await import("../src/contacts.mjs");

before(async () => { await store.loadData(); });

test("numeri di telefono: prefisso italiano aggiunto quando manca", () => {
  assert.equal(normalizePhone("333 123 4567"), "393331234567");
  assert.equal(normalizePhone("+39 333-123-4567"), "393331234567");
  assert.equal(normalizePhone("0039 3331234567"), "393331234567");
  assert.equal(normalizePhone("091 555 1234"), "390915551234");
  assert.equal(normalizePhone("+44 7911 123456"), "447911123456");
  assert.equal(normalizePhone("123"), null);
});

test("numeri mostrati in modo leggibile", () => {
  assert.equal(phoneShown("393331234567"), "+39 333 123 4567");
});

test("rubrica .vcf: cellulare preferito, accenti, contatti senza numero scartati", async () => {
  const vcf = [
    "BEGIN:VCARD", "VERSION:3.0", "FN:Giuseppe Bianchi", "TEL;TYPE=HOME:091 555 1234", "TEL;TYPE=CELL:+39 320 111 2222", "END:VCARD",
    "BEGIN:VCARD", "VERSION:2.1", "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Nicol=C3=B2", "TEL;CELL:+393475556666", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:Senza Numero", "EMAIL:x@example.com", "END:VCARD",
  ].join("\r\n");
  const list = parseVcf(vcf);
  assert.deepEqual(list.map((c) => c.name), ["Giuseppe Bianchi", "Nicolò"]);
  const r = await importContacts(list);
  assert.equal(r.added, 2);
  assert.equal(findContacts("Giuseppe")[0].phone, "393201112222");
});

test("ricerca contatti: nomi uguali restituiscono tutti i candidati", async () => {
  await saveContact("Giuseppe Verdi", "338 333 4444");
  assert.deepEqual(findContacts("giuseppe").map((c) => c.name).sort(), ["Giuseppe Bianchi", "Giuseppe Verdi"]);
  assert.equal(findContacts("Giuseppe Verdi")[0].name, "Giuseppe Verdi");
  assert.deepEqual(findContacts("nessuno"), []);
});

test("parenti: 'mia madre' trova il contatto Mamma", async () => {
  await saveContact("Mamma", "333 000 1111");
  assert.equal(findContacts("mia madre")[0]?.name, "Mamma");
  assert.equal(findContacts("alla mamma")[0]?.name, "Mamma");
});

test("richieste di messaggio o chiamata verso un contatto in rubrica", () => {
  assert.equal(wantsAction("scrivi alla mamma che arrivo tardi"), true);
  assert.equal(wantsAction("chiama Nicolò"), true);
  assert.equal(wantsAction("come si chiama la capitale della Francia"), false);
  assert.equal(wantsAction("scrivi una poesia"), false);
});
