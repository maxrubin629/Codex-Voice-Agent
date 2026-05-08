import { contextBridge, ipcRenderer } from "electron";
import type {
  AppEvent,
  AppState,
  ApprovalDecision,
  CodexPermissionMode,
  CodexSettingsScope,
  CodexServiceTier,
  CodexVoiceApi,
  CreateCodexThreadArgs,
  DispatchCodexTaskArgs,
  ListCodexThreadsArgs,
  ReasoningEffort,
  RightPanelOpenTarget,
  RightPanelPreviewRequest,
  ToolQuestionAnswer,
  VoiceExecCommandArgs,
  VoiceWriteStdinArgs,
  WindowChromeState,
} from "../shared/types";

const api: CodexVoiceApi = {
  getState: () => ipcRenderer.invoke("app:getState"),
  openVoiceWindow: () => ipcRenderer.invoke("app:openVoiceWindow"),
  getWindowChromeState: () => ipcRenderer.invoke("app:getWindowChromeState"),
  openDebugWindow: () => ipcRenderer.invoke("app:openDebugWindow"),
  getEvents: () => ipcRenderer.invoke("app:getEvents"),
  clearEvents: () => ipcRenderer.invoke("app:clearEvents"),
  logEvent: (event: AppEvent) => ipcRenderer.invoke("app:logEvent", event),
  selectWorkspaceFolder: () => ipcRenderer.invoke("projects:selectWorkspaceFolder"),
  setWorkspaceFolder: (workspacePath: string, name?: string | null) =>
    ipcRenderer.invoke("projects:setWorkspaceFolder", { workspacePath, name }),
  createProject: (name?: string, workspacePath?: string | null) =>
    ipcRenderer.invoke("projects:create", { name, workspacePath }),
  resumeProject: (projectId: string) => ipcRenderer.invoke("projects:resume", { projectId }),
  renameProject: (projectId: string, name: string) =>
    ipcRenderer.invoke("projects:rename", { projectId, name }),
  removeProject: (projectId: string) => ipcRenderer.invoke("projects:remove", { projectId }),
  archiveProject: (projectId: string) => ipcRenderer.invoke("projects:archive", { projectId }),
  restoreProject: (projectId: string) => ipcRenderer.invoke("projects:restore", { projectId }),
  createChat: (name: string, projectId?: string) =>
    ipcRenderer.invoke("projects:createChat", { name, projectId }),
  switchChat: (chatId: string, projectId?: string) =>
    ipcRenderer.invoke("projects:switchChat", { chatId, projectId }),
  renameChat: (chatId: string, name: string, projectId?: string) =>
    ipcRenderer.invoke("projects:renameChat", { chatId, name, projectId }),
  removeChat: (chatId: string, projectId?: string) =>
    ipcRenderer.invoke("projects:removeChat", { chatId, projectId }),
  archiveChat: (chatId: string, projectId?: string) =>
    ipcRenderer.invoke("projects:archiveChat", { chatId, projectId }),
  restoreChat: (chatId: string, projectId?: string) =>
    ipcRenderer.invoke("projects:restoreChat", { chatId, projectId }),
  listChats: (projectId?: string) => ipcRenderer.invoke("projects:listChats", { projectId }),
  showProjectChats: (open?: boolean) => ipcRenderer.invoke("projects:showChats", { open }),
  summarizeProject: (projectId?: string, chatId?: string) =>
    ipcRenderer.invoke("projects:summarize", { projectId, chatId }),
  createThread: (args: CreateCodexThreadArgs) => ipcRenderer.invoke("projects:createThread", args),
  listProjectThreads: (args?: ListCodexThreadsArgs) => ipcRenderer.invoke("projects:listThreads", args ?? {}),
  getAllThreadStatus: (args?: ListCodexThreadsArgs) =>
    ipcRenderer.invoke("projects:allThreadStatus", args ?? {}),
  dispatchCodexTask: (args: DispatchCodexTaskArgs) => ipcRenderer.invoke("codex:dispatchTask", args),
  sendToCodex: (text: string, chatId?: string, workspacePath?: string | null) =>
    ipcRenderer.invoke("codex:send", { text, chatId, workspacePath }),
  steerCodex: (text: string, chatId?: string) => ipcRenderer.invoke("codex:steer", { text, chatId }),
  interruptCodex: (chatId?: string) => ipcRenderer.invoke("codex:interrupt", { chatId }),
  openCodexThreadInApp: (threadId: string) =>
    ipcRenderer.invoke("codex:openThreadInApp", { threadId }),
  getChatStatus: (chatId?: string) => ipcRenderer.invoke("projects:chatStatus", { chatId }),
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
  getActiveThreadSummary: (chatId?: string) =>
    ipcRenderer.invoke("rightPanel:getActiveThreadSummary", { chatId }),
  getTranscriptMessages: (chatId?: string) =>
    ipcRenderer.invoke("rightPanel:getTranscriptMessages", { chatId }),
  getGitChangeSummary: (workspacePath?: string | null) =>
    ipcRenderer.invoke("rightPanel:getGitChangeSummary", { workspacePath }),
  previewRightPanelTarget: (target: RightPanelPreviewRequest) =>
    ipcRenderer.invoke("rightPanel:previewTarget", target),
  openRightPanelTarget: (target: RightPanelOpenTarget) =>
    ipcRenderer.invoke("rightPanel:openTarget", target),
  execCommand: (args: VoiceExecCommandArgs) => ipcRenderer.invoke("voiceTools:execCommand", args),
  writeStdin: (args: VoiceWriteStdinArgs) => ipcRenderer.invoke("voiceTools:writeStdin", args),
  terminateExecSession: (sessionId: number) => ipcRenderer.invoke("voiceTools:terminateExecSession", { sessionId }),
  applyPatch: (input: string) => ipcRenderer.invoke("voiceTools:applyPatch", { input }),
  webSearch: (args) => ipcRenderer.invoke("voiceTools:webSearch", args),
  cancelWebSearch: (requestId: string) => ipcRenderer.invoke("voiceTools:cancelWebSearch", { requestId }),
  saveOpenAiApiKey: (apiKey: string) => ipcRenderer.invoke("settings:saveOpenAiApiKey", { apiKey }),
  clearOpenAiApiKey: () => ipcRenderer.invoke("settings:clearOpenAiApiKey"),
  revealOpenAiApiKey: () => ipcRenderer.invoke("settings:revealOpenAiApiKey"),
  copyOpenAiApiKey: () => ipcRenderer.invoke("settings:copyOpenAiApiKey"),
  saveExaApiKey: (apiKey: string) => ipcRenderer.invoke("settings:saveExaApiKey", { apiKey }),
  clearExaApiKey: () => ipcRenderer.invoke("settings:clearExaApiKey"),
  revealExaApiKey: () => ipcRenderer.invoke("settings:revealExaApiKey"),
  copyExaApiKey: () => ipcRenderer.invoke("settings:copyExaApiKey"),
  createRealtimeClientSecret: () => ipcRenderer.invoke("realtime:createClientSecret"),
  setRealtimeSettings: (settings) => ipcRenderer.invoke("realtime:setSettings", { settings }),
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
