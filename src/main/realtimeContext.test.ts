import { describe, expect, it } from "vitest";

import type {
  ActiveThreadSummary,
  AppState,
  CodexChatRuntime,
  RealtimeContextInventory,
  VoiceSubagentListResult,
  VoiceTranscriptMessage,
} from "../shared/types";
import { buildRealtimeContextResult } from "./realtimeContext";

describe("realtime context", () => {
  it("builds official-like startup context with active work, plugins, workspace, and notes", () => {
    const result = buildRealtimeContextResult({
      scope: "startup",
      generatedAt: "2026-05-22T12:00:00.000Z",
      state: appState(),
      activeThreadSummary: activeSummary(),
      chatStatuses: chatStatuses(),
      subagents: subagents(),
      transcriptMessages: transcriptMessages(),
      inventory: pluginInventory(),
      workspaceEntries: [
        { path: "package.json", kind: "file" },
        { path: "src", kind: "directory" },
      ],
    });

    expect(result.ok).toBe(true);
    expect(result.scope).toBe("startup");
    expect(result.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(result.text).toContain("<startup_context>");
    expect(result.text).toContain("Startup context from Codex Voice Agent.");
    expect(result.text).toContain("Current Focus");
    expect(result.text).toContain("Project: Codex Voice Agent");
    expect(result.text).toContain("Current Thread");
    expect(result.text).toContain("User: make realtime context richer");
    expect(result.text).toContain("Recent Work");
    expect(result.text).toContain("Workspace Map");
    expect(result.text).toContain("Available Plugins And Apps");
    expect(result.text).toContain("Browser (browser) - installed, enabled - OpenAI");
    expect(result.text).toContain("github - connected - 2 tools");
    expect(result.text).toContain("Google Drive (google-drive) - enabled, accessible via Google Drive");
    expect(result.text).toContain("Visible Subagents");
    expect(result.text).toContain("Recent Voice Transcript");
    expect(result.text).toContain("Notes");
    expect(result.text).toContain("</startup_context>");
  });

  it("builds plugin-only context without unrelated sections", () => {
    const result = buildRealtimeContextResult({
      scope: "plugins",
      generatedAt: "2026-05-22T12:00:00.000Z",
      state: appState(),
      inventory: pluginInventory(),
    });

    expect(result.text).toContain("<realtime_context scope=\"plugins\">");
    expect(result.text).toContain("Available Plugins And Apps");
    expect(result.text).not.toContain("Current Thread");
    expect(result.text).not.toContain("Workspace Map");
  });

  it("returns useful context when no project is active", () => {
    const result = buildRealtimeContextResult({
      scope: "startup",
      generatedAt: "2026-05-22T12:00:00.000Z",
      state: {
        ...appState(),
        activeProject: null,
        runtime: {
          ...appState().runtime,
          activeProjectId: null,
          activeChatId: null,
          chats: [],
        },
      },
      inventory: { plugins: [], mcpServers: [], apps: [], errors: [] },
    });

    expect(result.ok).toBe(true);
    expect(result.text).toContain("No active project.");
    expect(result.text).toContain("No plugins reported by app-server.");
  });
});

function appState(): AppState {
  return {
    baseFolder: "/tmp/cva",
    projects: [
      {
        id: "project-1",
        displayName: "Codex Voice Agent",
        folderPath: "/repo",
        workspacePath: "/repo",
        activeChatId: "chat-1",
        codexThreadId: "thread-1",
        model: "gpt-5",
        reasoningEffort: "high",
        serviceTier: null,
        permissionMode: "default",
        createdAt: "2026-05-22T10:00:00.000Z",
        updatedAt: "2026-05-22T11:00:00.000Z",
        archivedAt: null,
        lastSummary: "Realtime handoff work",
        lastStatus: "Ready",
        chats: [
          {
            id: "chat-1",
            displayName: "Main",
            codexThreadId: "thread-1",
            voiceBridgePromptInjectedAt: null,
            model: "gpt-5",
            reasoningEffort: "high",
            serviceTier: null,
            permissionMode: "default",
            createdAt: "2026-05-22T10:00:00.000Z",
            updatedAt: "2026-05-22T11:00:00.000Z",
            archivedAt: null,
            lastSummary: "Context planning",
            lastStatus: "Ready",
            lastTurnOutput: null,
          },
        ],
      },
    ],
    archivedProjects: [],
    activeProject: null,
    runtime: {
      ready: true,
      activeProjectId: "project-1",
      activeChatId: "chat-1",
      activeTurnId: null,
      status: "Ready.",
      threadStatus: "ready",
      tokenUsage: null,
      pendingRequests: [],
      showProjectChats: false,
      chats: [],
    },
    codexSettings: {
      defaultModel: "gpt-5",
      defaultReasoningEffort: "high",
      defaultServiceTier: null,
      defaultPermissionMode: "default",
      chatModel: null,
      chatReasoningEffort: null,
      chatServiceTier: null,
      chatPermissionMode: "default",
      nextTurnModel: null,
      nextTurnReasoningEffort: null,
      nextTurnServiceTier: null,
      nextTurnPermissionMode: null,
      activeTurnModel: null,
      activeTurnReasoningEffort: null,
      activeTurnServiceTier: null,
      activeTurnPermissionMode: null,
      models: [],
    },
    mcpOkGrants: [],
    realtime: {
      available: true,
      model: "gpt-realtime-2",
      voice: "verse",
      reasoningEffort: "low",
      reason: null,
      apiKeySource: "saved",
      apiKeyEncrypted: true,
    },
    phone: {
      settings: {
        enabled: false,
        webhookPath: "/phone",
        localPort: 0,
        publicUrl: null,
        allowUnsignedDevWebhooks: false,
        webhookSecretConfigured: false,
        allowedCallerNumbers: [],
      },
      listener: { running: false, url: null, error: null },
      activeCall: null,
      logs: [],
    },
    replay: { active: null },
  };
}

function activeSummary(): ActiveThreadSummary {
  return {
    status: "ready",
    projectId: "project-1",
    projectName: "Codex Voice Agent",
    workspacePath: "/repo",
    chatId: "chat-1",
    chatName: "Main",
    threadId: "thread-1",
    turnCount: 2,
    latestTurnStatus: "completed",
    latestAssistantText: "I added the delegation wrapper.",
    progress: [{ id: "todo-1", label: "Plan", detail: "1 of 2 tasks completed", status: "in_progress", sourceType: "todo-list", raw: {} }],
    artifacts: [{ id: "artifact-1", kind: "file", title: "realtimeDelegation.ts", subtitle: "main", path: "src/main/realtimeDelegation.ts", sourceType: "file", raw: {} }],
    sources: [],
    referencedFiles: [],
    rawUnknownItems: [],
    turns: [
      {
        id: "turn-1",
        status: "completed",
        startedAt: null,
        completedAt: null,
        durationMs: null,
        userText: "make realtime context richer",
        assistantText: "I added the delegation wrapper.",
        itemCount: 2,
        items: [],
      },
    ],
  };
}

function chatStatuses(): CodexChatRuntime[] {
  return [
    {
      chatId: "chat-1",
      threadId: "thread-1",
      displayName: "Main",
      todos: [{ id: "todo-1", text: "Implement context", status: "in_progress", raw: {} }],
      activeTurnId: null,
      status: "Ready",
      threadStatus: "ready",
      tokenUsage: null,
      pendingRequests: [],
      activeTurnModel: "gpt-5",
      activeTurnReasoningEffort: "high",
      activeTurnServiceTier: null,
    },
  ];
}

function subagents(): VoiceSubagentListResult {
  return {
    chatId: "chat-1",
    chatName: "Main",
    subagents: [
      {
        id: "subagent-1",
        parentChatId: "chat-1",
        parentChatName: "Main",
        title: "Tests worker",
        threadId: "thread-sub",
        detail: "checking tests",
        status: "running",
        activeTurnId: "turn-sub",
        threadStatus: "running",
        source: "stored",
      },
    ],
  };
}

function transcriptMessages(): VoiceTranscriptMessage[] {
  return [
    {
      id: "voice-1",
      chatId: "chat-1",
      threadId: "thread-1",
      source: "realtime",
      role: "user",
      text: "also tell realtime what plugins are available",
      createdAt: "2026-05-22T11:00:00.000Z",
      completedAt: "2026-05-22T11:00:01.000Z",
      status: "completed",
    },
  ];
}

function pluginInventory(): RealtimeContextInventory {
  return {
    plugins: [
      {
        id: "browser",
        name: "Browser",
        marketplace: "OpenAI",
        installed: true,
        enabled: true,
      },
    ],
    mcpServers: [
      {
        name: "github",
        authStatus: "connected",
        toolNames: ["search_repositories", "get_issue"],
      },
    ],
    apps: [
      {
        id: "google-drive",
        name: "Google Drive",
        enabled: true,
        accessible: true,
        pluginDisplayNames: ["Google Drive"],
      },
    ],
    errors: [],
  };
}
