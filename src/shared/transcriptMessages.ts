import type {
  AppEvent,
  VoiceTranscriptMessage,
  VoiceTranscriptMessageRole,
} from "./types";

export function transcriptMessageFromEvent(event: AppEvent): VoiceTranscriptMessage | null {
  const raw = recordFromUnknown(event.raw);
  const transcript = realtimeTranscriptDetails(event, raw);
  if (!transcript) return null;
  const role = transcript.role;

  const chatId = stringField(raw?.chatId);
  if (!chatId) return null;

  const text = realtimeTranscriptText(event, raw, transcript.phase);
  if (!text) return null;

  const id = transcriptMessageIdFromEvent(event);
  if (!id) return null;

  const threadId = stringField(raw?.threadId);
  const responseId = stringField(raw?.response_id) ?? stringField(raw?.responseId);
  const itemId = stringField(raw?.item_id) ?? stringField(raw?.itemId);
  const turnId = stringField(raw?.turnId);
  const metadata = transcriptMetadata(event, raw);

  return {
    id,
    chatId,
    threadId,
    source: "realtime",
    role,
    text,
    createdAt: event.at,
    completedAt: transcript.phase === "completed" ? event.at : null,
    status: transcript.phase === "completed" ? "completed" : "streaming",
    ...(turnId ? { turnId } : {}),
    ...(responseId ? { responseId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

export function transcriptMessageIdFromEvent(event: AppEvent): string | null {
  const raw = recordFromUnknown(event.raw);
  const transcript = realtimeTranscriptDetails(event, raw);
  if (!transcript) return null;
  const chatId = stringField(raw?.chatId);
  if (!chatId) return null;
  const key = realtimeTranscriptKey(transcript.role, raw);
  return `realtime:${chatId}:${key || `${transcript.role}:${event.at}`}`;
}

function transcriptMetadata(event: AppEvent, raw: Record<string, unknown> | null): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    kind: event.kind,
  };
  const rawType = stringField(raw?.type);
  if (rawType) metadata.rawType = rawType;
  const outputIndex = numberField(raw?.output_index) ?? numberField(raw?.outputIndex);
  if (outputIndex !== null) metadata.outputIndex = outputIndex;
  const contentIndex = numberField(raw?.content_index) ?? numberField(raw?.contentIndex);
  if (contentIndex !== null) metadata.contentIndex = contentIndex;
  const attachments = transcriptAttachments(raw?.attachments);
  if (attachments.length > 0) metadata.attachments = attachments;
  return metadata;
}

function realtimeTranscriptDetails(
  event: AppEvent,
  raw: Record<string, unknown> | null,
): { role: VoiceTranscriptMessageRole; phase: "streaming" | "completed" } | null {
  const rawType = stringField(raw?.type);
  if (event.source !== "realtime") return null;
  if (event.kind === "userInput" || rawType === "codex_voice.user_input") {
    return { role: "user", phase: "completed" };
  }
  if (event.kind === "userTranscriptDelta" || rawType === "conversation.item.input_audio_transcription.delta") {
    return { role: "user", phase: "streaming" };
  }
  if (
    event.kind === "voiceDelta" ||
    event.kind === "assistantTranscriptDelta" ||
    rawType === "response.output_audio_transcript.delta"
  ) {
    return { role: "assistant", phase: "streaming" };
  }
  if (event.kind === "userTranscript" || rawType === "conversation.item.input_audio_transcription.completed") {
    return { role: "user", phase: "completed" };
  }
  if (event.kind === "assistantTranscript" || rawType === "response.output_audio_transcript.done") {
    return { role: "assistant", phase: "completed" };
  }
  return null;
}

function realtimeTranscriptText(
  event: AppEvent,
  raw: Record<string, unknown> | null,
  phase: "streaming" | "completed",
): string | null {
  const text =
    phase === "streaming"
      ? streamedString(raw?.delta) ?? stringField(raw?.transcript) ?? stringField(raw?.text)
      : stringField(raw?.transcript) ?? stringField(raw?.text);
  if (text) return text;
  const attachmentText = attachmentTranscriptText(raw?.attachments);
  if (attachmentText) return attachmentText;
  const fallback = stringField(event.message);
  if (!fallback || fallback === event.kind || fallback.includes("_audio_transcript")) return null;
  return fallback;
}

function realtimeTranscriptKey(role: VoiceTranscriptMessageRole, raw: Record<string, unknown> | null): string | null {
  const userInputId = stringField(raw?.userInputId);
  if (userInputId) return `${role}:${userInputId}`;
  const itemId = stringField(raw?.item_id) ?? stringField(raw?.itemId);
  const responseId = stringField(raw?.response_id) ?? stringField(raw?.responseId);
  const outputIndex = numberField(raw?.output_index) ?? numberField(raw?.outputIndex);
  const contentIndex = numberField(raw?.content_index) ?? numberField(raw?.contentIndex);
  const key = [role, itemId, responseId, outputIndex, contentIndex]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .join(":");
  return key || null;
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

function transcriptAttachments(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): Record<string, unknown> | null => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const record = item as Record<string, unknown>;
      const name = stringField(record.name);
      const mimeType = stringField(record.mimeType);
      const sizeBytes = numberField(record.sizeBytes);
      if (!name || !mimeType || sizeBytes === null) return null;
      return {
        id: stringField(record.id) ?? name,
        kind: stringField(record.kind) ?? "image",
        name,
        mimeType,
        sizeBytes,
        localPath: stringField(record.localPath),
      };
    })
    .filter((item): item is Record<string, unknown> => item !== null);
}

function attachmentTranscriptText(value: unknown): string | null {
  const attachments = transcriptAttachments(value);
  if (attachments.length === 0) return null;
  if (attachments.length === 1) return `Image: ${stringField(attachments[0].name) ?? "attachment"}`;
  return `${attachments.length} images`;
}
