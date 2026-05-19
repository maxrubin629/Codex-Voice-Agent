import { app } from "electron";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { McpOkGrant } from "../shared/types";

type McpOkGrantsFile = {
  version: 1;
  grants: McpOkGrant[];
};

const GRANTS_FILE_NAME = "cva-mcp-ok-grants.json";

export class McpOkGrantStore {
  private grants: McpOkGrant[] = [];
  private ready = false;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath = path.join(app.getPath("userData"), GRANTS_FILE_NAME)) {}

  async ensureReady(): Promise<void> {
    if (this.ready) return;
    this.grants = await this.readFile();
    this.ready = true;
  }

  async list(): Promise<McpOkGrant[]> {
    await this.ensureReady();
    return [...this.grants].sort(compareGrant);
  }

  async has(server: string, tool: string): Promise<boolean> {
    await this.ensureReady();
    return this.grants.some((grant) => grant.server === server && grant.tool === tool);
  }

  async save(server: string, tool: string): Promise<McpOkGrant> {
    const normalized = normalizeGrant(server, tool);
    if (!normalized) throw new Error("MCP OK grant requires a server and tool.");
    await this.ensureReady();
    return this.enqueueMutation(async () => {
      const now = new Date().toISOString();
      const existing = this.grants.find(
        (grant) => grant.server === normalized.server && grant.tool === normalized.tool,
      );
      const grant: McpOkGrant = existing
        ? { ...existing, updatedAt: now }
        : { ...normalized, grantedAt: now, updatedAt: now };
      this.grants = [
        grant,
        ...this.grants.filter(
          (candidate) => candidate.server !== normalized.server || candidate.tool !== normalized.tool,
        ),
      ].sort(compareGrant);
      await this.writeFile(this.grants);
      return grant;
    });
  }

  async revoke(server: string, tool: string): Promise<McpOkGrant[]> {
    const normalized = normalizeGrant(server, tool);
    if (!normalized) throw new Error("MCP OK grant requires a server and tool.");
    await this.ensureReady();
    return this.enqueueMutation(async () => {
      this.grants = this.grants.filter(
        (grant) => grant.server !== normalized.server || grant.tool !== normalized.tool,
      );
      await this.writeFile(this.grants);
      return [...this.grants].sort(compareGrant);
    });
  }

  private enqueueMutation<T>(mutation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(mutation, mutation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async readFile(): Promise<McpOkGrant[]> {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<McpOkGrantsFile>;
      if (!Array.isArray(parsed.grants)) return [];
      return parsed.grants
        .map((grant) => normalizeStoredGrant(grant))
        .filter((grant): grant is McpOkGrant => grant !== null)
        .sort(compareGrant);
    } catch {
      return [];
    }
  }

  private async writeFile(grants: McpOkGrant[]): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${process.pid}.tmp`;
    const payload: McpOkGrantsFile = { version: 1, grants };
    await writeFile(tmpPath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    await rename(tmpPath, this.filePath);
  }
}

function normalizeGrant(server: string, tool: string): Pick<McpOkGrant, "server" | "tool"> | null {
  const normalizedServer = server.trim();
  const normalizedTool = tool.trim();
  if (!normalizedServer || !normalizedTool) return null;
  return { server: normalizedServer, tool: normalizedTool };
}

function normalizeStoredGrant(value: unknown): McpOkGrant | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const normalized = normalizeGrant(String(record.server ?? ""), String(record.tool ?? ""));
  if (!normalized) return null;
  const grantedAt = typeof record.grantedAt === "string" && record.grantedAt ? record.grantedAt : new Date().toISOString();
  const updatedAt = typeof record.updatedAt === "string" && record.updatedAt ? record.updatedAt : grantedAt;
  return { ...normalized, grantedAt, updatedAt };
}

function compareGrant(left: McpOkGrant, right: McpOkGrant): number {
  const server = left.server.localeCompare(right.server);
  if (server !== 0) return server;
  return left.tool.localeCompare(right.tool);
}
