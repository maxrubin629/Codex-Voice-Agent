---
name: realtime-project-orientation
description: Create Realtime-ready project orientation context documents for repos, workspaces, and computer-work tasks. Use when the user asks to orient the Realtime model, create a project context package, summarize a repo for voice routing, prepare injected Realtime context, or document task context for files, documents, spreadsheets, presentations, browser work, desktop-app work, or other Codex Voice projects.
---

# Realtime Project Orientation

## Purpose

Create a stable context document that can be injected into the Realtime model for a specific project or task. Write for the voice routing layer: concise, factual, and useful for deciding how to hand work to Codex.

Do not produce a casual project summary. Do not imply the Realtime model inspected files, ran commands, or performed work itself. Treat the document as app-provided context that helps Realtime understand what the project is, where tasks belong, and what not to invent.

## Workflow

1. Identify whether the target is a code repo/workspace or a computer-work task.
2. Inspect only the minimum sources needed to ground the document.
3. Separate facts found in files from reasonable inferences.
4. Avoid secrets, credentials, private env files, generated artifacts, dependency folders, caches, and unrelated local state.
5. Produce a short Markdown document suitable for later prompt/context injection.

For repo inspection, you may run:

```sh
python3 .codex/skills/realtime-project-orientation/scripts/inspect_project.py .
```

Use the helper as a first pass only. Verify important claims from source files before including them.

## Repo Or Workspace Document

Use this shape for code repos, local apps, CLI tools, packages, and project folders with manifests or source code.

```md
# Realtime Project Orientation

## Project Purpose
[One or two factual sentences about what this project is for.]

## Realtime Routing Context
[What Realtime should know when deciding whether to answer directly, ask a clarification, call status/chat tools, or hand work to Codex.]

## Main Entry Points
- [Key source folders, app commands, task commands, config files, docs, or runtime surfaces.]

## Constraints
- [Supported platforms, coding style, testing requirements, deployment limits, security boundaries, or voice-layer limits.]

## Pain Points / Off-Limits
- [Known fragile areas, deferred work, behaviors not to infer, files not to touch, or tool boundaries.]

## Example Workflow
[A short concrete workflow, such as how to start the app, run tests, inspect a document, or hand a task to Codex.]

## Open Questions
- [Only include if something material is unknown.]
```

Favor high-signal specifics over broad inventory. Include commands only when they are evidenced by manifests, environment configs, docs, or local conventions.

## Computer-Work Document

Use this shape for spreadsheet, slide deck, document, browser, desktop-app, image, or other task-oriented projects where there may not be a repo.

```md
# Realtime Task Orientation

## Project Purpose
[What the user is trying to accomplish and the intended output.]

## Realtime Routing Context
[How Realtime should route follow-ups, approvals, status requests, and corrections.]

## Main Entry Points
- [Source artifacts, target files, apps/connectors/tools, relevant folders, URLs, or active windows if provided.]

## Constraints
- [Formatting, audience, privacy, file format, app/tool, review, deadline, or non-destructive-work constraints.]

## Pain Points / Off-Limits
- [Known risks, ambiguous source material, files/apps not to touch, or operations requiring explicit user approval.]

## Example Workflow
[A short concrete workflow for inspecting inputs, creating/updating outputs, and verifying the result.]

## Open Questions
- [Only include if something material is unknown.]
```

Do not add source artifacts or app state that were not provided or inspected through available tools. If a task requires the user's live app state and no app tool is available, say that in `Open Questions`.

## Writing Rules

- Keep the document short enough to fit comfortably in Realtime instructions or app-provided context.
- Use direct, stable language: what the project is, how work is routed, and what constraints matter.
- Distinguish evidence from inference with phrases like `Evidence:` or `Likely:` when needed.
- Never include secrets or secret-looking values. Do not read `.env*`, key files, credentials, tokens, caches, dependency installs, or generated output unless the user explicitly asks and it is safe.
- Do not turn the orientation document into a work request for Codex.
- Do not modify app code or wire injection unless the user explicitly asks for integration work.
