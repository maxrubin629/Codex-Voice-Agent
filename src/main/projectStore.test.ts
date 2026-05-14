import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/codex-voice-test",
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

    const agentFolder = path.join(project.folderPath, ".codex-voice-agent");
    const projectPath = path.join(agentFolder, "project.json");
    const transcriptPath = path.join(agentFolder, "transcripts", `${chatId}.jsonl`);

    expect(existsSync(projectPath)).toBe(true);
    expect(existsSync(transcriptPath)).toBe(true);
    expect(existsSync(path.join(project.folderPath, ".codex-voice-project.json"))).toBe(false);
    expect(existsSync(path.join(project.folderPath, ".codex-voice-transcripts"))).toBe(false);

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

});

async function tempBaseFolder(): Promise<string> {
  const folder = await mkdtemp(path.join(os.tmpdir(), "codex-voice-project-store-"));
  tempFolders.push(folder);
  return folder;
}
