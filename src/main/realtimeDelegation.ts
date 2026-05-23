export const REALTIME_CONVERSATION_STARTED_TEXT = [
  "Realtime conversation started.",
  "",
  "You are operating as a backend executor behind an intermediary. The user does not talk to you directly. Any response you produce will be consumed by the intermediary and may be summarized before the user sees it.",
  "",
  "When invoked, you receive the latest conversation transcript and any relevant mode or metadata. The intermediary may invoke you even when backend help is not actually needed. Use the transcript to decide whether you should do work. If backend help is unnecessary, avoid verbose responses that add user-visible latency.",
  "",
  "When user text is routed from realtime, treat it as a transcript. It may be unpunctuated or contain recognition errors.",
  "",
  "- Keep responses concise and action-oriented. Your updates should help the intermediary respond to the user.",
].join("\n");

export const REALTIME_CONVERSATION_ENDED_TEXT = [
  "Realtime conversation ended.",
  "",
  "Subsequent user input will return to typed text rather than transcript-style text. Do not assume recognition errors or missing punctuation once realtime has ended. Resume normal chat behavior.",
  "",
  "Reason: inactive",
].join("\n");

export const REALTIME_CONVERSATION_ENDED_INPUT = "Realtime conversation ended.";

type RealtimeDelegationOptions = {
  input: string;
  transcriptDelta?: string | null;
  includeStart?: boolean;
};

export function buildRealtimeDelegationText({
  input,
  transcriptDelta,
  includeStart = false,
}: RealtimeDelegationOptions): string {
  const lines = ["<realtime_delegation>"];
  if (includeStart) {
    lines.push("  <realtime_conversation>");
    lines.push(REALTIME_CONVERSATION_STARTED_TEXT);
    lines.push("  </realtime_conversation>");
  }
  lines.push(`  <input>${escapeXmlText(input)}</input>`);
  const trimmedTranscriptDelta = transcriptDelta?.trim();
  if (trimmedTranscriptDelta) {
    lines.push(`  <transcript_delta>${escapeXmlText(trimmedTranscriptDelta)}</transcript_delta>`);
  }
  lines.push("</realtime_delegation>");
  return lines.join("\n");
}

export function buildRealtimeConversationEndedDelegationText(): string {
  return [
    "<realtime_delegation>",
    "  <realtime_conversation>",
    REALTIME_CONVERSATION_ENDED_TEXT,
    "  </realtime_conversation>",
    `  <input>${REALTIME_CONVERSATION_ENDED_INPUT}</input>`,
    "</realtime_delegation>",
  ].join("\n");
}

export function realtimeUserMessageItem(text: string): Record<string, unknown> {
  return {
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  };
}

function escapeXmlText(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
