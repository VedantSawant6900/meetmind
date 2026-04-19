export type TranscriptLine = {
  time?: string;
  text?: string;
};

export type MeetingMode =
  | "planning"
  | "decision"
  | "status update"
  | "problem solving"
  | "brainstorming";

export type MeetingCues = {
  mode: MeetingMode;
  explicitQuestions: string[];
  likelyOpenQuestions: string[];
  decisions: string[];
  blockers: string[];
  actionItems: string[];
  verificationCandidates: string[];
  clarificationTerms: string[];
  uncertaintyPhrases: string[];
};

export type MeetingContext = {
  cues: MeetingCues;
  cueSummary: string;
  mostRecentTranscript: string;
  olderRelevantTranscript: string;
  recentLineCount: number;
  olderRelevantLineCount: number;
};

type CleanTranscriptLine = {
  index: number;
  time?: string;
  text: string;
  formatted: string;
};

type MeetingContextOptions = {
  recentLineCount: number;
  olderLineCount?: number;
  relevanceQuery?: string;
  maxRecentChars?: number;
  maxOlderChars?: number;
};

const DEFAULT_OLDER_LINE_COUNT = 6;
const DEFAULT_MAX_RECENT_CHARS = 6_000;
const DEFAULT_MAX_OLDER_CHARS = 2_500;
const MAX_CUE_ITEMS = 4;

const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "because",
  "been",
  "but",
  "can",
  "could",
  "did",
  "does",
  "for",
  "from",
  "had",
  "has",
  "have",
  "how",
  "into",
  "just",
  "like",
  "more",
  "need",
  "our",
  "out",
  "over",
  "should",
  "that",
  "the",
  "their",
  "then",
  "there",
  "they",
  "this",
  "those",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "will",
  "with",
  "would",
  "you",
]);

const QUESTION_START_PATTERN =
  /^\s*(?:what|why|how|when|who|where|which|should|could|can|do|does|did|is|are|will|would)\b/i;
const OPEN_QUESTION_PATTERN =
  /\b(?:not sure|unclear|open question|need to figure out|need to know|need to decide|we need to check|to confirm|who owns|who will|what if|whether we|should we|can we|how do we)\b/i;
const DECISION_PATTERN =
  /\b(?:decide|decision|choose|choice|option|tradeoff|trade-off|align on|approval|approve|go with|commit to|prioritize)\b/i;
const BLOCKER_PATTERN =
  /\b(?:blocker|blocked|risk|concern|issue|problem|dependency|depends on|waiting on|delay|delayed|behind|can't|cannot|unable|stuck|missing)\b/i;
const ACTION_PATTERN =
  /\b(?:action item|next step|follow up|follow-up|owner|owns|assign|by (?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)|i'll|i will|we'll|we will|let's|can you|could you|we need to)\b/i;
const NUMBER_PATTERN = /\b(?:\$?\d+(?:[.,]\d+)*(?:\.\d+)?%?|q[1-4]|fy\d{2,4})\b/i;
const DATE_PATTERN =
  /\b(?:today|tomorrow|yesterday|monday|tuesday|wednesday|thursday|friday|saturday|sunday|jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/i;
const CLAIM_PATTERN =
  /\b(?:because|due to|caused by|driven by|depends on|assuming|estimate|forecast|target|will|won't|must|always|never|guarantee|guaranteed)\b/i;
const UNCERTAINTY_PHRASES = [
  "not sure",
  "maybe",
  "i think",
  "we need to check",
  "to confirm",
  "probably",
  "might",
  "could be",
  "assuming",
  "roughly",
  "around",
  "tbd",
];

const MODE_PATTERNS: Record<MeetingMode, RegExp[]> = {
  planning: [/\bplan\b/i, /\broadmap\b/i, /\btimeline\b/i, /\bmilestone\b/i, /\bscope\b/i, /\bnext steps?\b/i],
  decision: [DECISION_PATTERN],
  "status update": [/\bstatus\b/i, /\bupdate\b/i, /\bdone\b/i, /\bprogress\b/i, /\bshipped\b/i, /\bworking on\b/i],
  "problem solving": [BLOCKER_PATTERN, /\bfix\b/i, /\bdebug\b/i, /\broot cause\b/i, /\bsolve\b/i],
  brainstorming: [/\bidea\b/i, /\bbrainstorm\b/i, /\bwhat if\b/i, /\balternative\b/i, /\bmaybe\b/i],
};

function normalizeWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function cleanTranscriptLines(lines: TranscriptLine[]) {
  return lines
    .map((line, index): CleanTranscriptLine | null => {
      const text = typeof line.text === "string" ? normalizeWhitespace(line.text) : "";

      if (!text) {
        return null;
      }

      const time = typeof line.time === "string" && line.time.trim() ? line.time.trim() : undefined;
      const formatted = time ? `[${time}] ${text}` : text;
      return { index, time, text, formatted };
    })
    .filter((line): line is CleanTranscriptLine => line !== null);
}

function clipText(value: string, maxChars: number) {
  if (value.length <= maxChars) {
    return value;
  }

  return `${value.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function cueSnippet(line: CleanTranscriptLine, maxChars = 150) {
  return clipText(line.formatted, maxChars);
}

function addUnique(items: string[], value: string) {
  const normalized = value.toLowerCase();

  if (items.some((item) => item.toLowerCase() === normalized)) {
    return;
  }

  if (items.length < MAX_CUE_ITEMS) {
    items.push(value);
  }
}

function extractQuestion(line: CleanTranscriptLine) {
  const questionMarkIndex = line.text.indexOf("?");

  if (questionMarkIndex >= 0) {
    const questionPrefix = line.text.slice(0, questionMarkIndex + 1);
    const sentenceStart = Math.max(questionPrefix.lastIndexOf("."), questionPrefix.lastIndexOf("!"));
    const question = questionPrefix.slice(sentenceStart + 1).trim();
    return question ? cueSnippet({ ...line, text: question, formatted: line.time ? `[${line.time}] ${question}` : question }) : null;
  }

  if (QUESTION_START_PATTERN.test(line.text)) {
    return cueSnippet(line);
  }

  return null;
}

function extractClarificationTerms(lines: CleanTranscriptLine[]) {
  const terms: string[] = [];
  const acronymPattern = /\b[A-Z][A-Z0-9&/-]{1,8}\b/g;
  const hyphenatedPattern = /\b[a-z][a-z0-9]+(?:-[a-z0-9]+){1,3}\b/gi;

  lines.forEach((line) => {
    const acronyms = line.text.match(acronymPattern) ?? [];

    acronyms
      .filter((term) => !/^(AM|PM|OK)$/.test(term))
      .forEach((term) => addUnique(terms, term));

    const hyphenatedTerms = line.text.match(hyphenatedPattern) ?? [];
    hyphenatedTerms.forEach((term) => addUnique(terms, term.toLowerCase()));
  });

  return terms.slice(0, MAX_CUE_ITEMS);
}

function extractUncertaintyPhrases(lines: CleanTranscriptLine[]) {
  const combined = lines.map((line) => line.text.toLowerCase()).join(" ");

  return UNCERTAINTY_PHRASES.flatMap((phrase) => {
    const matches = combined.match(new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g")) ?? [];
    return matches.length > 0 ? [`${phrase}${matches.length > 1 ? ` (${matches.length}x)` : ""}`] : [];
  }).slice(0, MAX_CUE_ITEMS);
}

function detectMode(lines: CleanTranscriptLine[], cues: Omit<MeetingCues, "mode">): MeetingMode {
  const combined = lines.map((line) => line.text).join("\n");
  let bestMode: MeetingMode = "status update";
  let bestScore = 0;

  (Object.keys(MODE_PATTERNS) as MeetingMode[]).forEach((mode) => {
    const score = MODE_PATTERNS[mode].reduce((total, pattern) => {
      const matches = combined.match(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`));
      return total + (matches?.length ?? 0);
    }, 0);

    if (score > bestScore) {
      bestMode = mode;
      bestScore = score;
    }
  });

  if (bestScore === 0) {
    if (cues.blockers.length > 0) {
      return "problem solving";
    }

    if (cues.decisions.length > 0 || cues.likelyOpenQuestions.length > 0) {
      return "decision";
    }
  }

  return bestMode;
}

export function extractMeetingCues(lines: TranscriptLine[]): MeetingCues {
  const cleanLines = cleanTranscriptLines(lines);
  const explicitQuestions: string[] = [];
  const likelyOpenQuestions: string[] = [];
  const decisions: string[] = [];
  const blockers: string[] = [];
  const actionItems: string[] = [];
  const verificationCandidates: string[] = [];

  cleanLines.forEach((line) => {
    const question = extractQuestion(line);

    if (question) {
      addUnique(explicitQuestions, question);
    }

    if (OPEN_QUESTION_PATTERN.test(line.text)) {
      addUnique(likelyOpenQuestions, cueSnippet(line));
    }

    if (DECISION_PATTERN.test(line.text)) {
      addUnique(decisions, cueSnippet(line));
    }

    if (BLOCKER_PATTERN.test(line.text)) {
      addUnique(blockers, cueSnippet(line));
    }

    if (ACTION_PATTERN.test(line.text)) {
      addUnique(actionItems, cueSnippet(line));
    }

    if (NUMBER_PATTERN.test(line.text) || DATE_PATTERN.test(line.text) || CLAIM_PATTERN.test(line.text)) {
      addUnique(verificationCandidates, cueSnippet(line));
    }
  });

  const cuesWithoutMode = {
    explicitQuestions,
    likelyOpenQuestions,
    decisions,
    blockers,
    actionItems,
    verificationCandidates,
    clarificationTerms: extractClarificationTerms(cleanLines),
    uncertaintyPhrases: extractUncertaintyPhrases(cleanLines),
  };

  return {
    mode: detectMode(cleanLines, cuesWithoutMode),
    ...cuesWithoutMode,
  };
}

function inlineList(items: string[]) {
  return items.length > 0 ? items.join(" | ") : "none detected";
}

export function formatMeetingCues(cues: MeetingCues) {
  return [
    `Conversation mode: ${cues.mode}`,
    `Explicit questions asked recently: ${inlineList(cues.explicitQuestions)}`,
    `Likely open questions or gaps: ${inlineList(cues.likelyOpenQuestions)}`,
    `Decisions being discussed: ${inlineList(cues.decisions)}`,
    `Blockers, risks, or concerns: ${inlineList(cues.blockers)}`,
    `Action items or ownership gaps: ${inlineList(cues.actionItems)}`,
    `Claims, numbers, dates, or assumptions to verify: ${inlineList(cues.verificationCandidates)}`,
    `Jargon, acronyms, or concepts to clarify: ${inlineList(cues.clarificationTerms)}`,
    `Uncertainty language: ${inlineList(cues.uncertaintyPhrases)}`,
  ].join("\n");
}

function tokenize(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[-/]+|[-/]+$/g, ""))
    .filter((token) => token.length >= 3 && !STOP_WORDS.has(token));
}

function scoreOlderLine(line: CleanTranscriptLine, queryTokens: Set<string>, totalLineCount: number) {
  const lineTokens = new Set(tokenize(line.text));
  let score = 0;

  lineTokens.forEach((token) => {
    if (queryTokens.has(token)) {
      score += token.length >= 6 ? 2 : 1;
    }
  });

  if (NUMBER_PATTERN.test(line.text)) {
    score += 0.5;
  }

  if (DATE_PATTERN.test(line.text)) {
    score += 0.5;
  }

  const recencyBoost = totalLineCount > 0 ? line.index / totalLineCount : 0;
  return score > 0 ? score + recencyBoost : 0;
}

function formatLinesWithinBudget(lines: CleanTranscriptLine[], maxChars: number) {
  const selected: string[] = [];
  let length = 0;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const formatted = lines[index].formatted;
    const nextLength = length + formatted.length + (selected.length > 0 ? 1 : 0);

    if (nextLength > maxChars && selected.length > 0) {
      break;
    }

    selected.unshift(clipText(formatted, maxChars));
    length = nextLength;

    if (length >= maxChars) {
      break;
    }
  }

  return selected.join("\n");
}

function selectOlderRelevantLines(
  olderLines: CleanTranscriptLine[],
  recentLines: CleanTranscriptLine[],
  relevanceQuery: string,
  olderLineCount: number,
) {
  const querySeed = `${relevanceQuery}\n${recentLines.slice(-6).map((line) => line.text).join("\n")}`;
  const queryTokens = new Set(tokenize(querySeed));

  if (queryTokens.size === 0) {
    return [];
  }

  return olderLines
    .map((line) => ({
      line,
      score: scoreOlderLine(line, queryTokens, olderLines.length + recentLines.length),
    }))
    .filter((item) => item.score > 0)
    .sort((first, second) => second.score - first.score || second.line.index - first.line.index)
    .slice(0, olderLineCount)
    .map((item) => item.line)
    .sort((first, second) => first.index - second.index);
}

export function buildMeetingContext(lines: TranscriptLine[], options: MeetingContextOptions): MeetingContext {
  const cleanLines = cleanTranscriptLines(lines);
  const recentLineCount = Math.max(1, Math.min(options.recentLineCount, cleanLines.length || 1));
  const olderLineCount = options.olderLineCount ?? DEFAULT_OLDER_LINE_COUNT;
  const maxRecentChars = options.maxRecentChars ?? DEFAULT_MAX_RECENT_CHARS;
  const maxOlderChars = options.maxOlderChars ?? DEFAULT_MAX_OLDER_CHARS;
  const recentLines = cleanLines.slice(-recentLineCount);
  const olderLines = cleanLines.slice(0, Math.max(0, cleanLines.length - recentLineCount));
  const olderRelevantLines = selectOlderRelevantLines(
    olderLines,
    recentLines,
    options.relevanceQuery ?? "",
    olderLineCount,
  );
  const cues = extractMeetingCues(recentLines);

  return {
    cues,
    cueSummary: formatMeetingCues(cues),
    mostRecentTranscript: formatLinesWithinBudget(recentLines, maxRecentChars),
    olderRelevantTranscript: formatLinesWithinBudget(olderRelevantLines, maxOlderChars),
    recentLineCount: recentLines.length,
    olderRelevantLineCount: olderRelevantLines.length,
  };
}
