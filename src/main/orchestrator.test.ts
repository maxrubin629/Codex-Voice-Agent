import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/codex-voice-test",
  },
}));

import {
  codexVoiceTurnText,
  mcpToolGrantFromRequest,
  normalizeThreadItemType,
  progressItemsFromThread,
  resolveVisibleSubagentTarget,
  threadTurnsHaveVoiceBridgePrompt,
  todoItemsFromPlanNotification,
  visibleSubagentsForChat,
  type CodexThreadItem,
  type CodexThreadTurn,
} from "./orchestrator";
import type { PendingCodexRequest, VoiceChat } from "../shared/types";

function countOccurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe("one-time voice prompt injection", () => {
  it("prepends the bridge prompt for a new thread", () => {
    const text = codexVoiceTurnText("open the app", false);

    expect(text).toContain("Codex (you) owns the actual planning");
    expect(text).toContain("Voice ===\nopen the app");
    expect(countOccurrences(text, "Voice ===\n")).toBe(1);
  });

  it("sends only the voice marker once the bridge prompt is persisted", () => {
    const text = codexVoiceTurnText("run the focused tests", true);

    expect(text).toBe("Voice ===\nrun the focused tests");
    expect(text).not.toContain("Codex (you) owns the actual planning");
  });

  it("detects a legacy-injected bridge prompt in previous turns", () => {
    const firstTurnText = codexVoiceTurnText("initial request", false);
    const turns: CodexThreadTurn[] = [
      {
        id: "turn-1",
        items: [{ type: "user_message", text: firstTurnText }],
      },
    ];

    expect(threadTurnsHaveVoiceBridgePrompt(turns)).toBe(true);
    expect(threadTurnsHaveVoiceBridgePrompt([{ id: "turn-2", items: [{ type: "user_message", text: "plain" }] }])).toBe(
      false,
    );
  });
});

describe("todo and plan parsing", () => {
  it("summarizes TodoListItem items with TodoItem completed booleans", () => {
    const todoList: CodexThreadItem = {
      type: "todo-list",
      id: "todo-1",
      items: [
        { text: "Add vitest", completed: true },
        { text: "Add focused tests", completed: false },
      ],
    };

    expect(progressItemsFromThread([], [todoList])).toEqual([
      {
        id: "todo-1",
        label: "To do list",
        detail: "1 of 2 tasks completed",
        status: "unknown",
        sourceType: "todo-list",
        raw: todoList,
      },
    ]);
  });

  it("parses the stable array-shaped turn/plan/updated payload", () => {
    const update = {
      threadId: "thread-1",
      turnId: "turn-1",
      explanation: "Focused verification",
      plan: [
        { step: "Add vitest", status: "completed" },
        { step: "Cover SIP state", status: "inProgress" },
        { step: "Report gaps", status: "pending" },
      ],
    } satisfies {
      threadId: string;
      turnId: string;
      explanation?: string;
      plan: Array<{ step: string; status: "pending" | "inProgress" | "completed" }>;
    };

    expect(todoItemsFromPlanNotification(update)).toMatchObject([
      { id: "todo-1", text: "Add vitest", status: "completed" },
      { id: "todo-2", text: "Cover SIP state", status: "in_progress" },
      { id: "todo-3", text: "Report gaps", status: "pending" },
    ]);
  });
});

describe("subagent item parsing", () => {
  it("normalizes exposed subagent item variants", () => {
    expect(normalizeThreadItemType("collabAgentToolCall")).toBe("sub-agent");
    expect(normalizeThreadItemType("multi_agent_action")).toBe("sub-agent");
    expect(normalizeThreadItemType("remote-task-created")).toBe("sub-agent");
    expect(normalizeThreadItemType("worked_for")).toBe("sub-agent");
  });

  it("selects subagent items for progress rendering", () => {
    const item: CodexThreadItem = {
      id: "agent-1",
      type: "collabAgentToolCall",
      status: "running",
      server: "subagents",
      tool: "worker-a",
    };

    expect(progressItemsFromThread([], [item])).toMatchObject([
      {
        id: "agent-1",
        label: "Sub-agent",
        detail: "subagents.worker-a",
        status: "in_progress",
        sourceType: "sub-agent",
      },
    ]);
  });

  it("derives visible child subagents from stored state and latest turn output", () => {
    const chat = chatWithSubagents({
      subagents: [
        {
          id: "stored-worker",
          displayName: "Stored worker",
          threadId: "thread-stored",
          status: "running",
        },
      ],
      lastTurnOutput: {
        threadId: "parent-thread",
        turnId: "turn-1",
        status: "completed",
        finalAssistantText: "Done",
        items: [
          {
            id: "item-stored",
            type: "collabAgentToolCall",
            newThreadId: "thread-stored",
            agentStatus: "completed",
            prompt: "stored worker finished",
          },
          {
            id: "item-tests",
            type: "remote-task-created",
            newThreadId: "thread-tests",
            agentName: "Tests worker",
            agentStatus: "running",
          },
        ],
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    });

    expect(visibleSubagentsForChat(chat)).toMatchObject([
      {
        id: "stored-worker",
        title: "Stored worker",
        threadId: "thread-stored",
        detail: "completed",
        status: "completed",
        source: "stored",
      },
      {
        id: "item-tests",
        title: "Tests worker",
        threadId: "thread-tests",
        detail: "running",
        status: "running",
        source: "turn-output",
      },
    ]);
  });

  it("resolves child subagents by semantic target without allowing invisible threads", () => {
    const subagents = visibleSubagentsForChat(chatWithSubagents({
      lastTurnOutput: {
        threadId: "parent-thread",
        turnId: "turn-1",
        status: "completed",
        finalAssistantText: "Done",
        items: [
          {
            id: "item-tests",
            type: "remote-task-created",
            newThreadId: "thread-tests",
            agentName: "Tests worker",
            agentStatus: "running",
          },
          {
            id: "item-ui",
            type: "remote-task-created",
            newThreadId: "thread-ui",
            agentName: "UI worker",
            agentStatus: "waiting",
          },
        ],
        startedAt: null,
        completedAt: null,
        durationMs: null,
      },
    }));

    expect(resolveVisibleSubagentTarget(subagents, "tests").threadId).toBe("thread-tests");
    expect(resolveVisibleSubagentTarget(subagents, "second").threadId).toBe("thread-ui");
    expect(() => resolveVisibleSubagentTarget(subagents, "thread-not-visible")).toThrow(
      /No visible child subagent matched/,
    );
    expect(() => resolveVisibleSubagentTarget(subagents)).toThrow(/More than one child subagent is visible/);
  });
});

function chatWithSubagents(patch: Partial<VoiceChat>): VoiceChat {
  return {
    id: "chat-1",
    displayName: "Main chat",
    codexThreadId: "parent-thread",
    voiceBridgePromptInjectedAt: null,
    model: "gpt-5.5",
    reasoningEffort: "medium",
    serviceTier: null,
    permissionMode: "default",
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    archivedAt: null,
    lastSummary: null,
    lastStatus: null,
    lastTurnOutput: null,
    ...patch,
  };
}

describe("MCP OK grant request parsing", () => {
  function request(method: string, params: Record<string, unknown>): PendingCodexRequest {
    return {
      kind: method === "item/tool/call" ? "tool" : "approval",
      requestId: "request-1",
      method,
      title: "request",
      body: "request",
      raw: { id: "request-1", method, params },
    };
  }

  it("extracts only global server/tool grants from MCP dynamic tool calls", () => {
    expect(
      mcpToolGrantFromRequest(
        request("item/tool/call", {
          namespace: "google-drive",
          tool: "search",
          arguments: { query: "roadmap" },
        }),
      ),
    ).toEqual({ server: "google-drive", tool: "search" });
  });

  it("does not extract grants for elicitations, auth, permissions, files, or commands", () => {
    const nonToolMethods = [
      "mcpServer/elicitation/request",
      "account/chatgptAuthTokens/refresh",
      "item/permissions/requestApproval",
      "item/fileChange/requestApproval",
      "item/commandExecution/requestApproval",
    ];

    for (const method of nonToolMethods) {
      expect(mcpToolGrantFromRequest(request(method, { namespace: "server", tool: "tool" }))).toBeNull();
    }
  });
});
