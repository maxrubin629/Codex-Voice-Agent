import { describe, expect, it } from "vitest";
import { classifyReplayEvent, replayFrameAt } from "./replay";
import type { AppEvent } from "./types";

describe("replay timeline reducer", () => {
  const events: AppEvent[] = [
    {
      at: "2026-05-13T12:00:00.000Z",
      source: "app",
      kind: "replayRecordingStarted",
      message: "Started replay recording.",
    },
    {
      at: "2026-05-13T12:00:01.000Z",
      source: "realtime",
      kind: "assistantTranscript",
      message: "I sent that to Codex.",
      raw: { type: "response.output_audio_transcript.done" },
    },
    {
      at: "2026-05-13T12:00:02.000Z",
      source: "realtime",
      kind: "toolCall",
      message: "submit_to_codex {}",
      raw: { responseId: "response-1", callId: "call-1" },
    },
    {
      at: "2026-05-13T12:00:03.000Z",
      source: "codex",
      kind: "serverRequest",
      message: "Codex wants approval.",
    },
    {
      at: "2026-05-13T12:00:04.000Z",
      source: "codex",
      kind: "item/started",
      message: "Codex is coordinating a sub-agent.",
      raw: { item: { type: "sub-agent" } },
    },
  ];

  it("reconstructs a point-in-time cockpit frame", () => {
    const frame = replayFrameAt(events, Date.parse("2026-05-13T12:00:03.000Z"));

    expect(frame.events).toHaveLength(4);
    expect(frame.latestStatus).toBe("Codex wants approval.");
    expect(frame.transcriptText).toContain("I sent that to Codex.");
    expect(frame.toolCallCount).toBe(1);
    expect(frame.pendingApprovalCount).toBe(1);
    expect(frame.subagentCount).toBe(0);
    expect(frame.sourceCounts).toMatchObject({ app: 1, realtime: 2, codex: 1 });
  });

  it("classifies timeline ticks by semantic event type", () => {
    expect(classifyReplayEvent(events[1])).toBe("realtime");
    expect(classifyReplayEvent(events[2])).toBe("tool");
    expect(classifyReplayEvent(events[3])).toBe("approval");
    expect(classifyReplayEvent(events[4])).toBe("subagent");
  });
});
