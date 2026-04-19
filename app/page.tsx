"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  DEFAULT_CHAT_PROMPT,
  DEFAULT_DETAIL_ANSWER_PROMPT,
  DEFAULT_LIVE_SUGGESTION_PROMPT,
} from "../lib/default-prompts";

const SETTINGS_STORAGE_KEY = "meetmind.settings";
const LEGACY_GROQ_KEY_STORAGE_KEY = "meetmind.groqApiKey";
const DEFAULT_WHISPER_MODEL = "whisper-large-v3";
const DEFAULT_TRANSCRIPTION_LANGUAGE = "en";
const DEFAULT_SUGGESTION_MODEL = "openai/gpt-oss-120b";
const DEFAULT_CHUNK_INTERVAL_SECONDS = 30;
const MIN_CHUNK_INTERVAL_SECONDS = 5;
const MAX_CHUNK_INTERVAL_SECONDS = 120;
const DEFAULT_SUGGESTION_CONTEXT_LINES = 18;
const DEFAULT_DETAIL_CONTEXT_LINES = 80;
const MIN_CONTEXT_LINES = 3;
const MAX_CONTEXT_LINES = 200;
const OLDER_CONTEXT_LOOKBACK_LINES = 60;
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

type SuggestionType = "question" | "talking" | "answer" | "fact" | "clarifying";

type Suggestion = {
  type: SuggestionType;
  text: string;
};

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
  createdAt: string;
  suggestions: Suggestion[];
};

type ChatMessage = {
  id: number;
  who: "user" | "ai";
  text: string;
  time: string;
  createdAt: string;
  label?: string;
};

type TranscriptionResponse = {
  text?: string;
  error?: string;
  quality?: TranscriptionQuality;
};

type SuggestionsResponse = {
  suggestions?: Suggestion[];
  error?: string;
};

type ChatResponse = {
  answer?: string;
  finishReason?: string | null;
  error?: string;
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
  transcriptionLanguage?: string;
  suggestionModel?: string;
  chunkIntervalSeconds?: number;
  suggestionContextLines?: number;
  detailContextLines?: number;
  liveSuggestionPrompt?: string;
  detailAnswerPrompt?: string;
  chatPrompt?: string;
};

type ClientLogCategory = "app" | "client" | "audio" | "transcription" | "suggestions" | "chat" | "groq" | "errors";

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
    clarifying: "Clarifying info",
  }[type];
}

function FormattedChatText({ text }: { text: string }) {
  return (
    <div className="markdown-content">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
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

function clampContextLines(value: number, fallback: number) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(MAX_CONTEXT_LINES, Math.max(MIN_CONTEXT_LINES, Math.round(value)));
}

function resolvePrompt(value: string, fallback: string) {
  return value.trim() || fallback;
}

function getServerTranscriptLineLimit(recentLineLimit: number) {
  return Math.min(MAX_CONTEXT_LINES, Math.max(recentLineLimit, recentLineLimit + OLDER_CONTEXT_LOOKBACK_LINES));
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
  const [transcriptionLanguage, setTranscriptionLanguage] = useState(DEFAULT_TRANSCRIPTION_LANGUAGE);
  const [suggestionModel, setSuggestionModel] = useState(DEFAULT_SUGGESTION_MODEL);
  const [chunkIntervalSeconds, setChunkIntervalSeconds] = useState(DEFAULT_CHUNK_INTERVAL_SECONDS);
  const [suggestionContextLines, setSuggestionContextLines] = useState(DEFAULT_SUGGESTION_CONTEXT_LINES);
  const [detailContextLines, setDetailContextLines] = useState(DEFAULT_DETAIL_CONTEXT_LINES);
  const [liveSuggestionPrompt, setLiveSuggestionPrompt] = useState(DEFAULT_LIVE_SUGGESTION_PROMPT);
  const [detailAnswerPrompt, setDetailAnswerPrompt] = useState(DEFAULT_DETAIL_ANSWER_PROMPT);
  const [chatPrompt, setChatPrompt] = useState(DEFAULT_CHAT_PROMPT);
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [renderedBatches, setRenderedBatches] = useState<RenderedBatch[]>([]);
  const [suggestionsLoading, setSuggestionsLoading] = useState(false);
  const [refreshingTranscript, setRefreshingTranscript] = useState(false);
  const [suggestionsError, setSuggestionsError] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState<string | null>(null);
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
  const currentSegmentStartedAtRef = useRef<Date | null>(null);
  const transcriptionQueueRef = useRef<Promise<void>>(Promise.resolve());
  const groqApiKeyRef = useRef("");
  const whisperModelRef = useRef(DEFAULT_WHISPER_MODEL);
  const transcriptionLanguageRef = useRef(DEFAULT_TRANSCRIPTION_LANGUAGE);
  const suggestionModelRef = useRef(DEFAULT_SUGGESTION_MODEL);
  const chunkIntervalSecondsRef = useRef(DEFAULT_CHUNK_INTERVAL_SECONDS);
  const suggestionContextLinesRef = useRef(DEFAULT_SUGGESTION_CONTEXT_LINES);
  const detailContextLinesRef = useRef(DEFAULT_DETAIL_CONTEXT_LINES);
  const liveSuggestionPromptRef = useRef(DEFAULT_LIVE_SUGGESTION_PROMPT);
  const detailAnswerPromptRef = useRef(DEFAULT_DETAIL_ANSWER_PROMPT);
  const chatPromptRef = useRef(DEFAULT_CHAT_PROMPT);
  const transcriptLinesRef = useRef<TranscriptLine[]>([]);
  const chatMessagesRef = useRef<ChatMessage[]>([]);
  const chatLoadingRef = useRef(false);
  const suggestionsLoadingRef = useRef(false);
  const refreshingTranscriptRef = useRef(false);
  const refreshTranscriptThenSuggestionsRef = useRef<((trigger: "auto" | "manual") => Promise<void>) | null>(null);
  const manualSegmentFlushResolverRef = useRef<((task?: Promise<void>) => void) | null>(null);
  const transcriptBodyRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);

  const apiKeyReady = groqApiKey.trim().length > 0;

  const generateSuggestionBatch = useCallback(async (trigger: "auto" | "manual") => {
    if (suggestionsLoadingRef.current) {
      return;
    }

    const apiKey = groqApiKeyRef.current;

    if (!apiKey) {
      setSuggestionsError("Open Settings to add your Groq API key before generating suggestions.");
      emitClientLog("suggestions", "suggestions_blocked_missing_api_key", { trigger });
      return;
    }

    const contextLineLimit = suggestionContextLinesRef.current;
    const serverTranscriptLineLimit = getServerTranscriptLineLimit(contextLineLimit);
    const prompt = resolvePrompt(liveSuggestionPromptRef.current, DEFAULT_LIVE_SUGGESTION_PROMPT);
    const contextLines = transcriptLinesRef.current
      .slice(-serverTranscriptLineLimit)
      .filter((line) => line.text.trim().length > 0);

    if (contextLines.length === 0) {
      setSuggestionsError("Waiting for transcript text before generating suggestions.");
      emitClientLog("suggestions", "suggestions_blocked_empty_transcript", { trigger });
      return;
    }

    suggestionsLoadingRef.current = true;
    setSuggestionsLoading(true);
    setSuggestionsError(null);

    const model = suggestionModelRef.current || DEFAULT_SUGGESTION_MODEL;
    const requestedAt = new Date();

    emitClientLog("suggestions", "suggestions_request_started", {
      trigger,
      model,
      transcriptLineCount: contextLines.length,
      contextLineLimit,
      serverTranscriptLineLimit,
      promptLength: prompt.length,
    });

    try {
      const response = await fetch("/api/suggestions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-groq-api-key": apiKey,
        },
        body: JSON.stringify({
          model,
          prompt,
          contextWindowLines: contextLineLimit,
          transcriptLines: contextLines,
        }),
      });
      const payload = (await response.json().catch(() => null)) as SuggestionsResponse | null;

      if (!response.ok) {
        throw new Error(payload?.error ?? "Suggestion generation failed.");
      }

      const suggestions = payload?.suggestions ?? [];

      if (suggestions.length !== 3) {
        throw new Error("Suggestion model did not return exactly 3 suggestions.");
      }

      batchIndexRef.current += 1;
      const batchNumber = batchIndexRef.current;
      const completedAt = new Date();

      setRenderedBatches((current) => [
        {
          id: batchNumber,
          batchNumber,
          time: timestamp(completedAt),
          createdAt: completedAt.toISOString(),
          suggestions,
        },
        ...current,
      ]);

      emitClientLog("suggestions", "suggestions_batch_added", {
        trigger,
        model,
        batchNumber,
        suggestionCount: suggestions.length,
        durationMs: completedAt.getTime() - requestedAt.getTime(),
        contextLineLimit,
        serverTranscriptLineLimit,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Suggestion generation failed.";
      setSuggestionsError(message);
      emitClientLog("errors", "suggestions_request_failed", {
        trigger,
        model,
        error: message,
      });
    } finally {
      suggestionsLoadingRef.current = false;
      setSuggestionsLoading(false);
    }
  }, []);

  const tickCountdown = useCallback(() => {
    setCountdown((current) => {
      if (current <= 1) {
        void refreshTranscriptThenSuggestionsRef.current?.("auto");
        return chunkIntervalSecondsRef.current;
      }

      return current - 1;
    });
  }, []);

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
        const language = transcriptionLanguageRef.current || DEFAULT_TRANSCRIPTION_LANGUAGE;

        formData.append("audio", blob, fileName);
        formData.append("model", model);
        formData.append("language", language);

        emitClientLog("transcription", "transcription_request_started", {
          fileName,
          model,
          language,
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

      const task = transcriptionQueueRef.current
        .catch(() => undefined)
        .then(() => transcribeAudioChunk(blob, startedAt, endedAt, audioStats));

      transcriptionQueueRef.current = task;
      return task;
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
      currentSegmentStartedAtRef.current = startedAt;
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
          currentSegmentStartedAtRef.current = null;
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

        let transcriptionTask: Promise<void> | undefined;

        if (audioBlob.size >= MIN_AUDIO_CHUNK_BYTES && durationMs >= MIN_AUDIO_CHUNK_MS && hasSpeech) {
          emitClientLog("audio", "audio_chunk_ready", audioStats);
          transcriptionTask = enqueueTranscription(audioBlob, startedAt, endedAt, audioStats);
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

        if (manualSegmentFlushResolverRef.current) {
          manualSegmentFlushResolverRef.current(transcriptionTask);
          manualSegmentFlushResolverRef.current = null;
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
    currentSegmentStartedAtRef.current = null;
    stopAudioActivityMonitor();
    stopMediaStream();
  }, [clearCountdownTimer, clearSegmentTimer, stopAudioActivityMonitor, stopMediaStream]);

  const flushCurrentRecordingSegment = useCallback(async (trigger: "auto" | "manual") => {
    const recorder = mediaRecorderRef.current;

    if (!recording || !recorder || recorder.state !== "recording") {
      await transcriptionQueueRef.current.catch(() => undefined);
      return;
    }

    const segmentStartedAt = currentSegmentStartedAtRef.current;

    if (trigger === "auto" && segmentStartedAt && Date.now() - segmentStartedAt.getTime() < MIN_AUDIO_CHUNK_MS) {
      await transcriptionQueueRef.current.catch(() => undefined);
      return;
    }

    emitClientLog("suggestions", "refresh_transcript_flush_started", {
      trigger,
      recorderState: recorder.state,
    });

    await new Promise<void>((resolve) => {
      let resolved = false;

      const resolveAfterTask = (task?: Promise<void>) => {
        if (resolved) {
          return;
        }

        resolved = true;
        void (task ?? transcriptionQueueRef.current).catch(() => undefined).then(resolve);
      };

      manualSegmentFlushResolverRef.current = resolveAfterTask;

      try {
        recorder.stop();
      } catch {
        manualSegmentFlushResolverRef.current = null;
        resolveAfterTask();
      }
    });

    emitClientLog("suggestions", "refresh_transcript_flush_completed", { trigger });
  }, [recording]);

  const refreshTranscriptThenSuggestions = useCallback(
    async (trigger: "auto" | "manual") => {
      if (refreshingTranscriptRef.current || suggestionsLoadingRef.current) {
        return;
      }

      refreshingTranscriptRef.current = true;
      setRefreshingTranscript(true);
      setSuggestionsError(null);
      setCountdown(chunkIntervalSecondsRef.current);

      try {
        await flushCurrentRecordingSegment(trigger);
        await generateSuggestionBatch(trigger);
      } finally {
        refreshingTranscriptRef.current = false;
        setRefreshingTranscript(false);
      }
    },
    [flushCurrentRecordingSegment, generateSuggestionBatch],
  );

  useEffect(() => {
    refreshTranscriptThenSuggestionsRef.current = refreshTranscriptThenSuggestions;
  }, [refreshTranscriptThenSuggestions]);

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
      transcriptionLanguage: transcriptionLanguageRef.current,
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
      currentSegmentStartedAtRef.current = null;
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
    const createdAt = new Date();

    messageIdRef.current += 1;
    const message = {
      id: messageIdRef.current,
      who,
      text,
      time: timestamp(createdAt),
      createdAt: createdAt.toISOString(),
      label,
    };

    setChatMessages((current) => [...current, message]);
    return message;
  }, []);

  const sendToChat = useCallback(
    async (text: string, type?: SuggestionType) => {
      const question = text.trim();

      if (!question || chatLoadingRef.current) {
        return;
      }

      const apiKey = groqApiKeyRef.current;

      if (!apiKey) {
        setChatError("Open Settings to add your Groq API key before using chat.");
        emitClientLog("chat", "chat_blocked_missing_api_key");
        return;
      }

      const label = type ? labelFor(type) : undefined;
      const model = suggestionModelRef.current || DEFAULT_SUGGESTION_MODEL;
      const transcriptContextLimit = detailContextLinesRef.current;
      const serverTranscriptLineLimit = getServerTranscriptLineLimit(transcriptContextLimit);
      const transcriptContext = transcriptLinesRef.current.slice(-serverTranscriptLineLimit);
      const chatHistory = chatMessagesRef.current.slice(-12);
      const systemPrompt = type
        ? resolvePrompt(detailAnswerPromptRef.current, DEFAULT_DETAIL_ANSWER_PROMPT)
        : resolvePrompt(chatPromptRef.current, DEFAULT_CHAT_PROMPT);
      const requestedAt = new Date();

      addChatMessage("user", question, label);
      chatLoadingRef.current = true;
      setChatLoading(true);
      setChatError(null);

      emitClientLog("chat", "chat_request_started", {
        model,
        suggestionType: type,
        questionLength: question.length,
        transcriptLineCount: transcriptContext.length,
        contextLineLimit: transcriptContextLimit,
        serverTranscriptLineLimit,
        chatHistoryCount: chatHistory.length,
        promptLength: systemPrompt.length,
      });

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-groq-api-key": apiKey,
          },
          body: JSON.stringify({
            model,
            systemPrompt,
            contextWindowLines: transcriptContextLimit,
            question,
            suggestionType: type,
            transcriptLines: transcriptContext,
            chatMessages: chatHistory,
          }),
        });
        const payload = (await response.json().catch(() => null)) as ChatResponse | null;

        if (!response.ok) {
          throw new Error(payload?.error ?? "Chat answer failed.");
        }

        const answer = payload?.answer?.trim();

        if (!answer) {
          throw new Error("Chat model returned an empty answer.");
        }

        addChatMessage("ai", answer);

        if (payload?.finishReason === "length") {
          setChatError('Answer hit the response length limit. Ask "continue" or narrow the question to finish it.');
        }

        emitClientLog("chat", "chat_response_received", {
          model,
          suggestionType: type,
          durationMs: new Date().getTime() - requestedAt.getTime(),
          answerLength: answer.length,
          contextLineLimit: transcriptContextLimit,
          serverTranscriptLineLimit,
          finishReason: payload?.finishReason ?? null,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Chat answer failed.";
        setChatError(message);
        emitClientLog("errors", "chat_request_failed", {
          model,
          suggestionType: type,
          error: message,
        });
      } finally {
        chatLoadingRef.current = false;
        setChatLoading(false);
      }
    },
    [addChatMessage],
  );

  const handleReload = useCallback(async () => {
    await refreshTranscriptThenSuggestions("manual");
  }, [refreshTranscriptThenSuggestions]);

  const handleChatSend = useCallback(() => {
    const value = chatInput.trim();

    if (!value) {
      return;
    }

    void sendToChat(value);
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

  const handleSuggestionContextLinesChange = useCallback((value: string) => {
    const nextValue = clampContextLines(Number(value), DEFAULT_SUGGESTION_CONTEXT_LINES);

    setSuggestionContextLines(nextValue);
    emitClientLog("app", "settings_suggestion_context_lines_changed", {
      suggestionContextLines: nextValue,
    });
  }, []);

  const handleDetailContextLinesChange = useCallback((value: string) => {
    const nextValue = clampContextLines(Number(value), DEFAULT_DETAIL_CONTEXT_LINES);

    setDetailContextLines(nextValue);
    emitClientLog("app", "settings_detail_context_lines_changed", {
      detailContextLines: nextValue,
    });
  }, []);

  const handleExportSession = useCallback(() => {
    const exportedAt = new Date();
    const sessionExport = {
      exportedAt: exportedAt.toISOString(),
      settings: {
        whisperModel: whisperModelRef.current,
        transcriptionLanguage: transcriptionLanguageRef.current,
        suggestionModel: suggestionModelRef.current,
        chunkIntervalSeconds: chunkIntervalSecondsRef.current,
        suggestionContextLines: suggestionContextLinesRef.current,
        detailContextLines: detailContextLinesRef.current,
        prompts: {
          liveSuggestionPrompt: resolvePrompt(liveSuggestionPromptRef.current, DEFAULT_LIVE_SUGGESTION_PROMPT),
          detailAnswerPrompt: resolvePrompt(detailAnswerPromptRef.current, DEFAULT_DETAIL_ANSWER_PROMPT),
          chatPrompt: resolvePrompt(chatPromptRef.current, DEFAULT_CHAT_PROMPT),
        },
      },
      transcript: transcriptLinesRef.current,
      suggestionBatches: renderedBatches,
      chatHistory: chatMessagesRef.current,
    };
    const blob = new Blob([JSON.stringify(sessionExport, null, 2)], {
      type: "application/json",
    });
    const url = window.URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = `meetmind-session-${exportedAt.toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.URL.revokeObjectURL(url);

    emitClientLog("app", "session_exported", {
      transcriptLineCount: transcriptLinesRef.current.length,
      suggestionBatchCount: renderedBatches.length,
      chatMessageCount: chatMessagesRef.current.length,
    });
  }, [renderedBatches]);

  const handleResetDefaults = useCallback(() => {
    setWhisperModel(DEFAULT_WHISPER_MODEL);
    setTranscriptionLanguage(DEFAULT_TRANSCRIPTION_LANGUAGE);
    setSuggestionModel(DEFAULT_SUGGESTION_MODEL);
    setChunkIntervalSeconds(DEFAULT_CHUNK_INTERVAL_SECONDS);
    setSuggestionContextLines(DEFAULT_SUGGESTION_CONTEXT_LINES);
    setDetailContextLines(DEFAULT_DETAIL_CONTEXT_LINES);
    setLiveSuggestionPrompt(DEFAULT_LIVE_SUGGESTION_PROMPT);
    setDetailAnswerPrompt(DEFAULT_DETAIL_ANSWER_PROMPT);
    setChatPrompt(DEFAULT_CHAT_PROMPT);
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

    if (storedSettings?.transcriptionLanguage) {
      setTranscriptionLanguage(storedSettings.transcriptionLanguage);
    }

    if (storedSettings?.suggestionModel) {
      setSuggestionModel(storedSettings.suggestionModel);
    }

    if (storedSettings?.chunkIntervalSeconds) {
      const nextInterval = clampChunkInterval(storedSettings.chunkIntervalSeconds);
      setChunkIntervalSeconds(nextInterval);
      setCountdown(nextInterval);
    }

    if (storedSettings?.suggestionContextLines) {
      setSuggestionContextLines(clampContextLines(storedSettings.suggestionContextLines, DEFAULT_SUGGESTION_CONTEXT_LINES));
    }

    if (storedSettings?.detailContextLines) {
      setDetailContextLines(clampContextLines(storedSettings.detailContextLines, DEFAULT_DETAIL_CONTEXT_LINES));
    }

    if (storedSettings?.liveSuggestionPrompt) {
      setLiveSuggestionPrompt(storedSettings.liveSuggestionPrompt);
    }

    if (storedSettings?.detailAnswerPrompt) {
      setDetailAnswerPrompt(storedSettings.detailAnswerPrompt);
    }

    if (storedSettings?.chatPrompt) {
      setChatPrompt(storedSettings.chatPrompt);
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
      transcriptionLanguage,
      suggestionModel,
      chunkIntervalSeconds,
      suggestionContextLines,
      detailContextLines,
      liveSuggestionPrompt,
      detailAnswerPrompt,
      chatPrompt,
    };

    window.sessionStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));

    if (groqApiKey.trim()) {
      window.sessionStorage.setItem(LEGACY_GROQ_KEY_STORAGE_KEY, groqApiKey);
    } else {
      window.sessionStorage.removeItem(LEGACY_GROQ_KEY_STORAGE_KEY);
    }
  }, [
    chatPrompt,
    chunkIntervalSeconds,
    detailAnswerPrompt,
    detailContextLines,
    groqApiKey,
    liveSuggestionPrompt,
    suggestionContextLines,
    suggestionModel,
    transcriptionLanguage,
    whisperModel,
  ]);

  useEffect(() => {
    groqApiKeyRef.current = groqApiKey.trim();
  }, [groqApiKey]);

  useEffect(() => {
    whisperModelRef.current = whisperModel.trim() || DEFAULT_WHISPER_MODEL;
  }, [whisperModel]);

  useEffect(() => {
    transcriptionLanguageRef.current = transcriptionLanguage.trim() || DEFAULT_TRANSCRIPTION_LANGUAGE;
  }, [transcriptionLanguage]);

  useEffect(() => {
    suggestionModelRef.current = suggestionModel.trim() || DEFAULT_SUGGESTION_MODEL;
  }, [suggestionModel]);

  useEffect(() => {
    chunkIntervalSecondsRef.current = clampChunkInterval(chunkIntervalSeconds);
  }, [chunkIntervalSeconds]);

  useEffect(() => {
    suggestionContextLinesRef.current = clampContextLines(suggestionContextLines, DEFAULT_SUGGESTION_CONTEXT_LINES);
  }, [suggestionContextLines]);

  useEffect(() => {
    detailContextLinesRef.current = clampContextLines(detailContextLines, DEFAULT_DETAIL_CONTEXT_LINES);
  }, [detailContextLines]);

  useEffect(() => {
    liveSuggestionPromptRef.current = resolvePrompt(liveSuggestionPrompt, DEFAULT_LIVE_SUGGESTION_PROMPT);
  }, [liveSuggestionPrompt]);

  useEffect(() => {
    detailAnswerPromptRef.current = resolvePrompt(detailAnswerPrompt, DEFAULT_DETAIL_ANSWER_PROMPT);
  }, [detailAnswerPrompt]);

  useEffect(() => {
    chatPromptRef.current = resolvePrompt(chatPrompt, DEFAULT_CHAT_PROMPT);
  }, [chatPrompt]);

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
    chatMessagesRef.current = chatMessages;

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
      currentSegmentStartedAtRef.current = null;
    };
  }, []);

  return (
    <>
      <div className="topbar">
        <h1>MeetMind — Live Suggestions</h1>
        <div className="topbar-actions">
          <div className="meta">3-column layout · Transcript · Live Suggestions · Chat</div>
          <button
            className="settings-btn"
            disabled={transcriptLines.length === 0 && renderedBatches.length === 0 && chatMessages.length === 0}
            onClick={handleExportSession}
            type="button"
          >
            Export
          </button>
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

              <label className="settings-field" htmlFor="transcriptionLanguage">
                <span>Transcript language</span>
                <input
                  id="transcriptionLanguage"
                  onChange={(event) => setTranscriptionLanguage(event.target.value)}
                  value={transcriptionLanguage}
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

              <label className="settings-field" htmlFor="suggestionContextLines">
                <span>Live suggestion context window</span>
                <div className="number-input-wrap">
                  <input
                    id="suggestionContextLines"
                    max={MAX_CONTEXT_LINES}
                    min={MIN_CONTEXT_LINES}
                    onChange={(event) => handleSuggestionContextLinesChange(event.target.value)}
                    step={1}
                    type="number"
                    value={suggestionContextLines}
                  />
                  <span>lines</span>
                </div>
              </label>

              <label className="settings-field" htmlFor="detailContextLines">
                <span>Expanded answer context window</span>
                <div className="number-input-wrap">
                  <input
                    id="detailContextLines"
                    max={MAX_CONTEXT_LINES}
                    min={MIN_CONTEXT_LINES}
                    onChange={(event) => handleDetailContextLinesChange(event.target.value)}
                    step={1}
                    type="number"
                    value={detailContextLines}
                  />
                  <span>lines</span>
                </div>
              </label>

              <label className="settings-field settings-field-wide" htmlFor="liveSuggestionPrompt">
                <span>Live suggestion prompt</span>
                <textarea
                  id="liveSuggestionPrompt"
                  onChange={(event) => setLiveSuggestionPrompt(event.target.value)}
                  rows={5}
                  value={liveSuggestionPrompt}
                />
              </label>

              <label className="settings-field settings-field-wide" htmlFor="detailAnswerPrompt">
                <span>Detailed answer prompt</span>
                <textarea
                  id="detailAnswerPrompt"
                  onChange={(event) => setDetailAnswerPrompt(event.target.value)}
                  rows={5}
                  value={detailAnswerPrompt}
                />
              </label>

              <label className="settings-field settings-field-wide" htmlFor="chatPrompt">
                <span>Chat prompt</span>
                <textarea
                  id="chatPrompt"
                  onChange={(event) => setChatPrompt(event.target.value)}
                  rows={5}
                  value={chatPrompt}
                />
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
              recording. Audio is captured from the mic and transcribed with Groq Whisper Large V3 using
              language {transcriptionLanguage || DEFAULT_TRANSCRIPTION_LANGUAGE}.
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
              {refreshingTranscript
                ? "updating transcript"
                : suggestionsLoading
                ? "generating"
                : `${renderedBatches.length} batch${renderedBatches.length === 1 ? "" : "es"}`}
            </span>
          </header>
          <div className="reload-row">
            <button
              className="reload-btn"
              disabled={refreshingTranscript || suggestionsLoading}
              id="reloadBtn"
              type="button"
              onClick={handleReload}
            >
              {refreshingTranscript ? "Updating..." : suggestionsLoading ? "Generating..." : "↻ Refresh"}
            </button>
            <span className={`countdown${suggestionsError ? " status-error" : ""}`} id="countdown">
              {refreshingTranscript
                ? "transcribing latest audio"
                : suggestionsLoading
                ? "calling Groq"
                : recording
                  ? `auto-refresh in ${countdown}s`
                  : `auto every ~${chunkIntervalSeconds}s while recording`}
            </span>
          </div>
          <div className="body" id="suggestionsBody">
            <div className="help-banner">
              On reload (or auto every ~{chunkIntervalSeconds}s), generate <b>3 fresh suggestions</b> from recent transcript
              context using the latest {suggestionContextLines} lines. New batch appears at the top; older batches push down (faded). Each is a tappable
              card: a <span className="accent-text">question to ask</span>, a{" "}
              <span className="accent-2-text">talking point</span>, an{" "}
              <span className="good-text">answer</span>, a <span className="warn-text">fact-check</span>, or{" "}
              <span className="clarifying-text">clarifying info</span>.
              The preview alone should already be useful.
            </div>
            {suggestionsError ? <div className="suggestion-error">{suggestionsError}</div> : null}
            {renderedBatches.length === 0 ? (
              <div className="empty" id="suggestionsEmpty">
                {refreshingTranscript
                  ? "Updating transcript before suggestions..."
                  : suggestionsLoading
                    ? "Generating suggestions from recent transcript..."
                    : "Suggestions appear here once transcript text is available."}
              </div>
            ) : (
              renderedBatches.map((batch, batchPosition) => (
                <div key={batch.id}>
                  {batch.suggestions.map((suggestion) => (
                    <button
                      className={`suggestion ${batchPosition === 0 ? "fresh" : "stale"}`}
                      disabled={chatLoading}
                      key={`${batch.id}-${suggestion.type}-${suggestion.text}`}
                      onClick={() => void sendToChat(suggestion.text, suggestion.type)}
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
            <span>{chatLoading ? "thinking" : "session-only"}</span>
          </header>
          <div className="body" id="chatBody" ref={chatBodyRef}>
            <div className="help-banner">
              Clicking a suggestion adds it to this chat and returns a detailed answer using the full transcript
              context. User can also type questions directly. One continuous chat per session — no login, no
              persistence.
            </div>
            {chatError ? <div className="chat-error">{chatError}</div> : null}
            {chatMessages.length === 0 ? (
              <div className="empty" id="chatEmpty">
                {chatLoading ? "Generating an answer..." : "Click a suggestion or type a question below."}
              </div>
            ) : (
              <>
                {chatMessages.map((message) => (
                  <div className={`chat-msg ${message.who}`} key={message.id}>
                    <div className="who">
                      {message.who === "user" ? (message.label ? `You · ${message.label}` : "You") : "Assistant"} · {message.time}
                    </div>
                    <div className="bubble">
                      <FormattedChatText text={message.text} />
                    </div>
                  </div>
                ))}
                {chatLoading ? (
                  <div className="chat-msg ai pending">
                    <div className="who">Assistant</div>
                    <div className="bubble">Thinking through the transcript...</div>
                  </div>
                ) : null}
              </>
            )}
          </div>
          <div className="chat-input-row">
            <input
              disabled={chatLoading}
              id="chatInput"
              onChange={(event) => setChatInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleChatSend();
                }
              }}
              placeholder="Ask anything about the conversation..."
              value={chatInput}
            />
            <button disabled={chatLoading} id="chatSend" onClick={handleChatSend} type="button">
              {chatLoading ? "Thinking..." : "Send"}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
