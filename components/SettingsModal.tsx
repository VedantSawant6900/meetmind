"use client";

import { useEffect } from "react";
import {
  MAX_CHUNK_INTERVAL_SECONDS,
  MAX_CONTEXT_LINES,
  MIN_CHUNK_INTERVAL_SECONDS,
  MIN_CONTEXT_LINES,
} from "../lib/client-config";

type SettingsModalProps = {
  open: boolean;
  groqApiKey: string;
  localApiKeyReady: boolean;
  serverGroqKeyAvailable: boolean;
  whisperModel: string;
  transcriptionLanguage: string;
  suggestionModel: string;
  chunkIntervalSeconds: number;
  suggestionContextLines: number;
  detailContextLines: number;
  liveSuggestionPrompt: string;
  detailAnswerPrompt: string;
  chatPrompt: string;
  onClose: () => void;
  onGroqApiKeyChange: (value: string) => void;
  onWhisperModelChange: (value: string) => void;
  onTranscriptionLanguageChange: (value: string) => void;
  onSuggestionModelChange: (value: string) => void;
  onChunkIntervalChange: (value: string) => void;
  onSuggestionContextLinesChange: (value: string) => void;
  onDetailContextLinesChange: (value: string) => void;
  onLiveSuggestionPromptChange: (value: string) => void;
  onDetailAnswerPromptChange: (value: string) => void;
  onChatPromptChange: (value: string) => void;
  onResetDefaults: () => void;
};

export function SettingsModal({
  open,
  groqApiKey,
  localApiKeyReady,
  serverGroqKeyAvailable,
  whisperModel,
  transcriptionLanguage,
  suggestionModel,
  chunkIntervalSeconds,
  suggestionContextLines,
  detailContextLines,
  liveSuggestionPrompt,
  detailAnswerPrompt,
  chatPrompt,
  onClose,
  onGroqApiKeyChange,
  onWhisperModelChange,
  onTranscriptionLanguageChange,
  onSuggestionModelChange,
  onChunkIntervalChange,
  onSuggestionContextLinesChange,
  onDetailContextLinesChange,
  onLiveSuggestionPromptChange,
  onDetailAnswerPromptChange,
  onChatPromptChange,
  onResetDefaults,
}: SettingsModalProps) {
  if (!open) {
    return null;
  }

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  return (
    <div
      className="settings-backdrop"
      onMouseDown={(event) => {
        if (event.currentTarget === event.target) {
          onClose();
        }
      }}
    >
      <div aria-labelledby="settingsTitle" aria-modal="true" className="settings-modal" role="dialog">
        <div className="settings-header">
          <h2 id="settingsTitle">Settings</h2>
          <button aria-label="Close settings" className="settings-close" onClick={onClose} type="button">
            ×
          </button>
        </div>

        <div className="settings-fields">
          <label className="settings-field" htmlFor="groqApiKey">
            <span>Groq API key</span>
            <input
              autoComplete="off"
              id="groqApiKey"
              onChange={(event) => onGroqApiKeyChange(event.target.value)}
              placeholder="gsk_..."
              type="password"
              value={groqApiKey}
            />
            {serverGroqKeyAvailable ? (
              <div className="settings-note">
                {localApiKeyReady
                  ? "A pasted key overrides the server GROQ_API_KEY for this browser session."
                  : "This deployment already has GROQ_API_KEY configured, so the app can run without pasting a key here."}
              </div>
            ) : null}
          </label>

          <label className="settings-field" htmlFor="whisperModel">
            <span>Whisper model</span>
            <input id="whisperModel" onChange={(event) => onWhisperModelChange(event.target.value)} value={whisperModel} />
          </label>

          <label className="settings-field" htmlFor="transcriptionLanguage">
            <span>Transcript language</span>
            <input
              id="transcriptionLanguage"
              onChange={(event) => onTranscriptionLanguageChange(event.target.value)}
              value={transcriptionLanguage}
            />
          </label>

          <label className="settings-field" htmlFor="suggestionModel">
            <span>Suggestion model</span>
            <input
              id="suggestionModel"
              onChange={(event) => onSuggestionModelChange(event.target.value)}
              value={suggestionModel}
            />
          </label>

          <label className="settings-field" htmlFor="chunkIntervalSeconds">
            <span>Chunk interval</span>
            <div className="number-input-wrap">
              <input
                id="chunkIntervalSeconds"
                max={MAX_CHUNK_INTERVAL_SECONDS}
                min={MIN_CHUNK_INTERVAL_SECONDS}
                onChange={(event) => onChunkIntervalChange(event.target.value)}
                step={1}
                type="number"
                value={chunkIntervalSeconds}
              />
              <span>seconds</span>
            </div>
          </label>

          <label className="settings-field" htmlFor="suggestionContextLines">
            <span>Live suggestion context window</span>
            <div className="number-input-wrap">
              <input
                id="suggestionContextLines"
                max={MAX_CONTEXT_LINES}
                min={MIN_CONTEXT_LINES}
                onChange={(event) => onSuggestionContextLinesChange(event.target.value)}
                step={1}
                type="number"
                value={suggestionContextLines}
              />
              <span>lines</span>
            </div>
          </label>

          <label className="settings-field" htmlFor="detailContextLines">
            <span>Expanded answer context window</span>
            <div className="number-input-wrap">
              <input
                id="detailContextLines"
                max={MAX_CONTEXT_LINES}
                min={MIN_CONTEXT_LINES}
                onChange={(event) => onDetailContextLinesChange(event.target.value)}
                step={1}
                type="number"
                value={detailContextLines}
              />
              <span>lines</span>
            </div>
          </label>

          <label className="settings-field settings-field-wide" htmlFor="liveSuggestionPrompt">
            <span>Live suggestion prompt</span>
            <textarea
              id="liveSuggestionPrompt"
              onChange={(event) => onLiveSuggestionPromptChange(event.target.value)}
              rows={5}
              value={liveSuggestionPrompt}
            />
          </label>

          <label className="settings-field settings-field-wide" htmlFor="detailAnswerPrompt">
            <span>Detailed answer prompt</span>
            <textarea
              id="detailAnswerPrompt"
              onChange={(event) => onDetailAnswerPromptChange(event.target.value)}
              rows={5}
              value={detailAnswerPrompt}
            />
          </label>

          <label className="settings-field settings-field-wide" htmlFor="chatPrompt">
            <span>Chat prompt</span>
            <textarea id="chatPrompt" onChange={(event) => onChatPromptChange(event.target.value)} rows={5} value={chatPrompt} />
          </label>
        </div>

        <div className="settings-footer">
          <button className="settings-secondary" onClick={onResetDefaults} type="button">
            Reset defaults
          </button>
          <button className="settings-primary" onClick={onClose} type="button">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
