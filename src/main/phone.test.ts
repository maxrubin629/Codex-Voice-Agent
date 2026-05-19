import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/cva-test",
  },
}));

vi.mock("./apiKeyStore", () => ({
  getOpenAiApiKey: () => "test-key",
}));

vi.mock("./realtime", () => ({
  realtimeConfig: () => ({
    available: true,
    model: "gpt-realtime-2",
    voice: "marin",
    reasoningEffort: "low",
    reason: null,
    apiKeySource: "saved",
    apiKeyEncrypted: false,
  }),
  realtimeTools: () => [],
}));

import { isAllowedCaller, PhoneController, type PhoneCallSession, type PhoneRealtimeAdapter } from "./phone";

class FakePhoneAdapter implements PhoneRealtimeAdapter {
  accepted: string[] = [];
  rejected: Array<{ callId: string; statusCode?: number }> = [];
  hungUp: string[] = [];

  async acceptCall(callId: string): Promise<void> {
    this.accepted.push(callId);
  }

  async rejectCall(callId: string, statusCode?: number): Promise<void> {
    this.rejected.push({ callId, statusCode });
  }

  async hangupCall(callId: string): Promise<void> {
    this.hungUp.push(callId);
  }
}

async function incoming(
  controller: PhoneController,
  event: { callId: string; from: string | null },
): Promise<void> {
  await (controller as unknown as { handleIncomingCall(event: unknown): Promise<void> }).handleIncomingCall({
    eventId: event.callId,
    callId: event.callId,
    from: event.from,
  });
}

describe("SIP phone state machine", () => {
  it("rejects calls from numbers outside the allowlist", async () => {
    const adapter = new FakePhoneAdapter();
    const controller = new PhoneController(adapter);
    await controller.updateSettings({
      enabled: true,
      allowedCallerNumbers: ["+15551234567"],
      allowUnsignedDevWebhooks: true,
    });

    await incoming(controller, { callId: "call-reject", from: "+15557654321" });

    expect(adapter.rejected).toEqual([{ callId: "call-reject", statusCode: 603 }]);
    expect(controller.status().activeCall).toBeNull();
    expect(controller.status().logs[0]).toMatchObject({
      callId: "call-reject",
      status: "rejected",
      reason: "Caller is not on the allowlist.",
    });
  });

  it("enforces one active call at a time", async () => {
    const adapter = new FakePhoneAdapter();
    const controller = new PhoneController(adapter);
    await controller.updateSettings({
      enabled: true,
      allowedCallerNumbers: ["+15551234567"],
      allowUnsignedDevWebhooks: true,
    });

    await incoming(controller, { callId: "call-1", from: "+15551234567" });
    await incoming(controller, { callId: "call-2", from: "+15551234567" });

    expect(adapter.accepted).toEqual(["call-1"]);
    expect(adapter.rejected).toEqual([{ callId: "call-2", statusCode: 486 }]);
    expect(controller.status().activeCall).toMatchObject({ callId: "call-1", status: "active" });
  });

  it("starts a Realtime SIP call session after accepting a call", async () => {
    const adapter = new FakePhoneAdapter();
    const started: string[] = [];
    const closed: string[] = [];
    const controller = new PhoneController(adapter, {
      callSessionFactory: (call): PhoneCallSession => ({
        async start() {
          started.push(call.callId);
        },
        close() {
          closed.push(call.callId);
        },
      }),
    });
    await controller.updateSettings({
      enabled: true,
      allowedCallerNumbers: ["+15551234567"],
      allowUnsignedDevWebhooks: true,
    });

    await incoming(controller, { callId: "call-1", from: "+15551234567" });
    await controller.hangupActiveCall();

    expect(started).toEqual(["call-1"]);
    expect(closed).toEqual(["call-1"]);
  });

  it("hangs up the active call and records an ended state", async () => {
    const adapter = new FakePhoneAdapter();
    const controller = new PhoneController(adapter);
    await controller.updateSettings({
      enabled: true,
      allowedCallerNumbers: ["+15551234567"],
      allowUnsignedDevWebhooks: true,
    });
    await incoming(controller, { callId: "call-1", from: "+15551234567" });

    await controller.hangupActiveCall();

    expect(adapter.hungUp).toEqual(["call-1"]);
    expect(controller.status().activeCall).toBeNull();
    expect(controller.status().logs[0]).toMatchObject({ callId: "call-1", status: "ended" });
  });

  it("normalizes allowlist comparisons", () => {
    expect(isAllowedCaller("+1 (555) 123-4567", ["+15551234567"])).toBe(true);
    expect(isAllowedCaller(null, ["+15551234567"])).toBe(false);
    expect(isAllowedCaller("+15551234567", [])).toBe(false);
  });

  it("rejects calls while phone mode is disabled", async () => {
    const adapter = new FakePhoneAdapter();
    const controller = new PhoneController(adapter);
    await controller.updateSettings({
      enabled: false,
      allowedCallerNumbers: ["+15551234567"],
      allowUnsignedDevWebhooks: true,
    });

    await incoming(controller, { callId: "call-disabled", from: "+15551234567" });

    expect(adapter.accepted).toEqual([]);
    expect(adapter.rejected).toEqual([{ callId: "call-disabled", statusCode: 480 }]);
    expect(controller.status().activeCall).toBeNull();
  });
});
