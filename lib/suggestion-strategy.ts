import type { MeetingCues, MeetingMode } from "./meeting-context";

export const VALID_SUGGESTION_TYPES = ["question", "talking", "answer", "fact", "clarifying"] as const;

export type SuggestionType = (typeof VALID_SUGGESTION_TYPES)[number];

export type SuggestionSlot = {
  type: SuggestionType;
  reason: string;
  required: boolean;
};

export type SuggestionPlan = {
  meetingMode: MeetingMode;
  meetingModeLabel: string;
  slots: SuggestionSlot[];
  requiredTypes: SuggestionType[];
  summary: string;
  shortSummary: string;
};

const MODE_LABELS: Record<MeetingMode, string> = {
  planning: "Planning mode",
  decision: "Decision mode",
  "status update": "Status update",
  "problem solving": "Problem-solving mode",
  brainstorming: "Brainstorming mode",
};

const MODE_FALLBACK_TYPES: Record<MeetingMode, SuggestionType[]> = {
  planning: ["talking", "question", "fact", "clarifying", "answer"],
  decision: ["talking", "question", "answer", "fact", "clarifying"],
  "status update": ["talking", "fact", "question", "clarifying", "answer"],
  "problem solving": ["talking", "question", "fact", "answer", "clarifying"],
  brainstorming: ["talking", "question", "clarifying", "fact", "answer"],
};

function addSlot(slots: SuggestionSlot[], type: SuggestionType, reason: string, required: boolean) {
  if (slots.some((slot) => slot.type === type) || slots.length >= 3) {
    return false;
  }

  slots.push({ type, reason, required });
  return true;
}

function pushSummaryPart(parts: string[], value: string) {
  if (!parts.includes(value) && parts.length < 3) {
    parts.push(value);
  }
}

function getModeFallbackReason(mode: MeetingMode, type: SuggestionType) {
  switch (type) {
    case "question":
      return `Use a question that helps move the ${MODE_LABELS[mode].toLowerCase()} forward in the next turn.`;
    case "talking":
      return `Use a talking point the user can say immediately in this ${MODE_LABELS[mode].toLowerCase()}.`;
    case "answer":
      return `Offer the most likely answer the user may need during this ${MODE_LABELS[mode].toLowerCase()}.`;
    case "fact":
      return `Surface the concrete claim or assumption worth verifying during this ${MODE_LABELS[mode].toLowerCase()}.`;
    case "clarifying":
      return `Clarify the term or distinction most likely to unblock this ${MODE_LABELS[mode].toLowerCase()}.`;
    default:
      return `Help the user contribute in this ${MODE_LABELS[mode].toLowerCase()}.`;
  }
}

function getDefaultSummary(mode: MeetingMode) {
  switch (mode) {
    case "decision":
      return "1 decision-driving point, 1 question, 1 answer angle";
    case "planning":
      return "1 next-step point, 1 question, 1 risk or dependency check";
    case "problem solving":
      return "1 blocker to address, 1 diagnostic question, 1 claim to verify";
    case "brainstorming":
      return "1 idea to contribute, 1 question, 1 clarification";
    case "status update":
    default:
      return "1 next-step point, 1 question, 1 verification angle";
  }
}

export function getMeetingModeLabel(mode: MeetingMode) {
  return MODE_LABELS[mode];
}

export function buildSuggestionPlan(cues: MeetingCues): SuggestionPlan {
  const slots: SuggestionSlot[] = [];
  const summaryParts: string[] = [];

  const openQuestionReference =
    cues.explicitQuestions[0] ?? cues.likelyOpenQuestions[0] ?? cues.uncertaintyPhrases[0] ?? "";
  const blockerOrDecisionReference = cues.blockers[0] ?? cues.decisions[0] ?? cues.actionItems[0] ?? "";
  const verificationReference = cues.verificationCandidates[0] ?? "";
  const clarificationReference = cues.clarificationTerms[0] ?? "";

  const hasOpenQuestion =
    cues.explicitQuestions.length > 0 || cues.likelyOpenQuestions.length > 0 || cues.uncertaintyPhrases.length > 0;
  const hasDecisionPressure = cues.decisions.length > 0 || cues.blockers.length > 0 || cues.actionItems.length > 0;
  const hasVerificationNeed = cues.verificationCandidates.length > 0;
  const hasClarificationNeed = cues.clarificationTerms.length > 0;
  const shouldOfferAnswer = cues.explicitQuestions.length > 0 && hasDecisionPressure;

  if (
    hasOpenQuestion &&
    addSlot(
      slots,
      "question",
      openQuestionReference
        ? `There is an unresolved question or gap: ${openQuestionReference}`
        : "There is unresolved uncertainty that should turn into a sharper next question.",
      true,
    )
  ) {
    pushSummaryPart(summaryParts, "1 open question");
  }

  if (
    hasDecisionPressure &&
    addSlot(
      slots,
      "talking",
      blockerOrDecisionReference
        ? `The user likely needs a point to say next: ${blockerOrDecisionReference}`
        : "The conversation has a blocker, decision, or ownership gap that needs a spoken point next.",
      true,
    )
  ) {
    pushSummaryPart(
      summaryParts,
      cues.blockers.length > 0 ? "1 blocker to address" : cues.decisions.length > 0 ? "1 decision point" : "1 next step",
    );
  }

  if (
    hasVerificationNeed &&
    addSlot(
      slots,
      "fact",
      verificationReference
        ? `A concrete claim, date, number, or dependency needs verification: ${verificationReference}`
        : "There is a concrete claim, date, or assumption worth verifying now.",
      true,
    )
  ) {
    pushSummaryPart(summaryParts, "1 claim to verify");
  }

  if (
    slots.length < 3 &&
    shouldOfferAnswer &&
    addSlot(
      slots,
      "answer",
      cues.explicitQuestions[0]
        ? `A recent question likely needs a crisp answer: ${cues.explicitQuestions[0]}`
        : "A recent question likely needs a direct answer grounded in the transcript.",
      false,
    )
  ) {
    pushSummaryPart(summaryParts, "1 likely answer");
  }

  if (
    slots.length < 3 &&
    hasClarificationNeed &&
    addSlot(
      slots,
      "clarifying",
      clarificationReference
        ? `The conversation uses a term or distinction that may need clarification: ${clarificationReference}`
        : "The conversation likely needs a simple clarification tied to the current topic.",
      false,
    )
  ) {
    pushSummaryPart(summaryParts, "1 term to clarify");
  }

  MODE_FALLBACK_TYPES[cues.mode].forEach((type) => {
    if (slots.length >= 3) {
      return;
    }

    addSlot(slots, type, getModeFallbackReason(cues.mode, type), false);
  });

  const shortSummary = summaryParts.length > 0 ? summaryParts.join(", ") : getDefaultSummary(cues.mode);

  return {
    meetingMode: cues.mode,
    meetingModeLabel: getMeetingModeLabel(cues.mode),
    slots,
    requiredTypes: slots.filter((slot) => slot.required).map((slot) => slot.type),
    summary: `Chosen for the next turn: ${shortSummary}.`,
    shortSummary,
  };
}
