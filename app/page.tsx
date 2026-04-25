"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatPanel } from "../components/ChatPanel";
import { SettingsModal } from "../components/SettingsModal";
import { SuggestionsPanel } from "../components/SuggestionsPanel";
import { TopBar } from "../components/TopBar";
import { TranscriptPanel } from "../components/TranscriptPanel";
import { useCurrentTime } from "../hooks/useCurrentTime";
import { useServerGroqKey } from "../hooks/useServerGroqKey";
import {
  AUDIO_ACTIVITY_SAMPLE_MS,
  MIN_AUDIO_CHUNK_BYTES,
  MIN_AUDIO_CHUNK_MS,
  MIN_SPEECH_RMS,
  MIN_SPEECH_SAMPLES,
  extensionForMimeType,
  getMicrophonePermissionState,
  getPreferredMimeType,
  microphoneErrorMessage,
  transcriptionErrorMessage,
} from "../lib/audio-client";
import {
  DEFAULT_CHUNK_INTERVAL_SECONDS,
  DEFAULT_DETAIL_CONTEXT_LINES,
  DEFAULT_SUGGESTION_CONTEXT_LINES,
  DEFAULT_SUGGESTION_MODEL,
  DEFAULT_TRANSCRIPTION_LANGUAGE,
  DEFAULT_WHISPER_MODEL,
  LEGACY_GROQ_KEY_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  SETTINGS_SCHEMA_VERSION,
  AUTO_TRANSCRIPTION_LANGUAGE_LABEL,
  clampChunkInterval,
  clampContextLines,
  getDetailServerTranscriptLineLimit,
  getSuggestionServerTranscriptLineLimit,
  parseStoredSettings,
  resolvePrompt,
} from "../lib/client-config";
import { formatRelativeAge, labelFor, timestamp, truncatePreview } from "../lib/client-formatters";
import { emitClientLog } from "../lib/client-logger";
import type {
  AudioChunkStats,
  ChatMessage,
  ChatResponse,
  QueuedChatRequest,
  RefreshPhase,
  RenderedBatch,
  StoredSettings,
  SuggestionsResponse,
  TranscriptFilterContext,
  TranscriptLine,
  TranscriptionResponse,
} from "../lib/client-types";
import {
  DEFAULT_CHAT_PROMPT,
  DEFAULT_DETAIL_ANSWER_PROMPT,
  DEFAULT_LIVE_SUGGESTION_PROMPT,
} from "../lib/default-prompts";
import { getTranscriptFilterReason } from "../lib/transcript-filter";
import type { SuggestionType } from "../lib/suggestion-strategy";

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
  const [queuedChatRequest, setQueuedChatRequest] = useState<QueuedChatRequest | null>(null);
  const [countdown, setCountdown] = useState(DEFAULT_CHUNK_INTERVAL_SECONDS);
  const [refreshPhase, setRefreshPhase] = useState<RefreshPhase>("idle");

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
  const queuedChatRequestRef = useRef<QueuedChatRequest | null>(null);
  const sendToChatRef = useRef<((text: string, type?: SuggestionType) => Promise<void>) | null>(null);
  const transcriptBodyRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);

  const nowMs = useCurrentTime();
  const { serverGroqKeyAvailable, serverGroqKeyAvailableRef } = useServerGroqKey();

  const localApiKeyReady = groqApiKey.trim().length > 0;
  const apiKeyReady = localApiKeyReady || serverGroqKeyAvailable;

  const generateSuggestionBatch = useCallback(async (trigger: "auto" | "manual") => {
    if (suggestionsLoadingRef.current) {
      return;
    }

    const apiKey = groqApiKeyRef.current;

    if (!apiKey && !serverGroqKeyAvailableRef.current) {
      setSuggestionsError("Open Settings to add your Groq API key before generating suggestions.");
      emitClientLog("suggestions", "suggestions_blocked_missing_api_key", { trigger });
      return;
    }

    const contextLineLimit = suggestionContextLinesRef.current;
    const serverTranscriptLineLimit = getSuggestionServerTranscriptLineLimit(contextLineLimit);
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
      const headers: HeadersInit = {
        "Content-Type": "application/json",
      };

      if (apiKey) {
        headers["x-groq-api-key"] = apiKey;
      }

      const response = await fetch("/api/suggestions", {
        method: "POST",
        headers,
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
          rationale: payload?.rationale?.trim() || undefined,
          meetingMode: payload?.meetingMode,
          meetingModeLabel: payload?.meetingModeLabel,
          selectionPlan: payload?.selectionPlan,
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
      const nextLines = [...currentLines, line];

      transcriptLinesRef.current = nextLines;
      setTranscriptLines(nextLines);

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

      if (!apiKey && !serverGroqKeyAvailableRef.current) {
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
        const language = transcriptionLanguageRef.current.trim();

        formData.append("audio", blob, fileName);
        formData.append("model", model);
        if (language) {
          formData.append("language", language);
        }

        emitClientLog("transcription", "transcription_request_started", {
          fileName,
          model,
          language: language || AUTO_TRANSCRIPTION_LANGUAGE_LABEL,
          audioType: mimeType,
          audioSize: blob.size,
          startedAt: startedAt.toISOString(),
          endedAt: endedAt.toISOString(),
          audioStats,
        });

        const headers: HeadersInit = {};

        if (apiKey) {
          headers["x-groq-api-key"] = apiKey;
        }

        const response = await fetch("/api/transcribe", {
          method: "POST",
          headers,
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

        if (!shouldContinueRecordingRef.current && transcriptionTask) {
          void transcriptionTask.then(() => {
            if (!suggestionsLoadingRef.current && transcriptLinesRef.current.length > 0) {
              void generateSuggestionBatch("auto");
            }
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
      generateSuggestionBatch,
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
      setRefreshPhase("transcribing");
      setSuggestionsError(null);
      setCountdown(chunkIntervalSecondsRef.current);

      try {
        await flushCurrentRecordingSegment(trigger);
        setRefreshPhase("generating");
        await generateSuggestionBatch(trigger);
      } finally {
        refreshingTranscriptRef.current = false;
        setRefreshingTranscript(false);
        setRefreshPhase("idle");
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

      if (!question) {
        return;
      }

      if (chatLoadingRef.current) {
        const nextQueuedRequest = { text: question, type };

        queuedChatRequestRef.current = nextQueuedRequest;
        setQueuedChatRequest(nextQueuedRequest);
        setChatError(null);
        emitClientLog("chat", "chat_request_queued", {
          suggestionType: type,
          questionLength: question.length,
        });
        return;
      }

      const apiKey = groqApiKeyRef.current;

      if (!apiKey && !serverGroqKeyAvailableRef.current) {
        setChatError("Open Settings to add your Groq API key before using chat.");
        emitClientLog("chat", "chat_blocked_missing_api_key");
        return;
      }

      const label = type ? labelFor(type) : undefined;
      const model = suggestionModelRef.current || DEFAULT_SUGGESTION_MODEL;
      const transcriptContextLimit = detailContextLinesRef.current;
      const serverTranscriptLineLimit = getDetailServerTranscriptLineLimit(transcriptContextLimit);
      const transcriptContext = transcriptLinesRef.current.slice(-serverTranscriptLineLimit);
      const chatHistory = chatMessagesRef.current.slice(-12);
      const systemPrompt = type
        ? resolvePrompt(detailAnswerPromptRef.current, DEFAULT_DETAIL_ANSWER_PROMPT)
        : resolvePrompt(chatPromptRef.current, DEFAULT_CHAT_PROMPT);
      const requestedAt = new Date();

      setQueuedChatRequest(null);
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
        const headers: HeadersInit = {
          "Content-Type": "application/json",
        };

        if (apiKey) {
          headers["x-groq-api-key"] = apiKey;
        }

        const response = await fetch("/api/chat", {
          method: "POST",
          headers,
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

        const nextQueuedRequest = queuedChatRequestRef.current;

        if (nextQueuedRequest) {
          queuedChatRequestRef.current = null;
          setQueuedChatRequest(null);
          emitClientLog("chat", "chat_request_dequeued", {
            suggestionType: nextQueuedRequest.type,
            questionLength: nextQueuedRequest.text.length,
          });
          void sendToChatRef.current?.(nextQueuedRequest.text, nextQueuedRequest.type);
        }
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

    emitClientLog("app", "settings_reset_defaults", {
      resetDeveloperSettings: true,
    });

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

  const latestBatch = renderedBatches[0] ?? null;

  const suggestionPhaseLabel = useMemo(() => {
    if (refreshPhase === "transcribing") {
      return "Listening -> Transcribing";
    }

    if (refreshPhase === "generating") {
      return "Listening -> Transcribing -> Generating suggestions";
    }

    if (recording) {
      return "Listening";
    }

    return "Ready";
  }, [recording, refreshPhase]);

  const suggestionStatusDetail = useMemo(() => {
    if (refreshPhase === "transcribing") {
      return "Flushing the latest audio chunk before creating the next batch.";
    }

    if (refreshPhase === "generating") {
      return latestBatch ? `Generating a fresh batch. Last updated ${formatRelativeAge(latestBatch.createdAt, nowMs)}.` : "Generating a fresh batch.";
    }

    if (latestBatch) {
      return `Last updated ${formatRelativeAge(latestBatch.createdAt, nowMs)}.`;
    }

    return recording ? `Auto-refresh in ${countdown}s.` : `Auto every ~${chunkIntervalSeconds}s while recording.`;
  }, [chunkIntervalSeconds, countdown, latestBatch, nowMs, recording, refreshPhase]);

  const chatHeaderStatus = useMemo(() => {
    if (chatLoading && queuedChatRequest) {
      return "thinking + 1 queued";
    }

    if (chatLoading) {
      return "thinking";
    }

    if (queuedChatRequest) {
      return "1 queued";
    }

    return "session-only";
  }, [chatLoading, queuedChatRequest]);

  const queuedChatLabel = useMemo(() => {
    if (!queuedChatRequest) {
      return null;
    }

    const prefix = queuedChatRequest.type ? labelFor(queuedChatRequest.type) : "Typed question";
    return `${prefix} queued: ${truncatePreview(queuedChatRequest.text, 54)}`;
  }, [queuedChatRequest]);

  useEffect(() => {
    const storedSettings = parseStoredSettings(window.sessionStorage.getItem(SETTINGS_STORAGE_KEY));
    const storedLegacyKey = window.sessionStorage.getItem(LEGACY_GROQ_KEY_STORAGE_KEY);
    const promptSettingsAreCurrent = storedSettings?.settingsVersion === SETTINGS_SCHEMA_VERSION;

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

    if (promptSettingsAreCurrent && storedSettings?.liveSuggestionPrompt) {
      setLiveSuggestionPrompt(storedSettings.liveSuggestionPrompt);
    }

    if (promptSettingsAreCurrent && storedSettings?.detailAnswerPrompt) {
      setDetailAnswerPrompt(storedSettings.detailAnswerPrompt);
    }

    if (promptSettingsAreCurrent && storedSettings?.chatPrompt) {
      setChatPrompt(storedSettings.chatPrompt);
    }

    emitClientLog("app", "app_loaded", {
      restoredSettings: Boolean(storedSettings),
      restoredLegacyKey: Boolean(storedLegacyKey),
    });
  }, []);

  useEffect(() => {
    const settings: StoredSettings = {
      settingsVersion: SETTINGS_SCHEMA_VERSION,
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
    transcriptionLanguageRef.current = transcriptionLanguage.trim();
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
    sendToChatRef.current = sendToChat;
  }, [sendToChat]);

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
      <TopBar
        exportDisabled={transcriptLines.length === 0 && renderedBatches.length === 0 && chatMessages.length === 0}
        onExport={handleExportSession}
        onOpenSettings={() => setSettingsOpen(true)}
      />

      <SettingsModal
        open={settingsOpen}
        groqApiKey={groqApiKey}
        localApiKeyReady={localApiKeyReady}
        serverGroqKeyAvailable={serverGroqKeyAvailable}
        whisperModel={whisperModel}
        transcriptionLanguage={transcriptionLanguage}
        suggestionModel={suggestionModel}
        chunkIntervalSeconds={chunkIntervalSeconds}
        suggestionContextLines={suggestionContextLines}
        detailContextLines={detailContextLines}
        liveSuggestionPrompt={liveSuggestionPrompt}
        detailAnswerPrompt={detailAnswerPrompt}
        chatPrompt={chatPrompt}
        onClose={handleCloseSettings}
        onGroqApiKeyChange={handleGroqApiKeyChange}
        onWhisperModelChange={setWhisperModel}
        onTranscriptionLanguageChange={setTranscriptionLanguage}
        onSuggestionModelChange={setSuggestionModel}
        onChunkIntervalChange={handleChunkIntervalChange}
        onSuggestionContextLinesChange={handleSuggestionContextLinesChange}
        onDetailContextLinesChange={handleDetailContextLinesChange}
        onLiveSuggestionPromptChange={setLiveSuggestionPrompt}
        onDetailAnswerPromptChange={setDetailAnswerPrompt}
        onChatPromptChange={setChatPrompt}
        onResetDefaults={handleResetDefaults}
      />

      <div className="layout">
        <TranscriptPanel
          recState={recState}
          recording={recording}
          requestingMic={requestingMic}
          micStatus={micStatus}
          transcriptionError={transcriptionError}
          chunkIntervalSeconds={chunkIntervalSeconds}
          transcriptionLanguage={transcriptionLanguage}
          transcriptLines={transcriptLines}
          transcriptBodyRef={transcriptBodyRef}
          onMicClick={handleMicClick}
        />

        <SuggestionsPanel
          refreshingTranscript={refreshingTranscript}
          suggestionsLoading={suggestionsLoading}
          renderedBatches={renderedBatches}
          suggestionPhaseLabel={suggestionPhaseLabel}
          suggestionStatusDetail={suggestionStatusDetail}
          suggestionsError={suggestionsError}
          transcriptLines={transcriptLines}
          chunkIntervalSeconds={chunkIntervalSeconds}
          suggestionContextLines={suggestionContextLines}
          nowMs={nowMs}
          chatLoading={chatLoading}
          onReload={() => void handleReload()}
          onSuggestionClick={(text, type) => {
            void sendToChat(text, type);
          }}
        />

        <ChatPanel
          chatHeaderStatus={chatHeaderStatus}
          chatBodyRef={chatBodyRef}
          queuedChatLabel={queuedChatLabel}
          chatError={chatError}
          chatMessages={chatMessages}
          chatLoading={chatLoading}
          chatInput={chatInput}
          onChatInputChange={setChatInput}
          onChatSend={handleChatSend}
        />
      </div>
    </>
  );
}
