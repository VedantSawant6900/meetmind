# MeetMind

MeetMind is a TwinMind-style live meeting copilot built for the live suggestions assignment. It records microphone audio, transcribes it with Groq Whisper Large V3, surfaces exactly 3 useful live suggestions every refresh, and expands clicked suggestions into meeting-ready answers in a persistent session chat.

The product shape stays intentionally simple:

- Left: microphone + rolling transcript
- Middle: exactly 3 live suggestions per batch
- Right: detailed answers for clicked suggestions or typed questions

## What Improved

This version is tuned around the assignment priorities instead of adding extra product surface area.

- Live suggestions are more opinionated about the next 30-90 seconds of the meeting.
- Suggestion selection is cue-aware instead of generic: unresolved questions, blockers, decisions, claims, dates, and terminology drive the mix.
- Clicked answers are structured to help the user say, ask, verify, or explain something immediately.
- The middle column now shows meeting mode, why the batch was chosen, and clearer freshness/loading states.
- The client works with either a pasted API key or a server-side `GROQ_API_KEY`, without exposing secrets.
- The oversized page was split into reusable UI components plus extracted hooks and shared logic modules.
- Core logic now has lightweight tests.

## Core Behavior

- Groq for everything
- Whisper Large V3 for transcription
- `openai/gpt-oss-120b` as the default suggestion and chat model
- Exactly 3 suggestions per refresh
- Session-only UX, no login, no persistence after reload
- Export transcript + suggestion batches + chat history with timestamps

## Tech Stack

- Next.js App Router
- React + TypeScript
- Groq APIs
- `react-markdown` + `remark-gfm`
- `vitest` for focused logic tests

## Project Structure

```txt
app/
  api/
    chat/route.ts
    config/route.ts
    logs/route.ts
    suggestions/route.ts
    transcribe/route.ts
  globals.css
  page.tsx
components/
  ChatPanel.tsx
  FormattedChatText.tsx
  SettingsModal.tsx
  SuggestionsPanel.tsx
  TopBar.tsx
  TranscriptPanel.tsx
hooks/
  useCurrentTime.ts
  useServerGroqKey.ts
lib/
  audio-client.ts
  client-config.ts
  client-formatters.ts
  client-logger.ts
  client-types.ts
  default-prompts.ts
  groq-retry.ts
  meeting-context.ts
  server-logger.ts
  suggestion-output.ts
  suggestion-strategy.ts
  transcript-filter.ts
```

## Running Locally

### Requirements

- Node.js 22.13+ recommended
- npm 10+
- Browser with `MediaRecorder`
- Microphone access enabled

### Install

```bash
npm install
```

### Start

```bash
npm run dev
```

Open `http://localhost:3000`.

## Environment Variables

The app supports two valid key modes:

1. User pastes a Groq key in Settings
2. Server already has `GROQ_API_KEY`

Create `.env.local` for server-side fallback:

```bash
GROQ_API_KEY=your_groq_key_here
```

## Settings

The Settings modal keeps the assignment-required runtime tuning directly editable:

- Whisper model
- Transcript language
- Suggestion model
- Chunk interval
- Live suggestion context window
- Expanded answer context window
- Live suggestion prompt
- Detailed answer prompt
- Chat prompt

Settings are stored in browser session storage only.

## Prompt Strategy

### Live Suggestions

The live suggestion prompt is intentionally opinionated.

- Optimize for what helps in the next speaking turn, not recap.
- Force diversity across the 3 cards.
- Prefer transcript nouns, owners, dates, numbers, blockers, and dependencies.
- Reject bland suggestions like “ask for clarification” unless grounded in a specific topic.
- Follow a cue-driven slot plan when one is available.

### Clicked Suggestion Answers

Clicked answers are shaped by suggestion type:

- `question`: polished line to say, why now, optional follow-up
- `talking`: 2-4 concise spoken bullets
- `answer`: most likely answer first, then evidence and assumptions
- `fact`: supported by transcript vs needs verification
- `clarifying`: plain-English explanation tied to the live topic

### Typed Chat

Typed chat stays grounded in transcript + recent chat, with concise sections and explicit uncertainty when information is missing.

## Context Strategy

The app does not just send the latest raw transcript dump.

- Recent transcript is clipped to a focused live window.
- Older transcript is selected by relevance, not by simple recency.
- Meeting cues are extracted from recent lines:
  explicit questions, open questions, decisions, blockers, action items, verification candidates, clarification terms, uncertainty phrases, and meeting mode.
- Suggestion planning uses those cues to bias the 3-card mix.
- Payload sizes were kept tighter to improve latency without dropping the freshest signal.

## Why The Suggestions Are Better

The biggest scoring category is live suggestion quality, so the backend now does more than “ask the model for 3 ideas”.

- Cue extraction is cleaner and less noisy.
- A suggestion plan decides which jobs should be represented in the batch.
- Validation is stricter around generic or duplicate cards.
- The correction pass still exists if the model returns malformed output.
- The UI explains why the fresh batch exists, which improves trust during a live meeting.

## UI / UX Notes

- Manual and automatic refresh both flush the active recording segment before suggestions are generated.
- Suggestion batches show detected meeting mode and a short “why these suggestions” line.
- The newest batch is visually primary; older batches stay visible but secondary.
- Chat no longer feels frozen when an answer is in flight: the user can queue the next click or typed question.
- The layout remains three-column on desktop and collapses cleanly on narrower screens.

## Testing And Validation

### Commands

```bash
npm run typecheck
npm run test
npm run build
```

### Current Test Coverage

Focused unit tests cover:

- suggestion parsing and validation
- duplicate/generic suggestion rejection
- meeting cue extraction and context selection
- suggestion planning
- transcript filtering

## Logging

The app writes local JSONL logs to `logs/`:

- `app.jsonl`
- `client.jsonl`
- `audio.jsonl`
- `transcription.jsonl`
- `suggestions.jsonl`
- `chat.jsonl`
- `groq.jsonl`
- `errors.jsonl`

These help inspect latency, transcript filtering, Groq failures, and suggestion generation behavior during live use.

## Useful Commands

```bash
npm run dev
npm run typecheck
npm run test
npm run build
```

## Troubleshooting

### No Transcript

- Confirm microphone permissions
- Confirm a pasted key or server-side `GROQ_API_KEY`
- Speak long enough to produce a chunk
- Check `logs/transcription.jsonl` and `logs/errors.jsonl`

### No Suggestions

- Confirm transcript lines exist first
- Click Refresh manually
- Check `logs/suggestions.jsonl`
- Keep the suggestion model on `openai/gpt-oss-120b`

### No Chat Answer

- Confirm key availability
- Check `logs/chat.jsonl` and `logs/groq.jsonl`

### Rate Limits

Groq calls already retry short `429` responses. If limits persist, reduce prompt/context size or wait briefly.

## Tradeoffs

- I prioritized better cue selection, clearer answer structure, and faster perceived feedback over adding new product surface area.
- Tests focus on logic that changes assignment quality, not UI snapshots.
- The page is smaller and cleaner than before, but the audio/recording controller still lives in `app/page.tsx`; that is the next refactor if more time is available.

## Security Notes

- Do not commit API keys
- `.env.local`, `grok_api.txt`, `logs/`, and the local detailed documentation file are ignored by git
- If a key is accidentally exposed, revoke it and create a new one
