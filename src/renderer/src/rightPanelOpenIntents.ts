import type {
  ActiveThreadSummary,
  AppEvent,
  AppState,
  ThreadArtifactCandidate,
  ThreadSourceCandidate,
} from "../../shared/types";

export type BuiltInTabId =
  | "overview"
  | "transcript"
  | "summary"
  | "activity"
  | "approvals"
  | "last-output"
  | "chats"
  | "changes"
  | "runtime";

export type RightPanelOpenIntentReason =
  | "image-view"
  | "image-generation"
  | "file-change"
  | "summary-file"
  | "approval"
  | "source"
  | "url";

export type RightPanelOpenIntentPriority = "foreground" | "background" | "badge";

export type RightPanelOpenIntentTarget =
  | { kind: "builtIn"; tabId: BuiltInTabId }
  | {
      kind: "file";
      path: string;
      workspacePath?: string | null;
      title?: string | null;
      subtitle?: string | null;
      mimeType?: string | null;
    }
  | { kind: "url"; url: string; title?: string | null; subtitle?: string | null; mimeType?: string | null }
  | { kind: "artifact"; artifact: ThreadArtifactCandidate }
  | { kind: "source"; source: ThreadSourceCandidate };

export type RightPanelOpenIntent = {
  id: string;
  reason: RightPanelOpenIntentReason;
  priority: RightPanelOpenIntentPriority;
  dedupeKey: string;
  createdAt: string;
  sourceEventId?: string | null;
  sourceItemId?: string | null;
  chatId?: string | null;
  threadId?: string | null;
  target: RightPanelOpenIntentTarget;
  label: string;
};

export function deriveRightPanelOpenIntents({
  event,
  state,
  summary,
}: {
  event: AppEvent;
  state: AppState;
  summary?: ActiveThreadSummary | null;
}): RightPanelOpenIntent[] {
  if (!eventBelongsToActiveContext(event, state)) return [];

  if (event.source === "codex" && event.kind === "serverRequest") {
    const raw = recordFromUnknown(event.raw);
    return [
      intent({
        event,
        raw,
        reason: "approval",
        priority: "foreground",
        label: "Approval requested",
        target: { kind: "builtIn", tabId: "approvals" },
        dedupeKey: `builtIn:approvals:${stringFromUnknown(raw?.requestId) ?? eventIdentity(event)}`,
      }),
    ];
  }

  if (event.source !== "codex") return [];

  const raw = recordFromUnknown(event.raw);
  const items = eventItems(event, raw);
  const intents: RightPanelOpenIntent[] = [];
  for (const item of items) {
    intents.push(...intentsFromItem(event, item, state, raw));
  }

  if (intents.length === 0 && summary?.status === "ready") {
    intents.push(...intentsFromSummary(event, summary, state));
  }

  return prioritizeIntents(dedupeIntents(intents)).slice(0, 4);
}

export function rightPanelIntentEventKey(event: AppEvent): string {
  return eventIdentity(event);
}

function intentsFromItem(
  event: AppEvent,
  item: Record<string, unknown>,
  state: AppState,
  eventRaw: Record<string, unknown> | null,
): RightPanelOpenIntent[] {
  const type = normalizeItemType(stringFromUnknown(item.type));
  const sourceItemId = stringFromUnknown(item.id) ?? stringFromUnknown(item.itemId) ?? stringFromUnknown(item.callId);
  const createdAt = event.at;

  if (type === "imageView") {
    const target = firstPath(item, ["path", "filePath", "file_path", "target"]);
    if (!target) return [];
    return [
      fileIntent({
        event,
        eventRaw,
        createdAt,
        sourceItemId,
        path: target,
        reason: "image-view",
        priority: "foreground",
        label: "Opened from image view",
        workspacePath: workspacePathForState(state),
        mimeType: imageMimeTypeForPath(target),
      }),
    ];
  }

  if (isImageViewToolCall(item)) {
    const args = toolArgumentsRecord(item);
    const target = firstPath(args, ["path", "filePath", "file_path", "target", "imagePath", "image_path"]);
    if (!target) return [];
    return [
      fileIntent({
        event,
        eventRaw,
        createdAt,
        sourceItemId,
        path: target,
        reason: "image-view",
        priority: "foreground",
        label: "Opened from image view",
        workspacePath: workspacePathForState(state),
        mimeType: imageMimeTypeForPath(target),
      }),
    ];
  }

  if (type === "generatedImage") {
    const target =
      firstPath(item, ["savedPath", "saved_path", "path", "filePath", "file_path", "src"]) ??
      firstUrl(item, ["url", "imageUrl", "image_url"]);
    if (!target) return [];
    return [
      target.startsWith("http://") || target.startsWith("https://")
        ? urlIntent({
            event,
            eventRaw,
            createdAt,
            sourceItemId,
            url: target,
            reason: "image-generation",
            priority: "foreground",
            label: "Generated image",
          })
        : fileIntent({
            event,
            eventRaw,
            createdAt,
            sourceItemId,
            path: target,
            reason: "image-generation",
            priority: "foreground",
            label: "Generated image",
            workspacePath: workspacePathForState(state),
            mimeType: imageMimeTypeForPath(target),
          }),
    ];
  }

  if (type === "fileChange") {
    return fileChangePaths(item)
      .slice(0, 3)
      .map((filePath) => {
        const summaryLike = isSummaryLikePath(filePath);
        const userFacing = summaryLike || isPreviewableUserFacingPath(filePath);
        return fileIntent({
          event,
          eventRaw,
          createdAt,
          sourceItemId,
          path: filePath,
          reason: summaryLike ? "summary-file" : "file-change",
          priority: userFacing ? "foreground" : "background",
          label: summaryLike ? "Summary file updated" : "File changed",
          workspacePath: workspacePathForState(state),
          mimeType: imageMimeTypeForPath(filePath),
        });
      });
  }

  return [];
}

function intentsFromSummary(
  event: AppEvent,
  summary: ActiveThreadSummary,
  state: AppState,
): RightPanelOpenIntent[] {
  return summary.artifacts
    .filter((artifact) => artifact.kind === "file" && artifact.path)
    .filter((artifact) => isSummaryLikePath(artifact.path!) || isImagePath(artifact.path!))
    .slice(-2)
    .map((artifact) =>
      intent({
        event,
        raw: recordFromUnknown(artifact.raw),
        reason: isImagePath(artifact.path!) ? "image-generation" : "summary-file",
        priority: "foreground",
        label: isImagePath(artifact.path!) ? "Image artifact" : "Summary file updated",
        dedupeKey: `artifact:${workspacePathForState(state) ?? ""}:${artifact.path}`,
        sourceItemId: artifact.id,
        target: { kind: "artifact", artifact },
      }),
    );
}

function eventItems(event: AppEvent, raw: Record<string, unknown> | null): Record<string, unknown>[] {
  if (!raw) return [];
  const directItem = recordFromUnknown(raw.item);
  if (directItem) return [directItem];
  const rawItems = Array.isArray(raw.items) ? raw.items : [];
  const items = rawItems.map(recordFromUnknown).filter((item): item is Record<string, unknown> => Boolean(item));
  if (items.length > 0) return items;
  if (event.kind === "turn/finalOutput") {
    const outputItems = Array.isArray(raw.output) ? raw.output : [];
    return outputItems.map(recordFromUnknown).filter((item): item is Record<string, unknown> => Boolean(item));
  }
  return [];
}

function fileIntent({
  event,
  eventRaw,
  createdAt,
  sourceItemId,
  path,
  reason,
  priority,
  label,
  workspacePath,
  mimeType,
}: {
  event: AppEvent;
  eventRaw: Record<string, unknown> | null;
  createdAt: string;
  sourceItemId?: string | null;
  path: string;
  reason: RightPanelOpenIntentReason;
  priority: RightPanelOpenIntentPriority;
  label: string;
  workspacePath: string | null;
  mimeType?: string | null;
}): RightPanelOpenIntent {
  return intent({
    event,
    raw: eventRaw,
    reason,
    priority,
    label,
    sourceItemId,
    dedupeKey: `file:${workspacePath ?? ""}:${path}`,
    target: {
      kind: "file",
      path,
      workspacePath,
      title: titleFromTarget(path),
      subtitle: label,
      mimeType,
    },
    createdAt,
  });
}

function urlIntent({
  event,
  eventRaw,
  createdAt,
  sourceItemId,
  url,
  reason,
  priority,
  label,
}: {
  event: AppEvent;
  eventRaw: Record<string, unknown> | null;
  createdAt: string;
  sourceItemId?: string | null;
  url: string;
  reason: RightPanelOpenIntentReason;
  priority: RightPanelOpenIntentPriority;
  label: string;
}): RightPanelOpenIntent {
  return intent({
    event,
    raw: eventRaw,
    reason,
    priority,
    label,
    sourceItemId,
    dedupeKey: `url:${url}`,
    target: { kind: "url", url, title: titleFromTarget(url), subtitle: label },
    createdAt,
  });
}

function intent({
  event,
  raw,
  reason,
  priority,
  dedupeKey,
  label,
  target,
  sourceItemId,
  createdAt,
}: {
  event: AppEvent;
  raw: Record<string, unknown> | null;
  reason: RightPanelOpenIntentReason;
  priority: RightPanelOpenIntentPriority;
  dedupeKey: string;
  label: string;
  target: RightPanelOpenIntentTarget;
  sourceItemId?: string | null;
  createdAt?: string;
}): RightPanelOpenIntent {
  const chatId = stringFromUnknown(raw?.chatId);
  const threadId = stringFromUnknown(raw?.threadId) ?? stringFromUnknown(raw?.conversationId);
  return {
    id: `${reason}:${dedupeKey}:${eventIdentity(event)}`,
    reason,
    priority,
    dedupeKey,
    createdAt: createdAt ?? event.at,
    sourceEventId: eventIdentity(event),
    sourceItemId: sourceItemId ?? stringFromUnknown(raw?.itemId) ?? null,
    chatId,
    threadId,
    target,
    label,
  };
}

function eventBelongsToActiveContext(event: AppEvent, state: AppState): boolean {
  const raw = recordFromUnknown(event.raw);
  const chatId = stringFromUnknown(raw?.chatId);
  const threadId = stringFromUnknown(raw?.threadId) ?? stringFromUnknown(raw?.conversationId);
  const activeChat = activeChatForState(state);
  const activeChatId = state.runtime.activeChatId ?? activeChat?.id ?? null;
  const activeThreadId = activeChat?.codexThreadId ?? state.activeProject?.codexThreadId ?? null;
  if (chatId && activeChatId) return chatId === activeChatId;
  if (threadId && activeThreadId) return threadId === activeThreadId;
  return true;
}

function activeChatForState(state: AppState) {
  const project = state.activeProject;
  if (!project) return null;
  const chats = project.chats.filter((chat) => !chat.archivedAt);
  return (
    chats.find((candidate) => candidate.id === state.runtime.activeChatId) ??
    chats.find((candidate) => candidate.id === project.activeChatId) ??
    chats.find((candidate) => candidate.codexThreadId === project.codexThreadId) ??
    chats[0] ??
    null
  );
}

function workspacePathForState(state: AppState): string | null {
  return state.activeProject?.workspacePath ?? state.activeProject?.folderPath ?? null;
}

function normalizeItemType(value: string | null): string {
  const normalized = (value ?? "unknown")
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
  if (normalized === "image-view" || normalized === "view-image" || normalized === "view-image-tool-call") {
    return "imageView";
  }
  if (normalized === "generated-image" || normalized === "image-generation") return "generatedImage";
  if (normalized === "file-change" || normalized === "patch" || normalized === "turn-diff") return "fileChange";
  return normalized;
}

function isImageViewToolCall(item: Record<string, unknown>): boolean {
  const name = [
    stringFromUnknown(item.tool),
    stringFromUnknown(item.name),
    stringFromUnknown(item.functionName),
    stringFromUnknown(item.function_name),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return name.includes("view_image") || name.includes("view image") || name.includes("read_image") || name.includes("read image");
}

function toolArgumentsRecord(item: Record<string, unknown>): Record<string, unknown> {
  const direct = recordFromUnknown(item.arguments) ?? recordFromUnknown(item.args) ?? recordFromUnknown(item.input);
  if (direct) return direct;
  const text = stringFromUnknown(item.arguments) ?? stringFromUnknown(item.args) ?? stringFromUnknown(item.input);
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as unknown;
    return recordFromUnknown(parsed) ?? {};
  } catch {
    return {};
  }
}

function firstPath(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const direct = stringFromUnknown(record[key]);
    if (direct && looksLikeFilePath(direct)) return direct;
  }
  return null;
}

function firstUrl(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const direct = stringFromUnknown(record[key]);
    if (direct && (direct.startsWith("http://") || direct.startsWith("https://"))) return direct;
  }
  return null;
}

function fileChangePaths(item: Record<string, unknown>): string[] {
  const paths = new Set<string>();
  for (const key of ["path", "filePath", "file_path", "filename", "target"]) {
    const value = stringFromUnknown(item[key]);
    if (value && looksLikeFilePath(value)) paths.add(value);
  }
  for (const key of [
    "editedFilePaths",
    "edited_file_paths",
    "createdFilePaths",
    "created_file_paths",
    "filePaths",
    "file_paths",
    "files",
  ]) {
    for (const value of stringArray(item[key])) {
      if (looksLikeFilePath(value)) paths.add(value);
    }
  }
  const changes = recordFromUnknown(item.changes) ?? recordFromUnknown(item.fileChanges) ?? recordFromUnknown(item.file_changes);
  if (changes) {
    for (const key of Object.keys(changes)) {
      if (looksLikeFilePath(key)) paths.add(key);
    }
  }
  return [...paths];
}

function stringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      const record = recordFromUnknown(item);
      return record
        ? stringFromUnknown(record.path) ??
            stringFromUnknown(record.filePath) ??
            stringFromUnknown(record.file_path) ??
            stringFromUnknown(record.name)
        : null;
    })
    .filter((item): item is string => Boolean(item));
}

function looksLikeFilePath(value: string): boolean {
  if (value.startsWith("file://") || value.startsWith("/") || value.startsWith("~/")) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (/^[\w.-]+([\\/][\w .@()[\]-]+)+$/.test(value)) return true;
  return Boolean(value.match(/\.(md|mdx|txt|json|html|png|jpe?g|webp|gif|svg|pdf|docx?|tsx?|jsx?|css|py|rs|go|sh|yaml|yml)$/i));
}

function isSummaryLikePath(value: string): boolean {
  const filename = value.split(/[\\/]/).pop()?.toLowerCase() ?? value.toLowerCase();
  return (
    filename.includes("summary") ||
    filename.includes("report") ||
    filename.includes("dossier") ||
    filename.includes("vision") ||
    filename.includes("execplan") ||
    filename.includes("plan") ||
    filename === "readme.md" ||
    filename === "readme"
  );
}

function isPreviewableUserFacingPath(value: string): boolean {
  return isImagePath(value) || /\.(md|mdx|markdown|html?|pdf|docx?)$/i.test(value);
}

function isImagePath(value: string): boolean {
  return /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(value);
}

function imageMimeTypeForPath(value: string): string | null {
  const lower = value.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".svg")) return "image/svg+xml";
  if (lower.endsWith(".avif")) return "image/avif";
  return null;
}

function titleFromTarget(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname.split("/").filter(Boolean).pop() || url.hostname || value;
  } catch {
    return value.split(/[\\/]/).filter(Boolean).pop() ?? value;
  }
}

function dedupeIntents(intents: RightPanelOpenIntent[]): RightPanelOpenIntent[] {
  const seen = new Set<string>();
  const output: RightPanelOpenIntent[] = [];
  for (const item of intents) {
    if (seen.has(item.dedupeKey)) continue;
    seen.add(item.dedupeKey);
    output.push(item);
  }
  return output;
}

function prioritizeIntents(intents: RightPanelOpenIntent[]): RightPanelOpenIntent[] {
  const rank: Record<RightPanelOpenIntentPriority, number> = {
    foreground: 0,
    background: 1,
    badge: 2,
  };
  return [...intents].sort((left, right) => rank[left.priority] - rank[right.priority]);
}

function eventIdentity(event: AppEvent): string {
  const raw = recordFromUnknown(event.raw);
  const requestId = stringFromUnknown(raw?.requestId) ?? stringFromUnknown(raw?.id);
  const item = recordFromUnknown(raw?.item);
  const itemId = stringFromUnknown(raw?.itemId) ?? stringFromUnknown(item?.id) ?? stringFromUnknown(item?.callId);
  const turnId = stringFromUnknown(raw?.turnId);
  return [event.at, event.source, event.kind, requestId, turnId, itemId, event.message.length]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .join(":");
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
