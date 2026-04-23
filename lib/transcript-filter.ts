import type { AudioChunkStats, TranscriptFilterContext, TranscriptLine } from "./client-types";

const DUPLICATE_SIMILARITY_THRESHOLD = 0.86;
const WEAK_AUDIO_RMS = 0.03;
const WEAK_SPEECH_SAMPLE_RATIO = 0.18;
const HIGH_NO_SPEECH_PROBABILITY = 0.55;
const LOW_AVG_LOGPROB = -1.15;
const VERY_LOW_AVG_LOGPROB = -2;
const LOW_CONFIDENCE_FRAGMENT_AVG_LOGPROB = -0.85;
const LOW_CONFIDENCE_FRAGMENT_COMPRESSION_RATIO = 0.35;
const WEAK_ARTIFACT_NO_SPEECH_PROBABILITY = 0.15;

export function normalizeTranscriptText(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function textSimilarity(first: string, second: string) {
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

export function isLikelyWhisperOutroArtifact(text: string) {
  const normalized = normalizeTranscriptText(text);
  return /^(thank you|thank you for watching|you for watching|thanks for watching|thanks)$/.test(normalized);
}

export function isLikelySubtitleArtifact(text: string) {
  const normalized = normalizeTranscriptText(text);
  return /subtitles?/.test(normalized) || /dimatorzok/.test(normalized) || /[\u0400-\u04ff]/.test(text);
}

export function isLikelyNonEnglishShortArtifact(text: string) {
  const normalized = normalizeTranscriptText(text);
  const words = normalized.split(" ").filter(Boolean);
  return words.length > 0 && words.length <= 4 && /[^\u0000-\u007f]/.test(text);
}

export function isLowInformationFragment(text: string) {
  const words = normalizeTranscriptText(text).split(" ").filter(Boolean);

  if (words.length === 0) {
    return true;
  }

  if (words.length === 1 && words[0].length <= 10) {
    return true;
  }

  return words.length <= 2 && words.join("").length <= 14;
}

export function getSpeechSampleRatio(audioStats?: AudioChunkStats) {
  if (!audioStats || audioStats.totalSamples <= 0) {
    return null;
  }

  return audioStats.speechSamples / audioStats.totalSamples;
}

export function hasVeryLowConfidence(context?: TranscriptFilterContext) {
  return Boolean(
    typeof context?.quality?.avgLogprob === "number" &&
      context.quality.avgLogprob <= VERY_LOW_AVG_LOGPROB,
  );
}

export function hasWeakTranscriptSignal(context?: TranscriptFilterContext) {
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

export function hasWeakArtifactSignal(context?: TranscriptFilterContext) {
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

export function hasLowConfidenceFragmentSignal(context?: TranscriptFilterContext) {
  const quality = context?.quality;

  return Boolean(
    hasWeakTranscriptSignal(context) ||
      (typeof quality?.avgLogprob === "number" &&
        quality.avgLogprob <= LOW_CONFIDENCE_FRAGMENT_AVG_LOGPROB &&
        typeof quality?.maxCompressionRatio === "number" &&
        quality.maxCompressionRatio <= LOW_CONFIDENCE_FRAGMENT_COMPRESSION_RATIO),
  );
}

export function getTranscriptFilterReason(text: string, recentLines: TranscriptLine[], context?: TranscriptFilterContext) {
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
