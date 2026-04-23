import { writeErrorLog, writeLog } from "../../../lib/server-logger";
import { DEFAULT_LIVE_SUGGESTION_PROMPT } from "../../../lib/default-prompts";
import { fetchGroqWithRetry } from "../../../lib/groq-retry";
import { buildMeetingContext } from "../../../lib/meeting-context";
import { parseSuggestions, SUGGESTION_PREVIEW_WORD_LIMIT } from "../../../lib/suggestion-output";
import { buildSuggestionPlan, type SuggestionPlan, type SuggestionType } from "../../../lib/suggestion-strategy";

export const runtime = "nodejs";

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_SUGGESTION_MODEL = "openai/gpt-oss-120b";
const DEFAULT_SUGGESTION_CONTEXT_LINES = 18;
const MIN_RECENT_CONTEXT_LINES = 6;
const MAX_RECENT_CONTEXT_LINES = 24;
const MAX_RECENT_TRANSCRIPT_CHARS = 5_500;
const MAX_OLDER_TRANSCRIPT_CHARS = 2_500;
const OLDER_RELEVANT_LINE_COUNT = 6;

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

function buildUserPayload(context: ReturnType<typeof buildMeetingContext>, plan: SuggestionPlan) {
  const slotPlan = plan.slots
    .map(
      (slot, index) =>
        `${index + 1}. ${slot.type}${slot.required ? " (required)" : " (preferred)"}: ${slot.reason}`,
    )
    .join("\n");

  return `TASK
Generate exactly 3 live suggestion previews for the user to see now. Optimize for the next 30-90 seconds of the meeting.

MEETING STATE / CUES
${context.cueSummary}

MEETING MODE
${plan.meetingModeLabel}

SUGGESTION SLOT PLAN
${slotPlan}

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
- Each card should help with the user's next turn: ask, say, answer, verify, or clarify.
- Use the transcript's actual nouns, owners, dates, numbers, and dependencies when possible.
- Do not use bland placeholders like "Ask for clarification", "Discuss timeline", or "Summarize next steps" unless tied to exact transcript details.
- Do not invent facts. Use fact only for claims or assumptions that should be verified.
- Follow the slot plan unless doing so would require inventing details.`;
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

function buildCorrectionMessages(
  userPayload: string,
  systemPrompt: string,
  rawContent: string,
  issue: string,
  plan: SuggestionPlan,
): GroqMessage[] {
  const requiredTypes = plan.requiredTypes.length > 0 ? plan.requiredTypes.join(", ") : "none";

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

Required type coverage for this meeting state: ${requiredTypes}
Plan summary: ${plan.shortSummary}

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
      temperature: 0.2,
      max_tokens: 450,
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
  const suggestionPlan = buildSuggestionPlan(meetingContext.cues);
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
    meetingMode: suggestionPlan.meetingMode,
    meetingModeLabel: suggestionPlan.meetingModeLabel,
    requiredTypes: suggestionPlan.requiredTypes,
    planSummary: suggestionPlan.shortSummary,
  });

  const userPayload = buildUserPayload(meetingContext, suggestionPlan);
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
    suggestions = parseSuggestions(rawContent, suggestionPlan);
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
      buildCorrectionMessages(userPayload, systemPrompt, rawContent, message, suggestionPlan),
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
      suggestions = parseSuggestions(rawContent, suggestionPlan);
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
    meetingMode: suggestionPlan.meetingMode,
    meetingModeLabel: suggestionPlan.meetingModeLabel,
    requiredTypes: suggestionPlan.requiredTypes,
    planSummary: suggestionPlan.shortSummary,
    suggestions,
  });

  return Response.json({
    suggestions,
    rationale: suggestionPlan.shortSummary,
    meetingMode: suggestionPlan.meetingMode,
    meetingModeLabel: suggestionPlan.meetingModeLabel,
    selectionPlan: suggestionPlan.slots,
  });
}
