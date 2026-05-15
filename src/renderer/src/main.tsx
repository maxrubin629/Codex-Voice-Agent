import React, { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  CODEX_PERMISSION_PROFILES,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CODEX_PERMISSION_MODE,
  DEFAULT_CODEX_REASONING_EFFORT,
  DEFAULT_CODEX_SERVICE_TIER,
  DEFAULT_REALTIME_MODEL,
  DEFAULT_REALTIME_REASONING_EFFORT,
  FAST_CODEX_SERVICE_TIER,
  REALTIME_MODEL_OPTIONS,
  REALTIME_REASONING_EFFORT_OPTIONS,
  REALTIME_VOICE_OPTIONS,
  type ActiveThreadSummary,
  type AppEvent,
  type AppState,
  type CodexModelSummary,
  type CodexPermissionMode,
  type CodexServiceTier,
  type CodexTodoItem,
  type CodexThreadTokenUsage,
  type CodexTurnOutput,
  type McpOkGrant,
  type PendingCodexRequest,
  type PendingRequestQuestion,
  type ReasoningEffort,
  type RealtimeModelId,
  type RealtimeReasoningEffort,
  type RealtimeVoiceId,
  type ReplaySessionLoadResult,
  type ReplaySessionMetadata,
  type ToolQuestionAnswer,
  type VoiceChat,
  type VoiceProject,
  type WindowChromeState,
} from "../../shared/types";
import { appendBufferedEvent } from "../../shared/eventBuffer";
import { classifyReplayEvent, replayFrameAt, sortReplayEvents } from "../../shared/replay";
import { RealtimeVoiceClient, type RealtimeChatContext } from "./realtimeClient";
import { RightPanel } from "./rightPanel";
import "./styles.css";

const emptyState: AppState = {
  baseFolder: "",
  projects: [],
  archivedProjects: [],
  activeProject: null,
  runtime: {
    ready: false,
    activeProjectId: null,
    activeChatId: null,
    activeTurnId: null,
    status: "Loading.",
    threadStatus: null,
    tokenUsage: null,
    pendingRequests: [],
    chats: [],
    showProjectChats: false,
  },
  codexSettings: {
    chatModel: null,
    chatReasoningEffort: null,
    chatServiceTier: DEFAULT_CODEX_SERVICE_TIER,
    chatPermissionMode: DEFAULT_CODEX_PERMISSION_MODE,
    nextTurnModel: null,
    nextTurnReasoningEffort: null,
    nextTurnServiceTier: null,
    nextTurnPermissionMode: null,
    activeTurnModel: null,
    activeTurnReasoningEffort: null,
    activeTurnServiceTier: null,
    activeTurnPermissionMode: null,
    defaultModel: DEFAULT_CODEX_MODEL,
    defaultReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
    defaultServiceTier: DEFAULT_CODEX_SERVICE_TIER,
    defaultPermissionMode: DEFAULT_CODEX_PERMISSION_MODE,
    models: [],
  },
  mcpOkGrants: [],
  realtime: {
    available: false,
    model: DEFAULT_REALTIME_MODEL,
    voice: "marin",
    reasoningEffort: "low",
    reason: null,
    apiKeySource: null,
    apiKeyEncrypted: false,
  },
  phone: {
    settings: {
      enabled: false,
      webhookPath: "",
      localPort: 0,
      publicUrl: null,
      allowUnsignedDevWebhooks: false,
      webhookSecretConfigured: false,
      allowedCallerNumbers: [],
    },
    listener: {
      running: false,
      url: null,
      error: null,
    },
    activeCall: null,
    logs: [],
  },
  replay: {
    active: null,
  },
};

type AppWindowKind = "voice" | "debug";
type ApiKeyDialogMode = "connect" | "settings";
type VoiceTone = "off" | "listening" | "working" | "connecting" | "paused" | "waiting";
type VoiceSettingsTab = "general" | "appearance" | "configuration" | "archive";

type VoiceOrbCustomization = {
  accentColor: string;
  glow: number;
  reactivity: number;
  waveHeight: number;
};

const voiceOrbCustomizationStorageKey = "codexVoice.orbCustomization";
const dualPaneLayoutMediaQuery = "(min-width: 780px)";
const rightPaneResizeCloseDurationMs = 240;
const compactWindowWidth = 444;
const rendererZoomFactor = 0.85;
const defaultVoiceOrbCustomization: VoiceOrbCustomization = {
  accentColor: "#1d9bf0",
  glow: 0,
  reactivity: 12,
  waveHeight: 100,
};
const voiceOrbColorOptions: Array<{ color: string; label: string }> = [
  { color: "#1d9bf0", label: "Azure" },
  { color: "#35d6ff", label: "Cyan" },
  { color: "#6f8cff", label: "Indigo" },
  { color: "#8ff5df", label: "Mint" },
  { color: "#f4f0dd", label: "Pearl" },
];

type ContextMenuTarget =
  | {
      kind: "project";
      projectId: string;
      label: string;
      x: number;
      y: number;
    }
  | {
      kind: "chat";
      projectId: string;
      chatId: string;
      label: string;
      x: number;
      y: number;
    };

type ArchivedChat = {
  projectId: string;
  projectName: string;
  chat: VoiceChat;
};

type VoiceEventContext = {
  projectId: string;
  chatId: string;
  threadId?: string | null;
};

function appWindowKind(): AppWindowKind {
  const kind = new URLSearchParams(window.location.search).get("window");
  return kind === "debug" ? "debug" : "voice";
}

function activeVoiceEventContext(state: AppState): VoiceEventContext | null {
  const project = state.activeProject;
  if (!project) return null;
  const chat = activeVoiceChatForState(state);
  if (!chat) return null;
  return {
    projectId: project.id,
    chatId: chat.id,
    threadId: chat.codexThreadId,
  };
}

function activeRealtimeChatContext(state: AppState): RealtimeChatContext | null {
  const project = state.activeProject;
  if (!project) return null;
  const chat = activeVoiceChatForState(state);
  if (!chat) return null;
  return {
    projectId: project.id,
    projectName: project.displayName,
    chatId: chat.id,
    chatName: chat.displayName,
    threadId: chat.codexThreadId,
  };
}

function eventWithVoiceContext(event: AppEvent, context: VoiceEventContext | null): AppEvent {
  if (event.source !== "realtime") return event;
  const resolvedContext = voiceEventContextFromEvent(event) ?? context;
  if (!resolvedContext) return event;
  const raw = event.raw && typeof event.raw === "object" && !Array.isArray(event.raw) ? event.raw : {};
  return {
    ...event,
    raw: {
      ...raw,
      projectId: resolvedContext.projectId,
      chatId: resolvedContext.chatId,
      threadId: resolvedContext.threadId,
    },
  };
}

function voiceEventContextFromEvent(event: AppEvent): VoiceEventContext | null {
  if (event.source !== "realtime") return null;
  const raw = recordFromUnknown(event.raw);
  const projectId = stringFromUnknown(raw?.projectId);
  const chatId = stringFromUnknown(raw?.chatId);
  if (projectId && chatId) {
    return {
      projectId,
      chatId,
      threadId: stringFromUnknown(raw?.threadId),
    };
  }

  const output = recordFromUnknown(raw?.output);
  const project = recordFromUnknown(output?.project);
  const chat = recordFromUnknown(output?.chat);
  const outputProjectId = stringFromUnknown(output?.projectId) ?? stringFromUnknown(project?.id);
  const outputChatId = stringFromUnknown(output?.chatId) ?? stringFromUnknown(chat?.id);
  if (!outputProjectId || !outputChatId) return null;
  return {
    projectId: outputProjectId,
    chatId: outputChatId,
    threadId:
      stringFromUnknown(output?.threadId) ??
      stringFromUnknown(chat?.codexThreadId) ??
      stringFromUnknown(chat?.threadId),
  };
}

function isRealtimeTranscriptEvent(event: AppEvent): boolean {
  if (event.source !== "realtime") return false;
  const raw = recordFromUnknown(event.raw);
  const rawType = stringFromUnknown(raw?.type);
  return [
    "userTranscriptDelta",
    "userTranscript",
    "voiceDelta",
    "assistantTranscriptDelta",
    "assistantTranscript",
  ].includes(event.kind) || [
    "conversation.item.input_audio_transcription.delta",
    "conversation.item.input_audio_transcription.completed",
    "response.output_audio_transcript.delta",
    "response.output_audio_transcript.done",
  ].includes(rawType ?? "");
}

function activeVoiceChatForState(state: AppState): VoiceChat | null {
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

function shouldAutoOpenTranscriptForEvent(event: AppEvent): boolean {
  if (event.source !== "realtime") return false;
  const raw = recordFromUnknown(event.raw);
  const rawType = stringFromUnknown(raw?.type);
  return [
    "userSpeechStarted",
    "userTranscriptDelta",
    "userTranscript",
    "input_audio_buffer.speech_started",
    "conversation.item.input_audio_transcription.delta",
    "conversation.item.input_audio_transcription.completed",
  ].includes(event.kind) || [
    "input_audio_buffer.speech_started",
    "conversation.item.input_audio_transcription.delta",
    "conversation.item.input_audio_transcription.completed",
  ].includes(rawType ?? "");
}

function eventMatchesActiveTranscriptContext(event: AppEvent, state: AppState): boolean {
  const raw = recordFromUnknown(event.raw);
  const chatId = stringFromUnknown(raw?.chatId);
  const threadId = stringFromUnknown(raw?.threadId);
  const activeChat = activeVoiceChatForState(state);
  const activeChatId = state.runtime.activeChatId ?? activeChat?.id ?? null;
  const activeThreadId = activeChat?.codexThreadId ?? state.activeProject?.codexThreadId ?? null;
  if (chatId && activeChatId) return chatId === activeChatId;
  if (threadId && activeThreadId) return threadId === activeThreadId;
  return true;
}

function eventIdentity(event: AppEvent): string {
  const raw = recordFromUnknown(event.raw);
  const itemId = stringFromUnknown(raw?.item_id) ?? stringFromUnknown(raw?.itemId);
  const responseId = stringFromUnknown(raw?.response_id) ?? stringFromUnknown(raw?.responseId);
  const outputIndex = typeof raw?.output_index === "number" ? raw.output_index : "";
  const contentIndex = typeof raw?.content_index === "number" ? raw.content_index : "";
  return [event.at, event.source, event.kind, itemId, responseId, outputIndex, contentIndex, event.message.length]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .join(":");
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isHexColor(value: unknown): value is string {
  return typeof value === "string" && /^#[0-9a-f]{6}$/i.test(value);
}

function clampControlValue(value: unknown, fallback: number): number {
  return Math.min(100, Math.max(0, typeof value === "number" && Number.isFinite(value) ? value : fallback));
}

function normalizeVoiceOrbCustomization(value: Partial<VoiceOrbCustomization> | null): VoiceOrbCustomization {
  return {
    accentColor: isHexColor(value?.accentColor) ? value.accentColor : defaultVoiceOrbCustomization.accentColor,
    glow: defaultVoiceOrbCustomization.glow,
    reactivity: defaultVoiceOrbCustomization.reactivity,
    waveHeight: defaultVoiceOrbCustomization.waveHeight,
  };
}

function loadVoiceOrbCustomization(): VoiceOrbCustomization {
  try {
    const stored = window.localStorage.getItem(voiceOrbCustomizationStorageKey);
    if (!stored) return defaultVoiceOrbCustomization;
    return normalizeVoiceOrbCustomization(JSON.parse(stored) as Partial<VoiceOrbCustomization>);
  } catch {
    return defaultVoiceOrbCustomization;
  }
}

function saveVoiceOrbCustomization(customization: VoiceOrbCustomization): void {
  try {
    window.localStorage.setItem(voiceOrbCustomizationStorageKey, JSON.stringify(customization));
  } catch {
    // Visual preferences should never block the voice UI.
  }
}

function supportsDualPaneLayout(): boolean {
  return window.matchMedia(dualPaneLayoutMediaQuery).matches;
}

function viewportWidth(): number {
  return Math.max(0, window.innerWidth);
}

function compactViewportWidth(): number {
  return compactWindowWidth / rendererZoomFactor;
}

function App(): React.ReactElement {
  const [windowKind] = useState<AppWindowKind>(() => appWindowKind());
  const [state, setState] = useState<AppState>(emptyState);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [projectName, setProjectName] = useState("");
  const [message, setMessage] = useState("");
  const [steer, setSteer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [voiceStatus, setVoiceStatus] = useState("Realtime disconnected.");
  const [voiceConnected, setVoiceConnected] = useState(false);
  const [voiceConnecting, setVoiceConnecting] = useState(false);
  const [voicePaused, setVoicePaused] = useState(false);
  const [voiceOutputLevel, setVoiceOutputLevel] = useState(0);
  const [realtimeIssue, setRealtimeIssue] = useState<string | null>(null);
  const [windowChromeState, setWindowChromeState] = useState<WindowChromeState>({ isFullScreen: false });
  const voiceRef = useRef<RealtimeVoiceClient | null>(null);
  const stateRef = useRef<AppState>(emptyState);
  const pendingRealtimeTranscriptEventsRef = useRef<AppEvent[]>([]);
  const outputLevelUpdateRef = useRef(0);
  const outputLevelValueRef = useRef(0);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    if (!error) return undefined;
    const timeoutId = window.setTimeout(() => setError(null), 15000);
    return () => window.clearTimeout(timeoutId);
  }, [error]);

  useEffect(() => {
    document.title = windowKind === "debug" ? "Codex Voice Debug" : "Codex Voice";
    void refreshState();
    void refreshEvents();
    void window.codexVoice.getWindowChromeState().then(setWindowChromeState).catch(() => {
      setWindowChromeState({ isFullScreen: false });
    });
    const offWindowChromeState = window.codexVoice.onWindowChromeState(setWindowChromeState);
    const offState = window.codexVoice.onAppState((nextState) => {
      stateRef.current = nextState;
      flushPendingRealtimeTranscriptEvents(activeVoiceEventContext(nextState));
      voiceRef.current?.setActiveChatContext(activeRealtimeChatContext(nextState));
      setState(nextState);
    });
    const offEvent = window.codexVoice.onAppEvent((event) => {
      setEvents((current) => appendBufferedEvent(current, event));
      if (event.source === "codex" && event.kind === "serverRequest") {
        voiceRef.current?.speakPendingRequest(event.raw as PendingCodexRequest);
      } else if (event.source === "codex" && event.kind === "turn/finalOutput") {
        voiceRef.current?.injectCodexTurnOutput(event.raw as CodexTurnOutput);
      } else if (event.source === "app" && event.kind === "queuedTurnStarted") {
        voiceRef.current?.speakQueuedCodexTransition(event.raw);
      } else if (event.source === "app" && event.kind === "queuedTurnFailed") {
        voiceRef.current?.speakStatus(event.message);
      } else if (event.source === "codex" && event.kind === "error") {
        voiceRef.current?.speakStatus(event.message);
      }
    });
    return () => {
      offWindowChromeState();
      offState();
      offEvent();
      voiceRef.current?.disconnect();
    };
  }, []);

  async function refreshState(): Promise<void> {
    setState(await window.codexVoice.getState());
  }

  async function refreshEvents(): Promise<void> {
    setEvents(await window.codexVoice.getEvents());
  }

  async function clearEvents(): Promise<void> {
    await window.codexVoice.clearEvents();
    setEvents([]);
  }

  async function logEvent(event: AppEvent): Promise<void> {
    await window.codexVoice.logEvent(event);
  }

  async function runAction(action: () => Promise<unknown>): Promise<void> {
    setError(null);
    try {
      await action();
      await refreshState();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  }

  function updateVoiceOutputLevel(level: number): void {
    const normalized = level < 0.006 ? 0 : Math.min(1, Math.max(0, level));
    const now = performance.now();
    if (normalized === 0 && outputLevelValueRef.current === 0) return;
    if (normalized === 0 || now - outputLevelUpdateRef.current > 32) {
      outputLevelUpdateRef.current = now;
      outputLevelValueRef.current = normalized;
      setVoiceOutputLevel(normalized);
    }
  }

  function clearVoiceOutputLevel(): void {
    outputLevelUpdateRef.current = 0;
    outputLevelValueRef.current = 0;
    setVoiceOutputLevel(0);
  }

  function flushPendingRealtimeTranscriptEvents(context = activeVoiceEventContext(stateRef.current)): void {
    if (!context || pendingRealtimeTranscriptEventsRef.current.length === 0) return;
    const pendingEvents = [...pendingRealtimeTranscriptEventsRef.current].reverse();
    pendingRealtimeTranscriptEventsRef.current = [];
    for (const event of pendingEvents) {
      void window.codexVoice.logEvent(eventWithVoiceContext(event, context));
    }
  }

  function logRealtimeEvent(event: AppEvent): void {
    const context = voiceEventContextFromEvent(event) ?? activeVoiceEventContext(stateRef.current);
    if (!context && isRealtimeTranscriptEvent(event)) {
      pendingRealtimeTranscriptEventsRef.current = appendBufferedEvent(
        pendingRealtimeTranscriptEventsRef.current,
        event,
        128,
      );
      return;
    }
    flushPendingRealtimeTranscriptEvents(context);
    void window.codexVoice.logEvent(eventWithVoiceContext(event, context));
  }

  function disconnectVoice(): void {
    flushPendingRealtimeTranscriptEvents();
    pendingRealtimeTranscriptEventsRef.current = [];
    voiceRef.current?.disconnect();
    voiceRef.current = null;
    setVoiceConnected(false);
    setVoiceConnecting(false);
    setVoicePaused(false);
    clearVoiceOutputLevel();
    setVoiceStatus("Realtime disconnected.");
  }

  async function connectVoice(): Promise<void> {
    if (voiceConnecting) return;
    await runAction(async () => {
      setVoiceConnecting(true);
      const client = new RealtimeVoiceClient({
        onConnectionChange: (connected, label) => {
          setVoiceConnected(connected);
          if (connected) setRealtimeIssue(null);
          setVoiceConnecting(!connected && label !== "Realtime data channel closed.");
          if (connected || label === "Realtime data channel closed." || label === "Realtime disconnected.") {
            setVoicePaused(false);
          }
          setVoiceStatus(label);
        },
        onLog: (event) => {
          logRealtimeEvent(event);
        },
        onOutputLevel: updateVoiceOutputLevel,
        getTranscriptMessages: (chatId) => window.codexVoice.getTranscriptMessages(chatId),
      });
      client.setActiveChatContext(activeRealtimeChatContext(stateRef.current));
      voiceRef.current = client;
      try {
        await client.connect();
      } catch (caught) {
        if (voiceRef.current === client) voiceRef.current = null;
        setVoicePaused(false);
        clearVoiceOutputLevel();
        setRealtimeIssue(caught instanceof Error ? caught.message : String(caught));
        throw caught;
      } finally {
        setVoiceConnecting(false);
      }
    });
  }

  async function toggleVoice(): Promise<void> {
    if (voiceRef.current?.connected || voiceConnected) {
      disconnectVoice();
      return;
    }
    await connectVoice();
  }

  async function restartVoice(): Promise<void> {
    if (!voiceRef.current?.connected && !voiceConnected) return;
    disconnectVoice();
    await connectVoice();
  }

  async function handleOrbAction(): Promise<void> {
    const client = voiceRef.current;
    if (client?.connected) {
      const nextPaused = !client.paused;
      client.setPaused(nextPaused);
      setVoicePaused(nextPaused);
      setVoiceStatus(nextPaused ? "Realtime voice paused." : "Realtime voice resumed.");
      return;
    }
    if (voiceConnected) {
      setVoiceConnected(false);
      setVoicePaused(false);
      clearVoiceOutputLevel();
      return;
    }
    await toggleVoice();
  }

  async function openDebugWindow(): Promise<void> {
    await runAction(() => window.codexVoice.openDebugWindow());
  }

  if (windowKind === "debug") {
    return (
      <DebugDashboard
        state={state}
        events={events}
        error={error}
        projectName={projectName}
        message={message}
        steer={steer}
        setProjectName={setProjectName}
        setMessage={setMessage}
        setSteer={setSteer}
        onDismissError={() => setError(null)}
        onAction={runAction}
        onClearEvents={clearEvents}
        onRefresh={refreshState}
        onLogEvent={logEvent}
      />
    );
  }

  return (
    <VoiceHome
      state={state}
      events={events}
      windowChromeState={windowChromeState}
      voiceOutputLevel={voiceOutputLevel}
      realtimeIssue={realtimeIssue}
      error={error}
      voiceConnected={voiceConnected}
      voiceConnecting={voiceConnecting}
      voicePaused={voicePaused}
      onAction={runAction}
      onDismissError={() => setError(null)}
      onOrbAction={handleOrbAction}
      onRefresh={refreshState}
      onShowDebug={openDebugWindow}
      onToggleVoice={toggleVoice}
      onRestartVoice={restartVoice}
      onClearRealtimeIssue={() => setRealtimeIssue(null)}
    />
  );
}

function VoiceHome({
  state,
  events,
  windowChromeState,
  voiceOutputLevel,
  realtimeIssue,
  error,
  voiceConnected,
  voiceConnecting,
  voicePaused,
  onAction,
  onDismissError,
  onOrbAction,
  onRefresh,
  onShowDebug,
  onToggleVoice,
  onRestartVoice,
  onClearRealtimeIssue,
}: {
  state: AppState;
  events: AppEvent[];
  windowChromeState: WindowChromeState;
  voiceOutputLevel: number;
  realtimeIssue: string | null;
  error: string | null;
  voiceConnected: boolean;
  voiceConnecting: boolean;
  voicePaused: boolean;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
  onDismissError: () => void;
  onOrbAction: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onShowDebug: () => Promise<void>;
  onToggleVoice: () => Promise<void>;
  onRestartVoice: () => Promise<void>;
  onClearRealtimeIssue: () => void;
}): React.ReactElement {
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [futureOpen, setFutureOpenState] = useState(false);
  const [futureVisible, setFutureVisible] = useState(false);
  const [futureResizeClosing, setFutureResizeClosing] = useState(false);
  const [rightPaneRevealWidth, setRightPaneRevealWidth] = useState(0);
  const [transcriptActivationRequest, setTranscriptActivationRequest] = useState(0);
  const [canShowBothPanes, setCanShowBothPanes] = useState(() => supportsDualPaneLayout());
  const [newOpen, setNewOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [switchChatOpen, setSwitchChatOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [orbCustomization, setOrbCustomization] = useState<VoiceOrbCustomization>(() => loadVoiceOrbCustomization());
  const [apiKeyDialogMode, setApiKeyDialogMode] = useState<ApiKeyDialogMode | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuTarget | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [newName, setNewName] = useState("");
  const [newChatName, setNewChatName] = useState("");
  const [query, setQuery] = useState("");
  const [selectedSubagentId, setSelectedSubagentId] = useState<string | null>(null);
  const [inspectedThread, setInspectedThread] = useState<{ threadId: string; label: string } | null>(null);
  const paneTogglePointerActivationRef = useRef(false);
  const futureOpenRef = useRef(false);
  const futureVisibleRef = useRef(false);
  const futureResizeClosingRef = useRef(false);
  const futureResizeCloseTimerRef = useRef<number | null>(null);
  const rightPaneRevealWidthRef = useRef(0);
  const rightPaneSyncFrameRef = useRef<number | null>(null);
  const rightPaneLastViewportWidthRef = useRef(viewportWidth());
  const rightPaneStableFrameCountRef = useRef(0);
  const canShowBothPanesRef = useRef(canShowBothPanes);
  const lastAutoTranscriptEventRef = useRef<string | null>(null);
  const transcriptAutoActivatedRef = useRef(false);
  const projects = state.projects;
  const archivedProjects = state.archivedProjects;
  const activeProject = state.activeProject;
  const activeProjectId = state.runtime.activeProjectId;
  const showProjectChats = state.runtime.showProjectChats;
  const featuredProject = activeProject ?? projects[0] ?? null;
  const projectChats = useMemo(
    () => chatSummariesForProject(activeProject, state),
    [activeProject, state],
  );
  const archivedChats = useMemo(() => archivedChatsForProjects(projects), [projects]);
  const archivedCount = archivedProjects.length + archivedChats.length;
  const recentProjects = projects.slice(0, 3);
  const modelScope = activeProject ? "chat" : "nextTurn";
  const effectiveModel =
    state.codexSettings.nextTurnModel ??
    state.codexSettings.chatModel ??
    state.codexSettings.defaultModel ??
    DEFAULT_CODEX_MODEL;
  const effectiveEffort =
    state.codexSettings.nextTurnReasoningEffort ??
    state.codexSettings.chatReasoningEffort ??
    state.codexSettings.defaultReasoningEffort ??
    DEFAULT_CODEX_REASONING_EFFORT;
  const effectiveServiceTier =
    state.codexSettings.nextTurnServiceTier ??
    state.codexSettings.chatServiceTier ??
    state.codexSettings.defaultServiceTier ??
    DEFAULT_CODEX_SERVICE_TIER;
  const effectivePermissionMode =
    state.codexSettings.nextTurnPermissionMode ??
    state.codexSettings.chatPermissionMode ??
    state.codexSettings.defaultPermissionMode ??
    DEFAULT_CODEX_PERMISSION_MODE;
  const effectivePermission = permissionProfile(effectivePermissionMode);
  const modelOptions = modelsForValue(state.codexSettings.models, effectiveModel);
  const selectedCodexModel = modelOptions.find((model) => model.model === effectiveModel) ?? null;
  const modelSupportsFast = supportsFastMode(selectedCodexModel);
  const fastModeOn = isFastServiceTier(effectiveServiceTier);
  const pendingRequests = state.runtime.pendingRequests;
  const primaryPendingRequest = pendingRequests[0] ?? null;
  const filteredProjects = projects.filter((project) => {
    const haystack = [
      project.displayName,
      project.folderPath,
      project.workspacePath,
      project.lastStatus ?? "",
      project.lastSummary ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(query.trim().toLowerCase());
  });
  const voiceState = voiceStateLabel(state, voiceConnected, voiceConnecting, voicePaused);
  const voiceOrbLabel = voiceOrbAriaLabel(state, voiceConnected, voiceConnecting, voicePaused);
  const selectedSubagent = selectedSubagentForSummaries(projectChats, selectedSubagentId);

  useEffect(() => {
    saveVoiceOrbCustomization(orbCustomization);
  }, [orbCustomization]);

  useEffect(() => {
    const handleResize = () => {
      if (futureResizeClosingRef.current) return;
      if (!futureVisibleRef.current && !futureOpenRef.current) {
        setRightPaneReveal(0);
        return;
      }

      const revealWidth = syncRightPaneRevealWidth();
      finishRightPaneCloseIfCollapsed(revealWidth);
    };

    window.addEventListener("resize", handleResize);
    return () => {
      window.removeEventListener("resize", handleResize);
      clearFutureResizeCloseTimer();
      stopRightPaneSyncLoop();
    };
  }, []);

  useEffect(() => {
    const mediaQuery = window.matchMedia(dualPaneLayoutMediaQuery);
    const updateCanShowBothPanes = () => {
      const nextCanShowBothPanes = mediaQuery.matches;
      const wasShowingBothPanes = canShowBothPanesRef.current;
      canShowBothPanesRef.current = nextCanShowBothPanes;
      setCanShowBothPanes(nextCanShowBothPanes);
      if (wasShowingBothPanes && !nextCanShowBothPanes && futureOpenRef.current) {
        closeFuturePaneFromResize();
      }
    };

    updateCanShowBothPanes();
    mediaQuery.addEventListener("change", updateCanShowBothPanes);
    return () => mediaQuery.removeEventListener("change", updateCanShowBothPanes);
  }, []);

  useEffect(() => {
    const latestEvent = events[0];
    if (!latestEvent || !canShowBothPanes) return;
    if (!shouldAutoOpenTranscriptForEvent(latestEvent)) return;
    if (!eventMatchesActiveTranscriptContext(latestEvent, state)) return;
    if (futureOpen && transcriptAutoActivatedRef.current) return;

    const identity = eventIdentity(latestEvent);
    if (lastAutoTranscriptEventRef.current === identity) return;
    lastAutoTranscriptEventRef.current = identity;

    openFuturePane();
    setTranscriptActivationRequest((current) => current + 1);
    transcriptAutoActivatedRef.current = true;
  }, [canShowBothPanes, events, futureOpen, state]);

  useEffect(() => {
    if (!voiceConnected) {
      transcriptAutoActivatedRef.current = false;
      lastAutoTranscriptEventRef.current = null;
    }
  }, [voiceConnected]);

  useEffect(() => {
    setChatsOpen(false);
    setSelectedSubagentId(null);
    setInspectedThread(null);
  }, [activeProject?.id]);

  useEffect(() => {
    setChatsOpen(showProjectChats);
  }, [showProjectChats]);

  useEffect(() => {
    if (!apiKeyDialogMode && !settingsOpen) return;
    setApiKey("");
  }, [apiKeyDialogMode, settingsOpen]);

  useEffect(() => {
    if (!contextMenu) return undefined;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("blur", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("blur", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  async function createNewProject(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onAction(async () => {
      await window.codexVoice.createProject(newName || undefined);
      setNewName("");
      setNewOpen(false);
      await onRefresh();
    });
  }

  async function selectWorkspaceFolder(): Promise<void> {
    await onAction(async () => {
      const folder = await window.codexVoice.selectWorkspaceFolder();
      if (!folder) return;
      await window.codexVoice.setWorkspaceFolder(folder.path, folder.name);
      await onRefresh();
    });
  }

  async function resumeProject(projectId: string): Promise<void> {
    await onAction(() => window.codexVoice.resumeProject(projectId));
    setBrowseOpen(false);
  }

  async function createNewChat(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const name = newChatName.trim();
    if (!name) return;
    await onAction(async () => {
      await window.codexVoice.createChat(name);
      setNewChatName("");
      setNewChatOpen(false);
      setChatsOpen(true);
    });
  }

  async function switchChat(chatId: string): Promise<void> {
    await onAction(async () => {
      await window.codexVoice.switchChat(chatId);
      setSelectedSubagentId(null);
      setInspectedThread(null);
      setSwitchChatOpen(false);
      setChatsOpen(true);
    });
  }

  function inspectSubagent(subagent: ChatSubagentSummary): void {
    setSelectedSubagentId(subagent.id);
    setInspectedThread({ threadId: subagent.threadId, label: subagent.title });
    openFuturePane();
  }

  function openProjectContextMenu(
    event: React.MouseEvent<HTMLElement>,
    project: VoiceProject,
  ): void {
    event.preventDefault();
    setContextMenu({
      kind: "project",
      projectId: project.id,
      label: project.displayName,
      x: event.clientX,
      y: event.clientY,
    });
  }

  function openChatContextMenu(event: React.MouseEvent<HTMLElement>, chat: ChatSummary): void {
    if (!activeProject) return;
    event.preventDefault();
    setContextMenu({
      kind: "chat",
      projectId: activeProject.id,
      chatId: chat.id,
      label: chat.title,
      x: event.clientX,
      y: event.clientY,
    });
  }

  async function archiveContextTarget(): Promise<void> {
    const target = contextMenu;
    if (!target) return;
    setContextMenu(null);
    if (target.kind === "project") {
      await onAction(() => window.codexVoice.archiveProject(target.projectId));
      return;
    }
    await onAction(() => window.codexVoice.archiveChat(target.chatId, target.projectId));
  }

  async function restoreProject(projectId: string): Promise<void> {
    await onAction(() => window.codexVoice.restoreProject(projectId));
  }

  async function restoreChat(projectId: string, chatId: string): Promise<void> {
    await onAction(() => window.codexVoice.restoreChat(chatId, projectId));
  }

  async function saveApiKey(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    await onAction(async () => {
      await window.codexVoice.saveOpenAiApiKey(apiKey);
      setApiKey("");
      setApiKeyDialogMode(null);
      onClearRealtimeIssue();
      await onRefresh();
    });
  }

  async function clearApiKey(): Promise<void> {
    await onAction(async () => {
      await window.codexVoice.clearOpenAiApiKey();
      setApiKey("");
      onClearRealtimeIssue();
      await onRefresh();
    });
  }

  function closeApiKeyDialog(): void {
    setApiKey("");
    setApiKeyDialogMode(null);
  }

  function handleVoiceOrbClick(): void {
    if (!state.realtime.available) {
      setApiKeyDialogMode("connect");
      return;
    }
    void onOrbAction();
  }

  function toggleSettingsPane(): void {
    setPermissionsOpen(false);
    setModelOpen(false);
    setSettingsOpen((current) => !current);
  }

  function toggleFuturePane(): void {
    setPermissionsOpen(false);
    if (futureOpenRef.current) {
      closeFuturePane();
    } else {
      openFuturePane();
    }
  }

  function openFuturePane(): void {
    clearFutureResizeCloseTimer();
    setFutureResizeClosingState(false);
    futureOpenRef.current = true;
    futureVisibleRef.current = true;
    setFutureOpenState(true);
    setFutureVisible(true);
    syncRightPaneRevealWidth();
    startRightPaneSyncLoop();
    void window.codexVoice
      .expandVoiceWindowForRightPane()
      .then(() => {
        if (futureOpenRef.current) syncRightPaneRevealWidth();
      })
      .catch(() => {
        if (futureOpenRef.current) syncRightPaneRevealWidth();
      });
  }

  function closeFuturePane(): void {
    clearFutureResizeCloseTimer();
    setFutureResizeClosingState(false);
    futureOpenRef.current = false;
    setFutureOpenState(false);
    syncRightPaneRevealWidth();
    startRightPaneSyncLoop();
    void window.codexVoice
      .collapseVoiceWindowFromRightPane()
      .then(() => {
        window.requestAnimationFrame(() => {
          if (!futureOpenRef.current) finishRightPaneClose();
        });
      })
      .catch(() => {
        if (!futureOpenRef.current) finishRightPaneClose();
      });
  }

  function closeFuturePaneFromResize(): void {
    if (futureResizeClosingRef.current) return;

    const startWidth = syncRightPaneRevealWidth();
    if (startWidth <= 1) {
      closeFuturePane();
      return;
    }

    clearFutureResizeCloseTimer();
    stopRightPaneSyncLoop();
    futureOpenRef.current = false;
    futureVisibleRef.current = true;
    setFutureOpenState(false);
    setFutureVisible(true);
    setFutureResizeClosingState(true);
    setRightPaneReveal(startWidth);

    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (!futureResizeClosingRef.current || futureOpenRef.current) return;
        setRightPaneReveal(0);
      });
    });

    futureResizeCloseTimerRef.current = window.setTimeout(() => {
      futureResizeCloseTimerRef.current = null;
      if (futureOpenRef.current) return;
      void window.codexVoice
        .collapseVoiceWindowFromRightPane()
        .then(() => {
          if (!futureOpenRef.current) finishRightPaneClose();
        })
        .catch(() => {
          if (!futureOpenRef.current) finishRightPaneClose();
        });
    }, rightPaneResizeCloseDurationMs + 40);
  }

  function setFutureResizeClosingState(next: boolean): void {
    futureResizeClosingRef.current = next;
    setFutureResizeClosing(next);
  }

  function clearFutureResizeCloseTimer(): void {
    if (futureResizeCloseTimerRef.current === null) return;
    window.clearTimeout(futureResizeCloseTimerRef.current);
    futureResizeCloseTimerRef.current = null;
  }

  function setRightPaneReveal(width: number): void {
    const roundedWidth = Math.max(0, Math.round(width));
    rightPaneRevealWidthRef.current = roundedWidth;
    setRightPaneRevealWidth(roundedWidth);
  }

  function syncRightPaneRevealWidth(): number {
    const revealWidth = Math.max(0, viewportWidth() - compactViewportWidth());
    setRightPaneReveal(revealWidth);
    return revealWidth;
  }

  function finishRightPaneCloseIfCollapsed(revealWidth: number): void {
    if (futureOpenRef.current || revealWidth > 1) return;
    finishRightPaneClose();
  }

  function finishRightPaneClose(): void {
    futureVisibleRef.current = false;
    setFutureVisible(false);
    setFutureResizeClosingState(false);
    setRightPaneReveal(0);
    stopRightPaneSyncLoop();
  }

  function startRightPaneSyncLoop(): void {
    stopRightPaneSyncLoop();
    rightPaneLastViewportWidthRef.current = -1;
    rightPaneStableFrameCountRef.current = 0;

    const syncFrame = () => {
      if (futureResizeClosingRef.current) {
        rightPaneSyncFrameRef.current = null;
        return;
      }

      const currentViewportWidth = viewportWidth();
      const revealWidth = syncRightPaneRevealWidth();
      finishRightPaneCloseIfCollapsed(revealWidth);

      if (currentViewportWidth === rightPaneLastViewportWidthRef.current) {
        rightPaneStableFrameCountRef.current += 1;
      } else {
        rightPaneStableFrameCountRef.current = 0;
        rightPaneLastViewportWidthRef.current = currentViewportWidth;
      }

      if (!futureVisibleRef.current || rightPaneStableFrameCountRef.current >= 8) {
        if (!futureOpenRef.current) finishRightPaneClose();
        rightPaneSyncFrameRef.current = null;
        return;
      }

      rightPaneSyncFrameRef.current = window.requestAnimationFrame(syncFrame);
    };

    rightPaneSyncFrameRef.current = window.requestAnimationFrame(syncFrame);
  }

  function stopRightPaneSyncLoop(): void {
    if (rightPaneSyncFrameRef.current === null) return;
    window.cancelAnimationFrame(rightPaneSyncFrameRef.current);
    rightPaneSyncFrameRef.current = null;
  }

  function handlePaneTogglePointerDown(event: React.PointerEvent<HTMLButtonElement>): void {
    event.preventDefault();
    event.stopPropagation();
  }

  function handlePaneTogglePointerUp(event: React.PointerEvent<HTMLButtonElement>): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    paneTogglePointerActivationRef.current = true;
    toggleFuturePane();
    window.setTimeout(() => {
      paneTogglePointerActivationRef.current = false;
    }, 400);
  }

  function handlePaneToggleClick(event: React.MouseEvent<HTMLButtonElement>): void {
    event.stopPropagation();
    if (paneTogglePointerActivationRef.current) {
      paneTogglePointerActivationRef.current = false;
      return;
    }
    toggleFuturePane();
  }

  return (
    <main
      className={`voice-home ${futureVisible ? "future-open" : ""} ${
        futureResizeClosing ? "future-resize-closing" : ""
      } ${
        windowChromeState.isFullScreen ? "window-fullscreen" : ""
      }`}
      style={{
        ...voiceAccentStyle(orbCustomization),
        "--voice-home-compact-width": `${compactViewportWidth()}px`,
        "--right-pane-window-delta": `${rightPaneRevealWidth}px`,
      } as React.CSSProperties}
    >
      <div className="voice-window-drag-region" aria-hidden="true" />
      <button
        className="voice-pane-toggle right"
        type="button"
        aria-label={futureOpen ? "Close right pane" : "Open right pane"}
        aria-expanded={futureOpen}
        onPointerDown={handlePaneTogglePointerDown}
        onPointerUp={handlePaneTogglePointerUp}
        onClick={handlePaneToggleClick}
      >
        <RightPaneIcon />
      </button>
      <div className="voice-shell">
        <div className="voice-home-content">
        <header className="voice-home-header">
          <h1>Codex Voice</h1>
          {selectedSubagent && (
            <p className="voice-header-breadcrumb">
              {activeProject?.displayName ?? "Project"} / {selectedSubagent.parentTitle} / {selectedSubagent.title}
            </p>
          )}
        </header>

        <div className="voice-home-scroll">
          <section className="voice-model-picker" aria-label="Model settings">
            <button
              className="voice-model-trigger"
              aria-expanded={modelOpen}
              onClick={() => setModelOpen((current) => !current)}
            >
              {fastModeOn && <LightningIcon />}
              <span className="voice-model-trigger-name">{formatModelName(effectiveModel)}</span>
              <span className="voice-model-trigger-separator" aria-hidden="true">·</span>
              <span className="voice-model-trigger-effort">{formatEffort(effectiveEffort)}</span>
              <DownIcon />
            </button>

            {modelOpen && (
              <div className="voice-model-panel">
                <label className="voice-model-field">
                  Model
                  <span className="voice-model-select-wrap">
                    <select
                      value={effectiveModel}
                      onChange={(event) => {
                        const model = event.target.value || null;
                        const nextModel = modelOptions.find((candidate) => candidate.model === model) ?? null;
                        const serviceTier =
                          model && !supportsFastMode(nextModel) ? DEFAULT_CODEX_SERVICE_TIER : effectiveServiceTier;
                        void onAction(() =>
                          window.codexVoice.setCodexSettings({ model, serviceTier }, modelScope),
                        );
                      }}
                    >
                      {modelOptions.length === 0 && (
                        <option value={effectiveModel}>{formatModelName(effectiveModel)}</option>
                      )}
                      {modelOptions.map((model) => (
                        <option key={model.id} value={model.model}>
                          {model.displayName || formatModelName(model.model)}
                        </option>
                      ))}
                    </select>
                    <DownIcon />
                  </span>
                </label>

                <div className="voice-effort-list">
                  <span>Reasoning effort</span>
                  {(["low", "medium", "high", "xhigh"] as ReasoningEffort[]).map((effort) => (
                    <button
                      key={effort}
                      className={effort === effectiveEffort ? "selected" : ""}
                      onClick={() =>
                        void onAction(() =>
                          window.codexVoice.setCodexSettings({ reasoningEffort: effort }, modelScope),
                        )
                      }
                    >
                      {formatEffort(effort)}
                      {effort === effectiveEffort && <CheckIcon />}
                    </button>
                  ))}
                </div>

                <div className="voice-speed-list">
                  <span>Speed</span>
                  <button
                    className={!fastModeOn ? "selected" : ""}
                    onClick={() =>
                      void onAction(() =>
                        window.codexVoice.setCodexSettings({ serviceTier: DEFAULT_CODEX_SERVICE_TIER }, modelScope),
                      )
                    }
                  >
                    <span>
                      Standard
                      <small>Default speed, normal usage</small>
                    </span>
                    {!fastModeOn && <CheckIcon />}
                  </button>
                  <button
                    className={fastModeOn ? "selected" : ""}
                    disabled={!modelSupportsFast}
                    onClick={() =>
                      void onAction(() =>
                        window.codexVoice.setCodexSettings({ serviceTier: FAST_CODEX_SERVICE_TIER }, modelScope),
                      )
                    }
                  >
                    <span>
                      Fast
                      <small>{modelSupportsFast ? "1.5x speed, increased usage" : "Not available for this model"}</small>
                    </span>
                    {fastModeOn && <CheckIcon />}
                  </button>
                </div>
              </div>
            )}
          </section>

          <section className="voice-hero" aria-label="Voice status">
            <button
              className={`voice-orb ${voiceState.tone}`}
              aria-label={voiceOrbLabel}
              onClick={handleVoiceOrbClick}
            >
              <VoiceOrbCanvas
                tone={voiceState.tone}
                outputLevel={voiceOutputLevel}
                customization={orbCustomization}
              />
              <span className="voice-orb-shine" />
            </button>
            <div className={`voice-state-line ${voiceState.tone}`}>
              <WaveformIcon />
              <span>{voiceState.label}</span>
            </div>
          </section>

          {error && <ErrorOverlay message={error} onDismiss={onDismissError} />}

          {primaryPendingRequest && (
            <VoicePendingRequestPanel
              request={primaryPendingRequest}
              requestCount={pendingRequests.length}
              onAction={onAction}
            />
          )}

          <section className="voice-project-region" aria-label="Projects">
            <FeaturedProjectCard
              activeProjectId={activeProjectId}
              project={featuredProject}
              chatsOpen={chatsOpen}
              onCreate={() => setNewOpen(true)}
              onResume={resumeProject}
              onOpenMenu={openProjectContextMenu}
              onToggleChats={() => {
                const next = !chatsOpen;
                setChatsOpen(next);
                void onAction(() => window.codexVoice.showProjectChats(next));
              }}
            />

            {chatsOpen && activeProject ? (
              <ProjectChatsPanel
                chats={projectChats}
                onNewChat={() => setNewChatOpen(true)}
                onSwitchChat={() => setSwitchChatOpen(true)}
                onSelectChat={switchChat}
                selectedSubagentId={selectedSubagentId}
                onSelectSubagent={setSelectedSubagentId}
                onInspectSubagent={inspectSubagent}
                onOpenChatMenu={openChatContextMenu}
                onAction={onAction}
              />
            ) : (
              <div className="voice-actions">
                <button className="voice-action-button" onClick={() => setNewOpen(true)}>
                  <PlusIcon />
                  <span>New project</span>
                </button>
                <button className="voice-action-button" onClick={() => setBrowseOpen(true)}>
                  <FolderIcon />
                  <span>Browse projects</span>
                </button>
              </div>
            )}

            {(!chatsOpen || !activeProject) && (
              <div className="recent-block">
                <h2>Recent Projects</h2>
                <div className="recent-list">
                  {recentProjects.map((project) => (
                    <button
                      key={project.id}
                      className="recent-row"
                      onClick={() => void resumeProject(project.id)}
                      onContextMenu={(event) => openProjectContextMenu(event, project)}
                    >
                      <span>
                        <strong>{project.displayName}</strong>
                        <small>{formatProjectTime(project.updatedAt)}</small>
                      </span>
                      <ChevronIcon />
                    </button>
                  ))}
                  {recentProjects.length === 0 && (
                    <div className="recent-empty">Recent projects will appear here.</div>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>

        <footer className="voice-footer">
          <button
            className="voice-footer-settings"
            aria-label="Open settings"
            aria-expanded={settingsOpen}
            title={state.runtime.ready ? "Codex app-server connected" : "Codex app-server starting"}
            onClick={toggleSettingsPane}
          >
            <ConfigIcon />
            <span className="voice-footer-settings-label">Settings</span>
          </button>
          <div className="voice-permission-wrap footer-permissions">
            <button
              className={`voice-permission-trigger ${effectivePermissionMode}`}
              aria-expanded={permissionsOpen}
              onClick={() => setPermissionsOpen((current) => !current)}
            >
              <PermissionIcon mode={effectivePermissionMode} />
              <span>{effectivePermission.displayName}</span>
              <DownIcon />
            </button>

            {permissionsOpen && (
              <div className="voice-permission-menu" role="menu">
                {CODEX_PERMISSION_PROFILES.map((profile) => (
                  <button
                    key={profile.mode}
                    className={[profile.mode, profile.mode === effectivePermissionMode ? "selected" : ""]
                      .filter(Boolean)
                      .join(" ")}
                    role="menuitemradio"
                    aria-checked={profile.mode === effectivePermissionMode}
                    onClick={() =>
                      void onAction(() =>
                        window.codexVoice.setCodexSettings({ permissionMode: profile.mode }, modelScope),
                      )
                    }
                  >
                    <PermissionIcon mode={profile.mode} />
                    <span>{profile.displayName}</span>
                    {profile.mode === effectivePermissionMode && <CheckIcon />}
                  </button>
                ))}
              </div>
            )}
          </div>
        </footer>
        </div>

        <RightPanel
          open={futureVisible}
          state={state}
          events={events}
          activateTranscriptRequest={transcriptActivationRequest}
          inspectedThread={inspectedThread}
          onClose={closeFuturePane}
          onAction={onAction}
        />
      </div>

      <VoiceSettingsPane
        open={settingsOpen}
        state={state}
        realtimeIssue={realtimeIssue}
        apiKey={apiKey}
        archivedCount={archivedCount}
        voiceConnected={voiceConnected}
        orbCustomization={orbCustomization}
        onOrbCustomizationChange={setOrbCustomization}
        onApiKeyChange={setApiKey}
        onSaveApiKey={saveApiKey}
        onClearApiKey={clearApiKey}
        onSelectWorkspace={selectWorkspaceFolder}
        onAction={onAction}
        onRefresh={onRefresh}
        onShowDebug={onShowDebug}
        onOpenArchived={() => setArchivedOpen(true)}
        onToggleVoice={onToggleVoice}
        onRestartVoice={onRestartVoice}
        onClose={() => setSettingsOpen(false)}
      />

      {newOpen && (
        <div className="voice-modal-backdrop" role="presentation">
          <form className="voice-dialog" onSubmit={(event) => void createNewProject(event)}>
            <div className="voice-dialog-header">
              <h2>New project</h2>
              <button type="button" aria-label="Close" onClick={() => setNewOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            <label className="voice-field">
              Project name
              <input
                autoFocus
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="Voice Project"
              />
            </label>
            <div className="voice-dialog-actions">
              <button type="button" onClick={() => setNewOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="voice-primary">
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {browseOpen && (
        <div className="voice-modal-backdrop" role="presentation">
          <section className="voice-dialog browse-dialog" aria-label="Browse projects">
            <div className="voice-dialog-header">
              <h2>Browse projects</h2>
              <button type="button" aria-label="Close" onClick={() => setBrowseOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            <label className="voice-field">
              Search
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search projects"
              />
            </label>
            <div className="browse-list">
              {filteredProjects.map((project) => (
                <button
                  key={project.id}
                  className="browse-row"
                  onClick={() => void resumeProject(project.id)}
                  onContextMenu={(event) => openProjectContextMenu(event, project)}
                >
                  <FolderIcon />
                  <span>
                    <strong>{project.displayName}</strong>
                    <small>{formatProjectTime(project.updatedAt)}</small>
                  </span>
                  <ChevronIcon />
                </button>
              ))}
              {filteredProjects.length === 0 && <p className="browse-empty">No matching projects.</p>}
            </div>
          </section>
        </div>
      )}

      {newChatOpen && (
        <div className="voice-modal-backdrop" role="presentation">
          <form className="voice-dialog" onSubmit={(event) => void createNewChat(event)}>
            <div className="voice-dialog-header">
              <h2>New chat</h2>
              <button type="button" aria-label="Close" onClick={() => setNewChatOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            <label className="voice-field">
              Chat name
              <input
                autoFocus
                value={newChatName}
                onChange={(event) => setNewChatName(event.target.value)}
                placeholder="Research thread"
              />
            </label>
            <div className="voice-dialog-actions">
              <button type="button" onClick={() => setNewChatOpen(false)}>
                Cancel
              </button>
              <button type="submit" className="voice-primary" disabled={!newChatName.trim()}>
                Create
              </button>
            </div>
          </form>
        </div>
      )}

      {switchChatOpen && (
        <div className="voice-modal-backdrop" role="presentation">
          <section className="voice-dialog browse-dialog" aria-label="Switch chat">
            <div className="voice-dialog-header">
              <h2>Switch chat</h2>
              <button type="button" aria-label="Close" onClick={() => setSwitchChatOpen(false)}>
                <CloseIcon />
              </button>
            </div>
            <div className="browse-list">
              {projectChats.map((chat) => (
                <button
                  key={chat.id}
                  className={`browse-row ${chat.active ? "selected-chat" : ""}`}
                  onClick={() => void switchChat(chat.id)}
                >
                  <span className={`chat-status-dot ${chat.tone}`} />
                  <span>
                    <strong>{chat.title}</strong>
                    <small>{chat.detail}</small>
                  </span>
                  <span className="browse-row-trailing">
                    {chat.active && <span className="active-chat-pill">Active</span>}
                    <ChevronIcon />
                  </span>
                </button>
              ))}
            </div>
          </section>
        </div>
      )}

      {apiKeyDialogMode && (
        <ApiKeyDialog
          mode={apiKeyDialogMode}
          realtime={state.realtime}
          realtimeIssue={realtimeIssue}
          apiKey={apiKey}
          onApiKeyChange={setApiKey}
          onSubmit={saveApiKey}
          onClose={closeApiKeyDialog}
        />
      )}

      {archivedOpen && (
        <ArchivedDialog
          projects={archivedProjects}
          chats={archivedChats}
          onClose={() => setArchivedOpen(false)}
          onRestoreProject={restoreProject}
          onRestoreChat={restoreChat}
        />
      )}

      {contextMenu && (
        <ArchiveContextMenu
          target={contextMenu}
          onArchive={() => void archiveContextTarget()}
        />
      )}
    </main>
  );
}

function VoiceSettingsPane({
  open,
  state,
  realtimeIssue,
  apiKey,
  archivedCount,
  voiceConnected,
  orbCustomization,
  onOrbCustomizationChange,
  onApiKeyChange,
  onSaveApiKey,
  onClearApiKey,
  onSelectWorkspace,
  onAction,
  onRefresh,
  onShowDebug,
  onOpenArchived,
  onToggleVoice,
  onRestartVoice,
  onClose,
}: {
  open: boolean;
  state: AppState;
  realtimeIssue: string | null;
  apiKey: string;
  archivedCount: number;
  voiceConnected: boolean;
  orbCustomization: VoiceOrbCustomization;
  onOrbCustomizationChange: (customization: VoiceOrbCustomization) => void;
  onApiKeyChange: (value: string) => void;
  onSaveApiKey: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onClearApiKey: () => Promise<void>;
  onSelectWorkspace: () => Promise<void>;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
  onRefresh: () => Promise<void>;
  onShowDebug: () => Promise<void>;
  onOpenArchived: () => void;
  onToggleVoice: () => Promise<void>;
  onRestartVoice: () => Promise<void>;
  onClose: () => void;
}): React.ReactElement {
  const [activeTab, setActiveTab] = useState<VoiceSettingsTab>("general");
  const [phoneWebhookSecret, setPhoneWebhookSecret] = useState("");
  const health = realtimeHealth(state.realtime, realtimeIssue);
  const activeProject = state.activeProject;
  const workspace = activeProject?.workspacePath ?? activeProject?.folderPath ?? "No active project";
  const hasApiKey = Boolean(apiKey.trim());
  const apiKeySource = state.realtime.apiKeySource;
  const apiKeyManagedByEnvironment = apiKeySource === "environment";
  const canClearSavedApiKey = apiKeySource === "saved";
  const realtimeSupportsReasoning = state.realtime.model === "gpt-realtime-2";
  const selectedRealtimeReasoningEffort =
    state.realtime.reasoningEffort ?? DEFAULT_REALTIME_REASONING_EFFORT;
  const tabs: Array<{ id: VoiceSettingsTab; label: string; icon: React.ReactElement }> = [
    { id: "general", label: "General", icon: <ConfigIcon /> },
    { id: "appearance", label: "Appearance", icon: <AppearanceIcon /> },
    { id: "configuration", label: "Configuration", icon: <WaveformIcon /> },
    { id: "archive", label: archivedCount > 0 ? `Archive (${archivedCount})` : "Archive", icon: <ArchiveIcon /> },
  ];

  useEffect(() => {
    if (open) {
      setActiveTab("general");
      setPhoneWebhookSecret("");
    }
  }, [open]);

  async function changeRealtimeModel(model: RealtimeModelId): Promise<void> {
    let updated = false;
    await onAction(async () => {
      try {
        await window.codexVoice.setRealtimeSettings({ model });
        updated = true;
      } catch (caught) {
        throw friendlyRealtimeSettingsError(caught);
      }
    });
    if (updated && voiceConnected) await onRestartVoice();
  }

  async function changeRealtimeVoice(voice: RealtimeVoiceId): Promise<void> {
    let updated = false;
    await onAction(async () => {
      try {
        await window.codexVoice.setRealtimeSettings({ voice });
        updated = true;
      } catch (caught) {
        throw friendlyRealtimeSettingsError(caught);
      }
    });
    if (updated && voiceConnected) await onRestartVoice();
  }

  async function changeRealtimeReasoningEffort(reasoningEffort: RealtimeReasoningEffort): Promise<void> {
    let updated = false;
    await onAction(async () => {
      try {
        await window.codexVoice.setRealtimeSettings({ reasoningEffort });
        updated = true;
      } catch (caught) {
        throw friendlyRealtimeSettingsError(caught);
      }
    });
    if (updated && voiceConnected) await onRestartVoice();
  }

  async function revokeMcpOkGrant(server: string, tool: string): Promise<void> {
    await onAction(() => window.codexVoice.revokeMcpOkGrant(server, tool));
  }

  async function togglePhoneMode(enabled: boolean): Promise<void> {
    await onAction(() => window.codexVoice.setPhoneSettings({ enabled }));
  }

  async function updatePhonePublicUrl(value: string): Promise<void> {
    await onAction(() => window.codexVoice.setPhoneSettings({ publicUrl: value.trim() || null }));
  }

  async function updatePhoneWebhookPath(value: string): Promise<void> {
    await onAction(() => window.codexVoice.setPhoneSettings({ webhookPath: value.trim() || "/phone/realtime-webhook" }));
  }

  async function updatePhonePort(value: string): Promise<void> {
    const localPort = Number(value);
    if (!Number.isInteger(localPort)) return;
    await onAction(() => window.codexVoice.setPhoneSettings({ localPort }));
  }

  async function updatePhoneAllowlist(value: string): Promise<void> {
    await onAction(() =>
      window.codexVoice.setPhoneSettings({
        allowedCallerNumbers: value
          .split(/[,\n]/)
          .map((entry) => entry.trim())
          .filter(Boolean),
      }),
    );
  }

  async function savePhoneWebhookSecret(): Promise<void> {
    const webhookSecret = phoneWebhookSecret.trim();
    if (!webhookSecret) return;
    await onAction(() => window.codexVoice.setPhoneSettings({ webhookSecret }));
    setPhoneWebhookSecret("");
  }

  async function clearPhoneWebhookSecret(): Promise<void> {
    await onAction(() => window.codexVoice.setPhoneSettings({ webhookSecret: null }));
    setPhoneWebhookSecret("");
  }

  return (
    <aside className="voice-settings-pane" aria-hidden={!open} inert={!open} aria-label="Settings">
      <div className="voice-settings-inner">
        <header className="voice-settings-header">
          <h2>Controls</h2>
          <button type="button" aria-label="Close settings" onClick={onClose}>
            <CloseIcon />
          </button>
        </header>

        <nav className="voice-settings-nav" aria-label="Control sections" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={tab.id === activeTab ? "selected" : ""}
              role="tab"
              aria-selected={tab.id === activeTab}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.icon}
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>

        <div className="voice-settings-scroll" role="tabpanel">
          {activeTab === "general" && (
            <>
              <section className="voice-settings-section">
                <h3>System</h3>
                <div className="voice-settings-card">
                  <div className="voice-settings-row">
                    <span>
                      <strong>Codex app-server</strong>
                      <small>{state.runtime.status}</small>
                    </span>
                    <StatusDot ready={state.runtime.ready} />
                  </div>
                  <div className="voice-settings-row">
                    <span>
                      <strong>Realtime voice</strong>
                      <small>{health.message}</small>
                    </span>
                    <StatusDot ready={health.ok} />
                  </div>
                  <button
                    type="button"
                    className="voice-settings-row voice-settings-workspace-row"
                    onClick={() => void onSelectWorkspace()}
                    aria-label="Select workspace folder"
                    title={workspace}
                  >
                    <span>
                      <strong>Workspace</strong>
                      <small>{workspace}</small>
                    </span>
                    <FolderIcon />
                  </button>
                </div>
              </section>

              <section className="voice-settings-section">
                <h3>OpenAI API key</h3>
                <form className="voice-settings-card voice-settings-api-key" onSubmit={(event) => void onSaveApiKey(event)}>
                  <div className="voice-settings-secret-status">
                    <strong>{apiKeyStorageTitle(state.realtime)}</strong>
                    <small>{apiKeyStorageDetail(state.realtime)}</small>
                  </div>
                  <label className="voice-settings-field">
                    {apiKeySource === "saved" ? "Replacement key" : "API key"}
                    <input
                      type="password"
                      value={apiKey}
                      onChange={(event) => onApiKeyChange(event.target.value)}
                      placeholder={apiKeyInputPlaceholder(state.realtime)}
                      disabled={apiKeyManagedByEnvironment}
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </label>
                  <div className="voice-settings-actions inline">
                    <button type="button" onClick={() => void onClearApiKey()} disabled={!canClearSavedApiKey}>
                      Clear
                    </button>
                    <button type="submit" className="primary" disabled={!hasApiKey || apiKeyManagedByEnvironment}>
                      {apiKeySource === "saved" ? "Replace" : "Save"}
                    </button>
                  </div>
                </form>
              </section>

              <section className="voice-settings-section">
                <h3>Actions</h3>
                <div className="voice-settings-card action-settings-card">
                  <button type="button" className="voice-settings-action" onClick={() => void onRefresh()}>
                    <RefreshIcon />
                    <span>
                      <strong>Refresh</strong>
                      <small>Reload projects and runtime state</small>
                    </span>
                  </button>
                  <button type="button" className="voice-settings-action" onClick={() => void onShowDebug()}>
                    <DebugIcon />
                    <span>
                      <strong>Debug UI</strong>
                      <small>Open the operator dashboard</small>
                    </span>
                  </button>
                  {voiceConnected && (
                    <button type="button" className="voice-settings-action" onClick={() => void onToggleVoice()}>
                      <PowerIcon />
                      <span>
                        <strong>Disconnect voice</strong>
                        <small>Stop the active Realtime session</small>
                      </span>
                    </button>
                  )}
                </div>
              </section>

              <section className="voice-settings-section">
                <h3>MCP OK grants</h3>
                <div className="voice-settings-card action-settings-card">
                  {state.mcpOkGrants.length === 0 ? (
                    <div className="voice-settings-permission-note">
                      <strong>No saved MCP tool grants</strong>
                      <small>Accepted app-server MCP tool approvals will appear here.</small>
                    </div>
                  ) : (
                    state.mcpOkGrants.map((grant) => (
                      <div key={`${grant.server}:${grant.tool}`} className="voice-settings-grant">
                        <span>
                          <strong>{grant.tool}</strong>
                          <small>{grant.server}</small>
                        </span>
                        <button
                          type="button"
                          onClick={() => void revokeMcpOkGrant(grant.server, grant.tool)}
                          aria-label={`Revoke MCP OK grant for ${grant.server}.${grant.tool}`}
                        >
                          Revoke
                        </button>
                      </div>
                    ))
                  )}
                </div>
              </section>
            </>
          )}

          {activeTab === "appearance" && (
            <section className="voice-settings-section">
              <h3>Orb</h3>
              <VoiceOrbColorPicker customization={orbCustomization} onCustomizationChange={onOrbCustomizationChange} />
            </section>
          )}

          {activeTab === "configuration" && (
            <>
              <section className="voice-settings-section">
                <h3>Realtime voice</h3>
                <div className="voice-settings-card">
                <label className="voice-settings-field">
                  Model
                  <span className="voice-settings-select-wrap">
                    <select
                      value={state.realtime.model}
                      onChange={(event) => void changeRealtimeModel(event.target.value as RealtimeModelId)}
                    >
                      {REALTIME_MODEL_OPTIONS.map((model) => (
                        <option key={model.model} value={model.model}>
                          {model.displayName}
                        </option>
                      ))}
                    </select>
                    <DownIcon />
                  </span>
                </label>

                <div className={`realtime-reasoning-panel ${realtimeSupportsReasoning ? "" : "disabled"}`}>
                  <div className="realtime-reasoning-header">
                    <span>
                      <strong>Reasoning</strong>
                      <small>
                        {realtimeSupportsReasoning
                          ? formatEffort(selectedRealtimeReasoningEffort)
                          : "Off on Realtime 1.5"}
                      </small>
                    </span>
                    <span className="realtime-reasoning-badge">
                      {realtimeSupportsReasoning ? "2.0" : "1.5"}
                    </span>
                  </div>
                  <div className="voice-settings-segmented realtime-reasoning" aria-label="Realtime reasoning effort">
                    {REALTIME_REASONING_EFFORT_OPTIONS.map((effort) => (
                      <button
                        key={effort}
                        type="button"
                        className={
                          realtimeSupportsReasoning && effort === selectedRealtimeReasoningEffort
                            ? "selected"
                            : ""
                        }
                        disabled={!realtimeSupportsReasoning}
                        onClick={() => void changeRealtimeReasoningEffort(effort)}
                      >
                        {formatEffort(effort)}
                      </button>
                    ))}
                  </div>
                </div>

                <label className="voice-settings-field">
                  Voice
                  <span className="voice-settings-select-wrap">
                    <select
                      value={state.realtime.voice}
                      onChange={(event) => void changeRealtimeVoice(event.target.value as RealtimeVoiceId)}
                    >
                      {REALTIME_VOICE_OPTIONS.map((voice) => (
                        <option key={voice.voice} value={voice.voice}>
                          {voice.displayName}
                        </option>
                      ))}
                    </select>
                    <DownIcon />
                  </span>
                </label>
                </div>
              </section>

              <section className="voice-settings-section">
                <h3>Phone mode</h3>
                <div className="voice-settings-card">
                  <div className="voice-settings-row">
                    <span>
                      <strong>{state.phone.settings.enabled ? "Enabled" : "Disabled"}</strong>
                      <small>
                        {state.phone.listener.running
                          ? state.phone.listener.url ?? "Phone listener running"
                          : state.phone.listener.error ?? "Phone listener is not running"}
                      </small>
                    </span>
                    <button
                      type="button"
                      className="voice-settings-mini-button"
                      onClick={() => void togglePhoneMode(!state.phone.settings.enabled)}
                    >
                      {state.phone.settings.enabled ? "Turn off" : "Turn on"}
                    </button>
                  </div>
                  <label className="voice-settings-field">
                    Public URL
                    <input
                      defaultValue={state.phone.settings.publicUrl ?? ""}
                      placeholder="https://example.ngrok-free.app"
                      onBlur={(event) => void updatePhonePublicUrl(event.currentTarget.value)}
                    />
                  </label>
                  <div className="voice-settings-split">
                    <label className="voice-settings-field">
                      Local port
                      <input
                        type="number"
                        min={1}
                        max={65535}
                        defaultValue={state.phone.settings.localPort || ""}
                        onBlur={(event) => void updatePhonePort(event.currentTarget.value)}
                      />
                    </label>
                    <label className="voice-settings-field">
                      Webhook path
                      <input
                        defaultValue={state.phone.settings.webhookPath}
                        onBlur={(event) => void updatePhoneWebhookPath(event.currentTarget.value)}
                      />
                    </label>
                  </div>
                  <label className="voice-settings-field">
                    Allowed callers
                    <textarea
                      defaultValue={state.phone.settings.allowedCallerNumbers.join("\n")}
                      placeholder="+15551234567"
                      onBlur={(event) => void updatePhoneAllowlist(event.currentTarget.value)}
                    />
                  </label>
                  <label className="voice-settings-field">
                    Webhook secret
                    <input
                      type="password"
                      value={phoneWebhookSecret}
                      placeholder={state.phone.settings.webhookSecretConfigured ? "Secret configured" : "whsec_..."}
                      autoComplete="off"
                      spellCheck={false}
                      onChange={(event) => setPhoneWebhookSecret(event.target.value)}
                    />
                  </label>
                  <div className="voice-settings-actions inline">
                    <button
                      type="button"
                      onClick={() => void clearPhoneWebhookSecret()}
                      disabled={!state.phone.settings.webhookSecretConfigured && !phoneWebhookSecret.trim()}
                    >
                      Clear
                    </button>
                    <button
                      type="button"
                      className="primary"
                      onClick={() => void savePhoneWebhookSecret()}
                      disabled={!phoneWebhookSecret.trim()}
                    >
                      Save
                    </button>
                  </div>
                  <label className="voice-settings-checkrow">
                    <input
                      type="checkbox"
                      checked={state.phone.settings.allowUnsignedDevWebhooks}
                      onChange={(event) =>
                        void onAction(() =>
                          window.codexVoice.setPhoneSettings({
                            allowUnsignedDevWebhooks: event.currentTarget.checked,
                          }),
                        )
                      }
                    />
                    <span>Allow unsigned local webhooks</span>
                  </label>
                  {state.phone.activeCall && (
                    <button
                      type="button"
                      className="voice-settings-action"
                      onClick={() => void onAction(() => window.codexVoice.hangupPhoneCall())}
                    >
                      <PowerIcon />
                      <span>
                        <strong>Hang up</strong>
                        <small>{state.phone.activeCall.from ?? state.phone.activeCall.callId}</small>
                      </span>
                    </button>
                  )}
                </div>
              </section>
            </>
          )}

          {activeTab === "archive" && (
            <section className="voice-settings-section">
              <h3>Archive</h3>
              <div className="voice-settings-card action-settings-card">
                <button type="button" className="voice-settings-action" onClick={onOpenArchived}>
                  <ArchiveIcon />
                  <span>
                    <strong>Archived items</strong>
                    <small>{archivedCount > 0 ? `${archivedCount} archived items` : "No archived items"}</small>
                  </span>
                </button>
              </div>
            </section>
          )}
        </div>
      </div>
    </aside>
  );
}

function VoiceOrbColorPicker({
  customization,
  onCustomizationChange,
}: {
  customization: VoiceOrbCustomization;
  onCustomizationChange: (customization: VoiceOrbCustomization) => void;
}): React.ReactElement {
  function selectColor(accentColor: string): void {
    onCustomizationChange(normalizeVoiceOrbCustomization({ ...customization, accentColor }));
  }

  return (
    <div className="voice-settings-card voice-orb-picker-card">
      <div className="voice-orb-carousel" aria-label="Orb preview">
        <div className="voice-orb-carousel-center">
          <div className="voice-orb-carousel-preview">
            <VoiceOrbCanvas tone="listening" outputLevel={0.32} customization={customization} preview />
          </div>
          <div className="voice-orb-carousel-label">
            <strong>Aurora</strong>
            <small>Color only</small>
          </div>
        </div>
      </div>

      <div className="voice-orb-customizer" aria-label="Orb color">
        <div className="voice-orb-control-row">
          <span className="voice-orb-control-label">Color</span>
          <div className="voice-orb-swatches" aria-label="Orb colors">
            {voiceOrbColorOptions.map((option) => (
              <button
                key={option.color}
                type="button"
                className={option.color.toLowerCase() === customization.accentColor.toLowerCase() ? "selected" : ""}
                style={{ backgroundColor: option.color }}
                aria-label={option.label}
                onClick={() => selectColor(option.color)}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusDot({ ready }: { ready: boolean }): React.ReactElement {
  return <span className={`settings-status-dot ${ready ? "ready" : ""}`} aria-hidden="true" />;
}

function VoiceOrbCanvas({
  tone,
  outputLevel,
  customization = defaultVoiceOrbCustomization,
  preview = false,
}: {
  tone: VoiceTone;
  outputLevel: number;
  customization?: VoiceOrbCustomization;
  preview?: boolean;
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const toneRef = useRef(tone);
  const outputLevelRef = useRef(outputLevel);
  const customizationRef = useRef(customization);

  useEffect(() => {
    toneRef.current = tone;
  }, [tone]);

  useEffect(() => {
    outputLevelRef.current = outputLevel;
  }, [outputLevel]);

  useEffect(() => {
    customizationRef.current = customization;
  }, [customization]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const context = canvas.getContext("2d");
    if (!context) return undefined;

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let animationFrame = 0;
    let lastTime = performance.now();
    let renderedLevel = 0;
    let wavePhase = 0;
    let cloudPhase = 0;
    let pressImpulse = 0;
    let wasActive = false;

    const draw = (now: number) => {
      const { width, height } = resizeOrbCanvas(canvas, context);
      const dt = Math.min(48, Math.max(8, now - lastTime));
      lastTime = now;

      if (width < 4 || height < 4) {
        animationFrame = window.requestAnimationFrame(draw);
        return;
      }

      const orbCustomization = customizationRef.current;
      const reactivityScale = 0.55 + orbCustomization.reactivity / 100;
      const waveScale = 0.58 + orbCustomization.waveHeight / 100;
      const orb = canvas.closest(preview ? ".voice-orb-carousel" : ".voice-orb") as HTMLElement | null;
      const hovering = Boolean(orb?.matches(":hover, :focus-visible"));
      const active = Boolean(orb?.matches(":active"));
      if (active && !wasActive) pressImpulse = 1;
      wasActive = active;

      const reduced = reducedMotion.matches;
      const toneEnergy = preview ? 0.16 : voiceToneBaseEnergy(toneRef.current);
      const outputEnergy = Math.min(1, Math.max(0, outputLevelRef.current) * reactivityScale);
      const interactionEnergy = reduced ? 0 : ((hovering ? 0.18 : 0) + pressImpulse * 0.42) * reactivityScale;
      const targetLevel = Math.min(1, Math.max(toneEnergy, outputEnergy) + interactionEnergy);
      const smoothing = targetLevel > renderedLevel ? 0.22 : 0.075;
      renderedLevel += (targetLevel - renderedLevel) * smoothing;
      pressImpulse *= Math.pow(0.0018, dt / 1000);

      const motion = reduced ? 0.08 : 1;
      wavePhase += dt * (0.001 + renderedLevel * 0.0033 * reactivityScale) * motion;
      cloudPhase += dt * (0.0002 + renderedLevel * 0.00075 * reactivityScale) * motion;

      context.clearRect(0, 0, width, height);
      context.save();
      clipOrbShapePath(context, width, height);

      drawOrbPresetBase(context, width, height, renderedLevel, cloudPhase);
      drawOrbTint(context, width, height, orbCustomization.accentColor, renderedLevel);
      drawOrbClouds(context, width, height, renderedLevel, cloudPhase, hovering);
      const palette = orbWavePalette(orbCustomization.accentColor);

      drawOrbWaveLayer(context, width, height, {
        baseline: height * (0.72 - renderedLevel * 0.18),
        amplitude: (7 + renderedLevel * 25) * waveScale,
        phase: wavePhase * 2.1,
        frequency: 0.92,
        secondFrequency: 2.2,
        blur: 8,
        alpha: 0.46 + renderedLevel * 0.26,
        stops: palette.deep,
      });

      drawOrbWaveLayer(context, width, height, {
        baseline: height * (0.62 - renderedLevel * 0.16),
        amplitude: (5 + renderedLevel * 19) * waveScale,
        phase: -wavePhase * 2.7 + 0.8,
        frequency: 1.26,
        secondFrequency: 2.85,
        blur: 6,
        alpha: 0.38 + renderedLevel * 0.24,
        stops: palette.mid,
      });

      drawOrbWaveLayer(context, width, height, {
        baseline: height * (0.52 - renderedLevel * 0.13),
        amplitude: (3 + renderedLevel * 13) * waveScale,
        phase: wavePhase * 3.15 + 2.4,
        frequency: 0.7,
        secondFrequency: 1.8,
        blur: 10,
        alpha: 0.2 + renderedLevel * 0.18,
        stops: palette.mist,
      });

      drawOrbCrestLine(context, width, height, {
        baseline: height * (0.55 - renderedLevel * 0.15),
        amplitude: (3 + renderedLevel * 15) * waveScale,
        phase: wavePhase * 3.4 + 1.2,
        alpha: 0.22 + renderedLevel * 0.36,
        stops: palette.crest,
      });

      context.restore();
      drawOrbPresetEdge(context, width, height, orbCustomization);
      animationFrame = window.requestAnimationFrame(draw);
    };

    animationFrame = window.requestAnimationFrame(draw);
    return () => window.cancelAnimationFrame(animationFrame);
  }, []);

  return <canvas ref={canvasRef} className="voice-orb-canvas" aria-hidden="true" />;
}

function voiceToneBaseEnergy(tone: VoiceTone): number {
  if (tone === "connecting") return 0.33;
  if (tone === "working") return 0.28;
  if (tone === "listening") return 0.22;
  if (tone === "waiting") return 0.2;
  if (tone === "paused") return 0.04;
  return 0.06;
}

function beginSphereShapePath(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  context.beginPath();
  context.arc(width / 2, height / 2, Math.min(width, height) / 2 - 1, 0, Math.PI * 2);
}

function clipOrbShapePath(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  beginSphereShapePath(context, width, height);
  context.clip();
}

function strokeOrbShapePath(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): void {
  beginSphereShapePath(context, width, height);
  context.stroke();
}

function drawOrbPresetBase(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  _level: number,
  _phase: number,
): void {
  const base = context.createLinearGradient(0, height * 0.04, 0, height);
  base.addColorStop(0, "rgba(255, 255, 250, 0.92)");
  base.addColorStop(0.38, "rgba(225, 255, 255, 0.86)");
  base.addColorStop(0.7, "rgba(68, 198, 255, 0.72)");
  base.addColorStop(1, "rgba(0, 120, 255, 0.82)");
  context.fillStyle = base;
  context.fillRect(0, 0, width, height);
}

function drawOrbPresetEdge(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  customization: VoiceOrbCustomization,
): void {
  context.save();
  context.globalCompositeOperation = "screen";
  context.shadowBlur = 0;
  context.strokeStyle = rgbaFromHex(customization.accentColor, 0.42) ?? "rgba(238, 255, 255, 0.52)";
  context.lineWidth = 1.4;
  strokeOrbShapePath(context, width, height);
  context.restore();
}

function drawOrbTint(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  color: string,
  level: number,
): void {
  const rgb = rgbFromHex(color);
  if (!rgb) return;

  context.save();
  context.globalCompositeOperation = "soft-light";
  context.globalAlpha = 0.32;
  context.fillStyle = `rgb(${rgb.r} ${rgb.g} ${rgb.b})`;
  context.fillRect(0, 0, width, height);

  const band = context.createLinearGradient(0, height * 0.18, 0, height);
  band.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
  band.addColorStop(0.48, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.1)`);
  band.addColorStop(0.82, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${0.24 + level * 0.14})`);
  band.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${0.3 + level * 0.16})`);
  context.globalCompositeOperation = "source-over";
  context.globalAlpha = 1;
  context.fillStyle = band;
  context.fillRect(0, 0, width, height);

  context.restore();
}

function rgbFromHex(color: string): { r: number; g: number; b: number } | null {
  if (!isHexColor(color)) return null;
  return {
    r: Number.parseInt(color.slice(1, 3), 16),
    g: Number.parseInt(color.slice(3, 5), 16),
    b: Number.parseInt(color.slice(5, 7), 16),
  };
}

function rgbaFromHex(color: string, alpha: number): string | null {
  const rgb = rgbFromHex(color);
  return rgb ? `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})` : null;
}

function voiceAccentStyle(customization: VoiceOrbCustomization): React.CSSProperties {
  const accent = isHexColor(customization.accentColor)
    ? customization.accentColor
    : defaultVoiceOrbCustomization.accentColor;
  return {
    "--voice-accent": accent,
    "--voice-accent-soft": rgbaFromHex(accent, 0.22) ?? "rgba(29, 155, 240, 0.22)",
    "--voice-accent-mid": rgbaFromHex(accent, 0.34) ?? "rgba(29, 155, 240, 0.34)",
    "--voice-accent-strong": rgbaFromHex(accent, 0.58) ?? "rgba(29, 155, 240, 0.58)",
    "--voice-glow-faint": "transparent",
    "--voice-glow-soft": "transparent",
    "--voice-glow-medium": "transparent",
    "--voice-glow-strong": "transparent",
    "--voice-glow-hot": "transparent",
    "--voice-glow-rim": "rgba(235, 251, 255, 0.38)",
  } as React.CSSProperties;
}

function mixRgb(
  rgb: { r: number; g: number; b: number },
  target: { r: number; g: number; b: number },
  amount: number,
): { r: number; g: number; b: number } {
  return {
    r: Math.round(rgb.r + (target.r - rgb.r) * amount),
    g: Math.round(rgb.g + (target.g - rgb.g) * amount),
    b: Math.round(rgb.b + (target.b - rgb.b) * amount),
  };
}

function rgbaFromRgb(rgb: { r: number; g: number; b: number }, alpha: number): string {
  return `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
}

function orbWavePalette(accentColor?: string): {
  deep: Array<[number, string]>;
  mid: Array<[number, string]>;
  mist: Array<[number, string]>;
  crest: Array<[number, string]>;
} {
  const accent = accentColor ? rgbFromHex(accentColor) : null;
  if (accent) {
    const light = mixRgb(accent, { r: 255, g: 255, b: 255 }, 0.5);
    const mist = mixRgb(accent, { r: 236, g: 255, b: 255 }, 0.68);
    const deep = mixRgb(accent, { r: 0, g: 24, b: 88 }, 0.34);

    return {
      deep: [
        [0, rgbaFromRgb(mist, 0.16)],
        [0.34, rgbaFromRgb(accent, 0.54)],
        [0.7, rgbaFromRgb(accent, 0.78)],
        [1, rgbaFromRgb(deep, 0.96)],
      ],
      mid: [
        [0, "rgba(255, 255, 255, 0.2)"],
        [0.35, rgbaFromRgb(light, 0.48)],
        [0.72, rgbaFromRgb(accent, 0.58)],
        [1, rgbaFromRgb(deep, 0.66)],
      ],
      mist: [
        [0, "rgba(255, 255, 255, 0.42)"],
        [0.48, rgbaFromRgb(mist, 0.28)],
        [1, rgbaFromRgb(accent, 0.2)],
      ],
      crest: [
        [0, "rgba(255, 255, 244, 0)"],
        [0.25, rgbaFromRgb(light, 0.78)],
        [0.58, rgbaFromRgb(mist, 0.68)],
        [1, "rgba(255, 255, 244, 0)"],
      ],
    };
  }

  return {
    deep: [
      [0, "rgba(180, 247, 255, 0.08)"],
      [0.28, "rgba(85, 219, 255, 0.28)"],
      [0.58, "rgba(0, 151, 255, 0.68)"],
      [1, "rgba(0, 84, 255, 0.88)"],
    ],
    mid: [
      [0, "rgba(247, 255, 247, 0.2)"],
      [0.34, "rgba(190, 251, 255, 0.42)"],
      [0.72, "rgba(34, 190, 255, 0.52)"],
      [1, "rgba(0, 117, 255, 0.62)"],
    ],
    mist: [
      [0, "rgba(255, 255, 238, 0.36)"],
      [0.46, "rgba(236, 255, 249, 0.26)"],
      [1, "rgba(127, 232, 255, 0.18)"],
    ],
    crest: [
      [0, "rgba(255, 255, 244, 0)"],
      [0.24, "rgba(255, 255, 244, 0.7)"],
      [0.58, "rgba(210, 255, 255, 0.62)"],
      [1, "rgba(255, 255, 244, 0)"],
    ],
  };
}

function resizeOrbCanvas(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
): { width: number; height: number } {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const pixelWidth = Math.max(1, Math.round(rect.width * dpr));
  const pixelHeight = Math.max(1, Math.round(rect.height * dpr));
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { width: rect.width, height: rect.height };
}

function drawOrbClouds(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  level: number,
  phase: number,
  hovering: boolean,
): void {
  const lift = level * height * 0.08;
  const hoverLift = hovering ? height * 0.015 : 0;

  context.save();
  context.globalCompositeOperation = "screen";
  context.filter = `blur(${8 + level * 5}px)`;
  context.globalAlpha = 0.42 + level * 0.26;

  const topGradient = context.createRadialGradient(
    width * (0.46 + Math.sin(phase * 0.9) * 0.05),
    height * (0.2 + Math.cos(phase * 0.7) * 0.025),
    0,
    width * 0.5,
    height * 0.22,
    width * 0.58,
  );
  topGradient.addColorStop(0, "rgba(255, 255, 246, 0.7)");
  topGradient.addColorStop(0.48, "rgba(220, 255, 252, 0.28)");
  topGradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.fillStyle = topGradient;
  context.beginPath();
  context.ellipse(width * 0.5, height * 0.22, width * 0.5, height * 0.24, -0.05, 0, Math.PI * 2);
  context.fill();

  const cloudGradient = context.createRadialGradient(
    width * (0.25 + Math.sin(phase * 1.5) * 0.055),
    height * 0.5 - lift - hoverLift,
    0,
    width * 0.36,
    height * 0.53 - lift,
    width * 0.58,
  );
  cloudGradient.addColorStop(0, "rgba(255, 254, 230, 0.46)");
  cloudGradient.addColorStop(0.35, "rgba(205, 252, 255, 0.3)");
  cloudGradient.addColorStop(0.72, "rgba(88, 218, 255, 0.12)");
  cloudGradient.addColorStop(1, "rgba(255, 255, 255, 0)");
  context.fillStyle = cloudGradient;
  context.beginPath();
  context.ellipse(width * 0.38, height * 0.53 - lift, width * 0.48, height * 0.2, -0.2, 0, Math.PI * 2);
  context.fill();

  context.restore();
}

function drawOrbWaveLayer(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  options: {
    baseline: number;
    amplitude: number;
    phase: number;
    frequency: number;
    secondFrequency: number;
    blur: number;
    alpha: number;
    stops: Array<[number, string]>;
  },
): void {
  context.save();
  context.filter = `blur(${options.blur}px)`;
  context.globalAlpha = options.alpha;
  context.globalCompositeOperation = "source-over";
  context.beginPath();
  context.moveTo(-20, height + 20);

  for (let x = -20; x <= width + 20; x += 3) {
    const unit = x / width;
    const y =
      options.baseline +
      Math.sin(unit * Math.PI * 2 * options.frequency + options.phase) * options.amplitude +
      Math.sin(unit * Math.PI * 2 * options.secondFrequency - options.phase * 0.72) * options.amplitude * 0.38 +
      Math.sin(unit * Math.PI * 2 * 0.5 + options.phase * 1.6) * options.amplitude * 0.16;
    context.lineTo(x, y);
  }

  context.lineTo(width + 20, height + 20);
  context.closePath();

  const gradient = context.createLinearGradient(0, options.baseline - options.amplitude * 2, 0, height);
  for (const [offset, color] of options.stops) {
    gradient.addColorStop(offset, color);
  }
  context.fillStyle = gradient;
  context.fill();
  context.restore();
}

function drawOrbCrestLine(
  context: CanvasRenderingContext2D,
  width: number,
  _height: number,
  options: {
    baseline: number;
    amplitude: number;
    phase: number;
    alpha: number;
    stops: Array<[number, string]>;
  },
): void {
  context.save();
  context.filter = "blur(3px)";
  context.globalCompositeOperation = "screen";
  context.globalAlpha = options.alpha;
  context.beginPath();

  for (let x = -8; x <= width + 8; x += 2) {
    const unit = x / width;
    const y =
      options.baseline +
      Math.sin(unit * Math.PI * 2 * 0.95 + options.phase) * options.amplitude +
      Math.sin(unit * Math.PI * 2 * 2.4 - options.phase * 0.6) * options.amplitude * 0.28;
    if (x === -8) {
      context.moveTo(x, y);
    } else {
      context.lineTo(x, y);
    }
  }

  const gradient = context.createLinearGradient(0, 0, width, 0);
  for (const [offset, color] of options.stops) {
    gradient.addColorStop(offset, color);
  }
  context.strokeStyle = gradient;
  context.lineWidth = 3.2;
  context.lineCap = "round";
  context.stroke();
  context.restore();
}

function ApiKeyDialog({
  mode,
  realtime,
  realtimeIssue,
  apiKey,
  onApiKeyChange,
  onSubmit,
  onClose,
}: {
  mode: ApiKeyDialogMode;
  realtime: AppState["realtime"];
  realtimeIssue: string | null;
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  onSubmit: (event: React.FormEvent<HTMLFormElement>) => Promise<void>;
  onClose: () => void;
}): React.ReactElement {
  const [revealed, setRevealed] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [waveDancing, setWaveDancing] = useState(false);
  const waveDanceTimeoutRef = useRef<number | null>(null);
  const title = mode === "connect" ? "Connect OpenAI" : "OpenAI API key";
  const primaryLabel =
    realtime.apiKeySource === "saved" ? "Replace" : mode === "connect" ? "Save key" : "Save";
  const secondaryLabel = mode === "connect" ? "Later" : "Cancel";
  const hasApiKey = Boolean(apiKey.trim());
  const apiKeyManagedByEnvironment = realtime.apiKeySource === "environment";
  const health = realtimeHealth(realtime, realtimeIssue);

  useEffect(
    () => () => {
      if (waveDanceTimeoutRef.current !== null) {
        window.clearTimeout(waveDanceTimeoutRef.current);
      }
    },
    [],
  );

  function startWaveDance(): void {
    if (waveDancing) return;
    setWaveDancing(true);
    if (waveDanceTimeoutRef.current !== null) {
      window.clearTimeout(waveDanceTimeoutRef.current);
    }
    waveDanceTimeoutRef.current = window.setTimeout(() => {
      setWaveDancing(false);
      waveDanceTimeoutRef.current = null;
    }, 1280);
  }

  return (
    <div className="voice-modal-backdrop api-key-backdrop" role="presentation">
      <form className="voice-dialog api-key-dialog" onSubmit={(event) => void onSubmit(event)}>
        <div className="api-key-visual" aria-hidden="true">
          <span
            className={`api-key-meter ${waveDancing ? "dancing" : ""}`}
            onPointerEnter={startWaveDance}
            onFocus={startWaveDance}
          >
            <span />
            <span />
            <span />
            <span />
            <span />
          </span>
        </div>

        <div className="voice-dialog-header api-key-header">
          <div>
            <div className="api-key-title-row">
              <h2>{title}</h2>
              <span
                className={`api-key-status ${health.ok ? "ready" : "broken"}`}
                tabIndex={health.ok ? undefined : 0}
                aria-label={health.ok ? "Realtime API key is ready" : health.message}
                title={health.ok ? "Realtime API key is ready" : undefined}
              >
                {!health.ok && <span className="api-key-health-popover">{health.message}</span>}
              </span>
            </div>
          </div>
          <button
            type="button"
            className="api-key-info-button"
            aria-label="API key storage details"
            title="Storage details"
            onClick={() => setInfoOpen((current) => !current)}
          >
            <InfoIcon />
          </button>
          {infoOpen && (
            <div className="api-key-info-popover" role="status">
              Main creates Realtime client secrets. Saved keys are not sent back to this window.
            </div>
          )}
        </div>

        <div className="voice-field api-key-field">
          <div className="api-key-input-wrap">
            <input
              id="openai-api-key-input"
              aria-label="OpenAI API key"
              autoFocus
              type={revealed ? "text" : "password"}
              value={apiKey}
              onChange={(event) => onApiKeyChange(event.target.value)}
              placeholder={apiKeyInputPlaceholder(realtime)}
              disabled={apiKeyManagedByEnvironment}
              autoComplete="off"
              spellCheck={false}
            />
            <div className="api-key-input-actions">
              <button
                type="button"
                aria-label={revealed ? "Hide API key" : "Reveal API key"}
                title={revealed ? "Hide key" : "Reveal key"}
                disabled={!hasApiKey}
                onClick={() => setRevealed((current) => !current)}
              >
                {revealed ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>
          </div>
        </div>

        <div className="voice-dialog-actions api-key-actions">
          <button type="button" onClick={onClose}>
            {secondaryLabel}
          </button>
          <button type="submit" className="voice-primary" disabled={!hasApiKey || apiKeyManagedByEnvironment}>
            {primaryLabel}
          </button>
        </div>
      </form>
    </div>
  );
}

function FeaturedProjectCard({
  activeProjectId,
  chatsOpen,
  project,
  onCreate,
  onResume,
  onOpenMenu,
  onToggleChats,
}: {
  activeProjectId: string | null;
  chatsOpen: boolean;
  project: VoiceProject | null;
  onCreate: () => void;
  onResume: (projectId: string) => Promise<void>;
  onOpenMenu: (event: React.MouseEvent<HTMLElement>, project: VoiceProject) => void;
  onToggleChats: () => void;
}): React.ReactElement {
  if (!project) {
    return (
      <button className="featured-project-card empty-feature" onClick={onCreate}>
        <span className="voice-folder-tile">
          <FolderIcon />
        </span>
        <span className="featured-copy">
          <strong>No active project</strong>
          <small>Create a project to begin</small>
        </span>
        <ChevronIcon />
      </button>
    );
  }

  const active = project.id === activeProjectId;
  return (
    <button
      className={`featured-project-card ${chatsOpen && active ? "expanded" : ""}`}
      aria-expanded={active ? chatsOpen : undefined}
      onContextMenu={(event) => onOpenMenu(event, project)}
      onClick={() => {
        if (active) {
          onToggleChats();
          return;
        }
        void onResume(project.id);
      }}
    >
      <span className="voice-folder-tile">
        <FolderIcon />
      </span>
      <span className="featured-copy">
        <strong>{project.displayName}</strong>
        <small>
          {formatProjectTime(project.updatedAt)}
          {active && (
            <>
              <span className="voice-meta-dot">.</span>
              <span className="active-project-text">Active project</span>
            </>
          )}
        </small>
      </span>
      <ChevronIcon className={chatsOpen && active ? "chevron-open" : ""} />
    </button>
  );
}

type ChatSummary = {
  id: string;
  title: string;
  detail: string;
  tone: "active" | "waiting" | "idle";
  active: boolean;
  subagents: ChatSubagentSummary[];
};

type ChatSubagentSummary = {
  id: string;
  parentTitle: string;
  title: string;
  threadId: string;
  detail: string;
  tone: "active" | "waiting" | "idle";
};

function ProjectChatsPanel({
  chats,
  onNewChat,
  onSwitchChat,
  onSelectChat,
  selectedSubagentId,
  onSelectSubagent,
  onInspectSubagent,
  onOpenChatMenu,
  onAction,
}: {
  chats: ChatSummary[];
  onNewChat: () => void;
  onSwitchChat: () => void;
  onSelectChat: (chatId: string) => Promise<void>;
  selectedSubagentId: string | null;
  onSelectSubagent: (subagentId: string) => void;
  onInspectSubagent: (subagent: ChatSubagentSummary) => void;
  onOpenChatMenu: (event: React.MouseEvent<HTMLElement>, chat: ChatSummary) => void;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  const activeChat = chats.find((chat) => chat.active) ?? null;
  return (
    <div className="project-chats-panel">
      <div className="project-chats-header">
        <div>
          <h2>Chats in this project</h2>
          {activeChat && (
            <p>
              Active chat: <strong>{activeChat.title}</strong>
            </p>
          )}
        </div>
        <span>{chats.length}</span>
      </div>
      <div className="project-chat-list">
        {chats.map((chat) => (
          <React.Fragment key={chat.id}>
            <button
              className={`project-chat-row ${chat.active ? "active" : ""}`}
              onClick={() => void onSelectChat(chat.id)}
              onContextMenu={(event) => onOpenChatMenu(event, chat)}
            >
              <span className={`chat-status-dot ${chat.tone}`} />
              <span className="project-chat-copy">
                <strong>{chat.title}</strong>
                <small>{chat.detail}</small>
              </span>
              {chat.active && (
                <span className="project-chat-trailing">
                  <span className="active-chat-pill">Active</span>
                </span>
              )}
            </button>
            {chat.active && chat.subagents.map((subagent) => (
              <SubagentRow
                key={subagent.id}
                subagent={subagent}
                selected={subagent.id === selectedSubagentId}
                onSelect={() => onSelectSubagent(subagent.id)}
                onInspect={() => onInspectSubagent(subagent)}
                onAction={onAction}
              />
            ))}
          </React.Fragment>
        ))}
      </div>
      <div className="voice-actions chat-actions">
        <button className="voice-action-button" type="button" onClick={onNewChat}>
          <PlusIcon />
          <span>New chat</span>
        </button>
        <button className="voice-action-button" type="button" onClick={onSwitchChat}>
          <SwitchIcon />
          <span>Switch chat</span>
        </button>
      </div>
    </div>
  );
}

function SubagentRow({
  subagent,
  selected,
  onSelect,
  onInspect,
  onAction,
}: {
  subagent: ChatSubagentSummary;
  selected: boolean;
  onSelect: () => void;
  onInspect: () => void;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  const [steerText, setSteerText] = useState("");
  const canSteer = Boolean(steerText.trim());
  return (
    <div className={`project-subagent-row ${selected ? "selected" : ""}`}>
      <button type="button" className="project-subagent-main" onClick={onSelect}>
        <span className={`chat-status-dot ${subagent.tone}`} />
        <span className="project-chat-copy">
          <strong>{subagent.title}</strong>
          <small>{subagent.detail}</small>
        </span>
      </button>
      {selected && (
        <div className="project-subagent-actions">
          <button type="button" onClick={onInspect}>
            Inspect
          </button>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              const text = steerText.trim();
              if (!text) return;
              void onAction(async () => {
                await window.codexVoice.steerCodexThread(subagent.threadId, text);
                setSteerText("");
              });
            }}
          >
            <input
              value={steerText}
              onChange={(event) => setSteerText(event.target.value)}
              placeholder="Steer child thread"
            />
            <button type="submit" disabled={!canSteer}>
              Steer
            </button>
          </form>
        </div>
      )}
    </div>
  );
}

function ArchiveContextMenu({
  target,
  onArchive,
}: {
  target: ContextMenuTarget;
  onArchive: () => void;
}): React.ReactElement {
  const left = Math.max(8, Math.min(target.x, window.innerWidth - 188));
  const top = Math.max(8, Math.min(target.y, window.innerHeight - 54));
  return (
    <div
      className="voice-context-menu"
      role="menu"
      style={{ left, top }}
      onClick={(event) => event.stopPropagation()}
    >
      <button role="menuitem" onClick={onArchive}>
        {target.kind === "project" ? "Archive project" : "Archive chat"}
      </button>
    </div>
  );
}

function ArchivedDialog({
  projects,
  chats,
  onClose,
  onRestoreProject,
  onRestoreChat,
}: {
  projects: VoiceProject[];
  chats: ArchivedChat[];
  onClose: () => void;
  onRestoreProject: (projectId: string) => Promise<void>;
  onRestoreChat: (projectId: string, chatId: string) => Promise<void>;
}): React.ReactElement {
  const empty = projects.length === 0 && chats.length === 0;
  return (
    <div className="voice-modal-backdrop" role="presentation">
      <section className="voice-dialog archived-dialog" aria-label="Archived">
        <div className="voice-dialog-header">
          <h2>Archived</h2>
          <button type="button" aria-label="Close" onClick={onClose}>
            <CloseIcon />
          </button>
        </div>

        {empty ? (
          <p className="browse-empty">Archived chats and projects will appear here.</p>
        ) : (
          <div className="archived-sections">
            {projects.length > 0 && (
              <section className="archived-section">
                <h3>Projects</h3>
                <div className="archived-list">
                  {projects.map((project) => (
                    <article key={project.id} className="archived-row">
                      <FolderIcon />
                      <span>
                        <strong>{project.displayName}</strong>
                        <small>{project.archivedAt ? formatProjectTime(project.archivedAt) : "Archived"}</small>
                      </span>
                      <button type="button" onClick={() => void onRestoreProject(project.id)}>
                        Restore
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            )}

            {chats.length > 0 && (
              <section className="archived-section">
                <h3>Chats</h3>
                <div className="archived-list">
                  {chats.map(({ projectId, projectName, chat }) => (
                    <article key={chat.id} className="archived-row">
                      <span className="chat-status-dot idle" />
                      <span>
                        <strong>{chat.displayName}</strong>
                        <small>
                          {projectName}
                          <span className="voice-meta-dot">.</span>
                          {chat.archivedAt ? formatProjectTime(chat.archivedAt) : "Archived"}
                        </small>
                      </span>
                      <button type="button" onClick={() => void onRestoreChat(projectId, chat.id)}>
                        Restore
                      </button>
                    </article>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </section>
    </div>
  );
}

function ErrorOverlay({
  message,
  onDismiss,
}: {
  message: string;
  onDismiss: () => void;
}): React.ReactElement {
  return (
    <div className="error-overlay" role="alert" aria-live="assertive">
      <p>{message}</p>
      <button type="button" aria-label="Dismiss error" onClick={onDismiss}>
        <CloseIcon />
      </button>
    </div>
  );
}

function DebugDashboard({
  state,
  events,
  error,
  projectName,
  message,
  steer,
  setProjectName,
  setMessage,
  setSteer,
  onDismissError,
  onAction,
  onClearEvents,
  onRefresh,
  onLogEvent,
}: {
  state: AppState;
  events: AppEvent[];
  error: string | null;
  projectName: string;
  message: string;
  steer: string;
  setProjectName: React.Dispatch<React.SetStateAction<string>>;
  setMessage: React.Dispatch<React.SetStateAction<string>>;
  setSteer: React.Dispatch<React.SetStateAction<string>>;
  onDismissError: () => void;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
  onClearEvents: () => Promise<void>;
  onRefresh: () => Promise<void>;
  onLogEvent: (event: AppEvent) => Promise<void>;
}): React.ReactElement {
  const projects = state.projects;
  const activeProject = state.activeProject;
  const activeProjectId = state.runtime.activeProjectId;
  const activeFolder = activeProject?.workspacePath ?? "No active project.";
  const activeChatName =
    (activeProject?.chats ?? []).find((chat) => chat.id === state.runtime.activeChatId && !chat.archivedAt)
      ?.displayName ?? "none";
  const effectiveNextModel =
    state.codexSettings.nextTurnModel ??
    state.codexSettings.chatModel ??
    state.codexSettings.defaultModel ??
    DEFAULT_CODEX_MODEL;
  const effectiveNextEffort =
    state.codexSettings.nextTurnReasoningEffort ??
    state.codexSettings.chatReasoningEffort ??
    state.codexSettings.defaultReasoningEffort ??
    DEFAULT_CODEX_REASONING_EFFORT;
  const [replaySessions, setReplaySessions] = useState<ReplaySessionMetadata[]>([]);
  const [selectedReplay, setSelectedReplay] = useState<ReplaySessionLoadResult | null>(null);
  const [replayCursor, setReplayCursor] = useState(100);
  const [replayPlaying, setReplayPlaying] = useState(false);
  const [replaySpeed, setReplaySpeed] = useState(1);
  const [selectedEvent, setSelectedEvent] = useState<AppEvent | null>(null);
  const activeReplay = state.replay.active;
  const replayProjectId = activeProject?.id ?? activeReplay?.projectId ?? null;
  const replaySourceEvents = selectedReplay?.events ?? events;
  const orderedReplayEvents = useMemo(() => sortReplayEvents(replaySourceEvents), [replaySourceEvents]);
  const replayBounds = replayTimelineBounds(orderedReplayEvents);
  const replayCursorMs = replayCursorMsFromPercent(replayBounds, replayCursor);
  const replayFrame = useMemo(
    () => replayFrameAt(orderedReplayEvents, replayCursorMs),
    [orderedReplayEvents, replayCursorMs],
  );
  const replayModeLabel = selectedReplay ? selectedReplay.metadata.name : "Live buffer";

  useEffect(() => {
    let cancelled = false;
    if (!replayProjectId) {
      setReplaySessions([]);
      setSelectedReplay(null);
      return undefined;
    }
    void window.codexVoice.listReplaySessions(replayProjectId).then((sessions) => {
      if (!cancelled) setReplaySessions(sessions);
    });
    return () => {
      cancelled = true;
    };
  }, [replayProjectId, activeReplay?.id, activeReplay?.stoppedAt]);

  useEffect(() => {
    if (!replayPlaying || orderedReplayEvents.length <= 1) return undefined;
    const timer = window.setInterval(() => {
      setReplayCursor((current) => {
        const next = Math.min(100, current + replaySpeed);
        if (next >= 100) setReplayPlaying(false);
        return next;
      });
    }, 160);
    return () => window.clearInterval(timer);
  }, [orderedReplayEvents.length, replayPlaying, replaySpeed]);

  async function refreshReplaySessions(): Promise<void> {
    if (!replayProjectId) {
      setReplaySessions([]);
      return;
    }
    setReplaySessions(await window.codexVoice.listReplaySessions(replayProjectId));
  }

  async function loadReplay(session: ReplaySessionMetadata | null): Promise<void> {
    setReplayPlaying(false);
    setReplayCursor(100);
    setSelectedEvent(null);
    if (!session) {
      setSelectedReplay(null);
      return;
    }
    setSelectedReplay(await window.codexVoice.loadReplaySession(session.projectId, session.id));
  }

  return (
    <main className="debug-shell app-shell">
      <header className="topbar">
        <div>
          <h1>Codex Voice Debug</h1>
          <p>Voice is the front door. Codex owns the computer work.</p>
        </div>
        <div className="status-stack">
          <StatusPill label={state.runtime.ready ? "Codex ready" : "Codex starting"} tone={state.runtime.ready ? "good" : "warn"} />
          <StatusPill label={`Next: ${effectiveNextModel} / ${effectiveNextEffort}`} tone="muted" />
          <StatusPill label="Voice in main window" tone="muted" />
        </div>
      </header>

      {error && <ErrorOverlay message={error} onDismiss={onDismissError} />}

      <section className="workspace-bar">
        <div>
          <span className="label">Base folder</span>
          <code>{state.baseFolder || "Loading..."}</code>
        </div>
        <div>
          <span className="label">Workspace</span>
          <code>{activeFolder}</code>
        </div>
      </section>

      <ReplayTimelinePanel
        activeReplay={activeReplay}
        sessions={replaySessions}
        selectedReplay={selectedReplay}
        replayModeLabel={replayModeLabel}
        events={orderedReplayEvents}
        frame={replayFrame}
        bounds={replayBounds}
        cursor={replayCursor}
        playing={replayPlaying}
        speed={replaySpeed}
        selectedEvent={selectedEvent}
        onCursorChange={setReplayCursor}
        onPlayingChange={setReplayPlaying}
        onSpeedChange={setReplaySpeed}
        onSelectEvent={setSelectedEvent}
        onLoadReplay={(session) => void onAction(() => loadReplay(session))}
        onStartRecording={() =>
          void onAction(async () => {
            await window.codexVoice.startReplayRecording();
            await refreshReplaySessions();
          })
        }
        onStopRecording={() =>
          void onAction(async () => {
            await window.codexVoice.stopReplayRecording();
            await refreshReplaySessions();
          })
        }
        onRenameReplay={(session) =>
          void onAction(async () => {
            const name = window.prompt("Replay name", session.name);
            if (!name || !name.trim()) return;
            const updated = await window.codexVoice.renameReplaySession(session.projectId, session.id, name);
            if (selectedReplay?.metadata.id === updated.id) {
              setSelectedReplay(await window.codexVoice.loadReplaySession(updated.projectId, updated.id));
            }
            await refreshReplaySessions();
          })
        }
        onDeleteReplay={(session) =>
          void onAction(async () => {
            if (!window.confirm(`Delete replay "${session.name}"? This removes the local raw event recording.`)) return;
            await window.codexVoice.deleteReplaySession(session.projectId, session.id);
            if (selectedReplay?.metadata.id === session.id) await loadReplay(null);
            await refreshReplaySessions();
          })
        }
        onDeleteAll={() =>
          void onAction(async () => {
            if (!replayProjectId) return;
            if (!window.confirm("Delete all replays for this project? This removes local raw event recordings.")) return;
            await window.codexVoice.deleteAllReplaySessions(replayProjectId);
            await loadReplay(null);
            await refreshReplaySessions();
          })
        }
      />

      <section className="grid">
        <aside className="panel projects-panel">
          <div className="panel-header">
            <h2>Projects</h2>
            <button onClick={() => void onRefresh()}>Refresh</button>
          </div>
          <div className="new-project-row">
            <input
              value={projectName}
              onChange={(event) => setProjectName(event.target.value)}
              placeholder="Project name"
            />
            <button
              className="primary"
              onClick={() =>
                void onAction(async () => {
                  await window.codexVoice.createProject(projectName || undefined);
                  setProjectName("");
                })
              }
            >
              New project
            </button>
          </div>
          <div className="project-list">
            {projects.map((project) => (
              <button
                key={project.id}
                className={`project-card ${project.id === activeProjectId ? "active" : ""}`}
                onClick={() => void onAction(() => window.codexVoice.resumeProject(project.id))}
              >
                <strong>{project.displayName}</strong>
                <span>{new Date(project.updatedAt).toLocaleString()}</span>
                <small>{project.lastStatus ?? "No status yet."}</small>
              </button>
            ))}
            {projects.length === 0 && <p className="empty">No voice projects yet.</p>}
          </div>
        </aside>

        <section className="panel command-panel">
          <div className="panel-header">
            <h2>Codex Control</h2>
          </div>
          <p className="help">
            {state.realtime.available
              ? `Realtime voice is controlled from the main Codex Voice window. Model: ${state.realtime.model}, voice: ${state.realtime.voice}, reasoning: ${state.realtime.reasoningEffort ?? "none"}.`
              : state.realtime.reason}
          </p>

          <div className="status-card">
            <span className="label">Codex status</span>
            <strong>{state.runtime.status}</strong>
            <small>
              Chat: {activeChatName} | Thread: {activeProject?.codexThreadId ?? "none"} | Turn:{" "}
              {state.runtime.activeTurnId ?? "none"}
            </small>
            <small>
              Thread state: {state.runtime.threadStatus ?? "unknown"} | Context:{" "}
              {formatTokenUsage(state.runtime.tokenUsage)}
            </small>
          </div>

          <CodexSettingsPanel state={state} onAction={onAction} />
          <NativeSlashPanel />

          <label className="stacked-input">
            Send request to Codex or native slash command
            <textarea
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder="Type a request, /status, /model, /model next gpt-5.5 high, /review, /compact, /mcp verbose..."
            />
          </label>
          <div className="button-row">
            <button
              className="primary"
              onClick={() =>
                void onAction(async () => {
                  await window.codexVoice.sendToCodex(message);
                  setMessage("");
                })
              }
            >
              Send
            </button>
            <button
              onClick={() =>
                void onAction(async () => {
                  const summary = await window.codexVoice.summarizeProject(activeProject?.id);
                  await onLogEvent({
                    at: new Date().toISOString(),
                    source: "app",
                    kind: "summary",
                    message: summary,
                  });
                })
              }
            >
              Summarize Active
            </button>
            <button className="danger" onClick={() => void onAction(() => window.codexVoice.interruptCodex())}>
              Interrupt
            </button>
          </div>

          <label className="stacked-input compact">
            Steer active turn
            <div className="inline-form">
              <input
                value={steer}
                onChange={(event) => setSteer(event.target.value)}
                placeholder="Actually, use the PDF from yesterday..."
              />
              <button
                onClick={() =>
                  void onAction(async () => {
                    await window.codexVoice.steerCodex(steer);
                    setSteer("");
                  })
                }
              >
                Steer
              </button>
            </div>
          </label>
        </section>

        <section className="panel approvals-panel">
          <div className="panel-header">
            <h2>Approvals / Questions</h2>
            <span>{state.runtime.pendingRequests.length}</span>
          </div>
          <p className="help">Voice can answer with allow, allow for this session, decline, or cancel.</p>
          {state.runtime.pendingRequests.length === 0 ? (
            <p className="empty">Nothing waiting on the user.</p>
          ) : (
            state.runtime.pendingRequests.map((request) => (
              <PendingRequestCard key={String(request.requestId)} request={request} onAction={onAction} />
            ))
          )}
        </section>

        <section className="panel event-panel">
          <div className="panel-header">
            <h2>{selectedReplay ? "Replay Events" : "Event Log"}</h2>
            <button onClick={() => void onClearEvents()}>Clear</button>
          </div>
          <p className="help">
            {selectedReplay
              ? `Scrubbing ${replayFrame.events.length} of ${orderedReplayEvents.length} recorded events.`
              : `Showing the live in-memory buffer; this is not persisted unless recording is active.`}
          </p>
          <div className="event-list">
            {[...replayFrame.events].reverse().map((event, index) => (
              <article key={`${event.at}-${index}`} className={`event ${event.source}`}>
                <div>
                  <strong>{event.kind}</strong>
                  <span>{event.source}</span>
                  <time>{new Date(event.at).toLocaleTimeString()}</time>
                </div>
                <p>{event.message}</p>
              </article>
            ))}
            {replayFrame.events.length === 0 && <p className="empty">No events yet.</p>}
          </div>
        </section>
      </section>
    </main>
  );
}

function ReplayTimelinePanel({
  activeReplay,
  sessions,
  selectedReplay,
  replayModeLabel,
  events,
  frame,
  bounds,
  cursor,
  playing,
  speed,
  selectedEvent,
  onCursorChange,
  onPlayingChange,
  onSpeedChange,
  onSelectEvent,
  onLoadReplay,
  onStartRecording,
  onStopRecording,
  onRenameReplay,
  onDeleteReplay,
  onDeleteAll,
}: {
  activeReplay: ReplaySessionMetadata | null;
  sessions: ReplaySessionMetadata[];
  selectedReplay: ReplaySessionLoadResult | null;
  replayModeLabel: string;
  events: AppEvent[];
  frame: ReturnType<typeof replayFrameAt>;
  bounds: ReplayTimelineBounds;
  cursor: number;
  playing: boolean;
  speed: number;
  selectedEvent: AppEvent | null;
  onCursorChange: (value: number) => void;
  onPlayingChange: (value: boolean) => void;
  onSpeedChange: (value: number) => void;
  onSelectEvent: (event: AppEvent | null) => void;
  onLoadReplay: (session: ReplaySessionMetadata | null) => void;
  onStartRecording: () => void;
  onStopRecording: () => void;
  onRenameReplay: (session: ReplaySessionMetadata) => void;
  onDeleteReplay: (session: ReplaySessionMetadata) => void;
  onDeleteAll: () => void;
}): React.ReactElement {
  const selectedReplayId = selectedReplay?.metadata.id ?? "live";
  const cursorTime = frame.cursorAt ? new Date(frame.cursorAt).toLocaleTimeString() : "No cursor";
  const duration = bounds.minMs !== null && bounds.maxMs !== null ? formatReplayDuration(bounds.maxMs - bounds.minMs) : "0s";
  const activeMatchesSelected = activeReplay && selectedReplay?.metadata.id === activeReplay.id;
  return (
    <section className="panel replay-panel">
      <div className="panel-header">
        <div>
          <h2>Replay Timeline</h2>
          <p>{replayModeLabel} / {duration}</p>
        </div>
        <div className="button-row wrap">
          {activeReplay ? (
            <button type="button" className="danger" onClick={onStopRecording}>
              Stop Recording
            </button>
          ) : (
            <button type="button" className="primary" onClick={onStartRecording}>
              Start Recording
            </button>
          )}
          <button type="button" className="danger" disabled={sessions.length === 0 || Boolean(activeReplay)} onClick={onDeleteAll}>
            Delete All
          </button>
        </div>
      </div>

      <div className="replay-toolbar">
        <label>
          <span>Replay</span>
          <select
            value={selectedReplayId}
            onChange={(event) => {
              const value = event.target.value;
              onLoadReplay(value === "live" ? null : sessions.find((session) => session.id === value) ?? null);
            }}
          >
            <option value="live">Live buffer (not persisted)</option>
            {sessions.map((session) => (
              <option key={session.id} value={session.id}>
                {session.name} ({session.eventCount})
              </option>
            ))}
          </select>
        </label>
        <div className={`replay-recording-indicator ${activeReplay ? "active" : ""}`}>
          <span aria-hidden="true" />
          {activeReplay ? `Recording ${activeReplay.eventCount} events` : "Recording off"}
        </div>
        {selectedReplay && (
          <div className="button-row wrap">
            <button type="button" onClick={() => onRenameReplay(selectedReplay.metadata)}>
              Rename
            </button>
            <button type="button" className="danger" disabled={Boolean(activeMatchesSelected)} onClick={() => onDeleteReplay(selectedReplay.metadata)}>
              Delete
            </button>
          </div>
        )}
      </div>

      <div className="replay-controls">
        <button type="button" disabled={events.length === 0} onClick={() => onPlayingChange(!playing)}>
          {playing ? "Pause" : "Play"}
        </button>
        <button type="button" disabled={events.length === 0} onClick={() => onCursorChange(100)}>
          Jump Live
        </button>
        <label>
          <span>Speed</span>
          <select value={speed} onChange={(event) => onSpeedChange(Number(event.target.value) || 1)}>
            <option value={0.5}>0.5x</option>
            <option value={1}>1x</option>
            <option value={2}>2x</option>
            <option value={4}>4x</option>
          </select>
        </label>
        <strong>{cursorTime}</strong>
      </div>

      <div className="replay-scrubber">
        <input
          type="range"
          min={0}
          max={100}
          step={0.1}
          value={cursor}
          disabled={events.length === 0}
          onChange={(event) => {
            onPlayingChange(false);
            onSelectEvent(null);
            onCursorChange(Number(event.target.value));
          }}
          aria-label="Replay timeline"
        />
        <div className="replay-ticks">
          {events.slice(-220).map((event, index) => (
            <button
              key={`${event.at}-${event.kind}-${index}`}
              type="button"
              className={`replay-tick ${classifyReplayEvent(event)}`}
              style={{ left: `${eventPercent(event, bounds)}%` }}
              title={`${event.source} ${event.kind}`}
              onClick={() => {
                onPlayingChange(false);
                onCursorChange(eventPercent(event, bounds));
                onSelectEvent(event);
              }}
            />
          ))}
        </div>
      </div>

      <div className="replay-frame-grid">
        <ReplayMetric label="Status" value={frame.latestStatus} />
        <ReplayMetric label="Events" value={`${frame.events.length} / ${events.length}`} />
        <ReplayMetric label="Tools" value={String(frame.toolCallCount)} />
        <ReplayMetric label="Approvals" value={String(frame.pendingApprovalCount)} />
        <ReplayMetric label="Subagents" value={String(frame.subagentCount)} />
        <ReplayMetric label="Errors" value={String(frame.errorCount)} />
      </div>

      <div className="replay-detail-grid">
        <section>
          <h3>Transcript At Cursor</h3>
          <pre>{frame.transcriptText || "No completed transcript events at this point."}</pre>
        </section>
        <section>
          <h3>Raw Event</h3>
          <pre>{JSON.stringify(selectedEvent ?? frame.currentEvent ?? null, null, 2)}</pre>
        </section>
      </div>
    </section>
  );
}

function ReplayMetric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="replay-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

type ReplayTimelineBounds = {
  minMs: number | null;
  maxMs: number | null;
};

function replayTimelineBounds(events: AppEvent[]): ReplayTimelineBounds {
  const times = events
    .map((event) => Date.parse(event.at))
    .filter((value) => Number.isFinite(value));
  if (times.length === 0) return { minMs: null, maxMs: null };
  return {
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
  };
}

function replayCursorMsFromPercent(bounds: ReplayTimelineBounds, percent: number): number | null {
  if (bounds.minMs === null || bounds.maxMs === null) return null;
  if (bounds.minMs === bounds.maxMs) return bounds.maxMs;
  const clamped = Math.min(100, Math.max(0, percent));
  return bounds.minMs + ((bounds.maxMs - bounds.minMs) * clamped) / 100;
}

function eventPercent(event: AppEvent, bounds: ReplayTimelineBounds): number {
  if (bounds.minMs === null || bounds.maxMs === null || bounds.minMs === bounds.maxMs) return 100;
  const parsed = Date.parse(event.at);
  if (!Number.isFinite(parsed)) return 100;
  return Math.min(100, Math.max(0, ((parsed - bounds.minMs) / (bounds.maxMs - bounds.minMs)) * 100));
}

function formatReplayDuration(durationMs: number): string {
  const seconds = Math.max(0, Math.round(durationMs / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function voiceStateLabel(
  state: AppState,
  voiceConnected: boolean,
  voiceConnecting: boolean,
  voicePaused: boolean,
): { label: string; tone: VoiceTone } {
  if (!state.realtime.available) return { label: "API key needed", tone: "off" };
  if (voiceConnecting) return { label: "Connecting", tone: "connecting" };
  if (state.runtime.pendingRequests.length > 0) return { label: "Needs input", tone: "waiting" };
  if (voiceConnected && voicePaused && state.runtime.activeTurnId) {
    return { label: "Working, voice paused", tone: "paused" };
  }
  if (voiceConnected && voicePaused) return { label: "Voice paused", tone: "paused" };
  if (state.runtime.activeTurnId) return { label: "Working", tone: "working" };
  if (voiceConnected) return { label: "Listening", tone: "listening" };
  return { label: "Voice off", tone: "off" };
}

function voiceOrbAriaLabel(
  state: AppState,
  voiceConnected: boolean,
  voiceConnecting: boolean,
  voicePaused: boolean,
): string {
  if (!state.realtime.available) return "Set up OpenAI API key";
  if (voiceConnecting) return "Voice connecting";
  if (state.runtime.pendingRequests.length > 0) return "Respond to pending Codex request";
  if (voiceConnected && voicePaused && state.runtime.activeTurnId) {
    return "Resume voice while Codex keeps working";
  }
  if (voiceConnected && voicePaused) return "Resume voice";
  if (voiceConnected && state.runtime.activeTurnId) return "Pause voice while Codex keeps working";
  if (voiceConnected) return "Pause voice";
  return "Start voice";
}

function chatSummariesForProject(project: VoiceProject | null, state: AppState): ChatSummary[] {
  if (!project) return [];
  return (project.chats ?? []).filter((chat) => !chat.archivedAt).map((chat) => {
    const runtime = (state.runtime.chats ?? []).find((candidate) => candidate.chatId === chat.id);
    const waiting = Boolean(runtime?.pendingRequests.length);
    const working = Boolean(runtime?.activeTurnId);
    return {
      id: chat.id,
      title: chat.displayName,
      detail: runtime?.status ?? chat.lastStatus ?? "Idle",
      tone: waiting ? "waiting" : working ? "active" : "idle",
      active: chat.id === state.runtime.activeChatId,
      subagents: subagentsForChat(chat),
    };
  });
}

function subagentsForChat(chat: VoiceChat): ChatSubagentSummary[] {
  const summaries = new Map<string, ChatSubagentSummary>();

  for (const subagent of chat.subagents ?? []) {
    summaries.set(subagent.threadId, {
      id: subagent.id,
      parentTitle: chat.displayName,
      title: subagent.displayName,
      threadId: subagent.threadId,
      detail: subagent.status ?? "Child thread",
      tone: subagentTone(subagent.status),
    });
  }

  for (const item of chat.lastTurnOutput?.items ?? []) {
    const record = recordFromUnknown(item);
    if (!record || !isSubagentItem(record)) continue;
    const threadId =
      stringFromUnknown(record.newThreadId) ??
      stringFromUnknown(record.receiverThreadId) ??
      stringFromUnknown(record.threadId);
    if (!threadId || summaries.has(threadId)) continue;
    const status = stringFromUnknown(record.agentStatus) ?? stringFromUnknown(record.status);
    summaries.set(threadId, {
      id: stringFromUnknown(record.id) ?? `subagent:${threadId}`,
      parentTitle: chat.displayName,
      title: stringFromUnknown(record.name) ?? stringFromUnknown(record.agentName) ?? "Subagent",
      threadId,
      detail: status ?? stringFromUnknown(record.prompt) ?? "Child thread",
      tone: subagentTone(status),
    });
  }

  return [...summaries.values()];
}

function isSubagentItem(record: Record<string, unknown>): boolean {
  const type = stringFromUnknown(record.type)
    ?.replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
  return [
    "collab-agent-tool-call",
    "collab-tool-call",
    "multi-agent-action",
    "remote-task-created",
    "worked-for",
    "sub-agent",
  ].includes(type ?? "");
}

function subagentTone(status: string | null): ChatSubagentSummary["tone"] {
  const normalized = status?.toLowerCase() ?? "";
  if (normalized.includes("waiting") || normalized.includes("pending")) return "waiting";
  if (normalized.includes("active") || normalized.includes("running") || normalized.includes("working")) return "active";
  return "idle";
}

function selectedSubagentForSummaries(
  chats: ChatSummary[],
  selectedSubagentId: string | null,
): ChatSubagentSummary | null {
  if (!selectedSubagentId) return null;
  for (const chat of chats) {
    const subagent = chat.subagents.find((candidate) => candidate.id === selectedSubagentId);
    if (subagent) return subagent;
  }
  return null;
}

function archivedChatsForProjects(projects: VoiceProject[]): ArchivedChat[] {
  return projects.flatMap((project) =>
    (project.chats ?? [])
      .filter((chat) => chat.archivedAt)
      .map((chat) => ({
        projectId: project.id,
        projectName: project.displayName,
        chat,
      })),
  );
}

function realtimeHealth(
  realtime: AppState["realtime"],
  realtimeIssue: string | null,
): { ok: boolean; message: string } {
  if (!realtime.available) {
    return {
      ok: false,
      message: "No OpenAI API key is configured. Add a key here, then save it to enable voice.",
    };
  }
  if (realtimeIssue) {
    return {
      ok: false,
      message: friendlyRealtimeIssue(realtimeIssue),
    };
  }
  return { ok: true, message: "Realtime API key is ready." };
}

function apiKeyInputPlaceholder(realtime: AppState["realtime"]): string {
  if (realtime.apiKeySource === "environment") return "OPENAI_API_KEY is set";
  if (realtime.apiKeySource === "saved") return "Paste a replacement key";
  return "sk-...";
}

function apiKeyStorageTitle(realtime: AppState["realtime"]): string {
  if (realtime.apiKeySource === "environment") return "Environment key active";
  if (realtime.apiKeySource === "saved") {
    return realtime.apiKeyEncrypted ? "Saved key encrypted" : "Saved key active";
  }
  return "No key configured";
}

function apiKeyStorageDetail(realtime: AppState["realtime"]): string {
  if (realtime.apiKeySource === "environment") {
    return "Loaded by main from OPENAI_API_KEY. Remove it from the environment to use a saved key.";
  }
  if (realtime.apiKeySource === "saved") {
    return realtime.apiKeyEncrypted
      ? "Stored with Electron safeStorage. Paste a new key here to replace it."
      : "Stored locally without safeStorage encryption on this machine.";
  }
  return "Paste a key once. After saving, this window cannot read it back.";
}

function friendlyRealtimeIssue(issue: string): string {
  const message = openAiErrorMessage(issue);
  const haystack = `${issue} ${message ?? ""}`.toLowerCase();

  if (
    haystack.includes("insufficient_quota") ||
    haystack.includes("quota") ||
    haystack.includes("billing") ||
    haystack.includes("credits")
  ) {
    return "OpenAI rejected the Realtime session because the account is out of quota or billing is not active. Check credits or billing, then try again.";
  }
  if (haystack.includes("invalid_api_key") || haystack.includes("incorrect api key") || haystack.includes("401")) {
    return "OpenAI rejected this API key. Check that it is copied correctly and still active.";
  }
  if (haystack.includes("permission") || haystack.includes("forbidden") || haystack.includes("403")) {
    return "This key does not appear to have access to Realtime sessions. Check the project permissions or use another key.";
  }
  if (haystack.includes("network") || haystack.includes("failed to fetch") || haystack.includes("fetch failed")) {
    return "Codex Voice could not reach OpenAI. Check the network connection, then try again.";
  }
  if (message) {
    return `OpenAI reported: ${message}`;
  }
  return `Realtime voice could not start. ${shortenStatus(issue)}`;
}

function friendlyRealtimeSettingsError(error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("No handler registered") && message.includes("realtime:setSettings")) {
    return new Error(
      "Codex Voice main process is still running an older build. Restart Codex Voice, then choose the Realtime settings again.",
    );
  }
  return error instanceof Error ? error : new Error(message);
}

function openAiErrorMessage(issue: string): string | null {
  const jsonStart = issue.indexOf("{");
  if (jsonStart < 0) return null;
  try {
    const parsed = JSON.parse(issue.slice(jsonStart)) as {
      error?: { message?: unknown };
    };
    return typeof parsed.error?.message === "string" ? parsed.error.message : null;
  } catch {
    return null;
  }
}

function shortenStatus(value: string): string {
  return value.replace(/^Realtime session creation failed:\s*/i, "").slice(0, 220);
}

function formatProjectTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Unknown time";

  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDate = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDelta = Math.round((startOfToday.getTime() - startOfDate.getTime()) / 86_400_000);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (dayDelta === 0) return `Today, ${time}`;
  if (dayDelta === 1) return `Yesterday, ${time}`;
  return date.toLocaleDateString([], { month: "short", day: "numeric" }) + `, ${time}`;
}

function formatModelName(model: string | null): string {
  if (!model) return "Default";
  return model.replace(/^gpt-/i, "GPT-");
}

function realtimeModelOption(model: RealtimeModelId) {
  return REALTIME_MODEL_OPTIONS.find((option) => option.model === model) ?? REALTIME_MODEL_OPTIONS[0];
}

function realtimeVoiceOption(voice: RealtimeVoiceId) {
  return REALTIME_VOICE_OPTIONS.find((option) => option.voice === voice) ?? REALTIME_VOICE_OPTIONS[0];
}

function formatRealtimeModelName(model: RealtimeModelId): string {
  return realtimeModelOption(model).displayName;
}

function realtimeModelDetail(realtime: AppState["realtime"]): string {
  const option = realtimeModelOption(realtime.model);
  if (!realtime.reasoningEffort) return option.description;
  return `${option.description}; reasoning ${formatEffort(realtime.reasoningEffort)}`;
}

function modelsForValue(models: CodexModelSummary[], value: string | null): CodexModelSummary[] {
  if (!value || models.some((model) => model.model === value)) return models;
  return [
    {
      id: value,
      model: value,
      displayName: formatModelName(value),
      description: "",
      isDefault: false,
      hidden: false,
      defaultReasoningEffort: DEFAULT_CODEX_REASONING_EFFORT,
      supportedReasoningEfforts: [],
      additionalSpeedTiers: [],
      serviceTiers: [],
    },
    ...models,
  ];
}

function supportsFastMode(model: CodexModelSummary | null): boolean {
  if (!model) return false;
  return (
    model.serviceTiers.some((tier) => tier.id === FAST_CODEX_SERVICE_TIER || tier.name.toLowerCase() === "fast") ||
    model.additionalSpeedTiers.includes("fast")
  );
}

function isFastServiceTier(value: CodexServiceTier | null | undefined): boolean {
  return value === FAST_CODEX_SERVICE_TIER || value === "fast";
}

function formatServiceTier(value: CodexServiceTier | null | undefined): string {
  return isFastServiceTier(value) ? "Fast" : "Standard";
}

function formatEffort(effort: string | null): string {
  if (!effort) return "Default";
  if (effort === "xhigh") return "Extra High";
  return effort.slice(0, 1).toUpperCase() + effort.slice(1);
}

function permissionProfile(mode: CodexPermissionMode) {
  return CODEX_PERMISSION_PROFILES.find((profile) => profile.mode === mode) ?? CODEX_PERMISSION_PROFILES[0];
}

function LightningIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="lightning-icon">
      <path d="M13.5 2.75 5.75 13.2h5.45l-.7 8.05 7.75-10.45H12.8l.7-8.05Z" />
    </svg>
  );
}

function FolderIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.75 6.75a2 2 0 0 1 2-2h4.15l2.05 2.25h6.3a2 2 0 0 1 2 2v8.25a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2V6.75Z" />
    </svg>
  );
}

function PlusIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

function DownIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="voice-chevron">
      <path d="m6.5 9 5.5 5.5L17.5 9" />
    </svg>
  );
}

function CheckIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m5.5 12.5 4.25 4.25L18.5 7.25" />
    </svg>
  );
}

function RightPaneIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.6" y="4.4" width="14.8" height="15.2" rx="3" />
      <path d="M14.4 7.2v9.6" />
    </svg>
  );
}

function RefreshIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M20 6v5h-5" />
      <path d="M4 18v-5h5" />
      <path d="M18.4 9A6.6 6.6 0 0 0 6.7 7.1L4 10" />
      <path d="M5.6 15A6.6 6.6 0 0 0 17.3 16.9L20 14" />
    </svg>
  );
}

function ArchiveIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.5 6.5h15" />
      <path d="M6.25 6.5v11.25a2 2 0 0 0 2 2h7.5a2 2 0 0 0 2-2V6.5" />
      <path d="M8.5 3.75h7a2 2 0 0 1 2 2v.75h-11v-.75a2 2 0 0 1 2-2Z" />
      <path d="M9.5 11.5h5" />
    </svg>
  );
}

function DebugIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 8.75h10" />
      <path d="M8.5 4.75h7" />
      <path d="M5.75 11.5v2.25a6.25 6.25 0 0 0 12.5 0V11.5" />
      <path d="M3.5 13h17" />
      <path d="M6.25 18.25 4.75 20" />
      <path d="m17.75 18.25 1.5 1.75" />
    </svg>
  );
}

function PowerIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.75v8" />
      <path d="M7.15 6.95A7.5 7.5 0 1 0 16.85 7" />
    </svg>
  );
}

function AppearanceIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 3.9c1.85 2.5 3.95 3.92 7.1 4.25-2.5 1.85-3.92 3.95-4.25 7.1-1.85-2.5-3.95-3.92-7.1-4.25 2.5-1.85 3.92-3.95 4.25-7.1Z" />
      <path d="M6.3 14.7c.76 1.03 1.63 1.62 2.95 1.76-1.03.76-1.62 1.63-1.76 2.95-.76-1.03-1.63-1.62-2.95-1.76 1.03-.76 1.62-1.63 1.76-2.95Z" />
    </svg>
  );
}

function PermissionIcon({ mode }: { mode: CodexPermissionMode }): React.ReactElement {
  if (mode === "default") return <DefaultPermissionsIcon />;
  if (mode === "auto-review") return <AutoReviewIcon />;
  if (mode === "custom-config") return <ConfigIcon />;
  return <FullAccessIcon />;
}

function DefaultPermissionsIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="permission-mode-icon">
      <path d="M7.85 11.75V7.05a1.34 1.34 0 0 1 2.68 0v4.25" />
      <path d="M10.53 11.1V5.75a1.34 1.34 0 0 1 2.68 0v5.4" />
      <path d="M13.21 11.35V6.55a1.34 1.34 0 0 1 2.68 0v5.25" />
      <path d="M15.89 12.2V8.35a1.3 1.3 0 0 1 2.6 0v5.35c0 4.05-2.55 6.55-6.42 6.55h-.95c-2.38 0-4-.96-5.2-2.62l-1.96-2.78a1.34 1.34 0 0 1 2.18-1.55l1.8 2.15" />
    </svg>
  );
}

function AutoReviewIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="permission-mode-icon">
      <path d="M12 3.6 18.35 6v5.35c0 4.08-2.52 6.92-6.35 8.85-3.83-1.93-6.35-4.77-6.35-8.85V6L12 3.6Z" />
      <path d="m9.45 10.25 1.9 1.75-1.9 1.75" />
      <path d="M13.15 14h2.25" />
    </svg>
  );
}

function FullAccessIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="permission-mode-icon">
      <path d="M12 3.6 18.35 6v5.35c0 4.08-2.52 6.92-6.35 8.85-3.83-1.93-6.35-4.77-6.35-8.85V6L12 3.6Z" />
      <path d="M12 8.35v4.3" />
      <path d="M12 16.15h.01" />
    </svg>
  );
}

function ConfigIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="permission-mode-icon">
      <path d="M12 9.25a2.75 2.75 0 1 1 0 5.5 2.75 2.75 0 0 1 0-5.5Z" />
      <path d="M19.35 13.7a7.9 7.9 0 0 0 .05-3.4l2.05-1.5-2-3.45-2.52 1.04a7.85 7.85 0 0 0-2.9-1.67L13.65 2h-3.3l-.38 2.72a7.85 7.85 0 0 0-2.9 1.67L4.55 5.35l-2 3.45 2.05 1.5a7.9 7.9 0 0 0 .05 3.4L2.6 15.2l2 3.45 2.47-1.02a7.85 7.85 0 0 0 2.9 1.65l.38 2.72h3.3l.38-2.72a7.85 7.85 0 0 0 2.9-1.65l2.47 1.02 2-3.45-2.05-1.5Z" />
    </svg>
  );
}

function ChevronIcon({ className }: { className?: string } = {}): React.ReactElement {
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden="true"
      className={["voice-chevron", className].filter(Boolean).join(" ")}
    >
      <path d="m9 5.5 6.5 6.5L9 18.5" />
    </svg>
  );
}

function SwitchIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 7h10l-3-3M17 17H7l3 3M17 7l-4 4M7 17l4-4" />
    </svg>
  );
}

function WaveformIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 28 24" aria-hidden="true" className="waveform-icon">
      <path d="M4 10v4M8 6v12M12 3.75v16.5M16 7v10M20 10v4M24 8.5v7" />
    </svg>
  );
}

function CloseIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m6.5 6.5 11 11M17.5 6.5l-11 11" />
    </svg>
  );
}

function InfoIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 10.75v5.5" />
      <path d="M12 7.75h.01" />
      <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18Z" />
    </svg>
  );
}

function EyeIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3.5 12s3.15-5.5 8.5-5.5 8.5 5.5 8.5 5.5-3.15 5.5-8.5 5.5S3.5 12 3.5 12Z" />
      <path d="M12 14.45a2.45 2.45 0 1 0 0-4.9 2.45 2.45 0 0 0 0 4.9Z" />
    </svg>
  );
}

function EyeOffIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m4 4 16 16" />
      <path d="M9.2 6.95A8.88 8.88 0 0 1 12 6.5c5.35 0 8.5 5.5 8.5 5.5a14.7 14.7 0 0 1-2.7 3.24" />
      <path d="M14.15 14.3a2.45 2.45 0 0 1-3.45-3.45" />
      <path d="M6.2 8.7A14.7 14.7 0 0 0 3.5 12s3.15 5.5 8.5 5.5c1.02 0 1.96-.2 2.8-.54" />
    </svg>
  );
}

function CodexSettingsPanel({
  state,
  onAction,
}: {
  state: AppState;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  const efforts: ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];
  const models = state.codexSettings.models;
  const chatModel = state.codexSettings.chatModel ?? "";
  const nextTurnModel = state.codexSettings.nextTurnModel ?? "";
  const chatEffort = state.codexSettings.chatReasoningEffort ?? "";
  const nextTurnEffort = state.codexSettings.nextTurnReasoningEffort ?? "";
  const chatServiceTier = state.codexSettings.chatServiceTier ?? "";
  const nextTurnServiceTier = state.codexSettings.nextTurnServiceTier ?? "";
  const chatPermissionMode = state.codexSettings.chatPermissionMode;
  const nextTurnPermissionMode = state.codexSettings.nextTurnPermissionMode ?? "";
  const chatModelOptions = modelsForValue(models, chatModel);
  const nextTurnModelOptions = modelsForValue(models, nextTurnModel);

  return (
    <section className="settings-panel">
      <div className="settings-grid">
        <SettingReadout
          label="Default"
          model={state.codexSettings.defaultModel ?? "unknown"}
          effort={state.codexSettings.defaultReasoningEffort ?? "unknown"}
          speed={formatServiceTier(state.codexSettings.defaultServiceTier)}
          permission={permissionProfile(state.codexSettings.defaultPermissionMode).displayName}
        />
        <SettingReadout
          label="Chat"
          model={state.codexSettings.chatModel ?? "default"}
          effort={state.codexSettings.chatReasoningEffort ?? "default"}
          speed={formatServiceTier(state.codexSettings.chatServiceTier)}
          permission={permissionProfile(state.codexSettings.chatPermissionMode).displayName}
        />
        <SettingReadout
          label="Next Turn"
          model={state.codexSettings.nextTurnModel ?? "chat/default"}
          effort={state.codexSettings.nextTurnReasoningEffort ?? "chat/default"}
          speed={
            state.codexSettings.nextTurnServiceTier
              ? formatServiceTier(state.codexSettings.nextTurnServiceTier)
              : "chat/default"
          }
          permission={
            state.codexSettings.nextTurnPermissionMode
              ? permissionProfile(state.codexSettings.nextTurnPermissionMode).displayName
              : "chat/default"
          }
        />
        <SettingReadout
          label="Active Turn"
          model={state.codexSettings.activeTurnModel ?? "none"}
          effort={state.codexSettings.activeTurnReasoningEffort ?? "none"}
          speed={
            state.codexSettings.activeTurnServiceTier
              ? formatServiceTier(state.codexSettings.activeTurnServiceTier)
              : "none"
          }
          permission={
            state.codexSettings.activeTurnPermissionMode
              ? permissionProfile(state.codexSettings.activeTurnPermissionMode).displayName
              : "none"
          }
        />
      </div>

      <div className="settings-controls">
        <label>
          Chat model
          <select
            value={chatModel}
            disabled={!state.activeProject}
            onChange={(event) =>
              void onAction(() =>
                window.codexVoice.setCodexSettings({ model: event.target.value || null }, "chat"),
              )
            }
          >
            <option value="">Default ({state.codexSettings.defaultModel ?? "unknown"})</option>
            {chatModelOptions.map((model) => (
              <option key={model.id} value={model.model}>
                {model.displayName} ({model.model})
              </option>
            ))}
          </select>
        </label>

        <label>
          Chat effort
          <select
            value={chatEffort}
            disabled={!state.activeProject}
            onChange={(event) =>
              void onAction(() =>
                window.codexVoice.setCodexSettings(
                  { reasoningEffort: (event.target.value || null) as ReasoningEffort | null },
                  "chat",
                ),
              )
            }
          >
            <option value="">Default ({state.codexSettings.defaultReasoningEffort ?? "unknown"})</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>

        <label>
          Chat speed
          <select
            value={chatServiceTier}
            disabled={!state.activeProject}
            onChange={(event) =>
              void onAction(() =>
                window.codexVoice.setCodexSettings(
                  { serviceTier: (event.target.value || null) as CodexServiceTier | null },
                  "chat",
                ),
              )
            }
          >
            <option value="">Standard</option>
            <option value={FAST_CODEX_SERVICE_TIER}>Fast</option>
          </select>
        </label>

        <label>
          Chat permissions
          <select
            value={chatPermissionMode}
            disabled={!state.activeProject}
            onChange={(event) =>
              void onAction(() =>
                window.codexVoice.setCodexSettings(
                  { permissionMode: event.target.value as CodexPermissionMode },
                  "chat",
                ),
              )
            }
          >
            {CODEX_PERMISSION_PROFILES.map((profile) => (
              <option key={profile.mode} value={profile.mode}>
                {profile.displayName}
              </option>
            ))}
          </select>
        </label>

        <label>
          Next-turn model
          <select
            value={nextTurnModel}
            onChange={(event) =>
              void onAction(() =>
                window.codexVoice.setCodexSettings({ model: event.target.value || null }, "nextTurn"),
              )
            }
          >
            <option value="">Use chat/default</option>
            {nextTurnModelOptions.map((model) => (
              <option key={model.id} value={model.model}>
                {model.displayName} ({model.model})
              </option>
            ))}
          </select>
        </label>

        <label>
          Next-turn effort
          <select
            value={nextTurnEffort}
            onChange={(event) =>
              void onAction(() =>
                window.codexVoice.setCodexSettings(
                  { reasoningEffort: (event.target.value || null) as ReasoningEffort | null },
                  "nextTurn",
                ),
              )
            }
          >
            <option value="">Use chat/default</option>
            {efforts.map((effort) => (
              <option key={effort} value={effort}>
                {effort}
              </option>
            ))}
          </select>
        </label>

        <label>
          Next-turn speed
          <select
            value={nextTurnServiceTier}
            onChange={(event) =>
              void onAction(() =>
                window.codexVoice.setCodexSettings(
                  { serviceTier: (event.target.value || null) as CodexServiceTier | null },
                  "nextTurn",
                ),
              )
            }
          >
            <option value="">Use chat/default</option>
            <option value={FAST_CODEX_SERVICE_TIER}>Fast</option>
          </select>
        </label>

        <label>
          Next-turn permissions
          <select
            value={nextTurnPermissionMode}
            onChange={(event) =>
              void onAction(() =>
                window.codexVoice.setCodexSettings(
                  { permissionMode: (event.target.value || null) as CodexPermissionMode | null },
                  "nextTurn",
                ),
              )
            }
          >
            <option value="">Use chat/default</option>
            {CODEX_PERMISSION_PROFILES.map((profile) => (
              <option key={profile.mode} value={profile.mode}>
                {profile.displayName}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}

function SettingReadout({
  label,
  model,
  effort,
  speed,
  permission,
}: {
  label: string;
  model: string;
  effort: string;
  speed: string;
  permission: string;
}): React.ReactElement {
  return (
    <div className="setting-readout">
      <span>{label}</span>
      <strong>{model}</strong>
      <small>
        {effort} / {speed}
      </small>
      <small>{permission}</small>
    </div>
  );
}

function NativeSlashPanel(): React.ReactElement {
  const backed = ["/status", "/model", "/fast", "/review", "/compact", "/mcp", "/apps", "/plugins"];
  const projectCommands = ["/new", "/resume"];
  const recognized = ["/feedback", "/plan-mode", "/diff", "/init", "/permissions", "/agent", "/stop"];
  return (
    <section className="slash-panel">
      <div>
        <span className="label">App-server backed</span>
        <div className="slash-chip-row">
          {backed.map((command) => (
            <code key={command}>{command}</code>
          ))}
        </div>
      </div>
      <div>
        <span className="label">Voice project controls</span>
        <div className="slash-chip-row">
          {projectCommands.map((command) => (
            <code key={command}>{command}</code>
          ))}
        </div>
      </div>
      <div>
        <span className="label">Recognized, not wired</span>
        <div className="slash-chip-row muted">
          {recognized.map((command) => (
            <code key={command}>{command}</code>
          ))}
        </div>
      </div>
    </section>
  );
}

function formatTokenUsage(usage: CodexThreadTokenUsage | null): string {
  if (!usage) return "not reported";
  const total = usage.total.totalTokens;
  if (!usage.modelContextWindow) return `${total.toLocaleString()} tokens`;
  return `${total.toLocaleString()} / ${usage.modelContextWindow.toLocaleString()}`;
}

function StatusPill({ label, tone }: { label: string; tone: "good" | "warn" | "muted" }): React.ReactElement {
  return <span className={`status-pill ${tone}`}>{label}</span>;
}

function VoicePendingRequestPanel({
  request,
  requestCount,
  onAction,
}: {
  request: PendingCodexRequest;
  requestCount: number;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  return (
    <section className={`voice-pending-panel ${request.kind}`} aria-label="Pending Codex request">
      <div className="voice-pending-topline">
        <span>{requestKindLabel(request)}</span>
        {requestCount > 1 && <strong>{requestCount} waiting</strong>}
      </div>
      <h2>{request.title}</h2>
      {requestContextLabel(request) && <p>{requestContextLabel(request)}</p>}
      {request.kind === "question" ? (
        <ToolQuestionForm request={request} onAction={onAction} surface="voice" />
      ) : (
        <>
          <RequestDetails request={request} surface="voice" />
          <ApprovalActions request={request} onAction={onAction} surface="voice" />
        </>
      )}
    </section>
  );
}

function PendingRequestCard({
  request,
  onAction,
}: {
  request: PendingCodexRequest;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  if (request.method === "item/tool/requestUserInput") {
    return <ToolQuestionCard request={request} onAction={onAction} />;
  }

  return (
    <article className={`pending-card ${request.kind}`}>
      <PendingRequestHeader request={request} />
      <RequestDetails request={request} surface="debug" />
      <ApprovalActions request={request} onAction={onAction} surface="debug" />
    </article>
  );
}

function PendingRequestHeader({ request }: { request: PendingCodexRequest }): React.ReactElement {
  return (
    <div className="pending-card-header">
      <div>
        <span className="pending-kind">{requestKindLabel(request)}</span>
        <h3>{request.title}</h3>
        {(request.subtitle || requestContextLabel(request)) && (
          <p>{[request.subtitle, requestContextLabel(request)].filter(Boolean).join(" - ")}</p>
        )}
      </div>
      <code>#{String(request.requestId)}</code>
    </div>
  );
}

function RequestDetails({
  request,
  surface,
}: {
  request: PendingCodexRequest;
  surface: "debug" | "voice";
}): React.ReactElement {
  const details = request.details ?? [];
  return (
    <div className={`request-details ${surface}`}>
      {request.body && <pre>{request.body}</pre>}
      {details.length > 0 && (
        <dl>
          {details.map((detail) => (
            <React.Fragment key={`${detail.label}-${detail.value}`}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

function ApprovalActions({
  request,
  onAction,
  surface,
}: {
  request: PendingCodexRequest;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
  surface: "debug" | "voice";
}): React.ReactElement {
  const options = request.options ?? ["cancel"];
  return (
    <div className={`button-row wrap approval-actions ${surface}`}>
      {options.includes("accept") && (
        <button className="primary" onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "accept"))}>
          Accept
        </button>
      )}
      {options.includes("acceptForSession") && (
        <button onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "acceptForSession"))}>
          Accept Session
        </button>
      )}
      {options.includes("decline") && (
        <button onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "decline"))}>
          Decline
        </button>
      )}
      {options.includes("cancel") && (
        <button className="danger" onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "cancel"))}>
          Cancel
        </button>
      )}
    </div>
  );
}

function ToolQuestionCard({
  request,
  onAction,
}: {
  request: PendingCodexRequest;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  return (
    <article className="pending-card question">
      <PendingRequestHeader request={request} />
      <ToolQuestionForm request={request} onAction={onAction} surface="debug" />
    </article>
  );
}

function ToolQuestionForm({
  request,
  onAction,
  surface,
}: {
  request: PendingCodexRequest;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
  surface: "debug" | "voice";
}): React.ReactElement {
  const questions = useMemo(() => {
    return request.questions?.length ? request.questions : questionsFromRawRequest(request);
  }, [request]);
  const [answers, setAnswers] = useState<Record<string, string>>({});

  useEffect(() => {
    setAnswers({});
  }, [request.requestId]);

  const payload: ToolQuestionAnswer[] = questions.map((question) => ({
    questionId: question.id,
    answers: [answers[question.id] || defaultQuestionAnswer(question)].filter(Boolean),
  }));
  const canSubmit = questions.length > 0 && payload.every((answer) => answer.answers.length > 0);

  return (
    <div className={`tool-question-form ${surface}`}>
      {request.body && questions.length === 0 && <p className="question-body">{request.body}</p>}
      {questions.map((question) => (
        <div key={question.id} className="question-block">
          <span>{question.header}</span>
          <label className="stacked-input compact">
            {question.question}
            {question.options?.length ? (
              <div className="question-options">
                {question.options.map((option) => (
                  <button
                    key={option.label}
                    type="button"
                    className={(answers[question.id] ?? defaultQuestionAnswer(question)) === option.label ? "selected" : ""}
                    onClick={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))}
                  >
                    <strong>{option.label}</strong>
                    {option.description && <small>{option.description}</small>}
                  </button>
                ))}
              </div>
            ) : null}
            {question.options?.length && !question.isOther ? null : (
              <input
                value={customQuestionAnswer(question, answers[question.id])}
                onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
                placeholder={question.options?.length ? "Other answer" : "Answer"}
                type={question.isSecret ? "password" : "text"}
                aria-label={`${question.header}: ${question.question}`}
              />
            )}
          </label>
        </div>
      ))}
      {questions.length === 0 && <p className="empty">Question details were not included in the app-server payload.</p>}
      <button
        className="primary"
        disabled={!canSubmit}
        onClick={() => void onAction(() => window.codexVoice.answerToolQuestion(request.requestId, payload))}
      >
        Send Answer
      </button>
    </div>
  );
}

function questionsFromRawRequest(request: PendingCodexRequest): PendingRequestQuestion[] {
  const raw = request.raw as { params?: { questions?: Array<any> }; raw?: { params?: { questions?: Array<any> } } };
  const questions = raw.params?.questions ?? raw.raw?.params?.questions ?? [];
  if (!Array.isArray(questions)) return [];
  return questions
    .map((question, index): PendingRequestQuestion | null => {
      if (!question || typeof question !== "object") return null;
      const record = question as Record<string, unknown>;
      const id = typeof record.id === "string" && record.id.trim() ? record.id : `question-${index + 1}`;
      const options = Array.isArray(record.options)
        ? record.options
            .map((option) => {
              if (!option || typeof option !== "object") return null;
              const optionRecord = option as Record<string, unknown>;
              return typeof optionRecord.label === "string"
                ? {
                    label: optionRecord.label,
                    description: typeof optionRecord.description === "string" ? optionRecord.description : "",
                  }
                : null;
            })
            .filter((option): option is { label: string; description: string } => option !== null)
        : null;
      return {
        id,
        header: typeof record.header === "string" ? record.header : `Question ${index + 1}`,
        question: typeof record.question === "string" ? record.question : "Codex is asking for input.",
        isOther: Boolean(record.isOther),
        isSecret: Boolean(record.isSecret),
        options,
      };
    })
    .filter((question): question is PendingRequestQuestion => question !== null);
}

function defaultQuestionAnswer(question: PendingRequestQuestion): string {
  return question.options?.[0]?.label ?? "";
}

function customQuestionAnswer(question: PendingRequestQuestion, answer: string | undefined): string {
  if (!answer) return "";
  if (!question.options?.some((option) => option.label === answer)) return answer;
  return "";
}

function requestKindLabel(request: PendingCodexRequest): string {
  if (request.kind === "question") return "Question";
  if (request.kind === "approval") return "Approval";
  if (request.kind === "elicitation") return "MCP request";
  if (request.kind === "tool") return "Tool call";
  if (request.kind === "auth") return "Auth";
  return "Request";
}

function requestContextLabel(request: PendingCodexRequest): string {
  return [request.projectName, request.chatName].filter(Boolean).join(" / ");
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
