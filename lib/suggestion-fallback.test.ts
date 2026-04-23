import { describe, expect, it } from "vitest";
import { validateSuggestionQuality } from "./suggestion-output";
import { buildFallbackSuggestions } from "./suggestion-fallback";
import { buildSuggestionPlan } from "./suggestion-strategy";

describe("suggestion-fallback", () => {
  it("builds a stable decision-mode fallback batch", () => {
    const cues = {
      mode: "decision" as const,
      explicitQuestions: ["[10:02] Can we commit to May 15 if the webhook lands by Tuesday?"],
      likelyOpenQuestions: [],
      decisions: ["[10:00] We need to decide whether to launch the beta on May 15 or push to June."],
      blockers: ["[10:01] Engineering is blocked on the billing webhook and QA still has three severity-two bugs."],
      actionItems: [],
      verificationCandidates: ["[10:03] Finance said the migration should cut infrastructure cost by 18 percent."],
      clarificationTerms: [],
      uncertaintyPhrases: [],
    };
    const plan = buildSuggestionPlan(cues);
    const suggestions = buildFallbackSuggestions(cues, plan);

    expect(suggestions).toHaveLength(3);
    expect(suggestions.map((suggestion) => suggestion.type)).toEqual(["question", "talking", "fact"]);
    expect(suggestions[2].text).toContain("18 percent");
    expect(validateSuggestionQuality(suggestions, plan)).toEqual([]);
  });

  it("keeps clarify-heavy meetings distinct by using a clarification-driven talking point", () => {
    const cues = {
      mode: "decision" as const,
      explicitQuestions: ["[12:02] Should we explain the tradeoff in latency versus relevance before we pick an approach?"],
      likelyOpenQuestions: [],
      decisions: ["[12:02] Should we explain the tradeoff in latency versus relevance before we pick an approach?"],
      blockers: [],
      actionItems: [],
      verificationCandidates: ["[12:03] The CTO said the current experiment improved answer quality by 11 percent."],
      clarificationTerms: ["hybrid retrieval"],
      uncertaintyPhrases: ["not sure"],
    };
    const plan = buildSuggestionPlan(cues);
    const suggestions = buildFallbackSuggestions(cues, plan);

    expect(suggestions).toHaveLength(3);
    expect(suggestions[1]).toEqual({
      type: "talking",
      text: expect.stringContaining("hybrid retrieval"),
    });
    expect(validateSuggestionQuality(suggestions, plan)).toEqual([]);
  });

  it("avoids reusing the same cue for talking and fact fallbacks", () => {
    const cues = {
      mode: "planning" as const,
      explicitQuestions: ["[11:02] What is the fastest way to unblock legal and keep the Friday deadline?"],
      likelyOpenQuestions: [],
      decisions: [],
      blockers: ["[11:01] Legal still has not approved the data retention language."],
      actionItems: ["[11:00] We promised the customer a revised onboarding plan by Friday."],
      verificationCandidates: [
        "[11:00] We promised the customer a revised onboarding plan by Friday.",
        "[11:03] If we miss Friday, the pilot start date moves to June 3.",
      ],
      clarificationTerms: [],
      uncertaintyPhrases: [],
    };
    const plan = buildSuggestionPlan(cues);
    const suggestions = buildFallbackSuggestions(cues, plan);

    expect(suggestions).toHaveLength(3);
    expect(suggestions[1].text).not.toEqual(suggestions[2].text);
    expect(validateSuggestionQuality(suggestions, plan)).toEqual([]);
  });
});
