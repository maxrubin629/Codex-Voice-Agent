import { execFile as execFileCallback } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { shell } from "electron";
import type {
  GitChangeSummary,
  GitPullRequestSummary,
  RightPanelOpenTarget,
  RightPanelPreviewRequest,
  RightPanelPreviewResult,
} from "../shared/types";

const execFile = promisify(execFileCallback);
const textPreviewBytes = 256 * 1024;
const imagePreviewBytes = 4 * 1024 * 1024;
const gitTimeoutMs = 4_000;

export async function readGitChangeSummary(workspacePath: string | null | undefined): Promise<GitChangeSummary> {
  const cwd = workspacePath?.trim() ? path.resolve(expandHomePath(workspacePath)) : null;
  if (!cwd) return emptyGitSummary("empty", null, null);

  try {
    const info = await stat(cwd);
    if (!info.isDirectory()) return emptyGitSummary("error", cwd, null, `${cwd} is not a directory.`);
  } catch (error) {
    return emptyGitSummary("error", cwd, null, errorMessage(error));
  }

  let gitRoot: string;
  try {
    gitRoot = await git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch (error) {
    return emptyGitSummary("not_git", cwd, null, errorMessage(error));
  }

  try {
    const [branch, upstream, statusOutput, diffStat, stagedDiffStat, commitOutput, pullRequest] = await Promise.all([
      git(gitRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "unknown"),
      git(gitRoot, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).catch(() => ""),
      git(gitRoot, ["status", "--porcelain=v1", "--branch"]).catch(() => ""),
      git(gitRoot, ["diff", "--stat", "--shortstat"]).catch(() => ""),
      git(gitRoot, ["diff", "--cached", "--stat", "--shortstat"]).catch(() => ""),
      git(gitRoot, ["log", "--oneline", "--decorate", "-8"]).catch(() => ""),
      readPullRequestSummary(gitRoot),
    ]);
    const statusLines = statusOutput.split(/\r?\n/).filter(Boolean);
    const branchLine = statusLines.find((line) => line.startsWith("## ")) ?? "";
    const changedFiles = statusLines
      .filter((line) => !line.startsWith("## "))
      .map((line) => normalizeStatusPath(line.slice(3).trim()))
      .filter(Boolean)
      .slice(0, 120);
    const aheadBehind = parseAheadBehind(branchLine);

    return {
      status: "ready",
      workspacePath: cwd,
      gitRoot,
      branch: branch || null,
      upstream: upstream || null,
      ahead: aheadBehind.ahead,
      behind: aheadBehind.behind,
      dirtyCount: changedFiles.length,
      changedFiles,
      diffStat: diffStat || null,
      stagedDiffStat: stagedDiffStat || null,
      recentCommits: parseCommits(commitOutput),
      pullRequest,
    };
  } catch (error) {
    return emptyGitSummary("error", cwd, gitRoot, errorMessage(error));
  }
}

export async function previewRightPanelTarget(
  target: RightPanelPreviewRequest,
): Promise<RightPanelPreviewResult> {
  if (target.kind === "url") {
    return previewUrl(target.url);
  }
  return previewFile(target.path, target.workspacePath);
}

export async function openRightPanelTarget(target: RightPanelOpenTarget): Promise<void> {
  if (target.kind === "url") {
    const url = target.url?.trim();
    if (!url) throw new Error("URL is required.");
    await shell.openExternal(url);
    return;
  }

  const rawPath = target.path?.trim();
  if (!rawPath) throw new Error("Path is required.");
  const resolved = resolvePreviewPath(rawPath, target.workspacePath);
  const result = target.kind === "folder"
    ? await shell.openPath(resolved)
    : await shell.openPath(resolved);
  if (result) throw new Error(result);
}

export async function openCodexThreadInApp(threadId: string | null | undefined): Promise<void> {
  const normalized = threadId?.trim();
  if (!normalized) throw new Error("A Codex thread id is required.");
  if (!isUuid(normalized)) throw new Error(`Codex thread id is not a valid deep-link id: ${normalized}`);
  await shell.openExternal(`codex://threads/${encodeURIComponent(normalized)}`);
}

async function previewUrl(urlValue: string | undefined): Promise<RightPanelPreviewResult> {
  const raw = urlValue?.trim();
  if (!raw) return emptyPreview("No URL selected.");

  let url: URL;
  try {
    url = new URL(raw);
  } catch (error) {
    return errorPreview(raw, errorMessage(error));
  }

  if (url.protocol === "file:") {
    return previewFile(fileURLToPath(url), null);
  }

  if (isLocalPreviewUrl(url)) {
    return {
      status: "ready",
      kind: "iframe",
      title: url.hostname || raw,
      subtitle: "Local preview URL",
      url: url.toString(),
      mimeType: "text/html",
      sizeBytes: null,
    };
  }

  return {
    status: "external",
    kind: "external",
    title: url.hostname || raw,
    subtitle: "External URL",
    url: url.toString(),
    mimeType: null,
    sizeBytes: null,
  };
}

async function previewFile(
  filePath: string | undefined,
  workspacePath: string | null | undefined,
): Promise<RightPanelPreviewResult> {
  if (!filePath?.trim()) return emptyPreview("No file selected.");
  const resolved = resolvePreviewPath(filePath, workspacePath);
  const title = path.basename(resolved) || resolved;
  const mimeType = mimeTypeForPath(resolved);

  let info;
  try {
    info = await stat(resolved);
  } catch (error) {
    return errorPreview(title, errorMessage(error), resolved, mimeType);
  }

  if (!info.isFile()) {
    return {
      status: "unsupported",
      kind: "unsupported",
      title,
      subtitle: "This path is not a file.",
      path: resolved,
      mimeType,
      sizeBytes: info.size,
    };
  }

  if (isImageMime(mimeType)) {
    if (info.size > imagePreviewBytes) {
      return tooLargePreview(title, resolved, mimeType, info.size, imagePreviewBytes);
    }
    const buffer = await readFile(resolved);
    return {
      status: "ready",
      kind: "image",
      title,
      subtitle: resolved,
      path: resolved,
      mimeType,
      sizeBytes: info.size,
      dataUrl: `data:${mimeType ?? "application/octet-stream"};base64,${buffer.toString("base64")}`,
    };
  }

  if (isPdfOrOffice(mimeType, resolved)) {
    return {
      status: "unsupported",
      kind: "unsupported",
      title,
      subtitle: "Preview is not available for this file type.",
      path: resolved,
      mimeType,
      sizeBytes: info.size,
    };
  }

  if (info.size > textPreviewBytes) {
    return tooLargePreview(title, resolved, mimeType, info.size, textPreviewBytes);
  }

  const buffer = await readFile(resolved);
  if (looksBinary(buffer)) {
    return {
      status: "unsupported",
      kind: "unsupported",
      title,
      subtitle: "Binary file preview is not available.",
      path: resolved,
      mimeType,
      sizeBytes: info.size,
    };
  }

  const text = buffer.toString("utf8");
  return {
    status: "ready",
    kind: previewKindForPath(resolved),
    title,
    subtitle: resolved,
    path: resolved,
    mimeType,
    sizeBytes: info.size,
    text,
    truncated: false,
  };
}

function emptyGitSummary(
  status: GitChangeSummary["status"],
  workspacePath: string | null,
  gitRoot: string | null,
  errorMessage?: string,
): GitChangeSummary {
  return {
    status,
    workspacePath,
    gitRoot,
    branch: null,
    upstream: null,
    ahead: null,
    behind: null,
    dirtyCount: 0,
    changedFiles: [],
    diffStat: null,
    stagedDiffStat: null,
    recentCommits: [],
    pullRequest: null,
    ...(errorMessage ? { errorMessage } : {}),
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFile("git", ["-C", cwd, ...args], {
    timeout: gitTimeoutMs,
    maxBuffer: 256 * 1024,
  });
  return String(stdout).trim();
}

async function readPullRequestSummary(cwd: string): Promise<GitPullRequestSummary | null> {
  try {
    const { stdout } = await execFile(
      "gh",
      ["pr", "view", "--json", "number,title,url,state,headRefName,baseRefName"],
      {
        cwd,
        timeout: 3_500,
        maxBuffer: 128 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: "1" },
      },
    );
    const parsed = JSON.parse(String(stdout)) as Partial<GitPullRequestSummary>;
    if (typeof parsed.number !== "number" || typeof parsed.title !== "string" || typeof parsed.url !== "string") {
      return null;
    }
    return {
      number: parsed.number,
      title: parsed.title,
      url: parsed.url,
      state: typeof parsed.state === "string" ? parsed.state : "unknown",
      headRefName: typeof parsed.headRefName === "string" ? parsed.headRefName : null,
      baseRefName: typeof parsed.baseRefName === "string" ? parsed.baseRefName : null,
    };
  } catch {
    return null;
  }
}

function parseAheadBehind(branchLine: string): { ahead: number | null; behind: number | null } {
  const ahead = branchLine.match(/ahead (\d+)/i);
  const behind = branchLine.match(/behind (\d+)/i);
  return {
    ahead: ahead ? Number(ahead[1]) : null,
    behind: behind ? Number(behind[1]) : null,
  };
}

function parseCommits(output: string): Array<{ sha: string; title: string; decorated: string }> {
  return output
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      const [sha = "", ...rest] = line.split(" ");
      const decorated = rest.join(" ").trim();
      const title = decorated.replace(/^\([^)]*\)\s*/, "");
      return { sha, title: title || decorated || sha, decorated };
    })
    .filter((commit) => commit.sha);
}

function normalizeStatusPath(value: string): string {
  if (value.includes(" -> ")) return value.split(" -> ").at(-1)?.trim() ?? value;
  return value;
}

function resolvePreviewPath(filePath: string, workspacePath: string | null | undefined): string {
  if (filePath.startsWith("file://")) return fileURLToPath(filePath);
  const expanded = expandHomePath(filePath);
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  const base = workspacePath?.trim() ? expandHomePath(workspacePath) : process.cwd();
  return path.resolve(base, expanded);
}

function expandHomePath(value: string): string {
  if (value === "~") return process.env.HOME ?? value;
  if (value.startsWith("~/")) {
    const home = process.env.HOME;
    return home ? path.join(home, value.slice(2)) : value;
  }
  return value;
}

function emptyPreview(message: string): RightPanelPreviewResult {
  return {
    status: "empty",
    kind: "empty",
    title: "Nothing selected",
    subtitle: message,
    mimeType: null,
    sizeBytes: null,
  };
}

function errorPreview(
  title: string,
  message: string,
  filePath?: string,
  mimeType?: string | null,
): RightPanelPreviewResult {
  return {
    status: "error",
    kind: "unsupported",
    title,
    subtitle: filePath ?? null,
    path: filePath,
    mimeType,
    sizeBytes: null,
    errorMessage: message,
  };
}

function tooLargePreview(
  title: string,
  filePath: string,
  mimeType: string | null,
  sizeBytes: number,
  limitBytes: number,
): RightPanelPreviewResult {
  return {
    status: "too_large",
    kind: "unsupported",
    title,
    subtitle: `File is larger than the ${formatBytes(limitBytes)} preview limit.`,
    path: filePath,
    mimeType,
    sizeBytes,
  };
}

function previewKindForPath(filePath: string): RightPanelPreviewResult["kind"] {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".mdx" || ext === ".markdown") return "markdown";
  if (codeExtensions.has(ext)) return "code";
  return "text";
}

function mimeTypeForPath(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  return mimeByExtension[ext] ?? null;
}

function isImageMime(mimeType: string | null): boolean {
  return Boolean(mimeType?.startsWith("image/"));
}

function isPdfOrOffice(mimeType: string | null, filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return (
    mimeType === "application/pdf" ||
    officeExtensions.has(ext)
  );
}

function looksBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  return sample.includes(0);
}

function isLocalPreviewUrl(url: URL): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname.toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const codeExtensions = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".mjs",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const officeExtensions = new Set([
  ".doc",
  ".docx",
  ".ppt",
  ".pptx",
  ".xls",
  ".xlsx",
  ".xlsm",
]);

const mimeByExtension: Record<string, string> = {
  ".avif": "image/avif",
  ".css": "text/css",
  ".csv": "text/csv",
  ".gif": "image/gif",
  ".htm": "text/html",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mdx": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xml": "application/xml",
};
