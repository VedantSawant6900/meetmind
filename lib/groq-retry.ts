const DEFAULT_MAX_RETRIES = 3;
const MIN_RETRY_DELAY_MS = 250;
const MAX_RETRY_DELAY_MS = 5_000;

type GroqRetryOptions = {
  maxRetries?: number;
};

export type GroqFetchResult = {
  response: Response;
  body: string;
  retryCount: number;
  totalRetryDelayMs: number;
};

function sleep(delayMs: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, delayMs));
}

function clampDelay(delayMs: number) {
  return Math.min(MAX_RETRY_DELAY_MS, Math.max(MIN_RETRY_DELAY_MS, Math.round(delayMs)));
}

function getRetryAfterHeaderDelayMs(response: Response) {
  const retryAfter = response.headers.get("retry-after");

  if (!retryAfter) {
    return null;
  }

  const numericSeconds = Number(retryAfter);

  if (Number.isFinite(numericSeconds)) {
    return numericSeconds * 1000;
  }

  const retryAt = Date.parse(retryAfter);

  if (Number.isFinite(retryAt)) {
    return retryAt - Date.now();
  }

  return null;
}

function getBodyHintDelayMs(body: string) {
  const msMatch = body.match(/try again in\s+(\d+(?:\.\d+)?)\s*ms/i);

  if (msMatch?.[1]) {
    return Number(msMatch[1]);
  }

  const secondsMatch = body.match(/try again in\s+(\d+(?:\.\d+)?)\s*s(?:econds?)?/i);

  if (secondsMatch?.[1]) {
    return Number(secondsMatch[1]) * 1000;
  }

  return null;
}

function getRetryDelayMs(response: Response, body: string, attempt: number) {
  const explicitDelay = getRetryAfterHeaderDelayMs(response) ?? getBodyHintDelayMs(body);

  if (typeof explicitDelay === "number" && Number.isFinite(explicitDelay)) {
    return clampDelay(explicitDelay + 100);
  }

  return clampDelay(500 * 2 ** attempt);
}

export async function fetchGroqWithRetry(
  url: string,
  init: RequestInit,
  options: GroqRetryOptions = {},
): Promise<GroqFetchResult> {
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  let retryCount = 0;
  let totalRetryDelayMs = 0;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, init);
    const body = await response.text();

    if (response.status !== 429 || attempt >= maxRetries) {
      return {
        response,
        body,
        retryCount,
        totalRetryDelayMs,
      };
    }

    const retryDelayMs = getRetryDelayMs(response, body, attempt);

    retryCount += 1;
    totalRetryDelayMs += retryDelayMs;
    await sleep(retryDelayMs);
  }
}
