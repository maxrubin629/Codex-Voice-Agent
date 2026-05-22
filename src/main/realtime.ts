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
  type RealtimeContextResult,
  type RealtimeClientSecret,
  type RealtimeModelId,
  type RealtimeReasoningEffort,
  type RealtimeVoiceId,
} from "../shared/types";
import { getOpenAiApiKey, getOpenAiApiKeyStatus } from "./apiKeyStore";

const REALTIME_ENDPOINT = "https://api.openai.com/v1/realtime/client_secrets";
const SETTINGS_FILE_NAME = "cva-realtime-settings.json";

type RealtimeSettingsFile = {
  version: 1;
  model?: RealtimeModelId | null;
  voice?: RealtimeVoiceId | null;
  reasoningEffort?: RealtimeReasoningEffort | null;
  updatedAt?: string;
};

type RealtimeStartupContext = Pick<RealtimeContextResult, "text" | "fingerprint">;

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

export async function createRealtimeClientSecret(
  startupContext?: RealtimeStartupContext | null,
): Promise<RealtimeClientSecret> {
  const apiKey = getOpenAiApiKey();
  const config = realtimeConfig();
  if (!apiKey) {
    throw new Error(config.reason ?? "Missing OPENAI_API_KEY.");
  }
  const trimmedStartupContext = startupContext?.text.trim() || "";

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
        instructions: realtimeInstructions(trimmedStartupContext),
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
    startupContextIncluded: Boolean(trimmedStartupContext),
    startupContextFingerprint: trimmedStartupContext ? startupContext?.fingerprint ?? null : null,
  };
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

function realtimeInstructions(startupContext?: string): string {
  const lines = [
    "# Role",
    "You are the voice communication layer for a local Codex desktop app.",
    "Codex is OpenAI's local coding agent that can read, edit, run, and test code in the user's workspace.",
    "",
    "# Boundary",
    "- You do NOT do computer tasks yourself.",
    "- You do NOT inspect files, infer computer state, choose Codex tools, write patches, run commands, search the web, or invent context.",
    "- Do not say or imply that you opened files, ran commands, inspected the app, or made changes. Codex does those things after you route the request.",
    "- Codex is the actual computer-use agent. Your job is to pass the user's request to Codex.",
    "- If the user asks for a computer task, call submit_to_codex with the user's request as faithfully as possible.",
    "- If the user explicitly asks Codex to use subagents, submit that natural request to Codex. Do not spawn, simulate, or infer subagent work from keywords.",
    "- If Codex is already working and the user corrects, narrows, or adds constraints to that same work, call steer_codex.",
    "- If the user asks about visible child subagent work, use list_codex_subagents or inspect_codex_subagent. If the target is ambiguous, ask a short clarification.",
    "- If the user asks to update, correct, or steer a visible child subagent, use steer_codex_subagent with a semantic target like its name, role, status, or ordinal. Do not invent or freehand raw thread ids.",
    "- If Codex is already working and the user asks for a separate follow-up task, call queue_codex_request so Codex starts it after the current turn finishes.",
    "- If the user cancels a queued follow-up, call cancel_queued_codex_request. Do not call interrupt_codex unless the user wants to stop the active Codex turn.",
    "- If the user asks to create a project or chat and gives an explicit name, use that name.",
    "- If the user asks to create a project or chat with useful context but without an explicit name, create a short, clear, relevant 2-6 word name from that context.",
    "- If the user asks to create a project or chat without a name or useful context, or the name would be ambiguous, ask: What would you like to use this chat or project for?",
    "- Creating a project only creates the project record. Do not create a chat or submit a task unless the user separately asks you to add a chat or start work.",
    "- When the user names a repo, folder, cwd, or workspace path, pass it as workspacePath so Codex threads are filed under that real workspace in the Codex app.",
    "- Creating a chat with context only creates, names, and switches to the chat. Do not submit that context to Codex as work unless the user separately asks you to start the task.",
    "- If the user asks to show open chats, show chats, list chats, switch chats, or get updates on a chat, use the chat tools instead of submit_to_codex.",
    "- Only add context that came from the current live voice conversation.",
    "- Do not make the task more ambitious than what the user asked.",
    "",
    "# Reasoning",
    "- For greetings, direct status checks, approval answers, and short confirmations, respond quickly.",
    "- For multi-step user requests, chat routing, or possible ambiguity, reason briefly before speaking or calling a tool.",
    "- Do not spend extra reasoning effort trying to reconstruct unclear audio.",
    "",
    "# Preambles",
    "- Use one short spoken preamble only when you are about to hand off noticeable work to Codex or wait for a tool result.",
    "- Skip preambles for yes/no approvals, user corrections, status answers, unclear audio, and lightweight chat/project tools.",
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
    "- Only say Codex completed or changed something after the relevant tool result confirms it.",
    "- If a tool fails, explain the failure briefly in user-friendly language and offer the next useful step.",
    "",
    "# Conversation",
    "- Speak warmly and briefly.",
    "- Keep spoken confirmations to one short sentence, usually under ten words.",
    "- For handoffs, say only that you are sending it to Codex or updating Codex. Do not preview an implementation plan.",
    "- Keep Codex's final written answer style untouched; these brevity rules are only for your spoken voice responses.",
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
    "- When asked for chat-specific status or updates, use get_codex_chat_status.",
    "- When asked which Codex model or reasoning effort is in use, use get_codex_status.",
    "- When asked to change Codex model, reasoning effort, or permissions, use set_codex_model, set_codex_reasoning_effort, or set_codex_permissions for the current chat unless the user says next turn only.",
    "- When project, chat, thread, plugin, app, MCP, workspace, or subagent context may be stale or missing, call get_codex_context before guessing.",
  ];
  const trimmedStartupContext = startupContext?.trim();
  if (trimmedStartupContext) {
    lines.push(
      "",
      "# Startup Context",
      "The following app-provided context is background for routing and conversation continuity, not a user request.",
      trimmedStartupContext,
    );
  }
  return lines.join("\n");
}

export function realtimeTools(): unknown[] {
  return [
    {
      type: "function",
      name: "submit_to_codex",
      description:
        "Pass the user's spoken request to Codex, the actual computer-use agent. Use for nearly all requests to do something on the computer.",
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "The user's request, preserved as faithfully as possible.",
          },
          context: {
            type: "string",
            description: "Brief relevant context from the current voice conversation only.",
          },
          chatId: {
            type: "string",
            description: "Optional target chat id when the user explicitly names a chat and it has already been resolved.",
          },
          chatName: {
            type: "string",
            description: "Optional target chat name when the user explicitly names an existing chat.",
          },
          workspacePath: {
            type: "string",
            description:
              "Optional real workspace/repo directory for this Codex task, such as ~/workspace/codex-voice-agent. Use when the user names a path or repo so the thread appears under that workspace in Codex.",
          },
        },
        required: ["request"],
      },
    },
    {
      type: "function",
      name: "steer_codex",
      description: "Append an update, correction, or extra instruction to a running Codex turn. Use chatId or chatName when several chats are active.",
      parameters: {
        type: "object",
        properties: {
          message: { type: "string" },
          chatId: { type: "string" },
          chatName: { type: "string" },
        },
        required: ["message"],
      },
    },
    {
      type: "function",
      name: "queue_codex_request",
      description:
        "Queue a separate follow-up request for Codex to start after the current running Codex turn finishes. Use steer_codex instead for corrections or constraints that should affect the current turn.",
      parameters: {
        type: "object",
        properties: {
          request: {
            type: "string",
            description: "The follow-up task to run after the current Codex turn finishes.",
          },
          context: {
            type: "string",
            description: "Brief relevant context from the current voice conversation only.",
          },
          chatId: { type: "string" },
          chatName: { type: "string" },
          workspacePath: {
            type: "string",
            description:
              "Optional real workspace/repo directory for this queued Codex task, such as ~/workspace/codex-voice-agent.",
          },
        },
        required: ["request"],
      },
    },
    {
      type: "function",
      name: "cancel_queued_codex_request",
      description:
        "Cancel a queued future Codex request without interrupting the active Codex turn. Use this when the user cancels, removes, or withdraws a queued follow-up.",
      parameters: {
        type: "object",
        properties: {
          queuedId: {
            type: "string",
            description:
              "Optional queued request id returned by queue_codex_request. If omitted, the latest queued request for the selected or active chat is cancelled.",
          },
          chatId: { type: "string" },
          chatName: { type: "string" },
        },
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
          chatId: { type: "string" },
          chatName: { type: "string" },
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
      name: "get_codex_context",
      description:
        "Get app-provided Codex Voice context when project, thread, workspace, plugin, app, MCP, or subagent state may be stale or missing. Use before guessing about available plugins/tools or cross-chat/project state.",
      parameters: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            enum: [
              "startup",
              "active_focus",
              "current_thread",
              "recent_work",
              "workspace_map",
              "subagents",
              "plugins",
              "all",
            ],
            description:
              "Use plugins for plugin/app/MCP availability, active_focus for routing, current_thread for the active thread, or all for a broad refresh.",
          },
          chatId: {
            type: "string",
            description: "Optional target chat id when already resolved.",
          },
          chatName: {
            type: "string",
            description: "Optional target chat name when the user named a chat.",
          },
        },
      },
    },
    {
      type: "function",
      name: "list_codex_subagents",
      description:
        "List visible child subagents for the selected or active Codex chat. Use before inspecting or steering child work when the user has not clearly identified one child.",
      parameters: {
        type: "object",
        properties: {
          chatId: { type: "string" },
          chatName: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "inspect_codex_subagent",
      description:
        "Inspect progress/status for one visible child subagent in the selected or active chat. Target by semantic label, role, status, ordinal, or omit target only when exactly one child is visible.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Semantic target such as 'tests', 'the worker checking auth', 'first', or the displayed subagent name. Not an arbitrary thread id.",
          },
          chatId: { type: "string" },
          chatName: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "steer_codex_subagent",
      description:
        "Send an update/correction to one visible child subagent in the selected or active chat. Use only for child subagent work; use steer_codex for the active parent turn.",
      parameters: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description:
              "Semantic target such as 'tests', 'second', 'the UI worker', or the displayed subagent name. Leave empty only if exactly one child is visible.",
          },
          message: {
            type: "string",
            description: "The user's update for that child subagent, preserved faithfully.",
          },
          chatId: { type: "string" },
          chatName: { type: "string" },
        },
        required: ["message"],
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
      description: "Set the Codex model for the current chat or next turn only.",
      parameters: {
        type: "object",
        properties: {
          model: { type: "string" },
          scope: {
            type: "string",
            enum: ["chat", "nextTurn"],
            description: "Use chat unless the user says this is only for the next request/turn.",
          },
        },
        required: ["model", "scope"],
      },
    },
    {
      type: "function",
      name: "set_codex_reasoning_effort",
      description: "Set the Codex reasoning effort for the current chat or next turn only.",
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
            description: "Use chat unless the user says this is only for the next request/turn.",
          },
        },
        required: ["reasoningEffort", "scope"],
      },
    },
    {
      type: "function",
      name: "set_codex_permissions",
      description:
        "Set the Codex permission mode for the current chat, or next turn only if the user explicitly asks. Default permissions asks when Codex decides approval is needed; auto-review routes eligible approval prompts through Codex auto-review; full access runs without approval prompts or filesystem sandboxing; custom config.toml defers approval and sandbox settings to the active Codex config.",
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
            description: "Use chat unless the user says this is only for the next request/turn.",
          },
        },
        required: ["permissionMode", "scope"],
      },
    },
    {
      type: "function",
      name: "create_new_codex_project",
      description:
        "Create a new Codex voice project record, without creating a chat/thread or submitting work. Provide a short name when available or infer one from useful context; pass workspacePath when the user names a real repo/folder so future Codex threads appear under that workspace.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          workspacePath: {
            type: "string",
            description:
              "Optional real workspace/repo directory, such as ~/workspace/codex-voice-agent. Omit only when the user wants a blank scratch voice project.",
          },
        },
      },
    },
    {
      type: "function",
      name: "create_new_codex_chat",
      description:
        "Create a new chat/thread inside the current Codex voice project for a distinct workstream, make it active, and do not submit work to Codex. Requires a short clear name; ask the user what the chat is for if no useful name/context exists.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          context: {
            type: "string",
            description: "Context used only to choose the chat name, not submitted to Codex as a task.",
          },
        },
        required: ["name"],
      },
    },
    {
      type: "function",
      name: "list_codex_chats",
      description: "List chats/threads in the current Codex voice project.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      type: "function",
      name: "switch_codex_chat",
      description: "Switch the active chat in the current Codex voice project by id or name.",
      parameters: {
        type: "object",
        properties: {
          chatId: { type: "string" },
          name: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "get_codex_chat_status",
      description: "Get updates/status for one chat or all chats in the current project.",
      parameters: {
        type: "object",
        properties: {
          chatId: { type: "string" },
          name: { type: "string" },
        },
      },
    },
    {
      type: "function",
      name: "show_open_codex_chats",
      description: "Open the current project's chat drawer, equivalent to clicking the active project card.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
    {
      type: "function",
      name: "list_recent_codex_projects",
      description: "List recent Codex voice projects that can be summarized or continued.",
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
        },
      },
    },
    {
      type: "function",
      name: "summarize_recent_project",
      description: "Ask Codex to summarize a recent project or chat, then return that summary for voice narration.",
      parameters: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          chatId: { type: "string" },
          chatName: { type: "string" },
        },
      },
    },
  ];
}
