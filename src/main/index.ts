import { app, BrowserWindow, clipboard, dialog, ipcMain, type IpcMainInvokeEvent, type OpenDialogOptions } from "electron";
import path from "node:path";
import {
  clearExaApiKey,
  clearOpenAiApiKey,
  revealExaApiKey,
  revealOpenAiApiKey,
  saveExaApiKey,
  saveOpenAiApiKey,
} from "./apiKeyStore";
import appIcon from "./assets/app-icon.png?asset";
import { CodexBridge } from "./codexBridge";
import { VoiceCodexOrchestrator } from "./orchestrator";
import { ProjectStore } from "./projectStore";
import {
  openCodexThreadInApp,
  openRightPanelTarget,
  previewRightPanelTarget,
  readGitChangeSummary,
} from "./rightPanelData";
import { cancelWebSearchForRealtime, searchWebForRealtime } from "./realtime";
import { appendBufferedEvent } from "../shared/eventBuffer";
import type {
  ApprovalDecision,
  AppEvent,
  CodexPermissionMode,
  CodexSettingsScope,
  CreateCodexThreadArgs,
  DispatchCodexTaskArgs,
  ListCodexThreadsArgs,
  RealtimeModelId,
  RealtimeReasoningEffort,
  RealtimeVoiceId,
  ReasoningEffort,
  RightPanelOpenTarget,
  RightPanelPreviewRequest,
  ToolQuestionAnswer,
  VoiceExecCommandArgs,
  VoiceWebSearchArgs,
  VoiceWriteStdinArgs,
  WindowChromeState,
} from "../shared/types";

const appName = "Codex Voice";

let voiceWindow: BrowserWindow | null = null;
let debugWindow: BrowserWindow | null = null;
let orchestrator: VoiceCodexOrchestrator | null = null;
let bufferedEvents: AppEvent[] = [];

type RendererWindowKind = "voice" | "debug";

guardConsoleStream(process.stdout);
guardConsoleStream(process.stderr);

function guardConsoleStream(stream: NodeJS.WriteStream): void {
  stream.on("error", (error: NodeJS.ErrnoException) => {
    if (error.code === "EIO" || error.code === "EPIPE") return;
    throw error;
  });
}

function createVoiceWindow(): void {
  if (voiceWindow && !voiceWindow.isDestroyed()) {
    voiceWindow.show();
    voiceWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    width: 444,
    height: 661,
    minWidth: 410,
    minHeight: 640,
    title: "Codex Voice",
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 14, y: 18 },
        }
      : {}),
    icon: appIcon,
    backgroundColor: "#121212",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  voiceWindow = window;

  loadRenderer(window, "voice");
  window.webContents.setZoomFactor(0.85);
  window.webContents.once("did-finish-load", () => publishWindowChromeState(window));
  window.on("enter-full-screen", () => publishWindowChromeState(window));
  window.on("leave-full-screen", () => publishWindowChromeState(window));
  window.on("closed", () => {
    if (voiceWindow === window) voiceWindow = null;
  });
}

function createDebugWindow(): void {
  if (debugWindow && !debugWindow.isDestroyed()) {
    debugWindow.show();
    debugWindow.focus();
    return;
  }

  const window = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 960,
    minHeight: 700,
    title: "Codex Voice Debug",
    icon: appIcon,
    backgroundColor: "#f4f6f8",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  debugWindow = window;

  loadRenderer(window, "debug");
  window.on("closed", () => {
    if (debugWindow === window) debugWindow = null;
  });
}

function loadRenderer(window: BrowserWindow, kind: RendererWindowKind): void {
  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = new URL(process.env.ELECTRON_RENDERER_URL);
    rendererUrl.searchParams.set("window", kind);
    void window.loadURL(rendererUrl.toString());
  } else {
    void window.loadFile(path.join(__dirname, "../renderer/index.html"), {
      query: { window: kind },
    });
  }
}

function appWindows(): BrowserWindow[] {
  return [voiceWindow, debugWindow].filter(
    (window): window is BrowserWindow => Boolean(window && !window.isDestroyed()),
  );
}

function broadcastToAppWindows(channel: string, payload: unknown): void {
  for (const window of appWindows()) {
    window.webContents.send(channel, payload);
  }
}

function windowChromeStateFor(window: BrowserWindow | null): WindowChromeState {
  return {
    isFullScreen: Boolean(window && !window.isDestroyed() && window.isFullScreen()),
  };
}

function publishWindowChromeState(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  window.webContents.send("app:windowChromeState", windowChromeStateFor(window));
}

function recordEvent(event: AppEvent): void {
  bufferedEvents = appendBufferedEvent(bufferedEvents, event);
}

function publishEvent(event: AppEvent): void {
  recordEvent(event);
  void orchestrator?.recordTranscriptEvent(event).catch(() => {
    // Transcript persistence should never break live event delivery.
  });
  broadcastToAppWindows("app:event", event);
}

function normalizeAppEvent(payload: AppEvent): AppEvent {
  const source =
    payload.source === "app" || payload.source === "codex" || payload.source === "realtime"
      ? payload.source
      : "app";
  return {
    at: typeof payload.at === "string" && payload.at ? payload.at : new Date().toISOString(),
    source,
    kind: typeof payload.kind === "string" && payload.kind ? payload.kind : "event",
    message: typeof payload.message === "string" ? payload.message : String(payload.message ?? ""),
    ...(payload.raw !== undefined ? { raw: payload.raw } : {}),
  };
}

async function boot(): Promise<void> {
  const store = new ProjectStore();
  const codex = new CodexBridge();
  orchestrator = new VoiceCodexOrchestrator(store, codex);

  orchestrator.on("state", (state) => broadcastToAppWindows("app:state", state));
  orchestrator.on("event", (event) => publishEvent(normalizeAppEvent(event)));

  createVoiceWindow();
  await orchestrator.initialize();
}

function requireOrchestrator(): VoiceCodexOrchestrator {
  if (!orchestrator) throw new Error("App is still starting.");
  return orchestrator;
}

function registerIpcHandler(
  channel: string,
  listener: Parameters<typeof ipcMain.handle>[1],
): void {
  ipcMain.handle(channel, listener);
}

function requireVoiceWindowSecretRequest(event: IpcMainInvokeEvent): void {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  if (!senderWindow || senderWindow !== voiceWindow) {
    throw new Error("API keys can only be viewed or copied from the voice window.");
  }
}

app.setName(appName);

app.whenReady().then(() => {
  app.setAboutPanelOptions({ applicationName: appName });
  app.dock?.setIcon(appIcon);
  registerIpc();
  void boot();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createVoiceWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  orchestrator?.shutdown();
});

function registerIpc(): void {
  registerIpcHandler("app:getState", () => requireOrchestrator().state());
  registerIpcHandler("app:openVoiceWindow", () => {
    createVoiceWindow();
  });
  registerIpcHandler("app:getWindowChromeState", (event) =>
    windowChromeStateFor(BrowserWindow.fromWebContents(event.sender)),
  );
  registerIpcHandler("app:openDebugWindow", () => {
    createDebugWindow();
  });
  registerIpcHandler("app:getEvents", () => bufferedEvents);
  registerIpcHandler("app:clearEvents", () => {
    bufferedEvents = [];
  });
  registerIpcHandler("app:logEvent", (_event, payload: AppEvent) => {
    publishEvent(normalizeAppEvent(payload));
  });
  registerIpcHandler("projects:selectWorkspaceFolder", async () => {
    const options: OpenDialogOptions = {
      title: "Use an existing folder",
      buttonLabel: "Use folder",
      properties: ["openDirectory"],
    };
    const result =
      voiceWindow && !voiceWindow.isDestroyed()
        ? await dialog.showOpenDialog(voiceWindow, options)
        : await dialog.showOpenDialog(options);
    const folderPath = result.filePaths[0];
    if (result.canceled || !folderPath) return null;
    return {
      path: folderPath,
      name: path.basename(folderPath) || folderPath,
    };
  });
  registerIpcHandler(
    "projects:setWorkspaceFolder",
    (_event, payload: { workspacePath?: string | null; name?: string | null }) =>
      requireOrchestrator().setWorkspaceFolder(payload.workspacePath, payload.name),
  );
  registerIpcHandler(
    "projects:create",
    (_event, payload: { name?: string; workspacePath?: string | null }) =>
      requireOrchestrator().createProject(payload.name, payload.workspacePath),
  );
  registerIpcHandler(
    "projects:resume",
    (_event, payload: { projectId: string }) => requireOrchestrator().resumeProject(payload.projectId),
  );
  registerIpcHandler(
    "projects:rename",
    (_event, payload: { projectId: string; name: string }) =>
      requireOrchestrator().renameProject(payload.projectId, payload.name),
  );
  registerIpcHandler(
    "projects:remove",
    (_event, payload: { projectId: string }) => requireOrchestrator().removeProject(payload.projectId),
  );
  registerIpcHandler(
    "projects:archive",
    (_event, payload: { projectId: string }) => requireOrchestrator().archiveProject(payload.projectId),
  );
  registerIpcHandler(
    "projects:restore",
    (_event, payload: { projectId: string }) => requireOrchestrator().restoreProject(payload.projectId),
  );
  registerIpcHandler(
    "projects:createChat",
    (_event, payload: { name: string; projectId?: string }) =>
      requireOrchestrator().createChat(payload.name, payload.projectId),
  );
  registerIpcHandler(
    "projects:switchChat",
    (_event, payload: { chatId: string; projectId?: string }) =>
      requireOrchestrator().switchChat(payload.chatId, payload.projectId),
  );
  registerIpcHandler(
    "projects:renameChat",
    (_event, payload: { chatId: string; name: string; projectId?: string }) =>
      requireOrchestrator().renameChat(payload.chatId, payload.name, payload.projectId),
  );
  registerIpcHandler(
    "projects:removeChat",
    (_event, payload: { chatId: string; projectId?: string }) =>
      requireOrchestrator().removeChat(payload.chatId, payload.projectId),
  );
  registerIpcHandler(
    "projects:archiveChat",
    (_event, payload: { chatId: string; projectId?: string }) =>
      requireOrchestrator().archiveChat(payload.chatId, payload.projectId),
  );
  registerIpcHandler(
    "projects:restoreChat",
    (_event, payload: { chatId: string; projectId?: string }) =>
      requireOrchestrator().restoreChat(payload.chatId, payload.projectId),
  );
  registerIpcHandler(
    "projects:listChats",
    (_event, payload: { projectId?: string }) => requireOrchestrator().listChats(payload.projectId),
  );
  registerIpcHandler(
    "projects:showChats",
    (_event, payload: { open?: boolean }) => requireOrchestrator().showProjectChats(payload.open),
  );
  registerIpcHandler("projects:chatStatus", (_event, payload: { chatId?: string }) =>
    requireOrchestrator().getChatStatus(payload.chatId),
  );
  registerIpcHandler(
    "projects:summarize",
    (_event, payload: { projectId?: string; chatId?: string }) =>
      requireOrchestrator().summarizeProject(payload.projectId, payload.chatId),
  );
  registerIpcHandler("projects:createThread", (_event, payload: CreateCodexThreadArgs) =>
    requireOrchestrator().createThread(payload),
  );
  registerIpcHandler("projects:listThreads", (_event, payload?: ListCodexThreadsArgs) =>
    requireOrchestrator().listProjectThreads(payload ?? {}),
  );
  registerIpcHandler("projects:allThreadStatus", (_event, payload?: ListCodexThreadsArgs) =>
    requireOrchestrator().getAllThreadStatus(payload ?? {}),
  );
  registerIpcHandler("codex:dispatchTask", (_event, payload: DispatchCodexTaskArgs) =>
    requireOrchestrator().dispatchCodexTask(payload),
  );
  registerIpcHandler(
    "codex:send",
    (_event, payload: { text: string; chatId?: string; workspacePath?: string | null }) =>
      requireOrchestrator().sendToCodex(payload.text, payload.chatId, payload.workspacePath),
  );
  registerIpcHandler("codex:steer", (_event, payload: { text: string; chatId?: string }) =>
    requireOrchestrator().steerCodex(payload.text, payload.chatId),
  );
  registerIpcHandler("codex:interrupt", (_event, payload?: { chatId?: string }) =>
    requireOrchestrator().interruptCodex(payload?.chatId),
  );
  registerIpcHandler("codex:openThreadInApp", (_event, payload: { threadId?: string }) =>
    openCodexThreadInApp(payload.threadId),
  );
  registerIpcHandler(
    "codex:setSettings",
    (
      _event,
      payload: {
        settings: {
          model?: string | null;
          reasoningEffort?: ReasoningEffort | null;
          serviceTier?: string | null;
          permissionMode?: CodexPermissionMode | null;
        };
        scope: CodexSettingsScope;
      },
    ) => requireOrchestrator().setCodexSettings(payload.settings, payload.scope),
  );
  registerIpcHandler(
    "codex:answerApproval",
    (_event, payload: { requestId: string | number; decision: ApprovalDecision }) =>
      requireOrchestrator().answerApproval(payload.requestId, payload.decision),
  );
  registerIpcHandler(
    "codex:answerToolQuestion",
    (_event, payload: { requestId: string | number; answers: ToolQuestionAnswer[] }) =>
      requireOrchestrator().answerToolQuestion(payload.requestId, payload.answers),
  );
  registerIpcHandler(
    "rightPanel:getActiveThreadSummary",
    (_event, payload?: { chatId?: string }) => requireOrchestrator().getActiveThreadSummary(payload?.chatId),
  );
  registerIpcHandler(
    "rightPanel:getTranscriptMessages",
    (_event, payload?: { chatId?: string }) => requireOrchestrator().getTranscriptMessages(payload?.chatId),
  );
  registerIpcHandler(
    "rightPanel:getGitChangeSummary",
    (_event, payload?: { workspacePath?: string | null }) => readGitChangeSummary(payload?.workspacePath),
  );
  registerIpcHandler(
    "rightPanel:previewTarget",
    (_event, payload: RightPanelPreviewRequest) => previewRightPanelTarget(payload),
  );
  registerIpcHandler(
    "rightPanel:openTarget",
    (_event, payload: RightPanelOpenTarget) => openRightPanelTarget(payload),
  );
  registerIpcHandler("voiceTools:execCommand", (_event, payload: VoiceExecCommandArgs) =>
    requireOrchestrator().execCommandForVoice(payload),
  );
  registerIpcHandler("voiceTools:writeStdin", (_event, payload: VoiceWriteStdinArgs) =>
    requireOrchestrator().writeStdinForVoice(payload),
  );
  registerIpcHandler("voiceTools:terminateExecSession", (_event, payload: { sessionId: number }) =>
    requireOrchestrator().terminateVoiceExecSession(payload.sessionId),
  );
  registerIpcHandler("voiceTools:applyPatch", (_event, payload: { input: string }) =>
    requireOrchestrator().applyPatchForVoice(payload.input),
  );
  registerIpcHandler("voiceTools:webSearch", (_event, payload: VoiceWebSearchArgs) =>
    searchWebForRealtime(payload),
  );
  registerIpcHandler("voiceTools:cancelWebSearch", (_event, payload: { requestId: string }) => {
    cancelWebSearchForRealtime(payload.requestId);
  });
  registerIpcHandler("settings:saveOpenAiApiKey", (_event, payload: { apiKey: string }) => {
    saveOpenAiApiKey(payload.apiKey);
  });
  registerIpcHandler("settings:clearOpenAiApiKey", () => {
    clearOpenAiApiKey();
  });
  registerIpcHandler("settings:revealOpenAiApiKey", (event) => {
    requireVoiceWindowSecretRequest(event);
    return revealOpenAiApiKey();
  });
  registerIpcHandler("settings:copyOpenAiApiKey", (event) => {
    requireVoiceWindowSecretRequest(event);
    const secret = revealOpenAiApiKey();
    clipboard.writeText(secret.value);
    return { source: secret.source, encrypted: secret.encrypted };
  });
  registerIpcHandler("settings:saveExaApiKey", (_event, payload: { apiKey: string }) => {
    saveExaApiKey(payload.apiKey);
  });
  registerIpcHandler("settings:clearExaApiKey", () => {
    clearExaApiKey();
  });
  registerIpcHandler("settings:revealExaApiKey", (event) => {
    requireVoiceWindowSecretRequest(event);
    return revealExaApiKey();
  });
  registerIpcHandler("settings:copyExaApiKey", (event) => {
    requireVoiceWindowSecretRequest(event);
    const secret = revealExaApiKey();
    clipboard.writeText(secret.value);
    return { source: secret.source, encrypted: secret.encrypted };
  });
  registerIpcHandler("realtime:createClientSecret", () =>
    requireOrchestrator().createRealtimeClientSecret(),
  );
  registerIpcHandler(
    "realtime:setSettings",
    (
      _event,
      payload: {
        settings: {
          model?: RealtimeModelId | null;
          voice?: RealtimeVoiceId | null;
          reasoningEffort?: RealtimeReasoningEffort | null;
        };
      },
    ) =>
      requireOrchestrator().setRealtimeSettings(payload.settings),
  );
}
