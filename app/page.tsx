"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

const SETTINGS_STORAGE_KEY = "meetmind.settings";
const LEGACY_GROQ_KEY_STORAGE_KEY = "meetmind.groqApiKey";
const DEFAULT_WHISPER_MODEL = "whisper-large-v3";
const DEFAULT_SUGGESTION_MODEL = "openai/gpt-oss-120b";
const DEFAULT_CHUNK_INTERVAL_SECONDS = 10;
const MIN_CHUNK_INTERVAL_SECONDS = 5;
const MAX_CHUNK_INTERVAL_SECONDS = 120;
const MIN_AUDIO_CHUNK_BYTES = 2_048;
const MIN_AUDIO_CHUNK_MS = 1_000;
const AUDIO_ACTIVITY_SAMPLE_MS = 200;
const MIN_SPEECH_RMS = 0.012;
const MIN_SPEECH_SAMPLES = 2;
const DUPLICATE_SIMILARITY_THRESHOLD = 0.86;
const WEAK_AUDIO_RMS = 0.03;
const WEAK_SPEECH_SAMPLE_RATIO = 0.18;
const HIGH_NO_SPEECH_PROBABILITY = 0.55;
const LOW_AVG_LOGPROB = -1.15;
const VERY_LOW_AVG_LOGPROB = -2;
const LOW_CONFIDENCE_FRAGMENT_AVG_LOGPROB = -0.85;
const LOW_CONFIDENCE_FRAGMENT_COMPRESSION_RATIO = 0.35;
const WEAK_ARTIFACT_NO_SPEECH_PROBABILITY = 0.15;

const suggestionBatches = [
  [
    { type: "question", text: "What's your current p99 latency on websocket round-trips?" },
    { type: "talking", text: "Discord's sharding model: 2,500 guilds per shard, ~150k concurrent users each." },
    { type: "fact", text: "Fact-check: Slack's 2024 outage was a config push, not capacity — different problem." },
  ],
  [
    { type: "answer", text: "Managed Kafka (MSK) at ~1M events/sec runs roughly $8-15k/mo on AWS." },
    { type: "question", text: "Have you considered NATS JetStream as a lighter-weight alternative?" },
    { type: "talking", text: "Sharding by user cohort works if cohorts are stable; bad for viral spikes." },
  ],
  [
    { type: "answer", text: "For state-in-memory issues: Redis Cluster + consistent hashing handles ~1M ops/sec/node." },
    { type: "fact", text: "Discord publicly serves ~15M concurrent voice users on Elixir/Erlang infra." },
    { type: "question", text: "What's your read/write ratio? That changes the sharding strategy significantly." },
  ],
] as const;

type SuggestionType = (typeof suggestionBatches)[number][number]["type"];

type TranscriptLine = {
  id: number;
  time: string;
  text: string;
  startedAt: string;
  endedAt: string;
};

type RenderedBatch = {
  id: number;
  batchNumber: number;
  time: string;
  suggestions: readonly {
    type: SuggestionType;
    text: string;
  }[];
};

type ChatMessage = {
  id: number;
  who: "user" | "ai";
  text: string;
  label?: string;
};

type TranscriptionResponse = {
  text?: string;
  error?: string;
  quality?: TranscriptionQuality;
};

type TranscriptionQuality = {
  segmentCount?: number;
  noSpeechProbability?: number | null;
  avgLogprob?: number | null;
  maxCompressionRatio?: number | null;
};

type AudioChunkStats = {
  audioType: string;
  audioSize: number;
  durationMs: number;
  speechSamples: number;
  totalSamples: number;
  maxRms: number;
};

type TranscriptFilterContext = {
  audioStats?: AudioChunkStats;
  quality?: TranscriptionQuality;
};

type StoredSettings = {
  groqApiKey?: string;
  whisperModel?: string;
  suggestionModel?: string;
  chunkIntervalSeconds?: number;
};

type ClientLogCategory = "app" | "client" | "audio" | "transcription" | "groq" | "errors";

function emitClientLog(category: ClientLogCategory, event: string, data: Record<string, unknown> = {}) {
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

function timestamp(date = new Date()) {
  return date.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function labelFor(type: SuggestionType) {
  return {
    question: "Question to ask",
    talking: "Talking point",
    answer: "Answer",
    fact: "Fact-check",
  }[type];
}

function simulateAnswer(question: string) {
  return `Detailed answer to: "${question}"\n\nThis is where a separate, longer-form prompt runs against the chat model with full transcript context. Streamed response ideally. Candidates choose model + prompt strategy — we evaluate quality, latency, relevance.`;
}

function transcriptionErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Something went wrong while transcribing audio.";
}

function microphoneErrorMessage(error: unknown) {
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

function getPreferredMimeType() {
  if (typeof MediaRecorder === "undefined") {
    return undefined;
  }

  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  return candidates.find((mimeType) => MediaRecorder.isTypeSupported(mimeType));
}

async function getMicrophonePermissionState() {
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

function extensionForMimeType(mimeType: string) {
  if (mimeType.includes("mp4")) {
    return "mp4";
  }

  if (mimeType.includes("ogg")) {
    return "ogg";
  }

  return "webm";
}

function clampChunkInterval(value: number) {
  if (!Number.isFinite(value)) {
    return DEFAULT_CHUNK_INTERVAL_SECONDS;
  }

  return Math.min(MAX_CHUNK_INTERVAL_SECONDS, Math.max(MIN_CHUNK_INTERVAL_SECONDS, Math.round(value)));
}

function parseStoredSettings(value: string | null) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as StoredSettings;
  } catch {
    return null;
  }
}

function normalizeTranscriptText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textSimilarity(first: string, second: string) {
  const firstWords = new Set(normalizeTranscriptText(first).split(" ").filter(Boolean));
  const secondWords = new Set(normalizeTranscriptText(second).split(" ").filter(Boolean));

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

function isLikelyWhisperOutroArtifact(text: string) {
  const normalized = normalizeTranscriptText(text);
  return /^(thank you|thank you for watching|you for watching|thanks for watching|thanks)$/.test(normalized);
}

function isLikelySubtitleArtifact(text: string) {
  const normalized = normalizeTranscriptText(text);
  return (
    /subtitles?/.test(normalized) ||
    /dimatorzok/.test(normalized) ||
    /[\u0400-\u04ff]/.test(text)
  );
}

function isLikelyNonEnglishShortArtifact(text: string) {
  const normalized = normalizeTranscriptText(text);
  const words = normalized.split(" ").filter(Boolean);
  return words.length > 0 && words.length <= 4 && /[^\u0000-\u007f]/.test(text);
}

function isLowInformationFragment(text: string) {
  const words = normalizeTranscriptText(text).split(" ").filter(Boolean);

  if (words.length === 0) {
    return true;
  }

  if (words.length === 1 && words[0].length <= 10) {
    return true;
  }

  return words.length <= 2 && words.join("").length <= 14;
}

function getSpeechSampleRatio(audioStats?: AudioChunkStats) {
  if (!audioStats || audioStats.totalSamples <= 0) {
    return null;
  }

  return audioStats.speechSamples / audioStats.totalSamples;
}

function hasVeryLowConfidence(context?: TranscriptFilterContext) {
  return Boolean(
    typeof context?.quality?.avgLogprob === "number" &&
      context.quality.avgLogprob <= VERY_LOW_AVG_LOGPROB,
  );
}

function hasWeakArtifactSignal(context?: TranscriptFilterContext) {
  const audioStats = context?.audioStats;
  const quality = context?.quality;
  const speechRatio = getSpeechSampleRatio(audioStats);

  return Boolean(
    hasWeakTranscriptSignal(context) ||
      (audioStats &&
        speechRatio !== null &&
        speechRatio < WEAK_SPEECH_SAMPLE_RATIO &&
        typeof quality?.noSpeechProbability === "number" &&
        quality.noSpeechProbability >= WEAK_ARTIFACT_NO_SPEECH_PROBABILITY),
  );
}

function hasLowConfidenceFragmentSignal(context?: TranscriptFilterContext) {
  const quality = context?.quality;

  return Boolean(
    hasWeakTranscriptSignal(context) ||
      (typeof quality?.avgLogprob === "number" &&
        quality.avgLogprob <= LOW_CONFIDENCE_FRAGMENT_AVG_LOGPROB &&
        typeof quality?.maxCompressionRatio === "number" &&
        quality.maxCompressionRatio <= LOW_CONFIDENCE_FRAGMENT_COMPRESSION_RATIO),
  );
}

function hasWeakTranscriptSignal(context?: TranscriptFilterContext) {
  const audioStats = context?.audioStats;
  const quality = context?.quality;
  const speechRatio = getSpeechSampleRatio(audioStats);

  return Boolean(
    (typeof quality?.noSpeechProbability === "number" &&
      quality.noSpeechProbability >= HIGH_NO_SPEECH_PROBABILITY) ||
      (typeof quality?.avgLogprob === "number" && quality.avgLogprob <= LOW_AVG_LOGPROB) ||
      (audioStats &&
        audioStats.maxRms < WEAK_AUDIO_RMS &&
        (speechRatio === null || speechRatio < WEAK_SPEECH_SAMPLE_RATIO)),
  );
}

function getTranscriptFilterReason(text: string, recentLines: TranscriptLine[], context?: TranscriptFilterContext) {
  const normalized = normalizeTranscriptText(text);

  if (!normalized) {
    return "empty";
  }

  if (hasVeryLowConfidence(context)) {
    return "very_low_confidence";
  }

  if (isLikelySubtitleArtifact(text) && hasWeakArtifactSignal(context)) {
    return "subtitle_artifact_weak_signal";
  }

  if (isLikelyNonEnglishShortArtifact(text) && hasWeakArtifactSignal(context)) {
    return "non_english_short_artifact_weak_signal";
  }

  if (isLikelyWhisperOutroArtifact(text) && hasWeakArtifactSignal(context)) {
    return "outro_artifact_weak_signal";
  }

  if (isLowInformationFragment(text) && hasLowConfidenceFragmentSignal(context)) {
    return "low_information_weak_signal";
  }

  const duplicate = recentLines.slice(-4).some((line) => {
    const previous = normalizeTranscriptText(line.text);

    if (!previous) {
      return false;
    }

    return (
      previous === normalized ||
      previous.endsWith(normalized) ||
      normalized.endsWith(previous) ||
      textSimilarity(line.text, text) >= DUPLICATE_SIMILARITY_THRESHOLD
    );
  });

  return duplicate ? "duplicate" : null;
}

function shouldSkipTranscriptText(text: string, recentLines: TranscriptLine[], context?: TranscriptFilterContext) {
  return getTranscriptFilterReason(text, recentLines, context) !== null;
}

export default function Home() {
  const [recording, setRecording] = useState(false);
  const [requestingMic, setRequestingMic] = useState(false);
  const [pendingTranscriptions, setPendingTranscriptions] = useState(0);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [groqApiKey, setGroqApiKey] = useState("");
  const [whisperModel, setWhisperModel] = useState(DEFAULT_WHISPER_MODEL);
  const [suggestionModel, setSuggestionModel] = useState(DEFAULT_SUGGESTION_MODEL);
  const [chunkIntervalSeconds, setChunkIntervalSeconds] = useState(DEFAULT_CHUNK_INTERVAL_SECONDS);
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [renderedBatches, setRenderedBatches] = useState<RenderedBatch[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [countdown, setCountdown] = useState(DEFAULT_CHUNK_INTERVAL_SECONDS);

  const batchIndexRef = useRef(0);
  const messageIdRef = useRef(0);
  const transcriptIdRef = useRef(0);
  const countdownTimerRef = useRef<number | null>(null);
  const segmentTimerRef = useRef<number | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const shouldContinueRecordingRef = useRef(false);
  const audioContextRef = useRef<AudioContext | null>(null);
  const audioSourceRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const audioAnalyserRef = useRef<AnalyserNode | null>(null);
  const audioActivityTimerRef = useRef<number | null>(null);
  const segmentSpeechSamplesRef = useRef(0);
  const segmentTotalSamplesRef = useRef(0);
  const segmentMaxRmsRef = useRef(0);
  const transcriptionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const groqApiKeyRef = useRef("");
  const whisperModelRef = useRef(DEFAULT_WHISPER_MODEL);
  const chunkIntervalSecondsRef = useRef(DEFAULT_CHUNK_INTERVAL_SECONDS);
  const transcriptLinesRef = useRef<TranscriptLine[]>([]);
  const transcriptBodyRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);

  const apiKeyReady = groqApiKey.trim().length > 0;

  const addSuggestionBatch = useCallback(() => {
    const batch = suggestionBatches[batchIndexRef.current % suggestionBatches.length];
    batchIndexRef.current += 1;
    const batchNumber = batchIndexRef.current;

    setRenderedBatches((current) => [
      {
        id: batchNumber,
        batchNumber,
        time: timestamp(),
        suggestions: batch,
      },
      ...current,
    ]);
  }, []);

  const tickCountdown = useCallback(() => {
    setCountdown((current) => {
      if (current <= 1) {
        addSuggestionBatch();
        return chunkIntervalSecondsRef.current;
      }

      return current - 1;
    });
  }, [addSuggestionBatch]);

  const clearCountdownTimer = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  const clearSegmentTimer = useCallback(() => {
    if (segmentTimerRef.current !== null) {
      window.clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }
  }, []);

  const clearAudioActivityTimer = useCallback(() => {
    if (audioActivityTimerRef.current !== null) {
      window.clearInterval(audioActivityTimerRef.current);
      audioActivityTimerRef.current = null;
    }
  }, []);

  const resetSegmentAudioActivity = useCallback(() => {
    segmentSpeechSamplesRef.current = 0;
    segmentTotalSamplesRef.current = 0;
    segmentMaxRmsRef.current = 0;
  }, []);

  const hasSegmentSpeechActivity = useCallback(() => {
    if (!audioAnalyserRef.current) {
      return true;
    }

    return segmentSpeechSamplesRef.current >= MIN_SPEECH_SAMPLES && segmentMaxRmsRef.current >= MIN_SPEECH_RMS;
  }, []);

  const stopAudioActivityMonitor = useCallback(() => {
    clearAudioActivityTimer();
    audioSourceRef.current?.disconnect();
    audioSourceRef.current = null;
    audioAnalyserRef.current = null;

    if (audioContextRef.current) {
      void audioContextRef.current.close();
      audioContextRef.current = null;
    }
  }, [clearAudioActivityTimer]);

  const startAudioActivityMonitor = useCallback(
    (stream: MediaStream) => {
      stopAudioActivityMonitor();

      const AudioContextConstructor =
        window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

      if (!AudioContextConstructor) {
        return;
      }

      const audioContext = new AudioContextConstructor();
      const analyser = audioContext.createAnalyser();
      const source = audioContext.createMediaStreamSource(stream);

      analyser.fftSize = 1024;
      const samples = new Uint8Array(analyser.fftSize);
      source.connect(analyser);

      audioContextRef.current = audioContext;
      audioSourceRef.current = source;
      audioAnalyserRef.current = analyser;

      if (audioContext.state === "suspended") {
        void audioContext.resume();
      }

      audioActivityTimerRef.current = window.setInterval(() => {
        analyser.getByteTimeDomainData(samples);

        let sumSquares = 0;

        samples.forEach((sample) => {
          const centered = (sample - 128) / 128;
          sumSquares += centered * centered;
        });

        const rms = Math.sqrt(sumSquares / samples.length);
        segmentTotalSamplesRef.current += 1;
        segmentMaxRmsRef.current = Math.max(segmentMaxRmsRef.current, rms);

        if (rms >= MIN_SPEECH_RMS) {
          segmentSpeechSamplesRef.current += 1;
        }
      }, AUDIO_ACTIVITY_SAMPLE_MS);
    },
    [stopAudioActivityMonitor],
  );

  const stopMediaStream = useCallback(() => {
    mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
    mediaStreamRef.current = null;
  }, []);

  const appendTranscriptLine = useCallback(
    (text: string, startedAt: Date, endedAt: Date, context?: TranscriptFilterContext) => {
      const currentLines = transcriptLinesRef.current;
      const filterReason = getTranscriptFilterReason(text, currentLines, context);

      if (filterReason) {
        emitClientLog("transcription", "transcript_text_filtered", {
          reason: filterReason,
          text,
          textLength: text.length,
          recentLineCount: currentLines.length,
          audioStats: context?.audioStats,
          quality: context?.quality,
        });
        return;
      }

      transcriptIdRef.current += 1;
      const id = transcriptIdRef.current;
      const line = {
        id,
        time: timestamp(endedAt),
        text,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
      };

      setTranscriptLines((current) => {
        const nextLines = [...current, line];
        transcriptLinesRef.current = nextLines;
        return nextLines;
      });

      emitClientLog("transcription", "transcript_text_appended", {
        id,
        textLength: text.length,
        startedAt: line.startedAt,
        endedAt: line.endedAt,
        audioStats: context?.audioStats,
        quality: context?.quality,
      });
    },
    [],
  );

  const transcribeAudioChunk = useCallback(
    async (blob: Blob, startedAt: Date, endedAt: Date, audioStats?: AudioChunkStats) => {
      const apiKey = groqApiKeyRef.current;

      if (!apiKey) {
        setTranscriptionError("Paste a Groq API key before starting the mic.");
        emitClientLog("errors", "transcription_not_started_missing_api_key");
        return;
      }

      setPendingTranscriptions((current) => current + 1);
      setTranscriptionError(null);

      try {
        const formData = new FormData();
        const mimeType = blob.type || "audio/webm";
        const fileName = `meeting-${startedAt.getTime()}.${extensionForMimeType(mimeType)}`;
        const model = whisperModelRef.current || DEFAULT_WHISPER_MODEL;

        formData.append("audio", blob, fileName);
        formData.append("model", model);

        emitClientLog("transcription", "transcription_request_started", {
          fileName,
          model,
          audioType: mimeType,
          audioSize: blob.size,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          audioStats,
        });

        const response = await fetch("/api/transcribe", {
          method: "POST",
          headers: {
            "x-groq-api-key": apiKey,
          },
          body: formData,
        });
        const payload = (await response.json().catch(() => null)) as TranscriptionResponse | null;

        if (!response.ok) {
          throw new Error(payload?.error ?? "Transcription failed.");
        }

        const text = payload?.text?.trim();

        emitClientLog("transcription", "transcription_response_received", {
          status: response.status,
          textLength: text?.length ?? 0,
          audioSize: blob.size,
          quality: payload?.quality,
          audioStats,
        });

        if (text) {
          appendTranscriptLine(text, startedAt, endedAt, {
            audioStats,
            quality: payload?.quality,
          });
        }
      } catch (error) {
        setTranscriptionError(transcriptionErrorMessage(error));
        emitClientLog("errors", "transcription_request_failed", {
          error: transcriptionErrorMessage(error),
          audioSize: blob.size,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          audioStats,
        });
      } finally {
        setPendingTranscriptions((current) => Math.max(0, current - 1));
      }
    },
    [appendTranscriptLine],
  );

  const enqueueTranscription = useCallback(
    (blob: Blob, startedAt: Date, endedAt: Date, audioStats?: AudioChunkStats) => {
      emitClientLog("audio", "audio_chunk_enqueued", {
        audioType: blob.type || "unknown",
        audioSize: blob.size,
        startedAt: startedAt.toISOString(),
        endedAt: endedAt.toISOString(),
        audioStats,
      });

      transcriptionQueueRef.current = transcriptionQueueRef.current
        .catch(() => undefined)
        .then(() => transcribeAudioChunk(blob, startedAt, endedAt, audioStats));
    },
    [transcribeAudioChunk],
  );

  const startRecorderSegment = useCallback(
    (stream: MediaStream) => {
      const mimeType = getPreferredMimeType();
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const audioParts: Blob[] = [];
      const startedAt = new Date();

      mediaRecorderRef.current = recorder;
      resetSegmentAudioActivity();

      emitClientLog("audio", "recorder_segment_started", {
        mimeType: mimeType || recorder.mimeType || "browser-default",
        startedAt: startedAt.toISOString(),
        chunkIntervalSeconds: chunkIntervalSecondsRef.current,
      });

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          audioParts.push(event.data);
        }
      };

      recorder.onerror = () => {
        setTranscriptionError("The browser stopped recording audio.");
      };

      recorder.onstop = () => {
        clearSegmentTimer();

        if (mediaRecorderRef.current === recorder) {
          mediaRecorderRef.current = null;
        }

        const endedAt = new Date();
        const durationMs = endedAt.getTime() - startedAt.getTime();
        const recordedMimeType = recorder.mimeType || mimeType || audioParts[0]?.type || "audio/webm";
        const audioBlob = new Blob(audioParts, { type: recordedMimeType });
        const hasSpeech = hasSegmentSpeechActivity();
        const audioStats: AudioChunkStats = {
          audioType: recordedMimeType,
          audioSize: audioBlob.size,
          durationMs,
          speechSamples: segmentSpeechSamplesRef.current,
          totalSamples: segmentTotalSamplesRef.current,
          maxRms: Number(segmentMaxRmsRef.current.toFixed(5)),
        };

        if (audioBlob.size >= MIN_AUDIO_CHUNK_BYTES && durationMs >= MIN_AUDIO_CHUNK_MS && hasSpeech) {
          emitClientLog("audio", "audio_chunk_ready", audioStats);
          enqueueTranscription(audioBlob, startedAt, endedAt, audioStats);
        } else {
          emitClientLog("audio", "audio_chunk_skipped", {
            ...audioStats,
            reason:
              audioBlob.size < MIN_AUDIO_CHUNK_BYTES
                ? "too_small"
                : durationMs < MIN_AUDIO_CHUNK_MS
                  ? "too_short"
                  : "no_speech_activity",
          });
        }

        if (
          shouldContinueRecordingRef.current &&
          mediaStreamRef.current === stream &&
          stream.getAudioTracks().some((track) => track.readyState === "live")
        ) {
          startRecorderSegment(stream);
          return;
        }

        stopAudioActivityMonitor();
        stopMediaStream();
      };

      recorder.start();
      segmentTimerRef.current = window.setTimeout(() => {
        if (recorder.state === "recording") {
          recorder.stop();
        }
      }, chunkIntervalSecondsRef.current * 1000);
    },
    [
      clearSegmentTimer,
      enqueueTranscription,
      hasSegmentSpeechActivity,
      resetSegmentAudioActivity,
      stopAudioActivityMonitor,
      stopMediaStream,
    ],
  );

  const stopRecording = useCallback(() => {
    setRecording(false);
    shouldContinueRecordingRef.current = false;
    emitClientLog("client", "recording_stop_requested");
    clearCountdownTimer();
    clearSegmentTimer();

    const recorder = mediaRecorderRef.current;

    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
      return;
    }

    mediaRecorderRef.current = null;
    stopAudioActivityMonitor();
    stopMediaStream();
  }, [clearCountdownTimer, clearSegmentTimer, stopAudioActivityMonitor, stopMediaStream]);

  const startRecording = useCallback(async () => {
    if (recording || requestingMic) {
      return;
    }

    if (!apiKeyReady) {
      setTranscriptionError("Paste a Groq API key before starting the mic.");
      emitClientLog("errors", "recording_blocked_missing_api_key");
      return;
    }

    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setTranscriptionError("This browser does not support microphone recording.");
      emitClientLog("errors", "recording_blocked_browser_unsupported");
      return;
    }

    if (!window.isSecureContext) {
      setTranscriptionError("Microphone recording requires HTTPS or localhost. Open http://localhost:3000 instead of the network URL.");
      emitClientLog("errors", "recording_blocked_insecure_context", {
        location: window.location.href,
      });
      return;
    }

    setRequestingMic(true);
    setTranscriptionError(null);
    emitClientLog("client", "recording_start_requested", {
      chunkIntervalSeconds: chunkIntervalSecondsRef.current,
      whisperModel: whisperModelRef.current,
    });

    try {
      const permissionState = await getMicrophonePermissionState();

      emitClientLog("client", "microphone_permission_state_checked", {
        permissionState: permissionState ?? "unknown",
      });

      if (permissionState === "denied") {
        throw new DOMException("Browser permission state is denied for this site.", "NotAllowedError");
      }

      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

      mediaStreamRef.current = stream;
      shouldContinueRecordingRef.current = true;
      startAudioActivityMonitor(stream);

      const chunkInterval = chunkIntervalSecondsRef.current;

      startRecorderSegment(stream);
      setRecording(true);
      setCountdown(chunkInterval);
      clearCountdownTimer();
      countdownTimerRef.current = window.setInterval(tickCountdown, 1000);
      emitClientLog("client", "recording_started", {
        chunkIntervalSeconds: chunkInterval,
        trackCount: stream.getAudioTracks().length,
      });
    } catch (error) {
      shouldContinueRecordingRef.current = false;
      clearSegmentTimer();
      stopAudioActivityMonitor();
      stopMediaStream();
      setTranscriptionError(microphoneErrorMessage(error));
      emitClientLog("errors", "recording_start_failed", {
        error: microphoneErrorMessage(error),
      });
    } finally {
      setRequestingMic(false);
    }
  }, [
    apiKeyReady,
    clearCountdownTimer,
    recording,
    requestingMic,
    startRecorderSegment,
    startAudioActivityMonitor,
    stopAudioActivityMonitor,
    stopMediaStream,
    tickCountdown,
  ]);

  const handleMicClick = useCallback(() => {
    if (recording) {
      stopRecording();
      return;
    }

    void startRecording();
  }, [recording, startRecording, stopRecording]);

  const addChatMessage = useCallback((who: ChatMessage["who"], text: string, label?: string) => {
    messageIdRef.current += 1;
    const id = messageIdRef.current;

    setChatMessages((current) => [
      ...current,
      {
        id,
        who,
        text,
        label,
      },
    ]);
  }, []);

  const sendToChat = useCallback(
    (text: string, type?: SuggestionType) => {
      addChatMessage("user", text, type ? labelFor(type) : undefined);
      window.setTimeout(() => addChatMessage("ai", simulateAnswer(text)), 600);
    },
    [addChatMessage],
  );

  const handleReload = useCallback(() => {
    addSuggestionBatch();
    setCountdown(chunkIntervalSecondsRef.current);
  }, [addSuggestionBatch]);

  const handleChatSend = useCallback(() => {
    const value = chatInput.trim();

    if (!value) {
      return;
    }

    sendToChat(value);
    setChatInput("");
  }, [chatInput, sendToChat]);

  const handleGroqApiKeyChange = useCallback((value: string) => {
    setGroqApiKey(value);
    emitClientLog("app", "settings_groq_api_key_changed", {
      hasKey: value.trim().length > 0,
    });
  }, []);

  const handleChunkIntervalChange = useCallback((value: string) => {
    const nextInterval = clampChunkInterval(Number(value));

    setChunkIntervalSeconds(nextInterval);
    emitClientLog("app", "settings_chunk_interval_changed", {
      chunkIntervalSeconds: nextInterval,
    });

    if (!recording) {
      setCountdown(nextInterval);
    }
  }, [recording]);

  const handleResetDefaults = useCallback(() => {
    setWhisperModel(DEFAULT_WHISPER_MODEL);
    setSuggestionModel(DEFAULT_SUGGESTION_MODEL);
    setChunkIntervalSeconds(DEFAULT_CHUNK_INTERVAL_SECONDS);
    emitClientLog("app", "settings_reset_defaults");

    if (!recording) {
      setCountdown(DEFAULT_CHUNK_INTERVAL_SECONDS);
    }
  }, [recording]);

  const handleCloseSettings = useCallback(() => {
    setSettingsOpen(false);
  }, []);

  const recState = useMemo(() => {
    if (requestingMic) {
      return "requesting mic";
    }

    if (recording) {
      return "● recording";
    }

    if (pendingTranscriptions > 0) {
      return "transcribing";
    }

    return "idle";
  }, [pendingTranscriptions, recording, requestingMic]);

  const micStatus = useMemo(() => {
    if (transcriptionError) {
      return transcriptionError;
    }

    if (!apiKeyReady) {
      return "Open Settings to add your Groq API key before recording.";
    }

    if (requestingMic) {
      return "Requesting microphone permission…";
    }

    if (recording && pendingTranscriptions > 0) {
      return "Listening… transcribing the latest audio chunk.";
    }

    if (recording) {
      return `Listening… transcript updates every ${chunkIntervalSeconds}s.`;
    }

    if (pendingTranscriptions > 0) {
      return "Stopped. Transcribing the final audio chunk.";
    }

    if (transcriptLines.length > 0) {
      return "Stopped. Click to resume.";
    }

    return `Click mic to start. Transcript appends every ~${chunkIntervalSeconds}s.`;
  }, [
    apiKeyReady,
    chunkIntervalSeconds,
    pendingTranscriptions,
    recording,
    requestingMic,
    transcriptLines.length,
    transcriptionError,
  ]);

  useEffect(() => {
    const storedSettings = parseStoredSettings(window.sessionStorage.getItem(SETTINGS_STORAGE_KEY));
    const storedLegacyKey = window.sessionStorage.getItem(LEGACY_GROQ_KEY_STORAGE_KEY);

    if (storedSettings?.groqApiKey || storedLegacyKey) {
      setGroqApiKey(storedSettings?.groqApiKey ?? storedLegacyKey ?? "");
    }

    if (storedSettings?.whisperModel) {
      setWhisperModel(storedSettings.whisperModel);
    }

    if (storedSettings?.suggestionModel) {
      setSuggestionModel(storedSettings.suggestionModel);
    }

    if (storedSettings?.chunkIntervalSeconds) {
      const nextInterval = clampChunkInterval(storedSettings.chunkIntervalSeconds);
      setChunkIntervalSeconds(nextInterval);
      setCountdown(nextInterval);
    }

    emitClientLog("app", "app_loaded", {
      restoredSettings: Boolean(storedSettings),
      restoredLegacyKey: Boolean(storedLegacyKey),
    });
  }, []);

  useEffect(() => {
    const settings: StoredSettings = {
      groqApiKey,
      whisperModel,
      suggestionModel,
      chunkIntervalSeconds,
    };

    window.sessionStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));

    if (groqApiKey.trim()) {
      window.sessionStorage.setItem(LEGACY_GROQ_KEY_STORAGE_KEY, groqApiKey);
    } else {
      window.sessionStorage.removeItem(LEGACY_GROQ_KEY_STORAGE_KEY);
    }
  }, [chunkIntervalSeconds, groqApiKey, suggestionModel, whisperModel]);

  useEffect(() => {
    groqApiKeyRef.current = groqApiKey.trim();
  }, [groqApiKey]);

  useEffect(() => {
    whisperModelRef.current = whisperModel.trim() || DEFAULT_WHISPER_MODEL;
  }, [whisperModel]);

  useEffect(() => {
    chunkIntervalSecondsRef.current = clampChunkInterval(chunkIntervalSeconds);
  }, [chunkIntervalSeconds]);

  useEffect(() => {
    if (!settingsOpen) {
      return undefined;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settingsOpen]);

  useEffect(() => {
    const transcriptBody = transcriptBodyRef.current;
    transcriptLinesRef.current = transcriptLines;

    if (transcriptBody) {
      transcriptBody.scrollTop = transcriptBody.scrollHeight;
    }
  }, [transcriptLines]);

  useEffect(() => {
    const chatBody = chatBodyRef.current;

    if (chatBody) {
      chatBody.scrollTop = chatBody.scrollHeight;
    }
  }, [chatMessages]);

  useEffect(() => {
    return () => {
      emitClientLog("app", "app_unloaded");
      shouldContinueRecordingRef.current = false;

      if (countdownTimerRef.current !== null) {
        window.clearInterval(countdownTimerRef.current);
        countdownTimerRef.current = null;
      }

      if (segmentTimerRef.current !== null) {
        window.clearTimeout(segmentTimerRef.current);
        segmentTimerRef.current = null;
      }

      if (audioActivityTimerRef.current !== null) {
        window.clearInterval(audioActivityTimerRef.current);
        audioActivityTimerRef.current = null;
      }

      const recorder = mediaRecorderRef.current;

      if (recorder && recorder.state !== "inactive") {
        recorder.stop();
      }

      audioSourceRef.current?.disconnect();
      audioSourceRef.current = null;
      audioAnalyserRef.current = null;

      if (audioContextRef.current) {
        void audioContextRef.current.close();
        audioContextRef.current = null;
      }

      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
    };
  }, []);

  return (
    <>
      <div className="topbar">
        <h1>TwinMind — Live Suggestions Web App (Reference Mockup)</h1>
        <div className="topbar-actions">
          <div className="meta">3-column layout · Transcript · Live Suggestions · Chat</div>
          <button className="settings-btn" onClick={() => setSettingsOpen(true)} type="button">
            Settings
          </button>
        </div>
      </div>

      {settingsOpen ? (
        <div
          className="settings-backdrop"
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) {
              handleCloseSettings();
            }
          }}
        >
          <div aria-labelledby="settingsTitle" aria-modal="true" className="settings-modal" role="dialog">
            <div className="settings-header">
              <h2 id="settingsTitle">Settings</h2>
              <button
                aria-label="Close settings"
                className="settings-close"
                onClick={handleCloseSettings}
                type="button"
              >
                ×
              </button>
            </div>

            <div className="settings-fields">
              <label className="settings-field" htmlFor="groqApiKey">
                <span>Groq API key</span>
                <input
                  autoComplete="off"
                  id="groqApiKey"
                  onChange={(event) => handleGroqApiKeyChange(event.target.value)}
                  placeholder="gsk_..."
                  type="password"
                  value={groqApiKey}
                />
              </label>

              <label className="settings-field" htmlFor="whisperModel">
                <span>Whisper model</span>
                <input
                  id="whisperModel"
                  onChange={(event) => setWhisperModel(event.target.value)}
                  value={whisperModel}
                />
              </label>

              <label className="settings-field" htmlFor="suggestionModel">
                <span>Suggestion model</span>
                <input
                  id="suggestionModel"
                  onChange={(event) => setSuggestionModel(event.target.value)}
                  value={suggestionModel}
                />
              </label>

              <label className="settings-field" htmlFor="chunkIntervalSeconds">
                <span>Chunk interval</span>
                <div className="number-input-wrap">
                  <input
                    id="chunkIntervalSeconds"
                    max={MAX_CHUNK_INTERVAL_SECONDS}
                    min={MIN_CHUNK_INTERVAL_SECONDS}
                    onChange={(event) => handleChunkIntervalChange(event.target.value)}
                    step={1}
                    type="number"
                    value={chunkIntervalSeconds}
                  />
                  <span>seconds</span>
                </div>
              </label>
            </div>

            <div className="settings-footer">
              <button className="settings-secondary" onClick={handleResetDefaults} type="button">
                Reset defaults
              </button>
              <button className="settings-primary" onClick={handleCloseSettings} type="button">
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}

      <div className="layout">
        <div className="col">
          <header>
            <span>1. Mic & Transcript</span>
            <span id="recState">{recState}</span>
          </header>
          <div className="mic-wrap">
            <button
              id="micBtn"
              className={`mic-btn${recording ? " recording" : ""}`}
              disabled={requestingMic}
              title="Start / stop recording"
              type="button"
              onClick={handleMicClick}
            >
              ●
            </button>
            <div className={`mic-status${transcriptionError ? " status-error" : ""}`} id="micStatus">
              {micStatus}
            </div>
          </div>
          <div className="body" id="transcriptBody" ref={transcriptBodyRef}>
            <div className="help-banner">
              The transcript scrolls and appends new chunks every ~{chunkIntervalSeconds} seconds while
              recording. Audio is captured from the mic and transcribed with Groq Whisper Large V3.
            </div>
            {transcriptLines.length === 0 ? (
              <div className="empty" id="transcriptEmpty">
                No transcript yet — start the mic.
              </div>
            ) : (
              transcriptLines.map((line) => (
                <div className="transcript-line new" key={line.id}>
                  <span className="ts">{line.time}</span>
                  {line.text}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="col">
          <header>
            <span>2. Live Suggestions</span>
            <span id="batchCount">
              {renderedBatches.length} batch{renderedBatches.length === 1 ? "" : "es"}
            </span>
          </header>
          <div className="reload-row">
            <button className="reload-btn" id="reloadBtn" type="button" onClick={handleReload}>
              ↻ Reload suggestions
            </button>
            <span className="countdown" id="countdown">
              auto-refresh in {countdown}s
            </span>
          </div>
          <div className="body" id="suggestionsBody">
            <div className="help-banner">
              On reload (or auto every ~30s), generate <b>3 fresh suggestions</b> from recent transcript
              context. New batch appears at the top; older batches push down (faded). Each is a tappable
              card: a <span className="accent-text">question to ask</span>, a{" "}
              <span className="accent-2-text">talking point</span>, an{" "}
              <span className="good-text">answer</span>, or a <span className="warn-text">fact-check</span>.
              The preview alone should already be useful.
            </div>
            {renderedBatches.length === 0 ? (
              <div className="empty" id="suggestionsEmpty">
                Suggestions appear here once recording starts.
              </div>
            ) : (
              renderedBatches.map((batch, batchPosition) => (
                <div key={batch.id}>
                  {batch.suggestions.map((suggestion) => (
                    <button
                      className={`suggestion ${batchPosition === 0 ? "fresh" : "stale"}`}
                      key={`${batch.id}-${suggestion.type}-${suggestion.text}`}
                      onClick={() => sendToChat(suggestion.text, suggestion.type)}
                      type="button"
                    >
                      <span className={`sug-tag ${suggestion.type}`}>{labelFor(suggestion.type)}</span>
                      <div className="sug-title">{suggestion.text}</div>
                    </button>
                  ))}
                  <div className="sug-batch-divider">
                    — Batch {batch.batchNumber} · {batch.time} —
                  </div>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="col">
          <header>
            <span>3. Chat (detailed answers)</span>
            <span>session-only</span>
          </header>
          <div className="body" id="chatBody" ref={chatBodyRef}>
            <div className="help-banner">
              Clicking a suggestion adds it to this chat and streams a detailed answer (separate prompt, more
              context). User can also type questions directly. One continuous chat per session — no login, no
              persistence.
            </div>
            {chatMessages.length === 0 ? (
              <div className="empty" id="chatEmpty">
                Click a suggestion or type a question below.
              </div>
            ) : (
              chatMessages.map((message) => (
                <div className={`chat-msg ${message.who}`} key={message.id}>
                  <div className="who">
                    {message.who === "user" ? (message.label ? `You · ${message.label}` : "You") : "Assistant"}
                  </div>
                  <div className="bubble">{message.text}</div>
                </div>
              ))
            )}
          </div>
          <div className="chat-input-row">
            <input
              id="chatInput"
              onChange={(event) => setChatInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleChatSend();
                }
              }}
              placeholder="Ask anything…"
              value={chatInput}
            />
            <button id="chatSend" onClick={handleChatSend} type="button">
              Send
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
