# Codex Voice Agent

A local Electron and TypeScript app that lets you talk to Codex through OpenAI
Realtime voice. The Realtime model is the voice/control layer; Codex app-server
is the computer-use agent that owns local execution, approvals, questions,
project state, and tool work.

## What it does

- Opens a compact voice window for speaking requests to Codex.
- Starts, resumes, summarizes, interrupts, and steers Codex app-server turns.
- Stores per-project workspaces under `~/Documents/Codex Voice Projects/`.
- Forwards Codex approval and tool-question requests back through the UI and
  voice layer.
- Uses OpenAI Realtime for audio input/output and `codex app-server` for the
  actual local work.

## Debugging

This repo is still early, so the app includes a debugging-oriented window rather
than a polished management surface. It shows project state, chats, runtime
status, events, pending approvals, and manual send/steer controls.

## Requirements

- Node.js and npm.
- A Codex CLI install available on `PATH` with `codex app-server` support.
- An OpenAI API key for Realtime voice.

## Setup

Install dependencies:

```sh
npm install
```

Configure an OpenAI API key in one of two ways:

- Set `OPENAI_API_KEY` in the environment before launching the app.
- Add the key from the app menu after launch. The app can store it through the
  local key store.

Optional Realtime settings:

```sh
export OPENAI_REALTIME_MODEL=gpt-realtime-2
export OPENAI_REALTIME_VOICE=marin
export OPENAI_REALTIME_REASONING_EFFORT=low
```

The app also exposes a Realtime model selector in Settings, with
`gpt-realtime-2` and `gpt-realtime-1.5` available. GPT Realtime 2 is the default
and supports low, medium, or high reasoning effort for voice sessions.

## Development

Run the app in development mode:

```sh
npm run dev
```

Typecheck:

```sh
npm run typecheck
```

Build:

```sh
npm run build
```

Preview the built Electron app:

```sh
npm run preview
```

## Project layout

```text
src/main/       Electron main process, Codex bridge, Realtime secret creation,
                project store, and orchestration.
src/preload/    Context-isolated renderer bridge.
src/renderer/   React UI and browser-side Realtime client.
src/shared/     Shared TypeScript types.
```

## Notes

The voice layer should stay narrow. It passes spoken intent, status requests,
approval answers, and steering instructions to Codex; it should not inspect the
computer, infer local state, or perform the task itself.

## License

MIT. See [LICENSE](./LICENSE).
