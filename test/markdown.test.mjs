import { test } from "node:test";
import assert from "node:assert/strict";
import { markdownToHtml, parseChart, esc } from "../public/js/markdown.js";

test("l'HTML scritto dall'AI viene neutralizzato (niente script nella pagina)", () => {
  const html = markdownToHtml("## Titolo <script>alert(1)</script>\n<img src=x onerror=alert(1)>");
  assert.ok(!html.includes("<script>"));
  assert.ok(!html.includes("<img"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("titoli, grassetto, corsivo e codice", () => {
  const html = markdownToHtml("# Uno\n## Due\nTesto **forte** e *corsivo* con `x = 1`");
  assert.match(html, /<h1>Uno<\/h1>/);
  assert.match(html, /<h2>Due<\/h2>/);
  assert.match(html, /<strong>forte<\/strong>/);
  assert.match(html, /<em>corsivo<\/em>/);
  assert.match(html, /<code>x = 1<\/code>/);
});

test("un elenco numerato dopo uno puntato resta separato", () => {
  const html = markdownToHtml("- a\n- b\n1. uno\n2. due");
  assert.match(html, /<ul><li>a<\/li><li>b<\/li><\/ul>/);
  assert.match(html, /<ol><li>uno<\/li><li>due<\/li><\/ol>/);
});

test("le sotto-voci hanno il rientro", () => {
  assert.match(markdownToHtml("- padre\n  - figlio"), /<li class="d1">figlio<\/li>/);
});

test("tabelle Markdown", () => {
  const html = markdownToHtml("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.match(html, /<thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>1<\/td><td>2<\/td>/);
});

test("grafici: JSON valido diventa grafico, JSON rotto viene ignorato", () => {
  const ok = '```chart\n{"type":"bar","title":"T","labels":["x","y"],"series":[{"name":"s","data":[1,2]}]}\n```';
  assert.match(markdownToHtml(ok), /<figcaption>T<\/figcaption>/);
  assert.equal(markdownToHtml("```chart\n{rotto\n```"), "");
  assert.equal(parseChart('{"labels":[],"series":[]}'), null);
  assert.equal(parseChart('{"type":"boh","labels":["a"],"series":[{"data":[1]}]}').type, "bar");
});

test("esc trasforma i caratteri pericolosi", () => {
  assert.equal(esc(`<a href="x">'&`), "&lt;a href=&quot;x&quot;&gt;&#39;&amp;");
});
