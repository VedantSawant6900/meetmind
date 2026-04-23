import type { SuggestionType } from "./suggestion-strategy";

export function timestamp(date = new Date()) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function labelFor(type: SuggestionType) {
  return {
    question: "Question to ask",
    talking: "Talking point",
    answer: "Answer",
    fact: "Fact-check",
    clarifying: "Clarifying info",
  }[type];
}

export function formatRelativeAge(isoTimestamp: string, nowMs: number) {
  const timestampMs = new Date(isoTimestamp).getTime();

  if (Number.isNaN(timestampMs)) {
    return "just now";
  }

  const diffSeconds = Math.max(0, Math.round((nowMs - timestampMs) / 1000));

  if (diffSeconds < 5) {
    return "just now";
  }

  if (diffSeconds < 60) {
    return `${diffSeconds}s ago`;
  }

  const diffMinutes = Math.floor(diffSeconds / 60);

  if (diffMinutes < 60) {
    return `${diffMinutes}m ago`;
  }

  const diffHours = Math.floor(diffMinutes / 60);
  return `${diffHours}h ago`;
}

export function truncatePreview(text: string, maxChars = 64) {
  const normalized = text.trim();

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
