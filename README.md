# Codex Voice

![Codex Voice](./docs/assets/codex-voice-readme-banner.png)

Codex Voice is a local desktop app that lets you talk to Codex through OpenAI
Realtime voice. Realtime handles the voice/control layer; `codex app-server`
owns local execution, approvals, questions, project state, and tool work.

## Features

- Compact voice window for speaking requests to Codex.
- Project creation, resume, summarize, interrupt, and steer flows for
  `codex app-server` turns.
- Per-project workspaces stored under `~/Documents/Codex Voice Projects/`.
- Approval and tool-question forwarding between Codex, the UI, and the voice
  layer.
- Debug window for project state, chats, runtime status, events, pending
  approvals, and manual send/steer controls.

## Requirements

- Node.js and npm
- Codex CLI on `PATH` with `codex app-server` support
- OpenAI API key for Realtime voice

## Setup

Install dependencies.

```sh
npm install
```

Configure an OpenAI API key in one of two ways.

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
and supports minimal, low, medium, high, or xhigh reasoning effort for voice
sessions.

The app uses OpenAI's ephemeral-token WebRTC path: the desktop main process
creates a Realtime client secret with the saved or environment API key, and the
renderer posts browser SDP to `/v1/realtime/calls` with that short-lived secret.
It does not use the unified server-side multipart `/v1/realtime/calls` sample.

## Development

Run the app in development mode.

```sh
npm run dev
```

Typecheck.

```sh
npm run typecheck
```

Build.

```sh
npm run build
```

Preview the built desktop app.

```sh
npm run preview
```

## Project layout

```text
src/main/       Desktop main process, Codex bridge, Realtime secret creation,
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
