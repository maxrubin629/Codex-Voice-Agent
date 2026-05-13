import type {
  AppState,
  ApprovalDecision,
  CodexPermissionMode,
  CodexRuntimeState,
  CodexSettings,
  CodexSettingsScope,
  CodexActionResult,
  PendingCodexRequest,
  QueuedCodexRequestResult,
  ReasoningEffort,
  ToolQuestionAnswer,
  VoiceChat,
  VoiceProject,
} from "../shared/types";
import type { PhoneToolHandler } from "./phone";

type VoiceToolApi = {
  state(): Promise<AppState>;
  sendToCodex(text: string, chatId?: string, workspacePath?: string | null): Promise<CodexActionResult>;
  steerCodex(text: string, chatId?: string): Promise<{ turnId: string }>;
  queueCodexRequest(
    text: string,
    chatId?: string,
    workspacePath?: string | null,
  ): Promise<QueuedCodexRequestResult>;
  cancelQueuedCodexRequest(queuedId?: string | null, chatId?: string): Promise<unknown>;
  interruptCodex(chatId?: string): Promise<void>;
  answerApproval(requestId: string | number, decision: ApprovalDecision): Promise<void>;
  answerToolQuestion(requestId: string | number, answers: ToolQuestionAnswer[]): Promise<void>;
  setCodexSettings(
    settings: {
      model?: string | null;
      reasoningEffort?: ReasoningEffort | null;
      permissionMode?: CodexPermissionMode | null;
    },
    scope: CodexSettingsScope,
  ): Promise<CodexSettings>;
  createProject(name?: string, workspacePath?: string | null): Promise<VoiceProject>;
  createChat(name: string, projectId?: string): Promise<VoiceProject>;
  switchChat(chatId: string, projectId?: string): Promise<VoiceProject>;
  getChatStatus(chatId?: string): Promise<CodexRuntimeState["chats"]>;
  showProjectChats(open?: boolean): Promise<void>;
  resumeProject(projectId: string): Promise<VoiceProject>;
  summarizeProject(projectId?: string, chatId?: string): Promise<string>;
};

export function createVoiceToolHandler(api: VoiceToolApi): PhoneToolHandler {
  return async (name, args) => {
    if (name === "submit_to_codex") {
      const request = stringArg(args.request);
      const context = optionalString(args.context);
      const chatId = await resolveChatId(api, optionalString(args.chatId), optionalString(args.chatName));
      const result = await api.sendToCodex(
        context ? `${request}\n\nVoice conversation context:\n${context}` : request,
        chatId,
        optionalString(args.workspacePath),
      );
      return {
        ok: true,
        message: result.message,
        turnId: result.turnId,
        project: result.project,
        chat: result.chat,
      };
    }

    if (name === "steer_codex") {
      const result = await api.steerCodex(
        stringArg(args.message),
        await resolveChatId(api, optionalString(args.chatId), optionalString(args.chatName)),
      );
      return { ok: true, message: "Codex received the update.", ...result };
    }

    if (name === "queue_codex_request") {
      const request = stringArg(args.request);
      const context = optionalString(args.context);
      const result = await api.queueCodexRequest(
        context ? `${request}\n\nVoice conversation context:\n${context}` : request,
        await resolveChatId(api, optionalString(args.chatId), optionalString(args.chatName)),
        optionalString(args.workspacePath),
      );
      return { ok: true, ...result };
    }

    if (name === "cancel_queued_codex_request") {
      const result = await api.cancelQueuedCodexRequest(
        optionalString(args.queuedId),
        await resolveChatId(api, optionalString(args.chatId), optionalString(args.chatName)),
      );
      return { ok: true, ...objectFromUnknown(result) };
    }

    if (name === "interrupt_codex") {
      await api.interruptCodex(await resolveChatId(api, optionalString(args.chatId), optionalString(args.chatName)));
      return { ok: true, message: "Codex interruption was requested." };
    }

    if (name === "get_codex_status") {
      const state = await api.state();
      const activeProject = state.activeProject;
      return {
        ok: true,
        activeProject,
        activeChat: activeProject ? activeChat(visibleChats(activeProject.chats), activeProject.activeChatId) : null,
        runtime: state.runtime,
        codexSettings: state.codexSettings,
      };
    }

    if (name === "answer_codex_approval") {
      const state = await api.state();
      const request = findPendingRequest(
        state.runtime.pendingRequests,
        optionalString(args.requestId),
        canAnswerWithApprovalDecision,
        "approval",
      );
      const decision = approvalDecisionArg(args.decision);
      await api.answerApproval(request.requestId, decision);
      return {
        ok: true,
        message: approvalDecisionMessage(decision),
        request: summarizePendingRequest(request),
      };
    }

    if (name === "answer_codex_question") {
      const answer = stringArg(args.answer);
      const state = await api.state();
      const request = findPendingRequest(
        state.runtime.pendingRequests,
        optionalString(args.requestId),
        (candidate) => candidate.kind === "question",
        "question",
      );
      const answers = answersForQuestionRequest(request, optionalString(args.questionId), answer);
      await api.answerToolQuestion(request.requestId, answers);
      return {
        ok: true,
        message: "Answered Codex's question.",
        request: summarizePendingRequest(request),
        answers,
      };
    }

    if (name === "set_codex_model") {
      const settings = await api.setCodexSettings({ model: stringArg(args.model) }, scopeArg(args.scope));
      return { ok: true, message: "Updated Codex model settings.", settings };
    }

    if (name === "set_codex_reasoning_effort") {
      const settings = await api.setCodexSettings(
        { reasoningEffort: reasoningEffortArg(args.reasoningEffort) },
        scopeArg(args.scope),
      );
      return { ok: true, message: "Updated Codex reasoning effort settings.", settings };
    }

    if (name === "set_codex_permissions") {
      const settings = await api.setCodexSettings(
        { permissionMode: permissionModeArg(args.permissionMode) },
        scopeArg(args.scope),
      );
      return { ok: true, message: "Updated Codex permission settings.", settings };
    }

    if (name === "create_new_codex_project") {
      const project = await api.createProject(optionalString(args.name), optionalString(args.workspacePath));
      return { ok: true, project };
    }

    if (name === "create_new_codex_chat") {
      const nameArg = stringArg(args.name);
      const project = await api.createChat(nameArg);
      return {
        ok: true,
        message: `Created chat ${nameArg}.`,
        project,
        activeChat: activeChat(visibleChats(project.chats), project.activeChatId),
      };
    }

    if (name === "list_codex_chats") {
      const state = await api.state();
      const activeProject = state.activeProject;
      return {
        ok: true,
        activeChatId: state.runtime.activeChatId,
        chats: visibleChats(activeProject?.chats ?? []),
        statuses: state.runtime.chats,
      };
    }

    if (name === "switch_codex_chat") {
      const chatId = await resolveChatId(api, optionalString(args.chatId), optionalString(args.name));
      if (!chatId) throw new Error("No chat matched that request.");
      const project = await api.switchChat(chatId);
      return {
        ok: true,
        message: "Switched active chat.",
        project,
        activeChat: activeChat(visibleChats(project.chats), project.activeChatId),
      };
    }

    if (name === "get_codex_chat_status") {
      const chatId = await resolveChatId(api, optionalString(args.chatId), optionalString(args.name), true);
      const statuses = await api.getChatStatus(chatId);
      return { ok: true, statuses };
    }

    if (name === "show_open_codex_chats") {
      await api.showProjectChats(true);
      const state = await api.state();
      const activeProject = state.activeProject;
      return {
        ok: true,
        message: "Showing open chats.",
        chats: visibleChats(activeProject?.chats ?? []),
        statuses: state.runtime.chats,
      };
    }

    if (name === "list_recent_codex_projects") {
      const state = await api.state();
      return {
        ok: true,
        projects: state.projects.slice(0, 8).map((project) => ({
          id: project.id,
          displayName: project.displayName,
          updatedAt: project.updatedAt,
          folderPath: project.folderPath,
          workspacePath: project.workspacePath,
          lastSummary: project.lastSummary,
          activeChatId: project.activeChatId,
          chats: visibleChats(project.chats),
        })),
      };
    }

    if (name === "continue_codex_project") {
      const state = await api.state();
      const projectId = optionalString(args.projectId) || state.projects[0]?.id;
      if (!projectId) throw new Error("No recent Codex voice projects exist yet.");
      const project = await api.resumeProject(projectId);
      return { ok: true, project };
    }

    if (name === "summarize_recent_project") {
      const summary = await api.summarizeProject(
        optionalString(args.projectId),
        await resolveChatId(api, optionalString(args.chatId), optionalString(args.chatName), true),
      );
      return { ok: true, summary };
    }

    throw new Error(`Unknown Realtime tool: ${name}`);
  };
}

function objectFromUnknown(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function stringArg(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Tool argument must be a non-empty string.");
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

async function resolveChatId(
  api: VoiceToolApi,
  chatId: string | undefined,
  name?: string,
  allowAll = false,
): Promise<string | undefined> {
  if (chatId) return chatId;
  if (!name) return allowAll ? undefined : undefined;
  const state = await api.state();
  const chat = findChatByName(state, name);
  if (!chat) throw new Error(`No chat matched "${name}".`);
  return chat.id;
}

function findChatByName(state: AppState, name: string): VoiceChat | null {
  const needle = name.trim().toLowerCase();
  const activeProject = state.activeProject;
  const chats = visibleChats(activeProject?.chats ?? []);
  const exact = chats.filter((chat) => chat.displayName.toLowerCase() === needle || chat.id === name);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`More than one chat matched "${name}".`);
  const partial = chats.filter((chat) => chat.displayName.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`More than one chat matched "${name}".`);
  return null;
}

function activeChat(chats: VoiceChat[], activeChatId: string | null): VoiceChat | null {
  return chats.find((chat) => chat.id === activeChatId) ?? chats[0] ?? null;
}

function visibleChats(chats: VoiceChat[]): VoiceChat[] {
  return chats.filter((chat) => !chat.archivedAt);
}

function scopeArg(value: unknown): CodexSettingsScope {
  return value === "nextTurn" ? "nextTurn" : "chat";
}

function reasoningEffortArg(value: unknown): ReasoningEffort {
  const effort = stringArg(value);
  const allowed: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
  if (!allowed.includes(effort as ReasoningEffort)) throw new Error(`Unknown reasoning effort: ${effort}`);
  return effort as ReasoningEffort;
}

function permissionModeArg(value: unknown): CodexPermissionMode {
  const mode = stringArg(value).toLowerCase();
  const normalized = mode.replace(/[_\s]+/g, "-");
  if (["default", "default-permissions", "normal"].includes(normalized)) return "default";
  if (["auto", "auto-review", "autoreview"].includes(normalized)) return "auto-review";
  if (["full", "full-access", "danger", "danger-full-access"].includes(normalized)) return "full-access";
  if (
    ["custom", "custom-config", "custom-config-toml", "custom-config.toml", "config", "config-toml", "config.toml"].includes(
      normalized,
    )
  ) {
    return "custom-config";
  }
  throw new Error(`Unknown permission mode: ${mode}`);
}

function approvalDecisionArg(value: unknown): ApprovalDecision {
  const raw = stringArg(value).toLowerCase();
  if (["accept", "allow", "approve", "yes", "ok", "okay", "go ahead"].includes(raw)) return "accept";
  if (["acceptforsession", "accept_for_session", "allowforsession", "session", "always"].includes(raw)) {
    return "acceptForSession";
  }
  if (["decline", "deny", "no", "do not allow", "don't allow"].includes(raw)) return "decline";
  if (["cancel", "abort", "stop"].includes(raw)) return "cancel";
  throw new Error(`Unknown approval decision: ${raw}`);
}

function findPendingRequest(
  requests: PendingCodexRequest[],
  requestId: string | undefined,
  predicate: (request: PendingCodexRequest) => boolean,
  label: string,
): PendingCodexRequest {
  const matching = requests.filter(predicate);
  if (requestId) {
    const request = matching.find((candidate) => String(candidate.requestId) === requestId);
    if (!request) throw new Error(`No pending Codex ${label} matched request id ${requestId}.`);
    return request;
  }
  if (matching.length === 1) return matching[0];
  if (matching.length === 0) throw new Error(`There is no pending Codex ${label}.`);
  throw new Error(`There is more than one pending Codex ${label}; ask which one to answer.`);
}

function canAnswerWithApprovalDecision(request: PendingCodexRequest): boolean {
  return request.kind === "approval" || request.kind === "elicitation" || request.kind === "tool" || request.kind === "auth";
}

function answersForQuestionRequest(
  request: PendingCodexRequest,
  questionId: string | undefined,
  answer: string,
): ToolQuestionAnswer[] {
  const raw = request.raw as { raw?: { params?: { questions?: Array<any> } }; params?: { questions?: Array<any> } };
  const questions = request.questions ?? raw.params?.questions ?? raw.raw?.params?.questions ?? [];
  if (questions.length === 0) {
    if (!questionId) throw new Error("Codex question payload did not include question ids.");
    return [{ questionId, answers: [answer] }];
  }
  if (questionId && !questions.some((question) => question.id === questionId)) {
    throw new Error(`No pending Codex question matched question id ${questionId}.`);
  }
  if (questionId) {
    const question = questions.find((candidate) => candidate.id === questionId);
    return [{ questionId, answers: [answerForQuestion(question, answer)] }];
  }
  if (!questionId && questions.length > 1) {
    throw new Error("There is more than one Codex question; ask which one to answer.");
  }
  return questions.map((question) => ({
    questionId: question.id,
    answers: [answerForQuestion(question, answer)],
  }));
}

function answerForQuestion(
  question: { options?: Array<{ label: string }> | null } | undefined,
  answer: string,
): string {
  const spoken = answer.trim();
  const options = question?.options ?? [];
  const exact = options.find((option) => option.label.toLowerCase() === spoken.toLowerCase());
  return exact?.label ?? spoken;
}

function approvalDecisionMessage(decision: ApprovalDecision): string {
  if (decision === "accept") return "Approved Codex's request.";
  if (decision === "acceptForSession") return "Approved Codex's request for this session.";
  if (decision === "decline") return "Declined Codex's request.";
  return "Cancelled Codex's request.";
}

function summarizePendingRequest(request: PendingCodexRequest): Record<string, unknown> {
  return {
    requestId: request.requestId,
    method: request.method,
    kind: request.kind,
    title: request.title,
    subtitle: request.subtitle,
    body: request.body,
    chat: request.chatName,
    details: request.details,
    questions: request.questions,
  };
}
