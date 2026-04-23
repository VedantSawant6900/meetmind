import { describe, expect, it } from "vitest";
import { buildMeetingContext, extractMeetingCues } from "./meeting-context";

describe("meeting-context", () => {
  it("extracts high-value cues from recent transcript lines", () => {
    const cues = extractMeetingCues([
      { time: "10:00:01", text: "What is blocking the Friday rollout?" },
      { time: "10:00:12", text: "We need to decide whether to slip launch if legal approval is late." },
      { time: "10:00:24", text: "The blocker is that legal has not approved the pricing copy yet." },
      { time: "10:00:36", text: "Can you own the final approval follow up by Thursday?" },
      { time: "10:00:48", text: "I think Friday is still possible, but we need to check with legal." },
    ]);

    expect(cues.explicitQuestions[0]).toContain("What is blocking the Friday rollout?");
    expect(cues.decisions[0]).toContain("decide whether to slip launch");
    expect(cues.blockers[0]).toContain("blocker");
    expect(cues.actionItems[0]).toContain("own the final approval");
    expect(cues.verificationCandidates[0]).toContain("Friday is still possible");
    expect(cues.mode).toBe("decision");
  });

  it("keeps older relevant context when it matches the recent discussion", () => {
    const context = buildMeetingContext(
      [
        { time: "09:58:00", text: "The Europe rollout depends on legal approving the localized pricing copy." },
        { time: "09:58:30", text: "Marketing already booked the Friday announcement slot." },
        { time: "10:00:00", text: "Who owns the final Europe launch approval?" },
        { time: "10:00:15", text: "We still need a legal unblock date before deciding on Friday." },
      ],
      {
        recentLineCount: 2,
        olderLineCount: 2,
        relevanceQuery: "Europe launch legal approval Friday",
      },
    );

    expect(context.mostRecentTranscript).toContain("Who owns the final Europe launch approval?");
    expect(context.olderRelevantTranscript).toContain("Europe rollout depends on legal approving");
  });
});
