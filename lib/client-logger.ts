export type ClientLogCategory = "app" | "client" | "audio" | "transcription" | "suggestions" | "chat" | "groq" | "errors";

export function emitClientLog(category: ClientLogCategory, event: string, data: Record<string, unknown> = {}) {
  if (typeof window === "undefined") {
    return;
  }

  void fetch("/api/logs", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ category, event, data }),
    keepalive: true,
  }).catch(() => undefined);
}
