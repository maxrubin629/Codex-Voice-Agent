import { app } from "electron";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CodexTurnOutput,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SERVICE_TIER,
  type CodexPermissionMode,
  type CodexServiceTier,
  type ReasoningEffort,
  type VoiceChat,
  type VoiceProject,
  type VoiceTranscriptMessage,
  type VoiceTranscriptMessageRole,
  type VoiceTranscriptMessageSource,
  type VoiceTranscriptMessageStatus,
} from "../shared/types";

type ProjectIndex = {
  version: 1;
  projects: VoiceProject[];
};

type ListProjectsOptions = {
  includeArchived?: boolean;
};

const INDEX_FILE = ".codex-voice-projects.json";
const PROJECT_FILE = ".codex-voice-project.json";
const TRANSCRIPT_FOLDER = ".codex-voice-transcripts";
const MAX_TRANSCRIPT_MESSAGES = 5_000;

export class ProjectStore {
  readonly baseFolder: string;
  private readonly indexPath: string;
  private readonly lockPath: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(baseFolder = path.join(app.getPath("documents"), "Codex Voice Projects")) {
    this.baseFolder = baseFolder;
    this.indexPath = path.join(baseFolder, INDEX_FILE);
    this.lockPath = `${this.indexPath}.lock`;
  }

  async ensureReady(): Promise<void> {
    await mkdir(this.baseFolder, { recursive: true });
    await this.enqueueMutation(async () => {
      const index = await this.readIndexFile();
      if (!index) {
        await this.writeIndex({ version: 1, projects: await this.readProjectsFromFolders() });
        return;
      }
      if (index.projects.length === 0) {
        const projects = await this.readProjectsFromFolders();
        if (projects.length > 0) {
          await this.writeIndex({ version: 1, projects });
        }
      }
    });
  }

  async listProjects(options: ListProjectsOptions = {}): Promise<VoiceProject[]> {
    const index = await this.readIndex();
    return index.projects
      .filter((project) => options.includeArchived || !project.archivedAt)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async listArchivedProjects(): Promise<VoiceProject[]> {
    const projects = await this.listProjects({ includeArchived: true });
    return projects.filter((project) => project.archivedAt);
  }

  async getProject(id: string, options: ListProjectsOptions = {}): Promise<VoiceProject | null> {
    const projects = await this.listProjects(options);
    return projects.find((project) => project.id === id) ?? null;
  }

  async getMostRecentProject(): Promise<VoiceProject | null> {
    const projects = await this.listProjects();
    return projects[0] ?? null;
  }

  async createProject(displayName?: string, workspacePath?: string | null): Promise<VoiceProject> {
    const now = new Date();
    const id = randomUUID();
    const normalizedWorkspacePath = stringOrNull(workspacePath) ? normalizeStoredPath(workspacePath, "") : null;
    const resolvedDisplayName = projectDisplayName(displayName, normalizedWorkspacePath);
    const displayNameSource = normalizedWorkspacePath ? "workspace" : "custom";
    const safeName = sanitizeProjectName(resolvedDisplayName);
    const folderName = `${formatFolderTimestamp(now)} - ${safeName}`;
    const folderPath = await this.uniqueFolderPath(folderName);

    await mkdir(folderPath, { recursive: true });

    const project: VoiceProject = {
      id,
      displayName: resolvedDisplayName,
      displayNameSource,
      folderPath,
      workspacePath: normalizedWorkspacePath ?? folderPath,
      activeChatId: null,
      chats: [],
      codexThreadId: null,
      model: null,
      reasoningEffort: null,
      serviceTier: DEFAULT_CODEX_SERVICE_TIER,
      permissionMode: DEFAULT_CODEX_PERMISSION_MODE,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      archivedAt: null,
      lastSummary: null,
      lastStatus: "Created project folder.",
    };

    await this.upsertProject(project);
    return project;
  }

  async upsertProject(project: VoiceProject): Promise<VoiceProject> {
    return this.enqueueMutation(async () => {
      await mkdir(project.folderPath, { recursive: true });
      const index = await this.readIndex();
      const nextProject = { ...project, updatedAt: new Date().toISOString() };
      const nextProjects = [
        nextProject,
        ...index.projects.filter((existing) => existing.id !== project.id),
      ];
      await this.writeJsonAtomic(path.join(project.folderPath, PROJECT_FILE), nextProject);
      await this.writeIndex({ version: 1, projects: nextProjects });
      return nextProject;
    });
  }

  async updateProject(id: string, patch: Partial<VoiceProject>): Promise<VoiceProject> {
    const existing = await this.getProject(id);
    if (!existing) {
      throw new Error(`Unknown voice project: ${id}`);
    }
    return this.upsertProject({ ...existing, ...patch });
  }

  async archiveProject(id: string): Promise<VoiceProject> {
    const existing = await this.getProject(id, { includeArchived: true });
    if (!existing) {
      throw new Error(`Unknown voice project: ${id}`);
    }
    if (existing.archivedAt) return existing;
    return this.upsertProject({
      ...existing,
      archivedAt: new Date().toISOString(),
      lastStatus: "Archived project.",
    });
  }

  async restoreProject(id: string): Promise<VoiceProject> {
    const existing = await this.getProject(id, { includeArchived: true });
    if (!existing) {
      throw new Error(`Unknown voice project: ${id}`);
    }
    return this.upsertProject({
      ...existing,
      archivedAt: null,
      lastStatus: "Restored project.",
    });
  }

  async addChat(
    projectId: string,
    displayName: string,
    codexThreadId: string,
    settings: {
      model?: string | null;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
      permissionMode?: CodexPermissionMode;
    } = {},
  ): Promise<VoiceProject> {
    const existing = await this.getProject(projectId);
    if (!existing) {
      throw new Error(`Unknown voice project: ${projectId}`);
    }

    const now = new Date().toISOString();
    const model = settings.model ?? existing.model ?? DEFAULT_CODEX_MODEL;
    const reasoningEffort =
      settings.reasoningEffort ?? existing.reasoningEffort ?? DEFAULT_CODEX_REASONING_EFFORT;
    const serviceTier = settings.serviceTier ?? existing.serviceTier ?? DEFAULT_CODEX_SERVICE_TIER;
    const permissionMode = settings.permissionMode ?? existing.permissionMode ?? DEFAULT_CODEX_PERMISSION_MODE;
    const chat: VoiceChat = {
      id: randomUUID(),
      displayName: displayName.trim() || "New chat",
      codexThreadId,
      model,
      reasoningEffort,
      serviceTier,
      permissionMode,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      lastSummary: null,
      lastStatus: "Codex thread started.",
      lastTurnOutput: null,
    };

    return this.upsertProject({
      ...existing,
      activeChatId: chat.id,
      codexThreadId,
      chats: [...existing.chats, chat],
      lastStatus: `Active chat: ${chat.displayName}`,
    });
  }

  async archiveChat(projectId: string, chatId: string): Promise<VoiceProject> {
    return this.setChatArchived(projectId, chatId, new Date().toISOString());
  }

  async restoreChat(projectId: string, chatId: string): Promise<VoiceProject> {
    return this.setChatArchived(projectId, chatId, null);
  }

  async setActiveChat(projectId: string, chatId: string): Promise<VoiceProject> {
    const existing = await this.getProject(projectId);
    if (!existing) {
      throw new Error(`Unknown voice project: ${projectId}`);
    }
    const chat = existing.chats.find((candidate) => candidate.id === chatId);
    if (!chat) {
      throw new Error(`Unknown chat: ${chatId}`);
    }
    return this.upsertProject({
      ...existing,
      activeChatId: chat.id,
      codexThreadId: chat.codexThreadId,
      lastStatus: `Active chat: ${chat.displayName}`,
    });
  }

  async updateChat(projectId: string, chatId: string, patch: Partial<VoiceChat>): Promise<VoiceProject> {
    const existing = await this.getProject(projectId);
    if (!existing) {
      throw new Error(`Unknown voice project: ${projectId}`);
    }
    const now = new Date().toISOString();
    let activeThreadId = existing.codexThreadId;
    const chats = existing.chats.map((chat) => {
      if (chat.id !== chatId) return chat;
      const updated = { ...chat, ...patch, updatedAt: now };
      if (existing.activeChatId === chatId) activeThreadId = updated.codexThreadId;
      return updated;
    });
    if (!chats.some((chat) => chat.id === chatId)) {
      throw new Error(`Unknown chat: ${chatId}`);
    }
    return this.upsertProject({
      ...existing,
      chats,
      codexThreadId: activeThreadId,
      lastStatus: patch.lastStatus ?? existing.lastStatus,
      lastSummary: patch.lastSummary ?? existing.lastSummary,
    });
  }

  async listTranscriptMessages(projectId: string, chatId: string): Promise<VoiceTranscriptMessage[]> {
    const project = await this.getProject(projectId, { includeArchived: true });
    if (!project) {
      throw new Error(`Unknown voice project: ${projectId}`);
    }
    if (!project.chats.some((chat) => chat.id === chatId)) {
      throw new Error(`Unknown chat: ${chatId}`);
    }
    return this.readTranscriptMessagesFile(this.transcriptPath(project, chatId), chatId);
  }

  async upsertTranscriptMessage(
    projectId: string,
    chatId: string,
    message: VoiceTranscriptMessage,
  ): Promise<VoiceTranscriptMessage | null> {
    return this.enqueueMutation(async () => {
      const project = await this.getProject(projectId, { includeArchived: true });
      if (!project) {
        throw new Error(`Unknown voice project: ${projectId}`);
      }
      const chat = project.chats.find((candidate) => candidate.id === chatId);
      if (!chat) {
        throw new Error(`Unknown chat: ${chatId}`);
      }

      const normalized = normalizeTranscriptMessage(message, chat.id, chat.codexThreadId);
      if (!normalized) return null;

      const filePath = this.transcriptPath(project, chat.id);
      const existingMessages = await this.readTranscriptMessagesFile(filePath, chat.id);
      const byId = new Map(existingMessages.map((existing) => [existing.id, existing]));
      const existing = byId.get(normalized.id);
      byId.set(normalized.id, mergeTranscriptMessage(existing, normalized));
      const messages = [...byId.values()]
        .sort(compareTranscriptMessages)
        .slice(-MAX_TRANSCRIPT_MESSAGES);

      await mkdir(path.dirname(filePath), { recursive: true });
      await this.writeTextAtomic(filePath, `${messages.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
      return normalized;
    });
  }

  private async setChatArchived(
    projectId: string,
    chatId: string,
    archivedAt: string | null,
  ): Promise<VoiceProject> {
    const existing = await this.getProject(projectId, { includeArchived: true });
    if (!existing) {
      throw new Error(`Unknown voice project: ${projectId}`);
    }

    const now = new Date().toISOString();
    let changed = false;
    const chats = existing.chats.map((chat) => {
      if (chat.id !== chatId) return chat;
      changed = true;
      return {
        ...chat,
        archivedAt,
        updatedAt: now,
        lastStatus: archivedAt ? "Archived chat." : "Restored chat.",
      };
    });
    if (!changed) {
      throw new Error(`Unknown chat: ${chatId}`);
    }

    const currentActiveChat =
      existing.activeChatId && chats.find((chat) => chat.id === existing.activeChatId && !chat.archivedAt)
        ? existing.activeChatId
        : null;
    const restoredTarget = !archivedAt ? chats.find((chat) => chat.id === chatId) ?? null : null;
    const activeChatId =
      currentActiveChat ??
      (restoredTarget && !restoredTarget.archivedAt ? restoredTarget.id : null) ??
      chats.find((chat) => !chat.archivedAt)?.id ??
      null;
    const activeChat = activeChatId ? chats.find((chat) => chat.id === activeChatId) ?? null : null;

    return this.upsertProject({
      ...existing,
      activeChatId,
      codexThreadId: activeChat?.codexThreadId ?? null,
      chats,
      lastStatus: archivedAt ? "Archived chat." : "Restored chat.",
    });
  }

  private async uniqueFolderPath(folderName: string): Promise<string> {
    let candidate = path.join(this.baseFolder, folderName);
    let suffix = 2;
    while (existsSync(candidate)) {
      candidate = path.join(this.baseFolder, `${folderName} ${suffix}`);
      suffix += 1;
    }
    return candidate;
  }

  private async readIndex(): Promise<ProjectIndex> {
    await mkdir(this.baseFolder, { recursive: true });
    const index = await this.readIndexFile();
    if (index) return index;
    return { version: 1, projects: await this.readProjectsFromFolders() };
  }

  private async readIndexFile(): Promise<ProjectIndex | null> {
    try {
      const raw = await readFile(this.indexPath, "utf8");
      const parsed = JSON.parse(raw) as ProjectIndex;
      return {
        version: 1,
        projects: Array.isArray(parsed.projects) ? parsed.projects.map(normalizeProject) : [],
      };
    } catch {
      return null;
    }
  }

  private async writeIndex(index: ProjectIndex): Promise<void> {
    await mkdir(this.baseFolder, { recursive: true });
    await this.writeJsonAtomic(this.indexPath, index);
  }

  private async readProjectsFromFolders(): Promise<VoiceProject[]> {
    const entries = await readdir(this.baseFolder, { withFileTypes: true });
    const projects: VoiceProject[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const projectPath = path.join(this.baseFolder, entry.name, PROJECT_FILE);
      if (!existsSync(projectPath)) continue;
      try {
        const project = normalizeProject(JSON.parse(await readFile(projectPath, "utf8")));
        projects.push(project);
      } catch {
        // Ignore malformed sidecar files; the debug UI should remain bootable.
      }
    }
    return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  private async writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
    await this.writeTextAtomic(filePath, `${JSON.stringify(value, null, 2)}\n`);
  }

  private async writeTextAtomic(filePath: string, text: string): Promise<void> {
    const tempPath = `${filePath}.${process.pid}.${Date.now()}-${randomUUID()}.tmp`;
    try {
      await writeFile(tempPath, text);
      await rename(tempPath, filePath);
    } catch (error) {
      try {
        await unlink(tempPath);
      } catch {
        // Best-effort cleanup; preserve the original error.
      }
      throw error;
    }
  }

  private transcriptPath(project: VoiceProject, chatId: string): string {
    return path.join(project.folderPath, TRANSCRIPT_FOLDER, `${safeTranscriptFileName(chatId)}.jsonl`);
  }

  private async readTranscriptMessagesFile(filePath: string, chatId: string): Promise<VoiceTranscriptMessage[]> {
    try {
      const raw = await readFile(filePath, "utf8");
      return raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            return normalizeTranscriptMessage(JSON.parse(line), chatId);
          } catch {
            return null;
          }
        })
        .filter((message): message is VoiceTranscriptMessage => Boolean(message))
        .sort(compareTranscriptMessages)
        .slice(-MAX_TRANSCRIPT_MESSAGES);
    } catch (error) {
      if (isErrorWithCode(error, "ENOENT")) return [];
      throw error;
    }
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.mutationQueue.then(
      () => this.withMutationLock(operation),
      () => this.withMutationLock(operation),
    );
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async withMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    const release = await this.acquireMutationLock();
    try {
      return await operation();
    } finally {
      await release();
    }
  }

  private async acquireMutationLock(): Promise<() => Promise<void>> {
    const staleAfterMs = 30_000;
    while (true) {
      try {
        await mkdir(this.lockPath);
        return async () => {
          try {
            await rmdir(this.lockPath);
          } catch {
            // A stale-lock cleanup race should not hide the successful write.
          }
        };
      } catch (error) {
        if (!isErrorWithCode(error, "EEXIST")) throw error;
        try {
          const lock = await stat(this.lockPath);
          if (Date.now() - lock.mtimeMs > staleAfterMs) {
            await rmdir(this.lockPath);
            continue;
          }
        } catch (lockError) {
          if (!isErrorWithCode(lockError, "ENOENT")) throw lockError;
        }
        await delay(25);
      }
    }
  }
}

function normalizeProject(value: unknown): VoiceProject {
  const project = value as VoiceProject & {
    activeChatId?: string | null;
    chats?: VoiceChat[];
  };
  const createdAt = stringOrNow(project.createdAt);
  const updatedAt = stringOrNow(project.updatedAt);
  const folderPath = normalizeStoredPath((project as { folderPath?: unknown }).folderPath, "");
  const workspacePath = normalizeStoredPath((project as { workspacePath?: unknown }).workspacePath, folderPath);
  const workspaceBacked = Boolean(workspacePath && folderPath && path.resolve(workspacePath) !== path.resolve(folderPath));
  const storedDisplayNameSource = (project as { displayNameSource?: unknown }).displayNameSource;
  const displayNameSource =
    storedDisplayNameSource === "custom" ? "custom" : workspaceBacked ? "workspace" : "custom";
  const displayName = displayNameSource === "workspace"
    ? projectDisplayName(undefined, workspacePath)
    : stringOrNull(project.displayName) ?? "Voice Project";
  const projectModel = stringOrNull(project.model) ?? DEFAULT_CODEX_MODEL;
  const projectReasoningEffort =
    reasoningEffortOrNull(project.reasoningEffort) ?? DEFAULT_CODEX_REASONING_EFFORT;
  const projectServiceTier = serviceTierOrNull(project.serviceTier) ?? DEFAULT_CODEX_SERVICE_TIER;
  const projectPermissionMode = permissionModeOrDefault(project.permissionMode);
  const chats = Array.isArray(project.chats)
    ? project.chats
        .map((chat) =>
          normalizeChat(
            chat,
            createdAt,
            updatedAt,
            projectModel,
            projectReasoningEffort,
            projectServiceTier,
            projectPermissionMode,
          ),
        )
        .filter((chat) => chat.id)
    : [];

  const unarchivedChats = chats.filter((chat) => !chat.archivedAt);
  const activeChatId =
    stringOrNull(project.activeChatId) && unarchivedChats.some((chat) => chat.id === project.activeChatId)
      ? project.activeChatId
      : unarchivedChats[0]?.id ?? null;
  const activeChat = unarchivedChats.find((chat) => chat.id === activeChatId) ?? null;

  return {
    ...project,
    displayName,
    displayNameSource,
    folderPath,
    createdAt,
    updatedAt,
    archivedAt: stringOrNull(project.archivedAt),
    workspacePath,
    activeChatId,
    chats,
    codexThreadId: activeChat?.codexThreadId ?? null,
    model: stringOrNull(project.model),
    reasoningEffort: reasoningEffortOrNull(project.reasoningEffort),
    serviceTier: serviceTierOrNull(project.serviceTier),
    permissionMode: permissionModeOrDefault(project.permissionMode),
  };
}

function normalizeChat(
  value: unknown,
  fallbackCreatedAt: string,
  fallbackUpdatedAt: string,
  fallbackModel: string,
  fallbackReasoningEffort: ReasoningEffort,
  fallbackServiceTier: CodexServiceTier | null,
  fallbackPermissionMode: CodexPermissionMode,
): VoiceChat {
  const chat = value as VoiceChat & {
    reasoningEffort?: ReasoningEffort | null;
    serviceTier?: CodexServiceTier | null;
    permissionMode?: CodexPermissionMode;
  };
  const hasStoredServiceTier = Object.prototype.hasOwnProperty.call(chat, "serviceTier");
  return {
    id: String(chat.id ?? randomUUID()),
    displayName: String(chat.displayName ?? "New chat"),
    codexThreadId: stringOrNull(chat.codexThreadId),
    model: stringOrNull(chat.model) ?? fallbackModel,
    reasoningEffort: reasoningEffortOrNull(chat.reasoningEffort) ?? fallbackReasoningEffort,
    serviceTier: hasStoredServiceTier ? serviceTierOrNull(chat.serviceTier) : fallbackServiceTier,
    permissionMode: permissionModeOrDefault(chat.permissionMode, fallbackPermissionMode),
    createdAt: stringOrNow(chat.createdAt, fallbackCreatedAt),
    updatedAt: stringOrNow(chat.updatedAt, fallbackUpdatedAt),
    archivedAt: stringOrNull(chat.archivedAt),
    lastSummary: chat.lastSummary ?? null,
    lastStatus: chat.lastStatus ?? null,
    lastTurnOutput: normalizeCodexTurnOutput(chat.lastTurnOutput),
  };
}

function normalizeCodexTurnOutput(value: unknown): CodexTurnOutput | null {
  const output = value as Partial<CodexTurnOutput> | null | undefined;
  if (!output || typeof output !== "object") return null;
  if (
    typeof output.threadId !== "string" ||
    typeof output.turnId !== "string" ||
    typeof output.status !== "string" ||
    typeof output.finalAssistantText !== "string"
  ) {
    return null;
  }
  return {
    threadId: output.threadId,
    turnId: output.turnId,
    status: output.status,
    finalAssistantText: output.finalAssistantText,
    ...(Array.isArray(output.items) ? { items: output.items } : {}),
    startedAt: numberOrNull(output.startedAt),
    completedAt: numberOrNull(output.completedAt),
    durationMs: numberOrNull(output.durationMs),
    ...(typeof output.errorMessage === "string" && output.errorMessage ? { errorMessage: output.errorMessage } : {}),
  };
}

function normalizeTranscriptMessage(
  value: unknown,
  fallbackChatId: string,
  fallbackThreadId: string | null = null,
): VoiceTranscriptMessage | null {
  const message = value as Partial<VoiceTranscriptMessage> | null | undefined;
  if (!message || typeof message !== "object") return null;
  const id = stringOrNull(message.id);
  const text = stringOrNull(message.text);
  const chatId = stringOrNull(message.chatId) ?? fallbackChatId;
  const source = transcriptSourceOrNull(message.source);
  const role = transcriptRoleOrNull(message.role);
  const status = transcriptStatusOrNull(message.status);
  const turnId = stringOrNull(message.turnId);
  const responseId = stringOrNull(message.responseId);
  const itemId = stringOrNull(message.itemId);
  if (!id || !text || !chatId || !source || !role || !status) return null;
  const metadata =
    message.metadata && typeof message.metadata === "object" && !Array.isArray(message.metadata)
      ? (message.metadata as Record<string, unknown>)
      : undefined;

  return {
    id,
    chatId,
    threadId: stringOrNull(message.threadId) ?? fallbackThreadId,
    source,
    role,
    text,
    createdAt: stringOrNow(message.createdAt),
    completedAt: stringOrNull(message.completedAt),
    status,
    ...(turnId ? { turnId } : {}),
    ...(responseId ? { responseId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(metadata ? { metadata } : {}),
  };
}

function mergeTranscriptMessage(
  existing: VoiceTranscriptMessage | undefined,
  incoming: VoiceTranscriptMessage,
): VoiceTranscriptMessage {
  if (!existing) return incoming;
  if (incoming.status !== "streaming") {
    return {
      ...incoming,
      createdAt: existing.createdAt,
    };
  }
  if (existing.status !== "streaming") return existing;
  return {
    ...incoming,
    text: `${existing.text}${incoming.text}`,
    createdAt: existing.createdAt,
    metadata: {
      ...(existing.metadata ?? {}),
      ...(incoming.metadata ?? {}),
    },
  };
}

function compareTranscriptMessages(left: VoiceTranscriptMessage, right: VoiceTranscriptMessage): number {
  const leftTime = dateMs(left.createdAt) ?? 0;
  const rightTime = dateMs(right.createdAt) ?? 0;
  if (leftTime !== rightTime) return leftTime - rightTime;
  return left.id.localeCompare(right.id);
}

function transcriptSourceOrNull(value: unknown): VoiceTranscriptMessageSource | null {
  return typeof value === "string" && ["realtime", "codex", "app"].includes(value)
    ? (value as VoiceTranscriptMessageSource)
    : null;
}

function transcriptRoleOrNull(value: unknown): VoiceTranscriptMessageRole | null {
  return typeof value === "string" && ["user", "assistant"].includes(value)
    ? (value as VoiceTranscriptMessageRole)
    : null;
}

function transcriptStatusOrNull(value: unknown): VoiceTranscriptMessageStatus | null {
  return typeof value === "string" && ["completed", "streaming", "interrupted", "error"].includes(value)
    ? (value as VoiceTranscriptMessageStatus)
    : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function normalizeStoredPath(value: unknown, fallback: string): string {
  const raw = stringOrNull(value);
  if (!raw) return fallback;
  const expanded = raw === "~" ? process.env.HOME ?? raw : raw.startsWith("~/") ? path.join(process.env.HOME ?? "~", raw.slice(2)) : raw;
  return path.resolve(expanded);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function reasoningEffortOrNull(value: unknown): ReasoningEffort | null {
  return typeof value === "string" && ["none", "minimal", "low", "medium", "high", "xhigh"].includes(value)
    ? (value as ReasoningEffort)
    : null;
}

function serviceTierOrNull(value: unknown): CodexServiceTier | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function permissionModeOrDefault(value: unknown, fallback = DEFAULT_CODEX_PERMISSION_MODE): CodexPermissionMode {
  return typeof value === "string" && ["default", "auto-review", "full-access", "custom-config"].includes(value)
    ? (value as CodexPermissionMode)
    : fallback;
}

function stringOrNow(value: unknown, fallback = new Date().toISOString()): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

function isErrorWithCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && (error as { code?: unknown }).code === code;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function dateMs(value: unknown): number | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function safeTranscriptFileName(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_") || "chat";
}

function sanitizeProjectName(name: string): string {
  return name
    .replace(/[^\w\s.-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64)
    .replace(/\s/g, "-")
    .toLowerCase() || "voice-project";
}

function projectDisplayName(displayName: string | undefined, workspacePath: string | null): string {
  const workspaceName = workspacePath ? path.basename(workspacePath) : "";
  return workspaceName || displayName?.trim() || "Voice Project";
}

function formatFolderTimestamp(date: Date): string {
  const pad = (value: number) => value.toString().padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}.${pad(date.getMinutes())}.${pad(date.getSeconds())}`;
}
