import { describe, expect, it } from "vitest";

import type { PendingCodexRequest } from "../../shared/types";
import {
  hasNewPendingRequests,
  voiceShortcutActionForEvent,
} from "./main";

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
});
