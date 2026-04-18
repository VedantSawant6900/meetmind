import { LOG_GOALS, type LogCategory, writeLog } from "../../../lib/server-logger";

export const runtime = "nodejs";

type ClientLogPayload = {
  category?: LogCategory;
  event?: string;
  data?: Record<string, unknown>;
};

function isLogCategory(value: unknown): value is LogCategory {
  return typeof value === "string" && value in LOG_GOALS;
}

function sanitizeData(data: unknown) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return {};
  }

  const sanitized: Record<string, unknown> = {};

  Object.entries(data as Record<string, unknown>).forEach(([key, value]) => {
    if (/key|token|secret|authorization/i.test(key)) {
      sanitized[key] = "[redacted]";
      return;
    }

    sanitized[key] = value;
  });

  return sanitized;
}

export async function POST(request: Request) {
  let payload: ClientLogPayload;

  try {
    payload = (await request.json()) as ClientLogPayload;
  } catch {
    return Response.json({ error: "Expected JSON log payload." }, { status: 400 });
  }

  const category = isLogCategory(payload.category) ? payload.category : "client";
  const event = typeof payload.event === "string" && payload.event.trim() ? payload.event.trim() : "client_event";

  await writeLog(category, {
    event,
    source: "browser",
    data: sanitizeData(payload.data),
  });

  return Response.json({ ok: true });
}
