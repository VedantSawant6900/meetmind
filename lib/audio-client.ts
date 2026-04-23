export const MIN_AUDIO_CHUNK_BYTES = 2_048;
export const MIN_AUDIO_CHUNK_MS = 1_000;
export const AUDIO_ACTIVITY_SAMPLE_MS = 200;
export const MIN_SPEECH_RMS = 0.012;
export const MIN_SPEECH_SAMPLES = 2;

export function transcriptionErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong while transcribing audio.";
}

export function microphoneErrorMessage(error: unknown) {
  if (error instanceof DOMException) {
    const browserError = `Browser returned ${error.name}${error.message ? `: ${error.message}` : ""}.`;

    switch (error.name) {
      case "NotAllowedError":
      case "SecurityError":
        return `${browserError} Microphone access is blocked. Check browser site settings and system microphone privacy settings, then fully restart the browser.`;
      case "NotFoundError":
      case "DevicesNotFoundError":
        return `${browserError} No microphone was found. Connect a mic or choose an input device in your system settings.`;
      case "NotReadableError":
      case "TrackStartError":
        return `${browserError} The microphone is unavailable. Close other apps using the mic, check system privacy settings, then try again.`;
      case "OverconstrainedError":
        return `${browserError} The selected microphone cannot satisfy the requested audio settings. Try another input device.`;
      case "AbortError":
        return `${browserError} The browser stopped the microphone request. Try clicking the mic again.`;
      default:
        return `${browserError} The browser could not start microphone recording.`;
    }
  }

  if (error instanceof Error && error.message.toLowerCase().includes("permission")) {
    return `Browser returned: ${error.message}. Microphone access is blocked. Check browser site settings and system microphone privacy settings, then fully restart the browser.`;
  }

  if (error instanceof Error) {
    return error.message;
  }

  return "The browser could not start microphone recording.";
}

export function getPreferredMimeType() {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }

  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

export async function getMicrophonePermissionState() {
  if (!navigator.permissions?.query) {
    return null;
  }

  try {
    const status = await navigator.permissions.query({ name: "microphone" as PermissionName });
    return status.state;
  } catch {
    return null;
  }
}

export function extensionForMimeType(mimeType: string) {
  if (mimeType.includes("mp4")) {
    return "mp4";
  }

  if (mimeType.includes("ogg")) {
    return "ogg";
  }

  return "webm";
}
