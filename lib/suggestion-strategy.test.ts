import { describe, expect, it } from "vitest";
import { buildSuggestionPlan } from "./suggestion-strategy";

describe("suggestion-strategy", () => {
  it("prioritizes question, talking, and fact slots when the meeting has those cues", () => {
    const plan = buildSuggestionPlan({
      mode: "problem solving",
      explicitQuestions: ["[10:04:00] What is blocking the migration?"],
      likelyOpenQuestions: [],
      decisions: ["[10:04:10] We need to decide whether to cut scope."],
      blockers: ["[10:04:20] The data migration is blocked on missing credentials."],
      actionItems: ["[10:04:35] Someone needs to own the credential request today."],
      verificationCandidates: ["[10:04:45] The team said the migration can still finish today."],
      clarificationTerms: [],
      uncertaintyPhrases: ["not sure"],
    });

    expect(plan.meetingModeLabel).toBe("Problem-solving mode");
    expect(plan.slots.map((slot) => slot.type)).toEqual(["question", "talking", "fact"]);
    expect(plan.requiredTypes).toEqual(["question", "talking", "fact"]);
    expect(plan.shortSummary).toContain("open question");
    expect(plan.shortSummary).toContain("blocker");
  });

  it("falls back to clarification when jargon is the main useful signal", () => {
    const plan = buildSuggestionPlan({
      mode: "brainstorming",
      explicitQuestions: [],
      likelyOpenQuestions: [],
      decisions: [],
      blockers: [],
      actionItems: [],
      verificationCandidates: [],
      clarificationTerms: ["RAG"],
      uncertaintyPhrases: [],
    });

    expect(plan.slots.some((slot) => slot.type === "clarifying")).toBe(true);
    expect(plan.meetingModeLabel).toBe("Brainstorming mode");
  });
});
