import { describe, expect, it } from "vitest";
import { getTranscriptFilterReason } from "./transcript-filter";

describe("transcript-filter", () => {
  it("drops duplicate transcript lines", () => {
    const reason = getTranscriptFilterReason(
      "We need legal approval before Friday launch.",
      [
        {
          id: 1,
          time: "10:00:00",
          text: "We need legal approval before Friday launch.",
          startedAt: "2026-04-23T10:00:00.000Z",
          endedAt: "2026-04-23T10:00:05.000Z",
        },
      ],
    );

    expect(reason).toBe("duplicate");
  });

  it("drops subtitle artifacts when the confidence signal is weak", () => {
    const reason = getTranscriptFilterReason(
      "Subtitles by DimaTorzok",
      [],
      {
        audioStats: {
          audioType: "audio/webm",
          audioSize: 4096,
          durationMs: 2_000,
          speechSamples: 0,
          totalSamples: 10,
          maxRms: 0.01,
        },
        quality: {
          noSpeechProbability: 0.8,
          avgLogprob: -1.4,
          maxCompressionRatio: 0.2,
        },
      },
    );

    expect(reason).toBe("subtitle_artifact_weak_signal");
  });

  it("drops very short low-confidence fragments", () => {
    const reason = getTranscriptFilterReason(
      "yeah",
      [],
      {
        audioStats: {
          audioType: "audio/webm",
          audioSize: 3000,
          durationMs: 1500,
          speechSamples: 1,
          totalSamples: 10,
          maxRms: 0.02,
        },
        quality: {
          noSpeechProbability: 0.2,
          avgLogprob: -1.1,
          maxCompressionRatio: 0.2,
        },
      },
    );

    expect(reason).toBe("low_information_weak_signal");
  });
});
