import { writeErrorLog, writeLog } from "../../../lib/server-logger";

export const runtime = "nodejs";

const GROQ_CHAT_COMPLETIONS_URL = "https://api.groq.com/openai/v1/chat/completions";
const DEFAULT_CHAT_MODEL = "openai/gpt-oss-120b";
const MAX_TRANSCRIPT_CHARS = 12_000;
const MAX_CHAT_HISTORY_CHARS = 5_000;
const CHAT_MAX_OUTPUT_TOKENS = 2_500;

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

  return trimToLastChars(context, MAX_TRANSCRIPT_CHARS);
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

function buildMessages(question: string, transcriptContext: string, chatHistoryContext: string, suggestionType?: string) {
  const source = suggestionType ? `Suggestion type clicked: ${suggestionType}` : "Direct user question";

  return [
    {
      role: "system",
      content:
        "You are TwinMind, a live meeting copilot. Provide a complete, useful answer for the right-side chat panel. Ground the answer in the transcript and chat history. If context is thin, say what is missing and give the best next question or framing. Be concise, concrete, and actionable. Use bullets or a small table when they improve readability. Keep the answer complete within the response budget; summarize instead of ending mid-step. Do not fabricate facts.",
    },
    {
      role: "user",
      content: `${source}\n\nRecent transcript:\n${transcriptContext || "(No transcript yet.)"}\n\nChat history:\n${chatHistoryContext || "(No previous chat yet.)"}\n\nUser request:\n${question}`,
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
  const transcriptContext = getTranscriptContext(transcriptLines);
  const chatHistoryContext = getChatHistoryContext(chatMessages);
  const suggestionType = typeof payload.suggestionType === "string" ? payload.suggestionType : undefined;

  await writeLog("chat", {
    event: "chat_request_started",
    requestedAt: requestedAt.toISOString(),
    model: requestedModel,
    suggestionType,
    questionLength: question.length,
    transcriptLineCount: transcriptLines.length,
    transcriptContextLength: transcriptContext.length,
    chatHistoryCount: chatMessages.length,
    chatHistoryContextLength: chatHistoryContext.length,
  });

  const groqResponse = await fetch(GROQ_CHAT_COMPLETIONS_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: requestedModel,
      messages: buildMessages(question, transcriptContext, chatHistoryContext, suggestionType),
      temperature: 0.3,
      max_tokens: CHAT_MAX_OUTPUT_TOKENS,
    }),
  });
  const responseBody = await groqResponse.text();
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
    });

    await writeErrorLog({
      event: "chat_failed",
      requestedAt: requestedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      model: requestedModel,
      status: groqResponse.status,
      error,
    });

    return jsonError(error, groqResponse.status);
  }

  let answer = "";
  let finishReason: string | null = null;

  try {
    const completion = JSON.parse(responseBody) as GroqChatCompletionResponse;
    const choice = completion.choices?.[0];

    answer = choice?.message?.content?.trim() ?? "";
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
    finishReason,
    maxOutputTokens: CHAT_MAX_OUTPUT_TOKENS,
  });

  return Response.json({ answer, finishReason });
}
