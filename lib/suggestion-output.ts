import type { Suggestion } from "./client-types";
import type { SuggestionPlan, SuggestionType } from "./suggestion-strategy";
import { VALID_SUGGESTION_TYPES } from "./suggestion-strategy";

export const SUGGESTION_PREVIEW_WORD_LIMIT = 24;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.72;

const TYPE_ALIASES: Record<string, SuggestionType> = {
  answer: "answer",
  clarification: "clarifying",
  clarifying: "clarifying",
  fact: "fact",
  "fact-check": "fact",
  factcheck: "fact",
  question: "question",
  talking: "talking",
  "talking-point": "talking",
};

const SUGGESTION_STOP_WORDS = new Set([
  "about",
  "after",
  "ask",
  "clarify",
  "discuss",
  "for",
  "from",
  "next",
  "question",
  "should",
  "summarize",
  "that",
  "the",
  "their",
  "this",
  "with",
]);

const VAGUE_SUGGESTION_PATTERNS = [
  /^ask for clarification$/,
  /^ask a clarifying question$/,
  /^clarify (?:the )?(?:issue|plan|timeline|requirements|next steps|details)$/,
  /^discuss (?:the )?(?:timeline|plan|next steps|risks|blockers|budget)$/,
  /^follow up(?: on this)?$/,
  /^review (?:the )?(?:plan|timeline|next steps)$/,
  /^summari[sz]e (?:the )?next steps$/,
  /^talk about (?:the )?(?:plan|timeline|next steps|issue)$/,
];

function isSuggestionType(value: unknown): value is SuggestionType {
  return typeof value === "string" && VALID_SUGGESTION_TYPES.includes(value as SuggestionType);
}

export function normalizeSuggestionType(value: unknown): SuggestionType | null {
  if (isSuggestionType(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  return TYPE_ALIASES[value.trim().toLowerCase().replace(/\s+/g, "-")] ?? null;
}

export function normalizeSuggestionText(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim();
}

export function extractJsonObject(content: string) {
  const trimmed = content.trim();

  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    return trimmed;
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Suggestion model did not return JSON.");
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
}

export function suggestionWordCount(text: string) {
  return text.split(/\s+/).filter(Boolean).length;
}

function normalizeForComparison(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length > 2 && !SUGGESTION_STOP_WORDS.has(word))
    .join(" ");
}

function textSimilarity(first: string, second: string) {
  const firstWords = new Set(normalizeForComparison(first).split(" ").filter(Boolean));
  const secondWords = new Set(normalizeForComparison(second).split(" ").filter(Boolean));

  if (firstWords.size === 0 || secondWords.size === 0) {
    return 0;
  }

  let sharedWords = 0;
  firstWords.forEach((word) => {
    if (secondWords.has(word)) {
      sharedWords += 1;
    }
  });

  return sharedWords / Math.max(firstWords.size, secondWords.size);
}

function sharedWordCount(first: string, second: string) {
  const firstWords = new Set(normalizeForComparison(first).split(" ").filter(Boolean));
  const secondWords = new Set(normalizeForComparison(second).split(" ").filter(Boolean));
  let sharedWords = 0;

  firstWords.forEach((word) => {
    if (secondWords.has(word)) {
      sharedWords += 1;
    }
  });

  return sharedWords;
}

export function isVagueSuggestion(text: string) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const words = normalized.split(" ").filter(Boolean);

  if (words.length < 3) {
    return true;
  }

  return VAGUE_SUGGESTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export function validateSuggestionQuality(suggestions: Suggestion[], plan: SuggestionPlan) {
  const issues: string[] = [];

  suggestions.forEach((suggestion, index) => {
    if (!suggestion.text) {
      issues.push(`Suggestion ${index + 1} has empty text.`);
    }

    if (suggestionWordCount(suggestion.text) > SUGGESTION_PREVIEW_WORD_LIMIT) {
      issues.push(`Suggestion ${index + 1} is over ${SUGGESTION_PREVIEW_WORD_LIMIT} words.`);
    }

    if (isVagueSuggestion(suggestion.text)) {
      issues.push(`Suggestion ${index + 1} is too generic: "${suggestion.text}".`);
    }
  });

  const missingRequiredTypes = plan.requiredTypes.filter(
    (requiredType) => !suggestions.some((suggestion) => suggestion.type === requiredType),
  );

  if (missingRequiredTypes.length > 0) {
    issues.push(`Missing required suggestion types for this meeting state: ${missingRequiredTypes.join(", ")}.`);
  }

  if (new Set(suggestions.map((suggestion) => suggestion.type)).size < 2) {
    issues.push("Use at least two different suggestion types.");
  }

  for (let firstIndex = 0; firstIndex < suggestions.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < suggestions.length; secondIndex += 1) {
      const firstText = normalizeForComparison(suggestions[firstIndex].text);
      const secondText = normalizeForComparison(suggestions[secondIndex].text);

      if (
        firstText &&
        secondText &&
        (firstText === secondText ||
          firstText.includes(secondText) ||
          secondText.includes(firstText) ||
          sharedWordCount(suggestions[firstIndex].text, suggestions[secondIndex].text) >= 3 ||
          textSimilarity(suggestions[firstIndex].text, suggestions[secondIndex].text) >= DUPLICATE_SIMILARITY_THRESHOLD)
      ) {
        issues.push(`Suggestions ${firstIndex + 1} and ${secondIndex + 1} are too similar.`);
      }
    }
  }

  return issues;
}

export function parseSuggestions(content: string, plan: SuggestionPlan) {
  const parsed = JSON.parse(extractJsonObject(content)) as {
    suggestions?: Array<{
      type?: unknown;
      text?: unknown;
    }>;
  };

  if (!Array.isArray(parsed.suggestions)) {
    throw new Error("Suggestion JSON must contain a suggestions array.");
  }

  const suggestions = parsed.suggestions.map((suggestion, index) => {
    const type = normalizeSuggestionType(suggestion.type);

    if (!type) {
      throw new Error(`Suggestion ${index + 1} has an invalid type.`);
    }

    return {
      type,
      text: normalizeSuggestionText(suggestion.text),
    };
  });

  if (suggestions.length !== 3) {
    throw new Error("Suggestion model did not return exactly 3 suggestions.");
  }

  const qualityIssues = validateSuggestionQuality(suggestions, plan);

  if (qualityIssues.length > 0) {
    throw new Error(`Suggestion output failed quality checks: ${qualityIssues.join(" ")}`);
  }

  return suggestions;
}
