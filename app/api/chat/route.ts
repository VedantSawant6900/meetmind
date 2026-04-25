import { writeErrorLog, writeLog } from "../../../lib/server-logger";
import { DEFAULT_CHAT_PROMPT, DEFAULT_DETAIL_ANSWER_PROMPT } from "../../../lib/default-prompts";
import { fetchGroqWithRetry } from "../../../lib/groq-retry";
import { buildMeetingContext } from "../../../lib/meeting-context";

export const runtime = "nodejs";

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_CHAT_MODEL = "openai/gpt-oss-120b";
const DEFAULT_DETAIL_CONTEXT_LINES = 80;
const MIN_RECENT_CONTEXT_LINES = 6;
const MAX_RECENT_CONTEXT_LINES = 80;
const MAX_RECENT_TRANSCRIPT_CHARS = 8_000;
const MAX_OLDER_TRANSCRIPT_CHARS = 3_500;
const OLDER_RELEVANT_LINE_COUNT = 8;
const MAX_CHAT_HISTORY_CHARS = 4_000;
const CHAT_MAX_OUTPUT_TOKENS = 1_400;
const MAX_ANSWER_CHARS = 7_000;

type TranscriptLine = {
  time?: string;
  text?: string;
};

type ChatHistoryMessage = {
  who?: "user" | "ai";
  text?: string;
  label?: string;
};

type ChatRequest = {
  model?: string;
  systemPrompt?: string;
  contextWindowLines?: number;
  question?: string;
  suggestionType?: string;
  transcriptLines?: TranscriptLine[];
  chatMessages?: ChatHistoryMessage[];
};

type GroqChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string | null;
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
  };
};

type GroqMessage = {
  role: "system" | "user";
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

function trimToLastChars(value: string, maxChars: number) {
  return value.length > maxChars ? value.slice(-maxChars) : value;
}

function getContextLineCount(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_DETAIL_CONTEXT_LINES;
  }

  return Math.min(MAX_RECENT_CONTEXT_LINES, Math.max(MIN_RECENT_CONTEXT_LINES, Math.round(value)));
}

function getChatHistoryContext(messages: ChatHistoryMessage[]) {
  const context = messages
    .map((message) => {
      const text = typeof message.text === "string" ? message.text.trim() : "";

      if (!text) {
        return "";
      }

      const speaker = message.who === "ai" ? "Assistant" : "User";
      const label = typeof message.label === "string" && message.label.trim() ? ` (${message.label.trim()})` : "";
      return `${speaker}${label}: ${text}`;
    })
    .filter(Boolean)
    .join("\n");

  return trimToLastChars(context, MAX_CHAT_HISTORY_CHARS);
}

function getChatRelevanceQuery(question: string, suggestionType: string | undefined, messages: ChatHistoryMessage[]) {
  const recentChat = messages
    .slice(-6)
    .map((message) => (typeof message.text === "string" ? message.text.trim() : ""))
    .filter(Boolean)
    .join("\n");

  return [question, suggestionType, recentChat].filter(Boolean).join("\n");
}

function getClickedSuggestionInstructions(suggestionType: string) {
  switch (suggestionType) {
    case "question":
      return [
        "- Treat the clicked card as a question the user may ask.",
        '- Format it as: "Say this", "Why now", and optional "Follow-up".',
        "- In 'Say this', give one polished sentence the user can say verbatim.",
        "- Keep 'Why now' to one short reason tied to the live discussion.",
      ].join("\n");
    case "talking":
      return [
        "- Treat the clicked card as a point the user may say next.",
        '- Format it as: "Say this next" followed by 2-3 concise bullets.',
        "- Make each bullet sound natural enough to speak aloud.",
        "- Prefer crisp spoken phrasing over explanation.",
      ].join("\n");
    case "answer":
      return [
        "- Treat the clicked card as a likely answer to a recent question.",
        '- Format it as: "Answer", "Question asked", "Why", and "Transcript support / assumptions".',
        "- Give the answer directly in chat; do not tell the user to ask someone else unless the transcript truly lacks enough information.",
        "- In 'Question asked', quote or closely paraphrase the recent question and include its timestamp when available.",
        "- Use transcript context first, then general model knowledge for stable background facts.",
      ].join("\n");
    case "fact":
      return [
        "- Treat the clicked card as a verification item.",
        '- Format it as: "Verdict", "Why", and "Transcript support / uncertainty".',
        "- Give a direct verdict when possible: correct, incorrect, partially supported, or unclear.",
        "- Use transcript context first, then general model knowledge for stable facts.",
        "- Do not claim external verification or cite live sources; no web search is available.",
        "- If the claim is current, time-sensitive, or not knowable from transcript/model knowledge, say that clearly.",
      ].join("\n");
    case "clarifying":
      return [
        "- Treat the clicked card as a clarification request.",
        '- Format it as: "Plain-English explanation", "How it applies here", and optional "What to say next".',
        "- Explain the concept or distinction simply.",
        "- Tie it back to the meeting context and why it matters now.",
      ].join("\n");
    default:
      return "- Treat the clicked card as a live meeting assist. Be direct, grounded, and practical.";
  }
}

function getResponseInstructions(suggestionType?: string) {
  if (suggestionType) {
    return `Clicked suggestion response:
- Start with the most useful direct answer, verdict, or next move.
- Keep the structure tight and meeting-ready, not essay-like.
- Cite supporting transcript moments by timestamp when possible.
- Clearly separate what is supported by transcript from what is inferred or missing.
- Keep the answer concise enough to scan during a live conversation.
- For answer and fact-check cards, give the answer in chat instead of only suggesting what the user should ask next.
${getClickedSuggestionInstructions(suggestionType)}`;
  }

  return `Typed chat response:
- Answer the user's request directly first.
- Use transcript context and recent chat as evidence.
- Say exactly what information is missing when the transcript is insufficient.
- For summaries, action items, or "what should I say next?", use short scannable sections.
- Keep the answer concise; avoid long walls of text.`;
}

function normalizeAnswer(answer: string) {
  const normalized = answer
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim();

  if (normalized.length <= MAX_ANSWER_CHARS) {
    return normalized;
  }

  const clipped = normalized.slice(0, MAX_ANSWER_CHARS).replace(/\s+\S*$/, "").trim();
  const codeFenceCount = clipped.match(/```/g)?.length ?? 0;
  const closedFence = codeFenceCount % 2 === 1 ? `${clipped}\n\`\`\`` : clipped;

  return `${closedFence}\n\n_Response shortened to keep the live chat readable._`;
}

function buildMessages(
  question: string,
  meetingContext: ReturnType<typeof buildMeetingContext>,
  chatHistoryContext: string,
  systemPrompt: string,
  suggestionType?: string,
): GroqMessage[] {
  const suggestionTypeSection = suggestionType ?? "(none; this is a typed chat question)";

  return [
    {
      role: "system",
      content: systemPrompt,
    },
    {
      role: "user",
      content: `USER REQUEST
${question}

SUGGESTION TYPE
${suggestionTypeSection}

MEETING STATE / CUES
${meetingContext.cueSummary}

MOST RELEVANT RECENT TRANSCRIPT
${meetingContext.mostRecentTranscript || "(No transcript yet.)"}

OLDER SUPPORTING TRANSCRIPT
${meetingContext.olderRelevantTranscript || "(No older supporting transcript selected.)"}

RECENT CHAT HISTORY
${chatHistoryContext || "(No previous chat yet.)"}

RESPONSE INSTRUCTIONS
${getResponseInstructions(suggestionType)}`,
    },
  ];
}

export async function POST(request: Request) {
  const requestedAt = new Date();
  const apiKey = request.headers.get("x-groq-api-key")?.trim() || process.env.GROQ_API_KEY?.trim();

  if (!apiKey) {
    await writeErrorLog({
      event: "chat_rejected",
      reason: "missing_api_key",
      requestedAt: requestedAt.toISOString(),
    });
    return jsonError("Missing Groq API key.", 400);
  }

  let payload: ChatRequest;

  try {
    payload = (await request.json()) as ChatRequest;
  } catch {
    await writeErrorLog({
      event: "chat_rejected",
      reason: "invalid_json",
      requestedAt: requestedAt.toISOString(),
    });
    return jsonError("Expected JSON payload.", 400);
  }

  const question = typeof payload.question === "string" ? payload.question.trim() : "";

  if (!question) {
    await writeLog("chat", {
      event: "chat_rejected",
      reason: "empty_question",
      requestedAt: requestedAt.toISOString(),
    });
    return jsonError("Enter a question or click a suggestion first.", 400);
  }

  const requestedModel = typeof payload.model === "string" && payload.model.trim()
    ? payload.model.trim()
    : DEFAULT_CHAT_MODEL;
  const transcriptLines = Array.isArray(payload.transcriptLines) ? payload.transcriptLines : [];
  const chatMessages = Array.isArray(payload.chatMessages) ? payload.chatMessages : [];
  const chatHistoryContext = getChatHistoryContext(chatMessages);
  const suggestionType = typeof payload.suggestionType === "string" ? payload.suggestionType : undefined;
  const contextLineCount = getContextLineCount(payload.contextWindowLines);
  const meetingContext = buildMeetingContext(transcriptLines, {
    recentLineCount: contextLineCount,
    olderLineCount: OLDER_RELEVANT_LINE_COUNT,
    relevanceQuery: getChatRelevanceQuery(question, suggestionType, chatMessages),
    maxRecentChars: MAX_RECENT_TRANSCRIPT_CHARS,
    maxOlderChars: MAX_OLDER_TRANSCRIPT_CHARS,
  });
  const transcriptContextLength =
    meetingContext.mostRecentTranscript.length + meetingContext.olderRelevantTranscript.length;
  const defaultSystemPrompt = suggestionType ? DEFAULT_DETAIL_ANSWER_PROMPT : DEFAULT_CHAT_PROMPT;
  const systemPrompt = typeof payload.systemPrompt === "string" && payload.systemPrompt.trim()
    ? payload.systemPrompt.trim()
    : defaultSystemPrompt;

  await writeLog("chat", {
    event: "chat_request_started",
    requestedAt: requestedAt.toISOString(),
    model: requestedModel,
    suggestionType,
    questionLength: question.length,
    transcriptLineCount: transcriptLines.length,
    recentLineCount: meetingContext.recentLineCount,
    olderRelevantLineCount: meetingContext.olderRelevantLineCount,
    transcriptContextLength,
    contextWindowLines: contextLineCount,
    chatHistoryCount: chatMessages.length,
    chatHistoryContextLength: chatHistoryContext.length,
    promptLength: systemPrompt.length,
  });

  const groqResult = await fetchGroqWithRetry(GROQ_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: requestedModel,
      messages: buildMessages(question, meetingContext, chatHistoryContext, systemPrompt, suggestionType),
      temperature: 0.3,
      max_tokens: CHAT_MAX_OUTPUT_TOKENS,
    }),
  });
  const groqResponse = groqResult.response;
  const responseBody = groqResult.body;
  const completedAt = new Date();
  const durationMs = completedAt.getTime() - requestedAt.getTime();

  if (!groqResponse.ok) {
    const error = getGroqError(responseBody);

    await writeLog("groq", {
      event: "groq_chat_request_failed",
      requestedAt: requestedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      model: requestedModel,
      status: groqResponse.status,
      error,
      retryCount: groqResult.retryCount,
      retryDelayMs: groqResult.totalRetryDelayMs,
    });

    await writeErrorLog({
      event: "chat_failed",
      requestedAt: requestedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      model: requestedModel,
      status: groqResponse.status,
      error,
      retryCount: groqResult.retryCount,
      retryDelayMs: groqResult.totalRetryDelayMs,
    });

    return jsonError(error, groqResponse.status);
  }

  let answer = "";
  let finishReason: string | null = null;

  try {
    const completion = JSON.parse(responseBody) as GroqChatCompletionResponse;
    const choice = completion.choices?.[0];

    answer = normalizeAnswer(choice?.message?.content ?? "");
    finishReason = choice?.finish_reason ?? null;
  } catch {
    answer = "";
  }

  if (!answer) {
    await writeErrorLog({
      event: "chat_parse_failed",
      requestedAt: requestedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      model: requestedModel,
      responseLength: responseBody.length,
    });

    return jsonError("Chat model returned an empty answer.", 502);
  }

  await writeLog("groq", {
    event: "groq_chat_request_completed",
    requestedAt: requestedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    model: requestedModel,
    status: groqResponse.status,
    answerLength: answer.length,
    finishReason,
    maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
    retryCount: groqResult.retryCount,
    retryDelayMs: groqResult.totalRetryDelayMs,
  });

  await writeLog("chat", {
    event: "chat_completed",
    requestedAt: requestedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    model: requestedModel,
    suggestionType,
    questionLength: question.length,
    answerLength: answer.length,
    recentLineCount: meetingContext.recentLineCount,
    olderRelevantLineCount: meetingContext.olderRelevantLineCount,
    transcriptContextLength,
    contextWindowLines: contextLineCount,
    promptLength: systemPrompt.length,
    finishReason,
    maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
    retryCount: groqResult.retryCount,
    retryDelayMs: groqResult.totalRetryDelayMs,
  });

  return Response.json({ answer, finishReason });
}
