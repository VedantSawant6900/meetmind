import type { StoredSettings } from "./client-types";

export const SETTINGS_STORAGE_KEY = "meetmind.settings";
export const SETTINGS_SCHEMA_VERSION = 2;
export const LEGACY_GROQ_KEY_STORAGE_KEY = "meetmind.groqApiKey";

export const DEFAULT_WHISPER_MODEL = "whisper-large-v3";
export const DEFAULT_TRANSCRIPTION_LANGUAGE = "";
export const AUTO_TRANSCRIPTION_LANGUAGE_LABEL = "auto-detect";
export const DEFAULT_SUGGESTION_MODEL = "openai/gpt-oss-120b";
export const DEFAULT_CHUNK_INTERVAL_SECONDS = 30;
export const MIN_CHUNK_INTERVAL_SECONDS = 5;
export const MAX_CHUNK_INTERVAL_SECONDS = 120;
export const DEFAULT_SUGGESTION_CONTEXT_LINES = 18;
export const DEFAULT_DETAIL_CONTEXT_LINES = 80;
export const MIN_CONTEXT_LINES = 3;
export const MAX_CONTEXT_LINES = 200;
export const SUGGESTION_SERVER_LOOKBACK_LINES = 36;
export const DETAIL_SERVER_LOOKBACK_LINES = 42;

export function clampChunkInterval(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_CHUNK_INTERVAL_SECONDS;
  }

  return Math.min(MAX_CHUNK_INTERVAL_SECONDS, Math.max(MIN_CHUNK_INTERVAL_SECONDS, Math.round(value)));
}

export function clampContextLines(value: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(MAX_CONTEXT_LINES, Math.max(MIN_CONTEXT_LINES, Math.round(value)));
}

export function resolvePrompt(value: string, fallback: string) {
  return value.trim() || fallback;
}

export function getSuggestionServerTranscriptLineLimit(recentLineLimit: number) {
  return Math.min(MAX_CONTEXT_LINES, Math.max(recentLineLimit, recentLineLimit + SUGGESTION_SERVER_LOOKBACK_LINES));
}

export function getDetailServerTranscriptLineLimit(recentLineLimit: number) {
  return Math.min(MAX_CONTEXT_LINES, Math.max(recentLineLimit, recentLineLimit + DETAIL_SERVER_LOOKBACK_LINES));
}

export function parseStoredSettings(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as StoredSettings;
  } catch {
    return null;
  }
}
