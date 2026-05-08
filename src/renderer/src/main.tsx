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
  type AppEvent,
  type AppState,
  type CodexModelSummary,
  type CodexPermissionMode,
  type CodexServiceTier,
  type CodexThreadTokenUsage,
  type CodexTurnOutput,
  type PendingCodexRequest,
  type PendingRequestQuestion,
  type ReasoningEffort,
  type RealtimeModelId,
  type RealtimeReasoningEffort,
  type RealtimeVoiceId,
  type ToolQuestionAnswer,
  type VoiceChat,
  type VoiceProject,
  type WindowChromeState,
} from "../../shared/types";
import { appendBufferedEvent } from "../../shared/eventBuffer";
import { RealtimeVoiceClient } from "./realtimeClient";
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
  realtime: {
    available: false,
    model: DEFAULT_REALTIME_MODEL,
    voice: "marin",
    reasoningEffort: "low",
    reason: null,
    apiKeySource: null,
    apiKeyEncrypted: false,
  },
};

type AppWindowKind = "voice" | "debug";
type ApiKeyDialogMode = "onboarding" | "settings";
type OnboardingStep = "key" | "voice" | "orb" | "project";
type PaneSide = "settings" | "future";
type VoiceTone = "off" | "listening" | "working" | "connecting" | "paused" | "waiting";
type VoiceSettingsTab = "general" | "appearance" | "configuration" | "archive";
type VoiceOrbPresetId = "aurora" | "cloud" | "nocturne";

type VoiceOrbPreset = {
  id: VoiceOrbPresetId;
  name: string;
  detail: string;
  shape: "sphere" | "cloud";
  previewLevel: number;
};

type VoiceOrbCustomization = {
  accentColor: string;
  glow: number;
  reactivity: number;
  waveHeight: number;
};

const voiceOrbStorageKey = "codexVoice.orbPreset";
const leftPanelWidthStorageKey = "codexVoice.leftPanel.width";
const rightPanelWidthStorageKey = "codexVoice.rightPanel.width";
const voiceOrbCustomizationStorageKey = "codexVoice.orbCustomization";
const voiceOnboardingSeenStorageKey = "codexVoice.onboardingSeen";
const dualPaneLayoutMediaQuery = "(min-width: 1420px)";
const paneReplacementDelayMs = 120;
const minPaneWidth = 320;
const maxPaneWidth = 720;
const defaultPaneWidth = 420;
const defaultVoiceOrbCustomization: VoiceOrbCustomization = {
  accentColor: "#1d9bf0",
  glow: 52,
  reactivity: 56,
  waveHeight: 50,
};
const voiceOrbColorOptions: Array<{ color: string; label: string }> = [
  { color: "#1d9bf0", label: "Azure" },
  { color: "#35d6ff", label: "Cyan" },
  { color: "#6f8cff", label: "Indigo" },
  { color: "#8ff5df", label: "Mint" },
  { color: "#f4f0dd", label: "Pearl" },
];
const voiceOrbPresets: VoiceOrbPreset[] = [
  {
    id: "aurora",
    name: "Aurora",
    detail: "Round water",
    shape: "sphere",
    previewLevel: 0.32,
  },
  {
    id: "cloud",
    name: "Cloud",
    detail: "App icon shape",
    shape: "cloud",
    previewLevel: 0.42,
  },
  {
    id: "nocturne",
    name: "Nocturne",
    detail: "Night glass",
    shape: "sphere",
    previewLevel: 0.28,
  },
];

// Traced from src/main/assets/app-icon.png so the Cloud preset keeps the app icon silhouette.
const iconCloudPathData =
  "M4572 8120 c-80 -11 -245 -54 -325 -84 -402 -151 -739 -499 -906 -933 -41 -105 -85 -150 -189 -193 -335 -140 -573 -332 -767 -620 -113 -169 -195 -368 -242 -589 -25 -115 -27 -145 -28 -351 0 -200 3 -237 23 -329 57 -255 141 -437 289 -628 100 -128 107 -158 84 -343 -19 -145 -9 -412 19 -545 39 -186 113 -373 213 -539 95 -157 273 -342 444 -461 91 -63 242 -146 293 -160 14 -4 39 -15 55 -25 17 -10 57 -23 90 -30 33 -7 83 -21 110 -31 76 -27 136 -32 435 -34 254 -1 279 -3 328 -22 29 -12 68 -32 85 -45 158 -117 424 -246 557 -268 36 -6 94 -20 130 -31 107 -33 360 -40 570 -15 52 6 192 51 330 104 365 142 667 458 826 865 45 118 88 167 167 193 29 9 59 22 67 29 8 7 49 29 90 49 123 61 237 144 355 261 121 119 174 185 250 310 108 179 187 380 232 594 24 111 27 148 27 311 0 153 -4 203 -23 290 -47 222 -147 450 -271 620 -38 52 -80 111 -94 130 -39 54 -48 122 -31 237 34 238 28 420 -21 639 -107 484 -430 897 -856 1098 -133 63 -207 88 -343 117 -130 28 -355 36 -496 18 -115 -14 -175 -14 -215 1 -15 6 -68 44 -118 84 -145 117 -315 213 -462 260 -180 58 -239 68 -434 71 -102 2 -213 0 -248 -5z";
const iconCloudSourceBounds = {
  x: 2110,
  yBottom: 1840,
  yTop: 8130,
  width: 6070,
  height: 6290,
};
const iconCloudRotationRadians = (-12 * Math.PI) / 180;
let iconCloudPath: Path2D | null = null;

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

function appWindowKind(): AppWindowKind {
  const kind = new URLSearchParams(window.location.search).get("window");
  return kind === "debug" ? "debug" : "voice";
}

function eventWithActiveContext(event: AppEvent, state: AppState): AppEvent {
  if (event.source !== "realtime") return event;
  const project = state.activeProject;
  if (!project) return event;
  const chats = project.chats.filter((chat) => !chat.archivedAt);
  const chat =
    chats.find((candidate) => candidate.id === state.runtime.activeChatId) ??
    chats.find((candidate) => candidate.id === project.activeChatId) ??
    chats.find((candidate) => candidate.codexThreadId === project.codexThreadId) ??
    chats[0] ??
    null;
  if (!chat) return event;
  const raw = event.raw && typeof event.raw === "object" && !Array.isArray(event.raw) ? event.raw : {};
  return {
    ...event,
    raw: {
      ...raw,
      projectId: project.id,
      chatId: chat.id,
      threadId: chat.codexThreadId,
    },
  };
}

function isVoiceOrbPresetId(value: string | null): value is VoiceOrbPresetId {
  return voiceOrbPresets.some((preset) => preset.id === value);
}

function loadVoiceOrbPresetId(): VoiceOrbPresetId {
  try {
    const stored = window.localStorage.getItem(voiceOrbStorageKey);
    return isVoiceOrbPresetId(stored) ? stored : "aurora";
  } catch {
    return "aurora";
  }
}

function saveVoiceOrbPresetId(presetId: VoiceOrbPresetId): void {
  try {
    window.localStorage.setItem(voiceOrbStorageKey, presetId);
  } catch {
    // Visual preferences should never block the voice UI.
  }
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
    glow: clampControlValue(value?.glow, defaultVoiceOrbCustomization.glow),
    reactivity: clampControlValue(value?.reactivity, defaultVoiceOrbCustomization.reactivity),
    waveHeight: clampControlValue(value?.waveHeight, defaultVoiceOrbCustomization.waveHeight),
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

function clampPaneWidth(width: number): number {
  return Math.max(minPaneWidth, Math.min(maxPaneWidth, Math.round(width)));
}

function loadPaneWidth(storageKey: string): number {
  try {
    const value = Number(window.localStorage.getItem(storageKey));
    return Number.isFinite(value) ? clampPaneWidth(value) : defaultPaneWidth;
  } catch {
    return defaultPaneWidth;
  }
}

function savePaneWidth(storageKey: string, width: number): void {
  try {
    window.localStorage.setItem(storageKey, String(clampPaneWidth(width)));
  } catch {
    // Visual preferences should never block the voice UI.
  }
}

function loadVoiceOnboardingSeen(): boolean {
  try {
    return window.localStorage.getItem(voiceOnboardingSeenStorageKey) === "true";
  } catch {
    return false;
  }
}

function saveVoiceOnboardingSeen(seen: boolean): void {
  try {
    window.localStorage.setItem(voiceOnboardingSeenStorageKey, seen ? "true" : "false");
  } catch {
    // Onboarding should stay usable even if localStorage is unavailable.
  }
}

function supportsDualPaneLayout(): boolean {
  return window.matchMedia(dualPaneLayoutMediaQuery).matches;
}

function voiceOrbPresetById(presetId: VoiceOrbPresetId): VoiceOrbPreset {
  return voiceOrbPresets.find((preset) => preset.id === presetId) ?? voiceOrbPresets[0];
}

function voiceOrbPresetAtOffset(presetId: VoiceOrbPresetId, offset: number): VoiceOrbPresetId {
  const currentIndex = Math.max(0, voiceOrbPresets.findIndex((preset) => preset.id === presetId));
  const nextIndex = (currentIndex + offset + voiceOrbPresets.length) % voiceOrbPresets.length;
  return voiceOrbPresets[nextIndex].id;
}

function App(): React.ReactElement {
  const [windowKind] = useState<AppWindowKind>(() => appWindowKind());
  const [state, setState] = useState<AppState>(emptyState);
  const [stateLoaded, setStateLoaded] = useState(false);
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
  const [onboardingRequestId, setOnboardingRequestId] = useState(0);
  const [windowChromeState, setWindowChromeState] = useState<WindowChromeState>({ isFullScreen: false });
  const voiceRef = useRef<RealtimeVoiceClient | null>(null);
  const stateRef = useRef<AppState>(emptyState);
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
      setState(nextState);
      setStateLoaded(true);
    });
    const offEvent = window.codexVoice.onAppEvent((event) => {
      setEvents((current) => appendBufferedEvent(current, event));
      if (event.source === "app" && event.kind === "debug/startOnboarding") {
        setOnboardingRequestId((current) => current + 1);
      } else if (event.source === "codex" && event.kind === "serverRequest") {
        voiceRef.current?.speakPendingRequest(event.raw as PendingCodexRequest);
      } else if (event.source === "codex" && event.kind === "turn/finalOutput") {
        voiceRef.current?.injectCodexTurnOutput(event.raw as CodexTurnOutput);
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
    setStateLoaded(true);
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

  function disconnectVoice(): void {
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
          void window.codexVoice.logEvent(eventWithActiveContext(event, stateRef.current));
        },
        onOutputLevel: updateVoiceOutputLevel,
      });
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
      stateLoaded={stateLoaded}
      voiceOutputLevel={voiceOutputLevel}
      realtimeIssue={realtimeIssue}
      error={error}
      voiceConnected={voiceConnected}
      voiceConnecting={voiceConnecting}
      voicePaused={voicePaused}
      onboardingRequestId={onboardingRequestId}
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
  stateLoaded,
  voiceOutputLevel,
  realtimeIssue,
  error,
  voiceConnected,
  voiceConnecting,
  voicePaused,
  onboardingRequestId,
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
  stateLoaded: boolean;
  voiceOutputLevel: number;
  realtimeIssue: string | null;
  error: string | null;
  voiceConnected: boolean;
  voiceConnecting: boolean;
  voicePaused: boolean;
  onboardingRequestId: number;
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
  const [futureOpen, setFutureOpen] = useState(false);
  const [canShowBothPanes, setCanShowBothPanes] = useState(() => supportsDualPaneLayout());
  const [leftPaneWidth, setLeftPaneWidth] = useState(() => loadPaneWidth(leftPanelWidthStorageKey));
  const [rightPanelWidth, setRightPanelWidth] = useState(() => loadPaneWidth(rightPanelWidthStorageKey));
  const [resizingPane, setResizingPane] = useState<PaneSide | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [switchChatOpen, setSwitchChatOpen] = useState(false);
  const [browseOpen, setBrowseOpen] = useState(false);
  const [archivedOpen, setArchivedOpen] = useState(false);
  const [chatsOpen, setChatsOpen] = useState(false);
  const [permissionsOpen, setPermissionsOpen] = useState(false);
  const [orbPresetId, setOrbPresetId] = useState<VoiceOrbPresetId>(() => loadVoiceOrbPresetId());
  const [orbCustomization, setOrbCustomization] = useState<VoiceOrbCustomization>(() => loadVoiceOrbCustomization());
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [onboardingSeen, setOnboardingSeen] = useState(() => loadVoiceOnboardingSeen());
  const [apiKeyDialogMode, setApiKeyDialogMode] = useState<ApiKeyDialogMode | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuTarget | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [newName, setNewName] = useState("");
  const [newChatName, setNewChatName] = useState("");
  const [query, setQuery] = useState("");
  const paneTogglePointerActivationRef = useRef<PaneSide | null>(null);
  const paneReplacementTimeoutRef = useRef<number | null>(null);
  const paneResizeFrameRef = useRef<number | null>(null);
  const pendingPaneResizeRef = useRef<{ pane: PaneSide; width: number } | null>(null);
  const paneResizeCleanupRef = useRef<(() => void) | null>(null);
  const lastOpenedPaneRef = useRef<PaneSide>("settings");
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

  useEffect(() => {
    saveVoiceOrbPresetId(orbPresetId);
  }, [orbPresetId]);

  useEffect(() => {
    saveVoiceOrbCustomization(orbCustomization);
  }, [orbCustomization]);

  useEffect(() => {
    savePaneWidth(leftPanelWidthStorageKey, leftPaneWidth);
  }, [leftPaneWidth]);

  useEffect(() => {
    savePaneWidth(rightPanelWidthStorageKey, rightPanelWidth);
  }, [rightPanelWidth]);

  useEffect(() => {
    const mediaQuery = window.matchMedia(dualPaneLayoutMediaQuery);
    const updateCanShowBothPanes = () => setCanShowBothPanes(mediaQuery.matches);

    updateCanShowBothPanes();
    mediaQuery.addEventListener("change", updateCanShowBothPanes);
    return () => mediaQuery.removeEventListener("change", updateCanShowBothPanes);
  }, []);

  useEffect(() => {
    return () => {
      if (paneReplacementTimeoutRef.current !== null) {
        window.clearTimeout(paneReplacementTimeoutRef.current);
      }
      paneResizeCleanupRef.current?.();
      if (paneResizeFrameRef.current !== null) {
        window.cancelAnimationFrame(paneResizeFrameRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (canShowBothPanes || !settingsOpen || !futureOpen) return;

    if (lastOpenedPaneRef.current === "future") {
      setSettingsOpen(false);
    } else {
      setFutureOpen(false);
    }
  }, [canShowBothPanes, futureOpen, settingsOpen]);

  useEffect(() => {
    setChatsOpen(false);
  }, [activeProject?.id]);

  useEffect(() => {
    setChatsOpen(showProjectChats);
  }, [showProjectChats]);

  useEffect(() => {
    if (stateLoaded && projects.length > 0 && !onboardingSeen) {
      saveVoiceOnboardingSeen(true);
      setOnboardingSeen(true);
      return;
    }

    if (stateLoaded && !onboardingSeen && !onboardingOpen && !apiKeyDialogMode && projects.length === 0) {
      setOnboardingOpen(true);
    }
  }, [apiKeyDialogMode, onboardingOpen, onboardingSeen, projects.length, stateLoaded]);

  useEffect(() => {
    if (onboardingRequestId === 0) return;
    saveVoiceOnboardingSeen(false);
    setOnboardingSeen(false);
    setApiKeyDialogMode(null);
    setSettingsOpen(false);
    setFutureOpen(false);
    setOnboardingOpen(true);
  }, [onboardingRequestId]);

  useEffect(() => {
    if (!apiKeyDialogMode && !settingsOpen && !onboardingOpen) return;
    setApiKey("");
  }, [apiKeyDialogMode, onboardingOpen, settingsOpen]);

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

  async function startOnboardingProject(mode: "scratch" | "folder"): Promise<void> {
    let created = false;
    await onAction(async () => {
      if (mode === "folder") {
        const folder = await window.codexVoice.selectWorkspaceFolder();
        if (!folder) return;
        await window.codexVoice.createProject(folder.name, folder.path);
      } else {
        await window.codexVoice.createProject("Voice Project");
      }
      created = true;
      await onRefresh();
    });
    if (created) {
      completeOnboarding();
    }
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
      setSwitchChatOpen(false);
      setChatsOpen(true);
    });
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

  async function saveOnboardingApiKey(): Promise<void> {
    await onAction(async () => {
      await window.codexVoice.saveOpenAiApiKey(apiKey);
      setApiKey("");
      onClearRealtimeIssue();
      await onRefresh();
    });
  }

  async function changeRealtimeVoice(voice: RealtimeVoiceId): Promise<void> {
    let updated = false;
    await onAction(async () => {
      await window.codexVoice.setRealtimeSettings({ voice });
      updated = true;
      await onRefresh();
    });
    if (updated && voiceConnected) await onRestartVoice();
  }

  function completeOnboarding(): void {
    setApiKey("");
    saveVoiceOnboardingSeen(true);
    setOnboardingSeen(true);
    setOnboardingOpen(false);
  }

  function closeApiKeyDialog(): void {
    setApiKey("");
    setApiKeyDialogMode(null);
  }

  function handleVoiceOrbClick(): void {
    if (!state.realtime.available) {
      setApiKeyDialogMode("onboarding");
      return;
    }
    void onOrbAction();
  }

  function clearPaneReplacementTimeout(): void {
    if (paneReplacementTimeoutRef.current === null) return;
    window.clearTimeout(paneReplacementTimeoutRef.current);
    paneReplacementTimeoutRef.current = null;
  }

  function openPaneAfterReplacement(pane: PaneSide): void {
    paneReplacementTimeoutRef.current = window.setTimeout(() => {
      if (pane === "settings") {
        setSettingsOpen(true);
      } else {
        setFutureOpen(true);
      }
      paneReplacementTimeoutRef.current = null;
    }, paneReplacementDelayMs);
  }

  function toggleSettingsPane(): void {
    setPermissionsOpen(false);
    clearPaneReplacementTimeout();

    if (settingsOpen) {
      setSettingsOpen(false);
      return;
    }

    lastOpenedPaneRef.current = "settings";
    if (canShowBothPanes || !futureOpen) {
      setSettingsOpen(true);
      return;
    }

    setFutureOpen(false);
    openPaneAfterReplacement("settings");
  }

  function toggleFuturePane(): void {
    setPermissionsOpen(false);
    clearPaneReplacementTimeout();

    if (futureOpen) {
      setFutureOpen(false);
      return;
    }

    lastOpenedPaneRef.current = "future";
    if (canShowBothPanes || !settingsOpen) {
      setFutureOpen(true);
      return;
    }

    setSettingsOpen(false);
    openPaneAfterReplacement("future");
  }

  function activatePaneToggle(pane: PaneSide): void {
    if (pane === "settings") {
      toggleSettingsPane();
      return;
    }

    toggleFuturePane();
  }

  function handlePaneTogglePointerDown(event: React.PointerEvent<HTMLButtonElement>): void {
    event.preventDefault();
    event.stopPropagation();
  }

  function handlePaneTogglePointerUp(
    event: React.PointerEvent<HTMLButtonElement>,
    pane: PaneSide,
  ): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    paneTogglePointerActivationRef.current = pane;
    activatePaneToggle(pane);
    window.setTimeout(() => {
      if (paneTogglePointerActivationRef.current === pane) {
        paneTogglePointerActivationRef.current = null;
      }
    }, 400);
  }

  function handlePaneToggleClick(
    event: React.MouseEvent<HTMLButtonElement>,
    pane: PaneSide,
  ): void {
    event.stopPropagation();
    if (paneTogglePointerActivationRef.current === pane) {
      paneTogglePointerActivationRef.current = null;
      return;
    }
    activatePaneToggle(pane);
  }

  function paneWidth(pane: PaneSide): number {
    return pane === "settings" ? leftPaneWidth : rightPanelWidth;
  }

  function setPaneWidth(pane: PaneSide, width: number): void {
    if (pane === "settings") {
      setLeftPaneWidth(clampPaneWidth(width));
      return;
    }
    setRightPanelWidth(clampPaneWidth(width));
  }

  function maxPaneWidthForResize(pane: PaneSide): number {
    const otherPaneWidth =
      pane === "settings" && futureOpen ? rightPanelWidth : pane === "future" && settingsOpen ? leftPaneWidth : 0;
    const centerMinWidth = window.innerWidth >= 1240 ? 500 : 340;
    const availableWidth = window.innerWidth - otherPaneWidth - centerMinWidth;
    return Math.max(minPaneWidth, Math.min(maxPaneWidth, availableWidth));
  }

  function clampPaneWidthForResize(pane: PaneSide, width: number): number {
    return Math.max(minPaneWidth, Math.min(maxPaneWidthForResize(pane), Math.round(width)));
  }

  function flushPendingPaneResize(): void {
    const pending = pendingPaneResizeRef.current;
    if (!pending) return;
    pendingPaneResizeRef.current = null;
    paneResizeFrameRef.current = null;
    setPaneWidth(pending.pane, pending.width);
  }

  function schedulePaneResize(pane: PaneSide, width: number): void {
    pendingPaneResizeRef.current = { pane, width };
    if (paneResizeFrameRef.current !== null) return;
    paneResizeFrameRef.current = window.requestAnimationFrame(flushPendingPaneResize);
  }

  function finishPaneResize(pane: PaneSide): void {
    const pending = pendingPaneResizeRef.current;
    if (paneResizeFrameRef.current !== null) {
      window.cancelAnimationFrame(paneResizeFrameRef.current);
      paneResizeFrameRef.current = null;
    }
    if (pending?.pane === pane) {
      pendingPaneResizeRef.current = null;
      setPaneWidth(pending.pane, pending.width);
    }
    setResizingPane(null);
  }

  function startPaneResize(event: React.PointerEvent<HTMLDivElement>, pane: PaneSide): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    paneResizeCleanupRef.current?.();

    const target = event.currentTarget;
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startWidth = paneWidth(pane);
    const previousCursor = document.body.style.cursor;
    const previousUserSelect = document.body.style.userSelect;

    target.setPointerCapture(pointerId);
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizingPane(pane);

    function onMove(moveEvent: PointerEvent): void {
      const delta = moveEvent.clientX - startX;
      const nextWidth = pane === "settings" ? startWidth + delta : startWidth - delta;
      schedulePaneResize(pane, clampPaneWidthForResize(pane, nextWidth));
    }

    function onEnd(): void {
      cleanup();
    }

    function cleanup(): void {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onEnd);
      window.removeEventListener("pointercancel", onEnd);
      window.removeEventListener("blur", onEnd);
      if (target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
      document.body.style.cursor = previousCursor;
      document.body.style.userSelect = previousUserSelect;
      paneResizeCleanupRef.current = null;
      finishPaneResize(pane);
    }

    paneResizeCleanupRef.current = cleanup;
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onEnd);
    window.addEventListener("pointercancel", onEnd);
    window.addEventListener("blur", onEnd);
  }

  function resizePaneWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>, pane: PaneSide): void {
    const direction = pane === "settings" ? 1 : -1;
    const step = event.shiftKey ? 48 : 24;

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      setPaneWidth(pane, clampPaneWidthForResize(pane, paneWidth(pane) - step * direction));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      setPaneWidth(pane, clampPaneWidthForResize(pane, paneWidth(pane) + step * direction));
    }
  }

  function paneResizer(pane: PaneSide, open: boolean): React.ReactElement {
    const label = pane === "settings" ? "left" : "right";
    const maxWidth = maxPaneWidthForResize(pane);
    const currentWidth = Math.min(paneWidth(pane), maxWidth);
    return (
      <div
        className={`voice-pane-resizer ${label}${resizingPane === pane ? " resizing" : ""}`}
        role="separator"
        aria-orientation="vertical"
        aria-label={`Resize ${label} pane`}
        aria-valuemin={minPaneWidth}
        aria-valuemax={maxWidth}
        aria-valuenow={currentWidth}
        tabIndex={open ? 0 : -1}
        onPointerDown={(event) => startPaneResize(event, pane)}
        onKeyDown={(event) => resizePaneWithKeyboard(event, pane)}
      />
    );
  }

  return (
    <main
      className={`voice-home ${settingsOpen ? "settings-open" : ""} ${futureOpen ? "future-open" : ""} ${
        windowChromeState.isFullScreen ? "window-fullscreen" : ""
      } ${
        resizingPane ? `pane-resizing pane-resizing-${resizingPane}` : ""
      }`}
      style={{
        ...voiceAccentStyle(orbCustomization),
        "--settings-pane-resized-width": `${leftPaneWidth}px`,
        "--right-pane-width": `${rightPanelWidth}px`,
      } as React.CSSProperties}
    >
      <button
        className="voice-pane-toggle left"
        type="button"
        aria-label={settingsOpen ? "Close left pane" : "Open left pane"}
        aria-expanded={settingsOpen}
        onPointerDown={handlePaneTogglePointerDown}
        onPointerUp={(event) => handlePaneTogglePointerUp(event, "settings")}
        onClick={(event) => handlePaneToggleClick(event, "settings")}
      >
        <LeftPaneIcon />
      </button>
      <button
        className="voice-pane-toggle right"
        type="button"
        aria-label={futureOpen ? "Close right pane" : "Open right pane"}
        aria-expanded={futureOpen}
        onPointerDown={handlePaneTogglePointerDown}
        onPointerUp={(event) => handlePaneTogglePointerUp(event, "future")}
        onClick={(event) => handlePaneToggleClick(event, "future")}
      >
        <RightPaneIcon />
      </button>
      <div className="voice-shell">
        <VoiceSettingsPane
          open={settingsOpen}
          state={state}
          realtimeIssue={realtimeIssue}
          apiKey={apiKey}
          archivedCount={archivedCount}
          voiceConnected={voiceConnected}
          modelScope={modelScope}
          effectiveModel={effectiveModel}
          effectiveEffort={effectiveEffort}
          effectiveServiceTier={effectiveServiceTier}
          effectivePermissionMode={effectivePermissionMode}
          modelOptions={modelOptions}
          orbPresetId={orbPresetId}
          orbCustomization={orbCustomization}
          onOrbPresetChange={setOrbPresetId}
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
          resizer={paneResizer("settings", settingsOpen)}
        />

        <div className="voice-home-content">
        <header className="voice-home-header">
          <h1>Codex Voice</h1>
        </header>

        <div className="voice-home-scroll">
          <section className="voice-hero" aria-label="Voice status">
            <button
              className={`voice-orb ${voiceState.tone} ${orbPresetId}`}
              aria-label={voiceOrbLabel}
              onClick={handleVoiceOrbClick}
            >
              <VoiceOrbCanvas
                tone={voiceState.tone}
                outputLevel={voiceOutputLevel}
                presetId={orbPresetId}
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
                onOpenChatMenu={openChatContextMenu}
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
          open={futureOpen}
          state={state}
          events={events}
          width={rightPanelWidth}
          onWidthChange={setRightPanelWidth}
          onClose={() => setFutureOpen(false)}
          onAction={onAction}
        />
      </div>

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

      {onboardingOpen && (
        <OnboardingFlow
          state={state}
          realtimeIssue={realtimeIssue}
          apiKey={apiKey}
          orbPresetId={orbPresetId}
          orbCustomization={orbCustomization}
          onApiKeyChange={setApiKey}
          onSaveApiKey={saveOnboardingApiKey}
          onVoiceChange={changeRealtimeVoice}
          onOrbPresetChange={setOrbPresetId}
          onOrbCustomizationChange={setOrbCustomization}
          onStartProject={(mode) => void startOnboardingProject(mode)}
          onClose={completeOnboarding}
        />
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
  modelScope,
  effectiveModel,
  effectiveEffort,
  effectiveServiceTier,
  effectivePermissionMode,
  modelOptions,
  orbPresetId,
  orbCustomization,
  onOrbPresetChange,
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
  resizer,
}: {
  open: boolean;
  state: AppState;
  realtimeIssue: string | null;
  apiKey: string;
  archivedCount: number;
  voiceConnected: boolean;
  modelScope: "chat" | "nextTurn";
  effectiveModel: string;
  effectiveEffort: ReasoningEffort;
  effectiveServiceTier: CodexServiceTier | null;
  effectivePermissionMode: CodexPermissionMode;
  modelOptions: CodexModelSummary[];
  orbPresetId: VoiceOrbPresetId;
  orbCustomization: VoiceOrbCustomization;
  onOrbPresetChange: (presetId: VoiceOrbPresetId) => void;
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
  resizer?: React.ReactNode;
}): React.ReactElement {
  const [activeTab, setActiveTab] = useState<VoiceSettingsTab>("appearance");
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
  const selectedCodexModel = modelOptions.find((model) => model.model === effectiveModel) ?? null;
  const modelSupportsFast = supportsFastMode(selectedCodexModel);
  const fastModeOn = isFastServiceTier(effectiveServiceTier);
  const tabs: Array<{ id: VoiceSettingsTab; label: string; icon: React.ReactElement }> = [
    { id: "general", label: "General", icon: <ConfigIcon /> },
    { id: "appearance", label: "Appearance", icon: <AppearanceIcon /> },
    { id: "configuration", label: "Configuration", icon: <PermissionIcon mode={effectivePermissionMode} /> },
    { id: "archive", label: archivedCount > 0 ? `Archive (${archivedCount})` : "Archive", icon: <ArchiveIcon /> },
  ];

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

  return (
    <aside className="voice-settings-pane" aria-hidden={!open} inert={!open} aria-label="Settings">
      {resizer}
      <div className="voice-settings-inner">
        <header className="voice-settings-header">
          <h2>Controls</h2>
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
            </>
          )}

          {activeTab === "appearance" && (
            <section className="voice-settings-section">
              <h3>Orb</h3>
              <VoiceOrbPresetPicker
                value={orbPresetId}
                customization={orbCustomization}
                onChange={onOrbPresetChange}
                onCustomizationChange={onOrbCustomizationChange}
              />
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
                <h3>Codex model</h3>
                <div className="voice-settings-card">
                  <label className="voice-settings-field">
                    Model
                    <span className="voice-settings-select-wrap">
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

                  <div className="voice-settings-segmented" aria-label="Reasoning effort">
                    {(["low", "medium", "high", "xhigh"] as ReasoningEffort[]).map((effort) => (
                      <button
                        key={effort}
                        type="button"
                        className={effort === effectiveEffort ? "selected" : ""}
                        onClick={() =>
                          void onAction(() =>
                            window.codexVoice.setCodexSettings({ reasoningEffort: effort }, modelScope),
                          )
                        }
                      >
                        {formatEffort(effort)}
                      </button>
                    ))}
                  </div>

                  <div className="voice-settings-speed">
                    <div className="voice-settings-speed-header">
                      <span>
                        <strong>Speed</strong>
                        <small>{fastModeOn ? "Fast mode" : "Standard speed"}</small>
                      </span>
                    </div>
                    <div className="voice-settings-segmented codex-speed" aria-label="Codex speed">
                      <button
                        type="button"
                        className={!fastModeOn ? "selected" : ""}
                        onClick={() =>
                          void onAction(() =>
                            window.codexVoice.setCodexSettings(
                              { serviceTier: DEFAULT_CODEX_SERVICE_TIER },
                              modelScope,
                            ),
                          )
                        }
                      >
                        Standard
                      </button>
                      <button
                        type="button"
                        className={fastModeOn ? "selected" : ""}
                        disabled={!modelSupportsFast}
                        title={modelSupportsFast ? "Use Fast mode" : "Fast mode is not reported for this model"}
                        onClick={() =>
                          void onAction(() =>
                            window.codexVoice.setCodexSettings(
                              { serviceTier: FAST_CODEX_SERVICE_TIER },
                              modelScope,
                            ),
                          )
                        }
                      >
                        Fast
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <section className="voice-settings-section">
                <h3>Permissions</h3>
                <div className="voice-settings-card permission-settings-card">
                  <div className="voice-settings-permission-note">
                    <strong>Direct voice tools run in this workspace</strong>
                    <small>{workspace}</small>
                  </div>
                  {CODEX_PERMISSION_PROFILES.map((profile) => (
                    <button
                      key={profile.mode}
                      type="button"
                      className={`voice-settings-permission ${profile.mode === effectivePermissionMode ? "selected" : ""}`}
                      onClick={() =>
                        void onAction(() =>
                          window.codexVoice.setCodexSettings({ permissionMode: profile.mode }, modelScope),
                        )
                      }
                    >
                      <PermissionIcon mode={profile.mode} />
                      <span>
                        <strong>{profile.displayName}</strong>
                        <small>{profile.description}</small>
                      </span>
                      {profile.mode === effectivePermissionMode && <CheckIcon />}
                    </button>
                  ))}
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

function VoiceOrbPresetPicker({
  value,
  customization,
  onChange,
  onCustomizationChange,
  showCustomization = true,
}: {
  value: VoiceOrbPresetId;
  customization: VoiceOrbCustomization;
  onChange: (presetId: VoiceOrbPresetId) => void;
  onCustomizationChange: (customization: VoiceOrbCustomization) => void;
  showCustomization?: boolean;
}): React.ReactElement {
  const selectedPreset = voiceOrbPresetById(value);
  const selectedIndex = Math.max(0, voiceOrbPresets.findIndex((preset) => preset.id === value));

  function selectOffset(offset: number): void {
    onChange(voiceOrbPresetAtOffset(value, offset));
  }

  function updateCustomization(patch: Partial<VoiceOrbCustomization>): void {
    onCustomizationChange(normalizeVoiceOrbCustomization({ ...customization, ...patch }));
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      selectOffset(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      selectOffset(1);
    }
  }

  function handleWheel(event: React.WheelEvent<HTMLDivElement>): void {
    if (Math.abs(event.deltaX) < 12 && Math.abs(event.deltaY) < 18) return;
    event.preventDefault();
    selectOffset(event.deltaX + event.deltaY > 0 ? 1 : -1);
  }

  return (
    <div className="voice-settings-card voice-orb-picker-card">
      <div className="voice-orb-preset-tabs" role="tablist" aria-label="Orb presets">
        {voiceOrbPresets.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={preset.id === value ? "selected" : ""}
            role="tab"
            aria-selected={preset.id === value}
            onClick={() => onChange(preset.id)}
          >
            {preset.name}
          </button>
        ))}
      </div>

      <div
        className="voice-orb-carousel"
        tabIndex={0}
        role="tabpanel"
        aria-label={`${selectedPreset.name} orb preview, ${selectedIndex + 1} of ${voiceOrbPresets.length}`}
        onKeyDown={handleKeyDown}
        onWheel={handleWheel}
      >
        <div className="voice-orb-carousel-center">
          <div className={`voice-orb-carousel-preview ${selectedPreset.id}`}>
            <VoiceOrbCanvas
              tone="listening"
              outputLevel={selectedPreset.previewLevel}
              presetId={selectedPreset.id}
              customization={customization}
              preview
            />
          </div>
          <div className="voice-orb-carousel-label">
            <strong>{selectedPreset.name}</strong>
            <small>{selectedPreset.detail}</small>
          </div>
        </div>
      </div>

      {showCustomization && (
        <div className="voice-orb-customizer" aria-label="Orb customization">
          <div className="voice-orb-control-row">
            <span className="voice-orb-control-label">Color</span>
            <div className="voice-orb-color-controls">
              <div className="voice-orb-swatches" aria-label="Orb colors">
                {voiceOrbColorOptions.map((option) => (
                  <button
                    key={option.color}
                    type="button"
                    className={option.color.toLowerCase() === customization.accentColor.toLowerCase() ? "selected" : ""}
                    style={{ backgroundColor: option.color }}
                    aria-label={option.label}
                    onClick={() => updateCustomization({ accentColor: option.color })}
                  />
                ))}
              </div>
              <label className="voice-orb-color-picker" aria-label="Custom orb color">
                <input
                  type="color"
                  value={customization.accentColor}
                  onChange={(event) => updateCustomization({ accentColor: event.target.value })}
                />
              </label>
            </div>
          </div>

          <div className="voice-orb-slider-grid">
            <VoiceOrbSlider
              label="Glow"
              value={customization.glow}
              onChange={(glow) => updateCustomization({ glow })}
            />
            <VoiceOrbSlider
              label="Reactivity"
              value={customization.reactivity}
              onChange={(reactivity) => updateCustomization({ reactivity })}
            />
            <VoiceOrbSlider
              label="Wave height"
              value={customization.waveHeight}
              onChange={(waveHeight) => updateCustomization({ waveHeight })}
            />
          </div>

          <button
            type="button"
            className="voice-orb-reset-button"
            onClick={() => onCustomizationChange(defaultVoiceOrbCustomization)}
          >
            <RefreshIcon />
            <span>Reset</span>
          </button>
        </div>
      )}
    </div>
  );
}

function VoiceOrbSlider({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}): React.ReactElement {
  return (
    <label className="voice-orb-slider">
      <span>{label}</span>
      <input
        type="range"
        min={0}
        max={100}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

const onboardingStepOrder: OnboardingStep[] = ["key", "voice", "orb", "project"];

function OnboardingFlow({
  state,
  realtimeIssue,
  apiKey,
  orbPresetId,
  orbCustomization,
  onApiKeyChange,
  onSaveApiKey,
  onVoiceChange,
  onOrbPresetChange,
  onOrbCustomizationChange,
  onStartProject,
  onClose,
}: {
  state: AppState;
  realtimeIssue: string | null;
  apiKey: string;
  orbPresetId: VoiceOrbPresetId;
  orbCustomization: VoiceOrbCustomization;
  onApiKeyChange: (value: string) => void;
  onSaveApiKey: () => Promise<void>;
  onVoiceChange: (voice: RealtimeVoiceId) => Promise<void>;
  onOrbPresetChange: (presetId: VoiceOrbPresetId) => void;
  onOrbCustomizationChange: (customization: VoiceOrbCustomization) => void;
  onStartProject: (mode: "scratch" | "folder") => void;
  onClose: () => void;
}): React.ReactElement {
  const initialStep = state.realtime.available ? "voice" : "key";
  const [step, setStep] = useState<OnboardingStep>(initialStep);
  const [revealed, setRevealed] = useState(false);
  const health = realtimeHealth(state.realtime, realtimeIssue);
  const hasApiKey = Boolean(apiKey.trim());
  const apiKeyManagedByEnvironment = state.realtime.apiKeySource === "environment";
  const selectedVoice = realtimeVoiceOption(state.realtime.voice);
  const selectedOrb = voiceOrbPresetById(orbPresetId);
  const hasProject = state.projects.length > 0;
  const stepIndex = onboardingStepOrder.indexOf(step);
  const canGoBack = stepIndex > 0;
  const isLastStep = step === "project";

  const stepMeta: Array<{
    id: OnboardingStep;
    label: string;
    complete: boolean;
  }> = [
    { id: "key", label: "Key", complete: state.realtime.available },
    { id: "voice", label: "Voice", complete: true },
    { id: "orb", label: "Orb", complete: true },
    { id: "project", label: "Project", complete: hasProject },
  ];

  async function saveKeyAndContinue(): Promise<void> {
    if (hasApiKey) {
      await onSaveApiKey();
      setStep("voice");
      return;
    }
    if (state.realtime.available) {
      setStep("voice");
      return;
    }
  }

  async function goNext(): Promise<void> {
    if (step === "key") {
      await saveKeyAndContinue();
      return;
    }
    if (isLastStep) {
      onClose();
      return;
    }
    setStep(onboardingStepOrder[Math.min(onboardingStepOrder.length - 1, stepIndex + 1)]);
  }

  function goBack(): void {
    if (!canGoBack) return;
    setStep(onboardingStepOrder[stepIndex - 1]);
  }

  function startProject(mode: "scratch" | "folder"): void {
    onStartProject(mode);
  }

  return (
    <div className="voice-modal-backdrop api-key-backdrop onboarding-backdrop" role="presentation">
      <section className="voice-dialog api-key-dialog onboarding-dialog" aria-label="Codex Voice onboarding">
        <div className="api-key-visual onboarding-visual">
          <div className="onboarding-progress">
            {stepMeta.map((item) => (
              <button
                key={item.id}
                type="button"
                className={[
                  item.id,
                  item.id === step ? "selected" : "",
                  item.complete ? "complete" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                aria-label={`Go to ${item.label}`}
                aria-current={item.id === step ? "step" : undefined}
                title={item.label}
                onClick={() => setStep(item.id)}
              >
                <span className="onboarding-progress-mark" />
              </button>
            ))}
          </div>
          <div className={`onboarding-hero-icon ${step}`} aria-hidden="true">
            <OnboardingStepIcon step={step} orbPresetId={orbPresetId} orbCustomization={orbCustomization} />
          </div>
        </div>

        <div className="onboarding-track-window">
          <div className="onboarding-track" style={{ transform: `translateX(-${stepIndex * 100}%)` }}>
            <article className="onboarding-card">
              <div className="onboarding-card-header">
                <div className="api-key-title-row">
                  <h2>OpenAI API key</h2>
                  <span
                    className={`api-key-status ${health.ok ? "ready" : "broken"}`}
                    tabIndex={health.ok ? undefined : 0}
                    aria-label={health.ok ? "Realtime API key is ready" : health.message}
                    title={health.ok ? "Realtime API key is ready" : undefined}
                  >
                    {!health.ok && <span className="api-key-health-popover">{health.message}</span>}
                  </span>
                </div>
                <button
                  type="button"
                  className="api-key-info-button"
                  aria-label="API key storage details"
                  title="Storage details"
                >
                  <InfoIcon />
                  <span className="api-key-info-popover" role="status">
                    Main creates Realtime client secrets. Saved keys are not sent back to this window.
                  </span>
                </button>
              </div>

              <div className="voice-field api-key-field">
                <div className="api-key-input-wrap">
                  <input
                    id="openai-api-key-onboarding-input"
                    aria-label="OpenAI API key"
                    autoFocus
                    type={revealed ? "text" : "password"}
                    value={apiKey}
                    onChange={(event) => onApiKeyChange(event.target.value)}
                    placeholder={apiKeyInputPlaceholder(state.realtime)}
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

            </article>

            <article className="onboarding-card">
              <div className="onboarding-card-header">
                <div>
                  <h2>Choose a voice</h2>
                  <p>{selectedVoice.displayName} is selected.</p>
                </div>
              </div>

              <div className="onboarding-voice-grid" aria-label="Realtime voice">
                {REALTIME_VOICE_OPTIONS.map((option) => (
                  <button
                    key={option.voice}
                    type="button"
                    className={option.voice === state.realtime.voice ? "selected" : ""}
                    onClick={() => void onVoiceChange(option.voice)}
                  >
                    <strong>{option.displayName}</strong>
                    <small>{option.description}</small>
                  </button>
                ))}
              </div>
            </article>

            <article className="onboarding-card onboarding-orb-card">
              <div className="onboarding-card-header">
                <div>
                  <h2>Pick an orb</h2>
                  <p>{selectedOrb.name} is selected.</p>
                </div>
              </div>
              <VoiceOrbPresetPicker
                value={orbPresetId}
                customization={orbCustomization}
                onChange={onOrbPresetChange}
                onCustomizationChange={onOrbCustomizationChange}
                showCustomization={false}
              />
            </article>

            <article className="onboarding-card onboarding-project-card">
              <div className="onboarding-card-header">
                <div>
                  <h2>Start your first project</h2>
                  <p>{hasProject ? "Project ready." : "Create a clean space or attach a folder."}</p>
                </div>
              </div>

              <div className="onboarding-project-stage">
                <div className="onboarding-project-menu-wrap">
                  <div className="onboarding-project-menu" role="menu">
                    <button type="button" role="menuitem" onClick={() => startProject("scratch")}>
                      <PlusIcon />
                      <span>Start from scratch</span>
                    </button>
                    <button type="button" role="menuitem" onClick={() => startProject("folder")}>
                      <FolderIcon />
                      <span>Use an existing folder</span>
                    </button>
                  </div>
                </div>
              </div>
            </article>
          </div>
        </div>

        <div className="onboarding-actions">
          <button type="button" onClick={onClose}>
            Later
          </button>
          <div>
            <button type="button" disabled={!canGoBack} onClick={goBack}>
              Back
            </button>
            <button
              type="button"
              className="voice-primary"
              disabled={step === "key" && !state.realtime.available && !hasApiKey}
              onClick={() => void goNext()}
            >
              {isLastStep ? "Done" : "Next"}
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}

function OnboardingStepIcon({
  step,
  orbPresetId,
  orbCustomization,
}: {
  step: OnboardingStep;
  orbPresetId: VoiceOrbPresetId;
  orbCustomization: VoiceOrbCustomization;
}): React.ReactElement {
  if (step === "key") return <OnboardingKeyIcon />;
  if (step === "voice") return <OnboardingVoiceIcon />;
  if (step === "orb") {
    return (
      <span className="onboarding-mini-orb" aria-hidden="true">
        <VoiceOrbCanvas
          tone="listening"
          outputLevel={0.42}
          presetId={orbPresetId}
          customization={orbCustomization}
          preview
        />
      </span>
    );
  }
  return <OnboardingFolderIcon />;
}

function OnboardingKeyIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="onboarding-key-icon">
      <circle cx="8.1" cy="12" r="3.15" />
      <path className="key-shaft" d="M11.25 12h8" />
      <path className="key-tooth" d="M16.8 12v2.65M19.25 12v2.15" />
    </svg>
  );
}

function OnboardingVoiceIcon(): React.ReactElement {
  return (
    <span className="onboarding-wave-icon" aria-hidden="true">
      <span />
      <span />
      <span />
      <span />
      <span />
    </span>
  );
}

function OnboardingFolderIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className="onboarding-folder-icon">
      <path className="folder-back" d="M3.75 8.1a2 2 0 0 1 2-2h4.08l1.78 1.95h6.64a2 2 0 0 1 2 2v7.1a2 2 0 0 1-2 2H5.75a2 2 0 0 1-2-2V8.1Z" />
      <path className="folder-lid" d="M3.75 9.75h6.08l1.78-1.7h6.64a2 2 0 0 1 2 2v.9H3.75V9.75Z" />
      <path className="folder-front" d="M3.75 10.85h16.5l-1.28 6.52a2 2 0 0 1-1.96 1.62H5.72a2 2 0 0 1-1.96-1.62L3.75 10.85Z" />
    </svg>
  );
}

function StatusDot({ ready }: { ready: boolean }): React.ReactElement {
  return <span className={`settings-status-dot ${ready ? "ready" : ""}`} aria-hidden="true" />;
}

function VoiceOrbCanvas({
  tone,
  outputLevel,
  presetId,
  customization = defaultVoiceOrbCustomization,
  preview = false,
}: {
  tone: VoiceTone;
  outputLevel: number;
  presetId: VoiceOrbPresetId;
  customization?: VoiceOrbCustomization;
  preview?: boolean;
}): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const toneRef = useRef(tone);
  const outputLevelRef = useRef(outputLevel);
  const presetIdRef = useRef(presetId);
  const customizationRef = useRef(customization);

  useEffect(() => {
    toneRef.current = tone;
  }, [tone]);

  useEffect(() => {
    outputLevelRef.current = outputLevel;
  }, [outputLevel]);

  useEffect(() => {
    presetIdRef.current = presetId;
  }, [presetId]);

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

      const preset = voiceOrbPresetById(presetIdRef.current);
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
      clipOrbShapePath(context, width, height, preset.shape);

      drawOrbPresetBase(context, width, height, preset.id, renderedLevel, cloudPhase);
      drawOrbTint(context, width, height, orbCustomization.accentColor, renderedLevel);
      drawOrbClouds(context, width, height, renderedLevel, cloudPhase, hovering, preset.id);
      const palette = orbWavePalette(preset.id, orbCustomization.accentColor);

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
      drawOrbPresetEdge(context, width, height, preset.shape, preset.id, renderedLevel, orbCustomization);
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

function getIconCloudPath(): Path2D {
  iconCloudPath ??= new Path2D(iconCloudPathData);
  return iconCloudPath;
}

function iconCloudFitRect(width: number, height: number): { x: number; y: number; width: number; height: number } {
  const inset = Math.max(3, Math.min(width, height) * 0.04);
  const availableWidth = Math.max(1, width - inset * 2);
  const availableHeight = Math.max(1, height - inset * 2);
  const sourceAspect = iconCloudSourceBounds.width / iconCloudSourceBounds.height;
  let fittedWidth = availableWidth;
  let fittedHeight = fittedWidth / sourceAspect;

  if (fittedHeight > availableHeight) {
    fittedHeight = availableHeight;
    fittedWidth = fittedHeight * sourceAspect;
  }

  return {
    x: (width - fittedWidth) / 2,
    y: (height - fittedHeight) / 2,
    width: fittedWidth,
    height: fittedHeight,
  };
}

function applyIconCloudPathTransform(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
): number {
  const rect = iconCloudFitRect(width, height);
  const scaleX = rect.width / iconCloudSourceBounds.width;
  const scaleY = rect.height / iconCloudSourceBounds.height;

  context.translate(rect.x + rect.width / 2, rect.y + rect.height / 2);
  context.rotate(iconCloudRotationRadians);
  context.translate(-rect.width / 2, -rect.height / 2);
  context.scale(scaleX, scaleY);
  context.translate(-iconCloudSourceBounds.x, iconCloudSourceBounds.yTop);
  context.scale(1, -1);

  return (scaleX + scaleY) / 2;
}

function clipOrbShapePath(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  shape: VoiceOrbPreset["shape"],
): void {
  if (shape === "cloud") {
    const transform = context.getTransform();
    applyIconCloudPathTransform(context, width, height);
    context.clip(getIconCloudPath());
    context.setTransform(transform);
    return;
  }

  beginSphereShapePath(context, width, height);
  context.clip();
}

function strokeOrbShapePath(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  shape: VoiceOrbPreset["shape"],
): void {
  if (shape === "cloud") {
    const lineWidth = context.lineWidth;
    const scale = applyIconCloudPathTransform(context, width, height);
    context.lineWidth = lineWidth / scale;
    context.stroke(getIconCloudPath());
    return;
  }

  beginSphereShapePath(context, width, height);
  context.stroke();
}

function drawOrbPresetBase(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  presetId: VoiceOrbPresetId,
  level: number,
  phase: number,
): void {
  context.save();
  if (presetId === "aurora") {
    const base = context.createLinearGradient(0, height * 0.04, 0, height);
    base.addColorStop(0, "rgba(255, 255, 250, 0.92)");
    base.addColorStop(0.38, "rgba(225, 255, 255, 0.86)");
    base.addColorStop(0.7, "rgba(68, 198, 255, 0.72)");
    base.addColorStop(1, "rgba(0, 120, 255, 0.82)");
    context.fillStyle = base;
    context.fillRect(0, 0, width, height);
    context.restore();
    return;
  }

  if (presetId === "cloud") {
    const base = context.createLinearGradient(0, height * 0.16, 0, height * 0.9);
    base.addColorStop(0, "rgba(246, 252, 255, 0.96)");
    base.addColorStop(0.28, "rgba(196, 239, 255, 0.92)");
    base.addColorStop(0.62, "rgba(59, 154, 255, 0.92)");
    base.addColorStop(1, "rgba(34, 50, 255, 0.96)");
    context.fillStyle = base;
    context.fillRect(0, 0, width, height);

    context.globalCompositeOperation = "screen";
    context.globalAlpha = 0.32 + level * 0.14;
    context.fillStyle = "rgba(255, 255, 255, 0.75)";
    context.beginPath();
    context.ellipse(
      width * (0.43 + Math.sin(phase) * 0.03),
      height * 0.28,
      width * 0.37,
      height * 0.2,
      -0.1,
      0,
      Math.PI * 2,
    );
    context.fill();
    context.restore();
    return;
  }

  const base = context.createRadialGradient(width * 0.47, height * 0.18, 0, width * 0.5, height * 0.52, width * 0.58);
  base.addColorStop(0, "rgba(245, 252, 255, 0.72)");
  base.addColorStop(0.36, "rgba(82, 128, 170, 0.48)");
  base.addColorStop(0.7, "rgba(21, 30, 48, 0.9)");
  base.addColorStop(1, "rgba(4, 7, 15, 0.98)");
  context.fillStyle = base;
  context.fillRect(0, 0, width, height);
  context.restore();
}

function drawOrbPresetEdge(
  context: CanvasRenderingContext2D,
  width: number,
  height: number,
  shape: VoiceOrbPreset["shape"],
  presetId: VoiceOrbPresetId,
  level: number,
  customization: VoiceOrbCustomization,
): void {
  const accent = rgbaFromHex(customization.accentColor, presetId === "nocturne" ? 0.46 : 0.62);
  const glowScale = 0.48 + customization.glow / 75;
  context.save();
  context.globalCompositeOperation = "screen";
  context.shadowColor =
    accent ??
    (presetId === "cloud"
      ? "rgba(101, 193, 255, 0.68)"
      : presetId === "aurora"
        ? "rgba(161, 232, 255, 0.42)"
        : "rgba(154, 227, 255, 0.44)");
  context.shadowBlur = (7 + level * 16) * glowScale;
  context.strokeStyle =
    rgbaFromHex(customization.accentColor, 0.42) ??
    (presetId === "cloud"
      ? "rgba(205, 241, 255, 0.72)"
      : presetId === "aurora"
        ? "rgba(238, 255, 255, 0.52)"
        : "rgba(213, 245, 255, 0.46)");
  context.lineWidth = presetId === "cloud" ? 2.2 : 1.4;
  strokeOrbShapePath(context, width, height, shape);
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

  const glow = context.createRadialGradient(width * 0.55, height * 0.68, 0, width * 0.5, height * 0.58, width * 0.72);
  glow.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${0.32 + level * 0.18})`);
  glow.addColorStop(0.5, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${0.18 + level * 0.1})`);
  glow.addColorStop(1, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0)`);
  context.globalCompositeOperation = "screen";
  context.globalAlpha = 1;
  context.fillStyle = glow;
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

function scaledGlowAlpha(alpha: number, glow: number): number {
  const normalizedGlow = clampControlValue(glow, defaultVoiceOrbCustomization.glow);
  const scale = normalizedGlow / defaultVoiceOrbCustomization.glow;
  return Math.min(1, Math.max(0, Number((alpha * scale).toFixed(3))));
}

function glowColor(accent: string, alpha: number, glow: number, fallback: string): string {
  return rgbaFromHex(accent, scaledGlowAlpha(alpha, glow)) ?? fallback;
}

function voiceAccentStyle(customization: VoiceOrbCustomization): React.CSSProperties {
  const accent = isHexColor(customization.accentColor)
    ? customization.accentColor
    : defaultVoiceOrbCustomization.accentColor;
  const glow = clampControlValue(customization.glow, defaultVoiceOrbCustomization.glow);
  return {
    "--voice-accent": accent,
    "--voice-accent-soft": rgbaFromHex(accent, 0.22) ?? "rgba(29, 155, 240, 0.22)",
    "--voice-accent-mid": rgbaFromHex(accent, 0.34) ?? "rgba(29, 155, 240, 0.34)",
    "--voice-accent-strong": rgbaFromHex(accent, 0.58) ?? "rgba(29, 155, 240, 0.58)",
    "--voice-glow-faint": glowColor(accent, 0.08, glow, "rgba(29, 155, 240, 0.08)"),
    "--voice-glow-soft": glowColor(accent, 0.13, glow, "rgba(29, 155, 240, 0.13)"),
    "--voice-glow-medium": glowColor(accent, 0.2, glow, "rgba(29, 155, 240, 0.2)"),
    "--voice-glow-strong": glowColor(accent, 0.3, glow, "rgba(29, 155, 240, 0.3)"),
    "--voice-glow-hot": glowColor(accent, 0.42, glow, "rgba(29, 155, 240, 0.42)"),
    "--voice-glow-rim": glowColor(accent, 0.48, glow, "rgba(29, 155, 240, 0.48)"),
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

function orbWavePalette(presetId: VoiceOrbPresetId, accentColor?: string): {
  deep: Array<[number, string]>;
  mid: Array<[number, string]>;
  mist: Array<[number, string]>;
  crest: Array<[number, string]>;
} {
  const accent = accentColor ? rgbFromHex(accentColor) : null;
  if (accent) {
    const light = mixRgb(accent, { r: 255, g: 255, b: 255 }, presetId === "nocturne" ? 0.34 : 0.5);
    const mist = mixRgb(accent, { r: 236, g: 255, b: 255 }, 0.68);
    const deep = mixRgb(accent, { r: 0, g: 24, b: 88 }, presetId === "nocturne" ? 0.58 : 0.34);
    const lowAlpha = presetId === "nocturne" ? 0.1 : 0.16;
    const midAlpha = presetId === "nocturne" ? 0.36 : 0.54;
    const highAlpha = presetId === "nocturne" ? 0.62 : 0.78;

    return {
      deep: [
        [0, rgbaFromRgb(mist, lowAlpha)],
        [0.34, rgbaFromRgb(accent, midAlpha)],
        [0.7, rgbaFromRgb(accent, highAlpha)],
        [1, rgbaFromRgb(deep, presetId === "nocturne" ? 0.9 : 0.96)],
      ],
      mid: [
        [0, "rgba(255, 255, 255, 0.2)"],
        [0.35, rgbaFromRgb(light, presetId === "nocturne" ? 0.3 : 0.48)],
        [0.72, rgbaFromRgb(accent, presetId === "nocturne" ? 0.42 : 0.58)],
        [1, rgbaFromRgb(deep, presetId === "nocturne" ? 0.5 : 0.66)],
      ],
      mist: [
        [0, "rgba(255, 255, 255, 0.42)"],
        [0.48, rgbaFromRgb(mist, presetId === "nocturne" ? 0.18 : 0.28)],
        [1, rgbaFromRgb(accent, presetId === "nocturne" ? 0.12 : 0.2)],
      ],
      crest: [
        [0, "rgba(255, 255, 244, 0)"],
        [0.25, rgbaFromRgb(light, presetId === "nocturne" ? 0.55 : 0.78)],
        [0.58, rgbaFromRgb(mist, presetId === "nocturne" ? 0.46 : 0.68)],
        [1, "rgba(255, 255, 244, 0)"],
      ],
    };
  }

  if (presetId === "cloud") {
    return {
      deep: [
        [0, "rgba(180, 247, 255, 0.08)"],
        [0.35, "rgba(79, 208, 255, 0.36)"],
        [0.72, "rgba(34, 103, 255, 0.74)"],
        [1, "rgba(24, 39, 255, 0.92)"],
      ],
      mid: [
        [0, "rgba(252, 255, 255, 0.22)"],
        [0.4, "rgba(176, 227, 255, 0.46)"],
        [0.78, "rgba(86, 128, 255, 0.52)"],
        [1, "rgba(56, 90, 255, 0.64)"],
      ],
      mist: [
        [0, "rgba(255, 255, 255, 0.46)"],
        [0.5, "rgba(232, 249, 255, 0.28)"],
        [1, "rgba(163, 221, 255, 0.16)"],
      ],
      crest: [
        [0, "rgba(255, 255, 244, 0)"],
        [0.25, "rgba(255, 255, 255, 0.82)"],
        [0.58, "rgba(201, 236, 255, 0.72)"],
        [1, "rgba(255, 255, 244, 0)"],
      ],
    };
  }

  if (presetId === "nocturne") {
    return {
      deep: [
        [0, "rgba(164, 231, 255, 0.04)"],
        [0.3, "rgba(65, 165, 212, 0.2)"],
        [0.66, "rgba(31, 78, 139, 0.52)"],
        [1, "rgba(12, 31, 74, 0.82)"],
      ],
      mid: [
        [0, "rgba(243, 255, 255, 0.12)"],
        [0.36, "rgba(148, 227, 255, 0.24)"],
        [0.72, "rgba(36, 142, 206, 0.32)"],
        [1, "rgba(19, 88, 164, 0.42)"],
      ],
      mist: [
        [0, "rgba(232, 255, 255, 0.24)"],
        [0.5, "rgba(162, 231, 255, 0.14)"],
        [1, "rgba(84, 164, 220, 0.08)"],
      ],
      crest: [
        [0, "rgba(203, 246, 255, 0)"],
        [0.28, "rgba(203, 246, 255, 0.46)"],
        [0.6, "rgba(143, 221, 255, 0.4)"],
        [1, "rgba(203, 246, 255, 0)"],
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
  presetId: VoiceOrbPresetId,
): void {
  const lift = level * height * 0.08;
  const hoverLift = hovering ? height * 0.015 : 0;
  const cloudAlpha = presetId === "nocturne" ? 0.2 : 0.42;
  const cloudWhite = presetId === "nocturne" ? "rgba(210, 246, 255, 0.4)" : "rgba(255, 255, 246, 0.7)";

  context.save();
  context.globalCompositeOperation = "screen";
  context.filter = `blur(${8 + level * 5}px)`;
  context.globalAlpha = cloudAlpha + level * 0.26;

  const topGradient = context.createRadialGradient(
    width * (0.46 + Math.sin(phase * 0.9) * 0.05),
    height * (0.2 + Math.cos(phase * 0.7) * 0.025),
    0,
    width * 0.5,
    height * 0.22,
    width * 0.58,
  );
  topGradient.addColorStop(0, cloudWhite);
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
  const title = mode === "onboarding" ? "Connect OpenAI" : "OpenAI API key";
  const primaryLabel =
    realtime.apiKeySource === "saved" ? "Replace" : mode === "onboarding" ? "Save key" : "Save";
  const secondaryLabel = mode === "onboarding" ? "Later" : "Cancel";
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
};

function ProjectChatsPanel({
  chats,
  onNewChat,
  onSwitchChat,
  onSelectChat,
  onOpenChatMenu,
}: {
  chats: ChatSummary[];
  onNewChat: () => void;
  onSwitchChat: () => void;
  onSelectChat: (chatId: string) => Promise<void>;
  onOpenChatMenu: (event: React.MouseEvent<HTMLElement>, chat: ChatSummary) => void;
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
          <button
            key={chat.id}
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
                  await window.codexVoice.openVoiceWindow();
                  await onLogEvent({
                    at: new Date().toISOString(),
                    source: "app",
                    kind: "debug/startOnboarding",
                    message: "Show onboarding requested from Debug UI.",
                  });
                })
              }
            >
              Show onboarding
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
            <h2>Event Log</h2>
            <button onClick={() => void onClearEvents()}>Clear</button>
          </div>
          <div className="event-list">
            {events.map((event, index) => (
              <article key={`${event.at}-${index}`} className={`event ${event.source}`}>
                <div>
                  <strong>{event.kind}</strong>
                  <span>{event.source}</span>
                  <time>{new Date(event.at).toLocaleTimeString()}</time>
                </div>
                <p>{event.message}</p>
              </article>
            ))}
            {events.length === 0 && <p className="empty">No events yet.</p>}
          </div>
        </section>
      </section>
    </main>
  );
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
    };
  });
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

function LeftPaneIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.6" y="4.4" width="14.8" height="15.2" rx="3" />
      <path d="M9.6 7.2v9.6" />
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
