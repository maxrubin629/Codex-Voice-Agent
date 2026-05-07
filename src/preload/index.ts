import { contextBridge, ipcRenderer } from "electron";
import type {
  AppEvent,
  AppState,
  ApprovalDecision,
  CodexPermissionMode,
  CodexSettingsScope,
  CodexVoiceApi,
  ReasoningEffort,
  ToolQuestionAnswer,
  VoiceExecCommandArgs,
  VoiceWriteStdinArgs,
} from "../shared/types";

const api: CodexVoiceApi = {
  getState: () => ipcRenderer.invoke("app:getState"),
  openVoiceWindow: () => ipcRenderer.invoke("app:openVoiceWindow"),
  openDebugWindow: () => ipcRenderer.invoke("app:openDebugWindow"),
  getEvents: () => ipcRenderer.invoke("app:getEvents"),
  clearEvents: () => ipcRenderer.invoke("app:clearEvents"),
  logEvent: (event: AppEvent) => ipcRenderer.invoke("app:logEvent", event),
  selectWorkspaceFolder: () => ipcRenderer.invoke("projects:selectWorkspaceFolder"),
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
  interruptCodex: (chatId?: string) => ipcRenderer.invoke("codex:interrupt", { chatId }),
  getChatStatus: (chatId?: string) => ipcRenderer.invoke("projects:chatStatus", { chatId }),
  setCodexSettings: (
    settings: { model?: string | null; reasoningEffort?: ReasoningEffort | null; permissionMode?: CodexPermissionMode | null },
    scope: CodexSettingsScope,
  ) => ipcRenderer.invoke("codex:setSettings", { settings, scope }),
  answerApproval: (requestId: string | number, decision: ApprovalDecision) =>
    ipcRenderer.invoke("codex:answerApproval", { requestId, decision }),
  answerToolQuestion: (requestId: string | number, answers: ToolQuestionAnswer[]) =>
    ipcRenderer.invoke("codex:answerToolQuestion", { requestId, answers }),
  execCommand: (args: VoiceExecCommandArgs) => ipcRenderer.invoke("voiceTools:execCommand", args),
  writeStdin: (args: VoiceWriteStdinArgs) => ipcRenderer.invoke("voiceTools:writeStdin", args),
  terminateExecSession: (sessionId: number) => ipcRenderer.invoke("voiceTools:terminateExecSession", { sessionId }),
  applyPatch: (input: string) => ipcRenderer.invoke("voiceTools:applyPatch", { input }),
  getOpenAiApiKey: () => ipcRenderer.invoke("settings:getOpenAiApiKey"),
  saveOpenAiApiKey: (apiKey: string) => ipcRenderer.invoke("settings:saveOpenAiApiKey", { apiKey }),
  clearOpenAiApiKey: () => ipcRenderer.invoke("settings:clearOpenAiApiKey"),
  createRealtimeClientSecret: () => ipcRenderer.invoke("realtime:createClientSecret"),
  setRealtimeSettings: (settings) => ipcRenderer.invoke("realtime:setSettings", { settings }),
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
