import { contextBridge, ipcRenderer } from "electron";
import type {
  AppEvent,
  AppState,
  ApprovalDecision,
  CodexPermissionMode,
  CodexSettingsScope,
  CodexServiceTier,
  CodexVoiceApi,
  ReasoningEffort,
  ReplaySessionLoadResult,
  ReplaySessionMetadata,
  ReplayRecordingState,
  ToolQuestionAnswer,
  WindowChromeState,
} from "../shared/types";

const api: CodexVoiceApi = {
  getState: () => ipcRenderer.invoke("app:getState"),
  openVoiceWindow: () => ipcRenderer.invoke("app:openVoiceWindow"),
  getWindowChromeState: () => ipcRenderer.invoke("app:getWindowChromeState"),
  expandVoiceWindowForRightPane: () => ipcRenderer.invoke("app:expandVoiceWindowForRightPane"),
  collapseVoiceWindowFromRightPane: () => ipcRenderer.invoke("app:collapseVoiceWindowFromRightPane"),
  openDebugWindow: () => ipcRenderer.invoke("app:openDebugWindow"),
  getEvents: () => ipcRenderer.invoke("app:getEvents"),
  clearEvents: () => ipcRenderer.invoke("app:clearEvents"),
  logEvent: (event: AppEvent) => ipcRenderer.invoke("app:logEvent", event),
  listReplaySessions: (projectId?: string) =>
    ipcRenderer.invoke("replay:list", { projectId }) as Promise<ReplaySessionMetadata[]>,
  getReplayRecordingState: () =>
    ipcRenderer.invoke("replay:recordingState") as Promise<ReplayRecordingState>,
  startReplayRecording: (name?: string) =>
    ipcRenderer.invoke("replay:start", { name }) as Promise<ReplaySessionMetadata>,
  stopReplayRecording: () => ipcRenderer.invoke("replay:stop") as Promise<ReplaySessionMetadata | null>,
  loadReplaySession: (projectId: string, replayId: string) =>
    ipcRenderer.invoke("replay:load", { projectId, replayId }) as Promise<ReplaySessionLoadResult>,
  renameReplaySession: (projectId: string, replayId: string, name: string) =>
    ipcRenderer.invoke("replay:rename", { projectId, replayId, name }) as Promise<ReplaySessionMetadata>,
  deleteReplaySession: (projectId: string, replayId: string) =>
    ipcRenderer.invoke("replay:delete", { projectId, replayId }),
  deleteAllReplaySessions: (projectId?: string) => ipcRenderer.invoke("replay:deleteAll", { projectId }),
  selectWorkspaceFolder: () => ipcRenderer.invoke("projects:selectWorkspaceFolder"),
  setWorkspaceFolder: (workspacePath: string, name?: string | null) =>
    ipcRenderer.invoke("projects:setWorkspaceFolder", { workspacePath, name }),
  createProject: (name?: string, workspacePath?: string | null) =>
    ipcRenderer.invoke("projects:create", { name, workspacePath }),
  resumeProject: (projectId: string) => ipcRenderer.invoke("projects:resume", { projectId }),
  archiveProject: (projectId: string) => ipcRenderer.invoke("projects:archive", { projectId }),
  restoreProject: (projectId: string) => ipcRenderer.invoke("projects:restore", { projectId }),
  createChat: (name: string, projectId?: string) =>
    ipcRenderer.invoke("projects:createChat", { name, projectId }),
  switchChat: (chatId: string, projectId?: string) =>
    ipcRenderer.invoke("projects:switchChat", { chatId, projectId }),
  archiveChat: (chatId: string, projectId?: string) =>
    ipcRenderer.invoke("projects:archiveChat", { chatId, projectId }),
  restoreChat: (chatId: string, projectId?: string) =>
    ipcRenderer.invoke("projects:restoreChat", { chatId, projectId }),
  listChats: (projectId?: string) => ipcRenderer.invoke("projects:listChats", { projectId }),
  showProjectChats: (open?: boolean) => ipcRenderer.invoke("projects:showChats", { open }),
  summarizeProject: (projectId?: string, chatId?: string) =>
    ipcRenderer.invoke("projects:summarize", { projectId, chatId }),
  sendToCodex: (text: string, chatId?: string, workspacePath?: string | null) =>
    ipcRenderer.invoke("codex:send", { text, chatId, workspacePath }),
  steerCodex: (text: string, chatId?: string) => ipcRenderer.invoke("codex:steer", { text, chatId }),
  queueCodexRequest: (text: string, chatId?: string, workspacePath?: string | null) =>
    ipcRenderer.invoke("codex:queue", { text, chatId, workspacePath }),
  cancelQueuedCodexRequest: (queuedId?: string | null, chatId?: string) =>
    ipcRenderer.invoke("codex:cancelQueued", { queuedId, chatId }),
  interruptCodex: (chatId?: string) => ipcRenderer.invoke("codex:interrupt", { chatId }),
  getChatStatus: (chatId?: string) => ipcRenderer.invoke("projects:chatStatus", { chatId }),
  listSubagents: (chatId?: string) => ipcRenderer.invoke("codex:listSubagents", { chatId }),
  inspectSubagent: (target?: string, chatId?: string) =>
    ipcRenderer.invoke("codex:inspectSubagent", { target, chatId }),
  steerSubagent: (target: string | undefined, text: string, chatId?: string) =>
    ipcRenderer.invoke("codex:steerSubagent", { target, text, chatId }),
  setCodexSettings: (
    settings: {
      model?: string | null;
      reasoningEffort?: ReasoningEffort | null;
      serviceTier?: CodexServiceTier | null;
      permissionMode?: CodexPermissionMode | null;
    },
    scope: CodexSettingsScope,
  ) => ipcRenderer.invoke("codex:setSettings", { settings, scope }),
  answerApproval: (requestId: string | number, decision: ApprovalDecision) =>
    ipcRenderer.invoke("codex:answerApproval", { requestId, decision }),
  answerToolQuestion: (requestId: string | number, answers: ToolQuestionAnswer[]) =>
    ipcRenderer.invoke("codex:answerToolQuestion", { requestId, answers }),
  listMcpOkGrants: () => ipcRenderer.invoke("mcpOkGrants:list"),
  revokeMcpOkGrant: (server: string, tool: string) =>
    ipcRenderer.invoke("mcpOkGrants:revoke", { server, tool }),
  steerCodexThread: (threadId: string, text: string) =>
    ipcRenderer.invoke("codex:steerThread", { threadId, text }),
  getThreadSummary: (threadId: string) => ipcRenderer.invoke("rightPanel:getThreadSummary", { threadId }),
  getActiveThreadSummary: (chatId?: string) =>
    ipcRenderer.invoke("rightPanel:getActiveThreadSummary", { chatId }),
  getTranscriptMessages: (chatId?: string) =>
    ipcRenderer.invoke("rightPanel:getTranscriptMessages", { chatId }),
  saveOpenAiApiKey: (apiKey: string) => ipcRenderer.invoke("settings:saveOpenAiApiKey", { apiKey }),
  clearOpenAiApiKey: () => ipcRenderer.invoke("settings:clearOpenAiApiKey"),
  createRealtimeClientSecret: () => ipcRenderer.invoke("realtime:createClientSecret"),
  setRealtimeSettings: (settings) => ipcRenderer.invoke("realtime:setSettings", { settings }),
  setPhoneSettings: (settings) => ipcRenderer.invoke("phone:setSettings", { settings }),
  hangupPhoneCall: () => ipcRenderer.invoke("phone:hangup"),
  onWindowChromeState: (listener: (state: WindowChromeState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: WindowChromeState) => listener(state);
    ipcRenderer.on("app:windowChromeState", handler);
    return () => ipcRenderer.off("app:windowChromeState", handler);
  },
  onAppState: (listener: (state: AppState) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, state: AppState) => listener(state);
    ipcRenderer.on("app:state", handler);
    return () => ipcRenderer.off("app:state", handler);
  },
  onAppEvent: (listener: (event: AppEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, appEvent: AppEvent) => listener(appEvent);
    ipcRenderer.on("app:event", handler);
    return () => ipcRenderer.off("app:event", handler);
  },
};

contextBridge.exposeInMainWorld("codexVoice", api);
