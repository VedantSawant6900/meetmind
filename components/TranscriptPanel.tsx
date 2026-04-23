"use client";

import type { RefObject } from "react";
import { DEFAULT_TRANSCRIPTION_LANGUAGE } from "../lib/client-config";
import type { TranscriptLine } from "../lib/client-types";

type TranscriptPanelProps = {
  recState: string;
  recording: boolean;
  requestingMic: boolean;
  micStatus: string;
  transcriptionError: string | null;
  chunkIntervalSeconds: number;
  transcriptionLanguage: string;
  transcriptLines: TranscriptLine[];
  transcriptBodyRef: RefObject<HTMLDivElement | null>;
  onMicClick: () => void;
};

export function TranscriptPanel({
  recState,
  recording,
  requestingMic,
  micStatus,
  transcriptionError,
  chunkIntervalSeconds,
  transcriptionLanguage,
  transcriptLines,
  transcriptBodyRef,
  onMicClick,
}: TranscriptPanelProps) {
  return (
    <div className="col">
      <header>
        <span>1. Mic & Transcript</span>
        <span id="recState">{recState}</span>
      </header>
      <div className="mic-wrap">
        <button
          id="micBtn"
          className={`mic-btn${recording ? " recording" : ""}`}
          disabled={requestingMic}
          title="Start / stop recording"
          type="button"
          onClick={onMicClick}
        >
          ●
        </button>
        <div className={`mic-status${transcriptionError ? " status-error" : ""}`} id="micStatus">
          {micStatus}
        </div>
      </div>
      <div className="body" id="transcriptBody" ref={transcriptBodyRef}>
        <div className="help-banner">
          The transcript scrolls and appends new chunks every ~{chunkIntervalSeconds} seconds while recording. Audio
          is captured from the mic and transcribed with Groq Whisper Large V3 using language{" "}
          {transcriptionLanguage || DEFAULT_TRANSCRIPTION_LANGUAGE}.
        </div>
        {transcriptLines.length === 0 ? (
          <div className="empty" id="transcriptEmpty">
            No transcript yet — start the mic.
          </div>
        ) : (
          transcriptLines.map((line) => (
            <div className="transcript-line new" key={line.id}>
              <span className="ts">{line.time}</span>
              {line.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
