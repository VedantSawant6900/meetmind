"use client";

import type { KeyboardEvent, RefObject } from "react";
import { FormattedChatText } from "./FormattedChatText";
import type { ChatMessage } from "../lib/client-types";

type ChatPanelProps = {
  chatHeaderStatus: string;
  chatBodyRef: RefObject<HTMLDivElement | null>;
  queuedChatLabel: string | null;
  chatError: string | null;
  chatMessages: ChatMessage[];
  chatLoading: boolean;
  chatInput: string;
  onChatInputChange: (value: string) => void;
  onChatSend: () => void;
};

export function ChatPanel({
  chatHeaderStatus,
  chatBodyRef,
  queuedChatLabel,
  chatError,
  chatMessages,
  chatLoading,
  chatInput,
  onChatInputChange,
  onChatSend,
}: ChatPanelProps) {
  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      onChatSend();
    }
  };

  return (
    <div className="col">
      <header>
        <span>3. Chat (detailed answers)</span>
        <span>{chatHeaderStatus}</span>
      </header>
      <div className="body" id="chatBody" ref={chatBodyRef}>
        <div className="help-banner">
          Clicking a suggestion adds it to this chat and returns a detailed answer using the full transcript context.
          User can also type questions directly. One continuous chat per session — no login, no persistence.
        </div>
        {queuedChatLabel ? <div className="chat-queue">{queuedChatLabel}</div> : null}
        {chatError ? <div className="chat-error">{chatError}</div> : null}
        {chatMessages.length === 0 ? (
          <div className="empty" id="chatEmpty">
            {chatLoading ? "Generating an answer..." : "Click a suggestion or type a question below."}
          </div>
        ) : (
          <>
            {chatMessages.map((message) => (
              <div className={`chat-msg ${message.who}`} key={message.id}>
                <div className="who">
                  {message.who === "user" ? (message.label ? `You · ${message.label}` : "You") : "Assistant"} ·{" "}
                  {message.time}
                </div>
                <div className="bubble">
                  <FormattedChatText text={message.text} />
                </div>
              </div>
            ))}
            {chatLoading ? (
              <div className="chat-msg ai pending">
                <div className="who">Assistant</div>
                <div className="bubble">
                  Thinking through the transcript...
                  {queuedChatLabel ? ` Next up: ${queuedChatLabel}` : ""}
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>
      <div className="chat-input-row">
        <input
          id="chatInput"
          onChange={(event) => onChatInputChange(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Ask anything about the conversation..."
          value={chatInput}
        />
        <button disabled={!chatInput.trim()} id="chatSend" onClick={onChatSend} type="button">
          {chatLoading ? "Queue" : "Send"}
        </button>
      </div>
    </div>
  );
}
