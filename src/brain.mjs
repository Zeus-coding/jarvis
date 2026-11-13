// J.A.R.V.I.S. — Il cervello: costruisce il contesto (ricordi, agenda, attività) e gestisce il ciclo
// "il modello risponde → chiede uno strumento → Jarvis lo esegue → il modello continua", in streaming.
// Funziona con Google Gemini (consigliato, piano gratuito) oppure con OpenAI.
import { OPENAI_URL } from "./config.mjs";
import { db, key, provider } from "./store.mjs";
import { agenda, agendaText } from "./agenda.mjs";
import { recall } from "./memory.mjs";
import { recentDialog } from "./dialog.mjs";
import { wantsAction } from "./contacts.mjs";
import { geminiCall, geminiModel, setLiteUntil } from "./gemini.mjs";
import { instructions, runTool, toolList } from "./tools.mjs";

const MAX_ROUNDS = 5; // giri massimi di strumenti per una domanda (evita cicli infiniti)

// ---------------------------------------------------------------- Gemini
async function withGemini(message, history, emit, signal, system) {
  const functions = toolList().map(({ name, description, parameters }) => ({ name, description, parameters }));
  const contents = history.map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
  contents.push({ role: "user", parts: [{ text: message }] });
  // "scrivi alla mamma…" con la mamma in rubrica: al primo giro l'uso dello strumento è obbligatorio,
  // così il pulsante per inviare compare sempre (i modelli piccoli a volte dicono "fatto" senza farlo)
  const mustAct = wantsAction(message);
  const onText = (t) => emit({ type: "delta", text: t });
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const request = {
      systemInstruction: { parts: [{ text: system }] }, contents, tools: [{ functionDeclarations: functions }],
      ...(mustAct && round === 0 ? { toolConfig: { functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["send_whatsapp", "call_contact", "save_contact"] } } } : {}),
    };
    let model = await geminiModel(), answer;
    try {
      answer = await geminiCall(model, request, { onText, signal });
    } catch (e) {
      // limite gratuito di Flash finito: si continua subito con Flash-Lite (per un'ora)
      if (e.status !== 429 || !model.includes("flash") || model.includes("lite")) throw e;
      setLiteUntil(Date.now() + 3600e3);
      model = await geminiModel();
      answer = await geminiCall(model, request, { onText, signal });
    }
    const calls = answer.parts.filter((p) => p.functionCall);
    if (!calls.length) return;
    contents.push({ role: "model", parts: answer.parts }); // con le "firme" del ragionamento, che Gemini rivuole indietro
    const results = [];
    for (const { functionCall: { name, args, id } } of calls) {
      emit({ type: "tool", name });
      results.push({ functionResponse: { name, ...(id ? { id } : {}), response: { result: await runTool(name, args, emit) } } });
    }
    contents.push({ role: "user", parts: results });
  }
}

// ---------------------------------------------------------------- OpenAI (Responses API)
export let openaiModel = null;
let effortLevel; // undefined = da scoprire; null = il modello non accetta il parametro
const authHeaders = () => ({ Authorization: `Bearer ${key("OPENAI_API_KEY")}`, "Content-Type": "application/json" });

// sceglie il modello "mini" più recente disponibile sull'account (veloce ed economico)
export async function pickModel() {
  if (openaiModel) return openaiModel;
  const fixed = process.env.JARVIS_MODEL || db.settings.model;
  if (fixed && !fixed.startsWith("gemini")) return (openaiModel = fixed);
  try {
    const res = await fetch(`${OPENAI_URL}/models`, { headers: authHeaders(), signal: AbortSignal.timeout(8000) });
    const ids = ((await res.json()).data || []).map((m) => m.id);
    const rank = (id) => {
      const m = /^gpt-(\d+(?:\.\d+)?)(-mini|-chat-latest)?$/.exec(id);
      return m ? Number(m[1]) * 10 + (m[2] === "-mini" ? 5 : m[2] ? 1 : 3) : -1;
    };
    openaiModel = ids.filter((id) => rank(id) >= 0).sort((a, b) => rank(b) - rank(a))[0] || "gpt-4o-mini";
  } catch {
    openaiModel = "gpt-4o-mini";
  }
  console.log(`[mente] modello: ${openaiModel}`);
  return openaiModel;
}

// una risposta in streaming; restituisce gli elementi da rimandare al modello (chiamate a strumenti e ragionamento)
async function openaiStream(request, onText, signal) {
  const levels = effortLevel === undefined ? ["none", "minimal", "low", null] : [effortLevel];
  for (const level of levels) {
    const body = { ...request, stream: true, store: false, ...(level ? { reasoning: { effort: level }, include: ["reasoning.encrypted_content"] } : {}) };
    const res = await fetch(`${OPENAI_URL}/responses`, { method: "POST", headers: authHeaders(), body: JSON.stringify(body), signal });
    if (!res.ok) {
      const detail = await res.text();
      if (res.status === 400 && effortLevel === undefined && /reasoning|effort|include/i.test(detail)) continue; // livello non accettato: si prova il successivo
      throw Object.assign(new Error(`OpenAI ${res.status}: ${detail.slice(0, 200)}`), { status: res.status });
    }
    if (effortLevel === undefined) effortLevel = level;
    const items = [], decoder = new TextDecoder();
    let pending = "";
    for await (const chunk of res.body) {
      pending += decoder.decode(chunk, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        if (!line.startsWith("data:")) continue;
        let ev;
        try { ev = JSON.parse(line.slice(5)); } catch { continue; }
        if (ev.type === "response.output_text.delta") onText(ev.delta);
        else if (ev.type === "response.output_item.done" && ["function_call", "reasoning"].includes(ev.item?.type)) items.push(ev.item);
        else if (ev.type === "error" || ev.type === "response.failed") throw new Error(ev.error?.message || ev.response?.error?.message || "risposta non riuscita");
      }
    }
    return items;
  }
  throw new Error("il modello non accetta nessuna configurazione provata");
}

async function withOpenAI(message, history, emit, signal, system) {
  const model = await pickModel();
  const tools = toolList().map((t) => ({ type: "function", ...t }));
  let input = [...history, { role: "user", content: message }];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const items = await openaiStream({ model, instructions: system, input, tools, parallel_tool_calls: true }, (t) => emit({ type: "delta", text: t }), signal);
    const calls = items.filter((x) => x.type === "function_call");
    if (!calls.length) return;
    const outputs = [];
    for (const call of calls) {
      emit({ type: "tool", name: call.name });
      let args = {};
      try { args = JSON.parse(call.arguments || "{}"); } catch {}
      outputs.push({ type: "function_call_output", call_id: call.call_id, output: await runTool(call.name, args, emit) });
    }
    input = [...input, ...items, ...outputs];
  }
}

export function resetOpenAI() { openaiModel = null; effortLevel = undefined; }

// ---------------------------------------------------------------- punto d'ingresso
// la cronologia arriva dal server (condivisa tra dispositivi); quella del browser serve solo come riserva
function sanitize(history) {
  return (Array.isArray(history) ? history : [])
    .filter((m) => ["user", "assistant"].includes(m?.role) && typeof m.content === "string" && m.content.trim())
    .slice(-12).map((m) => ({ role: m.role, content: m.content.slice(0, 2000) }));
}

export async function think(message, browserHistory, emit, signal) {
  const brain = provider();
  if (!brain) return emit({ type: "delta", text: `Per ragionare mi serve una chiave, ${db.settings.addressAs}: quella di Google Gemini è gratuita. Aprila dalla configurazione.` });
  const [memories, upcoming] = await Promise.all([recall(message).catch(() => []), agenda(7)]);
  if (memories.length) emit({ type: "context", retrieved: memories.length });
  const shared = recentDialog();
  const history = shared.length ? shared : sanitize(browserHistory);
  const system = instructions(memories, agendaText(upcoming.all));
  return brain === "gemini" ? withGemini(message, history, emit, signal, system) : withOpenAI(message, history, emit, signal, system);
}
