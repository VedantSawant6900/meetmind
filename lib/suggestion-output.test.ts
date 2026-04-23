import { describe, expect, it } from "vitest";
import { parseSuggestions } from "./suggestion-output";
import { buildSuggestionPlan } from "./suggestion-strategy";

const plan = buildSuggestionPlan({
  mode: "decision",
  explicitQuestions: ["[10:02:00] Who owns launch readiness?"],
  likelyOpenQuestions: [],
  decisions: ["[10:01:15] We need to decide whether the launch stays on Friday."],
  blockers: ["[10:01:40] Legal review is still blocking the release."],
  actionItems: ["[10:02:20] We need an owner for final launch approval."],
  verificationCandidates: ["[10:02:35] The team said Friday is still feasible."],
  clarificationTerms: [],
  uncertaintyPhrases: ["not sure"],
});

describe("parseSuggestions", () => {
  it("accepts valid JSON and normalizes known type aliases", () => {
    const result = parseSuggestions(
      JSON.stringify({
        suggestions: [
          { type: "question", text: "Ask who owns final launch readiness before Friday." },
          { type: "talking", text: "Say legal review is the blocker and ask for a concrete unblock date." },
          { type: "fact-check", text: "Verify whether Friday is still feasible given the pending legal review." },
        ],
      }),
      plan,
    );

    expect(result).toEqual([
      { type: "question", text: "Ask who owns final launch readiness before Friday." },
      { type: "talking", text: "Say legal review is the blocker and ask for a concrete unblock date." },
      { type: "fact", text: "Verify whether Friday is still feasible given the pending legal review." },
    ]);
  });

  it("rejects generic suggestions", () => {
    expect(() =>
      parseSuggestions(
        JSON.stringify({
          suggestions: [
            { type: "question", text: "Discuss timeline" },
            { type: "talking", text: "Review next steps" },
            { type: "fact", text: "Ask for clarification" },
          ],
        }),
        plan,
      ),
    ).toThrow(/too generic/i);
  });

  it("rejects outputs that miss required meeting-state types", () => {
    expect(() =>
      parseSuggestions(
        JSON.stringify({
          suggestions: [
            { type: "talking", text: "Say launch ownership still needs to be assigned before legal sign-off." },
            { type: "answer", text: "The most likely answer is that launch is blocked until legal approves." },
            { type: "fact", text: "Verify whether Friday is still realistic given the current blocker." },
          ],
        }),
        plan,
      ),
    ).toThrow(/missing required suggestion types/i);
  });

  it("rejects near-duplicate suggestion angles", () => {
    expect(() =>
      parseSuggestions(
        JSON.stringify({
          suggestions: [
            { type: "question", text: "Ask who owns launch readiness before Friday." },
            { type: "talking", text: "Say the team still needs an owner for launch readiness before Friday." },
            { type: "fact", text: "Verify whether Friday is still feasible given legal review." },
          ],
        }),
        plan,
      ),
    ).toThrow(/too similar/i);
  });
});
