import type { RealtimeClientSecret } from "../shared/types";
import { getOpenAiApiKey, getOpenAiApiKeyStatus } from "./apiKeyStore";

const REALTIME_ENDPOINT = "https://api.openai.com/v1/realtime/client_secrets";

export function realtimeConfig(): {
  available: boolean;
  model: string;
  voice: string;
  reason: string | null;
  apiKeySource: "environment" | "saved" | null;
  apiKeyEncrypted: boolean;
} {
  const model = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime-1.5";
  const voice = process.env.OPENAI_REALTIME_VOICE || "marin";
  const status = getOpenAiApiKeyStatus();
  const available = status.configured;
  return {
    available,
    model,
    voice,
    reason: available
      ? null
      : "Add an OpenAI API key from the menu to enable Realtime voice.",
    apiKeySource: status.source,
    apiKeyEncrypted: status.encrypted,
  };
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
        output_modalities: ["audio"],
        instructions: realtimeInstructions(),
        audio: {
          input: {
            turn_detection: {
              type: "semantic_vad",
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
  };
}

function realtimeInstructions(): string {
  return [
    "# Role",
    "You are the voice communication layer for a local Codex desktop app.",
    "",
    "# Boundary",
    "- Codex is the primary computer-use agent. Use submit_to_codex for substantial, ambiguous, or multi-step coding work.",
    "- You may inspect/search files and run focused local commands with exec_command when that helps you answer or triage quickly.",
    "- You may edit files with apply_patch for small, clear, well-scoped changes. Larger changes should be handed to Codex.",
    "- Multi-file edits are not a separate tool. They are just repeated apply_patch calls, or one patch that contains several file sections.",
    "- Do not invent hard tool-side size, risk, or file-count limits. Use judgment in guidance: inspect first, edit deliberately, and delegate bigger work to Codex.",
    "- The active Codex permission mode also governs your file/command tools. Full access means no filesystem sandbox; custom config follows Codex config when available.",
    "- Prefer rg for search, read files before editing them, keep workdir explicit when it matters, and verify edits with targeted commands when reasonable.",
    "- Reading project docs, plan files, AGENTS.md, README files, tests, and nearby source is often the best use of your file tools before deciding what to do.",
    "- A strong voice workflow is to turn the user's live thinking into a concise plan file, then ask Codex to implement that plan. Use apply_patch for the plan file when the plan is clear, and submit_to_codex when implementation begins.",
    "- When several Codex chats are running at once, act as the coordinator: create or switch chats, read or update per-workstream plan files, submit focused tasks to the right chat, steer running chats with new context, and use get_codex_chat_status before summarizing progress.",
    "- Keep plan files practical: current goal, relevant files, decisions, open questions, and the next concrete Codex task. Do not bloat them with generic process text.",
    "- If the user asks for a computer task beyond a small direct inspection or edit, call submit_to_codex with the user's request as faithfully as possible.",
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
    "- When asked for chat-specific status or updates, use get_codex_chat_status.",
    "- When asked which Codex model or reasoning effort is in use, use get_codex_status.",
    "- When asked to change Codex model, reasoning effort, or permissions, use set_codex_model, set_codex_reasoning_effort, or set_codex_permissions for the current chat unless the user says next turn only.",
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
        "Pass the user's spoken request to Codex, the actual computer-use agent. Use for implementation work, and target a named chat when coordinating parallel workstreams.",
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
            description: "Optional target chat id when the user explicitly names a chat and it has already been resolved.",
          },
          chatName: {
            type: "string",
            description: "Optional target chat name when the user explicitly names an existing chat.",
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
              "Optional real workspace/repo directory, such as ~/workspace/codex-voice. Omit only when the user wants a blank scratch voice project.",
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
      description: "Get updates/status for one chat or all chats in the current project. Use this before coordinating or summarizing parallel Codex work.",
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
