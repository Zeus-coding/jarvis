import { test } from "node:test";
import assert from "node:assert/strict";
import { parseICS, occurrences } from "../calendar.mjs";

const ics = (body) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${body}\r\nEND:VCALENDAR\r\n`;

test("evento singolo con ora e luogo", () => {
  const ev = parseICS(ics("BEGIN:VEVENT\r\nUID:1\r\nSUMMARY:Esame\\, analisi\r\nLOCATION:Aula 3\r\nDTSTART:20261120T090000\r\nDTEND:20261120T110000\r\nEND:VEVENT"));
  assert.equal(ev.length, 1);
  assert.equal(ev[0].summary, "Esame, analisi");
  const occ = occurrences(ev, new Date(2026, 10, 20), new Date(2026, 10, 21));
  assert.equal(occ.length, 1);
  assert.equal(occ[0].start.getHours(), 9);
  assert.equal(occ[0].location, "Aula 3");
});

test("gli eventi annullati vengono scartati", () => {
  const ev = parseICS(ics("BEGIN:VEVENT\r\nUID:2\r\nSUMMARY:Annullato\r\nSTATUS:CANCELLED\r\nDTSTART:20261120T090000\r\nEND:VEVENT"));
  assert.equal(ev.length, 0);
});

test("evento settimanale ricorrente con un'eccezione (EXDATE)", () => {
  const ev = parseICS(ics([
    "BEGIN:VEVENT", "UID:3", "SUMMARY:Palestra",
    "DTSTART:20261102T180000", "DTEND:20261102T190000",
    "RRULE:FREQ=WEEKLY;BYDAY=MO,WE", "EXDATE:20261111T180000", "END:VEVENT",
  ].join("\r\n")));
  // dal 9 al 22 novembre: lunedì 9, mercoledì 11 (escluso), lunedì 16, mercoledì 18
  const occ = occurrences(ev, new Date(2026, 10, 9), new Date(2026, 10, 22));
  assert.deepEqual(occ.map((o) => o.start.getDate()), [9, 16, 18]);
});

test("ricorrenza con COUNT si ferma al numero giusto", () => {
  const ev = parseICS(ics("BEGIN:VEVENT\r\nUID:4\r\nSUMMARY:Corso\r\nDTSTART:20261101T100000\r\nRRULE:FREQ=DAILY;COUNT=3\r\nEND:VEVENT"));
  const occ = occurrences(ev, new Date(2026, 10, 1), new Date(2026, 10, 30));
  assert.equal(occ.length, 3);
});

test("fuso orario: le 9 a Roma restano le 9 anche dopo il cambio dell'ora legale", () => {
  const ev = parseICS(ics("BEGIN:VEVENT\r\nUID:6\r\nSUMMARY:Lezione\r\nDTSTART;TZID=Europe/Rome:20261019T090000\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT"));
  const occ = occurrences(ev, new Date(Date.UTC(2026, 9, 18)), new Date(Date.UTC(2026, 10, 3)));
  // 19 ottobre (ora legale, UTC+2) e 26 ottobre / 2 novembre (ora solare, UTC+1)
  assert.deepEqual(occ.map((o) => o.start.getUTCHours()), [7, 8, 8]);
});

test("una singola occorrenza spostata sostituisce quella della serie", () => {
  const ev = parseICS(ics([
    "BEGIN:VEVENT", "UID:7", "SUMMARY:Riunione", "DTSTART:20261102T100000Z", "RRULE:FREQ=DAILY;COUNT=3", "END:VEVENT",
    "BEGIN:VEVENT", "UID:7", "SUMMARY:Riunione spostata", "RECURRENCE-ID:20261103T100000Z", "DTSTART:20261103T150000Z", "END:VEVENT",
  ].join("\r\n")));
  const occ = occurrences(ev, new Date(Date.UTC(2026, 10, 1)), new Date(Date.UTC(2026, 10, 10)));
  assert.deepEqual(occ.map((o) => `${o.start.getUTCDate()} ${o.start.getUTCHours()} ${o.title}`), ["2 10 Riunione", "3 15 Riunione spostata", "4 10 Riunione"]);
});

test("giornata intera", () => {
  const ev = parseICS(ics("BEGIN:VEVENT\r\nUID:5\r\nSUMMARY:Ferie\r\nDTSTART;VALUE=DATE:20261124\r\nDTEND;VALUE=DATE:20261125\r\nEND:VEVENT"));
  const occ = occurrences(ev, new Date(2026, 10, 24), new Date(2026, 10, 25));
  assert.equal(occ.length, 1);
  assert.equal(occ[0].allDay, true);
});
