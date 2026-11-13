// Markdown minimo e sicuro per gli appunti delle lezioni (usato sia dalla pagina sia dal server per il file Word).
// Tutto il testo viene "escapato": l'AI non può inserire HTML o script nella pagina.
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*\w])\*([^*\s][^*]*?)\*(?!\w)/g, "$1<em>$2</em>")
    .replace(/(^|[^_\w])_([^_\s][^_]*?)_(?!\w)/g, "$1<em>$2</em>");
}

// Grafico: ```chart {"type":"bar|line|pie","title":"...","labels":[...],"series":[{"name":"...","data":[...]}]}
export function parseChart(text) {
  try {
    const c = JSON.parse(text);
    if (!Array.isArray(c.labels) || !Array.isArray(c.series) || !c.series.length) return null;
    c.series = c.series.filter((s) => Array.isArray(s.data)).map((s) => ({ name: String(s.name || ""), data: s.data.map(Number) }));
    c.labels = c.labels.map(String);
    c.type = ["bar", "line", "pie"].includes(c.type) ? c.type : "bar";
    return c.series.length ? c : null;
  } catch {
    return null;
  }
}
// versione tabella (per Word e come riserva)
export function chartTable(c) {
  const head = `<tr><th></th>${c.series.map((s) => `<th>${esc(s.name)}</th>`).join("")}</tr>`;
  const rows = c.labels.map((l, i) => `<tr><th>${esc(l)}</th>${c.series.map((s) => `<td>${Number.isFinite(s.data[i]) ? s.data[i] : ""}</td>`).join("")}</tr>`).join("");
  return `<figure class="chart-table">${c.title ? `<figcaption>${esc(c.title)}</figcaption>` : ""}<table>${head}${rows}</table></figure>`;
}

function table(rows) {
  const cells = (r) => r.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
  const body = rows.filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r)).map(cells);
  if (!body.length) return "";
  const [head, ...rest] = body;
  return `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rest.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
}

export function markdownToHtml(md, { chart = chartTable } = {}) {
  const lines = String(md || "").replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  const isList = (l) => /^\s*([-*+]|\d+[.)])\s+/.test(l);
  const isSpecial = (l) => /^```|^#{1,4}\s|^\s*\|.*\|\s*$|^\s*>|^\s*(-{3,}|\*{3,})\s*$/.test(l) || isList(l);
  while (i < lines.length) {
    const l = lines[i];
    const fence = l.match(/^```\s*([\w-]*)/);
    if (fence) {
      const buf = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]); i++) buf.push(lines[i]);
      i++;
      if (fence[1] === "chart") { const c = parseChart(buf.join("\n")); if (c) out.push(chart(c)); }
      else out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
      continue;
    }
    const h = l.match(/^(#{1,4})\s+(.*)/);
    if (h) { out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); i++; continue; }
    if (/^\s*\|.*\|\s*$/.test(l)) {
      const rows = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(lines[i++]);
      out.push(table(rows));
      continue;
    }
    if (isList(l)) {
      const ordered = /^\s*\d/.test(l);
      const items = [];
      while (i < lines.length && (isList(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        const m = lines[i].match(/^(\s*)([-*+]|\d+[.)])\s+(.*)/);
        if (m && items.length && !m[1] && /^\d/.test(m[2]) !== ordered) break; // inizia un elenco di tipo diverso
        if (m) items.push({ depth: Math.min(3, Math.floor(m[1].replace(/\t/g, "  ").length / 2)), text: m[3] });
        else items[items.length - 1].text += ` ${lines[i].trim()}`;
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((it) => `<li${it.depth ? ` class="d${it.depth}"` : ""}>${inline(it.text)}</li>`).join("")}</${tag}>`);
      continue;
    }
    if (/^\s*>/.test(l)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${inline(buf.join(" "))}</blockquote>`);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(l)) { out.push("<hr>"); i++; continue; }
    if (!l.trim()) { i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !isSpecial(lines[i])) buf.push(lines[i++].trim());
    out.push(`<p>${inline(buf.join(" "))}</p>`);
  }
  return out.join("\n");
}
