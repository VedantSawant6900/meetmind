import type { Suggestion } from "./client-types";
import type { MeetingCues } from "./meeting-context";
import { SUGGESTION_PREVIEW_WORD_LIMIT } from "./suggestion-output";
import type { SuggestionPlan, SuggestionType } from "./suggestion-strategy";
import { VALID_SUGGESTION_TYPES } from "./suggestion-strategy";

const QUESTION_START_PATTERN =
  /^(?:what|why|how|when|who|where|which|should|could|can|do|does|did|is|are|will|would)\b/i;
const SPECIFICITY_PATTERN =
  /\b(?:\$?\d+(?:[.,]\d+)*(?:\.\d+)?%?|today|tomorrow|friday|monday|tuesday|wednesday|thursday|saturday|sunday|january|february|march|april|may|june|july|august|september|october|november|december)\b/i;
const IGNORED_CLARIFICATION_TERMS = new Set(["CEO", "CFO", "COO", "CTO", "CIO", "CMO", "VP"]);
const CLAIM_SIGNAL_PATTERN =
  /\b(?:said|claim|claimed|estimate|estimated|forecast|forecasted|depends on|assuming|target|cut|increase|decrease|save|saves|gain|gains)\b/i;

type SuggestionCandidate = {
  text: string;
  reference?: string;
};

function stripCuePrefix(value: string) {
  return value.replace(/^\[[^\]]+\]\s*/, "").replace(/\s+/g, " ").trim();
}

function stripTrailingPunctuation(value: string) {
  return value.replace(/[.?!,:;]+$/g, "").trim();
}

function lowerCaseFirst(value: string) {
  if (!value) {
    return value;
  }

  return `${value[0].toLowerCase()}${value.slice(1)}`;
}

function limitSuggestionWords(value: string) {
  const words = value.split(/\s+/).filter(Boolean);

  if (words.length <= SUGGESTION_PREVIEW_WORD_LIMIT) {
    return value.trim();
  }

  return words.slice(0, SUGGESTION_PREVIEW_WORD_LIMIT).join(" ").trim();
}

function isQuestionLike(value: string) {
  return QUESTION_START_PATTERN.test(value) || value.endsWith("?");
}

function hasSpecificitySignal(value: string) {
  return SPECIFICITY_PATTERN.test(value);
}

function normalizeReference(value: string) {
  return stripCuePrefix(value).toLowerCase();
}

function pickCue(values: string[], options?: { avoidQuestionLike?: boolean; exclude?: string[]; preferSpecific?: boolean }) {
  const cleanValues = values.map(stripCuePrefix).filter(Boolean);
  const exclude = new Set((options?.exclude ?? []).map((value) => normalizeReference(value)));
  const filteredValues = cleanValues.filter((value) => !exclude.has(normalizeReference(value)));

  const candidates = filteredValues.length > 0 ? filteredValues : cleanValues;

  const orderedCandidates = options?.preferSpecific
    ? [...candidates].sort((first, second) => Number(hasSpecificitySignal(second)) - Number(hasSpecificitySignal(first)))
    : candidates;

  if (options?.avoidQuestionLike) {
    return orderedCandidates.find((value) => !isQuestionLike(value)) ?? orderedCandidates[0] ?? "";
  }

  return orderedCandidates[0] ?? "";
}

function scoreFactCue(value: string) {
  let score = 0;

  if (/\b\d+(?:[.,]\d+)*(?:\.\d+)?%?\b/.test(value) || /\$/.test(value)) {
    score += 3;
  }

  if (CLAIM_SIGNAL_PATTERN.test(value)) {
    score += 3;
  }

  if (hasSpecificitySignal(value)) {
    score += 1;
  }

  return score;
}

function pickFactCue(values: string[], exclude: string[]) {
  const cleanValues = values.map(stripCuePrefix).filter(Boolean);
  const excluded = new Set(exclude.map((value) => normalizeReference(value)));
  const candidates = cleanValues.filter((value) => !excluded.has(normalizeReference(value)));
  const orderedCandidates = [...(candidates.length > 0 ? candidates : cleanValues)].sort(
    (first, second) => scoreFactCue(second) - scoreFactCue(first),
  );

  return orderedCandidates[0] ?? "";
}

function quoteTerm(term: string) {
  const trimmed = term.trim();
  return trimmed.includes(" ") || trimmed.includes("-") ? `"${trimmed}"` : trimmed;
}

function pickClarificationTerm(cues: MeetingCues) {
  return cues.clarificationTerms.find((term) => {
    const trimmed = term.trim();
    return trimmed.length > 2 && !IGNORED_CLARIFICATION_TERMS.has(trimmed);
  }) ?? "";
}

function getTradeoffTalkingLine(cues: MeetingCues) {
  const combined = [...cues.explicitQuestions, ...cues.likelyOpenQuestions, ...cues.decisions]
    .map(stripCuePrefix)
    .join(" ");

  if (/\blatency\b/i.test(combined) && /\brelevance\b/i.test(combined)) {
    return "Say the decision should wait until the team agrees what matters more: latency or answer quality.";
  }

  if (/\btrade-?off\b/i.test(combined)) {
    return "Say the decision should wait until the team agrees on the key tradeoff.";
  }

  return "";
}

function buildQuestionSuggestion(cues: MeetingCues): SuggestionCandidate {
  const explicitQuestion = pickCue(cues.explicitQuestions);

  if (explicitQuestion) {
    return {
      text: limitSuggestionWords(
        explicitQuestion.endsWith("?") ? explicitQuestion : `${stripTrailingPunctuation(explicitQuestion)}?`,
      ),
      reference: explicitQuestion,
    };
  }

  const openQuestion = pickCue(cues.likelyOpenQuestions);

  if (openQuestion) {
    return {
      text: limitSuggestionWords(openQuestion.endsWith("?") ? openQuestion : `${stripTrailingPunctuation(openQuestion)}?`),
      reference: openQuestion,
    };
  }

  const blocker = pickCue(cues.blockers, { avoidQuestionLike: true });

  if (blocker) {
    return {
      text: limitSuggestionWords(`What needs to happen next to unblock ${lowerCaseFirst(stripTrailingPunctuation(blocker))}?`),
      reference: blocker,
    };
  }

  const decision = pickCue(cues.decisions, { avoidQuestionLike: true });

  if (decision) {
    return {
      text: limitSuggestionWords(`What decision do we need to make now on ${lowerCaseFirst(stripTrailingPunctuation(decision))}?`),
      reference: decision,
    };
  }

  return {
    text: "What should the user ask next to move this discussion forward?",
  };
}

function buildTalkingSuggestion(cues: MeetingCues, usedReferences: string[]): SuggestionCandidate {
  const blocker = pickCue(cues.blockers, { avoidQuestionLike: true, exclude: usedReferences });

  if (blocker) {
    return {
      text: limitSuggestionWords(`Say the blocker plainly: ${stripTrailingPunctuation(blocker)}`),
      reference: blocker,
    };
  }

  const actionItem = pickCue(cues.actionItems, { avoidQuestionLike: true, exclude: usedReferences });

  if (actionItem) {
    return {
      text: limitSuggestionWords(`Push for an owner and date on this next step: ${stripTrailingPunctuation(actionItem)}`),
      reference: actionItem,
    };
  }

  const clarificationTerm = pickClarificationTerm(cues);

  if (clarificationTerm) {
    return {
      text: limitSuggestionWords(
        `Say the choice depends on defining ${quoteTerm(clarificationTerm)} before the team commits.`,
      ),
      reference: clarificationTerm,
    };
  }

  const tradeoffLine = getTradeoffTalkingLine(cues);

  if (tradeoffLine) {
    return {
      text: limitSuggestionWords(tradeoffLine),
      reference: tradeoffLine,
    };
  }

  const decision = pickCue(cues.decisions, { avoidQuestionLike: true, exclude: usedReferences });

  if (decision) {
    return {
      text: limitSuggestionWords(`Frame the decision clearly: ${stripTrailingPunctuation(decision)}`),
      reference: decision,
    };
  }

  return {
    text: "Say the main tradeoff out loud before the next turn.",
  };
}

function buildAnswerSuggestion(cues: MeetingCues, usedReferences: string[]): SuggestionCandidate {
  const blocker = pickCue(cues.blockers, { avoidQuestionLike: true, exclude: usedReferences });

  if (blocker) {
    return {
      text: limitSuggestionWords(`Most likely answer: not yet, because ${lowerCaseFirst(stripTrailingPunctuation(blocker))}.`),
      reference: blocker,
    };
  }

  const decision = pickCue(cues.decisions, { avoidQuestionLike: true, exclude: usedReferences });

  if (decision) {
    return {
      text: limitSuggestionWords(
        `Most likely answer: the team still needs alignment on ${lowerCaseFirst(stripTrailingPunctuation(decision))}.`,
      ),
      reference: decision,
    };
  }

  const actionItem = pickCue(cues.actionItems, { avoidQuestionLike: true, exclude: usedReferences });

  if (actionItem) {
    return {
      text: limitSuggestionWords(
        `Most likely answer: this still needs an owner and date first: ${stripTrailingPunctuation(actionItem)}.`,
      ),
      reference: actionItem,
    };
  }

  return {
    text: "Most likely answer: there is still missing context before committing.",
  };
}

function buildFactSuggestion(cues: MeetingCues, usedReferences: string[]): SuggestionCandidate {
  const verificationCandidate = pickFactCue(cues.verificationCandidates, usedReferences);

  if (verificationCandidate) {
    return {
      text: limitSuggestionWords(`Verify this before relying on it: ${stripTrailingPunctuation(verificationCandidate)}`),
      reference: verificationCandidate,
    };
  }

  const blocker = pickCue(cues.blockers, { avoidQuestionLike: true, exclude: usedReferences, preferSpecific: true });

  if (blocker) {
    return {
      text: limitSuggestionWords(`Confirm this blocker is still true before committing: ${stripTrailingPunctuation(blocker)}`),
      reference: blocker,
    };
  }

  return {
    text: "Verify the key date, number, or dependency before the next turn.",
  };
}

function buildClarifyingSuggestion(cues: MeetingCues, usedReferences: string[]): SuggestionCandidate {
  const clarificationTerm = pickClarificationTerm(cues);

  if (clarificationTerm) {
    return {
      text: limitSuggestionWords(`Clarify what ${quoteTerm(clarificationTerm)} means here before the team decides.`),
      reference: clarificationTerm,
    };
  }

  const decision = pickCue(cues.decisions, { exclude: usedReferences });

  if (decision) {
    return {
      text: limitSuggestionWords(`Clarify the distinction driving this choice: ${stripTrailingPunctuation(decision)}`),
      reference: decision,
    };
  }

  return {
    text: "Clarify the term or distinction that is slowing down the decision.",
  };
}

function buildSuggestionText(type: SuggestionType, cues: MeetingCues, usedReferences: string[]): SuggestionCandidate {
  switch (type) {
    case "question":
      return buildQuestionSuggestion(cues);
    case "talking":
      return buildTalkingSuggestion(cues, usedReferences);
    case "answer":
      return buildAnswerSuggestion(cues, usedReferences);
    case "fact":
      return buildFactSuggestion(cues, usedReferences);
    case "clarifying":
      return buildClarifyingSuggestion(cues, usedReferences);
    default:
      return {
        text: "Surface the most useful next-turn contribution.",
      };
  }
}

function uniqueSuggestionTypes(plan: SuggestionPlan) {
  const orderedTypes = [...plan.slots.map((slot) => slot.type), ...VALID_SUGGESTION_TYPES];
  const seen = new Set<SuggestionType>();
  const result: SuggestionType[] = [];

  orderedTypes.forEach((type) => {
    if (!seen.has(type) && result.length < 3) {
      seen.add(type);
      result.push(type);
    }
  });

  return result;
}

export function buildFallbackSuggestions(cues: MeetingCues, plan: SuggestionPlan): Suggestion[] {
  const usedReferences: string[] = [];

  return uniqueSuggestionTypes(plan).map((type) => {
    const candidate = buildSuggestionText(type, cues, usedReferences);

    if (candidate.reference) {
      usedReferences.push(candidate.reference);
    }

    return {
      type,
      text: candidate.text,
    };
  });
}
