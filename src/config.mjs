// J.A.R.V.I.S. — configurazione: percorsi, porte e indirizzi dei servizi esterni (modificabili con variabili d'ambiente).
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url)); // cartella del progetto
export const dataDir = process.env.JARVIS_DATA_DIR || join(root, "data"); // i test usano una cartella temporanea
export const dbFile = join(dataDir, "jarvis.json");
export const secretsFile = join(dataDir, "secrets.json");
export const ttsDir = join(dataDir, "tts-cache");
export const VOICE_PORT = Number(process.env.JARVIS_VOICE_PORT) || 8765;
export const VOICE_URL = `http://127.0.0.1:${VOICE_PORT}`;
export const OPENAI_URL = (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
export const GEMINI_URL = (process.env.GEMINI_BASE_URL || "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");
export const PORT = Number(process.env.PORT) || 4173;
export const HOST = process.env.JARVIS_HOST || (process.argv.includes("--lan") || process.env.JARVIS_LAN ? "0.0.0.0" : "127.0.0.1");
export const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;
export const TYPES = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml",
  ".woff2": "font/woff2", ".mp3": "audio/mpeg", ".png": "image/png", ".webmanifest": "application/manifest+json",
};
