import { writeErrorLog, writeLog } from "../../../lib/server-logger";
import { DEFAULT_LIVE_SUGGESTION_PROMPT } from "../../../lib/default-prompts";
import { fetchGroqWithRetry } from "../../../lib/groq-retry";
import { buildMeetingContext } from "../../../lib/meeting-context";

export const runtime = "nodejs";

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_SUGGESTION_MODEL = "openai/gpt-oss-120b";
const DEFAULT_SUGGESTION_CONTEXT_LINES = 18;
const MIN_RECENT_CONTEXT_LINES = 6;
const MAX_RECENT_CONTEXT_LINES = 24;
const MAX_RECENT_TRANSCRIPT_CHARS = 5_500;
const MAX_OLDER_TRANSCRIPT_CHARS = 2_500;
const OLDER_RELEVANT_LINE_COUNT = 6;
const SUGGESTION_PREVIEW_WORD_LIMIT = 24;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.72;
const VALID_SUGGESTION_TYPES = ["question", "talking", "answer", "fact", "clarifying"] as const;

type SuggestionType = (typeof VALID_SUGGESTION_TYPES)[number];

type TranscriptLine = {
  time?: string;
  text?: string;
};

type Suggestion = {
  type: SuggestionType;
  text: string;
};

type SuggestionsRequest = {
  model?: string;
  prompt?: string;
  contextWindowLines?: number;
  transcriptLines?: TranscriptLine[];
};

type GroqChatCompletionResponse = {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

type GroqMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

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

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function getGroqError(body: string) {
  try {
    const parsed = JSON.parse(body) as GroqChatCompletionResponse;
    return parsed.error?.message ?? body;
  } catch {
    return body;
  }
}

function isSuggestionType(value: unknown): value is SuggestionType {
  return typeof value === "string" && VALID_SUGGESTION_TYPES.includes(value as SuggestionType);
}

function normalizeSuggestionType(value: unknown): SuggestionType | null {
  if (isSuggestionType(value)) {
    return value;
  }

  if (typeof value !== "string") {
    return null;
  }

  return TYPE_ALIASES[value.trim().toLowerCase().replace(/\s+/g, "-")] ?? null;
}

function normalizeSuggestionText(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim();
}

function getContextLineCount(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_SUGGESTION_CONTEXT_LINES;
  }

  return Math.min(MAX_RECENT_CONTEXT_LINES, Math.max(MIN_RECENT_CONTEXT_LINES, Math.round(value)));
}

function getSuggestionRelevanceQuery(lines: TranscriptLine[]) {
  return lines
    .slice(-8)
    .map((line) => (typeof line.text === "string" ? line.text.trim() : ""))
    .filter(Boolean)
    .join("\n");
}

function extractJsonObject(content: string) {
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

function suggestionWordCount(text: string) {
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

function isVagueSuggestion(text: string) {
  const normalized = text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
  const words = normalized.split(" ").filter(Boolean);

  if (words.length < 3) {
    return true;
  }

  return VAGUE_SUGGESTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

function validateSuggestionQuality(suggestions: Suggestion[]) {
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
          textSimilarity(suggestions[firstIndex].text, suggestions[secondIndex].text) >= DUPLICATE_SIMILARITY_THRESHOLD)
      ) {
        issues.push(`Suggestions ${firstIndex + 1} and ${secondIndex + 1} are too similar.`);
      }
    }
  }

  return issues;
}

function parseSuggestions(content: string) {
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

  const qualityIssues = validateSuggestionQuality(suggestions);

  if (qualityIssues.length > 0) {
    throw new Error(`Suggestion output failed quality checks: ${qualityIssues.join(" ")}`);
  }

  return suggestions;
}

function buildUserPayload(context: ReturnType<typeof buildMeetingContext>) {
  return `TASK
Generate exactly 3 live suggestion previews for the user to see now. Optimize for the next 30-90 seconds of the meeting.

MEETING STATE / CUES
${context.cueSummary}

MOST RECENT TRANSCRIPT
${context.mostRecentTranscript || "(No recent transcript selected.)"}

EARLIER RELEVANT CONTEXT
${context.olderRelevantTranscript || "(No older relevant transcript selected.)"}

OUTPUT RULES
- Return only valid JSON. No markdown, no prose outside JSON.
- Return exactly 3 suggestions.
- Allowed type values: question, talking, answer, fact, clarifying.
- Each text must be under ${SUGGESTION_PREVIEW_WORD_LIMIT} words.
- Make the three cards specific, useful before click, and different in purpose.
- Do not use bland placeholders like "Ask for clarification", "Discuss timeline", or "Summarize next steps" unless tied to exact transcript details.
- Do not invent facts. Use fact only for claims or assumptions that should be verified.`;
}

function buildMessages(userPayload: string, systemPrompt: string): GroqMessage[] {
  return [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "user",
      content: userPayload,
    },
  ];
}

function buildCorrectionMessages(userPayload: string, systemPrompt: string, rawContent: string, issue: string): GroqMessage[] {
  return [
    ...buildMessages(userPayload, systemPrompt),
    {
      role: "assistant",
      content: rawContent || "(empty response)",
    },
    {
      role: "user",
      content: `The previous response failed validation: ${issue}

Return a corrected response now. It must be ONLY valid JSON in this exact shape:
{"suggestions":[{"type":"question","text":"..."},{"type":"talking","text":"..."},{"type":"fact","text":"..."}]}

Keep exactly 3 suggestions, use at least two different types, keep every text under ${SUGGESTION_PREVIEW_WORD_LIMIT} words, and avoid duplicate or generic angles.`,
    },
  ];
}

async function requestSuggestions(apiKey: string, model: string, messages: GroqMessage[]) {
  return fetchGroqWithRetry(GROQ_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.35,
      max_tokens: 700,
    }),
  });
}

function getCompletionContent(responseBody: string) {
  const completion = JSON.parse(responseBody) as GroqChatCompletionResponse;
  return completion.choices?.[0]?.message?.content ?? "";
}

export async function POST(request: Request) {
  const requestedAt = new Date();
  const apiKey = request.headers.get("x-groq-api-key")?.trim() || process.env.GROQ_API_KEY?.trim();

  if (!apiKey) {
    await writeErrorLog({
      event: "suggestions_rejected",
      reason: "missing_api_key",
      requestedAt: requestedAt.toISOString(),
    });
    return jsonError("Missing Groq API key.", 400);
  }

  let payload: SuggestionsRequest;

  try {
    payload = (await request.json()) as SuggestionsRequest;
  } catch {
    await writeErrorLog({
      event: "suggestions_rejected",
      reason: "invalid_json",
      requestedAt: requestedAt.toISOString(),
    });
    return jsonError("Expected JSON payload.", 400);
  }

  const requestedModel = typeof payload.model === "string" && payload.model.trim()
    ? payload.model.trim()
    : DEFAULT_SUGGESTION_MODEL;
  const systemPrompt = typeof payload.prompt === "string" && payload.prompt.trim()
    ? payload.prompt.trim()
    : DEFAULT_LIVE_SUGGESTION_PROMPT;
  const transcriptLines = Array.isArray(payload.transcriptLines) ? payload.transcriptLines : [];
  const contextLineCount = getContextLineCount(payload.contextWindowLines);
  const meetingContext = buildMeetingContext(transcriptLines, {
    recentLineCount: contextLineCount,
    olderLineCount: OLDER_RELEVANT_LINE_COUNT,
    relevanceQuery: getSuggestionRelevanceQuery(transcriptLines),
    maxRecentChars: MAX_RECENT_TRANSCRIPT_CHARS,
    maxOlderChars: MAX_OLDER_TRANSCRIPT_CHARS,
  });
  const transcriptContextLength =
    meetingContext.mostRecentTranscript.length + meetingContext.olderRelevantTranscript.length;

  if (!meetingContext.mostRecentTranscript) {
    await writeLog("suggestions", {
      event: "suggestions_rejected",
      reason: "empty_transcript",
      requestedAt: requestedAt.toISOString(),
      model: requestedModel,
    });
    return jsonError("Add transcript text before generating suggestions.", 400);
  }

  await writeLog("suggestions", {
    event: "suggestions_request_started",
    requestedAt: requestedAt.toISOString(),
    model: requestedModel,
    transcriptLineCount: transcriptLines.length,
    recentLineCount: meetingContext.recentLineCount,
    olderRelevantLineCount: meetingContext.olderRelevantLineCount,
    transcriptContextLength,
    contextWindowLines: contextLineCount,
    promptLength: systemPrompt.length,
  });

  const userPayload = buildUserPayload(meetingContext);
  let groqResult = await requestSuggestions(apiKey, requestedModel, buildMessages(userPayload, systemPrompt));
  let groqResponse = groqResult.response;
  let responseBody = groqResult.body;
  let correctionUsed = false;
  let transportRetryCount = groqResult.retryCount;
  let transportRetryDelayMs = groqResult.totalRetryDelayMs;

  if (!groqResponse.ok) {
    const error = getGroqError(responseBody);
    const failedAt = new Date();
    const durationMs = failedAt.getTime() - requestedAt.getTime();

    await writeLog("groq", {
      event: "groq_suggestions_request_failed",
      requestedAt: requestedAt.toISOString(),
      completedAt: failedAt.toISOString(),
      durationMs,
      model: requestedModel,
      status: groqResponse.status,
      error,
      retryCount: transportRetryCount,
      retryDelayMs: transportRetryDelayMs,
    });

    await writeErrorLog({
      event: "suggestions_failed",
      requestedAt: requestedAt.toISOString(),
      completedAt: failedAt.toISOString(),
      durationMs,
      model: requestedModel,
      status: groqResponse.status,
      error,
      retryCount: transportRetryCount,
      retryDelayMs: transportRetryDelayMs,
    });

    return jsonError(error, groqResponse.status);
  }

  let suggestions: Suggestion[];
  let rawContent = "";

  try {
    rawContent = getCompletionContent(responseBody);
    suggestions = parseSuggestions(rawContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not parse suggestions.";
    const correctionStartedAt = new Date();

    await writeLog("suggestions", {
      event: "suggestions_correction_started",
      requestedAt: requestedAt.toISOString(),
      correctionStartedAt: correctionStartedAt.toISOString(),
      model: requestedModel,
      reason: message,
      responseLength: responseBody.length,
    });

    groqResult = await requestSuggestions(
      apiKey,
      requestedModel,
      buildCorrectionMessages(userPayload, systemPrompt, rawContent, message),
    );
    groqResponse = groqResult.response;
    responseBody = groqResult.body;
    correctionUsed = true;
    transportRetryCount += groqResult.retryCount;
    transportRetryDelayMs += groqResult.totalRetryDelayMs;

    if (!groqResponse.ok) {
      const groqError = getGroqError(responseBody);
      const failedAt = new Date();
      const durationMs = failedAt.getTime() - requestedAt.getTime();

      await writeLog("groq", {
        event: "groq_suggestions_correction_failed",
        requestedAt: requestedAt.toISOString(),
        completedAt: failedAt.toISOString(),
        durationMs,
        model: requestedModel,
        status: groqResponse.status,
        error: groqError,
        retryCount: transportRetryCount,
        retryDelayMs: transportRetryDelayMs,
      });

      await writeErrorLog({
        event: "suggestions_failed",
        requestedAt: requestedAt.toISOString(),
        completedAt: failedAt.toISOString(),
        durationMs,
        model: requestedModel,
        status: groqResponse.status,
        error: groqError,
        retryCount: transportRetryCount,
        retryDelayMs: transportRetryDelayMs,
      });

      return jsonError(groqError, groqResponse.status);
    }

    try {
      rawContent = getCompletionContent(responseBody);
      suggestions = parseSuggestions(rawContent);
    } catch (correctionError) {
      const completedAt = new Date();
      const durationMs = completedAt.getTime() - requestedAt.getTime();
      const correctionMessage =
        correctionError instanceof Error ? correctionError.message : "Could not parse corrected suggestions.";

      await writeErrorLog({
        event: "suggestions_parse_failed",
        requestedAt: requestedAt.toISOString(),
        completedAt: completedAt.toISOString(),
        durationMs,
        model: requestedModel,
        responseLength: responseBody.length,
        rawContent,
        firstError: message,
        error: correctionMessage,
        correctionUsed,
      });

      return jsonError(correctionMessage, 502);
    }
  }

  const completedAt = new Date();
  const durationMs = completedAt.getTime() - requestedAt.getTime();

  await writeLog("groq", {
    event: "groq_suggestions_request_completed",
    requestedAt: requestedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    model: requestedModel,
    status: groqResponse.status,
    suggestionCount: suggestions.length,
    correctionUsed,
    retryCount: transportRetryCount,
    retryDelayMs: transportRetryDelayMs,
  });

  await writeLog("suggestions", {
    event: "suggestions_completed",
    requestedAt: requestedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    model: requestedModel,
    transcriptLineCount: transcriptLines.length,
    recentLineCount: meetingContext.recentLineCount,
    olderRelevantLineCount: meetingContext.olderRelevantLineCount,
    transcriptContextLength,
    contextWindowLines: contextLineCount,
    promptLength: systemPrompt.length,
    correctionUsed,
    retryCount: transportRetryCount,
    retryDelayMs: transportRetryDelayMs,
    suggestions,
  });

  return Response.json({ suggestions });
}
