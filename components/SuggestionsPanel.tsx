"use client";

import { formatRelativeAge, labelFor } from "../lib/client-formatters";
import type { RenderedBatch, TranscriptLine } from "../lib/client-types";
import type { SuggestionType } from "../lib/suggestion-strategy";

type SuggestionsPanelProps = {
  refreshingTranscript: boolean;
  suggestionsLoading: boolean;
  renderedBatches: RenderedBatch[];
  suggestionPhaseLabel: string;
  suggestionStatusDetail: string;
  suggestionsError: string | null;
  transcriptLines: TranscriptLine[];
  chunkIntervalSeconds: number;
  suggestionContextLines: number;
  nowMs: number;
  chatLoading: boolean;
  onReload: () => void;
  onSuggestionClick: (text: string, type?: SuggestionType) => void;
};

export function SuggestionsPanel({
  refreshingTranscript,
  suggestionsLoading,
  renderedBatches,
  suggestionPhaseLabel,
  suggestionStatusDetail,
  suggestionsError,
  transcriptLines,
  chunkIntervalSeconds,
  suggestionContextLines,
  nowMs,
  chatLoading,
  onReload,
  onSuggestionClick,
}: SuggestionsPanelProps) {
  return (
    <div className="col">
      <header>
        <span>2. Live Suggestions</span>
        <span id="batchCount">
          {refreshingTranscript
            ? "updating transcript"
            : suggestionsLoading
              ? "generating"
              : `${renderedBatches.length} batch${renderedBatches.length === 1 ? "" : "es"}`}
        </span>
      </header>
      <div className="reload-row">
        <button
          className="reload-btn"
          disabled={refreshingTranscript || suggestionsLoading}
          id="reloadBtn"
          type="button"
          onClick={onReload}
        >
          {refreshingTranscript ? "Updating..." : suggestionsLoading ? "Generating..." : "↻ Refresh"}
        </button>
        <div className="suggestion-status-stack">
          <span className="suggestion-phase" id="suggestionPhase">
            {suggestionPhaseLabel}
          </span>
          <span className={`countdown${suggestionsError ? " status-error" : ""}`} id="countdown">
            {suggestionStatusDetail}
          </span>
        </div>
      </div>
      <div className="body" id="suggestionsBody">
        <div className="help-banner">
          On reload (or auto every ~{chunkIntervalSeconds}s), generate <b>3 fresh suggestions</b> from recent
          transcript context using the latest {suggestionContextLines} lines. Each batch now explains <b>why</b> those
          three cards were chosen and what meeting mode the app detected. Each card is a tappable preview: a{" "}
          <span className="accent-text">question to ask</span>, a <span className="accent-2-text">talking point</span>
          , an <span className="good-text">answer</span>, a <span className="warn-text">fact-check</span>, or{" "}
          <span className="clarifying-text">clarifying info</span>.
        </div>
        {suggestionsError ? <div className="suggestion-error">{suggestionsError}</div> : null}
        {renderedBatches.length === 0 ? (
          <div className="empty" id="suggestionsEmpty">
            {refreshingTranscript
              ? "Updating transcript before suggestions..."
              : suggestionsLoading
                ? "Generating suggestions from recent transcript..."
                : transcriptLines.length === 0
                  ? "Start the mic to generate meeting suggestions."
                  : "Suggestions appear here once transcript text is available."}
          </div>
        ) : (
          renderedBatches.map((batch, batchPosition) => (
            <div key={batch.id}>
              <div className={`sug-batch-meta ${batchPosition === 0 ? "fresh" : "stale"}`}>
                <span className="meeting-mode-badge">{batch.meetingModeLabel ?? "Live meeting"}</span>
                <span className="batch-rationale">{batch.rationale ?? "3 fresh suggestions for the next turn."}</span>
                <span className="batch-age">
                  {batchPosition === 0 ? `updated ${formatRelativeAge(batch.createdAt, nowMs)}` : batch.time}
                </span>
              </div>
              {batch.suggestions.map((suggestion) => (
                <button
                  className={`suggestion ${batchPosition === 0 ? "fresh" : "stale"}`}
                  key={`${batch.id}-${suggestion.type}-${suggestion.text}`}
                  onClick={() => onSuggestionClick(suggestion.text, suggestion.type)}
                  title={chatLoading ? "Answer in progress. This click will queue next." : "Open detailed answer"}
                  type="button"
                >
                  <span className={`sug-tag ${suggestion.type}`}>{labelFor(suggestion.type)}</span>
                  <div className="sug-title">{suggestion.text}</div>
                </button>
              ))}
              <div className="sug-batch-divider">
                — Batch {batch.batchNumber} · {batch.time} —
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
