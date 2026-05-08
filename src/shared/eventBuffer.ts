import type { AppEvent } from "./types";

export const maxBufferedEvents = 2_000;

export function appendBufferedEvent(
  events: AppEvent[],
  event: AppEvent,
  limit = maxBufferedEvents,
): AppEvent[] {
  let next = events;
  const completedStreamKey = realtimeTranscriptStreamKey(event, "completed");
  if (completedStreamKey) {
    next = next.filter((candidate) => realtimeTranscriptStreamKey(candidate, "delta") !== completedStreamKey);
  }

  const deltaStreamKey = realtimeTranscriptStreamKey(event, "delta");
  if (deltaStreamKey) {
    const existingIndex = next.findIndex((candidate) => realtimeTranscriptStreamKey(candidate, "delta") === deltaStreamKey);
    if (existingIndex !== -1) {
      const merged = mergeRealtimeTranscriptDelta(next[existingIndex], event);
      return [merged, ...next.filter((_, index) => index !== existingIndex)].slice(0, limit);
    }
  }

  return [event, ...next].slice(0, limit);
}

function mergeRealtimeTranscriptDelta(previous: AppEvent, next: AppEvent): AppEvent {
  const previousRaw = recordFromUnknown(previous.raw);
  const nextRaw = recordFromUnknown(next.raw);
  const previousDelta = streamedString(previousRaw?.delta) ?? previous.message;
  const nextDelta = streamedString(nextRaw?.delta) ?? next.message;
  const delta = `${previousDelta}${nextDelta}`;
  return {
    ...next,
    message: delta,
    raw: {
      ...(previousRaw ?? {}),
      ...(nextRaw ?? {}),
      delta,
    },
  };
}

function realtimeTranscriptStreamKey(event: AppEvent, phase: "delta" | "completed"): string | null {
  if (event.source !== "realtime") return null;
  const role = realtimeTranscriptRole(event, phase);
  if (!role) return null;
  const raw = recordFromUnknown(event.raw);
  const itemId = stringField(raw?.item_id) ?? stringField(raw?.itemId);
  const responseId = stringField(raw?.response_id) ?? stringField(raw?.responseId);
  const outputIndex = numberField(raw?.output_index) ?? numberField(raw?.outputIndex);
  const contentIndex = numberField(raw?.content_index) ?? numberField(raw?.contentIndex);
  const key = [role, itemId, responseId, outputIndex, contentIndex]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .join(":");
  return key || null;
}

function realtimeTranscriptRole(event: AppEvent, phase: "delta" | "completed"): "user" | "assistant" | null {
  const rawType = stringField(recordFromUnknown(event.raw)?.type);
  if (phase === "delta") {
    if (event.kind === "userTranscriptDelta" || rawType === "conversation.item.input_audio_transcription.delta") {
      return "user";
    }
    if (
      event.kind === "voiceDelta" ||
      event.kind === "assistantTranscriptDelta" ||
      rawType === "response.output_audio_transcript.delta"
    ) {
      return "assistant";
    }
    return null;
  }
  if (event.kind === "userTranscript" || rawType === "conversation.item.input_audio_transcription.completed") {
    return "user";
  }
  if (event.kind === "assistantTranscript" || rawType === "response.output_audio_transcript.done") {
    return "assistant";
  }
  return null;
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function streamedString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberField(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
