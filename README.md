# MeetMind

MeetMind is a browser-based live meeting copilot. It listens to microphone audio, transcribes the conversation in short chunks, generates useful live suggestions from recent context, and lets the user open a detailed chat answer from any suggestion.

The app is designed as a three-column workspace:

- **Mic & Transcript**: captures live audio from the microphone and appends transcript chunks.
- **Live Suggestions**: produces exactly three context-aware suggestions from the latest transcript.
- **Chat Answers**: expands clicked suggestions or typed questions into detailed answers grounded in the transcript.

## Features

- Live microphone recording with start and stop controls.
- Chunked transcription through Groq Whisper Large V3.
- Configurable transcript language, defaulting to English (`en`) to reduce non-English hallucinations from music, silence, and notification sounds.
- Transcript quality filtering using audio activity and Whisper segment confidence signals.
- Manual refresh that updates the latest transcript chunk before generating suggestions.
- Automatic suggestion refresh while recording.
- Exactly three fresh suggestions per refresh.
- Suggestion categories:
  - Question to ask
  - Talking point
  - Answer
  - Fact-check
  - Clarifying info
- Right-side chat powered by Groq GPT-OSS 120B.
- Markdown rendering for chat answers, including tables, lists, bold text, and inline code.
- Session-only state. Reloading the page clears transcript, suggestions, and chat.
- Local structured logs with rotation for debugging.

## Tech Stack

- **Framework**: Next.js App Router
- **Language**: TypeScript
- **UI**: React
- **Transcription**: Groq Whisper Large V3
- **Suggestions and chat**: Groq GPT-OSS 120B
- **Markdown rendering**: `react-markdown` with `remark-gfm`
- **Logging**: local JSON Lines files in `logs/`

## Project Structure

```txt
app/
  api/
    chat/route.ts          Detailed chat answers
    logs/route.ts          Browser-to-server log ingestion
    suggestions/route.ts   Live suggestion generation
    transcribe/route.ts    Audio transcription
  globals.css              App styling
  page.tsx                 Main three-column interface
lib/
  server-logger.ts         Rotating JSONL logger
README.md
package.json
```

## Requirements

- Node.js 22.13+ recommended
- npm 10+
- A Groq API key
- A browser that supports `MediaRecorder`
- Microphone access enabled

Microphone capture requires a secure browser context. Localhost works:

```bash
http://localhost:3000
```

## Quick Start

1. Clone the repository:

```bash
git clone git@github.com:VedantSawant6900/meetmind.git
cd meetmind
```

2. Install dependencies:

```bash
npm install
```

3. Start the development server:

```bash
npm run dev
```

4. Open the app:

```txt
http://localhost:3000
```

5. Open **Settings** and paste your Groq API key.

6. Click the microphone button and start speaking.

## Settings

The top-right **Settings** modal controls the runtime model parameters:

| Setting | Default | Purpose |
| --- | --- | --- |
| Groq API key | empty | Used by API routes to call Groq. |
| Whisper model | `whisper-large-v3` | Audio transcription model. |
| Transcript language | `en` | Sent to Whisper to prefer English transcription. |
| Suggestion model | `openai/gpt-oss-120b` | Used for live suggestions and chat answers. |
| Chunk interval | `10` seconds | How often audio is chunked, transcribed, and used for refresh timing. |

Settings are stored in browser session storage, not committed to the repository.

## Environment Variables

The app can use the API key from either the browser Settings modal or an environment variable.

Create `.env.local` if you want a local fallback key:

```bash
GROQ_API_KEY=your_groq_key_here
```

`.env.local` is ignored by git.

## How The App Works

### 1. Audio Capture

The browser records microphone input with `MediaRecorder`. Audio is split into short segments based on the chunk interval.

Before uploading, the client samples audio RMS activity. Segments that are too small, too short, or likely silent are skipped.

### 2. Transcription

Audio chunks are sent to:

```txt
POST /api/transcribe
```

The route forwards the file to Groq Whisper with:

- `model`
- `language`
- `response_format=verbose_json`
- `temperature=0`

The verbose response provides confidence signals such as:

- `avg_logprob`
- `compression_ratio`
- `no_speech_prob`

The client uses those signals with browser audio stats to filter weak hallucinated fragments.

### 3. Live Suggestions

Suggestions are generated through:

```txt
POST /api/suggestions
```

The request includes recent transcript lines and the configured suggestion model. The server asks Groq to return exactly three suggestions as JSON. Each suggestion contains:

```ts
type Suggestion = {
  type: "question" | "talking" | "answer" | "fact" | "clarifying";
  text: string;
};
```

Manual refresh does two things:

1. Flushes the current recording segment if recording is active.
2. Generates three suggestions from the updated transcript context.

### 4. Chat Answers

Chat answers are generated through:

```txt
POST /api/chat
```

The request includes:

- The clicked suggestion or typed user question
- Recent transcript context
- Recent chat history
- The configured Groq model

The answer is rendered as Markdown in the right column.

## Logs

The app writes local logs to `logs/`. This folder is ignored by git.

Log files:

| File | Purpose |
| --- | --- |
| `app.jsonl` | App lifecycle and Settings events |
| `client.jsonl` | Browser UI and recorder state |
| `audio.jsonl` | Audio chunk metadata and speech gating |
| `transcription.jsonl` | Transcription request and transcript filter outcomes |
| `suggestions.jsonl` | Live suggestion request and response details |
| `chat.jsonl` | Detailed answer and direct chat request details |
| `groq.jsonl` | Groq request status and latency |
| `errors.jsonl` | Rejections, exceptions, and failures |

Each log file rotates up to 10 files. Default max size is 512 KB per file. Override it with:

```bash
LOG_MAX_BYTES=1048576 npm run dev
```

## Replication Steps

Use this flow to reproduce the current app behavior from a fresh checkout:

1. Install dependencies:

```bash
npm install
```

2. Run validation:

```bash
npm run typecheck
npm run build
```

3. Start the app:

```bash
npm run dev
```

4. Open:

```txt
http://localhost:3000
```

5. Open **Settings**.

6. Enter:

```txt
Whisper model: whisper-large-v3
Transcript language: en
Suggestion model: openai/gpt-oss-120b
Chunk interval: 10
```

7. Paste a Groq API key.

8. Click the mic button and speak for at least one chunk interval.

9. Confirm the left column appends transcript text.

10. Click **Refresh** in the middle column.

11. Confirm exactly three suggestions appear at the top.

12. Click any suggestion.

13. Confirm the right column adds the suggestion and returns a detailed Markdown-formatted answer.

## Useful Commands

```bash
npm run dev        # Start local development server
npm run typecheck  # Run TypeScript checks
npm run build      # Build production bundle
```

## Troubleshooting

### Microphone Permission Denied

Use `http://localhost:3000`, not the network URL, when testing locally. Check browser site permissions and system microphone privacy settings.

### No Transcript Appears

- Confirm the Groq API key is present in Settings.
- Confirm the browser has mic access.
- Speak for longer than the chunk interval.
- Check `logs/audio.jsonl` for skipped chunks.
- Check `logs/errors.jsonl` for API errors.

### Suggestions Do Not Appear

- Confirm transcript lines exist first.
- Click **Refresh** manually.
- Check `logs/suggestions.jsonl`.
- Check that the suggestion model is `openai/gpt-oss-120b`.

### Chat Does Not Answer

- Confirm a Groq API key is available.
- Check `logs/chat.jsonl`.
- Check `logs/groq.jsonl` for upstream status codes.

### Markdown Table Looks Wide

Tables inside chat answers scroll horizontally inside the bubble so the layout remains stable.

## Security Notes

- Do not commit API keys.
- `grok_api.txt`, `.env.local`, and `logs/` are ignored.
- If a key is accidentally pasted into chat, screenshots, or a tracked file, revoke it and create a new one.
