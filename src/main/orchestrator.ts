import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import path from "node:path";
import type {
  AppEvent,
  ActiveThreadSummary,
  CodexApprovalPolicy,
  CodexApprovalsReviewer,
  AppState,
  ApprovalDecision,
  CodexActionResult,
  CodexChatRuntime,
  CodexModelSummary,
  CodexPermissionMode,
  VoiceChat,
  CodexSettings,
  CodexSettingsScope,
  CodexSandboxMode,
  CodexServiceTier,
  CodexThreadTokenUsage,
  CodexTurnOutput,
  CodexRuntimeState,
  PendingRequestDetail,
  PendingRequestQuestion,
  PendingRequestQuestionOption,
  PendingCodexRequest,
  RealtimeReasoningEffort,
  ReasoningEffort,
  ThreadArtifactCandidate,
  ThreadProgressItem,
  ThreadSourceCandidate,
  ThreadSummaryItem,
  ThreadSummaryTurn,
  ToolQuestionAnswer,
  VoiceExecCommandArgs,
  VoiceExecCommandResult,
  VoiceWriteStdinArgs,
  VoiceProject,
  VoiceTranscriptMessage,
} from "../shared/types";
import {
  CODEX_PERMISSION_PROFILES,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SERVICE_TIER,
  FAST_CODEX_SERVICE_TIER,
} from "../shared/types";
import { transcriptMessageFromEvent } from "../shared/transcriptMessages";
import { CodexBridge, type CodexJsonMessage } from "./codexBridge";
import { createRealtimeClientSecret, realtimeConfig, saveRealtimeSettings } from "./realtime";
import { ProjectStore } from "./projectStore";

type TurnWaiter = {
  text: string;
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

type ThreadReadResponse = {
  thread?: {
    id?: string;
    turns?: CodexThreadTurn[];
    status?: unknown;
  };
};

type CodexThreadTurn = {
  id?: string;
  status?: string;
  items?: CodexThreadItem[];
  error?: { message?: string } | null;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
  [key: string]: unknown;
};

type CodexThreadItem = {
  type?: string;
  text?: string;
  phase?: string | null;
  status?: string;
  id?: string;
  [key: string]: unknown;
};

type ChatContext = {
  project: VoiceProject;
  chat: VoiceChat;
  recovered?: boolean;
};

const CODEX_VOICE_DEVELOPER_INSTRUCTIONS = [
  "This request came through a local Realtime voice interface.",
  "Codex owns the actual planning, computer use, tool use, browser use, and execution.",
  "For requests that may require controlling desktop apps, use tool_search to discover computer-use before choosing an approach; do this only once per new tool or plugin requested by the user.",
  "If the user's request mentions the Computer Use plugin, satisfy that request by discovering and using the actual computer-use plugin. Do not replace it with shell commands, open -a, AppleScript via terminal, or other terminal workarounds.",
  "Ask for clarification or approval when needed, and keep final status concise enough to relay by voice.",
].join("\n");

type ReviewTarget =
  | { type: "uncommittedChanges" }
  | { type: "baseBranch"; branch: string }
  | { type: "commit"; sha: string; title: string | null }
  | { type: "custom"; instructions: string };

type CommandExecResponse = {
  exitCode?: number;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
};

type VoiceExecSession = {
  sessionId: number;
  processId: string;
  output: string;
  readOffset: number;
  startedAt: number;
  completedAt: number | null;
  exitCode: number | null;
  error: Error | null;
  done: Promise<void>;
};

type VoiceToolContext = {
  project: VoiceProject | null;
  chat: VoiceChat | null;
  permissionMode: CodexPermissionMode;
  permissionProfile: unknown | null;
};

export class VoiceCodexOrchestrator extends EventEmitter {
  private activeProjectId: string | null = null;
  private showProjectChatsFlag = false;
  private nextTurnModel: string | null = null;
  private nextTurnReasoningEffort: ReasoningEffort | null = null;
  private nextTurnServiceTier: CodexServiceTier | null = null;
  private nextTurnPermissionMode: CodexPermissionMode | null = null;
  private defaultModel: string | null = DEFAULT_CODEX_MODEL;
  private defaultReasoningEffort: ReasoningEffort | null = DEFAULT_CODEX_REASONING_EFFORT;
  private defaultServiceTier: CodexServiceTier | null = DEFAULT_CODEX_SERVICE_TIER;
  private defaultPermissionMode: CodexPermissionMode = DEFAULT_CODEX_PERMISSION_MODE;
  private models: CodexModelSummary[] = [];
  private status = "Starting Codex app-server.";
  private pendingRequests = new Map<string, PendingCodexRequest>();
  private turnWaiters = new Map<string, TurnWaiter>();
  private activeTurnByThread = new Map<string, string>();
  private activeTurnModelByThread = new Map<string, string | null>();
  private activeTurnReasoningEffortByThread = new Map<string, ReasoningEffort | null>();
  private activeTurnServiceTierByThread = new Map<string, CodexServiceTier | null>();
  private activeTurnPermissionModeByThread = new Map<string, CodexPermissionMode | null>();
  private threadByTurn = new Map<string, string>();
  private tokenUsageByThread = new Map<string, CodexThreadTokenUsage>();
  private threadStatusByThread = new Map<string, string>();
  private voiceExecNextSessionId = 1;
  private voiceExecNextProcessId = 1;
  private voiceExecSessions = new Map<number, VoiceExecSession>();
  private voiceExecSessionByProcessId = new Map<string, VoiceExecSession>();

  constructor(
    private readonly store: ProjectStore,
    private readonly codex: CodexBridge,
  ) {
    super();
    this.codex.on("notification", (message) => this.handleNotification(message as CodexJsonMessage));
    this.codex.on("serverRequest", (message) => this.handleServerRequest(message as CodexJsonMessage));
    this.codex.on("stderr", (text) => this.emitEvent("codex", "stderr", text));
    this.codex.on("exit", (info) => {
      this.status = "Codex app-server exited.";
      this.emitEvent("codex", "exit", `Codex app-server exited: ${JSON.stringify(info)}`, info);
      this.emitState();
    });
  }

  async initialize(): Promise<void> {
    await this.store.ensureReady();
    await this.codex.start();
    await this.refreshModels();
    this.status = "Ready.";
    this.emitEvent("app", "ready", "Codex app-server is ready.");
    this.emitState();
  }

  shutdown(): void {
    this.codex.stop();
  }

  async state(): Promise<AppState> {
    const projects = await this.store.listProjects();
    const archivedProjects = await this.store.listArchivedProjects();
    let activeProject = this.activeProjectId
      ? projects.find((project) => project.id === this.activeProjectId) ?? null
      : null;
    if (this.activeProjectId && !activeProject) {
      this.activeProjectId = null;
      this.showProjectChatsFlag = false;
      activeProject = null;
    }
    return {
      baseFolder: this.store.baseFolder,
      projects,
      archivedProjects,
      activeProject,
      runtime: this.runtimeState(activeProject, projects),
      codexSettings: this.codexSettings(activeProject),
      realtime: realtimeConfig(),
    };
  }

  async createProject(name?: string, workspacePath?: string | null): Promise<VoiceProject> {
    const resolvedWorkspacePath = await resolveWorkspacePathInput(workspacePath);
    const project = await this.store.createProject(name, resolvedWorkspacePath);
    this.activeProjectId = project.id;
    this.showProjectChatsFlag = false;
    this.status = `Active project: ${project.displayName}`;
    this.emitEvent("app", "projectCreated", `Created project "${project.displayName}".`, project);
    this.emitState();
    return project;
  }

  async setWorkspaceFolder(workspacePath?: string | null, name?: string | null): Promise<VoiceProject> {
    const resolvedWorkspacePath = await resolveWorkspacePathInput(workspacePath);
    if (!resolvedWorkspacePath) throw new Error("No workspace folder selected.");

    const activeProject = await this.getActiveProject();
    const projects = await this.store.listProjects();
    const existing = projects.find((project) => samePath(projectWorkspacePath(project), resolvedWorkspacePath));
    if (existing && existing.id !== activeProject?.id) {
      this.activeProjectId = existing.id;
      this.showProjectChatsFlag = false;
      this.status = `Active project: ${existing.displayName}`;
      this.emitEvent("app", "workspaceSelected", `Selected workspace "${existing.displayName}".`, existing);
      this.emitState();
      return existing;
    }

    if (!activeProject) {
      return this.createProject(name || path.basename(resolvedWorkspacePath) || undefined, resolvedWorkspacePath);
    }

    const updated = await this.store.updateProject(activeProject.id, {
      workspacePath: resolvedWorkspacePath,
      lastStatus: `Workspace: ${resolvedWorkspacePath}`,
    });
    this.activeProjectId = updated.id;
    this.showProjectChatsFlag = false;
    this.status = `Workspace selected: ${resolvedWorkspacePath}`;
    this.emitEvent("app", "workspaceSelected", `Selected workspace "${resolvedWorkspacePath}".`, updated);
    this.emitState();
    return updated;
  }

  async resumeProject(projectId: string): Promise<VoiceProject> {
    let project = await this.store.getProject(projectId);
    if (!project) throw new Error(`Unknown project: ${projectId}`);
    let chat = activeChatForProject(project);
    if (!chat) {
      this.activeProjectId = project.id;
      this.showProjectChatsFlag = false;
      this.status = `Resumed project: ${project.displayName}`;
      this.emitEvent("app", "projectResumed", `Resumed project "${project.displayName}".`, project);
      this.emitState();
      return project;
    }

    const resumed = await this.resumeChatThread(project, chat);

    const updated = await this.store.updateProject(resumed.project.id, {
      activeChatId: resumed.chat.id,
      codexThreadId: resumed.chat.codexThreadId,
      lastStatus: resumed.recovered ? "Started a fresh Codex thread." : "Codex thread resumed.",
    });
    this.activeProjectId = updated.id;
    this.showProjectChatsFlag = false;
    this.status = resumed.recovered
      ? `Recovered project chat: ${resumed.chat.displayName}`
      : `Resumed project: ${updated.displayName}`;
    this.emitEvent("app", "projectResumed", `Resumed project "${updated.displayName}".`, updated);
    this.emitState();
    return updated;
  }

  async archiveProject(projectId: string): Promise<VoiceProject> {
    const updated = await this.store.archiveProject(projectId);
    if (this.activeProjectId === projectId) {
      this.activeProjectId = null;
      this.showProjectChatsFlag = false;
    }
    this.status = `Archived project: ${updated.displayName}`;
    this.emitEvent("app", "projectArchived", this.status, updated);
    this.emitState();
    return updated;
  }

  async restoreProject(projectId: string): Promise<VoiceProject> {
    const updated = await this.store.restoreProject(projectId);
    this.status = `Restored project: ${updated.displayName}`;
    this.emitEvent("app", "projectRestored", this.status, updated);
    this.emitState();
    return updated;
  }

  async createChat(name: string, projectId?: string): Promise<VoiceProject> {
    const displayName = name.trim();
    if (!displayName) throw new Error("Chat name is required.");
    const project = await this.requireProject(projectId);
    const updated = await this.startChatThread(project, displayName);
    this.activeProjectId = updated.id;
    this.showProjectChatsFlag = true;
    this.status = `Active chat: ${displayName}`;
    this.emitEvent("app", "chatCreated", `Created chat "${displayName}".`, activeChatForProject(updated));
    this.emitState();
    return updated;
  }

  async switchChat(chatId: string, projectId?: string): Promise<VoiceProject> {
    const project = projectId ? await this.requireProject(projectId) : await this.requireProjectForChat(chatId);
    const chat = project.chats.find((candidate) => candidate.id === chatId);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);
    if (!chat.codexThreadId) throw new Error(`Chat "${chat.displayName}" does not have a Codex thread id.`);

    const resumed = await this.resumeChatThread(project, chat);

    const updated = await this.store.setActiveChat(resumed.project.id, resumed.chat.id);
    this.activeProjectId = updated.id;
    this.showProjectChatsFlag = true;
    this.status = resumed.recovered
      ? `Recovered and switched to chat: ${resumed.chat.displayName}`
      : `Active chat: ${resumed.chat.displayName}`;
    this.emitEvent("app", "chatSwitched", `Switched to chat "${resumed.chat.displayName}".`, resumed.chat);
    this.emitState();
    return updated;
  }

  async archiveChat(chatId: string, projectId?: string): Promise<VoiceProject> {
    const project = projectId ? await this.requireProject(projectId) : await this.requireProjectForChat(chatId);
    const chat = project.chats.find((candidate) => candidate.id === chatId && !candidate.archivedAt);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);

    const updated = await this.store.archiveChat(project.id, chat.id);
    if (this.activeProjectId === project.id) {
      this.activeProjectId = updated.id;
      this.showProjectChatsFlag = Boolean(updated.activeChatId);
    }
    this.status = `Archived chat: ${chat.displayName}`;
    this.emitEvent("app", "chatArchived", this.status, { projectId: project.id, chatId: chat.id });
    this.emitState();
    return updated;
  }

  async restoreChat(chatId: string, projectId?: string): Promise<VoiceProject> {
    const project = projectId
      ? await this.store.getProject(projectId, { includeArchived: true })
      : await this.findProjectForChat(chatId, true);
    if (!project) throw new Error(`Unknown chat: ${chatId}`);
    const chat = project.chats.find((candidate) => candidate.id === chatId);
    if (!chat) throw new Error(`Unknown chat: ${chatId}`);

    const updated = await this.store.restoreChat(project.id, chat.id);
    this.status = `Restored chat: ${chat.displayName}`;
    this.emitEvent("app", "chatRestored", this.status, { projectId: project.id, chatId: chat.id });
    this.emitState();
    return updated;
  }

  async listChats(projectId?: string): Promise<VoiceChat[]> {
    const project = await this.requireProject(projectId);
    return project.chats.filter((chat) => !chat.archivedAt);
  }

  async showProjectChats(open = true): Promise<void> {
    this.showProjectChatsFlag = open;
    this.status = open ? "Showing open chats." : "Hiding open chats.";
    this.emitEvent("app", "showProjectChats", this.status, { open });
    this.emitState();
  }

  async sendToCodex(text: string, chatId?: string, workspacePath?: string | null): Promise<CodexActionResult> {
    const trimmed = text.trim();
    if (!trimmed) throw new Error("Cannot send an empty request to Codex.");

    if (trimmed.startsWith("/")) {
      return this.handleNativeSlashCommand(trimmed);
    }

    const resolvedWorkspacePath = workspacePath?.trim()
      ? await resolveWorkspacePathInput(workspacePath)
      : await inferWorkspacePathFromText(trimmed);
    let context: ChatContext;
    if (resolvedWorkspacePath && !chatId) {
      const project = await this.projectForWorkspace(titleFromText(trimmed), resolvedWorkspacePath);
      const chat = activeChatForProject(project);
      const updated = chat ? project : await this.startChatThread(project, titleFromText(trimmed));
      context = this.requireActiveChatContextFromProject(updated);
    } else if (!this.activeProjectId && !chatId) {
      const project = await this.createProject(titleFromText(trimmed));
      const updated = await this.startChatThread(project, titleFromText(trimmed));
      context = this.requireActiveChatContextFromProject(updated);
    } else {
      context = await this.requireChatContextForPrompt(trimmed, chatId);
    }
    const { project, chat } = await this.resumeChatThread(context.project, context.chat);
    if (!chat.codexThreadId) throw new Error("Active chat is missing a Codex thread id.");

    const turnSettings = this.resolveTurnSettings(project, chat);
    const cwd = projectWorkspacePath(project);
    const result = (await this.codex.request("turn/start", {
      threadId: chat.codexThreadId,
      cwd,
      ...turnPermissionParams(turnSettings.permissionMode),
      personality: "friendly",
      ...(turnSettings.model ? { model: turnSettings.model } : {}),
      ...(turnSettings.serviceTier ? { serviceTier: turnSettings.serviceTier } : {}),
      ...(turnSettings.reasoningEffort ? { effort: turnSettings.reasoningEffort } : {}),
      input: [
        {
          type: "text",
          text: codexTurnText(trimmed),
          text_elements: [],
        },
      ],
    })) as { turn?: { id?: string } };

    const turnId = result.turn?.id;
    if (!turnId) throw new Error("Codex did not return a turn id.");

    this.activeTurnByThread.set(chat.codexThreadId, turnId);
    this.threadByTurn.set(turnId, chat.codexThreadId);
    this.activeTurnModelByThread.set(chat.codexThreadId, turnSettings.model);
    this.activeTurnReasoningEffortByThread.set(chat.codexThreadId, turnSettings.reasoningEffort);
    this.activeTurnServiceTierByThread.set(chat.codexThreadId, turnSettings.serviceTier);
    this.activeTurnPermissionModeByThread.set(chat.codexThreadId, turnSettings.permissionMode);
    this.nextTurnModel = null;
    this.nextTurnReasoningEffort = null;
    this.nextTurnServiceTier = null;
    this.nextTurnPermissionMode = null;
    this.status = `${chat.displayName}: Codex is working.`;
    const updated = await this.store.updateChat(project.id, chat.id, {
      lastStatus: "Codex is working.",
    });
    this.emitEvent("app", "turnStarted", `Sent request to "${chat.displayName}".`, { turnId, chatId: chat.id, text: trimmed });
    this.emitState();
    return {
      kind: "turn",
      message: `Codex started with ${this.describeModelEffort(
        turnSettings.model,
        turnSettings.reasoningEffort,
        turnSettings.serviceTier,
      )}.`,
      turnId,
      project: updated,
      chat: updated.chats.find((candidate) => candidate.id === chat.id) ?? null,
    };
  }

  async steerCodex(text: string, chatId?: string): Promise<{ turnId: string }> {
    const { project, chat } = await this.requireChatContext(chatId);
    const threadId = chat.codexThreadId;
    const turnId = threadId ? this.activeTurnByThread.get(threadId) ?? null : null;
    if (!threadId || !turnId) {
      throw new Error("There is no active Codex turn to steer.");
    }
    await this.codex.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: [
        {
          type: "text",
          text: text.trim(),
          text_elements: [],
        },
      ],
    });
    await this.store.updateChat(project.id, chat.id, { lastStatus: "Steered active turn." });
    this.status = `Steered "${chat.displayName}".`;
    this.emitEvent("app", "turnSteered", `Steered "${chat.displayName}".`, { text, chatId: chat.id });
    this.emitState();
    return { turnId };
  }

  async interruptCodex(chatId?: string): Promise<void> {
    const { project, chat } = await this.requireChatContext(chatId);
    const threadId = chat.codexThreadId;
    const turnId = threadId ? this.activeTurnByThread.get(threadId) ?? null : null;
    if (!threadId || !turnId) {
      throw new Error("There is no active Codex turn to interrupt.");
    }
    await this.codex.request("turn/interrupt", {
      threadId,
      turnId,
    });
    await this.store.updateChat(project.id, chat.id, { lastStatus: "Requested Codex interruption." });
    this.status = `Requested interruption for "${chat.displayName}".`;
    this.emitEvent("app", "turnInterrupted", this.status, { chatId: chat.id, turnId });
    this.emitState();
  }

  async summarizeProject(projectId?: string, chatId?: string): Promise<string> {
    const target =
      (projectId ? await this.store.getProject(projectId) : null) ??
      (this.activeProjectId ? await this.store.getProject(this.activeProjectId) : null) ??
      (await this.store.getMostRecentProject());
    if (!target) throw new Error("No recent projects are available to summarize.");

    const chat = chatId
      ? target.chats.find((candidate) => candidate.id === chatId && !candidate.archivedAt) ?? null
      : activeChatForProject(target) ?? target.chats.find((candidate) => !candidate.archivedAt) ?? null;
    if (chatId && !chat) throw new Error(`Unknown chat for project "${target.displayName}": ${chatId}`);
    if (!chat?.codexThreadId) throw new Error("Project is missing a Codex chat thread id.");
    const resumed = await this.resumeChatThread(target, chat);
    const resumedThreadId = resumed.chat.codexThreadId;
    if (!resumedThreadId) throw new Error("Project is missing a Codex chat thread id.");

    const turnSettings = this.resolveTurnSettings(resumed.project, resumed.chat);
    const result = (await this.codex.request("turn/start", {
      threadId: resumedThreadId,
      cwd: projectWorkspacePath(resumed.project),
      ...turnPermissionParams(turnSettings.permissionMode),
      personality: "friendly",
      ...(turnSettings.model ? { model: turnSettings.model } : {}),
      ...(turnSettings.serviceTier ? { serviceTier: turnSettings.serviceTier } : {}),
      ...(turnSettings.reasoningEffort ? { effort: turnSettings.reasoningEffort } : {}),
      input: [
        {
          type: "text",
          text:
            "Please summarize this Codex voice project for the user in 4-6 concise bullets. Focus on what the user was trying to do, what Codex changed or found, current status, and useful next steps. Do not invent context.",
          text_elements: [],
        },
      ],
    })) as { turn?: { id?: string } };

    const turnId = result.turn?.id;
    if (!turnId) throw new Error("Codex did not return a summary turn id.");
    this.activeTurnByThread.set(resumedThreadId, turnId);
    this.threadByTurn.set(turnId, resumedThreadId);
    this.activeTurnModelByThread.set(resumedThreadId, turnSettings.model);
    this.activeTurnReasoningEffortByThread.set(resumedThreadId, turnSettings.reasoningEffort);
    this.activeTurnServiceTierByThread.set(resumedThreadId, turnSettings.serviceTier);
    this.activeTurnPermissionModeByThread.set(resumedThreadId, turnSettings.permissionMode);
    this.nextTurnModel = null;
    this.nextTurnReasoningEffort = null;
    this.nextTurnServiceTier = null;
    this.nextTurnPermissionMode = null;
    this.status = `Codex is summarizing "${resumed.chat.displayName}".`;
    this.emitEvent("app", "summaryStarted", `Summarizing "${resumed.chat.displayName}".`, {
      turnId,
      chatId: resumed.chat.id,
    });
    this.emitState();

    const summary = await this.waitForTurnText(turnId);
    await this.store.updateChat(resumed.project.id, resumed.chat.id, {
      lastSummary: summary,
      lastStatus: "Chat summarized.",
    });
    this.emitEvent("app", "summaryCompleted", "Codex summarized the project.", { summary });
    this.emitState();
    return summary;
  }

  async answerApproval(requestId: string | number, decision: ApprovalDecision): Promise<void> {
    const request = this.pendingRequests.get(String(requestId));
    if (!request) throw new Error(`Unknown pending request: ${requestId}`);

    const response = await this.responseForDecision(request, decision);
    if (response.kind === "error") {
      this.codex.rejectRequest(requestId, response.message);
    } else {
      this.codex.respond(requestId, response.result);
    }
    this.pendingRequests.delete(String(requestId));
    this.status = `Answered ${request.title}: ${decision}`;
    if (request.threadId) {
      this.updateChatForThread(request.threadId, { lastStatus: `Answered ${request.title}: ${decision}` });
    }
    this.emitEvent("app", "approvalAnswered", `Answered ${request.title}: ${decision}`, {
      requestId,
      decision,
    });
    this.emitState();
  }

  private async responseForDecision(
    request: PendingCodexRequest,
    decision: ApprovalDecision,
  ): Promise<ServerRequestResponse> {
    if (request.method === "item/tool/call") {
      return this.responseForDynamicToolCall(request, decision);
    }
    if (request.method === "account/chatgptAuthTokens/refresh" && isAcceptDecision(decision)) {
      return this.responseForChatgptAuthRefresh(request);
    }
    return responseForDecision(request, decision);
  }

  private async responseForDynamicToolCall(
    request: PendingCodexRequest,
    decision: ApprovalDecision,
  ): Promise<ServerRequestResponse> {
    if (!isAcceptDecision(decision)) {
      return {
        kind: "result",
        result: {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: `User ${decision === "cancel" ? "cancelled" : "declined"} the requested tool call.`,
            },
          ],
        },
      };
    }

    const params = request.raw as {
      params?: {
        threadId?: unknown;
        namespace?: unknown;
        tool?: unknown;
        arguments?: unknown;
      };
    };
    const threadId = stringField(params.params?.threadId);
    const server = stringField(params.params?.namespace);
    const tool = stringField(params.params?.tool);

    if (!threadId || !server || !tool) {
      return {
        kind: "result",
        result: {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: "The app-server tool call did not include enough MCP routing information to run it.",
            },
          ],
        },
      };
    }

    try {
      const result = await this.codex.request("mcpServer/tool/call", {
        threadId,
        server,
        tool,
        ...(params.params?.arguments !== undefined ? { arguments: params.params.arguments } : {}),
      });
      return dynamicToolResponseFromMcpResult(result);
    } catch (error) {
      return {
        kind: "result",
        result: {
          success: false,
          contentItems: [
            {
              type: "inputText",
              text: `MCP tool call failed: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
        },
      };
    }
  }

  private async responseForChatgptAuthRefresh(request: PendingCodexRequest): Promise<ServerRequestResponse> {
    const params = request.raw as { params?: { previousAccountId?: unknown } };
    const previousAccountId = stringField(params.params?.previousAccountId);

    try {
      const authStatus = (await this.codex.request("getAuthStatus", {
        includeToken: true,
        refreshToken: true,
      })) as { authToken?: string | null };
      const accountResponse = (await this.codex.request("account/read", {
        refreshToken: true,
      })) as { account?: { type?: string; planType?: string | null } | null };
      const token = stringField(authStatus.authToken);
      if (!token || !previousAccountId) {
        return responseForDecision(request, "decline");
      }
      return {
        kind: "result",
        result: {
          accessToken: token,
          chatgptAccountId: previousAccountId,
          chatgptPlanType:
            accountResponse.account?.type === "chatgpt" ? accountResponse.account.planType ?? null : null,
        },
      };
    } catch {
      return responseForDecision(request, "decline");
    }
  }

  async answerToolQuestion(requestId: string | number, answers: ToolQuestionAnswer[]): Promise<void> {
    const request = this.pendingRequests.get(String(requestId));
    if (!request) throw new Error(`Unknown pending request: ${requestId}`);
    if (request.method !== "item/tool/requestUserInput") {
      throw new Error(`Pending request ${requestId} is not a Codex question.`);
    }
    const normalizedAnswers = normalizeToolQuestionAnswers(request, answers);
    const result = {
      answers: Object.fromEntries(
        normalizedAnswers.map((answer) => [answer.questionId, { answers: answer.answers }]),
      ),
    };
    this.codex.respond(requestId, result);
    this.pendingRequests.delete(String(requestId));
    this.status = "Answered Codex question.";
    if (request.threadId) {
      this.updateChatForThread(request.threadId, { lastStatus: "Answered Codex question." });
    }
    this.emitEvent("app", "questionAnswered", "Answered a Codex question.", {
      requestId,
      answers: normalizedAnswers,
    });
    this.emitState();
  }

  async execCommandForVoice(args: VoiceExecCommandArgs): Promise<VoiceExecCommandResult> {
    const command = commandVectorFromVoiceArgs(args);
    return this.runVoiceCommand(command, args);
  }

  async writeStdinForVoice(args: VoiceWriteStdinArgs): Promise<VoiceExecCommandResult> {
    const session = this.voiceExecSessions.get(args.session_id);
    if (!session) throw new Error(`Unknown exec_command session: ${args.session_id}`);

    const startedAt = Date.now();
    const chars = args.chars ?? "";
    if (chars && session.completedAt) {
      throw new Error(`exec_command session ${args.session_id} is no longer running.`);
    }
    if (chars) {
      await this.codex.request("command/exec/write", {
        processId: session.processId,
        deltaBase64: Buffer.from(chars).toString("base64"),
      });
    }

    await waitForVoiceSession(session, normalizeYieldMs(args.yield_time_ms));
    return formatVoiceExecResult(session, startedAt, args.max_output_tokens, true);
  }

  async terminateVoiceExecSession(sessionId: number): Promise<void> {
    const session = this.voiceExecSessions.get(sessionId);
    if (!session || session.completedAt) return;
    await this.codex.request("command/exec/terminate", {
      processId: session.processId,
    });
    await waitForVoiceSession(session, 500);
    this.emitEvent("app", "voiceExecTerminated", `Terminated voice exec session ${sessionId}.`, {
      sessionId,
      processId: session.processId,
    });
    this.emitState();
  }

  async applyPatchForVoice(input: string): Promise<VoiceExecCommandResult> {
    if (!input.trim()) throw new Error("apply_patch input is required.");
    return this.runVoiceCommand(["apply_patch", input], {
      cmd: "apply_patch",
      yield_time_ms: 1_000,
      max_output_tokens: 6_000,
    });
  }

  async getChatStatus(chatId?: string): Promise<CodexChatRuntime[]> {
    const project = chatId ? await this.requireProjectForChat(chatId) : await this.requireProject();
    const runtimes = this.chatRuntimeStates(project);
    return chatId ? runtimes.filter((runtime) => runtime.chatId === chatId) : runtimes;
  }

  async getActiveThreadSummary(chatId?: string): Promise<ActiveThreadSummary> {
    let project: VoiceProject | null = null;
    let chat: VoiceChat | null = null;
    try {
      project = chatId ? await this.requireProjectForChat(chatId) : await this.getActiveProject();
      chat = project
        ? chatId
          ? project.chats.find((candidate) => candidate.id === chatId && !candidate.archivedAt) ?? null
          : activeChatForProject(project)
        : null;
    } catch (error) {
      return emptyActiveThreadSummary({
        status: "error",
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }

    if (!project) {
      return emptyActiveThreadSummary({
        status: "empty",
        errorMessage: "No active project.",
      });
    }
    if (!chat) {
      return emptyActiveThreadSummary({
        status: "empty",
        project,
        errorMessage: "No active chat.",
      });
    }
    if (!chat.codexThreadId) {
      return emptyActiveThreadSummary({
        status: "empty",
        project,
        chat,
        errorMessage: "Active chat does not have a Codex thread yet.",
      });
    }

    try {
      const response = (await this.codex.request("thread/read", {
        threadId: chat.codexThreadId,
        includeTurns: true,
      })) as ThreadReadResponse;
      return activeThreadSummaryFromRead(project, chat, response);
    } catch (error) {
      return emptyActiveThreadSummary({
        status: "error",
        project,
        chat,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getTranscriptMessages(chatId?: string): Promise<VoiceTranscriptMessage[]> {
    const project = chatId ? await this.requireProjectForChat(chatId) : await this.getActiveProject();
    const chat = project
      ? chatId
        ? project.chats.find((candidate) => candidate.id === chatId && !candidate.archivedAt) ?? null
        : activeChatForProject(project)
      : null;
    if (!project || !chat) return [];
    return this.store.listTranscriptMessages(project.id, chat.id);
  }

  async recordTranscriptEvent(event: AppEvent): Promise<void> {
    const message = transcriptMessageFromEvent(event);
    if (!message) return;
    const project = await this.requireProjectForChat(message.chatId);
    await this.store.upsertTranscriptMessage(project.id, message.chatId, message);
  }

  async setCodexSettings(
    settings: {
      model?: string | null;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
      permissionMode?: CodexPermissionMode | null;
    },
    scope: CodexSettingsScope,
  ): Promise<CodexSettings> {
    if (settings.model !== undefined && settings.model !== null) {
      this.assertKnownModel(settings.model);
    }
    if (settings.reasoningEffort !== undefined && settings.reasoningEffort !== null) {
      this.assertReasoningEffort(settings.reasoningEffort);
    }
    if (settings.serviceTier !== undefined && settings.serviceTier !== null) {
      this.assertServiceTier(settings.serviceTier, settings.model);
    }
    if (settings.permissionMode !== undefined && settings.permissionMode !== null) {
      this.assertPermissionMode(settings.permissionMode);
    }

    if (scope === "nextTurn") {
      if (settings.model !== undefined) this.nextTurnModel = settings.model;
      if (settings.reasoningEffort !== undefined) {
        this.nextTurnReasoningEffort = settings.reasoningEffort;
      }
      if (settings.serviceTier !== undefined) this.nextTurnServiceTier = settings.serviceTier;
      if (settings.permissionMode !== undefined) this.nextTurnPermissionMode = settings.permissionMode;
      this.status = `Updated next-turn Codex settings: ${this.describeModelEffort(
        this.nextTurnModel,
        this.nextTurnReasoningEffort,
        this.nextTurnServiceTier,
      )}, ${this.describePermissions(this.nextTurnPermissionMode ?? DEFAULT_CODEX_PERMISSION_MODE)}.`;
      this.emitEvent("app", "settingsChanged", this.status);
      this.emitState();
      return this.codexSettings(await this.getActiveProject());
    }

    const project = await this.requireProject();
    const chat = activeChatForProject(project);
    if (!chat) {
      const updated = await this.store.updateProject(project.id, {
        ...(settings.model !== undefined ? { model: settings.model } : {}),
        ...(settings.reasoningEffort !== undefined
          ? { reasoningEffort: settings.reasoningEffort }
          : {}),
        ...(settings.serviceTier !== undefined ? { serviceTier: settings.serviceTier } : {}),
        ...(settings.permissionMode !== undefined
          ? { permissionMode: settings.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE }
          : {}),
        lastStatus: "Updated Codex settings.",
      });
      this.status = `Updated project Codex settings: ${this.describeModelEffort(
        updated.model,
        updated.reasoningEffort,
        updated.serviceTier,
      )}, ${this.describePermissions(updated.permissionMode)}.`;
      this.emitEvent("app", "settingsChanged", this.status, updated);
      this.emitState();
      return this.codexSettings(updated);
    }

    const updated = await this.store.updateChat(project.id, chat.id, {
      ...(settings.model !== undefined ? { model: settings.model } : {}),
      ...(settings.reasoningEffort !== undefined
        ? { reasoningEffort: settings.reasoningEffort }
        : {}),
      ...(settings.serviceTier !== undefined ? { serviceTier: settings.serviceTier } : {}),
      ...(settings.permissionMode !== undefined
        ? { permissionMode: settings.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE }
        : {}),
      lastStatus: "Updated Codex settings.",
    });
    const updatedChat = updated.chats.find((candidate) => candidate.id === chat.id) ?? chat;
    this.status = `Updated chat Codex settings: ${this.describeModelEffort(
      updatedChat.model,
      updatedChat.reasoningEffort,
      updatedChat.serviceTier,
    )}, ${this.describePermissions(updatedChat.permissionMode)}.`;
    this.emitEvent("app", "settingsChanged", this.status, updated);
    this.emitState();
    return this.codexSettings(updated);
  }

  createRealtimeClientSecret = createRealtimeClientSecret;

  async setRealtimeSettings(settings: {
    model?: AppState["realtime"]["model"] | null;
    voice?: AppState["realtime"]["voice"] | null;
    reasoningEffort?: RealtimeReasoningEffort | null;
  }): Promise<AppState["realtime"]> {
    const config = saveRealtimeSettings(settings);
    this.status = `Updated Realtime voice: ${config.model}, ${config.voice}, reasoning ${
      config.reasoningEffort ?? "none"
    }.`;
    this.emitEvent("app", "settingsChanged", this.status, config);
    this.emitState();
    return config;
  }

  private async runVoiceCommand(
    command: string[],
    args: VoiceExecCommandArgs,
  ): Promise<VoiceExecCommandResult> {
    if (command.length === 0) throw new Error("exec_command command must not be empty.");

    const startedAt = Date.now();
    const context = await this.resolveVoiceToolContext();
    const cwd = resolveVoiceWorkdir(args.workdir, context.project ? projectWorkspacePath(context.project) : null);
    const processId = `voice-exec-${Date.now()}-${this.voiceExecNextProcessId++}`;
    const sessionId = this.voiceExecNextSessionId++;
    const session: VoiceExecSession = {
      sessionId,
      processId,
      output: "",
      readOffset: 0,
      startedAt,
      completedAt: null,
      exitCode: null,
      error: null,
      done: Promise.resolve(),
    };

    this.voiceExecSessions.set(sessionId, session);
    this.voiceExecSessionByProcessId.set(processId, session);
    const request = this.codex.request(
      "command/exec",
      {
        command,
        processId,
        tty: Boolean(args.tty),
        streamStdin: true,
        streamStdoutStderr: true,
        cwd,
        ...(context.permissionProfile ? { permissionProfile: context.permissionProfile } : {}),
      },
      60 * 60 * 1_000,
    ) as Promise<CommandExecResponse>;

    session.done = request
      .then((response) => {
        session.exitCode = numberField(response.exitCode) ?? numberField(response.exit_code) ?? null;
        if (response.stdout) session.output += response.stdout;
        if (response.stderr) session.output += response.stderr;
      })
      .catch((error) => {
        session.error = error instanceof Error ? error : new Error(String(error));
      })
      .finally(() => {
        session.completedAt = Date.now();
        const cleanupTimer = setTimeout(() => {
          this.voiceExecSessions.delete(session.sessionId);
          this.voiceExecSessionByProcessId.delete(session.processId);
        }, 10 * 60 * 1_000);
        if (typeof cleanupTimer === "object" && "unref" in cleanupTimer) {
          cleanupTimer.unref();
        }
      });

    await waitForVoiceSession(session, normalizeYieldMs(args.yield_time_ms));
    return formatVoiceExecResult(session, startedAt, args.max_output_tokens, true);
  }

  private async resolveVoiceToolContext(): Promise<VoiceToolContext> {
    const project = await this.getActiveProject();
    const chat = project ? activeChatForProject(project) : null;
    const settings = project
      ? this.threadSettingsForChat(project, chat)
      : {
          model: this.defaultModel,
          reasoningEffort: this.defaultReasoningEffort,
          permissionMode: this.defaultPermissionMode,
        };
    return {
      project,
      chat,
      permissionMode: settings.permissionMode,
      permissionProfile: voicePermissionProfile(
        settings.permissionMode,
        project ? projectWorkspacePath(project) : null,
      ),
    };
  }

  private async getActiveProject(): Promise<VoiceProject | null> {
    return this.activeProjectId ? this.store.getProject(this.activeProjectId) : null;
  }

  private async requireProject(projectId?: string): Promise<VoiceProject> {
    const id = projectId ?? this.activeProjectId;
    if (!id) throw new Error("No active Codex project.");
    const project = await this.store.getProject(id);
    if (!project) throw new Error(`Unknown voice project: ${id}`);
    return project;
  }

  private async requireProjectForChat(chatId: string): Promise<VoiceProject> {
    const project = await this.findProjectForChat(chatId, false);
    if (!project) throw new Error(`Unknown chat: ${chatId}`);
    return project;
  }

  private async findProjectForChat(chatId: string, includeArchived: boolean): Promise<VoiceProject | null> {
    const projects = await this.store.listProjects({ includeArchived });
    return (
      projects.find((candidate) =>
        candidate.chats.some((chat) => chat.id === chatId && (includeArchived || !chat.archivedAt)),
      ) ?? null
    );
  }

  private async projectForWorkspace(displayName: string, workspacePath: string): Promise<VoiceProject> {
    const projects = await this.store.listProjects();
    const existing = projects.find((project) => samePath(projectWorkspacePath(project), workspacePath));
    if (existing) {
      this.activeProjectId = existing.id;
      return existing;
    }
    return this.createProject(displayName, workspacePath);
  }

  private async requireActiveProject(): Promise<VoiceProject> {
    return this.requireProject();
  }

  private async requireChatContext(chatId?: string): Promise<ChatContext> {
    if (chatId) {
      const project = await this.requireProjectForChat(chatId);
      const chat = project.chats.find((candidate) => candidate.id === chatId && !candidate.archivedAt);
      if (!chat) throw new Error(`Unknown chat: ${chatId}`);
      return { project, chat };
    }

    const project = await this.requireProject();
    const chat = activeChatForProject(project);
    if (!chat) throw new Error("Active project does not have an active chat.");
    return { project, chat };
  }

  private async requireChatContextForPrompt(text: string, chatId?: string): Promise<ChatContext> {
    if (chatId) return this.requireChatContext(chatId);

    let project = await this.requireProject();
    let chat = activeChatForProject(project);
    if (!chat) {
      project = await this.startChatThread(project, titleFromText(text));
      chat = activeChatForProject(project);
    }
    if (!chat) throw new Error("Active project does not have an active chat.");
    return { project, chat };
  }

  private requireActiveChatContextFromProject(project: VoiceProject): ChatContext {
    const chat = activeChatForProject(project);
    if (!chat) throw new Error("Project does not have an active chat.");
    return { project, chat };
  }

  private async resumeChatThread(project: VoiceProject, chat: VoiceChat): Promise<ChatContext> {
    if (!chat.codexThreadId) {
      throw new Error(`Chat "${chat.displayName}" does not have a Codex thread id.`);
    }
    const chatSettings = this.threadSettingsForChat(project, chat);

    try {
      await this.codex.request("thread/resume", {
        threadId: chat.codexThreadId,
        cwd: projectWorkspacePath(project),
        ...threadPermissionParams(chatSettings.permissionMode),
        developerInstructions: CODEX_VOICE_DEVELOPER_INSTRUCTIONS,
        personality: "friendly",
        excludeTurns: true,
        ...(chatSettings.model ? { model: chatSettings.model } : {}),
        ...(chatSettings.serviceTier ? { serviceTier: chatSettings.serviceTier } : {}),
      });
      await this.syncThreadName(chat.codexThreadId, chat.displayName);
      return { project, chat };
    } catch (error) {
      if (!isMissingCodexThreadError(error)) throw error;
    }

    const result = (await this.codex.request("thread/start", {
      cwd: projectWorkspacePath(project),
      ...(chatSettings.model ? { model: chatSettings.model } : {}),
      ...(chatSettings.serviceTier ? { serviceTier: chatSettings.serviceTier } : {}),
      ...threadPermissionParams(chatSettings.permissionMode),
      developerInstructions: CODEX_VOICE_DEVELOPER_INSTRUCTIONS,
      personality: "friendly",
      serviceName: "codex_voice",
    })) as { thread?: { id?: string } };

    const codexThreadId = result.thread?.id;
    if (!codexThreadId) throw new Error("Codex did not return a replacement thread id.");
    await this.syncThreadName(codexThreadId, chat.displayName);

    const updatedProject = await this.store.updateChat(project.id, chat.id, {
      codexThreadId,
      lastStatus: "Started a fresh Codex thread.",
    });
    const updatedChat = updatedProject.chats.find((candidate) => candidate.id === chat.id);
    if (!updatedChat) throw new Error(`Unknown chat after recovery: ${chat.id}`);

    this.emitEvent(
      "app",
      "chatThreadRecovered",
      `Started a fresh Codex thread for "${updatedChat.displayName}" because the previous rollout was unavailable.`,
      { chatId: updatedChat.id, oldThreadId: chat.codexThreadId, newThreadId: codexThreadId },
    );
    return { project: updatedProject, chat: updatedChat, recovered: true };
  }

  private async startChatThread(project: VoiceProject, displayName: string): Promise<VoiceProject> {
    const chatSettings = this.initialChatSettings(project);
    const result = (await this.codex.request("thread/start", {
      cwd: projectWorkspacePath(project),
      ...(chatSettings.model ? { model: chatSettings.model } : {}),
      ...(chatSettings.serviceTier ? { serviceTier: chatSettings.serviceTier } : {}),
      ...threadPermissionParams(chatSettings.permissionMode),
      developerInstructions: CODEX_VOICE_DEVELOPER_INSTRUCTIONS,
      personality: "friendly",
      serviceName: "codex_voice",
    })) as { thread?: { id?: string } };

    const codexThreadId = result.thread?.id;
    if (!codexThreadId) throw new Error("Codex did not return a thread id.");
    await this.syncThreadName(codexThreadId, displayName);

    return this.store.addChat(project.id, displayName, codexThreadId, chatSettings);
  }

  private async syncThreadName(threadId: string, name: string): Promise<void> {
    try {
      await this.codex.request("thread/name/set", { threadId, name });
    } catch (error) {
      this.emitEvent("app", "threadNameSyncFailed", `Could not sync Codex thread name: ${error instanceof Error ? error.message : String(error)}`, {
        threadId,
      });
    }
  }

  private handleServerRequest(message: CodexJsonMessage): void {
    if (message.id === undefined || !message.method) return;
    const pending = describeServerRequest(message);
    this.pendingRequests.set(String(message.id), pending);
    this.status = pending.title;
    this.emitEvent("codex", "serverRequest", pending.title, pending);
    if (pending.threadId) {
      this.updateChatForThread(pending.threadId, { lastStatus: pending.title });
    }
    this.emitState();
  }

  private handleNotification(message: CodexJsonMessage): void {
    const method = message.method ?? "notification";
    const params = message.params as Record<string, unknown> | undefined;
    if (method === "command/exec/outputDelta") {
      this.handleVoiceCommandOutputDelta(params);
    }
    const threadId = stringField(params?.threadId);
    const status = statusFromNotification(method, params);
    if (status) {
      this.status = status;
      this.emitEvent("codex", method, status, message.params);
      if (threadId) this.updateChatForThread(threadId, { lastStatus: status });
    } else if (method !== "command/exec/outputDelta") {
      this.emitEvent("codex", method, method, message.params);
    }

    if (method === "turn/started") {
      const turn = (params?.turn ?? {}) as { id?: string };
      if (threadId && turn.id) {
        this.activeTurnByThread.set(threadId, turn.id);
        this.threadByTurn.set(turn.id, threadId);
      }
    }

    if (method === "thread/status/changed") {
      const statusParams = params as { threadId?: string; status?: unknown };
      if (statusParams.threadId) {
        this.threadStatusByThread.set(statusParams.threadId, describeThreadStatus(statusParams.status));
      }
    }

    if (method === "serverRequest/resolved") {
      const resolvedParams = params as { requestId?: string | number; threadId?: string };
      if (resolvedParams.requestId !== undefined) {
        const resolved = this.pendingRequests.get(String(resolvedParams.requestId));
        this.pendingRequests.delete(String(resolvedParams.requestId));
        if (resolved?.threadId) {
          this.updateChatForThread(resolved.threadId, { lastStatus: "Codex request resolved." });
        }
      }
    }

    if (method === "thread/tokenUsage/updated") {
      const usageParams = params as { threadId?: string; tokenUsage?: CodexThreadTokenUsage };
      if (usageParams.threadId && usageParams.tokenUsage) {
        this.tokenUsageByThread.set(usageParams.threadId, usageParams.tokenUsage);
      }
    }

    if (method === "item/agentMessage/delta") {
      const deltaParams = params as { turnId?: string; delta?: string };
      if (deltaParams.turnId && deltaParams.delta) {
        const waiter = this.turnWaiters.get(deltaParams.turnId);
        if (waiter) waiter.text += deltaParams.delta;
      }
    }

    if (method === "turn/completed") {
      const turn = (params?.turn ?? {}) as { id?: string; status?: string; error?: { message?: string } };
      const completedThreadId = threadId ?? (turn.id ? this.threadByTurn.get(turn.id) : undefined);
      if (completedThreadId) {
        const activeTurnId = this.activeTurnByThread.get(completedThreadId);
        const completedCurrentTurn = !turn.id || activeTurnId === turn.id;
        if (completedCurrentTurn) {
          this.activeTurnByThread.delete(completedThreadId);
          this.activeTurnModelByThread.delete(completedThreadId);
          this.activeTurnReasoningEffortByThread.delete(completedThreadId);
          this.activeTurnServiceTierByThread.delete(completedThreadId);
          this.activeTurnPermissionModeByThread.delete(completedThreadId);
          const lastStatus = completedTurnStatusText(turn.status);
          const cleared = this.clearPendingRequestsForTurn(completedThreadId, turn.id);
          if (cleared > 0) {
            this.emitEvent("app", "pendingRequestsCleared", `Cleared ${cleared} pending Codex request${cleared === 1 ? "" : "s"} for the ended turn.`, {
              threadId: completedThreadId,
              turnId: turn.id,
            });
          }
          if (turn.id && turn.status !== "interrupted") {
            void this.captureCompletedTurnOutput(completedThreadId, turn.id, lastStatus);
          } else {
            this.updateChatForThread(completedThreadId, { lastStatus });
          }
        }
      }
      if (turn.id) {
        this.threadByTurn.delete(turn.id);
        const waiter = this.turnWaiters.get(turn.id);
        if (waiter) {
          clearTimeout(waiter.timeout);
          this.turnWaiters.delete(turn.id);
          if (turn.status === "failed") {
            waiter.reject(new Error(turn.error?.message ?? "Codex summary turn failed."));
          } else if (turn.status === "interrupted") {
            waiter.reject(new Error("Codex summary turn was interrupted."));
          } else {
            waiter.resolve(waiter.text.trim() || "Codex finished, but no summary text was returned.");
          }
        }
      }
    }

    this.emitState();
  }

  private handleVoiceCommandOutputDelta(params: Record<string, unknown> | undefined): void {
    const processId = stringField(params?.processId);
    const deltaBase64 = stringField(params?.deltaBase64);
    if (!processId || !deltaBase64) return;
    const session = this.voiceExecSessionByProcessId.get(processId);
    if (!session) return;
    try {
      session.output += Buffer.from(deltaBase64, "base64").toString("utf8");
    } catch {
      session.output += deltaBase64;
    }
  }

  private clearPendingRequestsForTurn(threadId: string, turnId?: string): number {
    let cleared = 0;
    for (const [requestId, request] of this.pendingRequests.entries()) {
      if (request.threadId !== threadId) continue;
      if (turnId && request.turnId && request.turnId !== turnId) continue;
      this.pendingRequests.delete(requestId);
      cleared += 1;
    }
    return cleared;
  }

  private waitForTurnText(turnId: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.turnWaiters.delete(turnId);
        reject(new Error("Timed out waiting for Codex summary text."));
      }, 180_000);
      this.turnWaiters.set(turnId, { text: "", resolve, reject, timeout });
    });
  }

  private async captureCompletedTurnOutput(threadId: string, turnId: string, lastStatus: string): Promise<void> {
    try {
      const response = (await this.codex.request("thread/read", {
        threadId,
        includeTurns: true,
      })) as ThreadReadResponse;
      const turn = response.thread?.turns?.find((candidate) => candidate.id === turnId);
      if (!turn) {
        await this.updateCompletedTurnStatus(threadId, lastStatus);
        this.emitEvent("app", "turnOutputUnavailable", "Codex turn ended, but thread/read did not include the completed turn.", {
          threadId,
          turnId,
        });
        return;
      }

      if (turn.status === "interrupted") {
        await this.updateCompletedTurnStatus(threadId, lastStatus);
        this.emitEvent("app", "turnOutputSkipped", "Codex turn was interrupted; partial output was not injected into voice context.", {
          threadId,
          turnId,
        });
        return;
      }

      const finalAssistantText = finalAssistantTextFromTurn(turn);
      if (!finalAssistantText) {
        await this.updateCompletedTurnStatus(threadId, lastStatus);
        this.emitEvent("app", "turnOutputUnavailable", "Codex turn ended, but no final assistant output was available.", {
          threadId,
          turnId,
          status: turn.status,
        });
        return;
      }

      const output: CodexTurnOutput = {
        threadId,
        turnId,
        status: turn.status ?? "completed",
        finalAssistantText,
        items: Array.isArray(turn.items) ? turn.items : [],
        startedAt: numberOrNull(turn.startedAt),
        completedAt: numberOrNull(turn.completedAt),
        durationMs: numberOrNull(turn.durationMs),
        ...(turn.error?.message ? { errorMessage: turn.error.message } : {}),
      };
      const context = await this.findChatByThread(threadId);
      if (context) {
        await this.store.updateChat(context.project.id, context.chat.id, {
          lastStatus,
          lastTurnOutput: output,
        });
      }
      this.emitEvent("codex", "turn/finalOutput", "Codex final output is available for voice context.", output);
      this.emitState();
    } catch (error) {
      await this.updateCompletedTurnStatus(threadId, lastStatus);
      this.emitEvent(
        "app",
        "turnOutputUnavailable",
        error instanceof Error ? error.message : "Unable to read Codex final turn output.",
        { threadId, turnId },
      );
    }
  }

  private async updateCompletedTurnStatus(threadId: string, lastStatus: string): Promise<void> {
    try {
      const context = await this.findChatByThread(threadId);
      if (!context) return;
      await this.store.updateChat(context.project.id, context.chat.id, { lastStatus });
      this.emitState();
    } catch (error) {
      this.emitEvent(
        "app",
        "chatUpdateFailed",
        error instanceof Error ? error.message : "Unable to update chat status.",
        { threadId },
      );
    }
  }

  private runtimeState(activeProject: VoiceProject | null, projects: VoiceProject[]): CodexRuntimeState {
    const activeChat = activeProject ? activeChatForProject(activeProject) : null;
    const activeThreadId = activeChat?.codexThreadId ?? null;
    const chatRuntimes = activeProject ? this.chatRuntimeStates(activeProject) : [];
    const activeRuntime = activeChat
      ? chatRuntimes.find((runtime) => runtime.chatId === activeChat.id) ?? null
      : null;
    return {
      ready: this.codex.ready,
      activeProjectId: this.activeProjectId,
      activeChatId: activeChat?.id ?? null,
      activeTurnId: activeRuntime?.activeTurnId ?? null,
      status: activeRuntime?.status ?? this.status,
      threadStatus: activeThreadId ? this.threadStatusByThread.get(activeThreadId) ?? null : null,
      tokenUsage: activeThreadId ? this.tokenUsageByThread.get(activeThreadId) ?? null : null,
      pendingRequests: this.runtimePendingRequests(activeProject, chatRuntimes, projects),
      chats: chatRuntimes,
      showProjectChats: this.showProjectChatsFlag,
    };
  }

  private chatRuntimeStates(project: VoiceProject): CodexChatRuntime[] {
    return project.chats.filter((chat) => !chat.archivedAt).map((chat) => {
      const threadId = chat.codexThreadId;
      const pendingRequests = threadId
        ? [...this.pendingRequests.values()]
            .filter((request) => request.threadId === threadId)
            .map((request) => ({
              ...request,
              projectId: project.id,
              projectName: project.displayName,
              chatId: chat.id,
              chatName: chat.displayName,
            }))
        : [];
      const activeTurnId = threadId ? this.activeTurnByThread.get(threadId) ?? null : null;
      return {
        chatId: chat.id,
        threadId,
        displayName: chat.displayName,
        activeTurnId,
        status: pendingRequests[0]?.title ?? (activeTurnId ? "Codex is working." : chat.lastStatus ?? "Idle"),
        threadStatus: threadId ? this.threadStatusByThread.get(threadId) ?? null : null,
        tokenUsage: threadId ? this.tokenUsageByThread.get(threadId) ?? null : null,
        pendingRequests,
        activeTurnModel: threadId ? this.activeTurnModelByThread.get(threadId) ?? null : null,
        activeTurnReasoningEffort: threadId
          ? this.activeTurnReasoningEffortByThread.get(threadId) ?? null
          : null,
        activeTurnServiceTier: threadId ? this.activeTurnServiceTierByThread.get(threadId) ?? null : null,
      };
    });
  }

  private runtimePendingRequests(
    activeProject: VoiceProject | null,
    chatRuntimes: CodexChatRuntime[],
    projects: VoiceProject[],
  ): PendingCodexRequest[] {
    const chatByThread = new Map(
      chatRuntimes
        .filter((runtime): runtime is CodexChatRuntime & { threadId: string } => Boolean(runtime.threadId))
        .map((runtime) => [runtime.threadId, runtime]),
    );
    const storedChatByThread = new Map<string, { project: VoiceProject; chat: VoiceChat }>();
    for (const project of projects) {
      for (const chat of project.chats) {
        if (chat.codexThreadId && !chat.archivedAt) {
          storedChatByThread.set(chat.codexThreadId, { project, chat });
        }
      }
    }
    return [...this.pendingRequests.values()].map((request) => {
      if (!request.threadId) return request;
      const runtime = chatByThread.get(request.threadId);
      const stored = storedChatByThread.get(request.threadId);
      if (!runtime && !stored) return request;
      return {
        ...request,
        projectId: stored?.project.id ?? activeProject?.id,
        chatId: runtime?.chatId ?? stored?.chat.id,
        projectName: stored?.project.displayName,
        chatName: runtime?.displayName ?? stored?.chat.displayName,
      };
    });
  }

  private async refreshModels(): Promise<void> {
    try {
      const result = (await this.codex.request("model/list", {
        limit: 100,
        includeHidden: false,
      })) as { data?: CodexModelSummary[] };
      this.models = (result.data ?? []).map((model) => ({
        id: model.id,
        model: model.model,
        displayName: model.displayName,
        description: model.description,
        isDefault: model.isDefault,
        hidden: model.hidden,
        defaultReasoningEffort: model.defaultReasoningEffort,
        supportedReasoningEfforts: model.supportedReasoningEfforts ?? [],
        additionalSpeedTiers: model.additionalSpeedTiers ?? [],
        serviceTiers: model.serviceTiers ?? [],
      }));
      this.defaultModel = DEFAULT_CODEX_MODEL;
      this.defaultReasoningEffort = DEFAULT_CODEX_REASONING_EFFORT;
      this.defaultServiceTier = DEFAULT_CODEX_SERVICE_TIER;
    } catch (error) {
      this.emitEvent(
        "app",
        "modelListFailed",
        error instanceof Error ? error.message : "Unable to list Codex models.",
      );
    }
  }

  private codexSettings(activeProject: VoiceProject | null): CodexSettings {
    const activeChat = activeProject ? activeChatForProject(activeProject) : null;
    const activeThreadId = activeChat?.codexThreadId ?? null;
    const chatModel = activeChat?.model ?? activeProject?.model ?? null;
    const chatReasoningEffort = activeChat?.reasoningEffort ?? activeProject?.reasoningEffort ?? null;
    const chatServiceTier = activeChat ? activeChat.serviceTier : activeProject?.serviceTier ?? null;
    const chatPermissionMode = activeChat?.permissionMode ?? activeProject?.permissionMode ?? this.defaultPermissionMode;
    return {
      chatModel,
      chatReasoningEffort,
      chatServiceTier,
      chatPermissionMode,
      nextTurnModel: this.nextTurnModel,
      nextTurnReasoningEffort: this.nextTurnReasoningEffort,
      nextTurnServiceTier: this.nextTurnServiceTier,
      nextTurnPermissionMode: this.nextTurnPermissionMode,
      activeTurnModel: activeThreadId ? this.activeTurnModelByThread.get(activeThreadId) ?? null : null,
      activeTurnReasoningEffort: activeThreadId
        ? this.activeTurnReasoningEffortByThread.get(activeThreadId) ?? null
        : null,
      activeTurnServiceTier: activeThreadId ? this.activeTurnServiceTierByThread.get(activeThreadId) ?? null : null,
      activeTurnPermissionMode: activeThreadId
        ? this.activeTurnPermissionModeByThread.get(activeThreadId) ?? null
        : null,
      defaultModel: this.defaultModel,
      defaultReasoningEffort: this.defaultReasoningEffort,
      defaultServiceTier: this.defaultServiceTier,
      defaultPermissionMode: this.defaultPermissionMode,
      models: this.models,
    };
  }

  private resolveTurnSettings(project: VoiceProject, chat?: VoiceChat | null): {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    serviceTier: CodexServiceTier | null;
    permissionMode: CodexPermissionMode;
  } {
    const settings = this.threadSettingsForChat(project, chat ?? activeChatForProject(project));
    return {
      model: this.nextTurnModel ?? settings.model,
      reasoningEffort:
        this.nextTurnReasoningEffort ??
        settings.reasoningEffort,
      serviceTier: this.nextTurnServiceTier ?? settings.serviceTier,
      permissionMode: this.nextTurnPermissionMode ?? settings.permissionMode,
    };
  }

  private initialChatSettings(project: VoiceProject): {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    serviceTier: CodexServiceTier | null;
    permissionMode: CodexPermissionMode;
  } {
    return {
      model: project.model ?? this.defaultModel ?? DEFAULT_CODEX_MODEL,
      reasoningEffort:
        project.reasoningEffort ?? this.defaultReasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT,
      serviceTier: project.serviceTier ?? this.defaultServiceTier ?? DEFAULT_CODEX_SERVICE_TIER,
      permissionMode: project.permissionMode ?? this.defaultPermissionMode,
    };
  }

  private threadSettingsForChat(
    project: VoiceProject,
    chat?: VoiceChat | null,
  ): {
    model: string | null;
    reasoningEffort: ReasoningEffort | null;
    serviceTier: CodexServiceTier | null;
    permissionMode: CodexPermissionMode;
  } {
    return {
      model: chat?.model ?? project.model ?? this.defaultModel ?? DEFAULT_CODEX_MODEL,
      reasoningEffort:
        chat?.reasoningEffort ??
        project.reasoningEffort ??
        this.defaultReasoningEffort ??
        DEFAULT_CODEX_REASONING_EFFORT,
      serviceTier: chat ? chat.serviceTier : project.serviceTier ?? this.defaultServiceTier ?? DEFAULT_CODEX_SERVICE_TIER,
      permissionMode: chat?.permissionMode ?? project.permissionMode ?? this.defaultPermissionMode,
    };
  }

  private async handleNativeSlashCommand(text: string): Promise<CodexActionResult> {
    const { command, args, rest } = parseSlashInput(text);
    const lowerCommand = command.toLowerCase();

    if (!lowerCommand || lowerCommand === "help") {
      return this.commandResult(nativeSlashHelpText());
    }

    if (lowerCommand === "status" || lowerCommand === "settings") {
      return this.commandResult(await this.nativeStatusText(), await this.getActiveProject());
    }

    if (lowerCommand === "model" || lowerCommand === "models") {
      return this.handleModelSlash(args);
    }

    if (lowerCommand === "fast") {
      return this.handleFastSlash(args);
    }

    if (lowerCommand === "permissions" || lowerCommand === "approvals") {
      return this.handlePermissionsSlash(args);
    }

    if (lowerCommand === "effort" || lowerCommand === "reasoning") {
      return this.commandResult(
        "Reasoning effort is part of Codex's native /model command. Use /model <effort> or /model <model> <effort>.",
      );
    }

    if (lowerCommand === "review") {
      return this.handleReviewSlash(args);
    }

    if (lowerCommand === "compact") {
      return this.handleCompactSlash();
    }

    if (lowerCommand === "mcp") {
      return this.handleMcpSlash(args);
    }

    if (lowerCommand === "apps") {
      return this.handleAppsSlash();
    }

    if (lowerCommand === "plugins") {
      return this.handlePluginsSlash();
    }

    if (lowerCommand === "new") {
      const project = await this.createProject(rest || undefined);
      return this.commandResult(
        `Created new Codex voice project: ${project.displayName}\nWorkspace: ${projectWorkspacePath(project)}\nVoice folder: ${project.folderPath}`,
        project,
      );
    }

    if (lowerCommand === "resume") {
      const targetId = args[0] ?? (await this.store.getMostRecentProject())?.id;
      if (!targetId) throw new Error("No recent Codex voice projects exist yet.");
      const project = await this.resumeProject(targetId);
      return this.commandResult(`Resumed Codex voice project: ${project.displayName}`, project);
    }

    const unsupported = nativeUnsupportedSlashCommand(lowerCommand);
    if (unsupported) {
      return this.commandResult(unsupported);
    }

    return this.commandResult(`Unknown Codex slash command: /${command}. Try /help.`);
  }

  private async handleModelSlash(args: string[]): Promise<CodexActionResult> {
    await this.refreshModels();
    const activeProject = await this.getActiveProject();

    if (args.length === 0) {
      return this.commandResult(
        [this.currentSettingsText(activeProject), "", "Available models", formatModelList(this.models)].join("\n"),
        activeProject,
      );
    }

    const parsed = parseModelSlashArgs(args, activeProject ? "chat" : "nextTurn");
    if (parsed.model !== undefined && parsed.model !== null) this.assertKnownModel(parsed.model);
    if (parsed.reasoningEffort !== undefined && parsed.reasoningEffort !== null) {
      this.assertReasoningEffort(parsed.reasoningEffort);
    }

    const settings = await this.setCodexSettings(
      {
        ...(parsed.model !== undefined ? { model: parsed.model } : {}),
        ...(parsed.reasoningEffort !== undefined ? { reasoningEffort: parsed.reasoningEffort } : {}),
      },
      parsed.scope,
    );
    return this.commandResult(`Updated /model for ${parsed.scope}.\n${settingsText(settings)}`, await this.getActiveProject());
  }

  private async handleFastSlash(args: string[]): Promise<CodexActionResult> {
    await this.refreshModels();
    const activeProject = await this.getActiveProject();
    const settings = this.codexSettings(activeProject);
    const scope = activeProject ? "chat" : "nextTurn";
    const effectiveModel =
      settings.nextTurnModel ?? settings.chatModel ?? settings.defaultModel ?? DEFAULT_CODEX_MODEL;
    const currentTier =
      settings.nextTurnServiceTier ?? settings.chatServiceTier ?? settings.defaultServiceTier ?? DEFAULT_CODEX_SERVICE_TIER;
    const command = (args[0] ?? "status").toLowerCase();

    if (command === "status") {
      return this.commandResult(
        `Fast mode is ${isFastServiceTier(currentTier) ? "on" : "off"} for ${effectiveModel}.`,
        activeProject,
      );
    }

    if (command !== "on" && command !== "off" && command !== "standard") {
      throw new Error("Use /fast on, /fast off, or /fast status.");
    }

    if (command === "on" && !this.modelSupportsServiceTier(effectiveModel, FAST_CODEX_SERVICE_TIER)) {
      throw new Error(`${effectiveModel} does not report Fast mode support from app-server.`);
    }

    const updated = await this.setCodexSettings(
      { serviceTier: command === "on" ? FAST_CODEX_SERVICE_TIER : null },
      scope,
    );
    return this.commandResult(`Updated /fast for ${scope}.\n${settingsText(updated)}`, await this.getActiveProject());
  }

  private async handlePermissionsSlash(args: string[]): Promise<CodexActionResult> {
    const activeProject = await this.getActiveProject();
    if (args.length === 0) {
      return this.commandResult(
        [
          this.currentSettingsText(activeProject),
          "",
          "Permission modes",
          ...CODEX_PERMISSION_PROFILES.map(
            (profile) =>
              `${profile.mode} - ${profile.displayName}: approval ${formatPermissionValue(
                profile.approvalPolicy,
              )}, reviewer ${formatPermissionValue(profile.approvalsReviewer)}, sandbox ${formatPermissionValue(
                profile.sandbox,
              )}`,
          ),
        ].join("\n"),
        activeProject,
      );
    }

    const mode = permissionModeFromText(args.join(" "));
    const settings = await this.setCodexSettings({ permissionMode: mode }, activeProject ? "chat" : "nextTurn");
    return this.commandResult(
      `Updated /permissions to ${permissionProfile(mode).displayName}.\n${settingsText(settings)}`,
      await this.getActiveProject(),
    );
  }

  private async handleReviewSlash(args: string[]): Promise<CodexActionResult> {
    const { project, chat } = await this.requireChatContext();
    if (!chat.codexThreadId) throw new Error("Active chat is missing a Codex thread id.");
    const { target, delivery } = parseReviewSlashArgs(args);
    const turnSettings = this.resolveTurnSettings(project, chat);
    const result = (await this.codex.request("review/start", {
      threadId: chat.codexThreadId,
      target,
      ...(delivery ? { delivery } : {}),
    })) as { turn?: { id?: string }; reviewThreadId?: string };

    const turnId = result.turn?.id ?? null;
    if (turnId) {
      this.activeTurnByThread.set(chat.codexThreadId, turnId);
      this.threadByTurn.set(turnId, chat.codexThreadId);
      this.activeTurnModelByThread.set(chat.codexThreadId, turnSettings.model);
      this.activeTurnReasoningEffortByThread.set(chat.codexThreadId, turnSettings.reasoningEffort);
      this.activeTurnServiceTierByThread.set(chat.codexThreadId, turnSettings.serviceTier);
      this.activeTurnPermissionModeByThread.set(chat.codexThreadId, turnSettings.permissionMode);
    }
    const updated = await this.store.updateChat(project.id, chat.id, {
      lastStatus: "Codex review started.",
    });
    this.status = "Codex review started.";
    return this.commandResult(
      `Started /review (${describeReviewTarget(target)}) in ${chat.displayName}. Review thread: ${result.reviewThreadId ?? chat.codexThreadId}.`,
      updated,
    );
  }

  private async handleCompactSlash(): Promise<CodexActionResult> {
    const { project, chat } = await this.requireChatContext();
    if (!chat.codexThreadId) throw new Error("Active chat is missing a Codex thread id.");
    await this.codex.request("thread/compact/start", { threadId: chat.codexThreadId });
    const updated = await this.store.updateChat(project.id, chat.id, {
      lastStatus: "Context compaction requested.",
    });
    return this.commandResult(`Requested native /compact for "${chat.displayName}".`, updated);
  }

  private async handleMcpSlash(args: string[]): Promise<CodexActionResult> {
    const verbose = args.some((arg) => arg.toLowerCase() === "verbose" || arg.toLowerCase() === "full");
    const result = (await this.codex.request("mcpServerStatus/list", {
      limit: 100,
      detail: verbose ? "full" : "toolsAndAuthOnly",
    })) as { data?: Array<{ name: string; tools?: Record<string, unknown>; authStatus?: string }> };
    return this.commandResult(formatMcpServers(result.data ?? [], verbose), await this.getActiveProject());
  }

  private async handleAppsSlash(): Promise<CodexActionResult> {
    const project = await this.getActiveProject();
    const chat = project ? activeChatForProject(project) : null;
    const result = (await this.codex.request("app/list", {
      limit: 100,
      threadId: chat?.codexThreadId ?? null,
      forceRefetch: false,
    })) as { data?: Array<{ id: string; name: string; isEnabled: boolean; isAccessible: boolean; pluginDisplayNames?: string[] }> };
    return this.commandResult(formatApps(result.data ?? []), project);
  }

  private async handlePluginsSlash(): Promise<CodexActionResult> {
    const project = await this.getActiveProject();
    const result = (await this.codex.request("plugin/list", {
      cwds: project ? [projectWorkspacePath(project)] : null,
    })) as {
      marketplaces?: Array<{
        name: string;
        plugins?: Array<{ id: string; name: string; installed: boolean; enabled: boolean }>;
      }>;
      marketplaceLoadErrors?: unknown[];
    };
    return this.commandResult(formatPlugins(result.marketplaces ?? [], result.marketplaceLoadErrors ?? []), project);
  }

  private async nativeStatusText(): Promise<string> {
    const project = await this.getActiveProject();
    const chat = project ? activeChatForProject(project) : null;
    const threadId = chat?.codexThreadId ?? null;
    const settings = this.codexSettings(project);
    const resolved = project
      ? this.resolveTurnSettings(project, chat)
        : {
            model: settings.nextTurnModel ?? settings.defaultModel,
            reasoningEffort: settings.nextTurnReasoningEffort ?? settings.defaultReasoningEffort,
            serviceTier: settings.nextTurnServiceTier ?? settings.defaultServiceTier,
            permissionMode: settings.nextTurnPermissionMode ?? settings.defaultPermissionMode,
          };
    const tokenUsage = threadId ? this.tokenUsageByThread.get(threadId) ?? null : null;
    const [configSummary, rateLimitSummary] = await Promise.all([
      this.readConfigSummary(project),
      this.readRateLimitSummary(),
    ]);

    return [
      "Codex /status",
      `Chat: ${chat?.displayName ?? "none"}`,
      `Thread: ${threadId ?? "none"}`,
      `Workspace: ${project ? projectWorkspacePath(project) : "none"}`,
      `Voice folder: ${project?.folderPath ?? "none"}`,
      `Runtime: ${this.threadStatusByThread.get(threadId ?? "") ?? this.status}`,
      `Active turn: ${threadId ? this.activeTurnByThread.get(threadId) ?? "none" : "none"}`,
      `Effective next turn: model ${resolved.model ?? "default"}, reasoning ${
        resolved.reasoningEffort ?? "default"
      }, speed ${formatServiceTier(resolved.serviceTier)}, permissions ${permissionProfile(resolved.permissionMode).displayName}`,
      `Chat override: model ${settings.chatModel ?? "default"}, reasoning ${
        settings.chatReasoningEffort ?? "default"
      }, speed ${formatServiceTier(settings.chatServiceTier)}, permissions ${permissionProfile(settings.chatPermissionMode).displayName}`,
      `Active turn model: ${settings.activeTurnModel ?? "none"}, reasoning ${
        settings.activeTurnReasoningEffort ?? "none"
      }, speed ${formatServiceTier(settings.activeTurnServiceTier)}, permissions ${
        settings.activeTurnPermissionMode ? permissionProfile(settings.activeTurnPermissionMode).displayName : "none"
      }`,
      `Voice app defaults: ${permissionProfile(settings.defaultPermissionMode).displayName}.`,
      `Context: ${formatTokenUsage(tokenUsage)}`,
      `Rate limits: ${rateLimitSummary}`,
      configSummary,
    ].join("\n");
  }

  private async readConfigSummary(project: VoiceProject | null): Promise<string> {
    try {
      const result = (await this.codex.request("config/read", {
        includeLayers: false,
        cwd: project ? projectWorkspacePath(project) : null,
      })) as { config?: Record<string, unknown> };
      const config = result.config ?? {};
      return `Config defaults: model ${formatConfigValue(config.model)}, reasoning ${formatConfigValue(
        config.model_reasoning_effort,
      )}, speed ${formatServiceTier(
        typeof config.service_tier === "string" ? config.service_tier : null,
      )}, approval ${formatConfigValue(config.approval_policy)}, reviewer ${formatConfigValue(
        config.approvals_reviewer,
      )}, sandbox ${formatConfigValue(config.sandbox_mode)}.`;
    } catch (error) {
      return `Config defaults: unavailable (${error instanceof Error ? error.message : String(error)}).`;
    }
  }

  private async readRateLimitSummary(): Promise<string> {
    try {
      const result = (await this.codex.request("account/rateLimits/read", undefined)) as {
        rateLimits?: unknown;
        rateLimitsByLimitId?: Record<string, unknown> | null;
      };
      const bucket = result.rateLimitsByLimitId?.codex ?? result.rateLimits;
      return formatRateLimit(bucket);
    } catch (error) {
      return `unavailable (${error instanceof Error ? error.message : String(error)})`;
    }
  }

  private commandResult(message: string, project: VoiceProject | null = null): CodexActionResult {
    this.status = message.split("\n")[0] || "Native slash command handled.";
    this.emitEvent("app", "slashCommand", message);
    this.emitState();
    return { kind: "command", message, turnId: null, project: project, chat: project ? activeChatForProject(project) : null };
  }

  private currentSettingsText(activeProject: VoiceProject | null): string {
    return settingsText(this.codexSettings(activeProject));
  }

  private assertKnownModel(model: string): void {
    if (model === DEFAULT_CODEX_MODEL) return;
    if (this.models.length === 0) return;
    const found = this.models.some((candidate) => candidate.model === model || candidate.id === model);
    if (!found) {
      throw new Error(`Unknown model "${model}". Use /model to list available models.`);
    }
  }

  private assertReasoningEffort(effort: string): asserts effort is ReasoningEffort {
    const allowed: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
    if (!allowed.includes(effort as ReasoningEffort)) {
      throw new Error(`Unknown reasoning effort "${effort}". Use one of: ${allowed.join(", ")}.`);
    }
  }

  private assertServiceTier(serviceTier: string, model: string | null | undefined): asserts serviceTier is CodexServiceTier {
    if (serviceTier === FAST_CODEX_SERVICE_TIER || serviceTier === "fast") {
      const targetModel = model ?? this.nextTurnModel ?? this.defaultModel ?? DEFAULT_CODEX_MODEL;
      if (!this.modelSupportsServiceTier(targetModel, FAST_CODEX_SERVICE_TIER)) {
        throw new Error(`${targetModel} does not report Fast mode support from app-server.`);
      }
      return;
    }
    const allowed = Array.from(new Set(this.models.flatMap((modelSummary) => modelSummary.serviceTiers.map((tier) => tier.id))));
    if (allowed.length > 0 && !allowed.includes(serviceTier)) {
      throw new Error(`Unknown service tier "${serviceTier}". Use one of: ${allowed.join(", ")}.`);
    }
  }

  private assertPermissionMode(mode: string): asserts mode is CodexPermissionMode {
    const allowed = CODEX_PERMISSION_PROFILES.map((profile) => profile.mode);
    if (!allowed.includes(mode as CodexPermissionMode)) {
      throw new Error(`Unknown permission mode "${mode}". Use one of: ${allowed.join(", ")}.`);
    }
  }

  private modelSupportsServiceTier(model: string | null, serviceTier: CodexServiceTier): boolean {
    const modelSummary = this.models.find((candidate) => candidate.model === model || candidate.id === model);
    if (!modelSummary) return true;
    return (
      modelSummary.serviceTiers.some((tier) => tier.id === serviceTier || tier.name.toLowerCase() === "fast") ||
      modelSummary.additionalSpeedTiers.includes("fast")
    );
  }

  private describeModelEffort(
    model: string | null,
    effort: ReasoningEffort | null,
    serviceTier: CodexServiceTier | null = null,
  ): string {
    return `model ${model ?? this.defaultModel ?? "default"}, reasoning ${
      effort ?? this.defaultReasoningEffort ?? "default"
    }, speed ${isFastServiceTier(serviceTier) ? "Fast" : "Standard"}`;
  }

  private describePermissions(mode: CodexPermissionMode): string {
    const profile = permissionProfile(mode);
    return `permissions ${profile.displayName}`;
  }

  private updateChatForThread(threadId: string, patch: Partial<VoiceChat>): void {
    void this.findChatByThread(threadId)
      .then((context) => {
        if (!context) return null;
        return this.store.updateChat(context.project.id, context.chat.id, patch);
      })
      .then(() => this.emitState())
      .catch((error) => {
        this.emitEvent(
          "app",
          "chatUpdateFailed",
          error instanceof Error ? error.message : "Unable to update chat status.",
        );
      });
  }

  private async findChatByThread(threadId: string): Promise<ChatContext | null> {
    const projects = await this.store.listProjects();
    for (const project of projects) {
      const chat = project.chats.find((candidate) => candidate.codexThreadId === threadId && !candidate.archivedAt);
      if (chat) return { project, chat };
    }
    return null;
  }

  private emitState(): void {
    void this.state().then((state) => this.emit("state", state));
  }

  private emitEvent(source: AppEvent["source"], kind: string, message: string, raw?: unknown): void {
    this.emit("event", {
      at: new Date().toISOString(),
      source,
      kind,
      message,
      raw,
    } satisfies AppEvent);
  }
}

function emptyActiveThreadSummary({
  status = "empty",
  project = null,
  chat = null,
  errorMessage,
}: {
  status?: ActiveThreadSummary["status"];
  project?: VoiceProject | null;
  chat?: VoiceChat | null;
  errorMessage?: string;
}): ActiveThreadSummary {
  return {
    status,
    ...(errorMessage ? { errorMessage } : {}),
    projectId: project?.id ?? null,
    projectName: project?.displayName ?? null,
    workspacePath: project ? projectWorkspacePath(project) : null,
    chatId: chat?.id ?? null,
    chatName: chat?.displayName ?? null,
    threadId: chat?.codexThreadId ?? null,
    turnCount: 0,
    latestTurnStatus: null,
    latestAssistantText: chat?.lastTurnOutput?.finalAssistantText ?? null,
    progress: [],
    artifacts: [],
    sources: [],
    referencedFiles: [],
    turns: [],
    rawUnknownItems: [],
  };
}

function activeThreadSummaryFromRead(
  project: VoiceProject,
  chat: VoiceChat,
  response: ThreadReadResponse,
): ActiveThreadSummary {
  const rawTurns = response.thread?.turns ?? [];
  const turns = rawTurns.map((turn, index) => summarizeThreadTurn(turn, index));
  const rawItems = rawTurns.flatMap((turn) => turn.items ?? []);
  const artifacts = dedupeArtifacts([
    ...rawTurns.flatMap((turn, index) => artifactCandidatesFromTurn(turn, index)),
    ...rawItems.flatMap((item, index) => artifactCandidatesFromItem(item, index)),
  ]);
  const sources = dedupeSources(rawItems.flatMap((item, index) => sourceCandidatesFromItem(item, index)));
  const referencedFiles = artifacts.filter((artifact) => artifact.kind === "file");
  const latestAssistantText =
    [...turns].reverse().find((turn) => turn.assistantText?.trim())?.assistantText ??
    chat.lastTurnOutput?.finalAssistantText ??
    null;
  const latestTurn = rawTurns.at(-1) ?? null;

  return {
    status: "ready",
    projectId: project.id,
    projectName: project.displayName,
    workspacePath: projectWorkspacePath(project),
    chatId: chat.id,
    chatName: chat.displayName,
    threadId: chat.codexThreadId,
    turnCount: rawTurns.length,
    latestTurnStatus: latestTurn?.status ?? null,
    latestAssistantText,
    progress: progressItemsFromThread(rawTurns, rawItems),
    artifacts,
    sources,
    referencedFiles,
    turns,
    rawUnknownItems: rawItems
      .filter((item) => !knownThreadItemTypes.has(normalizeThreadItemType(item)))
      .slice(-40),
  };
}

function summarizeThreadTurn(turn: CodexThreadTurn, index: number): ThreadSummaryTurn {
  const items = turn.items ?? [];
  return {
    id: turn.id ?? `turn-${index + 1}`,
    status: turn.status ?? "unknown",
    startedAt: numberOrNull(turn.startedAt),
    completedAt: numberOrNull(turn.completedAt),
    durationMs: numberOrNull(turn.durationMs),
    userText: userTextFromTurn(turn),
    assistantText: finalAssistantTextFromTurn(turn),
    itemCount: items.length,
    items: items.map((item, itemIndex) => summarizeThreadItem(item, turn.id ?? `turn-${index + 1}`, itemIndex)),
    ...(turn.error?.message ? { errorMessage: turn.error.message } : {}),
  };
}

function summarizeThreadItem(item: CodexThreadItem, turnId: string, itemIndex: number): ThreadSummaryItem {
  const type = rawThreadItemType(item);
  return {
    id: itemId(item, `${turnId}:item-${itemIndex + 1}`),
    type,
    status: stringField(item.status) ?? stringField(item.phase) ?? null,
    label: labelForThreadItem(item),
    detail: detailForThreadItem(item),
    raw: item,
  };
}

function progressItemsFromThread(
  turns: CodexThreadTurn[],
  rawItems: CodexThreadItem[],
): ThreadProgressItem[] {
  const progress: ThreadProgressItem[] = [];
  for (const [index, item] of rawItems.entries()) {
    const type = normalizeThreadItemType(item);
    const status = normalizeProgressStatus(item.status ?? item.phase);
    if (type === "todo-list") {
      const tasks = taskRecords(item);
      const completed = tasks.filter((task) => normalizeProgressStatus(task.status) === "completed").length;
      progress.push({
        id: itemId(item, `progress-${index}`),
        label: "To do list",
        detail: tasks.length > 0 ? `${completed} of ${tasks.length} tasks completed` : detailForThreadItem(item),
        status: tasks.length > 0 && completed === tasks.length ? "completed" : status,
        sourceType: type,
        raw: item,
      });
      continue;
    }
    if (type === "proposed-plan" || type === "plan-implementation") {
      progress.push({
        id: itemId(item, `progress-${index}`),
        label: type === "proposed-plan" ? "Plan proposed" : "Plan implementation",
        detail: firstTextField(item, ["text", "summary", "description", "title"]),
        status,
        sourceType: type,
        raw: item,
      });
      continue;
    }
    if (type === "reasoning") {
      const summary = reasoningSummary(item);
      if (summary) {
        progress.push({
          id: itemId(item, `progress-${index}`),
          label: "Reasoning",
          detail: summary,
          status,
          sourceType: type,
          raw: item,
        });
      }
      continue;
    }
    if (
      status === "in_progress" ||
      type === "exec" ||
      type === "patch" ||
      type === "web-search" ||
      type === "mcp-tool-call" ||
      type === "sub-agent" ||
      type === "generated-image"
    ) {
      progress.push({
        id: itemId(item, `progress-${index}`),
        label: labelForThreadItem(item),
        detail: detailForThreadItem(item),
        status,
        sourceType: type,
        raw: item,
      });
    }
  }

  const latestTurn = turns.at(-1);
  if (latestTurn && latestTurn.status && normalizeProgressStatus(latestTurn.status) === "in_progress") {
    progress.push({
      id: latestTurn.id ?? "latest-turn",
      label: "Turn in progress",
      detail: latestTurn.items?.at(-1) ? labelForThreadItem(latestTurn.items.at(-1)!) : null,
      status: "in_progress",
      sourceType: "turn",
      raw: latestTurn,
    });
  }

  return progress.slice(-18);
}

function artifactCandidatesFromTurn(turn: CodexThreadTurn, index: number): ThreadArtifactCandidate[] {
  const candidates: ThreadArtifactCandidate[] = [];
  const turnId = turn.id ?? `turn-${index + 1}`;
  const artifacts = recordField(turn, "artifacts");
  if (artifacts) {
    for (const target of targetStringsFromFields(artifacts, ["editedFilePaths", "edited_file_paths"])) {
      candidates.push(artifactFromTarget(target, {
        id: `turn-artifact-edited-${turnId}:${target}`,
        title: titleFromTarget(target),
        subtitle: "Edited file",
        mimeType: null,
        sourceType: "turn-artifacts",
        raw: turn,
      }));
    }
    for (const target of targetStringsFromFields(artifacts, [
      "referencedFilePaths",
      "referenced_file_paths",
      "filePaths",
      "file_paths",
      "files",
    ])) {
      candidates.push(artifactFromTarget(target, {
        id: `turn-artifact-referenced-${turnId}:${target}`,
        title: titleFromTarget(target),
        subtitle: "Referenced file",
        mimeType: null,
        sourceType: "turn-artifacts",
        raw: turn,
      }));
    }
    for (const resource of recordsFromFields(artifacts, [
      "endResources",
      "end_resources",
      "resources",
      "generatedImages",
      "generated_images",
      "images",
    ])) {
      const target = firstStringField(resource, ["uri", "url", "path", "filePath", "target", "src"]);
      if (!target) continue;
      const mimeType = firstStringField(resource, ["mimeType", "mime_type", "contentType", "content_type"]);
      candidates.push(artifactFromTarget(target, {
        id: `turn-artifact-resource-${turnId}:${target}`,
        title: firstStringField(resource, ["name", "title"]) ?? titleFromTarget(target),
        subtitle: mimeType ?? "Turn resource",
        mimeType,
        sourceType: "turn-artifacts",
        raw: turn,
      }));
    }
    for (const target of collectTargets(artifacts).slice(0, 16)) {
      candidates.push(artifactFromTarget(target.value, {
        id: `turn-artifact-target-${turnId}:${target.value}`,
        title: titleFromTarget(target.value),
        subtitle: target.label,
        mimeType: null,
        sourceType: "turn-artifacts",
        raw: turn,
      }));
    }
  }

  const assistantText = finalAssistantTextFromTurn(turn);
  if (assistantText) {
    for (const target of extractTargetsFromText(assistantText).slice(0, 12)) {
      candidates.push(artifactFromTarget(target, {
        id: `turn-artifact-text-${turnId}:${target}`,
        title: titleFromTarget(target),
        subtitle: "Assistant output reference",
        mimeType: null,
        sourceType: "assistant-message",
        raw: turn,
      }));
    }
  }

  return candidates;
}

function artifactCandidatesFromItem(item: CodexThreadItem, index: number): ThreadArtifactCandidate[] {
  const candidates: ThreadArtifactCandidate[] = [];
  const type = normalizeThreadItemType(item);
  const directResource = recordField(item, "resource");
  if (directResource) {
    const uri = firstStringField(directResource, ["uri", "url", "target"]);
    const mimeType = firstStringField(directResource, ["mimeType", "mime_type"]);
    if (uri) {
      candidates.push(artifactFromTarget(uri, {
        id: itemId(item, `artifact-resource-${index}`),
        title: firstStringField(directResource, ["name", "title"]) ?? titleFromTarget(uri),
        subtitle: mimeType ?? "Embedded resource",
        mimeType,
        sourceType: type,
        raw: item,
      }));
    }
  }

  if (type === "generated-image") {
    for (const target of targetStringsFromFields(item, ["url", "imageUrl", "image_url", "path", "filePath", "src"])) {
      candidates.push(artifactFromTarget(target, {
        id: `${itemId(item, `artifact-image-${index}`)}:${target}`,
        title: titleFromTarget(target),
        subtitle: "Generated image",
        mimeType: firstStringField(item, ["mimeType", "mime_type"]) ?? "image",
        sourceType: type,
        raw: item,
      }));
    }
  }

  for (const filePath of fileChangePaths(item)) {
    candidates.push({
      id: `${itemId(item, `artifact-file-${index}`)}:${filePath}`,
      kind: "file",
      title: titleFromTarget(filePath),
      subtitle: "Edited or referenced file",
      path: filePath,
      sourceType: type,
      raw: item,
    });
  }

  for (const target of collectTargets(item).slice(0, 12)) {
    candidates.push(artifactFromTarget(target.value, {
      id: `${itemId(item, `artifact-target-${index}`)}:${target.value}`,
      title: titleFromTarget(target.value),
      subtitle: target.label,
      mimeType: null,
      sourceType: type,
      raw: item,
    }));
  }

  return candidates;
}

function sourceCandidatesFromItem(item: CodexThreadItem, index: number): ThreadSourceCandidate[] {
  const type = normalizeThreadItemType(item);
  const sources: ThreadSourceCandidate[] = [];
  if (type === "web-search") {
    const query = firstStringField(item, ["query", "searchQuery", "text"]);
    sources.push({
      id: itemId(item, `source-web-${index}`),
      kind: "web",
      title: query ? `Web search: ${query}` : "Web search",
      subtitle: normalizeProgressStatus(item.status) === "in_progress" ? "Searching" : "Search result",
      sourceType: type,
      raw: item,
    });
  }

  if (type === "mcp-tool-call" || type === "sub-agent" || type === "exec") {
    const server = firstStringField(item, ["server", "namespace"]);
    if (server !== "node_repl") {
      sources.push({
        id: itemId(item, `source-tool-${index}`),
        kind: "tool",
        title: labelForThreadItem(item),
        subtitle: detailForThreadItem(item),
        sourceType: type,
        raw: item,
      });
    }
  }

  if (type === "generated-image") {
    sources.push({
      id: itemId(item, `source-image-${index}`),
      kind: "resource",
      title: labelForThreadItem(item),
      subtitle: detailForThreadItem(item),
      sourceType: type,
      raw: item,
    });
  }

  for (const target of collectTargets(item).slice(0, 16)) {
    const artifact = artifactFromTarget(target.value, {
      id: `${itemId(item, `source-target-${index}`)}:${target.value}`,
      title: titleFromTarget(target.value),
      subtitle: target.label,
      mimeType: null,
      sourceType: type,
      raw: item,
    });
    sources.push({
      id: artifact.id,
      kind: artifact.kind === "url" ? "web" : artifact.kind === "file" ? "file" : "resource",
      title: artifact.title,
      subtitle: artifact.subtitle,
      url: artifact.url,
      path: artifact.path,
      sourceType: type,
      raw: item,
    });
  }

  return sources;
}

function artifactFromTarget(
  target: string,
  base: Omit<ThreadArtifactCandidate, "kind" | "path" | "url">,
): ThreadArtifactCandidate {
  if (isUrl(target)) {
    return {
      ...base,
      kind: "url",
      url: target,
    };
  }
  if (looksLikeFilePath(target)) {
    return {
      ...base,
      kind: "file",
      path: target,
    };
  }
  return {
    ...base,
    kind: "resource",
    url: target,
  };
}

function collectTargets(value: unknown, depth = 0, label = "Reference"): Array<{ value: string; label: string }> {
  if (depth > 4 || value == null) return [];
  if (Array.isArray(value)) return value.flatMap((entry) => collectTargets(entry, depth + 1, label));
  if (typeof value !== "object") return [];

  const targets: Array<{ value: string; label: string }> = [];
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    const nextLabel = humanizeKey(key);
    if (typeof entry === "string" && targetKeyNames.has(key.toLowerCase())) {
      const trimmed = entry.trim();
      if (isUrl(trimmed) || looksLikeFilePath(trimmed)) {
        targets.push({ value: trimmed, label: nextLabel });
      }
    }
    if (entry && typeof entry === "object") {
      targets.push(...collectTargets(entry, depth + 1, nextLabel));
    }
  }
  return dedupeTargets(targets);
}

function fileChangePaths(item: CodexThreadItem): string[] {
  const paths = new Set<string>();
  for (const key of ["path", "filePath", "filepath", "filename", "target"]) {
    const value = firstStringField(item, [key]);
    if (value && looksLikeFilePath(value)) paths.add(value);
  }
  for (const key of [
    "editedFilePaths",
    "edited_file_paths",
    "referencedFilePaths",
    "referenced_file_paths",
    "filePaths",
    "file_paths",
    "fileChanges",
    "changes",
    "diff",
    "files",
    "edits",
  ]) {
    const value = (item as Record<string, unknown>)[key];
    if (typeof value === "string") {
      if (looksLikeFilePath(value)) paths.add(value);
      for (const candidate of extractTargetsFromText(value)) {
        if (looksLikeFilePath(candidate)) paths.add(candidate);
      }
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      for (const name of Object.keys(value)) {
        if (looksLikeFilePath(name)) paths.add(name);
      }
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string" && looksLikeFilePath(entry)) paths.add(entry);
        if (entry && typeof entry === "object") {
          for (const field of ["path", "filePath", "filepath", "filename", "target", "name"]) {
            const candidate = firstStringField(entry as Record<string, unknown>, [field]);
            if (candidate && looksLikeFilePath(candidate)) paths.add(candidate);
          }
        }
      }
    }
  }
  return [...paths];
}

function dedupeArtifacts(candidates: ThreadArtifactCandidate[]): ThreadArtifactCandidate[] {
  const seen = new Set<string>();
  const output: ThreadArtifactCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.path ?? candidate.url ?? candidate.id;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output.slice(-60);
}

function dedupeSources(candidates: ThreadSourceCandidate[]): ThreadSourceCandidate[] {
  const seen = new Set<string>();
  const output: ThreadSourceCandidate[] = [];
  for (const candidate of candidates) {
    const key = candidate.url ?? candidate.path ?? candidate.id;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(candidate);
  }
  return output.slice(-60);
}

function dedupeTargets(targets: Array<{ value: string; label: string }>): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const output: Array<{ value: string; label: string }> = [];
  for (const target of targets) {
    if (seen.has(target.value)) continue;
    seen.add(target.value);
    output.push(target);
  }
  return output;
}

function rawThreadItemType(item: CodexThreadItem): string {
  return String(item.type ?? "unknown");
}

function normalizeThreadItemType(itemOrType: CodexThreadItem | string | null | undefined): string {
  const raw = typeof itemOrType === "string" ? itemOrType : itemOrType?.type;
  if (!raw) return "unknown";
  const normalized = raw
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
  if (normalized === "agent-message" || normalized === "assistant-message") return "assistant-message";
  if (normalized === "user-message" || normalized === "user-input") return "user-message";
  if (normalized === "command-execution" || normalized === "exec") return "exec";
  if (normalized === "file-change" || normalized === "patch" || normalized === "turn-diff") return "patch";
  if (normalized === "mcp-tool-call" || normalized === "tool-call" || normalized === "dynamic-tool-call") {
    return "mcp-tool-call";
  }
  if (normalized === "mcp-server-elicitation") return "mcp-tool-call";
  if (normalized === "web-search") return "web-search";
  if (normalized === "todo-list") return "todo-list";
  if (normalized === "proposed-plan") return "proposed-plan";
  if (normalized === "plan-implementation") return "plan-implementation";
  if (
    normalized === "collab-agent-tool-call" ||
    normalized === "multi-agent-action" ||
    normalized === "remote-task-created" ||
    normalized === "worked-for"
  ) {
    return "sub-agent";
  }
  if (normalized === "generated-image" || normalized === "image-generation") return "generated-image";
  if (normalized === "automation-update" || normalized === "system-event") return "system-event";
  if (normalized === "tool-output") return "tool-output";
  return normalized;
}

function labelForThreadItem(item: CodexThreadItem): string {
  const type = normalizeThreadItemType(item);
  if (type === "assistant-message") return "Assistant message";
  if (type === "user-message") return "User message";
  if (type === "exec") return "Command";
  if (type === "patch") return "File change";
  if (type === "mcp-tool-call") return "Tool call";
  if (type === "web-search") return "Web search";
  if (type === "todo-list") return "To do list";
  if (type === "proposed-plan") return "Proposed plan";
  if (type === "plan-implementation") return "Plan implementation";
  if (type === "reasoning") return "Reasoning";
  if (type === "sub-agent") return "Sub-agent";
  if (type === "generated-image") return "Generated image";
  return humanizeKey(rawThreadItemType(item));
}

function detailForThreadItem(item: CodexThreadItem): string | null {
  const type = normalizeThreadItemType(item);
  if (type === "exec") return firstStringField(item, ["command", "cmd", "aggregatedOutput", "output", "text"]);
  if (type === "web-search") return firstStringField(item, ["query", "searchQuery", "text"]);
  if (type === "mcp-tool-call" || type === "sub-agent") {
    return [firstStringField(item, ["server", "namespace"]), firstStringField(item, ["tool", "name"])]
      .filter(Boolean)
      .join(".") || null;
  }
  if (type === "todo-list") {
    const tasks = taskRecords(item);
    if (tasks.length > 0) return `${tasks.length} tasks`;
  }
  if (type === "patch") {
    const paths = fileChangePaths(item);
    if (paths.length === 1) return paths[0];
    if (paths.length > 1) return `${paths.length} files`;
  }
  if (type === "generated-image") {
    return firstStringField(item, ["prompt", "description", "url", "path", "filePath"]);
  }
  return firstTextField(item, ["title", "summary", "text", "message", "description", "content"]);
}

function firstTextField(record: Record<string, unknown>, fields: string[]): string | null {
  const value = firstStringField(record, fields);
  if (!value) return null;
  return value.length > 240 ? `${value.slice(0, 240)}...` : value;
}

function firstStringField(record: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function recordField(record: Record<string, unknown>, field: string): Record<string, unknown> | null {
  const value = record[field];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function targetStringsFromFields(record: Record<string, unknown>, fields: string[]): string[] {
  const output = new Set<string>();
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed && (isUrl(trimmed) || looksLikeFilePath(trimmed))) output.add(trimmed);
      continue;
    }
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          const trimmed = entry.trim();
          if (trimmed && (isUrl(trimmed) || looksLikeFilePath(trimmed))) output.add(trimmed);
        } else if (entry && typeof entry === "object") {
          const target = firstStringField(entry as Record<string, unknown>, ["uri", "url", "path", "filePath", "target", "src"]);
          if (target && (isUrl(target) || looksLikeFilePath(target))) output.add(target);
        }
      }
    }
  }
  return [...output];
}

function recordsFromFields(record: Record<string, unknown>, fields: string[]): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = [];
  for (const field of fields) {
    const value = record[field];
    if (Array.isArray(value)) {
      output.push(...value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry))));
    } else if (value && typeof value === "object" && !Array.isArray(value)) {
      output.push(value as Record<string, unknown>);
    }
  }
  return output;
}

function itemId(item: CodexThreadItem, fallback: string): string {
  return firstStringField(item, ["id", "itemId", "callId", "requestId", "taskId"]) ?? fallback;
}

function taskRecords(item: CodexThreadItem): Array<Record<string, unknown>> {
  for (const field of ["items", "tasks", "todos"]) {
    const value = item[field];
    if (Array.isArray(value)) {
      return value.filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object"));
    }
  }
  return [];
}

function reasoningSummary(item: CodexThreadItem): string | null {
  const summary = item.summary;
  if (Array.isArray(summary)) {
    const parts = summary
      .map((entry) => typeof entry === "string" ? entry : firstTextField(entry as Record<string, unknown>, ["text", "summary"]))
      .filter(Boolean);
    return parts.at(-1) ?? null;
  }
  return firstTextField(item, ["summary", "text"]);
}

function normalizeProgressStatus(value: unknown): ThreadProgressItem["status"] {
  const normalized = typeof value === "string" ? value.toLowerCase().replace(/-/g, "_") : "";
  if (normalized === "completed" || normalized === "done" || normalized === "success") return "completed";
  if (normalized === "failed" || normalized === "error") return "failed";
  if (normalized === "pending" || normalized === "queued") return "pending";
  if (normalized === "in_progress" || normalized === "inprogress" || normalized === "running") return "in_progress";
  return "unknown";
}

function isUrl(value: string): boolean {
  return /^(https?|file):\/\//i.test(value);
}

function extractTargetsFromText(value: string): string[] {
  const targets = new Set<string>();
  for (const match of value.matchAll(/\b(?:https?|file):\/\/[^\s<>"')]+/gi)) {
    targets.add(cleanTrailingTargetPunctuation(match[0]));
  }
  for (const match of value.matchAll(/(?:^|[\s"'`(])((?:\.{1,2}\/|\/|~\/)[^\s"'`)]+|[A-Za-z0-9_.-]+\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]{1,8})/g)) {
    const candidate = cleanTrailingTargetPunctuation(match[1] ?? "");
    if (candidate && looksLikeFilePath(candidate)) targets.add(candidate);
  }
  return [...targets];
}

function cleanTrailingTargetPunctuation(value: string): string {
  return value.replace(/[),.;:]+$/g, "");
}

function looksLikeFilePath(value: string): boolean {
  if (!value || /\n/.test(value)) return false;
  if (/^(https?|data):\/\//i.test(value)) return false;
  if (/^(file):\/\//i.test(value)) return true;
  return (
    value.startsWith("/") ||
    value.startsWith("~/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    /\.[A-Za-z0-9]{1,8}$/.test(value)
  );
}

function titleFromTarget(value: string): string {
  try {
    if (isUrl(value)) {
      const url = new URL(value);
      return url.pathname.split("/").filter(Boolean).at(-1) ?? url.hostname;
    }
  } catch {
    // Fall through to path handling.
  }
  return value.split(/[\\/]/).filter(Boolean).at(-1) ?? value;
}

function humanizeKey(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (letter) => letter.toUpperCase()) || "Item";
}

const targetKeyNames = new Set([
  "file",
  "filepath",
  "filename",
  "href",
  "path",
  "source",
  "target",
  "uri",
  "url",
]);

const knownThreadItemTypes = new Set([
  "assistant-message",
  "exec",
  "generated-image",
  "mcp-tool-call",
  "patch",
  "plan-implementation",
  "proposed-plan",
  "reasoning",
  "sub-agent",
  "system-event",
  "todo-list",
  "tool-output",
  "user-message",
  "web-search",
]);

function commandVectorFromVoiceArgs(args: VoiceExecCommandArgs): string[] {
  const cmd = args.cmd.trim();
  if (!cmd) throw new Error("exec_command cmd is required.");
  const shell = args.shell?.trim() || process.env.SHELL || "/bin/zsh";
  const flag = args.login === false ? "-c" : "-lc";
  return [shell, flag, cmd];
}

function resolveVoiceWorkdir(workdir: string | null | undefined, projectFolderPath: string | null): string {
  const base = projectFolderPath ?? process.cwd();
  if (!workdir?.trim()) return base;
  return path.isAbsolute(workdir) ? workdir : path.resolve(base, workdir);
}

function voicePermissionProfile(
  mode: CodexPermissionMode,
  projectFolderPath: string | null,
): unknown | null {
  if (mode === "custom-config") return null;
  if (mode === "full-access") return { type: "disabled" };

  return workspaceWritePermissionProfile(projectFolderPath ?? process.cwd());
}

function workspaceWritePermissionProfile(projectFolderPath: string): unknown {
  const protectedSubpaths = [".git", ".agents", ".codex"].map((subpath) => path.join(projectFolderPath, subpath));
  return {
    type: "managed",
    network: { enabled: false },
    fileSystem: {
      type: "restricted",
      entries: [
        { path: { type: "special", value: { kind: "root" } }, access: "read" },
        { path: { type: "path", path: projectFolderPath }, access: "write" },
        { path: { type: "special", value: { kind: "tmpdir" } }, access: "write" },
        { path: { type: "special", value: { kind: "slash_tmp" } }, access: "write" },
        ...protectedSubpaths.map((protectedPath) => ({
          path: { type: "path", path: protectedPath },
          access: "read",
        })),
      ],
    },
  };
}

function normalizeYieldMs(value: number | null | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 1_000;
  return Math.max(0, Math.min(30_000, Math.floor(value)));
}

async function waitForVoiceSession(session: VoiceExecSession, yieldMs: number): Promise<void> {
  if (session.completedAt) return;
  await Promise.race([session.done, sleep(yieldMs)]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatVoiceExecResult(
  session: VoiceExecSession,
  startedAt: number,
  maxOutputTokens: number | null | undefined,
  consume: boolean,
): VoiceExecCommandResult {
  if (session.error) throw session.error;
  const output = consume ? session.output.slice(session.readOffset) : session.output;
  if (consume) session.readOffset = session.output.length;
  const approxTokens = approximateTokenCount(output);
  return {
    wall_time_seconds: (Date.now() - startedAt) / 1_000,
    ...(session.completedAt ? { exit_code: session.exitCode ?? 0 } : { session_id: session.sessionId }),
    original_token_count: approxTokens,
    output: truncateOutput(output, maxOutputTokens),
  };
}

function truncateOutput(output: string, maxOutputTokens: number | null | undefined): string {
  const maxTokens = typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens)
    ? Math.max(1, Math.floor(maxOutputTokens))
    : 6_000;
  const maxChars = maxTokens * 4;
  if (output.length <= maxChars) return output;
  return `${output.slice(0, maxChars)}\n[output truncated]`;
}

function approximateTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}

function finalAssistantTextFromTurn(turn: CodexThreadTurn): string | null {
  const agentMessages = (turn.items ?? []).filter((item) => {
    return normalizeThreadItemType(item) === "assistant-message" && textFromThreadMessageItem(item) !== null;
  });
  const finalMessage =
    [...agentMessages].reverse().find((item) => isFinalAssistantPhase(item.phase ?? item.status)) ??
    agentMessages[agentMessages.length - 1] ??
    null;
  return finalMessage ? textFromThreadMessageItem(finalMessage) : firstTextField(turn, [
    "finalAssistantText",
    "assistantText",
    "output",
    "message",
    "text",
  ]);
}

function userTextFromTurn(turn: CodexThreadTurn): string | null {
  const userMessages = (turn.items ?? [])
    .filter((item) => normalizeThreadItemType(item) === "user-message")
    .map(textFromThreadMessageItem)
    .filter((text): text is string => Boolean(text));
  if (userMessages.length > 0) return userMessages.join("\n\n");
  return firstTextField(turn, ["userText", "input", "prompt", "request"]);
}

function textFromThreadMessageItem(item: CodexThreadItem): string | null {
  const direct = firstStringField(item, ["text", "message", "content"]);
  if (direct) return direct;
  const content = item.content;
  if (Array.isArray(content)) {
    const text = content
      .map((part) =>
        typeof part === "string"
          ? part
          : part && typeof part === "object" && !Array.isArray(part)
            ? firstStringField(part as Record<string, unknown>, ["text", "content"])
            : null,
      )
      .filter(Boolean)
      .join("\n")
      .trim();
    return text || null;
  }
  return null;
}

function isFinalAssistantPhase(value: unknown): boolean {
  const normalized = typeof value === "string" ? value.toLowerCase().replace(/-/g, "_") : "";
  return normalized === "final_answer" || normalized === "final" || normalized === "completed" || normalized === "complete";
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function describeServerRequest(message: CodexJsonMessage): PendingCodexRequest {
  const params = (message.params ?? {}) as Record<string, unknown>;
  const method = message.method ?? "serverRequest";
  const requestId = message.id ?? "";

  if (method === "item/commandExecution/requestApproval") {
    const command = stringField(params.command);
    const details = detailList([
      detail("Command", command),
      detail("Directory", stringField(params.cwd)),
      detail("Reason", stringField(params.reason)),
      detail("Approval callback", stringField(params.approvalId)),
      detail("Network context", describeNetworkApprovalContext(params.networkApprovalContext)),
      detail("Parsed actions", describeCommandActions(params.commandActions)),
      detail("Proposed command rule", describeExecpolicyAmendment(params.proposedExecpolicyAmendment)),
      detail("Proposed network rule", describeNetworkPolicyAmendments(params.proposedNetworkPolicyAmendments)),
    ]);
    return {
      kind: "approval",
      requestId,
      method,
      threadId: stringField(params.threadId),
      turnId: stringField(params.turnId),
      itemId: stringField(params.itemId),
      title: "Command approval needed",
      subtitle: command ? "Shell command" : "Command execution",
      body: requestBody(stringField(params.reason), command ? `Command: ${command}` : null, "Codex wants to run a command."),
      details,
      options: ["accept", "acceptForSession", "decline", "cancel"],
      raw: message,
    };
  }

  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    const fileChanges =
      method === "applyPatchApproval" ? describeFileChanges(params.fileChanges) : undefined;
    const details = detailList([
      detail("Reason", stringField(params.reason)),
      detail("Requested write root", stringField(params.grantRoot)),
      detail("Files", fileChanges),
      detail("Call", stringField(params.callId)),
    ]);
    return {
      kind: "approval",
      requestId,
      method,
      threadId: stringField(params.threadId) || stringField(params.conversationId),
      turnId: stringField(params.turnId),
      itemId: stringField(params.itemId),
      title: "File change approval needed",
      subtitle: stringField(params.grantRoot) ? "Extra write access" : "File edit",
      body: requestBody(
        stringField(params.reason),
        fileChanges ? `Files: ${fileChanges}` : null,
        "Codex wants to apply file changes.",
      ),
      details,
      options: ["accept", "acceptForSession", "decline", "cancel"],
      raw: message,
    };
  }

  if (method === "item/tool/requestUserInput") {
    const questions = normalizeQuestions(params.questions);
    const questionBody = questions
      .map((question) => describeQuestionForBody(question))
      .filter(Boolean)
      .join("\n\n");
    return {
      kind: "question",
      requestId,
      method,
      threadId: stringField(params.threadId),
      turnId: stringField(params.turnId),
      itemId: stringField(params.itemId),
      title: questions.length === 1 ? questions[0].header || "Codex has a question" : "Codex has questions",
      subtitle: "Waiting on user input",
      body: questionBody || "Codex is waiting for user input.",
      details: detailList([detail("Questions", String(questions.length || 1))]),
      questions,
      raw: message,
    };
  }

  if (method === "mcpServer/elicitation/request") {
    const mode = stringField(params.mode);
    const details = detailList([
      detail("Server", stringField(params.serverName)),
      detail("Mode", mode),
      detail("URL", stringField(params.url)),
      detail("Elicitation", stringField(params.elicitationId)),
      detail("Schema", mode === "form" ? describeJsonValue(params.requestedSchema) : undefined),
    ]);
    return {
      kind: "elicitation",
      requestId,
      method,
      threadId: stringField(params.threadId),
      turnId: stringField(params.turnId),
      title: "MCP input needed",
      subtitle: stringField(params.serverName) ?? undefined,
      body: requestBody(stringField(params.message), stringField(params.url), "An MCP server is asking for input."),
      details,
      options: ["accept", "decline", "cancel"],
      raw: message,
    };
  }

  if (method === "item/permissions/requestApproval") {
    const details = detailList([
      detail("Directory", stringField(params.cwd)),
      detail("Reason", stringField(params.reason)),
      detail("Permissions", describePermissionProfile(params.permissions)),
    ]);
    return {
      kind: "approval",
      requestId,
      method,
      threadId: stringField(params.threadId),
      turnId: stringField(params.turnId),
      itemId: stringField(params.itemId),
      title: "Permission approval needed",
      subtitle: "Additional permissions",
      body: stringField(params.reason) || "Codex is requesting additional permissions.",
      details,
      options: ["accept", "acceptForSession", "decline", "cancel"],
      raw: message,
    };
  }

  if (method === "item/tool/call") {
    const details = detailList([
      detail("Namespace", stringField(params.namespace)),
      detail("Tool", stringField(params.tool)),
      detail("Arguments", describeJsonValue(params.arguments)),
    ]);
    return {
      kind: "tool",
      requestId,
      method,
      threadId: stringField(params.threadId),
      turnId: stringField(params.turnId),
      itemId: stringField(params.callId),
      title: "Tool call approval needed",
      subtitle: stringField(params.tool),
      body: stringField(params.tool)
        ? `Codex wants to use ${[stringField(params.namespace), stringField(params.tool)].filter(Boolean).join(".")}.`
        : "Codex wants to use a dynamic app-server tool.",
      details,
      options: ["accept", "decline", "cancel"],
      raw: message,
    };
  }

  if (method === "account/chatgptAuthTokens/refresh") {
    return {
      kind: "auth",
      requestId,
      method,
      title: "ChatGPT auth refresh needed",
      subtitle: "Account token refresh",
      body:
        "Codex app-server asked this client to refresh ChatGPT auth tokens. Codex Voice cannot refresh ChatGPT desktop auth tokens directly.",
      details: detailList([
        detail("Reason", stringField(params.reason)),
        detail("Previous account", stringField(params.previousAccountId)),
      ]),
      options: ["accept", "decline", "cancel"],
      raw: message,
    };
  }

  if (method === "execCommandApproval") {
    const command = Array.isArray(params.command) ? params.command.join(" ") : "";
    const details = detailList([
      detail("Command", command),
      detail("Directory", stringField(params.cwd)),
      detail("Reason", stringField(params.reason)),
      detail("Approval callback", stringField(params.approvalId)),
      detail("Call", stringField(params.callId)),
      detail("Parsed command", describeJsonValue(params.parsedCmd)),
    ]);
    return {
      kind: "approval",
      requestId,
      method,
      threadId: stringField(params.conversationId),
      title: "Command approval needed",
      subtitle: "Legacy command approval",
      body: requestBody(stringField(params.reason), command ? `Command: ${command}` : null, "Codex wants to run a command."),
      details,
      options: ["accept", "acceptForSession", "decline", "cancel"],
      raw: message,
    };
  }

  return {
    kind: "unknown",
    requestId,
    method,
    title: "Codex needs a response",
    subtitle: "Unsupported app-server request",
    body: method,
    details: detailList([detail("Params", describeJsonValue(params))]),
    options: ["cancel"],
    raw: message,
  };
}

function detail(label: string, value: string | undefined | null): PendingRequestDetail | null {
  if (!value?.trim()) return null;
  return { label, value: value.trim() };
}

function detailList(items: Array<PendingRequestDetail | null>): PendingRequestDetail[] {
  return items.filter((item): item is PendingRequestDetail => item !== null);
}

function requestBody(...parts: Array<string | null | undefined>): string {
  const fallback = parts.at(-1);
  const body = parts
    .slice(0, -1)
    .filter((part): part is string => Boolean(part?.trim()))
    .join("\n");
  return body || fallback || "Codex is waiting for a user response.";
}

function normalizeQuestions(value: unknown): PendingRequestQuestion[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((question, index): PendingRequestQuestion | null => {
      if (!question || typeof question !== "object") return null;
      const record = question as Record<string, unknown>;
      const options = Array.isArray(record.options)
        ? record.options
            .map((option): PendingRequestQuestionOption | null => {
              if (!option || typeof option !== "object") return null;
              const optionRecord = option as Record<string, unknown>;
              const label = stringField(optionRecord.label);
              if (!label) return null;
              return {
                label,
                description: stringField(optionRecord.description) ?? "",
              };
            })
            .filter((option): option is PendingRequestQuestionOption => option !== null)
        : null;
      return {
        id: stringField(record.id) ?? `question-${index + 1}`,
        header: stringField(record.header) ?? `Question ${index + 1}`,
        question: stringField(record.question) ?? "Codex is asking for input.",
        isOther: Boolean(record.isOther),
        isSecret: Boolean(record.isSecret),
        options,
      };
    })
    .filter((question): question is PendingRequestQuestion => question !== null);
}

function describeQuestionForBody(question: PendingRequestQuestion): string {
  const options = question.options?.length
    ? `Options: ${question.options.map((option) => option.label).join(", ")}`
    : null;
  return [question.header, question.question, options].filter(Boolean).join("\n");
}

function describeCommandActions(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value
    .map((action) => {
      if (!action || typeof action !== "object") return null;
      const record = action as Record<string, unknown>;
      const type = stringField(record.type) ?? "unknown";
      if (type === "read") {
        return `Read ${stringField(record.name) ?? "file"} at ${stringField(record.path) ?? "unknown path"}`;
      }
      if (type === "listFiles") {
        return `List files${stringField(record.path) ? ` in ${stringField(record.path)}` : ""}`;
      }
      if (type === "search") {
        return `Search${stringField(record.query) ? ` for ${stringField(record.query)}` : ""}${
          stringField(record.path) ? ` in ${stringField(record.path)}` : ""
        }`;
      }
      return stringField(record.command) ?? type;
    })
    .filter(Boolean)
    .join("; ");
}

function describeNetworkApprovalContext(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const host = stringField(record.host);
  const protocol = stringField(record.protocol);
  if (!host && !protocol) return undefined;
  return [protocol, host].filter(Boolean).join(" ");
}

function describeExecpolicyAmendment(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.map((entry) => String(entry)).join(" ");
}

function describeNetworkPolicyAmendments(value: unknown): string | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value
    .map((amendment) => {
      if (!amendment || typeof amendment !== "object") return null;
      const record = amendment as Record<string, unknown>;
      const action = stringField(record.action) ?? "allow";
      const host = stringField(record.host) ?? "unknown host";
      return `${action} ${host}`;
    })
    .filter(Boolean)
    .join("; ");
}

function describePermissionProfile(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const parts: string[] = [];
  const network = record.network as Record<string, unknown> | null | undefined;
  if (network && typeof network === "object") {
    parts.push(`network ${network.enabled === false ? "disabled" : "enabled"}`);
  }
  const fileSystem = record.fileSystem as Record<string, unknown> | null | undefined;
  if (fileSystem && typeof fileSystem === "object") {
    const read = Array.isArray(fileSystem.read) ? fileSystem.read.map(String).join(", ") : "";
    const write = Array.isArray(fileSystem.write) ? fileSystem.write.map(String).join(", ") : "";
    const entries = Array.isArray(fileSystem.entries) ? `${fileSystem.entries.length} entries` : "";
    if (read) parts.push(`read: ${read}`);
    if (write) parts.push(`write: ${write}`);
    if (entries) parts.push(entries);
  }
  return parts.join("; ") || describeJsonValue(value);
}

function describeFileChanges(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const names = Object.keys(value as Record<string, unknown>);
  if (names.length === 0) return undefined;
  return names.length <= 5 ? names.join(", ") : `${names.slice(0, 5).join(", ")} and ${names.length - 5} more`;
}

function describeJsonValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

type ServerRequestResponse =
  | { kind: "result"; result: unknown }
  | { kind: "error"; message: string };

function isAcceptDecision(decision: ApprovalDecision): boolean {
  return decision === "accept" || decision === "acceptForSession";
}

function responseForDecision(request: PendingCodexRequest, decision: ApprovalDecision): ServerRequestResponse {
  const method = request.method;
  if (method === "execCommandApproval" || method === "applyPatchApproval") {
    const legacy = {
      accept: "approved",
      acceptForSession: "approved_for_session",
      decline: "denied",
      cancel: "abort",
    } as const;
    return { kind: "result", result: { decision: legacy[decision] } };
  }
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
    return { kind: "result", result: { decision } };
  }
  if (method === "mcpServer/elicitation/request") {
    const action = decision === "cancel" ? "cancel" : decision === "decline" ? "decline" : "accept";
    return { kind: "result", result: { action, content: null, _meta: null } };
  }
  if (method === "item/permissions/requestApproval") {
    if (decision === "decline" || decision === "cancel") {
      return { kind: "error", message: `Permission request ${decision === "cancel" ? "cancelled" : "declined"}.` };
    }
    return {
      kind: "result",
      result: {
        permissions: permissionGrantFromRequest(request),
        scope: decision === "acceptForSession" ? "session" : "turn",
      },
    };
  }
  if (method === "item/tool/call") {
    return {
      kind: "result",
      result: {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "Codex Voice cannot service dynamic app-server tool calls yet.",
          },
        ],
      },
    };
  }
  if (method === "account/chatgptAuthTokens/refresh") {
    return {
      kind: "error",
      message:
        "Codex Voice cannot refresh ChatGPT auth tokens directly. Re-authenticate Codex from the desktop app or CLI, then retry.",
    };
  }
  return { kind: "error", message: `Unsupported Codex server request method: ${method}` };
}

function dynamicToolResponseFromMcpResult(result: unknown): ServerRequestResponse {
  const response = result as {
    content?: unknown;
    structuredContent?: unknown;
    isError?: boolean;
  };
  const contentItems = Array.isArray(response.content)
    ? response.content.map(dynamicContentItemFromMcpContent)
    : [];
  if (response.structuredContent !== undefined && response.structuredContent !== null) {
    contentItems.push({
      type: "inputText",
      text: describeJsonValue(response.structuredContent) ?? String(response.structuredContent),
    });
  }
  if (contentItems.length === 0) {
    contentItems.push({
      type: "inputText",
      text: response.isError ? "MCP tool returned an error with no content." : "MCP tool completed with no content.",
    });
  }
  return {
    kind: "result",
    result: {
      success: response.isError !== true,
      contentItems,
    },
  };
}

function dynamicContentItemFromMcpContent(content: unknown): { type: "inputText"; text: string } | { type: "inputImage"; imageUrl: string } {
  if (content && typeof content === "object") {
    const record = content as Record<string, unknown>;
    if (record.type === "text" && typeof record.text === "string") {
      return { type: "inputText", text: record.text };
    }
    if (record.type === "image") {
      const imageUrl = stringField(record.imageUrl);
      if (imageUrl) return { type: "inputImage", imageUrl };
      const data = stringField(record.data);
      const mimeType = stringField(record.mimeType) ?? "image/png";
      if (data) return { type: "inputImage", imageUrl: `data:${mimeType};base64,${data}` };
    }
  }
  return {
    type: "inputText",
    text: describeJsonValue(content) ?? String(content),
  };
}

function normalizeToolQuestionAnswers(
  request: PendingCodexRequest,
  answers: ToolQuestionAnswer[],
): ToolQuestionAnswer[] {
  const byQuestionId = new Map(
    answers.map((answer) => [
      answer.questionId,
      answer.answers.map((value) => value.trim()).filter(Boolean),
    ]),
  );
  const expectedQuestions = request.questions ?? [];
  if (expectedQuestions.length === 0) {
    const normalized = answers
      .map((answer) => ({
        questionId: answer.questionId,
        answers: answer.answers.map((value) => value.trim()).filter(Boolean),
      }))
      .filter((answer) => answer.answers.length > 0);
    if (normalized.length === 0) {
      throw new Error("Answer is required before resolving Codex's question.");
    }
    return normalized;
  }

  return expectedQuestions.map((question) => {
    const values = byQuestionId.get(question.id) ?? [];
    if (values.length === 0) {
      throw new Error(`Answer is required for "${question.header || question.question}".`);
    }
    return { questionId: question.id, answers: values };
  });
}

function permissionGrantFromRequest(request: PendingCodexRequest): Record<string, unknown> {
  const raw = request.raw as { params?: { permissions?: { network?: unknown; fileSystem?: unknown } } };
  const permissions = raw.params?.permissions ?? {};
  return {
    ...(permissions.network ? { network: permissions.network } : {}),
    ...(permissions.fileSystem ? { fileSystem: permissions.fileSystem } : {}),
  };
}

function statusFromNotification(method: string, params?: Record<string, unknown>): string | null {
  if (method === "turn/started") return "Codex started working.";
  if (method === "turn/completed") {
    const turn = (params?.turn ?? {}) as { status?: string };
    return completedTurnStatusText(turn.status);
  }
  if (method === "item/started") {
    const item = (params?.item ?? {}) as { type?: string; command?: string; server?: string; tool?: string; query?: string };
    const type = normalizeThreadItemType(item.type);
    if (type === "exec") return `Codex is running: ${item.command ?? "a command"}`;
    if (type === "patch") return "Codex is preparing file changes.";
    if (type === "mcp-tool-call") return `Codex is using ${item.server ?? "an app"} ${item.tool ?? "tool"}.`;
    if (type === "web-search") return `Codex is searching: ${item.query ?? "the web"}`;
    if (type === "sub-agent") return "Codex is coordinating a sub-agent.";
    if (type === "assistant-message") return "Codex is writing a response.";
    return `Codex started ${item.type ?? "work"}.`;
  }
  if (method === "item/completed") {
    const item = (params?.item ?? {}) as { type?: string };
    const type = normalizeThreadItemType(item.type);
    if (type === "exec") return "Codex finished a command.";
    if (type === "patch") return "Codex finished file changes.";
    if (type === "mcp-tool-call") return "Codex finished using an app tool.";
    if (type === "generated-image") return "Codex generated an image.";
  }
  if (method === "serverRequest/resolved") return "Codex request resolved.";
  if (method === "error") return "Codex reported an error.";
  return null;
}

function completedTurnStatusText(status: unknown): string {
  if (status === "failed") return "Codex turn failed.";
  if (status === "interrupted") return "Codex interrupted.";
  return "Codex finished.";
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function activeChatForProject(project: VoiceProject): VoiceChat | null {
  const chats = project.chats.filter((chat) => !chat.archivedAt);
  return (
    chats.find((chat) => chat.id === project.activeChatId) ??
    chats.find((chat) => chat.codexThreadId === project.codexThreadId) ??
    chats[0] ??
    null
  );
}

function titleFromText(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 48) || "Voice Project";
}

function parseSlashInput(text: string): { command: string; args: string[]; rest: string } {
  const raw = text.slice(1).trim();
  const firstSpace = raw.search(/\s/);
  const command = firstSpace === -1 ? raw : raw.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : raw.slice(firstSpace + 1).trim();
  return { command, args: rest ? rest.split(/\s+/) : [], rest };
}

function nativeSlashHelpText(): string {
  return [
    "Native Codex slash commands exposed in this debug app:",
    "/status - show thread, model/reasoning, context, and rate-limit state.",
    "/model [chat|next] [model|effort] [effort] - headless model picker.",
    "/fast [on|off|status] - show or update Fast mode for supported models.",
    "/review [base <branch>|commit <sha>|custom <instructions>] [detached] - start app-server review.",
    "/compact - compact the active Codex thread context.",
    "/mcp [verbose] - list MCP servers reported by app-server.",
    "/apps - list apps/connectors reported by app-server.",
    "/plugins - list plugins reported by app-server.",
    "/permissions [default|auto-review|full-access|custom-config] - show or update chat permission mode.",
    "/new [name] and /resume [projectId] - voice-project equivalents of Codex conversation controls.",
    "Recognized but UI-only or not wired yet: /feedback, /plan-mode, /diff, /init, /agent, /mention, /stop, /fork, /side, /clear, /copy, /quit.",
  ].join("\n");
}

function nativeUnsupportedSlashCommand(command: string): string | null {
  const messages: Record<string, string> = {
    feedback:
      "Recognized native /feedback. This debug UI does not open the Codex feedback dialog or upload logs yet.",
    "plan-mode":
      "Recognized native /plan-mode. The v0 voice app intentionally keeps Realtime as a voice layer around normal Codex execution, so plan-mode is not wired here yet.",
    plan:
      "Recognized native /plan. The v0 voice app intentionally routes tasks to Codex execution rather than switching this debug surface into plan mode.",
    diff: "Recognized native /diff. This debug UI does not render Codex's diff view yet.",
    init: "Recognized native /init. Ask Codex to create or update AGENTS.md as a normal task for now.",
    "sandbox-add-read-dir":
      "Recognized native /sandbox-add-read-dir. Extra sandbox readable roots are not wired into this debug UI yet.",
    agent: "Recognized native /agent. Subagent thread switching is not exposed in this debug UI yet.",
    mention: "Recognized native /mention. File attachment UI is not wired yet; include the path in your request for now.",
    personality: "Recognized native /personality. This voice app currently starts Codex with the friendly personality.",
    ps: "Recognized native /ps. Background terminal inventory is not exposed in this debug UI yet.",
    stop:
      "Recognized native /stop, which stops background terminals in Codex CLI. This debug app does not track those yet; use Interrupt to stop the active Codex turn.",
    fork: "Recognized native /fork. Forking Codex threads is not wired into the voice-project folder model yet.",
    side: "Recognized native /side. Side conversations are not wired into this debug UI yet.",
    clear: "Recognized native /clear. Use the Event Log Clear button for debug output; Codex thread history is unchanged.",
    copy: "Recognized native /copy. Copying the latest Codex output is not wired into this debug UI yet.",
    exit: "Recognized native /exit. This debug app does not close itself through slash commands.",
    quit: "Recognized native /quit. This debug app does not close itself through slash commands.",
    logout: "Recognized native /logout. Account logout is not exposed in this debug UI yet.",
    experimental: "Recognized native /experimental. Feature toggles are not exposed in this debug UI yet.",
    "debug-config": "Recognized native /debug-config. Config diagnostics are not rendered here yet; /status shows the effective basics.",
    statusline: "Recognized native /statusline. TUI status-line configuration does not apply to this debug UI.",
    title: "Recognized native /title. Terminal-title configuration does not apply to this debug UI.",
    keymap: "Recognized native /keymap. TUI keymap configuration does not apply to this debug UI.",
    interrupt: "Interrupt is a voice-app control rather than a native Codex slash command. Use the Interrupt button.",
    summarize: "Summarize is a voice-app action rather than a native Codex slash command. Use Summarize Active.",
  };
  return messages[command] ?? null;
}

function parseModelSlashArgs(
  args: string[],
  defaultScope: CodexSettingsScope,
): { scope: CodexSettingsScope; model?: string | null; reasoningEffort?: ReasoningEffort | null } {
  let scope = defaultScope;
  let tokens = [...args];
  if (isScopeToken(tokens[0])) {
    scope = scopeFromToken(tokens[0]);
    tokens = tokens.slice(1);
  }
  if (tokens.length > 1 && isScopeToken(tokens[tokens.length - 1])) {
    scope = scopeFromToken(tokens[tokens.length - 1]);
    tokens = tokens.slice(0, -1);
  }
  if (tokens.length === 0) {
    throw new Error("Missing model or reasoning effort for /model.");
  }

  const first = tokens[0].toLowerCase();
  if (first === "effort" || first === "reasoning") {
    const effortToken = tokens[1];
    if (!effortToken) throw new Error("Missing reasoning effort for /model.");
    return { scope, reasoningEffort: parseNullableReasoningEffort(effortToken) };
  }

  if (isResetToken(first)) {
    return { scope, model: null, reasoningEffort: null };
  }

  if (isReasoningEffortToken(first)) {
    return { scope, reasoningEffort: first as ReasoningEffort };
  }

  return {
    scope,
    model: tokens[0],
    ...(tokens[1] ? { reasoningEffort: parseNullableReasoningEffort(tokens[1]) } : {}),
  };
}

function parseReviewSlashArgs(args: string[]): { target: ReviewTarget; delivery?: "inline" | "detached" } {
  const tokens = [...args];
  let delivery: "inline" | "detached" | undefined;
  const deliveryIndex = tokens.findIndex((token) => ["inline", "detached"].includes(token.toLowerCase()));
  if (deliveryIndex !== -1) {
    delivery = tokens[deliveryIndex].toLowerCase() as "inline" | "detached";
    tokens.splice(deliveryIndex, 1);
  }

  const mode = tokens[0]?.toLowerCase();
  if (!mode) return { target: { type: "uncommittedChanges" }, delivery };
  if (mode === "base" || mode === "branch") {
    const branch = tokens[1];
    if (!branch) throw new Error("Missing branch for /review base <branch>.");
    return { target: { type: "baseBranch", branch }, delivery };
  }
  if (mode === "commit") {
    const sha = tokens[1];
    if (!sha) throw new Error("Missing sha for /review commit <sha>.");
    const title = tokens.slice(2).join(" ").trim() || null;
    return { target: { type: "commit", sha, title }, delivery };
  }
  if (mode === "custom") {
    const instructions = tokens.slice(1).join(" ").trim();
    if (!instructions) throw new Error("Missing instructions for /review custom <instructions>.");
    return { target: { type: "custom", instructions }, delivery };
  }
  return { target: { type: "custom", instructions: tokens.join(" ") }, delivery };
}

function isScopeToken(value: string | undefined): value is string {
  return value === "chat" || value === "next" || value === "nextturn" || value === "next-turn";
}

function scopeFromToken(value: string): CodexSettingsScope {
  return value === "next" || value === "nextturn" || value === "next-turn" ? "nextTurn" : "chat";
}

function isResetToken(value: string): boolean {
  return value === "default" || value === "reset" || value === "clear";
}

function isReasoningEffortToken(value: string): value is ReasoningEffort {
  return ["none", "minimal", "low", "medium", "high", "xhigh"].includes(value);
}

function parseNullableReasoningEffort(value: string): ReasoningEffort | null {
  const lower = value.toLowerCase();
  return isResetToken(lower) ? null : (lower as ReasoningEffort);
}

function formatModelList(models: CodexModelSummary[]): string {
  if (models.length === 0) return "No Codex models were returned by app-server.";
  return models
    .map((model) => {
      const efforts = model.supportedReasoningEfforts.map((effort) => effort.reasoningEffort).join(", ");
      const speed = model.serviceTiers.some((tier) => tier.name.toLowerCase() === "fast") ? " + Fast" : "";
      return `${model.model}${model.isDefault ? " (default)" : ""}: ${
        efforts || model.defaultReasoningEffort
      }${speed}`;
    })
    .join("\n");
}

function describeReviewTarget(target: ReviewTarget): string {
  if (target.type === "uncommittedChanges") return "uncommitted changes";
  if (target.type === "baseBranch") return `base branch ${target.branch}`;
  if (target.type === "commit") return `commit ${target.sha}`;
  return "custom instructions";
}

function describeThreadStatus(status: unknown): string {
  if (!status || typeof status !== "object") return "unknown";
  const value = status as { type?: string; activeFlags?: unknown[] };
  if (value.type === "active") return `active (${value.activeFlags?.length ?? 0} flags)`;
  return value.type ?? "unknown";
}

function formatTokenUsage(usage: CodexThreadTokenUsage | null): string {
  if (!usage) return "no token usage reported yet";
  const total = usage.total.totalTokens;
  if (!usage.modelContextWindow) return `${total.toLocaleString()} tokens used`;
  const percent = Math.round((total / usage.modelContextWindow) * 100);
  return `${total.toLocaleString()} / ${usage.modelContextWindow.toLocaleString()} tokens (${percent}%), last turn ${usage.last.totalTokens.toLocaleString()}`;
}

function formatRateLimit(value: unknown): string {
  if (!value || typeof value !== "object") return "not reported";
  const snapshot = value as {
    limitName?: string | null;
    primary?: { usedPercent?: number; resetsAt?: number | null } | null;
    secondary?: { usedPercent?: number; resetsAt?: number | null } | null;
    credits?: { hasCredits?: boolean; unlimited?: boolean; balance?: string | null } | null;
    planType?: string | null;
  };
  const primary = snapshot.primary
    ? `${Math.round(snapshot.primary.usedPercent ?? 0)}% used${formatResetTime(snapshot.primary.resetsAt)}`
    : "primary not reported";
  const secondary = snapshot.secondary
    ? `, secondary ${Math.round(snapshot.secondary.usedPercent ?? 0)}% used${formatResetTime(snapshot.secondary.resetsAt)}`
    : "";
  const credits = snapshot.credits
    ? `, credits ${snapshot.credits.unlimited ? "unlimited" : snapshot.credits.balance ?? (snapshot.credits.hasCredits ? "available" : "none")}`
    : "";
  return `${snapshot.limitName ?? "codex"} (${snapshot.planType ?? "unknown"}): ${primary}${secondary}${credits}`;
}

function formatResetTime(resetsAt: number | null | undefined): string {
  if (typeof resetsAt !== "number") return "";
  return `, resets ${new Date(resetsAt * 1000).toLocaleTimeString()}`;
}

function formatConfigValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "default";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

function isFastServiceTier(value: string | null | undefined): boolean {
  return value === FAST_CODEX_SERVICE_TIER || value === "fast";
}

function formatServiceTier(value: string | null | undefined): string {
  return isFastServiceTier(value) ? "Fast" : "Standard";
}

function formatMcpServers(
  servers: Array<{ name: string; tools?: Record<string, unknown>; authStatus?: string }>,
  verbose: boolean,
): string {
  if (servers.length === 0) return "No MCP servers reported by app-server.";
  return [
    verbose ? "MCP servers (verbose)" : "MCP servers",
    ...servers.map((server) => {
      const toolNames = Object.keys(server.tools ?? {});
      const suffix = verbose && toolNames.length > 0 ? `: ${toolNames.slice(0, 12).join(", ")}` : "";
      return `${server.name} - ${server.authStatus ?? "auth unknown"} - ${toolNames.length} tools${suffix}`;
    }),
  ].join("\n");
}

function formatApps(
  apps: Array<{ id: string; name: string; isEnabled: boolean; isAccessible: boolean; pluginDisplayNames?: string[] }>,
): string {
  if (apps.length === 0) return "No apps/connectors reported by app-server.";
  return [
    "Apps/connectors",
    ...apps.map((app) => {
      const state = [app.isEnabled ? "enabled" : "disabled", app.isAccessible ? "accessible" : "not accessible"].join(", ");
      const plugins = app.pluginDisplayNames?.length ? ` via ${app.pluginDisplayNames.join(", ")}` : "";
      return `${app.name} (${app.id}) - ${state}${plugins}`;
    }),
  ].join("\n");
}

function formatPlugins(
  marketplaces: Array<{
    name: string;
    plugins?: Array<{ id: string; name: string; installed: boolean; enabled: boolean }>;
  }>,
  errors: unknown[],
): string {
  const pluginLines = marketplaces.flatMap((marketplace) =>
    (marketplace.plugins ?? []).map(
      (plugin) =>
        `${plugin.name} (${plugin.id}) - ${plugin.installed ? "installed" : "not installed"}, ${
          plugin.enabled ? "enabled" : "disabled"
        } - ${marketplace.name}`,
    ),
  );
  return [
    "Plugins",
    ...(pluginLines.length > 0 ? pluginLines : ["No plugins reported by app-server."]),
    ...(errors.length > 0 ? [`Marketplace load errors: ${errors.length}`] : []),
  ].join("\n");
}

function settingsText(settings: CodexSettings): string {
  const effectiveNextModel =
    settings.nextTurnModel ?? settings.chatModel ?? settings.defaultModel ?? "default";
  const effectiveNextEffort =
    settings.nextTurnReasoningEffort ??
    settings.chatReasoningEffort ??
    settings.defaultReasoningEffort ??
    "default";
  const effectiveNextServiceTier =
    settings.nextTurnServiceTier ?? settings.chatServiceTier ?? settings.defaultServiceTier;
  const effectiveNextPermissions =
    settings.nextTurnPermissionMode ?? settings.chatPermissionMode ?? settings.defaultPermissionMode;
  return [
    `Current chat default: model ${settings.chatModel ?? settings.defaultModel ?? "default"}, reasoning ${
      settings.chatReasoningEffort ?? settings.defaultReasoningEffort ?? "default"
    }, speed ${formatServiceTier(settings.chatServiceTier)}, permissions ${
      permissionProfile(settings.chatPermissionMode).displayName
    }.`,
    `Next turn: model ${effectiveNextModel}, reasoning ${effectiveNextEffort}, speed ${formatServiceTier(
      effectiveNextServiceTier,
    )}, permissions ${
      permissionProfile(effectiveNextPermissions).displayName
    }.`,
    `Active turn: model ${settings.activeTurnModel ?? "none"}, reasoning ${
      settings.activeTurnReasoningEffort ?? "none"
    }, speed ${formatServiceTier(settings.activeTurnServiceTier)}, permissions ${
      settings.activeTurnPermissionMode ? permissionProfile(settings.activeTurnPermissionMode).displayName : "none"
    }.`,
  ].join("\n");
}

function permissionProfile(mode: CodexPermissionMode) {
  return (
    CODEX_PERMISSION_PROFILES.find((profile) => profile.mode === mode) ??
    CODEX_PERMISSION_PROFILES[0]
  );
}

type CodexPermissionParams = {
  approvalPolicy?: CodexApprovalPolicy;
  approvalsReviewer?: CodexApprovalsReviewer;
  sandbox?: CodexSandboxMode;
};

function threadPermissionParams(mode: CodexPermissionMode): CodexPermissionParams {
  return codexPermissionParams(mode);
}

function turnPermissionParams(mode: CodexPermissionMode): CodexPermissionParams {
  return codexPermissionParams(mode);
}

function codexPermissionParams(mode: CodexPermissionMode): CodexPermissionParams {
  const profile = permissionProfile(mode);
  return {
    ...(profile.approvalPolicy ? { approvalPolicy: profile.approvalPolicy } : {}),
    ...(profile.approvalsReviewer ? { approvalsReviewer: profile.approvalsReviewer } : {}),
    ...(profile.sandbox ? { sandbox: profile.sandbox } : {}),
  };
}

function formatPermissionValue(value: string | null): string {
  return value ?? "config.toml";
}

function permissionModeFromText(text: string): CodexPermissionMode {
  const normalized = text.trim().toLowerCase().replace(/[_\s]+/g, "-");
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
  throw new Error("Unknown permission mode. Use default, auto-review, full-access, or custom-config.");
}

function isMissingCodexThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found for thread id/i.test(message) || /unknown thread/i.test(message);
}

function projectWorkspacePath(project: VoiceProject): string {
  return project.workspacePath || project.folderPath;
}

async function resolveWorkspacePathInput(value: string | null | undefined): Promise<string | null> {
  const raw = value?.trim();
  if (!raw) return null;
  const resolved = path.resolve(expandHomePath(raw));
  const info = await stat(resolved).catch((error: unknown) => {
    throw new Error(
      `Workspace path is not accessible: ${resolved} (${error instanceof Error ? error.message : String(error)})`,
    );
  });
  if (!info.isDirectory()) {
    throw new Error(`Workspace path is not a directory: ${resolved}`);
  }
  return resolved;
}

async function inferWorkspacePathFromText(text: string): Promise<string | null> {
  const candidates = workspacePathCandidates(text);
  for (const candidate of candidates) {
    try {
      return await resolveWorkspacePathInput(candidate);
    } catch {
      // Ignore path-like phrases that do not resolve to a real directory.
    }
  }
  return null;
}

function workspacePathCandidates(text: string): string[] {
  const candidates: string[] = [];
  const quotedPath = /["'`]((?:~\/|\/)[^"'`]+)["'`]/g;
  for (const match of text.matchAll(quotedPath)) {
    candidates.push(match[1]);
  }

  const pathLike = /(?:^|\s)((?:~\/|\/)[^\s,.;:!?]+)/g;
  for (const match of text.matchAll(pathLike)) {
    candidates.push(match[1]);
  }

  const workspaceRelative = /(?:^|\s)(workspace\/[A-Za-z0-9._/-]+)/gi;
  for (const match of text.matchAll(workspaceRelative)) {
    candidates.push(`~/${match[1]}`);
  }

  return [...new Set(candidates.map((candidate) => candidate.replace(/[)\]}]+$/, "")))];
}

function expandHomePath(value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) {
    const home = process.env.HOME;
    return home ? path.join(home, value.slice(2)) : value;
  }
  return value;
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function codexTurnText(userText: string): string {
  return userText;
}
