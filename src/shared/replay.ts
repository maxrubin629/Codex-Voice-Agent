import type { AppEvent } from "./types";

export type ReplayEventTone =
  | "realtime"
  | "codex"
  | "app"
  | "tool"
  | "approval"
  | "subagent"
  | "error";

export type ReplayFrame = {
  cursorAt: string | null;
  events: AppEvent[];
  currentEvent: AppEvent | null;
  latestStatus: string;
  sourceCounts: Record<AppEvent["source"], number>;
  transcriptText: string;
  toolCallCount: number;
  pendingApprovalCount: number;
  subagentCount: number;
  errorCount: number;
};

export function replayFrameAt(events: AppEvent[], cursorMs: number | null): ReplayFrame {
  const ordered = sortReplayEvents(events);
  const visible = cursorMs === null
    ? ordered
    : ordered.filter((event) => {
        const eventMs = Date.parse(event.at);
        return Number.isFinite(eventMs) && eventMs <= cursorMs;
      });
  const currentEvent = visible.at(-1) ?? null;
  const sourceCounts: ReplayFrame["sourceCounts"] = { app: 0, codex: 0, realtime: 0 };
  const transcript: string[] = [];
  let latestStatus = "No replay events at this point.";
  let toolCallCount = 0;
  let pendingApprovalCount = 0;
  let subagentCount = 0;
  let errorCount = 0;

  for (const event of visible) {
    sourceCounts[event.source] += 1;
    const tone = classifyReplayEvent(event);
    if (tone === "tool") toolCallCount += 1;
    if (tone === "approval") pendingApprovalCount += 1;
    if (tone === "subagent") subagentCount += 1;
    if (tone === "error") errorCount += 1;
    if (isTranscriptEvent(event)) {
      transcript.push(`${event.source === "realtime" ? "Realtime" : event.source}: ${event.message}`);
    }
    if (event.message) latestStatus = event.message;
  }

  return {
    cursorAt: currentEvent?.at ?? null,
    events: visible,
    currentEvent,
    latestStatus,
    sourceCounts,
    transcriptText: transcript.slice(-8).join("\n"),
    toolCallCount,
    pendingApprovalCount,
    subagentCount,
    errorCount,
  };
}

export function sortReplayEvents(events: AppEvent[]): AppEvent[] {
  return [...events].sort((left, right) => {
    const leftMs = Date.parse(left.at);
    const rightMs = Date.parse(right.at);
    if (leftMs !== rightMs) return leftMs - rightMs;
    return `${left.source}:${left.kind}:${left.message}`.localeCompare(`${right.source}:${right.kind}:${right.message}`);
  });
}

export function classifyReplayEvent(event: AppEvent): ReplayEventTone {
  const text = `${event.source} ${event.kind} ${event.message} ${rawType(event.raw) ?? ""}`.toLowerCase();
  if (text.includes("error") || text.includes("failed") || text.includes("stderr")) return "error";
  if (text.includes("approval") || text.includes("serverrequest") || text.includes("requestuserinput")) return "approval";
  if (text.includes("subagent") || text.includes("sub-agent") || text.includes("multi_agent")) return "subagent";
  if (text.includes("tool") || text.includes("function_call") || text.includes("function call")) return "tool";
  if (event.source === "realtime") return "realtime";
  if (event.source === "codex") return "codex";
  return "app";
}

function isTranscriptEvent(event: AppEvent): boolean {
  const type = rawType(event.raw);
  return [
    "userTranscript",
    "assistantTranscript",
    "conversation.item.input_audio_transcription.completed",
    "response.output_audio_transcript.done",
  ].includes(event.kind) || [
    "conversation.item.input_audio_transcription.completed",
    "response.output_audio_transcript.done",
  ].includes(type ?? "");
}

function rawType(raw: unknown): string | null {
  return raw && typeof raw === "object" && !Array.isArray(raw) && typeof (raw as { type?: unknown }).type === "string"
    ? ((raw as { type: string }).type)
    : null;
}
