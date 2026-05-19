import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/cva-test",
  },
}));

import { McpOkGrantStore } from "./mcpOkGrants";

describe("MCP OK grant store", () => {
  it("persists a normalized global server/tool grant", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cva-grants-"));
    const filePath = path.join(dir, "grants.json");
    const store = new McpOkGrantStore(filePath);

    const grant = await store.save(" google-drive ", " search ");

    expect(grant).toMatchObject({ server: "google-drive", tool: "search" });
    expect(await store.has("google-drive", "search")).toBe(true);

    const raw = JSON.parse(await readFile(filePath, "utf8")) as { grants: unknown[] };
    expect(raw.grants).toHaveLength(1);
    expect(raw.grants[0]).toMatchObject({ server: "google-drive", tool: "search" });
    expect(raw.grants[0]).not.toHaveProperty("arguments");
    expect(raw.grants[0]).not.toHaveProperty("threadId");
    expect(raw.grants[0]).not.toHaveProperty("requestId");
  });

  it("rejects empty server or tool grants", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cva-grants-"));
    const store = new McpOkGrantStore(path.join(dir, "grants.json"));

    await expect(store.save("", "search")).rejects.toThrow("requires a server and tool");
    await expect(store.save("google-drive", " ")).rejects.toThrow("requires a server and tool");
  });
});
