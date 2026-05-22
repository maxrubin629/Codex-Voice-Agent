import { createHash } from "node:crypto";

import type {
  ActiveThreadSummary,
  AppState,
  CodexChatRuntime,
  RealtimeContextInventory,
  RealtimeContextResult,
  RealtimeContextScope,
  VoiceChat,
  VoiceProject,
  VoiceSubagentListResult,
  VoiceTranscriptMessage,
} from "../shared/types";

export type RealtimeWorkspaceEntry = {
  path: string;
  kind: "file" | "directory";
};

type BuildRealtimeContextOptions = {
  scope?: RealtimeContextScope;
  generatedAt?: string;
  state: AppState;
  activeThreadSummary?: ActiveThreadSummary | null;
  chatStatuses?: CodexChatRuntime[];
  subagents?: VoiceSubagentListResult | null;
  transcriptMessages?: VoiceTranscriptMessage[];
  inventory?: RealtimeContextInventory | null;
  workspaceEntries?: RealtimeWorkspaceEntry[];
  errorMessage?: string;
};

const DEFAULT_SCOPE: RealtimeContextScope = "all";
const MAX_RECENT_PROJECTS = 6;
const MAX_CHATS_PER_PROJECT = 6;
const MAX_THREAD_TURNS = 4;
const MAX_PROGRESS_ITEMS = 6;
const MAX_ARTIFACTS = 6;
const MAX_TRANSCRIPT_MESSAGES = 8;
const MAX_WORKSPACE_ENTRIES = 80;
const MAX_SUBAGENTS = 10;
const MAX_PLUGINS = 24;
const MAX_MCP_SERVERS = 20;
const MAX_MCP_TOOLS = 12;
const MAX_APPS = 20;
const MAX_LINE_LENGTH = 260;

export function buildRealtimeContextResult(options: BuildRealtimeContextOptions): RealtimeContextResult {
  const scope = options.scope ?? DEFAULT_SCOPE;
  const generatedAt = options.generatedAt ?? new Date().toISOString();
  const wrapper = scope === "startup" ? "startup_context" : `realtime_context scope="${escapeXmlAttr(scope)}"`;
  const sections = contextSections(scope, options);
  const body = [
    scope === "startup"
      ? "Startup context from Codex Voice Agent."
      : `Realtime context from Codex Voice Agent for scope: ${scope}.`,
    "",
    `Generated: ${generatedAt}`,
    "",
    ...sections,
  ].join("\n");
  const text = [`<${wrapper}>`, trimBlankLines(body), `</${wrapper.split(" ")[0]}>`].join("\n");
  return {
    ok: !options.errorMessage,
    scope,
    text,
    fingerprint: fingerprintText(text),
    generatedAt,
    ...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
  };
}

export function fingerprintText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

function contextSections(scope: RealtimeContextScope, options: BuildRealtimeContextOptions): string[] {
  const sections: string[] = [];
  if (includesSection(scope, "active_focus")) sections.push(activeFocusSection(options));
  if (includesSection(scope, "current_thread")) sections.push(currentThreadSection(options.activeThreadSummary));
  if (includesSection(scope, "recent_work")) sections.push(recentWorkSection(options.state, options.chatStatuses ?? []));
  if (includesSection(scope, "workspace_map")) sections.push(workspaceMapSection(options.workspaceEntries ?? []));
  if (includesSection(scope, "plugins")) sections.push(pluginsSection(options.inventory));
  if (includesSection(scope, "subagents")) sections.push(subagentsSection(options.subagents));
  if (includesSection(scope, "all") || scope === "startup" || scope === "active_focus") {
    sections.push(recentTranscriptSection(options.transcriptMessages ?? []));
  }
  if (scope === "startup" || scope === "all") sections.push(notesSection());
  return sections.filter((section) => section.trim().length > 0);
}

function includesSection(scope: RealtimeContextScope, section: RealtimeContextScope): boolean {
  if (scope === "startup" || scope === "all") return true;
  return scope === section;
}

function activeFocusSection(options: BuildRealtimeContextOptions): string {
  const project = activeProject(options.state);
  const chat = project ? activeChat(project, options.state.runtime.activeChatId) : null;
  if (!project) {
    return section("Current Focus", ["No active project."]);
  }
  const runtime = options.chatStatuses?.find((candidate) => candidate.chatId === chat?.id) ?? null;
  return section("Current Focus", [
    `Project: ${project.displayName}`,
    `Project ID: ${project.id}`,
    `Workspace: ${project.workspacePath || project.folderPath || "none"}`,
    chat ? `Chat: ${chat.displayName}` : "Chat: none",
    chat ? `Chat ID: ${chat.id}` : null,
    chat ? `Thread ID: ${chat.codexThreadId ?? "none"}` : null,
    `App status: ${options.state.runtime.status}`,
    `Thread status: ${runtime?.threadStatus ?? options.state.runtime.threadStatus ?? "unknown"}`,
    runtime?.activeTurnId ? `Active turn: ${runtime.activeTurnId}` : null,
    runtime?.todos?.length ? `Todos: ${runtime.todos.map((todo) => `${todo.status}: ${todo.text}`).join("; ")}` : null,
    options.state.runtime.pendingRequests.length
      ? `Pending requests: ${options.state.runtime.pendingRequests.map((request) => request.title).join("; ")}`
      : null,
  ]);
}

function currentThreadSection(summary: ActiveThreadSummary | null | undefined): string {
  if (!summary || summary.status === "empty") return section("Current Thread", ["No active Codex thread."]);
  if (summary.status === "error") {
    return section("Current Thread", [`Unable to read active thread: ${summary.errorMessage ?? "unknown error"}`]);
  }

  const lines: Array<string | null> = [
    `Thread ID: ${summary.threadId ?? "none"}`,
    `Turns: ${summary.turnCount}`,
    `Latest turn status: ${summary.latestTurnStatus ?? "unknown"}`,
    summary.latestAssistantText ? `Latest assistant: ${truncate(summary.latestAssistantText, MAX_LINE_LENGTH)}` : null,
  ];
  for (const item of summary.progress.slice(0, MAX_PROGRESS_ITEMS)) {
    lines.push(`Progress: ${item.status} - ${item.label}${item.detail ? ` - ${truncate(item.detail, 120)}` : ""}`);
  }
  for (const artifact of [...summary.artifacts, ...summary.referencedFiles].slice(0, MAX_ARTIFACTS)) {
    lines.push(`Artifact: ${artifact.title}${artifact.path ? ` (${artifact.path})` : ""}`);
  }
  for (const turn of summary.turns.slice(-MAX_THREAD_TURNS)) {
    if (turn.userText) lines.push(`User: ${truncate(turn.userText, MAX_LINE_LENGTH)}`);
    if (turn.assistantText) lines.push(`Assistant: ${truncate(turn.assistantText, MAX_LINE_LENGTH)}`);
  }
  return section("Current Thread", lines);
}

function recentWorkSection(state: AppState, chatStatuses: CodexChatRuntime[]): string {
  const projects = state.projects.slice(0, MAX_RECENT_PROJECTS);
  if (projects.length === 0) return section("Recent Work", ["No recent Codex Voice projects."]);
  const statusByChatId = new Map(chatStatuses.map((status) => [status.chatId, status]));
  const lines: string[] = [];
  for (const project of projects) {
    lines.push(`Project: ${project.displayName} (${project.id}) - updated ${project.updatedAt}`);
    if (project.lastSummary) lines.push(`  Summary: ${truncate(project.lastSummary, MAX_LINE_LENGTH)}`);
    for (const chat of visibleChats(project).slice(0, MAX_CHATS_PER_PROJECT)) {
      const status = statusByChatId.get(chat.id);
      lines.push(
        `  Chat: ${chat.displayName} (${chat.id}) - thread ${chat.codexThreadId ?? "none"} - ${status?.status ?? chat.lastStatus ?? "unknown"}`,
      );
    }
  }
  return section("Recent Work", lines);
}

function workspaceMapSection(entries: RealtimeWorkspaceEntry[]): string {
  if (entries.length === 0) return section("Workspace Map", ["No workspace snapshot available."]);
  return section(
    "Workspace Map",
    entries.slice(0, MAX_WORKSPACE_ENTRIES).map((entry) => `${entry.kind}: ${entry.path}`),
  );
}

function pluginsSection(inventory: RealtimeContextInventory | null | undefined): string {
  if (!inventory) return section("Available Plugins And Apps", ["Plugin/app inventory is unavailable."]);
  const lines: string[] = [];
  if (inventory.plugins.length === 0) {
    lines.push("No plugins reported by app-server.");
  } else {
    for (const plugin of inventory.plugins.slice(0, MAX_PLUGINS)) {
      lines.push(
        `${plugin.name} (${plugin.id}) - ${plugin.installed ? "installed" : "not installed"}, ${
          plugin.enabled ? "enabled" : "disabled"
        }${plugin.marketplace ? ` - ${plugin.marketplace}` : ""}`,
      );
    }
  }
  if (inventory.mcpServers.length === 0) {
    lines.push("No MCP servers reported by app-server.");
  } else {
    for (const server of inventory.mcpServers.slice(0, MAX_MCP_SERVERS)) {
      const tools = server.toolNames.slice(0, MAX_MCP_TOOLS);
      lines.push(
        `${server.name} - ${server.authStatus ?? "auth unknown"} - ${server.toolNames.length} tools${
          tools.length ? `: ${tools.join(", ")}` : ""
        }`,
      );
    }
  }
  if (inventory.apps.length === 0) {
    lines.push("No apps/connectors reported by app-server.");
  } else {
    for (const app of inventory.apps.slice(0, MAX_APPS)) {
      const plugins = app.pluginDisplayNames.length ? ` via ${app.pluginDisplayNames.join(", ")}` : "";
      lines.push(
        `${app.name} (${app.id}) - ${app.enabled ? "enabled" : "disabled"}, ${
          app.accessible ? "accessible" : "not accessible"
        }${plugins}`,
      );
    }
  }
  for (const error of inventory.errors) lines.push(`Inventory warning: ${truncate(error, MAX_LINE_LENGTH)}`);
  return section("Available Plugins And Apps", lines);
}

function subagentsSection(subagents: VoiceSubagentListResult | null | undefined): string {
  if (!subagents || subagents.subagents.length === 0) {
    return section("Visible Subagents", ["No visible child subagents for the active chat."]);
  }
  return section(
    "Visible Subagents",
    subagents.subagents.slice(0, MAX_SUBAGENTS).map((subagent) =>
      [
        `${subagent.title} (${subagent.id})`,
        `thread ${subagent.threadId}`,
        subagent.status ?? "status unknown",
        subagent.detail,
      ].join(" - "),
    ),
  );
}

function recentTranscriptSection(messages: VoiceTranscriptMessage[]): string {
  if (messages.length === 0) return section("Recent Voice Transcript", ["No voice transcript excerpts available."]);
  return section(
    "Recent Voice Transcript",
    messages.slice(-MAX_TRANSCRIPT_MESSAGES).map((message) =>
      `${message.source}/${message.role}: ${truncate(message.text, MAX_LINE_LENGTH)}`,
    ),
  );
}

function notesSection(): string {
  return section("Notes", [
    "This context is app-provided background for routing and conversation continuity, not a new user request.",
    "The Realtime model cannot inspect files, run tools, or use plugins directly unless a Realtime tool explicitly exposes that action.",
    "Plugin, app, and MCP availability is listed so Realtime can route requests to Codex or ask for clarification instead of inventing unavailable tools.",
  ]);
}

function section(title: string, rawLines: Array<string | null | undefined>): string {
  const lines = rawLines
    .filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    .map((line) => escapeXmlText(truncate(line, MAX_LINE_LENGTH)));
  return [`## ${title}`, ...(lines.length ? lines : ["None."]), ""].join("\n");
}

function activeProject(state: AppState): VoiceProject | null {
  if (state.activeProject) return state.activeProject;
  const activeProjectId = state.runtime.activeProjectId;
  return activeProjectId ? state.projects.find((project) => project.id === activeProjectId) ?? null : null;
}

function activeChat(project: VoiceProject, activeChatId: string | null): VoiceChat | null {
  const chats = visibleChats(project);
  return (
    (activeChatId ? chats.find((chat) => chat.id === activeChatId) ?? null : null) ??
    (project.activeChatId ? chats.find((chat) => chat.id === project.activeChatId) ?? null : null) ??
    chats[0] ??
    null
  );
}

function visibleChats(project: VoiceProject): VoiceChat[] {
  return project.chats.filter((chat) => !chat.archivedAt);
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
}

function trimBlankLines(value: string): string {
  return value.replace(/\n{3,}/g, "\n\n").trim();
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeXmlAttr(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;");
}
