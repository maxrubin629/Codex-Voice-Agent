import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/cva-test",
  },
}));

import { ProjectStore } from "./projectStore";

const tempFolders: string[] = [];

afterEach(async () => {
  await Promise.all(tempFolders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

describe("ProjectStore sidecar layout", () => {
  it("writes project metadata and transcripts inside one agent folder", async () => {
    const store = new ProjectStore(await tempBaseFolder());
    await store.ensureReady();

    const project = await store.createProject("Layout Test");
    const projectWithChat = await store.addChat(project.id, "Main", "thread-1");
    const chatId = projectWithChat.activeChatId;
    expect(chatId).toBeTruthy();

    await store.upsertTranscriptMessage(project.id, chatId!, {
      id: "message-1",
      chatId: chatId!,
      threadId: "thread-1",
      source: "realtime",
      role: "user",
      text: "hello from voice",
      createdAt: "2026-05-13T12:00:00.000Z",
      completedAt: "2026-05-13T12:00:01.000Z",
      status: "completed",
    });

    const agentFolder = path.join(project.folderPath, ".cva-agent");
    const projectPath = path.join(agentFolder, "project.json");
    const transcriptPath = path.join(agentFolder, "transcripts", `${chatId}.jsonl`);

    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(transcriptPath)).toBe(true);
    expect(existsSync(path.join(project.folderPath, ".cva-project.json"))).toBe(false);
    expect(existsSync(path.join(project.folderPath, ".cva-transcripts"))).toBe(false);

    expect(JSON.parse(await readFile(projectPath, "utf8"))).toMatchObject({
      id: project.id,
      activeChatId: chatId,
    });
    expect(
      (await readFile(transcriptPath, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ).toMatchObject([
      {
        id: "message-1",
        chatId,
        text: "hello from voice",
      },
    ]);
  });

  it("persists, loads, renames, and deletes opt-in replay sessions", async () => {
    const store = new ProjectStore(await tempBaseFolder());
    await store.ensureReady();

    const project = await store.createProject("Replay Test");
    const projectWithChat = await store.addChat(project.id, "Main", "thread-1");
    const chatId = projectWithChat.activeChatId;
    expect(chatId).toBeTruthy();

    expect(await store.listReplaySessions(project.id)).toEqual([]);

    const session = await store.createReplaySession({
      projectId: project.id,
      chatId: chatId!,
      threadId: "thread-1",
      name: "First pass",
    });

    await store.appendReplayEvent(project.id, session.id, {
      at: "2026-05-13T12:00:00.000Z",
      source: "realtime",
      kind: "outbound",
      message: "Realtime outbound response.create.",
      raw: { type: "response.create", response: { instructions: "say hi" } },
    });
    await store.appendReplayEvent(project.id, session.id, {
      at: "2026-05-13T12:00:01.000Z",
      source: "codex",
      kind: "turn/start/request",
      message: "Sending turn/start to Codex app-server.",
      raw: { threadId: "thread-1", input: [{ text: "Voice ===\nhello" }] },
    });

    const loaded = await store.loadReplaySession(project.id, session.id);
    expect(loaded.metadata).toMatchObject({
      id: session.id,
      name: "First pass",
      eventCount: 2,
      chatId,
      threadId: "thread-1",
    });
    expect(loaded.events).toHaveLength(2);
    expect(loaded.events[0].raw).toMatchObject({ type: "response.create" });

    const renamed = await store.renameReplaySession(project.id, session.id, "Renamed");
    expect(renamed.name).toBe("Renamed");

    const finalized = await store.finalizeReplaySession(project.id, session.id);
    expect(finalized?.stoppedAt).toBeTruthy();

    const replayPath = path.join(project.folderPath, ".cva-agent", "replays", session.id);
    expect(existsSync(replayPath)).toBe(true);
    await store.deleteReplaySession(project.id, session.id);
    expect(existsSync(replayPath)).toBe(false);

    await store.createReplaySession({
      projectId: project.id,
      chatId: chatId!,
      threadId: "thread-1",
      name: "Second pass",
    });
    expect(await store.listReplaySessions(project.id)).toHaveLength(1);
    await store.deleteAllReplaySessions(project.id);
    expect(await store.listReplaySessions(project.id)).toEqual([]);
  });

  it("rejects dot replay ids before deleting paths", async () => {
    const store = new ProjectStore(await tempBaseFolder());
    await store.ensureReady();

    const project = await store.createProject("Replay Path Test");
    const projectWithChat = await store.addChat(project.id, "Main", "thread-1");
    const chatId = projectWithChat.activeChatId;
    expect(chatId).toBeTruthy();

    await store.createReplaySession({
      projectId: project.id,
      chatId: chatId!,
      threadId: "thread-1",
      name: "Keep me",
    });

    const agentFolder = path.join(project.folderPath, ".cva-agent");
    expect(existsSync(agentFolder)).toBe(true);

    await expect(store.deleteReplaySession(project.id, "..")).rejects.toThrow(/Invalid replay id/);
    expect(existsSync(agentFolder)).toBe(true);
    expect(await store.listReplaySessions(project.id)).toHaveLength(1);
  });

});

async function tempBaseFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "cva-project-store-"));
  tempFolders.push(folder);
  return folder;
}
