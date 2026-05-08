import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_REASONING_EFFORT,
  DEFAULT_REALTIME_VOICE,
  REALTIME_MODEL_OPTIONS,
  REALTIME_REASONING_EFFORT_OPTIONS,
  REALTIME_VOICE_OPTIONS,
  type AppState,
  type RealtimeClientSecret,
  type RealtimeModelId,
  type RealtimeReasoningEffort,
  type RealtimeVoiceId,
  type VoiceWebSearchAction,
  type VoiceWebSearchArgs,
  type VoiceWebSearchResult,
  type VoiceWebSearchSource,
} from "../shared/types";
import { getExaApiKey, getExaApiKeyStatus, getOpenAiApiKey, getOpenAiApiKeyStatus } from "./apiKeyStore";

const REALTIME_ENDPOINT = "https://api.openai.com/v1/realtime/client_secrets";
const EXA_SEARCH_ENDPOINT = "https://api.exa.ai/search";
const SETTINGS_FILE_NAME = "codex-voice-realtime-settings.json";
const DEFAULT_EXA_SEARCH_TYPE = "instant";
const DEFAULT_EXA_NUM_RESULTS = 5;
const DEFAULT_EXA_LIVECRAWL_TIMEOUT_MS = 5000;
const EXA_SEARCH_TYPES = new Set(["auto", "fast", "instant", "deep-lite", "deep", "deep-reasoning"]);
const webSearchControllers = new Map<string, AbortController>();

type RealtimeSettingsFile = {
  version: 1;
  model?: RealtimeModelId | null;
  voice?: RealtimeVoiceId | null;
  reasoningEffort?: RealtimeReasoningEffort | null;
  updatedAt?: string;
};

type ExaSearchResult = {
  title?: unknown;
  url?: unknown;
  author?: unknown;
  publishedDate?: unknown;
  highlights?: unknown;
  highlightScores?: unknown;
  score?: unknown;
};

type ExaSearchResponse = {
  requestId?: unknown;
  results?: unknown;
};

export function realtimeConfig(): AppState["realtime"] {
  const saved = readRealtimeSettings();
  const model =
    saved.model ??
    normalizeRealtimeModel(process.env.OPENAI_REALTIME_MODEL) ??
    DEFAULT_REALTIME_MODEL;
  const voice =
    saved.voice ??
    normalizeRealtimeVoice(process.env.OPENAI_REALTIME_VOICE) ??
    DEFAULT_REALTIME_VOICE;
  const selectedReasoningEffort =
    saved.reasoningEffort ??
    normalizeRealtimeReasoningEffort(process.env.OPENAI_REALTIME_REASONING_EFFORT) ??
    DEFAULT_REALTIME_REASONING_EFFORT;
  const reasoningEffort = realtimeReasoningEffort(model, selectedReasoningEffort);
  const status = getOpenAiApiKeyStatus();
  const available = status.configured;
  return {
    available,
    model,
    voice,
    reasoningEffort,
    reason: available
      ? null
      : "Add an OpenAI API key from the menu to enable Realtime voice.",
    apiKeySource: status.source,
    apiKeyEncrypted: status.encrypted,
  };
}

export function webSearchConfig(): AppState["webSearch"] {
  const status = getExaApiKeyStatus();
  return {
    available: status.configured,
    provider: "exa",
    reason: status.configured ? null : "Add an Exa API key to enable voice web search.",
    apiKeySource: status.source,
    apiKeyEncrypted: status.encrypted,
  };
}

export function saveRealtimeSettings(settings: {
  model?: RealtimeModelId | null;
  voice?: RealtimeVoiceId | null;
  reasoningEffort?: RealtimeReasoningEffort | null;
}): AppState["realtime"] {
  const current = readRealtimeSettings();
  const next: RealtimeSettingsFile = {
    ...current,
    version: 1,
    updatedAt: new Date().toISOString(),
  };

  if (settings.model !== undefined) {
    if (settings.model === null) {
      next.model = null;
    } else {
      next.model = requireRealtimeModel(settings.model);
    }
  }

  if (settings.voice !== undefined) {
    if (settings.voice === null) {
      next.voice = null;
    } else {
      next.voice = requireRealtimeVoice(settings.voice);
    }
  }

  if (settings.reasoningEffort !== undefined) {
    if (settings.reasoningEffort === null) {
      next.reasoningEffort = null;
    } else {
      next.reasoningEffort = requireRealtimeReasoningEffort(settings.reasoningEffort);
    }
  }

  writeRealtimeSettings(next);
  return realtimeConfig();
}

export async function createRealtimeClientSecret(): Promise<RealtimeClientSecret> {
  const apiKey = getOpenAiApiKey();
  const config = realtimeConfig();
  if (!apiKey) {
    throw new Error(config.reason ?? "Missing OPENAI_API_KEY.");
  }

  const response = await fetch(REALTIME_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session: {
        type: "realtime",
        model: config.model,
        ...(config.reasoningEffort
          ? {
              reasoning: {
                effort: config.reasoningEffort,
              },
            }
          : {}),
        output_modalities: ["audio"],
        instructions: realtimeInstructions(),
        audio: {
          input: {
            transcription: {
              model: "gpt-4o-mini-transcribe",
            },
            turn_detection: {
              type: "semantic_vad",
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            voice: config.voice,
          },
        },
        tools: realtimeTools(),
        tool_choice: "auto",
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Realtime session creation failed: ${response.status} ${text}`);
  }

  const data = (await response.json()) as {
    value?: string;
    client_secret?: { value?: string; expires_at?: number };
    expires_at?: number;
  };

  const value = data.value ?? data.client_secret?.value;
  if (!value) {
    throw new Error("Realtime client secret response did not include a value.");
  }

  return {
    value,
    expiresAt: data.expires_at ?? data.client_secret?.expires_at,
    model: config.model,
    voice: config.voice,
    reasoningEffort: config.reasoningEffort,
  };
}

export async function searchWebForRealtime(args: VoiceWebSearchArgs): Promise<VoiceWebSearchResult> {
  const apiKey = getExaApiKey();
  if (!apiKey) {
    throw new Error("Set EXA_API_KEY to use web search.");
  }

  const query = requireSearchQuery(args?.query);
  const context = optionalSearchContext(args?.context);
  const searchType = exaSearchType();
  const numResults = exaNumResults();
  const requestId = optionalRequestId(args?.requestId);
  const controller = requestId ? new AbortController() : null;
  if (requestId && controller) {
    webSearchControllers.set(requestId, controller);
  }
  const exaQuery = context ? `${query}\n\nContext: ${context}` : query;

  try {
    const response = await fetch(EXA_SEARCH_ENDPOINT, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json",
      },
      signal: controller?.signal,
      body: JSON.stringify({
        query: exaQuery,
        type: searchType,
        numResults,
        contents: {
          highlights: true,
          livecrawlTimeout: exaLivecrawlTimeoutMs(),
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Web search failed: ${response.status} ${text}`);
    }

    const data = (await response.json()) as ExaSearchResponse;
    const results = exaSearchResults(data);

    return {
      query,
      answer: exaSearchEvidenceText(query, results),
      sources: exaSearchSources(results),
      actions: [
        {
          type: "search",
          query,
        },
      ],
      model: `exa:${searchType}`,
      provider: "exa",
      searchType,
      requestId: stringFromUnknown(data.requestId),
    };
  } catch (error) {
    if (controller?.signal.aborted) {
      throw new Error("Web search canceled.");
    }
    throw error;
  } finally {
    if (requestId) {
      webSearchControllers.delete(requestId);
    }
  }
}

export function cancelWebSearchForRealtime(requestId: string): void {
  const controller = webSearchControllers.get(requestId);
  if (!controller) return;
  controller.abort();
  webSearchControllers.delete(requestId);
}

function requireSearchQuery(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("web_search requires a non-empty query.");
  }
  return value.trim().slice(0, 1000);
}

function optionalSearchContext(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 1600) : null;
}

function optionalRequestId(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 120) : null;
}

function exaSearchType(): string {
  const configured = process.env.EXA_WEB_SEARCH_TYPE?.trim();
  return configured && EXA_SEARCH_TYPES.has(configured) ? configured : DEFAULT_EXA_SEARCH_TYPE;
}

function exaNumResults(): number {
  return boundedInteger(process.env.EXA_WEB_SEARCH_NUM_RESULTS, DEFAULT_EXA_NUM_RESULTS, 1, 10);
}

function exaLivecrawlTimeoutMs(): number {
  return boundedInteger(
    process.env.EXA_WEB_SEARCH_LIVECRAWL_TIMEOUT_MS,
    DEFAULT_EXA_LIVECRAWL_TIMEOUT_MS,
    1000,
    20000,
  );
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function exaSearchResults(data: ExaSearchResponse): ExaSearchResult[] {
  return arrayRecords(data.results);
}

function exaSearchSources(results: ExaSearchResult[]): VoiceWebSearchSource[] {
  const sources = new Map<string, VoiceWebSearchSource>();
  for (const result of results) {
    const url = stringFromUnknown(result.url);
    if (!url || sources.has(url)) continue;
    sources.set(url, {
      url,
      title: stringFromUnknown(result.title),
      author: stringFromUnknown(result.author),
      publishedDate: stringFromUnknown(result.publishedDate),
      highlights: arrayStrings(result.highlights).slice(0, 5),
      score: numberFromUnknown(result.score),
    });
  }
  return [...sources.values()];
}

function exaSearchEvidenceText(query: string, results: ExaSearchResult[]): string {
  if (results.length === 0) {
    return `No Exa web search results were returned for "${query}".`;
  }

  const lines = [`Exa web search results for "${query}". Synthesize an answer from these sources; do not treat this as a prewritten answer.`];
  results.slice(0, 8).forEach((result, index) => {
    const title = stringFromUnknown(result.title) ?? "Untitled result";
    const url = stringFromUnknown(result.url) ?? "No URL";
    const author = stringFromUnknown(result.author);
    const publishedDate = stringFromUnknown(result.publishedDate);
    const highlights = arrayStrings(result.highlights)
      .map((highlight) => highlight.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, 3);
    lines.push(`${index + 1}. ${title}`);
    lines.push(`URL: ${url}`);
    if (publishedDate) lines.push(`Published: ${publishedDate}`);
    if (author) lines.push(`Author: ${author}`);
    if (highlights.length > 0) {
      lines.push(`Highlights: ${highlights.join(" / ")}`);
    }
  });
  return lines.join("\n");
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : [];
}

function arrayStrings(value: unknown): string[] {
  return Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        .map((item) => item.trim())
    : [];
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeRealtimeModel(value: unknown): RealtimeModelId | null {
  if (typeof value !== "string") return null;
  const model = value.trim();
  const option = REALTIME_MODEL_OPTIONS.find((candidate) => candidate.model === model);
  return option?.model ?? null;
}

function requireRealtimeModel(value: unknown): RealtimeModelId {
  const model = normalizeRealtimeModel(value);
  if (!model) {
    throw new Error(
      `Unsupported Realtime model "${String(value)}". Choose gpt-realtime-2 or gpt-realtime-1.5.`,
    );
  }
  return model;
}

function normalizeRealtimeVoice(value: unknown): RealtimeVoiceId | null {
  if (typeof value !== "string") return null;
  const voice = value.trim();
  const option = REALTIME_VOICE_OPTIONS.find((candidate) => candidate.voice === voice);
  return option?.voice ?? null;
}

function requireRealtimeVoice(value: unknown): RealtimeVoiceId {
  const voice = normalizeRealtimeVoice(value);
  if (!voice) {
    throw new Error(`Unsupported Realtime voice "${String(value)}".`);
  }
  return voice;
}

function normalizeRealtimeReasoningEffort(value: unknown): RealtimeReasoningEffort | null {
  if (typeof value !== "string") return null;
  const effort = value.trim();
  return REALTIME_REASONING_EFFORT_OPTIONS.includes(effort as RealtimeReasoningEffort)
    ? (effort as RealtimeReasoningEffort)
    : null;
}

function requireRealtimeReasoningEffort(value: unknown): RealtimeReasoningEffort {
  const effort = normalizeRealtimeReasoningEffort(value);
  if (!effort) {
    throw new Error(
      `Unsupported Realtime reasoning effort "${String(value)}". Choose ${REALTIME_REASONING_EFFORT_OPTIONS.join(
        ", ",
      )}.`,
    );
  }
  return effort;
}

function realtimeReasoningEffort(
  model: RealtimeModelId,
  selectedReasoningEffort: RealtimeReasoningEffort,
): RealtimeReasoningEffort | null {
  return model === "gpt-realtime-2" ? selectedReasoningEffort : null;
}

function realtimeSettingsPath(): string {
  return path.join(app.getPath("userData"), SETTINGS_FILE_NAME);
}

function readRealtimeSettings(): RealtimeSettingsFile {
  try {
    const filePath = realtimeSettingsPath();
    if (!existsSync(filePath)) return { version: 1 };
    const settings = JSON.parse(readFileSync(filePath, "utf8")) as RealtimeSettingsFile;
    return {
      version: 1,
      model: settings.model === null ? null : normalizeRealtimeModel(settings.model),
      voice: settings.voice === null ? null : normalizeRealtimeVoice(settings.voice),
      reasoningEffort: settings.reasoningEffort === null
        ? null
        : normalizeRealtimeReasoningEffort(settings.reasoningEffort),
      updatedAt: settings.updatedAt,
    };
  } catch {
    return { version: 1 };
  }
}

function writeRealtimeSettings(settings: RealtimeSettingsFile): void {
  const filePath = realtimeSettingsPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function realtimeInstructions(): string {
  return [
    "# Role",
    "You are the voice communication layer for a local Codex desktop app.",
    "",
    "# Boundary",
    "- Codex is the primary computer-use agent. Use submit_to_codex for substantial, ambiguous, or multi-step coding work.",
    "- You may inspect/search files and run focused local commands with exec_command when that helps you answer or triage quickly.",
    "- You have a web_search tool backed by Exa retrieval for current public web information. Use it when the user asks for latest/current facts or explicitly asks you to search the web.",
    "- You are Codex. The dedicated Codex threads are also Codex. Do not describe yourself as a separate assistant competing with or merely proxying Codex.",
    "- Think of yourself as the live Codex orchestrator: you can talk, inspect, patch small files, align plan files, manage projects/threads, and hand longer work to dedicated Codex threads.",
    "- You may edit files with apply_patch for small, clear, well-scoped changes. Longer implementation, risky changes, broad refactors, or work that should persist as a focused workstream should be dispatched to a dedicated Codex thread.",
    "- Multi-file edits are not a separate tool. They are just repeated apply_patch calls, or one patch that contains several file sections.",
    "- Do not invent hard tool-side size, risk, or file-count limits. Use judgment in guidance: inspect first, edit deliberately, and delegate bigger work to Codex.",
    "- The active Codex permission mode also governs your file/command tools. Full access means no filesystem sandbox; custom config follows Codex config when available.",
    "- Prefer rg for search, read files before editing them, keep workdir explicit when it matters, and verify edits with targeted commands when reasonable.",
    "- Reading project docs, plan files, AGENTS.md, README files, tests, and nearby source is often the best use of your file tools before deciding what to do.",
    "- A strong voice workflow is to turn the user's live thinking into a concise plan file, then dispatch a dedicated Codex thread to implement that plan. Use apply_patch for the plan file when the plan is clear, and dispatch_codex_task when implementation begins.",
    "- Projects are workspace/path-bound containers. Threads are named workstreams inside a project. You operate above all projects and can coordinate work across them.",
    "- Prefer canonical handles from status/list tool results, such as projectHandle and thread handle, when targeting a project or thread. Handles are the most reliable routing vocabulary.",
    "- When several Codex threads are running at once, act as the coordinator: create or switch threads, read or update per-workstream plan files, dispatch focused tasks to the right project/thread, steer running threads with new context, and use get_all_codex_thread_status before summarizing progress.",
    "- Keep plan files practical: current goal, relevant files, decisions, open questions, and the next concrete Codex task. Do not bloat them with generic process text.",
    "- If the user asks for a computer task beyond a small direct inspection or edit, call dispatch_codex_task with the user's request as faithfully as possible.",
    "- If the user asks to create a project or thread and gives an explicit name, use that name.",
    "- If the user asks to create a project or thread with useful context but without an explicit name, create a short, clear, relevant 2-6 word name from that context.",
    "- If the user asks to create a project or thread without a name or useful context, or the name would be ambiguous, ask: What would you like to use this thread or project for?",
    "- Creating a project only creates the project record. Do not create a thread or submit a task unless the user separately asks you to add a thread or start work.",
    "- When the user names a repo, folder, cwd, or workspace path, pass it as workspacePath so Codex threads are filed under that real workspace in the Codex app.",
    "- Creating a thread with context only creates, names, and switches to the thread. Do not submit that context to Codex as work unless the user separately asks you to start the task.",
    "- If the user asks to show open threads, list threads, switch threads, or get updates on a thread, use the thread/status tools instead of submit_to_codex.",
    "- Only add context that came from the current live voice conversation.",
    "- Do not make the task more ambitious than what the user asked.",
    "",
    "# Reasoning",
    "- For greetings, direct status checks, approval answers, and short confirmations, respond quickly.",
    "- For multi-step user requests, thread routing, task handoff, or possible ambiguity, reason briefly before speaking or calling a tool.",
    "- Do not spend extra reasoning effort trying to reconstruct unclear audio.",
    "",
    "# Preambles",
    "- Use one short spoken preamble only when you are about to hand off noticeable work to Codex or wait for a tool result.",
    "- Skip preambles for yes/no approvals, user corrections, status answers, unclear audio, and lightweight thread/project tools.",
    "- Describe the action, not your internal reasoning. Avoid filler like 'let me think' or 'one moment while I process that'.",
    "",
    "# Unclear Audio",
    "- Only act on clear audio or text.",
    "- If the user's audio is ambiguous, noisy, cut off, or you are unsure of the exact words, ask one brief clarification question.",
    "- Do not guess missing words, approve requests, or call submit_to_codex when the audio is unclear.",
    "",
    "# Tool Behavior",
    "- Use only tools explicitly provided in the current tool list.",
    "- Do not invent, rename, simulate, or claim to use unavailable tools.",
    "- When web_search succeeds, synthesize from the returned Exa titles, URLs, and highlights. Treat the tool output as search evidence, not a prewritten answer.",
    "- Only say Codex completed or changed something after the relevant tool result confirms it.",
    "- If a tool fails, explain the failure briefly in user-friendly language and offer the next useful step.",
    "",
    "# Conversation",
    "- Speak warmly and briefly.",
    "- Ask a short clarification only when the user's request is too ambiguous to hand to Codex safely.",
    "- Let the user interrupt you naturally.",
    "- When Codex needs approval, ask the user plainly before approving or declining. Mention the concrete command, file change, app/tool, or question when it is available.",
    "- If Codex asks to use an MCP server or app-server tool and the user says yes, allow it, or go ahead, call answer_codex_approval with decision accept.",
    "- If the user says yes, allow it, go ahead, or similar while Codex is waiting for approval, call answer_codex_approval with decision accept.",
    "- If the user says allow for this session, always allow during this session, or similar, call answer_codex_approval with decision acceptForSession.",
    "- If the user says no, do not allow, or decline, call answer_codex_approval with decision decline.",
    "- If the user says cancel, stop, or abort in response to an approval, call answer_codex_approval with decision cancel.",
    "- If Codex asks a question and the user answers by voice, call answer_codex_question.",
    "- When asked for status, use get_codex_status instead of guessing.",
    "- When asked for project or thread-specific status, or before summarizing parallel work, use get_all_codex_thread_status or get_codex_thread_status.",
    "- When asked which Codex model or reasoning effort is in use, use get_codex_status.",
    "- When asked to change Codex model, reasoning effort, or permissions, use set_codex_model, set_codex_reasoning_effort, or set_codex_permissions for the current thread unless the user says next turn only.",
  ].join("\n");
}

const APPLY_PATCH_DESCRIPTION = [
  "Use the apply_patch tool to edit files. Pass the patch text in the input field.",
  "The patch must start with *** Begin Patch and end with *** End Patch.",
  "Supported operations are *** Add File, *** Delete File, and *** Update File.",
  "For updates, use @@ hunks with enough surrounding context to identify the lines. File paths are relative to the active project working directory.",
  "A patch may touch more than one file; multi-file edits do not require a separate tool.",
].join("\n");

function realtimeTools(): unknown[] {
  return [
    {
      type: "function",
      name: "submit_to_codex",
      description:
        "Legacy direct handoff to Codex. Prefer dispatch_codex_task when the user names a project, workspace, thread, or workstream.",
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "The user's request, preserved as faithfully as possible.",
          },
          context: {
            type: "string",
            description: "Brief relevant context from the current voice conversation only. Include plan file paths or workstream names when they matter.",
          },
          chatId: {
            type: "string",
            description: "Optional target thread id when the user explicitly names a thread and it has already been resolved.",
          },
          threadHandle: {
            type: "string",
            description: "Optional canonical thread handle returned by status/list tools.",
          },
          chatName: {
            type: "string",
            description: "Optional target thread name when the user explicitly names an existing thread.",
          },
          workspacePath: {
            type: "string",
            description:
              "Optional real workspace/repo directory for this Codex task, such as ~/workspace/codex-voice. Use when the user names a path or repo so the thread appears under that workspace in Codex.",
          },
        },
        required: ["request"],
      },
    },
    {
      type: "function",
      name: "dispatch_codex_task",
      description:
        "Resolve or create a workspace-bound project and a named thread/workstream, then start a Codex turn there. Use this for implementation or substantial computer-use tasks, especially when coordinating multiple projects or threads.",
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "The user's request, preserved as faithfully as possible.",
          },
          context: {
            type: "string",
            description:
              "Brief relevant context from the current live voice conversation only. Include plan file paths or workstream intent when useful.",
          },
          project: {
            type: "object",
            description:
              "Project/workspace target. Prefer workspacePath when the user names a real repo/folder; use projectName for a known project nickname.",
              properties: {
                projectId: { type: "string" },
                projectHandle: {
                  type: "string",
                  description: "Canonical project handle returned by status/list tools, such as codex_voice.",
                },
                projectName: { type: "string" },
                workspacePath: {
                  type: "string",
                description: "Absolute or ~/ workspace/repo directory, such as ~/workspace/codex-voice.",
              },
              createIfMissing: {
                type: "boolean",
                description:
                  "Use true when the user wants to work in a named workspace/project and it may not exist in Codex Voice yet.",
              },
            },
          },
          thread: {
            type: "object",
            description:
              "Thread/workstream target inside the project. Use a clear short name when creating or resolving a workstream.",
              properties: {
                chatId: { type: "string" },
                threadHandle: {
                  type: "string",
                  description:
                    "Canonical thread handle returned by status/list tools, such as codex_voice/main_panel.",
                },
                chatName: { type: "string" },
                newChatName: {
                  type: "string",
                description:
                  "Name for a new thread/workstream if one should be created, such as main panel or left pane UX.",
              },
              createIfMissing: {
                type: "boolean",
                description: "Create the named thread if it does not already exist. Defaults to true for named threads.",
              },
              forceNew: {
                type: "boolean",
                description: "Create a fresh thread even if a similarly named thread already exists.",
              },
            },
          },
        },
        required: ["request"],
      },
    },
    {
      type: "function",
      name: "steer_codex",
      description:
        "Append an update, correction, or extra instruction to a running Codex turn. Use threadHandle, chatId, or chatName when several threads are active.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" },
          threadHandle: { type: "string" },
          chatId: { type: "string" },
          chatName: { type: "string" },
          projectId: { type: "string" },
          projectHandle: { type: "string" },
          projectName: { type: "string" },
          workspacePath: { type: "string" },
        },
        required: ["message"],
      },
    },
    {
      type: "function",
      name: "interrupt_codex",
      description: "Interrupt the active Codex turn when the user says to stop, cancel, or never mind.",
      parameters: {
        type: "object",
        properties: {
          reason: { type: "string" },
          threadHandle: { type: "string" },
          chatId: { type: "string" },
          chatName: { type: "string" },
          projectId: { type: "string" },
          projectHandle: { type: "string" },
          projectName: { type: "string" },
          workspacePath: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "get_codex_status",
      description:
        "Get the current Codex project, turn status, model, reasoning effort settings, and pending approvals/questions.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      type: "function",
      name: "web_search",
      description:
        "Search the live web with Exa for current public information, recent facts, news, pricing, docs, or anything the user explicitly asks to look up. Returns titles, URLs, and extractive highlights for the voice model to synthesize.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The search query or user question to answer from the web.",
          },
          context: {
            type: "string",
            description: "Optional short context from the current voice conversation that helps disambiguate the query.",
          },
        },
        required: ["query"],
      },
    },
    {
      type: "function",
      name: "exec_command",
      description: "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
      parameters: {
        type: "object",
        properties: {
          cmd: {
            type: "string",
            description: "Shell command to execute.",
          },
          workdir: {
            type: "string",
            description: "Optional working directory to run the command in; defaults to the active project's workspace.",
          },
          shell: {
            type: "string",
            description: "Shell binary to launch. Defaults to the user's default shell.",
          },
          tty: {
            type: "boolean",
            description: "Whether to allocate a TTY for the command. Defaults to false.",
          },
          login: {
            type: "boolean",
            description: "Whether to run the shell with login-shell semantics. Defaults to true.",
          },
          yield_time_ms: {
            type: "number",
            description: "How long to wait in milliseconds for output before yielding.",
          },
          max_output_tokens: {
            type: "number",
            description: "Maximum number of approximate tokens to return. Excess output will be truncated.",
          },
        },
        required: ["cmd"],
      },
    },
    {
      type: "function",
      name: "write_stdin",
      description: "Writes characters to an existing exec_command session and returns recent output.",
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "number",
            description: "Identifier of the running exec_command session.",
          },
          chars: {
            type: "string",
            description: "Bytes to write to stdin. Omit or pass an empty string to poll.",
          },
          yield_time_ms: {
            type: "number",
            description: "How long to wait in milliseconds for output before yielding.",
          },
          max_output_tokens: {
            type: "number",
            description: "Maximum number of approximate tokens to return. Excess output will be truncated.",
          },
        },
        required: ["session_id"],
      },
    },
    {
      type: "function",
      name: "apply_patch",
      description: APPLY_PATCH_DESCRIPTION,
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "Patch text using the Codex apply_patch format.",
          },
        },
        required: ["input"],
      },
    },
    {
      type: "function",
      name: "answer_codex_approval",
      description:
        "Answer a pending Codex approval, permission, MCP elicitation, auth, or app-server tool request after the user grants, denies, or cancels it by voice. If requestId is omitted, the app will use the only pending approval-style request when there is exactly one.",
      parameters: {
        type: "object",
        properties: {
          requestId: {
            type: "string",
            description: "The pending request id. Optional when exactly one approval is pending.",
          },
          decision: {
            type: "string",
            enum: ["accept", "acceptForSession", "decline", "cancel"],
            description:
              "Use accept for yes/allow; acceptForSession only when the user explicitly says for this session or always; decline for no; cancel for abort/stop.",
          },
          spokenConfirmation: {
            type: "string",
            description: "Short phrase the user said, useful for logs.",
          },
        },
        required: ["decision"],
      },
    },
    {
      type: "function",
      name: "answer_codex_question",
      description:
        "Answer a pending Codex question/requestUserInput prompt using the user's spoken answer. If requestId is omitted, the app will use the only pending question when there is exactly one.",
      parameters: {
        type: "object",
        properties: {
          requestId: {
            type: "string",
            description: "The pending question request id. Optional when exactly one question is pending.",
          },
          questionId: {
            type: "string",
            description: "Specific question id. Optional when the prompt has one question.",
          },
          answer: {
            type: "string",
            description: "The user's spoken answer.",
          },
        },
        required: ["answer"],
      },
    },
    {
      type: "function",
      name: "set_codex_model",
      description: "Set the Codex model for the current thread or next turn only.",
      parameters: {
        type: "object",
        properties: {
          model: { type: "string" },
          scope: {
            type: "string",
            enum: ["chat", "nextTurn"],
            description: "Use chat for the current thread setting unless the user says this is only for the next request/turn.",
          },
        },
        required: ["model", "scope"],
      },
    },
    {
      type: "function",
      name: "set_codex_reasoning_effort",
      description: "Set the Codex reasoning effort for the current thread or next turn only.",
      parameters: {
        type: "object",
        properties: {
          reasoningEffort: {
            type: "string",
            enum: ["none", "minimal", "low", "medium", "high", "xhigh"],
          },
          scope: {
            type: "string",
            enum: ["chat", "nextTurn"],
            description: "Use chat for the current thread setting unless the user says this is only for the next request/turn.",
          },
        },
        required: ["reasoningEffort", "scope"],
      },
    },
    {
      type: "function",
      name: "set_codex_permissions",
      description:
        "Set the Codex permission mode for the current thread, or next turn only if the user explicitly asks. Default permissions asks when Codex decides approval is needed; auto-review routes eligible approval prompts through Codex auto-review; full access runs without approval prompts or filesystem sandboxing; custom config.toml defers approval and sandbox settings to the active Codex config.",
      parameters: {
        type: "object",
        properties: {
          permissionMode: {
            type: "string",
            enum: ["default", "auto-review", "full-access", "custom-config"],
          },
          scope: {
            type: "string",
            enum: ["chat", "nextTurn"],
            description: "Use chat for the current thread setting unless the user says this is only for the next request/turn.",
          },
        },
        required: ["permissionMode", "scope"],
      },
    },
    {
      type: "function",
      name: "create_new_codex_project",
      description:
        "Create a new Codex Voice project record, without creating a thread or submitting work. Provide a short name when available or infer one from useful context; pass workspacePath when the user names a real repo/folder so future Codex threads appear under that workspace.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          workspacePath: {
            type: "string",
            description:
              "Optional real workspace/repo directory, such as ~/workspace/codex-voice. Omit only when the user wants a blank scratch voice project.",
          },
        },
      },
    },
    {
      type: "function",
      name: "create_new_codex_thread",
      description:
        "Create a new thread/workstream inside a target Codex Voice project, make it active, and do not submit work to Codex. Requires a short clear name; ask the user what the thread is for if no useful name/context exists.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          context: {
            type: "string",
            description: "Context used only to choose the thread name, not submitted to Codex as a task.",
          },
          projectId: { type: "string" },
          projectHandle: { type: "string" },
          projectName: { type: "string" },
          workspacePath: {
            type: "string",
            description: "Optional real workspace/repo directory for the project that should contain this thread.",
          },
          createProjectIfMissing: {
            type: "boolean",
            description: "Create the target project if it does not exist yet.",
          },
          forceNew: {
            type: "boolean",
            description: "Create a fresh thread even if a matching thread name exists.",
          },
        },
        required: ["name"],
      },
    },
    {
      type: "function",
      name: "list_codex_threads",
      description:
        "List Codex threads/workstreams in the current Codex Voice project, a target project, or all projects. Use this to get canonical projectHandle and thread handle values for later routing.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          projectHandle: { type: "string" },
          projectName: { type: "string" },
          workspacePath: { type: "string" },
          allProjects: {
            type: "boolean",
            description: "Use true when the user asks for all projects/threads rather than one project.",
          },
        },
      },
    },
    {
      type: "function",
      name: "get_all_codex_thread_status",
      description:
        "Get current status for active/open Codex threads across all projects or within one target project. Use before summarizing orchestration progress.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          projectHandle: { type: "string" },
          projectName: { type: "string" },
          workspacePath: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "switch_codex_thread",
      description: "Switch the active thread in the current or target Codex Voice project by id, name, or canonical threadHandle.",
      parameters: {
        type: "object",
        properties: {
          chatId: { type: "string" },
          threadHandle: { type: "string" },
          name: { type: "string" },
          projectId: { type: "string" },
          projectHandle: { type: "string" },
          projectName: { type: "string" },
          workspacePath: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "get_codex_thread_status",
      description:
        "Get updates/status for one thread or all threads in the current project. Use this before coordinating or summarizing parallel Codex work.",
      parameters: {
        type: "object",
        properties: {
          chatId: { type: "string" },
          threadHandle: { type: "string" },
          name: { type: "string" },
          projectId: { type: "string" },
          projectHandle: { type: "string" },
          projectName: { type: "string" },
          workspacePath: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "show_open_codex_threads",
      description: "Open the current project's thread list, equivalent to clicking the active project card.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      type: "function",
      name: "list_recent_codex_projects",
      description: "List Codex voice projects that can be summarized, continued, or used as routing targets.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      type: "function",
      name: "continue_codex_project",
      description: "Resume an existing Codex voice project by id, or the most recent project if no id is supplied.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          projectHandle: { type: "string" },
          projectName: { type: "string" },
          workspacePath: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "summarize_recent_project",
      description: "Ask Codex to summarize a recent project or thread, then return that summary for voice narration.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          projectHandle: { type: "string" },
          projectName: { type: "string" },
          workspacePath: { type: "string" },
          chatId: { type: "string" },
          threadHandle: { type: "string" },
          chatName: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "rename_codex_project",
      description: "Rename a Codex Voice project after the user asks to rename it.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          projectHandle: { type: "string" },
          projectName: { type: "string" },
          workspacePath: { type: "string" },
          name: { type: "string" },
        },
        required: ["name"],
      },
    },
    {
      type: "function",
      name: "rename_codex_thread",
      description: "Rename a Codex Voice thread after the user asks to rename it.",
      parameters: {
        type: "object",
        properties: {
          chatId: { type: "string" },
          threadHandle: { type: "string" },
          chatName: { type: "string" },
          projectId: { type: "string" },
          projectHandle: { type: "string" },
          projectName: { type: "string" },
          workspacePath: { type: "string" },
          name: { type: "string" },
        },
        required: ["name"],
      },
    },
    {
      type: "function",
      name: "remove_codex_project",
      description: "Remove a Codex Voice project from this app after the user asks to remove it.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          projectHandle: { type: "string" },
          projectName: { type: "string" },
          workspacePath: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "remove_codex_thread",
      description: "Remove a Codex Voice thread from this app after the user asks to remove it.",
      parameters: {
        type: "object",
        properties: {
          chatId: { type: "string" },
          threadHandle: { type: "string" },
          chatName: { type: "string" },
          projectId: { type: "string" },
          projectHandle: { type: "string" },
          projectName: { type: "string" },
          workspacePath: { type: "string" },
        },
      },
    },
  ];
}
