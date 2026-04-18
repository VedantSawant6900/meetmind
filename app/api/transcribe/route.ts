import { writeErrorLog, writeLog } from "../../../lib/server-logger";

export const runtime = "nodejs";

const GROQ_TRANSCRIPTION_URL = "https://api.groq.com/openai/v1/audio/transcriptions";
const DEFAULT_TRANSCRIPTION_MODEL = "whisper-large-v3";

type GroqTranscriptionResponse = {
  text?: string;
  error?: {
    message?: string;
  };
};

function jsonError(message: string, status: number) {
  return Response.json({ error: message }, { status });
}

function getGroqError(body: string) {
  try {
    const parsed = JSON.parse(body) as GroqTranscriptionResponse;
    return parsed.error?.message ?? body;
  } catch {
    return body;
  }
}

export async function POST(request: Request) {
  const requestedAt = new Date();
  const apiKey = request.headers.get("x-groq-api-key")?.trim() || process.env.GROQ_API_KEY?.trim();

  if (!apiKey) {
    await writeErrorLog({
      event: "transcription_rejected",
      reason: "missing_api_key",
      requestedAt: requestedAt.toISOString(),
    });
    return jsonError("Missing Groq API key.", 400);
  }

  let incomingForm: FormData;

  try {
    incomingForm = await request.formData();
  } catch {
    await writeErrorLog({
      event: "transcription_rejected",
      reason: "invalid_form_data",
      requestedAt: requestedAt.toISOString(),
    });
    return jsonError("Expected multipart form data with an audio file.", 400);
  }

  const audio = incomingForm.get("audio");
  const model = incomingForm.get("model");
  const requestedModel = typeof model === "string" && model.trim() ? model.trim() : DEFAULT_TRANSCRIPTION_MODEL;

  if (!(audio instanceof File)) {
    await writeErrorLog({
      event: "transcription_rejected",
      reason: "missing_audio_file",
      requestedAt: requestedAt.toISOString(),
      model: requestedModel,
    });
    return jsonError("Missing audio file.", 400);
  }

  if (audio.size === 0) {
    await writeErrorLog({
      event: "transcription_rejected",
      reason: "empty_audio_file",
      requestedAt: requestedAt.toISOString(),
      model: requestedModel,
      audio: {
        name: audio.name || "meeting-chunk",
        type: audio.type || "unknown",
        size: audio.size,
      },
    });
    return jsonError("Audio file is empty.", 400);
  }

  const audioLog = {
    name: audio.name || "meeting-chunk",
    type: audio.type || "unknown",
    size: audio.size,
  };

  await writeLog("audio", {
    event: "audio_chunk_received",
    requestedAt: requestedAt.toISOString(),
    model: requestedModel,
    audio: audioLog,
  });

  const groqForm = new FormData();
  groqForm.append("file", audio, audio.name || "meeting-chunk.webm");
  groqForm.append("model", requestedModel);
  groqForm.append("response_format", "json");
  groqForm.append("temperature", "0");

  await writeLog("groq", {
    event: "groq_transcription_request_started",
    requestedAt: requestedAt.toISOString(),
    model: requestedModel,
    audio: audioLog,
  });

  const groqResponse = await fetch(GROQ_TRANSCRIPTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: groqForm,
  });
  const responseBody = await groqResponse.text();
  const completedAt = new Date();
  const durationMs = completedAt.getTime() - requestedAt.getTime();

  if (!groqResponse.ok) {
    const details = `${audio.name || "meeting-chunk"} (${audio.type || "unknown type"}, ${audio.size} bytes)`;
    const error = getGroqError(responseBody);

    await writeLog("groq", {
      event: "groq_transcription_request_failed",
      requestedAt: requestedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      model: requestedModel,
      status: groqResponse.status,
      audio: audioLog,
    });

    await writeErrorLog({
      event: "transcription_failed",
      requestedAt: requestedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs,
      model: requestedModel,
      status: groqResponse.status,
      audio: audioLog,
      error,
    });

    return jsonError(`${error} Received ${details}.`, groqResponse.status);
  }

  const transcription = JSON.parse(responseBody) as GroqTranscriptionResponse;
  const text = transcription.text?.trim() ?? "";

  await writeLog("groq", {
    event: "groq_transcription_request_completed",
    requestedAt: requestedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    model: requestedModel,
    status: groqResponse.status,
    audio: audioLog,
    textLength: text.length,
  });

  await writeLog("transcription", {
    event: "transcription_completed",
    requestedAt: requestedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs,
    model: requestedModel,
    status: groqResponse.status,
    audio: audioLog,
    textLength: text.length,
    text,
  });

  return Response.json({ text });
}
