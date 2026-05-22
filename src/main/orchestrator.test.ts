import { EventEmitter } from "node:events";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/cva-test",
  },
}));

import {
  VoiceCodexOrchestrator,
  mcpToolGrantFromRequest,
  normalizeThreadItemType,
  progressItemsFromThread,
  resolveVisibleSubagentTarget,
  subagentsFromSessionLogText,
  todoItemsFromPlanNotification,
  visibleSubagentsForChat,
  type CodexThreadItem,
  type CodexThreadTurn,
} from "./orchestrator";
import { ProjectStore } from "./projectStore";
import type { PendingCodexRequest, VoiceChat } from "../shared/types";

type FakeCodexRequest = {
  method: string;
  params: any;
};

class FakeCodexBridge extends EventEmitter {
  requests: FakeCodexRequest[] = [];
  private nextTurnId = 1;

  async start(): Promise<void> {}
  stop(): void {}

  async request(method: string, params?: unknown): Promise<unknown> {
    this.requests.push({ method, params });
    if (method === "thread/resume" || method === "thread/name/set" || method === "thread/inject_items") {
      return {};
    }
    if (method === "turn/start") {
      return { turn: { id: `turn-${this.nextTurnId++}` } };
    }
    if (method === "thread/read") {
      return { thread: { turns: [] } };
    }
    if (method === "plugin/list") {
      return {
        marketplaces: [
          {
            name: "OpenAI",
            plugins: [{ id: "browser", name: "Browser", installed: true, enabled: true }],
          },
        ],
      };
    }
    if (method === "mcpServerStatus/list") {
      return {
        data: [
          {
            name: "github",
            authStatus: "connected",
            tools: { search_repositories: {}, get_issue: {} },
          },
        ],
      };
    }
    if (method === "app/list") {
      return {
        data: [
          {
            id: "google-drive",
            name: "Google Drive",
            isEnabled: true,
            isAccessible: true,
            pluginDisplayNames: ["Google Drive"],
          },
        ],
      };
    }
    throw new Error(`Unexpected fake Codex request: ${method}`);
  }
}

async function testOrchestrator(): Promise<{
  orchestrator: VoiceCodexOrchestrator;
  codex: FakeCodexBridge;
  chatId: string;
}> {
  const baseFolder = await mkdtemp(path.join(os.tmpdir(), "cva-orchestrator-"));
  const store = new ProjectStore(baseFolder);
  await store.ensureReady();
  const codex = new FakeCodexBridge();
  const orchestrator = new VoiceCodexOrchestrator(store, codex as unknown as any);
  const project = await orchestrator.createProject("Realtime XML", baseFolder);
  const withChat = await store.addChat(project.id, "Main", "thread-1");
  return { orchestrator, codex, chatId: withChat.activeChatId! };
}

describe("realtime delegation orchestration", () => {
  it("leaves typed UI turns as ordinary Codex user input", async () => {
    const { orchestrator, codex, chatId } = await testOrchestrator();

    await orchestrator.sendToCodex("plain typed request", chatId);

    const turnStart = codex.requests.find((request) => request.method === "turn/start");
    expect(turnStart?.params.input[0].text).toBe("plain typed request");
  });

  it("wraps realtime-originated turns and injects start context once per realtime session thread", async () => {
    const { orchestrator, codex, chatId } = await testOrchestrator();
    await orchestrator.realtimeSessionStarted();

    await orchestrator.sendToCodex("open the app", chatId, null, {
      source: "realtime",
      transcriptDelta: "user: open the app",
    });
    await orchestrator.sendToCodex("run tests", chatId, null, {
      source: "realtime",
    });

    const turnStarts = codex.requests.filter((request) => request.method === "turn/start");
    expect(turnStarts).toHaveLength(2);

    const firstText = turnStarts[0].params.input[0].text;
    expect(firstText).toContain("<realtime_delegation>");
    expect(firstText).toContain("<realtime_conversation>");
    expect(firstText).toContain("Realtime conversation started.");
    expect(firstText).toContain("<input>open the app</input>");
    expect(firstText).toContain("<transcript_delta>user: open the app</transcript_delta>");
    expect(firstText).not.toContain("Voice ===");

    const secondText = turnStarts[1].params.input[0].text;
    expect(secondText).toContain("<realtime_delegation>");
    expect(secondText).not.toContain("<realtime_conversation>");
    expect(secondText).toContain("<input>run tests</input>");
    expect(secondText).not.toContain("Voice ===");
  });

  it("passes queued realtime context through the delegation transcript delta when idle", async () => {
    const { orchestrator, codex, chatId } = await testOrchestrator();
    await orchestrator.realtimeSessionStarted();

    await orchestrator.queueCodexRequest("run focused tests", chatId, null, {
      source: "realtime",
      transcriptDelta: "user: run focused tests",
    });

    const turnStart = codex.requests.find((request) => request.method === "turn/start");
    const text = turnStart?.params.input[0].text;
    expect(text).toContain("<input>run focused tests</input>");
    expect(text).toContain("<transcript_delta>user: run focused tests</transcript_delta>");
  });

  it("injects realtime-ended context as a normal user history item", async () => {
    const { orchestrator, codex, chatId } = await testOrchestrator();
    await orchestrator.realtimeSessionStarted();
    await orchestrator.sendToCodex("open the app", chatId, null, { source: "realtime" });

    await orchestrator.realtimeSessionEnded();

    const injections = codex.requests.filter((request) => request.method === "thread/inject_items");
    expect(injections).toHaveLength(1);
    expect(injections[0].params.threadId).toBe("thread-1");
    expect(injections[0].params.items[0]).toMatchObject({
      type: "message",
      role: "user",
      content: [{ type: "input_text" }],
    });
    const text = injections[0].params.items[0].content[0].text;
    expect(text).toContain("<realtime_conversation>");
    expect(text).toContain("Realtime conversation ended.");
    expect(text).toContain("<input>Realtime conversation ended.</input>");
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

  it("extracts spawned child agents from local session log records", () => {
    const log = [
      {
        timestamp: "2026-05-14T05:49:10.448Z",
        type: "response_item",
        payload: {
          type: "function_call",
          name: "spawn_agent",
          call_id: "call_spawn",
          arguments: JSON.stringify({
            message: "Role: Data Center Research. Gather sources.",
          }),
        },
      },
      {
        timestamp: "2026-05-14T05:49:10.999Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_spawn",
          output: JSON.stringify({
            agent_id: "019e2508-3630-7043-bf28-90c73040f168",
            nickname: "Leibniz",
          }),
        },
      },
      {
        timestamp: "2026-05-14T05:51:10.999Z",
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call_wait",
          output: JSON.stringify({
            status: {
              "019e2508-3630-7043-bf28-90c73040f168": {
                completed: "Done",
              },
            },
          }),
        },
      },
    ].map((entry) => JSON.stringify(entry)).join("\n");

    expect(subagentsFromSessionLogText("parent-thread", log)).toMatchObject([
      {
        id: "019e2508-3630-7043-bf28-90c73040f168",
        displayName: "Leibniz",
        threadId: "019e2508-3630-7043-bf28-90c73040f168",
        status: "completed",
      },
    ]);
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
