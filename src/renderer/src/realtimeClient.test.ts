import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AppEvent, CodexTurnOutput, PendingCodexRequest } from "../../shared/types";
import { RealtimeVoiceClient } from "./realtimeClient";

type SentPayload = Record<string, any>;

function connectedClient(): { client: RealtimeVoiceClient; sent: SentPayload[]; logs: AppEvent[] } {
  const sent: SentPayload[] = [];
  const logs: AppEvent[] = [];
  const client = new RealtimeVoiceClient({
    onLog: (event) => logs.push(event),
    onConnectionChange: vi.fn(),
  });
  (client as unknown as { dc: { readyState: string; send: (payload: string) => void } }).dc = {
    readyState: "open",
    send: (payload: string) => sent.push(JSON.parse(payload)),
  };
  return { client, sent, logs };
}

function payloadTypes(sent: SentPayload[]): string[] {
  return sent.map((payload) => String(payload.type));
}

function installCodexVoiceMock(overrides: Record<string, unknown> = {}): void {
  const existingWindow = (globalThis as unknown as { window?: Record<string, unknown> }).window ?? {};
  Object.assign(globalThis, {
    window: {
      ...existingWindow,
      codexVoice: {
        sendToCodex: vi.fn(async () => ({
          ok: true,
          message: "Sent to Codex.",
          turnId: "turn-1",
          project: null,
          chat: null,
        })),
        getState: vi.fn(async () => ({
          activeProject: null,
          runtime: {},
          codexSettings: {},
        })),
        ...overrides,
      },
    },
  });
}

async function runToolCall(
  client: RealtimeVoiceClient,
  name: string,
  args: Record<string, unknown> = {},
): Promise<void> {
  await (client as unknown as {
    handleFunctionCalls(record: unknown): Promise<void>;
  }).handleFunctionCalls({
    responseId: "response-1",
    epoch: (client as unknown as { realtimeEpoch: number }).realtimeEpoch,
    calls: new Map([
      [
        "item-1",
        {
          callId: "call-1",
          itemId: "item-1",
          name,
          arguments: JSON.stringify(args),
          running: false,
          outputSent: false,
          stale: false,
        },
      ],
    ]),
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("RealtimeVoiceClient completion speech policy", () => {
  it("adds Codex turn completion as context without forcing speech", () => {
    const { client, sent } = connectedClient();

    client.notifyCodexTurnCompleted({
      at: "2026-05-22T00:00:00.000Z",
      source: "codex",
      kind: "turn/completed",
      message: "Codex finished.",
      raw: {
        threadId: "thread-1",
        turn: { id: "turn-1", status: "completed" },
      },
    });

    expect(payloadTypes(sent)).toEqual(["conversation.item.create"]);
    expect(sent[0].item.content[0].text).toContain("Codex turn completed.");
  });

  it("adds final Codex output as context without a completion nudge", () => {
    const { client, sent } = connectedClient();
    const output: CodexTurnOutput = {
      threadId: "thread-1",
      turnId: "turn-1",
      status: "completed",
      finalAssistantText: "Tests passed and the patch is ready.",
      startedAt: null,
      completedAt: null,
      durationMs: null,
    };

    client.injectCodexTurnOutput(output);

    expect(payloadTypes(sent)).toEqual(["conversation.item.create"]);
    const contextText = String(sent[0].item.content[0].text);
    expect(contextText).toContain("When speaking about this output, summarize it in first person");
    expect(contextText).toContain("Do not attribute ordinary summaries to Codex, the backend, a tool, or an unnamed it");
    expect(contextText).not.toContain("The previous Codex turn produced this exact final assistant output.");
    expect(JSON.stringify(sent)).not.toContain("Hey, just wanted to let you know");
    expect(JSON.stringify(sent)).not.toContain("Give the user a short natural completion nudge");
  });

  it("adds queued Codex transitions as context without forcing speech", () => {
    const { client, sent } = connectedClient();

    client.speakQueuedCodexTransition({ text: "run the next test file" });

    expect(payloadTypes(sent)).toEqual(["conversation.item.create"]);
    expect(sent[0].item.content[0].text).toContain("automatically started a queued follow-up");
  });

  it("still forces speech for pending approvals and questions", () => {
    const { client, sent } = connectedClient();
    const request: PendingCodexRequest = {
      kind: "approval",
      requestId: "request-1",
      method: "item/commandExecution/requestApproval",
      title: "Codex wants approval",
      body: "Run npm test",
      raw: {},
    };

    client.speakPendingRequest(request);

    expect(payloadTypes(sent)).toEqual(["response.create"]);
    expect(sent[0].response.instructions).toContain("Codex is waiting for user approval.");
  });

  it("does not force speech after submitting work to Codex", async () => {
    installCodexVoiceMock();
    const { client, sent } = connectedClient();

    await runToolCall(client, "submit_to_codex", { request: "run the tests" });

    expect(payloadTypes(sent)).toEqual(["conversation.item.create"]);
    expect(sent[0].item.type).toBe("function_call_output");
    expect(JSON.stringify(sent)).not.toContain("response.create");
    expect(JSON.stringify(sent)).toContain("Work started.");
    expect(JSON.stringify(sent)).not.toContain("Sent to Codex.");
  });

  it("still creates a response after informational tool output", async () => {
    installCodexVoiceMock();
    const { client, sent } = connectedClient();

    await runToolCall(client, "get_codex_status");

    expect(payloadTypes(sent)).toEqual(["conversation.item.create", "response.create"]);
  });

  it("does not force speech after remain_silent", async () => {
    installCodexVoiceMock();
    const { client, sent } = connectedClient();

    await runToolCall(client, "remain_silent", { reason: "status already visible" });

    expect(payloadTypes(sent)).toEqual(["conversation.item.create"]);
    expect(sent[0].item.type).toBe("function_call_output");
    expect(JSON.parse(sent[0].item.output)).toMatchObject({ silent: true });
    expect(JSON.stringify(sent)).not.toContain("response.create");
  });

  it("lets realtime pull Codex context, including plugin scope", async () => {
    const getRealtimeContext = vi.fn(async () => ({
      ok: true,
      scope: "plugins",
      text: "<realtime_context scope=\"plugins\">Available Plugins And Apps</realtime_context>",
      fingerprint: "fingerprint-plugins",
      generatedAt: "2026-05-22T12:00:00.000Z",
    }));
    installCodexVoiceMock({ getRealtimeContext });
    const { client, sent } = connectedClient();

    await runToolCall(client, "get_codex_context", { scope: "plugins" });

    expect(getRealtimeContext).toHaveBeenCalledWith({ scope: "plugins" });
    expect(payloadTypes(sent)).toEqual(["conversation.item.create", "response.create"]);
    expect(JSON.stringify(sent)).toContain("Available Plugins And Apps");
  });
});
