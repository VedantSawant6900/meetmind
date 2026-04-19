import { writeErrorLog, writeLog } from "../../../lib/server-logger";

export const runtime = "nodejs";

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_SUGGESTION_MODEL = "openai/gpt-oss-120b";
const MAX_TRANSCRIPT_CHARS = 8_000;
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

function normalizeSuggestionType(value: unknown): SuggestionType {
  if (isSuggestionType(value)) {
    return value;
  }

  return "talking";
}

function normalizeSuggestionText(value: unknown) {
  if (typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim();
}

function getTranscriptContext(lines: TranscriptLine[]) {
  const context = lines
    .map((line) => {
      const text = typeof line.text === "string" ? line.text.trim() : "";

      if (!text) {
        return "";
      }

      const time = typeof line.time === "string" && line.time.trim() ? `[${line.time.trim()}] ` : "";
      return `${time}${text}`;
    })
    .filter(Boolean)
    .join("\n");

  return context.length > MAX_TRANSCRIPT_CHARS ? context.slice(-MAX_TRANSCRIPT_CHARS) : context;
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

function parseSuggestions(content: string) {
  const parsed = JSON.parse(extractJsonObject(content)) as {
    suggestions?: Array<{
      type?: unknown;
      text?: unknown;
    }>;
  };

  const suggestions =
    parsed.suggestions
      ?.map((suggestion) => ({
        type: normalizeSuggestionType(suggestion.type),
        text: normalizeSuggestionText(suggestion.text),
      }))
      .filter((suggestion): suggestion is Suggestion => suggestion.text.length > 0)
      .slice(0, 3) ?? [];

  if (suggestions.length !== 3) {
    throw new Error("Suggestion model did not return exactly 3 suggestions.");
  }

  return suggestions;
}

function buildMessages(transcriptContext: string) {
  return [
    {
      role: "system",
      content:
        "You are TwinMind, a live meeting copilot. Generate exactly 3 concise, immediately useful suggestions from the recent transcript. Use a helpful mix of question, talking, answer, fact, and clarifying suggestions. Each suggestion must be a standalone preview, under 28 words, specific to the transcript, and useful even before clicking. Use clarifying when the user needs a definition, distinction, missing context, or a clearer framing of what was said. Do not invent facts beyond the transcript unless framed as something to verify. Return only JSON.",
    },
    {
      role: "user",
      content: `Recent transcript:\n${transcriptContext}\n\nReturn this exact JSON shape:\n{"suggestions":[{"type":"question","text":"..."},{"type":"talking","text":"..."},{"type":"clarifying","text":"..."}]}\nAllowed type values: question, talking, answer, fact, clarifying.`,
    },
  ];
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
  const transcriptLines = Array.isArray(payload.transcriptLines) ? payload.transcriptLines : [];
  const transcriptContext = getTranscriptContext(transcriptLines);

  if (!transcriptContext) {
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
    transcriptContextLength: transcriptContext.length,
  });

  const groqResponse = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: requestedModel,
      messages: buildMessages(transcriptContext),
      temperature: 0.35,
      max_tokens: 700,
    }),
  });
  const responseBody = await groqResponse.text();
  const completedAt = new Date();
  const durationMs = completedAt.getTime() - requestedAt.getTime();

  if (!groqResponse.ok) {
    const error = getGroqError(responseBody);

    await writeLog("groq", {
      event: "groq_suggestions_request_failed",
      requestedAt: requestedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      model: requestedModel,
      status: groqResponse.status,
      error,
    });

    await writeErrorLog({
      event: "suggestions_failed",
      requestedAt: requestedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      model: requestedModel,
      status: groqResponse.status,
      error,
    });

    return jsonError(error, groqResponse.status);
  }

  let suggestions: Suggestion[];
  let rawContent = "";

  try {
    const completion = JSON.parse(responseBody) as GroqChatCompletionResponse;
    rawContent = completion.choices?.[0]?.message?.content ?? "";
    suggestions = parseSuggestions(rawContent);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not parse suggestions.";

    await writeErrorLog({
      event: "suggestions_parse_failed",
      requestedAt: requestedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      model: requestedModel,
      responseLength: responseBody.length,
      rawContent,
      error: message,
    });

    return jsonError(message, 502);
  }

  await writeLog("groq", {
    event: "groq_suggestions_request_completed",
    requestedAt: requestedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    model: requestedModel,
    status: groqResponse.status,
    suggestionCount: suggestions.length,
  });

  await writeLog("suggestions", {
    event: "suggestions_completed",
    requestedAt: requestedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    model: requestedModel,
    transcriptLineCount: transcriptLines.length,
    transcriptContextLength: transcriptContext.length,
    suggestions,
  });

  return Response.json({ suggestions });
}
