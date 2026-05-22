import { describe, expect, it } from "vitest";

import {
  REALTIME_CONVERSATION_ENDED_INPUT,
  buildRealtimeConversationEndedDelegationText,
  buildRealtimeDelegationText,
} from "./realtimeDelegation";

describe("realtime delegation XML", () => {
  it("wraps the first delegated turn with start context, visible input, and transcript delta", () => {
    const text = buildRealtimeDelegationText({
      input: "open & fix <the app>",
      transcriptDelta: "user: \"please\"",
      includeStart: true,
    });

    expect(text).toContain("<realtime_delegation>");
    expect(text).toContain("<realtime_conversation>");
    expect(text).toContain("Realtime conversation started.");
    expect(text).toContain("<input>open &amp; fix &lt;the app&gt;</input>");
    expect(text).toContain("<transcript_delta>user: &quot;please&quot;</transcript_delta>");
  });

  it("omits start context and transcript delta for later delegated turns without extra context", () => {
    const text = buildRealtimeDelegationText({
      input: "run tests",
      includeStart: false,
    });

    expect(text).toBe([
      "<realtime_delegation>",
      "  <input>run tests</input>",
      "</realtime_delegation>",
    ].join("\n"));
  });

  it("builds a user-visible realtime-ended history item", () => {
    const text = buildRealtimeConversationEndedDelegationText();

    expect(text).toContain("<realtime_conversation>");
    expect(text).toContain("Realtime conversation ended.");
    expect(text).toContain(`<input>${REALTIME_CONVERSATION_ENDED_INPUT}</input>`);
    expect(text).toContain("Reason: inactive");
  });
});
