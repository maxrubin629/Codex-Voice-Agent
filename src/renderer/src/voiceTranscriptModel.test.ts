import { describe, expect, it } from "vitest";
import type {
  ActiveThreadSummary,
  AppEvent,
  AppState,
  ThreadSummaryItem,
  VoiceTranscriptMessage,
} from "../../shared/types";
import { buildVoiceTranscriptEntries, isPinnedToTranscriptBottom, type TranscriptEntry } from "./voiceTranscript";

const baseTime = "2026-05-08T12:00:00.000Z";

describe("buildVoiceTranscriptEntries", () => {
  it("renders every known Codex thread item type with visible, intentional text", () => {
    const entries = buildVoiceTranscriptEntries({
      events: [],
      state: appState(),
      summary: threadSummary([
        item("userMessage", "user-1", {
          content: [{ type: "input_text", text: "Please inspect the transcript surface." }],
        }),
        item("hookPrompt", "hook-1", {
          fragments: [{ text: "Repository hook added AGENTS.md guidance.", hookRunId: "hook-run-1" }],
        }),
        item("reasoning", "reasoning-1", {
          status: "completed",
          summary: ["Checked the Codex history vocabulary."],
        }),
        item("commandExecution", "command-1", {
          status: "completed",
          command: "rg transcript src",
          commandActions: [{ type: "search", query: "transcript", path: "src/renderer/src" }],
          durationMs: 1400,
        }),
        item("fileChange", "file-1", {
          status: "completed",
          changes: [
            {
              path: "src/renderer/src/voiceTranscript.tsx",
              kind: { type: "update" },
              diff: "+added\n-removed\n",
            },
          ],
        }),
        item("mcpToolCall", "mcp-1", {
          status: "completed",
          server: "github",
          tool: "list_pull_requests",
          arguments: { name: "codex-voice" },
        }),
        item("dynamicToolCall", "dynamic-1", {
          status: "completed",
          namespace: "browser",
          tool: "open_page",
          arguments: { url: "http://localhost:3000" },
        }),
        item("collabAgentToolCall", "agent-1", {
          status: "completed",
          tool: "spawn_agent",
          model: "gpt-5.4-mini",
        }),
        item("webSearch", "web-1", {
          status: "completed",
          query: "Codex app transcript history",
        }),
        item("todoList", "todo-1", {
          status: "completed",
          items: [
            { title: "Add fixtures", status: "completed" },
            { title: "Polish collapse", status: "pending" },
          ],
        }),
        item("plan", "plan-1", {
          status: "completed",
          text: "Plan updated with transcript parity steps.",
        }),
        item("imageView", "image-view-1", {
          status: "completed",
          path: "/tmp/codex-voice-screenshot.png",
        }),
        item("imageGeneration", "image-generation-1", {
          status: "completed",
          savedPath: "/tmp/generated-transcript.png",
          revisedPrompt: "A polished transcript surface",
        }),
        item("enteredReviewMode", "review-start-1", {
          status: "completed",
          review: "transcript parity",
        }),
        item("exitedReviewMode", "review-end-1", {
          status: "completed",
          review: "transcript parity",
        }),
        item("contextCompaction", "compact-1", {
          status: "completed",
          summary: "Previous context was compacted.",
        }),
        item("futureToolThing", "unknown-1", {
          status: "completed",
          text: "Future tool did useful work.",
        }),
      ]),
    });

    const visibleText = transcriptText(entries);

    expect(visibleText).toContain("Please inspect the transcript surface.");
    expect(visibleText).toContain("hook");
    expect(visibleText).toContain("Repository hook added AGENTS.md guidance.");
    expect(visibleText).toContain("Checked the Codex history vocabulary.");
    expect(visibleText).toContain("Searched for transcript");
    expect(visibleText).toContain("voiceTranscript.tsx");
    expect(visibleText).toContain("Used Github List pull requests");
    expect(visibleText).toContain("Used Browser Open page");
    expect(visibleText).toContain("Coordinated Spawn agent");
    expect(visibleText).toContain("Searched web for Codex app transcript history");
    expect(visibleText).toContain("Add fixtures");
    expect(visibleText).toContain("Plan updated with transcript parity steps.");
    expect(visibleText).toContain("codex-voice-screenshot.png");
    expect(visibleText).toContain("generated-transcript.png");
    expect(visibleText).toContain("Review mode started");
    expect(visibleText).toContain("Review mode finished");
    expect(visibleText).toContain("transcript parity");
    expect(visibleText).toContain("Compacted context");
    expect(visibleText).toContain("Future tool thing");
    expect(visibleText).toContain("Future tool did useful work.");
    expect(visibleText).toContain("Transcript parity is now visible.");
  });

  it("defaults completed reasoning collapsed and active reasoning expanded", () => {
    const completedEntries = buildVoiceTranscriptEntries({
      events: [],
      state: appState(),
      summary: threadSummary([
        item("reasoning", "reasoning-complete", {
          status: "completed",
          summary: ["Completed reasoning."],
        }),
      ]),
    });
    const activeEntries = buildVoiceTranscriptEntries({
      events: [],
      state: appState(),
      summary: {
        ...threadSummary([
          item("reasoning", "reasoning-active", {
            status: "in_progress",
            summary: ["Active reasoning."],
          }),
        ]),
        latestTurnStatus: "in_progress",
        turns: [
          {
            ...threadSummary([
              item("reasoning", "reasoning-active", {
                status: "in_progress",
                summary: ["Active reasoning."],
              }),
            ]).turns[0],
            status: "in_progress",
          },
        ],
      },
    });

    expect(flattenEntries(completedEntries).find((entry) => entry.kind === "reasoning")).toMatchObject({
      active: false,
      defaultExpanded: false,
    });
    expect(flattenEntries(activeEntries).find((entry) => entry.kind === "reasoning")).toMatchObject({
      active: true,
      defaultExpanded: true,
    });
  });

  it("deduplicates stored Realtime transcript messages against live completed events", () => {
    const liveEvent: AppEvent = {
      at: baseTime,
      source: "realtime",
      kind: "userTranscript",
      message: "userTranscript",
      raw: {
        chatId: "chat-1",
        threadId: "thread-1",
        item_id: "audio-item-1",
        transcript: "Hello from the microphone.",
      },
    };
    const messages: VoiceTranscriptMessage[] = [
      {
        id: "realtime:chat-1:user:audio-item-1",
        chatId: "chat-1",
        threadId: "thread-1",
        source: "realtime",
        role: "user",
        text: "Hello from the microphone.",
        createdAt: baseTime,
        completedAt: baseTime,
        status: "completed",
        itemId: "audio-item-1",
      },
    ];

    const entries = buildVoiceTranscriptEntries({
      events: [liveEvent],
      state: appState(),
      summary: null,
      messages,
    });

    const matches = flattenEntries(entries).filter(
      (entry) => entry.kind === "message" && entry.body === "Hello from the microphone.",
    );
    expect(matches).toHaveLength(1);
  });

  it("treats near-bottom scroll positions as pinned but preserves intentional scrollback", () => {
    expect(isPinnedToTranscriptBottom({ scrollHeight: 1200, scrollTop: 720, clientHeight: 400 })).toBe(true);
    expect(isPinnedToTranscriptBottom({ scrollHeight: 1200, scrollTop: 710, clientHeight: 400 })).toBe(false);
  });
});

function item(type: string, id: string, raw: Record<string, unknown>): ThreadSummaryItem {
  return {
    id,
    type,
    status: typeof raw.status === "string" ? raw.status : "completed",
    label: type,
    detail: null,
    raw: { id, type, ...raw },
  };
}

function threadSummary(items: ThreadSummaryItem[]): ActiveThreadSummary {
  return {
    status: "ready",
    projectId: "project-1",
    projectName: "Codex Voice",
    workspacePath: "/Users/juno/workspace/codex-voice",
    chatId: "chat-1",
    chatName: "Transcript parity",
    threadId: "thread-1",
    turnCount: 1,
    latestTurnStatus: "completed",
    latestAssistantText: "Transcript parity is now visible.",
    progress: [],
    artifacts: [],
    sources: [],
    referencedFiles: [],
    rawUnknownItems: [],
    turns: [
      {
        id: "turn-1",
        status: "completed",
        startedAt: Date.parse(baseTime),
        completedAt: Date.parse(baseTime) + 2000,
        durationMs: 2000,
        userText: null,
        assistantText: "Transcript parity is now visible.",
        itemCount: items.length,
        items,
      },
    ],
  };
}

function appState(): AppState {
  return {
    baseFolder: "/Users/juno/Documents/Codex Voice Projects",
    projects: [],
    archivedProjects: [],
    activeProject: null,
    runtime: {
      ready: true,
      activeProjectId: "project-1",
      activeChatId: "chat-1",
      activeTurnId: null,
      status: "ready",
      threadStatus: null,
      tokenUsage: null,
      pendingRequests: [],
      chats: [],
      projectThreads: [],
      showProjectChats: false,
    },
    codexSettings: {
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
      defaultModel: null,
      defaultReasoningEffort: null,
      defaultServiceTier: null,
      defaultPermissionMode: "default",
      models: [],
    },
    realtime: {
      available: true,
      model: "gpt-realtime-2",
      voice: "marin",
      reasoningEffort: "low",
      reason: null,
      apiKeySource: "saved",
      apiKeyEncrypted: true,
    },
    webSearch: {
      available: false,
      provider: "exa",
      reason: null,
      apiKeySource: null,
      apiKeyEncrypted: false,
    },
  };
}

function transcriptText(entries: TranscriptEntry[]): string {
  return flattenEntries(entries)
    .flatMap((entry) => {
      if (entry.kind === "message") return [entry.body];
      if (entry.kind === "work") return [entry.summary];
      if (entry.kind === "activity") {
        return [entry.summary, ...entry.rows.flatMap((row) => [row.label, row.meta ?? ""])];
      }
      if (entry.kind === "reasoning") return [entry.content];
      return [entry.title, entry.body ?? "", ...(entry.rows ?? []).flatMap((row) => [row.label, row.meta ?? ""])];
    })
    .join("\n");
}

function flattenEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  return entries.flatMap((entry): TranscriptEntry[] =>
    entry.kind === "work" ? [entry, ...flattenEntries(entry.children)] : [entry],
  );
}
