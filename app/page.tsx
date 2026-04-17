"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const transcriptChunks = [
  "So we're talking about how to scale our backend to handle a million concurrent users.",
  "The main bottleneck right now is the websocket connections and how we're handling state in memory.",
  "I read that companies like Discord shard by guild ID — should we do something similar by user cohort?",
  "Also concerned about cost. If we move to managed Kafka, what's a realistic monthly bill at our volume?",
  "And one more thing — what was the failure mode when Slack went down last year? I want to avoid that pattern.",
];

const suggestionBatches = [
  [
    { type: "question", text: "What's your current p99 latency on websocket round-trips?" },
    { type: "talking", text: "Discord's sharding model: 2,500 guilds per shard, ~150k concurrent users each." },
    { type: "fact", text: "Fact-check: Slack's 2024 outage was a config push, not capacity — different problem." },
  ],
  [
    { type: "answer", text: "Managed Kafka (MSK) at ~1M events/sec runs roughly $8-15k/mo on AWS." },
    { type: "question", text: "Have you considered NATS JetStream as a lighter-weight alternative?" },
    { type: "talking", text: "Sharding by user cohort works if cohorts are stable; bad for viral spikes." },
  ],
  [
    { type: "answer", text: "For state-in-memory issues: Redis Cluster + consistent hashing handles ~1M ops/sec/node." },
    { type: "fact", text: "Discord publicly serves ~15M concurrent voice users on Elixir/Erlang infra." },
    { type: "question", text: "What's your read/write ratio? That changes the sharding strategy significantly." },
  ],
] as const;

type SuggestionType = (typeof suggestionBatches)[number][number]["type"];

type TranscriptLine = {
  id: number;
  time: string;
  text: string;
};

type RenderedBatch = {
  id: number;
  batchNumber: number;
  time: string;
  suggestions: readonly {
    type: SuggestionType;
    text: string;
  }[];
};

type ChatMessage = {
  id: number;
  who: "user" | "ai";
  text: string;
  label?: string;
};

function timestamp() {
  return new Date().toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function labelFor(type: SuggestionType) {
  return {
    question: "Question to ask",
    talking: "Talking point",
    answer: "Answer",
    fact: "Fact-check",
  }[type];
}

function simulateAnswer(question: string) {
  return `Detailed answer to: "${question}"\n\nThis is where a separate, longer-form prompt runs against the chat model with full transcript context. Streamed response ideally. Candidates choose model + prompt strategy — we evaluate quality, latency, relevance.`;
}

export default function Home() {
  const [recording, setRecording] = useState(false);
  const [transcriptLines, setTranscriptLines] = useState<TranscriptLine[]>([]);
  const [renderedBatches, setRenderedBatches] = useState<RenderedBatch[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState("");
  const [countdown, setCountdown] = useState(30);

  const transcriptIndexRef = useRef(0);
  const batchIndexRef = useRef(0);
  const messageIdRef = useRef(0);
  const recordingTimerRef = useRef<number | null>(null);
  const countdownTimerRef = useRef<number | null>(null);
  const transcriptBodyRef = useRef<HTMLDivElement>(null);
  const chatBodyRef = useRef<HTMLDivElement>(null);

  const addSuggestionBatch = useCallback(() => {
    const batch = suggestionBatches[batchIndexRef.current % suggestionBatches.length];
    batchIndexRef.current += 1;
    const batchNumber = batchIndexRef.current;

    setRenderedBatches((current) => [
      {
        id: batchNumber,
        batchNumber,
        time: timestamp(),
        suggestions: batch,
      },
      ...current,
    ]);
  }, []);

  const addTranscriptChunk = useCallback(() => {
    const chunk = transcriptChunks[transcriptIndexRef.current % transcriptChunks.length];
    transcriptIndexRef.current += 1;
    const nextIndex = transcriptIndexRef.current;

    setTranscriptLines((current) => [
      ...current,
      {
        id: nextIndex,
        time: timestamp(),
        text: chunk,
      },
    ]);

    if (nextIndex % 2 === 0) {
      addSuggestionBatch();
    }
  }, [addSuggestionBatch]);

  const tickCountdown = useCallback(() => {
    setCountdown((current) => {
      if (current <= 1) {
        addSuggestionBatch();
        return 30;
      }

      return current - 1;
    });
  }, [addSuggestionBatch]);

  const stopRecording = useCallback(() => {
    setRecording(false);

    if (recordingTimerRef.current !== null) {
      window.clearInterval(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }

    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  const startRecording = useCallback(() => {
    setRecording(true);
    addTranscriptChunk();
    recordingTimerRef.current = window.setInterval(addTranscriptChunk, 6000);
    countdownTimerRef.current = window.setInterval(tickCountdown, 1000);
  }, [addTranscriptChunk, tickCountdown]);

  const handleMicClick = useCallback(() => {
    if (recording) {
      stopRecording();
      return;
    }

    startRecording();
  }, [recording, startRecording, stopRecording]);

  const addChatMessage = useCallback((who: ChatMessage["who"], text: string, label?: string) => {
    messageIdRef.current += 1;
    const id = messageIdRef.current;

    setChatMessages((current) => [
      ...current,
      {
        id,
        who,
        text,
        label,
      },
    ]);
  }, []);

  const sendToChat = useCallback(
    (text: string, type?: SuggestionType) => {
      addChatMessage("user", text, type ? labelFor(type) : undefined);
      window.setTimeout(() => addChatMessage("ai", simulateAnswer(text)), 600);
    },
    [addChatMessage],
  );

  const handleReload = useCallback(() => {
    addSuggestionBatch();
    setCountdown(30);
  }, [addSuggestionBatch]);

  const handleChatSend = useCallback(() => {
    const value = chatInput.trim();

    if (!value) {
      return;
    }

    sendToChat(value);
    setChatInput("");
  }, [chatInput, sendToChat]);

  useEffect(() => {
    const transcriptBody = transcriptBodyRef.current;

    if (transcriptBody) {
      transcriptBody.scrollTop = transcriptBody.scrollHeight;
    }
  }, [transcriptLines]);

  useEffect(() => {
    const chatBody = chatBodyRef.current;

    if (chatBody) {
      chatBody.scrollTop = chatBody.scrollHeight;
    }
  }, [chatMessages]);

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current !== null) {
        window.clearInterval(recordingTimerRef.current);
      }

      if (countdownTimerRef.current !== null) {
        window.clearInterval(countdownTimerRef.current);
      }
    };
  }, []);

  return (
    <>
      <div className="topbar">
        <h1>TwinMind — Live Suggestions Web App (Reference Mockup)</h1>
        <div className="meta">3-column layout · Transcript · Live Suggestions · Chat</div>
      </div>

      <div className="layout">
        <div className="col">
          <header>
            <span>1. Mic & Transcript</span>
            <span id="recState">{recording ? "● recording" : "idle"}</span>
          </header>
          <div className="mic-wrap">
            <button
              id="micBtn"
              className={`mic-btn${recording ? " recording" : ""}`}
              title="Start / stop recording"
              type="button"
              onClick={handleMicClick}
            >
              ●
            </button>
            <div className="mic-status" id="micStatus">
              {recording ? "Listening… transcript updates every 30s." : transcriptLines.length > 0 ? "Stopped. Click to resume." : "Click mic to start. Transcript appends every ~30s."}
            </div>
          </div>
          <div className="body" id="transcriptBody" ref={transcriptBodyRef}>
            <div className="help-banner">
              The transcript scrolls and appends new chunks every ~30 seconds while recording. Use the mic
              button to start/stop. Include an export button (not shown) so we can pull the full session.
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

        <div className="col">
          <header>
            <span>2. Live Suggestions</span>
            <span id="batchCount">
              {renderedBatches.length} batch{renderedBatches.length === 1 ? "" : "es"}
            </span>
          </header>
          <div className="reload-row">
            <button className="reload-btn" id="reloadBtn" type="button" onClick={handleReload}>
              ↻ Reload suggestions
            </button>
            <span className="countdown" id="countdown">
              auto-refresh in {countdown}s
            </span>
          </div>
          <div className="body" id="suggestionsBody">
            <div className="help-banner">
              On reload (or auto every ~30s), generate <b>3 fresh suggestions</b> from recent transcript
              context. New batch appears at the top; older batches push down (faded). Each is a tappable
              card: a <span className="accent-text">question to ask</span>, a{" "}
              <span className="accent-2-text">talking point</span>, an{" "}
              <span className="good-text">answer</span>, or a <span className="warn-text">fact-check</span>.
              The preview alone should already be useful.
            </div>
            {renderedBatches.length === 0 ? (
              <div className="empty" id="suggestionsEmpty">
                Suggestions appear here once recording starts.
              </div>
            ) : (
              renderedBatches.map((batch, batchPosition) => (
                <div key={batch.id}>
                  {batch.suggestions.map((suggestion) => (
                    <button
                      className={`suggestion ${batchPosition === 0 ? "fresh" : "stale"}`}
                      key={`${batch.id}-${suggestion.type}-${suggestion.text}`}
                      onClick={() => sendToChat(suggestion.text, suggestion.type)}
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

        <div className="col">
          <header>
            <span>3. Chat (detailed answers)</span>
            <span>session-only</span>
          </header>
          <div className="body" id="chatBody" ref={chatBodyRef}>
            <div className="help-banner">
              Clicking a suggestion adds it to this chat and streams a detailed answer (separate prompt, more
              context). User can also type questions directly. One continuous chat per session — no login, no
              persistence.
            </div>
            {chatMessages.length === 0 ? (
              <div className="empty" id="chatEmpty">
                Click a suggestion or type a question below.
              </div>
            ) : (
              chatMessages.map((message) => (
                <div className={`chat-msg ${message.who}`} key={message.id}>
                  <div className="who">
                    {message.who === "user" ? (message.label ? `You · ${message.label}` : "You") : "Assistant"}
                  </div>
                  <div className="bubble">{message.text}</div>
                </div>
              ))
            )}
          </div>
          <div className="chat-input-row">
            <input
              id="chatInput"
              onChange={(event) => setChatInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  handleChatSend();
                }
              }}
              placeholder="Ask anything…"
              value={chatInput}
            />
            <button id="chatSend" onClick={handleChatSend} type="button">
              Send
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
