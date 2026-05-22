import { describe, expect, it } from "vitest";

import type { AppEvent, PendingCodexRequest, VoiceTranscriptMessage } from "../../shared/types";
import {
  hasNewPendingRequests,
  voiceShortcutActionForEvent,
} from "./main";
import {
  shouldConsumeActivationRequest,
  isTranscriptScrollPinned,
  transcriptEntries,
} from "./rightPanel";

function request(requestId: string): PendingCodexRequest {
  return {
    kind: "approval",
    requestId,
    method: "item/commandExecution/requestApproval",
    title: "Run command?",
    body: "npm test",
    raw: {},
  };
}

function keyEvent(
  key: string,
  modifiers: Partial<Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "altKey" | "shiftKey">> = {},
): Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey"> {
  return {
    key,
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

describe("renderer voice shortcuts", () => {
  it("maps Cmd comma and Cmd period on macOS", () => {
    expect(voiceShortcutActionForEvent(keyEvent(",", { metaKey: true }), "MacIntel")).toBe("settings");
    expect(voiceShortcutActionForEvent(keyEvent(".", { metaKey: true }), "MacIntel")).toBe("rightPanel");
  });

  it("uses Ctrl fallback off macOS and ignores unhandled shortcuts", () => {
    expect(voiceShortcutActionForEvent(keyEvent(",", { ctrlKey: true }), "Linux x86_64")).toBe("settings");
    expect(voiceShortcutActionForEvent(keyEvent(".", { ctrlKey: true }), "Win32")).toBe("rightPanel");
    expect(voiceShortcutActionForEvent(keyEvent("k", { ctrlKey: true }), "Win32")).toBeNull();
    expect(voiceShortcutActionForEvent(keyEvent(",", { ctrlKey: true }), "MacIntel")).toBeNull();
  });
});

describe("pending request activation", () => {
  it("detects newly appearing pending approvals without retriggering existing ones", () => {
    expect(hasNewPendingRequests([], [request("approval-1")])).toBe(true);
    expect(hasNewPendingRequests(["approval-1"], [request("approval-1")])).toBe(false);
    expect(hasNewPendingRequests(["approval-1"], [request("approval-1"), request("approval-2")])).toBe(true);
    expect(hasNewPendingRequests(["approval-1", "approval-2"], [request("approval-2")])).toBe(false);
  });

  it("consumes a sidebar activation request only once", () => {
    expect(shouldConsumeActivationRequest(true, 1, 0)).toBe(true);
    expect(shouldConsumeActivationRequest(true, 1, 1)).toBe(false);
    expect(shouldConsumeActivationRequest(false, 2, 1)).toBe(false);
    expect(shouldConsumeActivationRequest(true, 2, 1)).toBe(true);
  });
});

describe("sidebar transcript helpers", () => {
  it("keeps the transcript pinned only when it is near the bottom", () => {
    expect(isTranscriptScrollPinned({ scrollHeight: 1000, scrollTop: 620, clientHeight: 340 })).toBe(true);
    expect(isTranscriptScrollPinned({ scrollHeight: 1000, scrollTop: 500, clientHeight: 340 })).toBe(false);
  });

  it("merges persisted transcript messages with newer live realtime events", () => {
    const stored: VoiceTranscriptMessage[] = [
      {
        id: "realtime:chat-1:user:item-1",
        chatId: "chat-1",
        threadId: "thread-1",
        source: "realtime",
        role: "user",
        text: "hello",
        createdAt: "2026-05-22T10:00:00.000Z",
        completedAt: null,
        status: "streaming",
      },
    ];
    const events: AppEvent[] = [
      {
        at: "2026-05-22T10:00:02.000Z",
        source: "realtime",
        kind: "userTranscript",
        message: "hello there",
        raw: {
          chatId: "chat-1",
          threadId: "thread-1",
          item_id: "item-1",
          transcript: "hello there",
        },
      },
      {
        at: "2026-05-22T10:00:03.000Z",
        source: "realtime",
        kind: "assistantTranscript",
        message: "hi",
        raw: {
          chatId: "chat-1",
          threadId: "thread-1",
          response_id: "response-1",
          transcript: "hi",
        },
      },
    ];

    expect(transcriptEntries(stored, events, "chat-1")).toEqual([
      expect.objectContaining({ id: "realtime:chat-1:user:item-1", text: "hello there", status: "completed" }),
      expect.objectContaining({ role: "assistant", text: "hi", status: "completed" }),
    ]);
  });
});
