#!/usr/bin/env node

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function read(relativePath) {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function assertIncludes(file, needle, note) {
  if (!file.includes(needle)) {
    throw new Error(`Missing orchestration contract: ${note}\nExpected to find: ${needle}`);
  }
}

const realtime = read("src/main/realtime.ts");
const orchestrator = read("src/main/orchestrator.ts");
const types = read("src/shared/types.ts");
const realtimeClient = read("src/renderer/src/realtimeClient.ts");

assertIncludes(realtime, "You are Codex.", "Realtime identity should be Codex, not a separate proxy voice.");
assertIncludes(realtime, "live Codex orchestrator", "Realtime prompt should describe the voice agent as the orchestration layer.");
assertIncludes(realtime, "Projects are workspace/path-bound containers.", "Realtime prompt should define projects.");
assertIncludes(realtime, "Threads are named workstreams inside a project.", "Realtime prompt should define threads.");
assertIncludes(realtime, 'name: "dispatch_codex_task"', "Dispatch tool should remain the primary handoff tool.");
assertIncludes(realtime, 'name: "create_new_codex_thread"', "Model-facing thread creation tool should use thread wording.");
assertIncludes(realtime, 'name: "list_codex_threads"', "Model-facing list tool should use thread wording.");
assertIncludes(realtime, 'name: "get_codex_thread_status"', "Model-facing status tool should use thread wording.");
assertIncludes(realtime, "projectHandle", "Realtime tools should expose canonical project handles.");
assertIncludes(realtime, "threadHandle", "Realtime tools should expose canonical thread handles.");

assertIncludes(types, "projectHandle: string;", "Runtime project summaries should include project handles.");
assertIncludes(types, "handle: string;", "Runtime thread summaries should include canonical handles.");
assertIncludes(types, "threadHandle?: string | null;", "Thread targets should accept canonical handles.");

assertIncludes(orchestrator, "function projectHandle", "Project handles should be computed centrally.");
assertIncludes(orchestrator, "function threadHandle", "Thread handles should be computed centrally.");
assertIncludes(orchestrator, "findProjectForThreadTarget", "Dispatch should be able to resolve a project from a thread handle.");
assertIncludes(orchestrator, 'this.codex.request("turn/start"', "Dispatch should still start a real Codex turn.");
assertIncludes(orchestrator, "...(turnSettings.model ? { model: turnSettings.model } : {})", "Codex turns should carry resolved model settings.");
assertIncludes(orchestrator, "...(turnSettings.reasoningEffort ? { effort: turnSettings.reasoningEffort } : {})", "Codex turns should carry resolved reasoning settings.");

assertIncludes(realtimeClient, "create_new_codex_thread", "Renderer should handle the model-facing thread creation tool.");
assertIncludes(realtimeClient, "list_codex_threads", "Renderer should handle the model-facing thread list tool.");
assertIncludes(realtimeClient, "get_codex_thread_status", "Renderer should handle the model-facing thread status tool.");
assertIncludes(realtimeClient, "normalizeHandlePath", "Renderer should resolve canonical handles.");

console.log("Codex Voice orchestration surface looks coherent.");
