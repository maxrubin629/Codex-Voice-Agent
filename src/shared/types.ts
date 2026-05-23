export type ReasoningEffort = "none" | "minimal" | "low" | "medium" | "high" | "xhigh";
export type CodexServiceTier = string;
export type CodexApprovalPolicy = "untrusted" | "on-failure" | "on-request" | "never";
export type CodexApprovalsReviewer = "user" | "auto_review";
export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexPermissionMode = "default" | "auto-review" | "full-access" | "custom-config";
export type RealtimeReasoningEffort = Extract<
  ReasoningEffort,
  "minimal" | "low" | "medium" | "high" | "xhigh"
>;

export const REALTIME_MODEL_OPTIONS = [
  {
    model: "gpt-realtime-2",
    displayName: "GPT Realtime 2",
    description: "Reasoning voice model",
  },
  {
    model: "gpt-realtime-1.5",
    displayName: "GPT Realtime 1.5",
    description: "Flagship audio model",
  },
] as const;

export type RealtimeModelId = (typeof REALTIME_MODEL_OPTIONS)[number]["model"];
export const DEFAULT_REALTIME_MODEL: RealtimeModelId = "gpt-realtime-2";

export const REALTIME_VOICE_OPTIONS = [
  {
    voice: "marin",
    displayName: "Marin",
    description: "Warm and composed",
  },
  {
    voice: "cedar",
    displayName: "Cedar",
    description: "Grounded and calm",
  },
  {
    voice: "verse",
    displayName: "Verse",
    description: "Bright and fluid",
  },
  {
    voice: "coral",
    displayName: "Coral",
    description: "Clear and lively",
  },
  {
    voice: "sage",
    displayName: "Sage",
    description: "Measured and soft",
  },
  {
    voice: "ballad",
    displayName: "Ballad",
    description: "Expressive and gentle",
  },
  {
    voice: "ash",
    displayName: "Ash",
    description: "Low and steady",
  },
  {
    voice: "shimmer",
    displayName: "Shimmer",
    description: "Light and crisp",
  },
  {
    voice: "alloy",
    displayName: "Alloy",
    description: "Balanced and direct",
  },
  {
    voice: "echo",
    displayName: "Echo",
    description: "Smooth and focused",
  },
] as const;

export type RealtimeVoiceId = (typeof REALTIME_VOICE_OPTIONS)[number]["voice"];
export const DEFAULT_REALTIME_VOICE: RealtimeVoiceId = "marin";
export const DEFAULT_REALTIME_REASONING_EFFORT: RealtimeReasoningEffort = "low";
export const REALTIME_REASONING_EFFORT_OPTIONS: RealtimeReasoningEffort[] = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
];

export type CodexPermissionProfile = {
  mode: CodexPermissionMode;
  displayName: string;
  description: string;
  approvalPolicy: CodexApprovalPolicy | null;
  approvalsReviewer: CodexApprovalsReviewer | null;
  sandbox: CodexSandboxMode | null;
};

export const DEFAULT_CODEX_MODEL = "gpt-5.5";
export const DEFAULT_CODEX_REASONING_EFFORT: ReasoningEffort = "medium";
export const DEFAULT_CODEX_SERVICE_TIER: CodexServiceTier | null = null;
export const FAST_CODEX_SERVICE_TIER: CodexServiceTier = "priority";
export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = "auto-review";

export const CODEX_PERMISSION_PROFILES: CodexPermissionProfile[] = [
  {
    mode: "default",
    displayName: "Default permissions",
    description: "Workspace-write sandbox; Codex turns ask when approval is needed.",
    approvalPolicy: "on-request",
    approvalsReviewer: "user",
    sandbox: "workspace-write",
  },
  {
    mode: "auto-review",
    displayName: "Auto-review",
    description: "Workspace-write sandbox with eligible Codex approvals auto-reviewed.",
    approvalPolicy: "on-request",
    approvalsReviewer: "auto_review",
    sandbox: "workspace-write",
  },
  {
    mode: "full-access",
    displayName: "Full access",
    description: "Run without approval prompts or filesystem sandboxing.",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: "danger-full-access",
  },
  {
    mode: "custom-config",
    displayName: "Custom (config.toml)",
    description: "Use approval and sandbox settings from the active Codex config.",
    approvalPolicy: null,
    approvalsReviewer: null,
    sandbox: null,
  },
];

export type CodexModelSummary = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  hidden: boolean;
  defaultReasoningEffort: ReasoningEffort;
  supportedReasoningEfforts: Array<{
    reasoningEffort: ReasoningEffort;
    description: string;
  }>;
  additionalSpeedTiers: string[];
  serviceTiers: Array<{
    id: string;
    name: string;
    description: string;
  }>;
};

export type CodexSettingsScope = "chat" | "nextTurn";

export type CodexSettings = {
  chatModel: string | null;
  chatReasoningEffort: ReasoningEffort | null;
  chatServiceTier: CodexServiceTier | null;
  chatPermissionMode: CodexPermissionMode;
  nextTurnModel: string | null;
  nextTurnReasoningEffort: ReasoningEffort | null;
  nextTurnServiceTier: CodexServiceTier | null;
  nextTurnPermissionMode: CodexPermissionMode | null;
  activeTurnModel: string | null;
  activeTurnReasoningEffort: ReasoningEffort | null;
  activeTurnServiceTier: CodexServiceTier | null;
  activeTurnPermissionMode: CodexPermissionMode | null;
  defaultModel: string | null;
  defaultReasoningEffort: ReasoningEffort | null;
  defaultServiceTier: CodexServiceTier | null;
  defaultPermissionMode: CodexPermissionMode;
  models: CodexModelSummary[];
};

export type McpOkGrant = {
  server: string;
  tool: string;
  grantedAt: string;
  updatedAt: string;
};

export type CodexTodoStatus = "pending" | "in_progress" | "completed";

export type CodexTodoItem = {
  id: string;
  text: string;
  status: CodexTodoStatus;
  raw: unknown;
};

export type VoiceSubagentThread = {
  id: string;
  displayName: string;
  threadId: string;
  status: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  raw?: unknown;
};

export type VoiceSubagentSummary = {
  id: string;
  parentChatId: string;
  parentChatName: string;
  title: string;
  threadId: string;
  detail: string;
  status: string | null;
  activeTurnId: string | null;
  threadStatus: string | null;
  source: "stored" | "turn-output";
};

export type VoiceSubagentListResult = {
  chatId: string;
  chatName: string;
  subagents: VoiceSubagentSummary[];
};

export type VoiceSubagentInspectResult = {
  subagent: VoiceSubagentSummary;
  summary: ActiveThreadSummary;
};

export type VoiceSubagentSteerResult = {
  subagent: VoiceSubagentSummary;
  turnId: string;
};

export type CodexTurnOutput = {
  threadId: string;
  turnId: string;
  status: string;
  finalAssistantText: string;
  nextQueuedRequestText?: string;
  items?: unknown[];
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  errorMessage?: string;
};

export type ThreadSummaryItem = {
  id: string;
  type: string;
  status: string | null;
  label: string;
  detail: string | null;
  raw: unknown;
};

export type ThreadProgressItem = {
  id: string;
  label: string;
  detail: string | null;
  status: "pending" | "in_progress" | "completed" | "failed" | "unknown";
  sourceType: string;
  raw: unknown;
};

export type ThreadArtifactCandidate = {
  id: string;
  kind: "file" | "url" | "resource" | "text" | "unknown";
  title: string;
  subtitle: string | null;
  path?: string;
  url?: string;
  mimeType?: string | null;
  sourceType: string;
  raw: unknown;
};

export type ThreadSourceCandidate = {
  id: string;
  kind: "web" | "file" | "tool" | "resource" | "unknown";
  title: string;
  subtitle: string | null;
  url?: string;
  path?: string;
  sourceType: string;
  raw: unknown;
};

export type ThreadSummaryTurn = {
  id: string;
  status: string;
  startedAt: number | null;
  completedAt: number | null;
  durationMs: number | null;
  userText: string | null;
  assistantText: string | null;
  itemCount: number;
  items: ThreadSummaryItem[];
  errorMessage?: string;
};

export type ActiveThreadSummary = {
  status: "ready" | "empty" | "error";
  errorMessage?: string;
  projectId: string | null;
  projectName: string | null;
  workspacePath: string | null;
  chatId: string | null;
  chatName: string | null;
  threadId: string | null;
  turnCount: number;
  latestTurnStatus: string | null;
  latestAssistantText: string | null;
  progress: ThreadProgressItem[];
  artifacts: ThreadArtifactCandidate[];
  sources: ThreadSourceCandidate[];
  referencedFiles: ThreadArtifactCandidate[];
  turns: ThreadSummaryTurn[];
  rawUnknownItems: unknown[];
};

export const CODEX_TEXT_INGRESS_MARKER = "Codex ===\n";

export type VoiceChat = {
  id: string;
  displayName: string;
  codexThreadId: string | null;
  voiceBridgePromptInjectedAt: string | null;
  subagents?: VoiceSubagentThread[];
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  serviceTier: CodexServiceTier | null;
  permissionMode: CodexPermissionMode;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  lastSummary: string | null;
  lastStatus: string | null;
  lastTurnOutput: CodexTurnOutput | null;
};

export type VoiceProject = {
  id: string;
  displayName: string;
  folderPath: string;
  workspacePath: string;
  activeChatId: string | null;
  chats: VoiceChat[];
  /** Compatibility alias for the active chat's Codex thread id. */
  codexThreadId: string | null;
  model: string | null;
  reasoningEffort: ReasoningEffort | null;
  serviceTier: CodexServiceTier | null;
  permissionMode: CodexPermissionMode;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  lastSummary: string | null;
  lastStatus: string | null;
};

export type SelectedWorkspaceFolder = {
  path: string;
  name: string;
};

export type CodexChatRuntime = {
  chatId: string;
  threadId: string | null;
  displayName: string;
  todos: CodexTodoItem[];
  activeTurnId: string | null;
  status: string;
  threadStatus: string | null;
  tokenUsage: CodexThreadTokenUsage | null;
  pendingRequests: PendingCodexRequest[];
  activeTurnModel: string | null;
  activeTurnReasoningEffort: ReasoningEffort | null;
  activeTurnServiceTier: CodexServiceTier | null;
};

export type CodexRuntimeState = {
  ready: boolean;
  activeProjectId: string | null;
  activeChatId: string | null;
  activeTurnId: string | null;
  status: string;
  threadStatus: string | null;
  tokenUsage: CodexThreadTokenUsage | null;
  pendingRequests: PendingCodexRequest[];
  chats: CodexChatRuntime[];
  showProjectChats: boolean;
};

export type CodexTokenUsageBreakdown = {
  totalTokens: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

export type CodexThreadTokenUsage = {
  total: CodexTokenUsageBreakdown;
  last: CodexTokenUsageBreakdown;
  modelContextWindow: number | null;
};

export type PendingRequestKind =
  | "approval"
  | "question"
  | "elicitation"
  | "tool"
  | "auth"
  | "unknown";

export type PendingRequestDetail = {
  label: string;
  value: string;
};

export type PendingRequestQuestionOption = {
  label: string;
  description: string;
};

export type PendingRequestQuestion = {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: PendingRequestQuestionOption[] | null;
};

export type PendingCodexRequest = {
  kind: PendingRequestKind;
  requestId: number | string;
  method: string;
  projectId?: string;
  projectName?: string;
  chatId?: string;
  chatName?: string;
  threadId?: string;
  turnId?: string;
  itemId?: string;
  title: string;
  subtitle?: string;
  body: string;
  details?: PendingRequestDetail[];
  questions?: PendingRequestQuestion[];
  options?: string[];
  raw: unknown;
};

export type AppState = {
  baseFolder: string;
  projects: VoiceProject[];
  archivedProjects: VoiceProject[];
  activeProject: VoiceProject | null;
  runtime: CodexRuntimeState;
  codexSettings: CodexSettings;
  mcpOkGrants: McpOkGrant[];
  realtime: {
    available: boolean;
    model: RealtimeModelId;
    voice: RealtimeVoiceId;
    reasoningEffort: RealtimeReasoningEffort | null;
    reason: string | null;
    apiKeySource: "environment" | "saved" | null;
    apiKeyEncrypted: boolean;
  };
  phone: PhoneStatus;
  replay: ReplayRecordingState;
};

export type PhoneSettings = {
  enabled: boolean;
  webhookPath: string;
  localPort: number;
  publicUrl: string | null;
  allowUnsignedDevWebhooks: boolean;
  webhookSecretConfigured: boolean;
  allowedCallerNumbers: string[];
};

export type PhoneSettingsUpdate = Partial<Omit<PhoneSettings, "webhookSecretConfigured">> & {
  webhookSecret?: string | null;
};

export type PhoneCallLogEntry = {
  id: string;
  callId: string | null;
  from: string | null;
  at: string;
  status: "accepted" | "rejected" | "ended" | "error";
  reason: string;
};

export type ActivePhoneCall = {
  callId: string;
  from: string | null;
  startedAt: string;
  status: "accepting" | "active" | "ending";
};

export type PhoneStatus = {
  settings: PhoneSettings;
  listener: {
    running: boolean;
    url: string | null;
    error: string | null;
  };
  activeCall: ActivePhoneCall | null;
  logs: PhoneCallLogEntry[];
};

export type CodexActionResult = {
  kind: "turn" | "command";
  message: string;
  turnId: string | null;
  project: VoiceProject | null;
  chat: VoiceChat | null;
};

export type CodexRequestOptions = {
  source?: "typed" | "realtime";
  transcriptDelta?: string | null;
};

export type QueuedCodexRequestResult = {
  queued: boolean;
  queuedId: string | null;
  message: string;
  chatId: string | null;
  turnId: string | null;
  position: number;
  text: string;
  started?: CodexActionResult;
};

export type CancelQueuedCodexRequestResult = {
  cancelled: boolean;
  queuedId: string;
  message: string;
  chatId: string | null;
  threadId: string | null;
  remaining: number;
  text: string;
};

export type AppEvent = {
  at: string;
  source: "app" | "codex" | "realtime";
  kind: string;
  message: string;
  raw?: unknown;
};

export type ReplaySessionMetadata = {
  id: string;
  name: string;
  projectId: string;
  projectName: string;
  chatId: string | null;
  chatName: string | null;
  threadId: string | null;
  startedAt: string;
  stoppedAt: string | null;
  eventCount: number;
};

export type ReplayRecordingState = {
  active: ReplaySessionMetadata | null;
};

export type ReplaySessionLoadResult = {
  metadata: ReplaySessionMetadata;
  events: AppEvent[];
};

export type VoiceTranscriptMessageSource = "realtime" | "codex" | "app";
export type VoiceTranscriptMessageRole = "user" | "assistant";
export type VoiceTranscriptMessageStatus = "completed" | "streaming" | "interrupted" | "error";

export type VoiceTranscriptMessage = {
  id: string;
  chatId: string;
  threadId: string | null;
  source: VoiceTranscriptMessageSource;
  role: VoiceTranscriptMessageRole;
  text: string;
  createdAt: string;
  completedAt: string | null;
  status: VoiceTranscriptMessageStatus;
  turnId?: string;
  responseId?: string;
  itemId?: string;
  metadata?: Record<string, unknown>;
};

export type RealtimeContextScope =
  | "startup"
  | "active_focus"
  | "current_thread"
  | "recent_work"
  | "workspace_map"
  | "subagents"
  | "plugins"
  | "all";

export type RealtimeContextRequest = {
  scope?: RealtimeContextScope;
  chatId?: string;
  chatName?: string;
};

export type RealtimeContextPluginSummary = {
  id: string;
  name: string;
  marketplace: string | null;
  installed: boolean;
  enabled: boolean;
};

export type RealtimeContextMcpServerSummary = {
  name: string;
  authStatus: string | null;
  toolNames: string[];
};

export type RealtimeContextAppSummary = {
  id: string;
  name: string;
  enabled: boolean;
  accessible: boolean;
  pluginDisplayNames: string[];
};

export type RealtimeContextInventory = {
  plugins: RealtimeContextPluginSummary[];
  mcpServers: RealtimeContextMcpServerSummary[];
  apps: RealtimeContextAppSummary[];
  errors: string[];
};

export type RealtimeContextResult = {
  ok: boolean;
  scope: RealtimeContextScope;
  text: string;
  fingerprint: string | null;
  generatedAt: string;
  errorMessage?: string;
};

export type WindowChromeState = {
  isFullScreen: boolean;
};

export type ApprovalDecision = "accept" | "acceptForSession" | "decline" | "cancel";

export type ToolQuestionAnswer = {
  questionId: string;
  answers: string[];
};

export type RealtimeClientSecret = {
  value: string;
  expiresAt?: number;
  model: RealtimeModelId;
  voice: RealtimeVoiceId;
  reasoningEffort: RealtimeReasoningEffort | null;
  startupContextIncluded?: boolean;
  startupContextFingerprint?: string | null;
};

export type CodexVoiceApi = {
  getState(): Promise<AppState>;
  openVoiceWindow(): Promise<void>;
  getWindowChromeState(): Promise<WindowChromeState>;
  expandVoiceWindowForRightPane(): Promise<boolean>;
  collapseVoiceWindowFromRightPane(): Promise<boolean>;
  openDebugWindow(): Promise<void>;
  getEvents(): Promise<AppEvent[]>;
  clearEvents(): Promise<void>;
  logEvent(event: AppEvent): Promise<void>;
  listReplaySessions(projectId?: string): Promise<ReplaySessionMetadata[]>;
  getReplayRecordingState(): Promise<ReplayRecordingState>;
  startReplayRecording(name?: string): Promise<ReplaySessionMetadata>;
  stopReplayRecording(): Promise<ReplaySessionMetadata | null>;
  loadReplaySession(projectId: string, replayId: string): Promise<ReplaySessionLoadResult>;
  renameReplaySession(projectId: string, replayId: string, name: string): Promise<ReplaySessionMetadata>;
  deleteReplaySession(projectId: string, replayId: string): Promise<void>;
  deleteAllReplaySessions(projectId?: string): Promise<void>;
  selectWorkspaceFolder(): Promise<SelectedWorkspaceFolder | null>;
  setWorkspaceFolder(workspacePath: string, name?: string | null): Promise<VoiceProject>;
  createProject(name?: string, workspacePath?: string | null): Promise<VoiceProject>;
  resumeProject(projectId: string): Promise<VoiceProject>;
  archiveProject(projectId: string): Promise<VoiceProject>;
  restoreProject(projectId: string): Promise<VoiceProject>;
  createChat(name: string, projectId?: string): Promise<VoiceProject>;
  switchChat(chatId: string, projectId?: string): Promise<VoiceProject>;
  archiveChat(chatId: string, projectId?: string): Promise<VoiceProject>;
  restoreChat(chatId: string, projectId?: string): Promise<VoiceProject>;
  listChats(projectId?: string): Promise<VoiceChat[]>;
  showProjectChats(open?: boolean): Promise<void>;
  summarizeProject(projectId?: string, chatId?: string): Promise<string>;
  sendToCodex(
    text: string,
    chatId?: string,
    workspacePath?: string | null,
    options?: CodexRequestOptions,
  ): Promise<CodexActionResult>;
  steerCodex(text: string, chatId?: string): Promise<{ turnId: string }>;
  queueCodexRequest(
    text: string,
    chatId?: string,
    workspacePath?: string | null,
    options?: CodexRequestOptions,
  ): Promise<QueuedCodexRequestResult>;
  realtimeSessionStarted(): Promise<void>;
  realtimeSessionEnded(): Promise<void>;
  cancelQueuedCodexRequest(
    queuedId?: string | null,
    chatId?: string,
  ): Promise<CancelQueuedCodexRequestResult>;
  interruptCodex(chatId?: string): Promise<void>;
  getChatStatus(chatId?: string): Promise<CodexChatRuntime[]>;
  listSubagents(chatId?: string): Promise<VoiceSubagentListResult>;
  inspectSubagent(target?: string, chatId?: string): Promise<VoiceSubagentInspectResult>;
  steerSubagent(target: string | undefined, text: string, chatId?: string): Promise<VoiceSubagentSteerResult>;
  setCodexSettings(
    settings: {
      model?: string | null;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
      permissionMode?: CodexPermissionMode | null;
    },
    scope: CodexSettingsScope,
  ): Promise<CodexSettings>;
  answerApproval(requestId: string | number, decision: ApprovalDecision): Promise<void>;
  answerToolQuestion(requestId: string | number, answers: ToolQuestionAnswer[]): Promise<void>;
  listMcpOkGrants(): Promise<McpOkGrant[]>;
  revokeMcpOkGrant(server: string, tool: string): Promise<McpOkGrant[]>;
  steerCodexThread(threadId: string, text: string): Promise<{ turnId: string }>;
  getThreadSummary(threadId: string): Promise<ActiveThreadSummary>;
  getActiveThreadSummary(chatId?: string): Promise<ActiveThreadSummary>;
  getTranscriptMessages(chatId?: string): Promise<VoiceTranscriptMessage[]>;
  getRealtimeContext(request?: RealtimeContextRequest): Promise<RealtimeContextResult>;
  saveOpenAiApiKey(apiKey: string): Promise<void>;
  clearOpenAiApiKey(): Promise<void>;
  createRealtimeClientSecret(): Promise<RealtimeClientSecret>;
  setRealtimeSettings(settings: {
    model?: RealtimeModelId | null;
    voice?: RealtimeVoiceId | null;
    reasoningEffort?: RealtimeReasoningEffort | null;
  }): Promise<AppState["realtime"]>;
  setPhoneSettings(settings: PhoneSettingsUpdate): Promise<PhoneStatus>;
  hangupPhoneCall(): Promise<PhoneStatus>;
  onWindowChromeState(listener: (state: WindowChromeState) => void): () => void;
  onAppState(listener: (state: AppState) => void): () => void;
  onAppEvent(listener: (event: AppEvent) => void): () => void;
};
