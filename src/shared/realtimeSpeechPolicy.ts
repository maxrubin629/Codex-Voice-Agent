const QUIET_AFTER_TOOL_OUTPUT = new Set([
  "submit_to_codex",
  "steer_codex",
  "queue_codex_request",
  "cancel_queued_codex_request",
  "interrupt_codex",
  "steer_codex_subagent",
  "answer_codex_approval",
  "answer_codex_question",
  "remain_silent",
]);

export function shouldCreateRealtimeResponseAfterToolOutputs(toolNames: Iterable<string>): boolean {
  for (const toolName of toolNames) {
    if (!QUIET_AFTER_TOOL_OUTPUT.has(toolName)) return true;
  }
  return false;
}
