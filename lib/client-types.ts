import type { SuggestionType } from "./suggestion-strategy";

export type Suggestion = {
  type: SuggestionType;
  text: string;
};

export type SelectionPlanSlot = {
  type: SuggestionType;
  reason: string;
  required: boolean;
};

export type TranscriptLine = {
  id: number;
  time: string;
  text: string;
  startedAt: string;
  endedAt: string;
};

export type RenderedBatch = {
  id: number;
  batchNumber: number;
  time: string;
  createdAt: string;
  suggestions: Suggestion[];
  rationale?: string;
  meetingMode?: string;
  meetingModeLabel?: string;
  selectionPlan?: SelectionPlanSlot[];
};

export type ChatMessage = {
  id: number;
  who: "user" | "ai";
  text: string;
  time: string;
  createdAt: string;
  label?: string;
};

export type TranscriptionQuality = {
  segmentCount?: number;
  noSpeechProbability?: number | null;
  avgLogprob?: number | null;
  maxCompressionRatio?: number | null;
};

export type AudioChunkStats = {
  audioType: string;
  audioSize: number;
  durationMs: number;
  speechSamples: number;
  totalSamples: number;
  maxRms: number;
};

export type TranscriptFilterContext = {
  audioStats?: AudioChunkStats;
  quality?: TranscriptionQuality;
};

export type StoredSettings = {
  settingsVersion?: number;
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

export type SuggestionsResponse = {
  suggestions?: Suggestion[];
  rationale?: string;
  meetingMode?: string;
  meetingModeLabel?: string;
  selectionPlan?: SelectionPlanSlot[];
  error?: string;
};

export type ChatResponse = {
  answer?: string;
  finishReason?: string | null;
  error?: string;
};

export type ConfigResponse = {
  hasServerGroqKey?: boolean;
};

export type TranscriptionResponse = {
  text?: string;
  error?: string;
  quality?: TranscriptionQuality;
};

export type RefreshPhase = "idle" | "transcribing" | "generating";

export type QueuedChatRequest = {
  text: string;
  type?: SuggestionType;
};
