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
export const DEFAULT_CODEX_PERMISSION_MODE: CodexPermissionMode = "default";

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

export type CodexTurnOutput = {
  threadId: string;
  turnId: string;
  status: string;
  finalAssistantText: string;
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

export type RightPanelPreviewRequest = {
  kind: "file" | "url";
  path?: string;
  url?: string;
  workspacePath?: string | null;
};

export type RightPanelPreviewResult = {
  status: "ready" | "empty" | "too_large" | "unsupported" | "external" | "error";
  kind: "text" | "markdown" | "code" | "image" | "iframe" | "external" | "unsupported" | "empty";
  title: string;
  subtitle: string | null;
  path?: string;
  url?: string;
  mimeType?: string | null;
  sizeBytes?: number | null;
  text?: string;
  dataUrl?: string;
  truncated?: boolean;
  errorMessage?: string;
};

export type RightPanelOpenTarget = {
  kind: "file" | "folder" | "url";
  path?: string;
  url?: string;
  workspacePath?: string | null;
};

export type GitPullRequestSummary = {
  number: number;
  title: string;
  url: string;
  state: string;
  headRefName?: string | null;
  baseRefName?: string | null;
};

export type GitChangeSummary = {
  status: "ready" | "empty" | "not_git" | "error";
  workspacePath: string | null;
  gitRoot: string | null;
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirtyCount: number;
  changedFiles: string[];
  diffStat: string | null;
  stagedDiffStat: string | null;
  recentCommits: Array<{ sha: string; title: string; decorated: string }>;
  pullRequest: GitPullRequestSummary | null;
  errorMessage?: string;
};

export type VoiceChat = {
  id: string;
  displayName: string;
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
  lastTurnOutput: CodexTurnOutput | null;
};

export type VoiceProject = {
  id: string;
  displayName: string;
  displayNameSource?: "workspace" | "custom";
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
  handle: string;
  projectHandle: string;
  threadId: string | null;
  displayName: string;
  activeTurnId: string | null;
  status: string;
  threadStatus: string | null;
  tokenUsage: CodexThreadTokenUsage | null;
  pendingRequests: PendingCodexRequest[];
  activeTurnModel: string | null;
  activeTurnReasoningEffort: ReasoningEffort | null;
  activeTurnServiceTier: CodexServiceTier | null;
};

export type CodexProjectTarget = {
  projectId?: string | null;
  projectHandle?: string | null;
  projectName?: string | null;
  workspacePath?: string | null;
  createIfMissing?: boolean | null;
};

export type CodexThreadTarget = {
  chatId?: string | null;
  threadHandle?: string | null;
  chatName?: string | null;
  newChatName?: string | null;
  createIfMissing?: boolean | null;
  forceNew?: boolean | null;
};

export type DispatchCodexTaskArgs = {
  request: string;
  context?: string | null;
  project?: CodexProjectTarget | null;
  thread?: CodexThreadTarget | null;
};

export type CreateCodexThreadArgs = {
  name: string;
  project?: CodexProjectTarget | null;
  context?: string | null;
  forceNew?: boolean | null;
};

export type ListCodexThreadsArgs = {
  project?: CodexProjectTarget | null;
};

export type CodexProjectThreadRuntime = {
  projectId: string;
  projectHandle: string;
  projectName: string;
  workspacePath: string;
  activeChatId: string | null;
  chats: CodexChatRuntime[];
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
  projectThreads: CodexProjectThreadRuntime[];
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
  projectHandle?: string;
  projectName?: string;
  chatId?: string;
  threadHandle?: string;
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
  realtime: {
    available: boolean;
    model: RealtimeModelId;
    voice: RealtimeVoiceId;
    reasoningEffort: RealtimeReasoningEffort | null;
    reason: string | null;
    apiKeySource: "environment" | "saved" | null;
    apiKeyEncrypted: boolean;
  };
  webSearch: {
    available: boolean;
    provider: "exa";
    reason: string | null;
    apiKeySource: "environment" | "saved" | null;
    apiKeyEncrypted: boolean;
  };
};

export type CodexActionResult = {
  kind: "turn" | "command";
  message: string;
  turnId: string | null;
  projectHandle?: string | null;
  threadHandle?: string | null;
  project: VoiceProject | null;
  chat: VoiceChat | null;
};

export type AppEvent = {
  at: string;
  source: "app" | "codex" | "realtime";
  kind: string;
  message: string;
  raw?: unknown;
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

export type RealtimeUserAttachment = {
  id: string;
  kind: "image";
  name: string;
  mimeType: string;
  sizeBytes: number;
  dataUrl: string;
  localPath?: string | null;
};

export type RealtimeUserAttachmentMetadata = Omit<RealtimeUserAttachment, "dataUrl">;

export type RealtimeUserInput = {
  text: string;
  attachments: RealtimeUserAttachment[];
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
};

export type VoiceExecCommandArgs = {
  cmd: string;
  workdir?: string | null;
  shell?: string | null;
  tty?: boolean | null;
  login?: boolean | null;
  yield_time_ms?: number | null;
  max_output_tokens?: number | null;
};

export type VoiceWriteStdinArgs = {
  session_id: number;
  chars?: string | null;
  yield_time_ms?: number | null;
  max_output_tokens?: number | null;
};

export type VoiceWebSearchArgs = {
  query: string;
  context?: string | null;
  requestId?: string | null;
};

export type VoiceWebSearchSource = {
  title: string | null;
  url: string;
  author?: string | null;
  publishedDate?: string | null;
  highlights?: string[];
  score?: number | null;
};

export type VoiceWebSearchAction = {
  type: string;
  query?: string;
  queries?: string[];
};

export type VoiceWebSearchResult = {
  query: string;
  answer: string;
  sources: VoiceWebSearchSource[];
  actions: VoiceWebSearchAction[];
  model: string;
  provider?: "exa";
  searchType?: string;
  requestId?: string | null;
};

export type VoiceExecCommandResult = {
  chunk_id?: string;
  wall_time_seconds: number;
  exit_code?: number;
  session_id?: number;
  original_token_count?: number;
  output: string;
};

export type ApiKeySecretView = {
  value: string;
  source: "environment" | "saved";
  encrypted: boolean;
};

export type ApiKeySecretCopyResult = {
  source: "environment" | "saved";
  encrypted: boolean;
};

export type CodexVoiceApi = {
  getState(): Promise<AppState>;
  openVoiceWindow(): Promise<void>;
  getWindowChromeState(): Promise<WindowChromeState>;
  openDebugWindow(): Promise<void>;
  getEvents(): Promise<AppEvent[]>;
  clearEvents(): Promise<void>;
  logEvent(event: AppEvent): Promise<void>;
  selectWorkspaceFolder(): Promise<SelectedWorkspaceFolder | null>;
  setWorkspaceFolder(workspacePath: string, name?: string | null): Promise<VoiceProject>;
  createProject(name?: string, workspacePath?: string | null): Promise<VoiceProject>;
  resumeProject(projectId: string): Promise<VoiceProject>;
  renameProject(projectId: string, name: string): Promise<VoiceProject>;
  removeProject(projectId: string): Promise<VoiceProject>;
  archiveProject(projectId: string): Promise<VoiceProject>;
  restoreProject(projectId: string): Promise<VoiceProject>;
  createChat(name: string, projectId?: string): Promise<VoiceProject>;
  switchChat(chatId: string, projectId?: string): Promise<VoiceProject>;
  renameChat(chatId: string, name: string, projectId?: string): Promise<VoiceProject>;
  removeChat(chatId: string, projectId?: string): Promise<VoiceProject>;
  archiveChat(chatId: string, projectId?: string): Promise<VoiceProject>;
  restoreChat(chatId: string, projectId?: string): Promise<VoiceProject>;
  listChats(projectId?: string): Promise<VoiceChat[]>;
  showProjectChats(open?: boolean): Promise<void>;
  summarizeProject(projectId?: string, chatId?: string): Promise<string>;
  createThread(args: CreateCodexThreadArgs): Promise<VoiceProject>;
  listProjectThreads(args?: ListCodexThreadsArgs): Promise<CodexProjectThreadRuntime[]>;
  getAllThreadStatus(args?: ListCodexThreadsArgs): Promise<CodexProjectThreadRuntime[]>;
  dispatchCodexTask(args: DispatchCodexTaskArgs): Promise<CodexActionResult>;
  sendToCodex(text: string, chatId?: string, workspacePath?: string | null): Promise<CodexActionResult>;
  steerCodex(text: string, chatId?: string): Promise<{ turnId: string }>;
  interruptCodex(chatId?: string): Promise<void>;
  openCodexThreadInApp(threadId: string): Promise<void>;
  getChatStatus(chatId?: string): Promise<CodexChatRuntime[]>;
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
  getActiveThreadSummary(chatId?: string): Promise<ActiveThreadSummary>;
  getTranscriptMessages(chatId?: string): Promise<VoiceTranscriptMessage[]>;
  getGitChangeSummary(workspacePath?: string | null): Promise<GitChangeSummary>;
  previewRightPanelTarget(target: RightPanelPreviewRequest): Promise<RightPanelPreviewResult>;
  openRightPanelTarget(target: RightPanelOpenTarget): Promise<void>;
  execCommand(args: VoiceExecCommandArgs): Promise<VoiceExecCommandResult>;
  writeStdin(args: VoiceWriteStdinArgs): Promise<VoiceExecCommandResult>;
  terminateExecSession(sessionId: number): Promise<void>;
  applyPatch(input: string): Promise<VoiceExecCommandResult>;
  webSearch(args: VoiceWebSearchArgs): Promise<VoiceWebSearchResult>;
  cancelWebSearch(requestId: string): Promise<void>;
  saveOpenAiApiKey(apiKey: string): Promise<void>;
  clearOpenAiApiKey(): Promise<void>;
  revealOpenAiApiKey(): Promise<ApiKeySecretView>;
  copyOpenAiApiKey(): Promise<ApiKeySecretCopyResult>;
  saveExaApiKey(apiKey: string): Promise<void>;
  clearExaApiKey(): Promise<void>;
  revealExaApiKey(): Promise<ApiKeySecretView>;
  copyExaApiKey(): Promise<ApiKeySecretCopyResult>;
  createRealtimeClientSecret(): Promise<RealtimeClientSecret>;
  setRealtimeSettings(settings: {
    model?: RealtimeModelId | null;
    voice?: RealtimeVoiceId | null;
    reasoningEffort?: RealtimeReasoningEffort | null;
  }): Promise<AppState["realtime"]>;
  onWindowChromeState(listener: (state: WindowChromeState) => void): () => void;
  onAppState(listener: (state: AppState) => void): () => void;
  onAppEvent(listener: (event: AppEvent) => void): () => void;
};
