import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/cva-test",
  },
}));

vi.mock("./apiKeyStore", () => ({
  getOpenAiApiKey: () => "sk-test",
  getOpenAiApiKeyStatus: () => ({
    configured: true,
    source: "saved",
    encrypted: true,
  }),
}));

import { createRealtimeClientSecret, realtimeTools } from "./realtime";

describe("realtime session setup", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("adds startup context to realtime instructions and reports metadata", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      json: async () => ({
        client_secret: {
          value: "secret-value",
          expires_at: 123,
        },
      }),
      text: async () => "",
      init,
    }));
    vi.stubGlobal("fetch", fetchMock);

    const secret = await createRealtimeClientSecret({
      text: "<startup_context>\nAvailable Plugins And Apps\n</startup_context>",
      fingerprint: "fingerprint-1",
    });

    expect(secret.startupContextIncluded).toBe(true);
    expect(secret.startupContextFingerprint).toBe("fingerprint-1");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.session.instructions).toContain("# Role");
    expect(body.session.instructions).toContain("<startup_context>");
    expect(body.session.instructions).toContain("Available Plugins And Apps");
  });

  it("instructs realtime to speak as the first-person user-facing assistant by default", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      json: async () => ({
        client_secret: {
          value: "secret-value",
        },
      }),
      text: async () => "",
      init,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createRealtimeClientSecret();

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const instructions = String(body.session.instructions);
    expect(instructions).toContain("Speak as the assistant handling the user's work in first person by default.");
    expect(instructions).toContain("Do not narrate backend delegation");
    expect(instructions).toContain("If the user asks how this works");
    expect(instructions).toContain("routes execution to the active Codex chat/thread");
    expect(instructions).toContain("Do not treat examples as required scripts");
    expect(instructions).not.toContain("For handoffs, say only that you are sending it to Codex or updating Codex.");
  });

  it("does not let architecture explanations override first-person phrasing", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      json: async () => ({
        client_secret: {
          value: "secret-value",
        },
      }),
      text: async () => "",
      init,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createRealtimeClientSecret();

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const instructions = String(body.session.instructions);
    expect(instructions).toContain("Do not use the internal Codex/tool architecture as a reason to avoid first-person phrasing.");
    expect(instructions).toContain("If the user challenges a Codex/backend mention");
    expect(instructions).toContain("correct the phrasing back to first person");
    expect(instructions).not.toContain("You do NOT do computer tasks yourself.");
    expect(instructions).not.toContain("Codex is the one actually doing the computer-side");
    expect(instructions).not.toContain("voice assistant and intermediary");
  });

  it("frames ordinary result relays in first person without changing approvals", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      json: async () => ({
        client_secret: {
          value: "secret-value",
        },
      }),
      text: async () => "",
      init,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createRealtimeClientSecret();

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const instructions = String(body.session.instructions);
    expect(instructions).toContain("present them as what you found, learned, or did in first person");
    expect(instructions).toContain("Do not attribute ordinary result summaries to Codex, the backend, a tool, an unnamed it, or the result itself");
    expect(instructions).toContain("Approval and permission prompts are the exception");
    expect(instructions).toContain("Do not treat result-relay examples as required scripts");
    expect(instructions).not.toContain("here's what it says");
    expect(instructions).not.toContain("here is what it says");
  });

  it("keeps routing tool descriptions internal instead of encouraging delegation narration", () => {
    const tools = realtimeTools() as Array<{ name?: string; description?: string }>;
    const submit = tools.find((tool) => tool.name === "submit_to_codex");
    const steer = tools.find((tool) => tool.name === "steer_codex");
    const queue = tools.find((tool) => tool.name === "queue_codex_request");

    expect(submit?.description).toContain("Internal routing tool");
    expect(steer?.description).toContain("Internal routing tool");
    expect(queue?.description).toContain("Internal routing tool");
    expect([submit, steer, queue].map((tool) => tool?.description).join("\n")).not.toContain("actual computer-use agent");
  });

  it("exposes a realtime context pull tool", () => {
    const contextTool = realtimeTools().find(
      (tool) => (tool as { name?: string }).name === "get_codex_context",
    ) as { parameters?: { properties?: Record<string, unknown> } } | undefined;

    expect(contextTool).toBeDefined();
    expect(contextTool?.parameters?.properties?.scope).toBeDefined();
    expect(JSON.stringify(contextTool)).toContain("plugins");
  });

  it("exposes a quiet tool for non-distracting moments", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => ({
      ok: true,
      json: async () => ({
        client_secret: {
          value: "secret-value",
        },
      }),
      text: async () => "",
      init,
    }));
    vi.stubGlobal("fetch", fetchMock);

    await createRealtimeClientSecret();

    const quietTool = realtimeTools().find(
      (tool) => (tool as { name?: string }).name === "remain_silent",
    ) as { description?: string } | undefined;
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    const instructions = String(body.session.instructions);
    expect(quietTool).toBeDefined();
    expect(quietTool?.description).toContain("no spoken response is needed");
    expect(instructions).toContain("use remain_silent instead of saying anything");
  });
});
