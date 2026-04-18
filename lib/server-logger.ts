import { appendFile, mkdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";

const LOG_DIR = path.join(process.cwd(), "logs");
const MAX_LOG_BYTES = Number(process.env.LOG_MAX_BYTES ?? 512 * 1024);
const MAX_LOG_FILES = 10;

export const LOG_GOALS = {
  app: "Application lifecycle and settings-level events.",
  client: "Browser UI and recorder state events.",
  audio: "Audio chunk metadata, speech gating, and upload shape.",
  transcription: "Transcription request outcomes and accepted transcript text.",
  groq: "Groq upstream request latency, model, and response status.",
  errors: "Rejected requests, exceptions, and failures needing attention.",
} as const;

export type LogCategory = keyof typeof LOG_GOALS;

const LOG_FILES: Record<LogCategory, string> = {
  app: "app.jsonl",
  client: "client.jsonl",
  audio: "audio.jsonl",
  transcription: "transcription.jsonl",
  groq: "groq.jsonl",
  errors: "errors.jsonl",
};

function logPath(category: LogCategory, index = 0) {
  const fileName = LOG_FILES[category];

  if (index === 0) {
    return path.join(LOG_DIR, fileName);
  }

  return path.join(LOG_DIR, `${fileName}.${index}`);
}

async function rotateLogIfNeeded(category: LogCategory, incomingBytes: number) {
  const currentPath = logPath(category);

  try {
    const currentStat = await stat(currentPath);

    if (currentStat.size + incomingBytes <= MAX_LOG_BYTES) {
      return;
    }
  } catch {
    return;
  }

  await rm(logPath(category, MAX_LOG_FILES - 1), { force: true });

  for (let index = MAX_LOG_FILES - 2; index >= 1; index -= 1) {
    try {
      await rename(logPath(category, index), logPath(category, index + 1));
    } catch {
      // Missing rotated files are expected.
    }
  }

  try {
    await rename(currentPath, logPath(category, 1));
  } catch {
    // If another write already rotated or removed it, the next append recreates current.
  }
}

export async function writeLog(category: LogCategory, entry: Record<string, unknown>) {
  const line = `${JSON.stringify({
    timestamp: new Date().toISOString(),
    category,
    goal: LOG_GOALS[category],
    ...entry,
  })}\n`;

  try {
    await mkdir(LOG_DIR, { recursive: true });
    await rotateLogIfNeeded(category, Buffer.byteLength(line, "utf8"));
    await appendFile(logPath(category), line, "utf8");
  } catch (error) {
    console.warn(`Failed to write ${category} log`, error);
  }
}

export async function writeErrorLog(entry: Record<string, unknown>) {
  await writeLog("errors", entry);
}
