import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActiveThreadSummary,
  AppEvent,
  AppState,
  GitChangeSummary,
  PendingCodexRequest,
  PendingRequestQuestion,
  RightPanelPreviewResult,
  ThreadArtifactCandidate,
  ThreadSourceCandidate,
  ToolQuestionAnswer,
  VoiceChat,
} from "../../shared/types";
import { VoiceTranscriptContent } from "./voiceTranscript";

type BuiltInTabId =
  | "overview"
  | "transcript"
  | "summary"
  | "activity"
  | "approvals"
  | "last-output"
  | "chats"
  | "changes"
  | "runtime";

type RightPanelTab =
  | { id: BuiltInTabId; kind: "builtIn"; title: string; closeable: boolean }
  | {
      id: string;
      kind: "file" | "url" | "source" | "artifact";
      title: string;
      subtitle: string | null;
      path?: string;
      url?: string;
      workspacePath?: string | null;
      mimeType?: string | null;
      raw?: unknown;
      closeable: true;
    };

type PreviewRightPanelTab = Extract<RightPanelTab, { kind: "file" | "url" | "source" | "artifact" }>;

type RemoteState<T> =
  | { status: "idle" | "loading"; data: T | null; error: string | null }
  | { status: "ready"; data: T; error: null }
  | { status: "error"; data: T | null; error: string };

const builtInTabs: Array<RightPanelTab & { id: BuiltInTabId; kind: "builtIn" }> = [
  { id: "overview", kind: "builtIn", title: "Overview", closeable: true },
  { id: "transcript", kind: "builtIn", title: "Transcript", closeable: true },
  { id: "summary", kind: "builtIn", title: "Summary", closeable: true },
  { id: "activity", kind: "builtIn", title: "Activity", closeable: true },
  { id: "approvals", kind: "builtIn", title: "Approvals", closeable: true },
  { id: "last-output", kind: "builtIn", title: "Last Output", closeable: true },
  { id: "chats", kind: "builtIn", title: "Chats", closeable: true },
  { id: "changes", kind: "builtIn", title: "Changes", closeable: true },
  { id: "runtime", kind: "builtIn", title: "Runtime", closeable: true },
];

const defaultTabs = builtInTabs.filter((tab) => tab.id === "transcript");
const tabsStorageKey = "codexVoice.rightPanel.tabs";
const tabsStorageVersionKey = "codexVoice.rightPanel.tabsVersion";
const tabsStorageVersion = "4";
const activeTabStorageKey = "codexVoice.rightPanel.activeTab";
const minPanelWidth = 320;
const maxPanelWidth = 720;

export function RightPanel({
  open,
  state,
  events,
  width,
  onWidthChange,
  onClose,
  onAction,
}: {
  open: boolean;
  state: AppState;
  events: AppEvent[];
  width: number;
  onWidthChange: (width: number) => void;
  onClose: () => void;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  const [tabs, setTabs] = useState<RightPanelTab[]>(() => loadTabs());
  const [activeTabId, setActiveTabId] = useState<string>(() => loadActiveTabId());
  const [tabMenuOpen, setTabMenuOpen] = useState(false);
  const [draggedTabId, setDraggedTabId] = useState<string | null>(null);
  const [summaryState, setSummaryState] = useState<RemoteState<ActiveThreadSummary>>({
    status: "idle",
    data: null,
    error: null,
  });
  const [gitState, setGitState] = useState<RemoteState<GitChangeSummary>>({
    status: "idle",
    data: null,
    error: null,
  });
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const activeProject = state.activeProject;
  const activeChat = useMemo(() => activeChatForState(state), [state]);
  const workspacePath = activeProject?.workspacePath ?? activeProject?.folderPath ?? null;
  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0] ?? null;
  const missingBuiltIns = builtInTabs.filter((builtIn) => !tabs.some((tab) => tab.id === builtIn.id));

  useEffect(() => {
    const normalized = normalizeTabSet(tabs);
    if (normalized === tabs) return;
    setTabs(normalized);
    if (!normalized.some((tab) => tab.id === activeTabId)) {
      setActiveTabId(normalized[0]?.id ?? "transcript");
    }
  }, [activeTabId, tabs]);

  useEffect(() => {
    persistTabs(tabs);
  }, [tabs]);

  useEffect(() => {
    if (!tabs.some((tab) => tab.id === activeTabId)) {
      setActiveTabId(tabs[0]?.id ?? "transcript");
    }
  }, [activeTabId, tabs]);

  useEffect(() => {
    persistActiveTabId(activeTabId);
  }, [activeTabId]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    void refreshSummary();
  }, [
    open,
    state.runtime.activeChatId,
    state.runtime.activeTurnId,
    state.runtime.status,
    activeProject?.updatedAt,
    activeChat?.lastTurnOutput?.turnId,
  ]);

  useEffect(() => {
    if (!open) return;
    void refreshGit();
  }, [open, workspacePath]);

  async function refreshSummary(): Promise<void> {
    setSummaryState((current) => ({ status: "loading", data: current.data, error: null }));
    try {
      const data = await window.codexVoice.getActiveThreadSummary(state.runtime.activeChatId ?? undefined);
      setSummaryState({ status: "ready", data, error: null });
    } catch (caught) {
      setSummaryState({ status: "error", data: null, error: errorMessage(caught) });
    }
  }

  async function refreshGit(): Promise<void> {
    setGitState((current) => ({ status: "loading", data: current.data, error: null }));
    try {
      const data = await window.codexVoice.getGitChangeSummary(workspacePath);
      setGitState({ status: "ready", data, error: null });
    } catch (caught) {
      setGitState({ status: "error", data: null, error: errorMessage(caught) });
    }
  }

  function openTab(tab: RightPanelTab): void {
    setTabs((current) => {
      const existing = current.find((candidate) => candidate.id === tab.id);
      if (existing) return current;
      return [...current, tab];
    });
    setActiveTabId(tab.id);
    setTabMenuOpen(false);
  }

  function openBuiltInTab(id: BuiltInTabId): void {
    const tab = builtInTabs.find((candidate) => candidate.id === id);
    if (tab) openTab(tab);
  }

  function openArtifactTab(artifact: ThreadArtifactCandidate): void {
    openTab({
      id: artifactTabId(artifact, workspacePath),
      kind: artifact.kind === "url" ? "url" : "artifact",
      title: artifact.title,
      subtitle: artifact.subtitle,
      path: artifact.path,
      url: artifact.url,
      workspacePath,
      mimeType: artifact.mimeType,
      raw: artifact.raw,
      closeable: true,
    });
  }

  function openSourceTab(source: ThreadSourceCandidate): void {
    openTab({
      id: sourceTabId(source, workspacePath),
      kind: source.url ? "url" : source.path ? "file" : "source",
      title: source.title,
      subtitle: source.subtitle,
      path: source.path,
      url: source.url,
      workspacePath,
      raw: source.raw,
      closeable: true,
    });
  }

  function closeTab(tabId: string): void {
    setTabs((current) => {
      const next = current.filter((tab) => tab.id !== tabId);
      if (tabId === activeTabId) {
        const index = current.findIndex((tab) => tab.id === tabId);
        setActiveTabId(next[Math.max(0, index - 1)]?.id ?? next[0]?.id ?? "transcript");
      }
      return next;
    });
  }

  function reorderTabs(targetId: string): void {
    if (!draggedTabId || draggedTabId === targetId) return;
    setTabs((current) => {
      const fromIndex = current.findIndex((tab) => tab.id === draggedTabId);
      const toIndex = current.findIndex((tab) => tab.id === targetId);
      if (fromIndex < 0 || toIndex < 0) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
    setDraggedTabId(null);
  }

  function activateRelativeTab(offset: number): void {
    if (tabs.length === 0) return;
    const index = Math.max(0, tabs.findIndex((tab) => tab.id === activeTabId));
    const nextIndex = (index + offset + tabs.length) % tabs.length;
    const nextId = tabs[nextIndex].id;
    setActiveTabId(nextId);
    window.requestAnimationFrame(() => tabRefs.current.get(nextId)?.focus());
  }

  function handleTabListKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      activateRelativeTab(1);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      activateRelativeTab(-1);
    } else if (event.key === "Home") {
      event.preventDefault();
      const first = tabs[0]?.id;
      if (first) setActiveTabId(first);
    } else if (event.key === "End") {
      event.preventDefault();
      const last = tabs.at(-1)?.id;
      if (last) setActiveTabId(last);
    } else if (event.key === "Delete" && activeTab?.closeable) {
      event.preventDefault();
      closeTab(activeTab.id);
    }
  }

  function startResize(event: React.PointerEvent<HTMLDivElement>): void {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = width;
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);
    const onMove = (moveEvent: PointerEvent) => {
      onWidthChange(clamp(startWidth + startX - moveEvent.clientX, minPanelWidth, maxPanelWidth));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function resizeWithKeyboard(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      onWidthChange(clamp(width + 24, minPanelWidth, maxPanelWidth));
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      onWidthChange(clamp(width - 24, minPanelWidth, maxPanelWidth));
    }
  }

  return (
    <aside
      className="voice-future-pane voice-right-panel"
      aria-hidden={!open}
      inert={!open}
      aria-label="Codex right panel"
    >
      <div
        className="voice-right-resizer"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize right panel"
        aria-valuemin={minPanelWidth}
        aria-valuemax={maxPanelWidth}
        aria-valuenow={Math.round(width)}
        tabIndex={open ? 0 : -1}
        onPointerDown={startResize}
        onKeyDown={resizeWithKeyboard}
      />

      <div className="voice-right-inner">
        <header className="voice-right-header">
          <div>
            <h2>Context</h2>
            <small>{activeProject?.displayName ?? "No active project"}</small>
          </div>
        </header>

        <div className="voice-right-tabbar">
          <div
            className="voice-right-tabs"
            role="tablist"
            aria-label="Right panel tabs"
            onKeyDown={handleTabListKeyDown}
          >
            {tabs.map((tab) => (
              <div
                key={tab.id}
                className={`voice-right-tab-shell ${tab.id === activeTabId ? "active" : ""}`}
                draggable
                onDragStart={() => setDraggedTabId(tab.id)}
                onDragOver={(event) => event.preventDefault()}
                onDrop={() => reorderTabs(tab.id)}
              >
                <button
                  ref={(node) => {
                    if (node) tabRefs.current.set(tab.id, node);
                    else tabRefs.current.delete(tab.id);
                  }}
                  type="button"
                  role="tab"
                  aria-selected={tab.id === activeTabId}
                  aria-controls={`voice-right-panel-${tab.id}`}
                  id={`voice-right-tab-${tab.id}`}
                  title="Drag to reorder"
                  onClick={() => setActiveTabId(tab.id)}
                >
                  <TabIcon kind={tab.kind} />
                  <span>{tab.title}</span>
                </button>
                {tab.closeable && (
                  <button
                    type="button"
                    className="voice-right-tab-close"
                    aria-label={`Close ${tab.title}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      closeTab(tab.id);
                    }}
                  >
                    <CloseSmallIcon />
                  </button>
                )}
              </div>
            ))}
          </div>
          <div className="voice-right-tab-menu-wrap">
            <button
              type="button"
              aria-label="Open right panel tab"
              aria-expanded={tabMenuOpen}
              title="Open tab"
              onClick={() => setTabMenuOpen((current) => !current)}
            >
              <PlusSmallIcon />
            </button>
            {tabMenuOpen && (
              <div className="voice-right-tab-menu" role="menu">
                {missingBuiltIns.length === 0 ? (
                  <span>All built-in tabs are open.</span>
                ) : (
                  missingBuiltIns.map((tab) => (
                    <button key={tab.id} type="button" role="menuitem" onClick={() => openBuiltInTab(tab.id)}>
                      {tab.title}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        <section
          className="voice-right-body"
          role="tabpanel"
          id={activeTab ? `voice-right-panel-${activeTab.id}` : undefined}
          aria-labelledby={activeTab ? `voice-right-tab-${activeTab.id}` : undefined}
        >
          {!activeTab ? (
            <RightPanelEmpty
              title="No open tabs"
              detail="Open Transcript to start."
              actionLabel="Open Transcript"
              onAction={() => openBuiltInTab("transcript")}
            />
          ) : (
            <RightPanelTabContent
              tab={activeTab}
              state={state}
              events={events}
              activeChat={activeChat}
              summaryState={summaryState}
              gitState={gitState}
              workspacePath={workspacePath}
              onAction={onAction}
              onOpenArtifact={openArtifactTab}
              onOpenSource={openSourceTab}
              onOpenBuiltIn={openBuiltInTab}
              onRefreshSummary={refreshSummary}
              onRefreshGit={refreshGit}
            />
          )}
        </section>
      </div>
    </aside>
  );
}

function RightPanelTabContent({
  tab,
  state,
  events,
  activeChat,
  summaryState,
  gitState,
  workspacePath,
  onAction,
  onOpenArtifact,
  onOpenSource,
  onOpenBuiltIn,
  onRefreshSummary,
  onRefreshGit,
}: {
  tab: RightPanelTab;
  state: AppState;
  events: AppEvent[];
  activeChat: VoiceChat | null;
  summaryState: RemoteState<ActiveThreadSummary>;
  gitState: RemoteState<GitChangeSummary>;
  workspacePath: string | null;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
  onOpenArtifact: (artifact: ThreadArtifactCandidate) => void;
  onOpenSource: (source: ThreadSourceCandidate) => void;
  onOpenBuiltIn: (tab: BuiltInTabId) => void;
  onRefreshSummary: () => Promise<void>;
  onRefreshGit: () => Promise<void>;
}): React.ReactElement {
  if (tab.kind === "file" || tab.kind === "url" || tab.kind === "artifact" || tab.kind === "source") {
    return <PreviewTab tab={tab} workspacePath={workspacePath} />;
  }

  if (tab.id === "overview") {
    return (
      <OverviewTab
        state={state}
        activeChat={activeChat}
        summaryState={summaryState}
        gitState={gitState}
        onOpenBuiltIn={onOpenBuiltIn}
      />
    );
  }
  if (tab.id === "transcript") {
    return (
      <div className="voice-right-transcript-tab">
        <VoiceTranscriptContent open state={state} events={events} summary={summaryState.data} />
      </div>
    );
  }
  if (tab.id === "summary") {
    return (
      <SummaryTab
        summaryState={summaryState}
        gitState={gitState}
        onOpenArtifact={onOpenArtifact}
        onOpenSource={onOpenSource}
        onOpenBuiltIn={onOpenBuiltIn}
        onRefreshSummary={onRefreshSummary}
        onRefreshGit={onRefreshGit}
      />
    );
  }
  if (tab.id === "activity") return <ActivityTab events={events} state={state} />;
  if (tab.id === "approvals") return <ApprovalsTab requests={state.runtime.pendingRequests} onAction={onAction} />;
  if (tab.id === "last-output") return <LastOutputTab activeChat={activeChat} />;
  if (tab.id === "chats") return <ChatsTab state={state} />;
  if (tab.id === "changes") return <ChangesTab gitState={gitState} onRefreshGit={onRefreshGit} />;
  return <RuntimeTab state={state} summaryState={summaryState} gitState={gitState} />;
}

function OverviewTab({
  state,
  activeChat,
  summaryState,
  gitState,
  onOpenBuiltIn,
}: {
  state: AppState;
  activeChat: VoiceChat | null;
  summaryState: RemoteState<ActiveThreadSummary>;
  gitState: RemoteState<GitChangeSummary>;
  onOpenBuiltIn: (tab: BuiltInTabId) => void;
}): React.ReactElement {
  const activeProject = state.activeProject;
  const summary = summaryState.data;
  const git = gitState.data;
  if (!activeProject) {
    return (
      <RightPanelEmpty
        title="No project selected"
        detail="Create or resume a project and this panel will show runtime, thread, files, sources, and changes."
      />
    );
  }

  return (
    <div className="voice-right-stack">
      <section className="voice-right-section">
        <SectionHeader title="Runtime Context" detail={state.runtime.status} />
        <div className="voice-right-metrics">
          <Metric label="Project" value={activeProject.displayName} />
          <Metric label="Chat" value={activeChat?.displayName ?? "No active chat"} />
          <Metric label="Thread" value={activeChat?.codexThreadId ?? "none"} />
          <Metric label="Tokens" value={formatTokenUsage(state.runtime.tokenUsage)} />
        </div>
      </section>

      <section className="voice-right-section">
        <SectionHeader title="Current State" />
        <div className="voice-right-command-grid">
          <button type="button" onClick={() => onOpenBuiltIn("summary")}>
            <strong>{summary?.progress.length ?? 0}</strong>
            <span>Progress</span>
          </button>
          <button type="button" onClick={() => onOpenBuiltIn("approvals")}>
            <strong>{state.runtime.pendingRequests.length}</strong>
            <span>Approvals</span>
          </button>
          <button type="button" onClick={() => onOpenBuiltIn("summary")}>
            <strong>{summary?.artifacts.length ?? 0}</strong>
            <span>Artifacts</span>
          </button>
          <button type="button" onClick={() => onOpenBuiltIn("changes")}>
            <strong>{git?.dirtyCount ?? 0}</strong>
            <span>Changes</span>
          </button>
        </div>
      </section>

      <section className="voice-right-section">
        <SectionHeader title="Last Output" detail={activeChat?.lastTurnOutput?.status ?? "No completed turn yet"} />
        {activeChat?.lastTurnOutput?.finalAssistantText ? (
          <FormattedText text={activeChat.lastTurnOutput.finalAssistantText} compact />
        ) : (
          <InlineEmpty>No final assistant output has been captured yet.</InlineEmpty>
        )}
      </section>
    </div>
  );
}

function SummaryTab({
  summaryState,
  gitState,
  onOpenArtifact,
  onOpenSource,
  onOpenBuiltIn,
  onRefreshSummary,
  onRefreshGit,
}: {
  summaryState: RemoteState<ActiveThreadSummary>;
  gitState: RemoteState<GitChangeSummary>;
  onOpenArtifact: (artifact: ThreadArtifactCandidate) => void;
  onOpenSource: (source: ThreadSourceCandidate) => void;
  onOpenBuiltIn: (tab: BuiltInTabId) => void;
  onRefreshSummary: () => Promise<void>;
  onRefreshGit: () => Promise<void>;
}): React.ReactElement {
  const summary = summaryState.data;
  const git = gitState.data;
  if (summaryState.status === "loading" && !summary) {
    return <RightPanelLoading title="Reading Codex thread" />;
  }
  if (summaryState.status === "error") {
    return (
      <RightPanelEmpty
        title="Thread summary unavailable"
        detail={summaryState.error ?? "Codex Voice could not read the active thread."}
        actionLabel="Retry"
        onAction={() => void onRefreshSummary()}
      />
    );
  }
  if (!summary || summary.status === "empty") {
    return (
      <RightPanelEmpty
        title="No thread summary yet"
        detail={summary?.errorMessage ?? "Start or resume a chat to populate progress, artifacts, and sources."}
        actionLabel="Refresh"
        onAction={() => void onRefreshSummary()}
      />
    );
  }

  return (
    <div className="voice-right-stack">
      <section className="voice-right-section">
        <SectionHeader
          title="Progress"
          detail={summary.latestTurnStatus ? `Latest turn: ${summary.latestTurnStatus}` : null}
          actionLabel="Refresh"
          onAction={() => void onRefreshSummary()}
        />
        <div className="voice-right-row-list">
          {summary.progress.map((item) => (
            <button key={item.id} type="button" className="voice-right-row" onClick={() => onOpenBuiltIn("activity")}>
              <StatusDot status={item.status} />
              <span>
                <strong>{item.label}</strong>
                <small>{item.detail ?? item.sourceType}</small>
              </span>
              <ChevronMini />
            </button>
          ))}
          {summary.progress.length === 0 && <InlineEmpty>No structured progress items in this thread yet.</InlineEmpty>}
        </div>
      </section>

      <section className="voice-right-section">
        <SectionHeader
          title="Branch Details"
          detail={git?.status === "ready" ? [git.branch, git.upstream].filter(Boolean).join(" -> ") : git?.errorMessage ?? null}
          actionLabel="Open"
          onAction={() => onOpenBuiltIn("changes")}
        />
        {gitState.status === "loading" && !git ? (
          <InlineEmpty>Reading git state...</InlineEmpty>
        ) : git?.status === "ready" ? (
          <div className="voice-right-branch-line">
            <span>{git.dirtyCount} changed</span>
            <span>{git.ahead ?? 0} ahead</span>
            <span>{git.behind ?? 0} behind</span>
          </div>
        ) : (
          <InlineEmpty>{git?.status === "not_git" ? "Workspace is not a git repository." : "Git state unavailable."}</InlineEmpty>
        )}
        <button type="button" className="voice-right-link-button" onClick={() => void onRefreshGit()}>
          Refresh branch details
        </button>
      </section>

      <section className="voice-right-section">
        <SectionHeader title="Artifacts" detail={`${summary.artifacts.length} candidates`} />
        <CandidateList
          items={summary.artifacts}
          empty="No artifact or file candidates were found in thread/read."
          onOpen={onOpenArtifact}
        />
      </section>

      <section className="voice-right-section">
        <SectionHeader title="Sources" detail={`${summary.sources.length} candidates`} />
        <SourceList
          items={summary.sources}
          empty="No source indicators were found in thread/read."
          onOpen={onOpenSource}
        />
      </section>

      <section className="voice-right-section">
        <SectionHeader title="Recent Turns" detail={`${summary.turnCount} total`} />
        <div className="voice-right-row-list">
          {summary.turns.slice(-5).reverse().map((turn) => (
            <button key={turn.id} type="button" className="voice-right-row" onClick={() => onOpenBuiltIn("runtime")}>
              <TurnIcon />
              <span>
                <strong>{turn.status}</strong>
                <small>{turn.assistantText ? firstLine(turn.assistantText) : `${turn.itemCount} items`}</small>
              </span>
              <ChevronMini />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function CandidateList({
  items,
  empty,
  onOpen,
}: {
  items: ThreadArtifactCandidate[];
  empty: string;
  onOpen: (item: ThreadArtifactCandidate) => void;
}): React.ReactElement {
  if (items.length === 0) return <InlineEmpty>{empty}</InlineEmpty>;
  return (
    <div className="voice-right-row-list">
      {items.slice(0, 16).map((item) => (
        <button key={item.id} type="button" className="voice-right-row" onClick={() => onOpen(item)}>
          <ArtifactIcon kind={item.kind} />
          <span>
            <strong>{item.title}</strong>
            <small>{item.subtitle ?? item.path ?? item.url ?? item.sourceType}</small>
          </span>
          <ChevronMini />
        </button>
      ))}
    </div>
  );
}

function SourceList({
  items,
  empty,
  onOpen,
}: {
  items: ThreadSourceCandidate[];
  empty: string;
  onOpen: (item: ThreadSourceCandidate) => void;
}): React.ReactElement {
  if (items.length === 0) return <InlineEmpty>{empty}</InlineEmpty>;
  return (
    <div className="voice-right-row-list">
      {items.slice(0, 16).map((item) => (
        <button key={item.id} type="button" className="voice-right-row" onClick={() => onOpen(item)}>
          <SourceIcon kind={item.kind} />
          <span>
            <strong>{item.title}</strong>
            <small>{item.subtitle ?? item.path ?? item.url ?? item.sourceType}</small>
          </span>
          <ChevronMini />
        </button>
      ))}
    </div>
  );
}

function ActivityTab({ events, state }: { events: AppEvent[]; state: AppState }): React.ReactElement {
  const runtimeRows = state.runtime.chats.map((chat) => ({
    id: chat.chatId,
    label: chat.displayName,
    detail: chat.status,
    status: chat.activeTurnId ? "in_progress" : chat.pendingRequests.length > 0 ? "pending" : "unknown",
  }));
  return (
    <div className="voice-right-stack">
      <section className="voice-right-section">
        <SectionHeader title="Live Runtime" detail={state.runtime.threadStatus ?? state.runtime.status} />
        <div className="voice-right-row-list">
          {runtimeRows.map((row) => (
            <div key={row.id} className="voice-right-row static">
              <StatusDot status={row.status as "pending" | "in_progress" | "unknown"} />
              <span>
                <strong>{row.label}</strong>
                <small>{row.detail}</small>
              </span>
            </div>
          ))}
          {runtimeRows.length === 0 && <InlineEmpty>No active chat runtime yet.</InlineEmpty>}
        </div>
      </section>

      <section className="voice-right-section">
        <SectionHeader title="Events" detail={`${events.length} buffered`} />
        <div className="voice-right-event-list">
          {events.slice(0, 80).map((event, index) => (
            <article key={`${event.at}-${index}`} className={`voice-right-event ${event.source}`}>
              <div>
                <strong>{event.kind}</strong>
                <span>{event.source}</span>
                <time>{new Date(event.at).toLocaleTimeString()}</time>
              </div>
              <p>{event.message}</p>
            </article>
          ))}
          {events.length === 0 && <InlineEmpty>Runtime events will appear here.</InlineEmpty>}
        </div>
      </section>
    </div>
  );
}

function ApprovalsTab({
  requests,
  onAction,
}: {
  requests: PendingCodexRequest[];
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  if (requests.length === 0) {
    return <RightPanelEmpty title="No approvals waiting" detail="Codex approval and question prompts will appear here." />;
  }
  return (
    <div className="voice-right-stack">
      {requests.map((request) => (
        <RightPanelRequest key={String(request.requestId)} request={request} onAction={onAction} />
      ))}
    </div>
  );
}

function RightPanelRequest({
  request,
  onAction,
}: {
  request: PendingCodexRequest;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  return (
    <section className={`voice-right-request ${request.kind}`}>
      <SectionHeader
        title={request.title}
        detail={[request.subtitle, request.projectName, request.chatName].filter(Boolean).join(" / ") || null}
      />
      {request.body && <pre>{request.body}</pre>}
      {request.details?.length ? (
        <dl>
          {request.details.map((detail) => (
            <React.Fragment key={`${detail.label}-${detail.value}`}>
              <dt>{detail.label}</dt>
              <dd>{detail.value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
      {request.method === "item/tool/requestUserInput" ? (
        <RightPanelQuestionForm request={request} onAction={onAction} />
      ) : (
        <div className="voice-right-button-row">
          {(request.options ?? ["cancel"]).includes("accept") && (
            <button type="button" className="primary" onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "accept"))}>
              Accept
            </button>
          )}
          {(request.options ?? []).includes("acceptForSession") && (
            <button type="button" onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "acceptForSession"))}>
              Session
            </button>
          )}
          {(request.options ?? []).includes("decline") && (
            <button type="button" onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "decline"))}>
              Decline
            </button>
          )}
          {(request.options ?? ["cancel"]).includes("cancel") && (
            <button type="button" className="danger" onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "cancel"))}>
              Cancel
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function RightPanelQuestionForm({
  request,
  onAction,
}: {
  request: PendingCodexRequest;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  const questions = request.questions?.length ? request.questions : fallbackQuestions(request);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  useEffect(() => setAnswers({}), [request.requestId]);
  const payload: ToolQuestionAnswer[] = questions.map((question) => ({
    questionId: question.id,
    answers: [answers[question.id] || defaultQuestionAnswer(question)].filter(Boolean),
  }));
  const canSubmit = payload.length > 0 && payload.every((answer) => answer.answers.length > 0);
  return (
    <div className="voice-right-question-form">
      {questions.map((question) => (
        <label key={question.id}>
          <span>{question.header}</span>
          <strong>{question.question}</strong>
          {question.options?.length ? (
            <div className="voice-right-option-grid">
              {question.options.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  className={(answers[question.id] ?? defaultQuestionAnswer(question)) === option.label ? "selected" : ""}
                  onClick={() => setAnswers((current) => ({ ...current, [question.id]: option.label }))}
                >
                  {option.label}
                </button>
              ))}
            </div>
          ) : null}
          {question.options?.length && !question.isOther ? null : (
            <input
              type={question.isSecret ? "password" : "text"}
              value={customQuestionAnswer(question, answers[question.id])}
              onChange={(event) => setAnswers((current) => ({ ...current, [question.id]: event.target.value }))}
              placeholder="Answer"
            />
          )}
        </label>
      ))}
      {questions.length === 0 && <InlineEmpty>Question details were not included in the request payload.</InlineEmpty>}
      <button
        type="button"
        className="voice-right-primary-wide"
        disabled={!canSubmit}
        onClick={() => void onAction(() => window.codexVoice.answerToolQuestion(request.requestId, payload))}
      >
        Send Answer
      </button>
    </div>
  );
}

function LastOutputTab({ activeChat }: { activeChat: VoiceChat | null }): React.ReactElement {
  const output = activeChat?.lastTurnOutput;
  if (!activeChat) return <RightPanelEmpty title="No active chat" detail="Select a chat to inspect final Codex output." />;
  if (!output?.finalAssistantText) {
    return <RightPanelEmpty title="No final output yet" detail="Completed Codex turns will appear here for voice context reuse." />;
  }
  return (
    <div className="voice-right-stack">
      <section className="voice-right-section">
        <SectionHeader
          title="Final Assistant Text"
          detail={[output.status, output.durationMs ? formatDuration(output.durationMs) : null].filter(Boolean).join(" / ")}
          actionLabel="Copy"
          onAction={() => void navigator.clipboard.writeText(output.finalAssistantText)}
        />
        <FormattedText text={output.finalAssistantText} />
      </section>
    </div>
  );
}

function ChatsTab({ state }: { state: AppState }): React.ReactElement {
  const project = state.activeProject;
  if (!project) return <RightPanelEmpty title="No active project" detail="Project chats will appear here once a project is selected." />;
  const chats = project.chats.filter((chat) => !chat.archivedAt);
  return (
    <div className="voice-right-stack">
      <section className="voice-right-section">
        <SectionHeader title="Project Chats" detail={`${chats.length} open`} />
        <div className="voice-right-row-list">
          {chats.map((chat) => {
            const runtime = state.runtime.chats.find((candidate) => candidate.chatId === chat.id);
            const active = chat.id === state.runtime.activeChatId;
            return (
              <button
                key={chat.id}
                type="button"
                className={`voice-right-row ${active ? "selected" : ""}`}
                onClick={() => void window.codexVoice.switchChat(chat.id, project.id)}
              >
                <StatusDot status={runtime?.activeTurnId ? "in_progress" : runtime?.pendingRequests.length ? "pending" : "unknown"} />
                <span>
                  <strong>{chat.displayName}</strong>
                  <small>{runtime?.status ?? chat.lastStatus ?? "Idle"}</small>
                </span>
                {active ? <span className="voice-right-pill">Active</span> : <ChevronMini />}
              </button>
            );
          })}
          {chats.length === 0 && <InlineEmpty>No chats in this project yet.</InlineEmpty>}
        </div>
      </section>
    </div>
  );
}

function ChangesTab({
  gitState,
  onRefreshGit,
}: {
  gitState: RemoteState<GitChangeSummary>;
  onRefreshGit: () => Promise<void>;
}): React.ReactElement {
  const git = gitState.data;
  if (gitState.status === "loading" && !git) return <RightPanelLoading title="Reading git context" />;
  if (!git || git.status === "empty") {
    return (
      <RightPanelEmpty
        title="No workspace"
        detail="Set an active project workspace to inspect branch and change context."
      />
    );
  }
  if (git.status === "not_git") {
    return (
      <RightPanelEmpty
        title="Not a git repository"
        detail={git.workspacePath ?? "The active workspace does not have git metadata."}
        actionLabel="Refresh"
        onAction={() => void onRefreshGit()}
      />
    );
  }
  if (git.status === "error") {
    return (
      <RightPanelEmpty
        title="Git unavailable"
        detail={git.errorMessage ?? "Could not read git state."}
        actionLabel="Retry"
        onAction={() => void onRefreshGit()}
      />
    );
  }

  return (
    <div className="voice-right-stack">
      <section className="voice-right-section">
        <SectionHeader title="Branch" detail={git.gitRoot} actionLabel="Refresh" onAction={() => void onRefreshGit()} />
        <div className="voice-right-metrics">
          <Metric label="Branch" value={git.branch ?? "unknown"} />
          <Metric label="Upstream" value={git.upstream ?? "none"} />
          <Metric label="Ahead" value={String(git.ahead ?? 0)} />
          <Metric label="Behind" value={String(git.behind ?? 0)} />
        </div>
        {git.pullRequest && (
          <button
            type="button"
            className="voice-right-pr"
            onClick={() => void window.codexVoice.openRightPanelTarget({ kind: "url", url: git.pullRequest?.url })}
          >
            <strong>PR #{git.pullRequest.number}</strong>
            <span>{git.pullRequest.title}</span>
          </button>
        )}
      </section>

      <section className="voice-right-section">
        <SectionHeader title="Changes" detail={`${git.dirtyCount} dirty paths`} />
        {git.diffStat && <pre className="voice-right-code small">{git.diffStat}</pre>}
        {git.stagedDiffStat && <pre className="voice-right-code small">Staged: {git.stagedDiffStat}</pre>}
        <div className="voice-right-file-list">
          {git.changedFiles.slice(0, 80).map((file) => (
            <span key={file}>{file}</span>
          ))}
          {git.changedFiles.length === 0 && <InlineEmpty>Working tree is clean.</InlineEmpty>}
        </div>
      </section>

      <section className="voice-right-section">
        <SectionHeader title="Recent Commits" />
        <div className="voice-right-row-list">
          {git.recentCommits.map((commit) => (
            <div key={commit.sha} className="voice-right-row static">
              <CommitIcon />
              <span>
                <strong>{commit.title}</strong>
                <small>{commit.sha} {commit.decorated.startsWith("(") ? commit.decorated.match(/^\([^)]*\)/)?.[0] ?? "" : ""}</small>
              </span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function RuntimeTab({
  state,
  summaryState,
  gitState,
}: {
  state: AppState;
  summaryState: RemoteState<ActiveThreadSummary>;
  gitState: RemoteState<GitChangeSummary>;
}): React.ReactElement {
  return (
    <div className="voice-right-stack">
      <section className="voice-right-section">
        <SectionHeader title="Runtime Debug" detail="Raw shapes are kept for unknown thread items." />
        <pre className="voice-right-code">
          {JSON.stringify(
            {
              runtime: state.runtime,
              codexSettings: state.codexSettings,
              summary: summaryState.data,
              git: gitState.data,
            },
            null,
            2,
          )}
        </pre>
      </section>
    </div>
  );
}

function PreviewTab({ tab, workspacePath }: { tab: PreviewRightPanelTab; workspacePath: string | null }): React.ReactElement {
  const [preview, setPreview] = useState<RemoteState<RightPanelPreviewResult>>({
    status: "idle",
    data: null,
    error: null,
  });
  const previewWorkspacePath = tab.workspacePath ?? workspacePath;

  useEffect(() => {
    let cancelled = false;
    setPreview((current) => ({ status: "loading", data: current.data, error: null }));
    const request =
      tab.kind === "url" || tab.url
        ? { kind: "url" as const, url: tab.url }
        : { kind: "file" as const, path: tab.path, workspacePath: previewWorkspacePath };
    void window.codexVoice
      .previewRightPanelTarget(request)
      .then((data) => {
        if (!cancelled) setPreview({ status: "ready", data, error: null });
      })
      .catch((caught) => {
        if (!cancelled) setPreview({ status: "error", data: null, error: errorMessage(caught) });
      });
    return () => {
      cancelled = true;
    };
  }, [tab.id, tab.path, tab.url, previewWorkspacePath]);

  if (preview.status === "loading" && !preview.data) return <RightPanelLoading title={`Loading ${tab.title}`} />;
  if (preview.status === "error") {
    return <RightPanelEmpty title="Preview failed" detail={preview.error ?? "Could not load this target."} />;
  }

  const data = preview.data;
  if (!data) return <RightPanelLoading title="Loading preview" />;
  const openTarget = () => {
    if (data.url) return window.codexVoice.openRightPanelTarget({ kind: "url", url: data.url });
    if (data.path) return window.codexVoice.openRightPanelTarget({ kind: "file", path: data.path });
    if (tab.url) return window.codexVoice.openRightPanelTarget({ kind: "url", url: tab.url });
    if (tab.path) return window.codexVoice.openRightPanelTarget({ kind: "file", path: tab.path, workspacePath: previewWorkspacePath });
    return Promise.resolve();
  };

  return (
    <div className="voice-right-stack">
      <section className="voice-right-section preview-section">
        <SectionHeader
          title={data.title}
          detail={data.subtitle ?? data.mimeType ?? null}
          actionLabel="Open"
          onAction={() => void openTarget()}
        />
        {data.status === "too_large" || data.status === "unsupported" || data.status === "external" ? (
          <RightPanelEmpty
            title={previewStatusTitle(data)}
            detail={data.errorMessage ?? data.subtitle ?? "Open externally to inspect this target."}
            actionLabel="Open"
            onAction={() => void openTarget()}
          />
        ) : data.kind === "image" && data.dataUrl ? (
          <div className="voice-right-image-preview">
            <img src={data.dataUrl} alt={data.title} />
          </div>
        ) : data.kind === "iframe" && data.url ? (
          <iframe
            className="voice-right-url-preview"
            title={data.title}
            src={data.url}
            sandbox="allow-forms allow-scripts allow-same-origin"
          />
        ) : data.text !== undefined ? (
          <>
            <div className="voice-right-preview-toolbar">
              <span>{formatBytes(data.sizeBytes ?? data.text.length)}</span>
              <button type="button" onClick={() => void navigator.clipboard.writeText(data.text ?? "")}>
                Copy
              </button>
            </div>
            {data.kind === "markdown" ? (
              <FormattedText text={data.text} />
            ) : (
              <pre className="voice-right-code">{data.text}</pre>
            )}
          </>
        ) : (
          <RightPanelEmpty title="No preview content" detail="This target did not return previewable content." />
        )}
      </section>
    </div>
  );
}

function FormattedText({ text, compact = false }: { text: string; compact?: boolean }): React.ReactElement {
  const blocks = text.split(/```/g);
  if (blocks.length === 1) {
    return <p className={`voice-right-markdown ${compact ? "compact" : ""}`}>{text}</p>;
  }
  return (
    <div className={`voice-right-markdown ${compact ? "compact" : ""}`}>
      {blocks.map((block, index) =>
        index % 2 === 1 ? (
          <pre key={index} className="voice-right-code">{stripCodeFenceLanguage(block)}</pre>
        ) : (
          block.trim() && <p key={index}>{block.trim()}</p>
        ),
      )}
    </div>
  );
}

function SectionHeader({
  title,
  detail,
  actionLabel,
  onAction,
}: {
  title: string;
  detail?: string | null;
  actionLabel?: string;
  onAction?: () => void;
}): React.ReactElement {
  return (
    <header className="voice-right-section-header">
      <span>
        <h3>{title}</h3>
        {detail && <small>{detail}</small>}
      </span>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </header>
  );
}

function Metric({ label, value }: { label: string; value: string }): React.ReactElement {
  return (
    <div className="voice-right-metric">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function RightPanelEmpty({
  title,
  detail,
  actionLabel,
  onAction,
}: {
  title: string;
  detail: string;
  actionLabel?: string;
  onAction?: () => void;
}): React.ReactElement {
  return (
    <div className="voice-right-empty">
      <span aria-hidden="true">
        <PanelIcon />
      </span>
      <h3>{title}</h3>
      <p>{detail}</p>
      {actionLabel && onAction && (
        <button type="button" onClick={onAction}>
          {actionLabel}
        </button>
      )}
    </div>
  );
}

function RightPanelLoading({ title }: { title: string }): React.ReactElement {
  return (
    <div className="voice-right-empty loading" role="status">
      <span aria-hidden="true" />
      <h3>{title}</h3>
      <p>One moment.</p>
    </div>
  );
}

function InlineEmpty({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="voice-right-inline-empty">{children}</p>;
}

function StatusDot({ status }: { status: "pending" | "in_progress" | "completed" | "failed" | "unknown" }): React.ReactElement {
  return <span className={`voice-right-status-dot ${status}`} aria-hidden="true" />;
}

function loadTabs(): RightPanelTab[] {
  try {
    if (window.localStorage.getItem(tabsStorageVersionKey) !== tabsStorageVersion) {
      return defaultTabs;
    }
    const parsed = JSON.parse(window.localStorage.getItem(tabsStorageKey) ?? "null") as RightPanelTab[] | null;
    if (Array.isArray(parsed) && parsed.length > 0) {
      const normalized = parsed
        .map(normalizeStoredTab)
        .filter((tab): tab is RightPanelTab => tab !== null);
      if (normalized.length > 0) return normalizeTabSet(normalized);
    }
  } catch {
    // Ignore corrupt UI preferences.
  }
  return defaultTabs;
}

function normalizeStoredTab(tab: RightPanelTab): RightPanelTab | null {
  if (!tab || typeof tab !== "object") return null;
  if (tab.kind === "builtIn") {
    return builtInTabs.find((candidate) => candidate.id === tab.id) ?? null;
  }
  return {
    ...tab,
    closeable: true,
  };
}

function persistTabs(tabs: RightPanelTab[]): void {
  try {
    const tabsToPersist = normalizeTabSet(tabs);
    const serializable = tabsToPersist.map((tab) => tab.kind === "builtIn" ? tab : { ...tab, raw: undefined });
    window.localStorage.setItem(tabsStorageVersionKey, tabsStorageVersion);
    window.localStorage.setItem(tabsStorageKey, JSON.stringify(serializable));
  } catch {
    // Ignore storage failures.
  }
}

function normalizeTabSet(tabs: RightPanelTab[]): RightPanelTab[] {
  return isLegacyAllBuiltInTabSet(tabs) ? defaultTabs : tabs;
}

function isLegacyAllBuiltInTabSet(tabs: RightPanelTab[]): boolean {
  if (tabs.length !== builtInTabs.length) return false;
  if (!tabs.every((tab) => tab.kind === "builtIn")) return false;
  const tabIds = new Set(tabs.map((tab) => tab.id));
  return builtInTabs.every((tab) => tabIds.has(tab.id));
}

function loadActiveTabId(): string {
  try {
    if (window.localStorage.getItem(tabsStorageVersionKey) !== tabsStorageVersion) return "transcript";
    return window.localStorage.getItem(activeTabStorageKey) || "transcript";
  } catch {
    return "transcript";
  }
}

function persistActiveTabId(tabId: string): void {
  try {
    window.localStorage.setItem(activeTabStorageKey, tabId);
  } catch {
    // Ignore storage failures.
  }
}

function activeChatForState(state: AppState): VoiceChat | null {
  const project = state.activeProject;
  if (!project) return null;
  const chats = project.chats.filter((chat) => !chat.archivedAt);
  return (
    chats.find((chat) => chat.id === state.runtime.activeChatId) ??
    chats.find((chat) => chat.id === project.activeChatId) ??
    chats[0] ??
    null
  );
}

function fallbackQuestions(request: PendingCodexRequest): PendingRequestQuestion[] {
  const raw = request.raw as { params?: { questions?: unknown }; raw?: { params?: { questions?: unknown } } };
  const value = raw.params?.questions ?? raw.raw?.params?.questions;
  if (!Array.isArray(value)) return [];
  return value
    .map((question, index): PendingRequestQuestion | null => {
      if (!question || typeof question !== "object") return null;
      const record = question as Record<string, unknown>;
      return {
        id: typeof record.id === "string" ? record.id : `question-${index + 1}`,
        header: typeof record.header === "string" ? record.header : `Question ${index + 1}`,
        question: typeof record.question === "string" ? record.question : "Codex is asking for input.",
        isOther: Boolean(record.isOther),
        isSecret: Boolean(record.isSecret),
        options: null,
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

function artifactTabId(artifact: ThreadArtifactCandidate, workspacePath: string | null): string {
  return `artifact:${previewTabScopeKey(artifact.path, artifact.url, artifact.id, workspacePath)}`;
}

function sourceTabId(source: ThreadSourceCandidate, workspacePath: string | null): string {
  return `source:${previewTabScopeKey(source.path, source.url, source.id, workspacePath)}`;
}

function previewTabScopeKey(
  targetPath: string | undefined,
  targetUrl: string | undefined,
  fallbackId: string,
  workspacePath: string | null,
): string {
  if (targetPath && workspacePath && isRelativePreviewPath(targetPath)) return `${workspacePath}:${targetPath}`;
  return targetPath ?? targetUrl ?? fallbackId;
}

function isRelativePreviewPath(value: string): boolean {
  return !value.startsWith("/") && !value.startsWith("~/") && !value.startsWith("file://") && !/^[A-Za-z]:[\\/]/.test(value);
}

function formatTokenUsage(usage: AppState["runtime"]["tokenUsage"]): string {
  if (!usage) return "not reported";
  const total = usage.total.totalTokens;
  if (!usage.modelContextWindow) return `${total.toLocaleString()} tokens`;
  return `${total.toLocaleString()} / ${usage.modelContextWindow.toLocaleString()}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/).find(Boolean)?.slice(0, 180) ?? "";
}

function stripCodeFenceLanguage(value: string): string {
  return value.replace(/^[A-Za-z0-9_-]+\n/, "").trim();
}

function previewStatusTitle(data: RightPanelPreviewResult): string {
  if (data.status === "too_large") return "File is too large to preview";
  if (data.status === "external") return "External preview";
  return "Preview unsupported";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function TabIcon({ kind }: { kind: RightPanelTab["kind"] }): React.ReactElement {
  if (kind === "file" || kind === "artifact") return <FileMiniIcon />;
  if (kind === "url" || kind === "source") return <LinkMiniIcon />;
  return <PanelIcon />;
}

function ArtifactIcon({ kind }: { kind: ThreadArtifactCandidate["kind"] }): React.ReactElement {
  if (kind === "url") return <LinkMiniIcon />;
  if (kind === "file") return <FileMiniIcon />;
  return <ArtifactMiniIcon />;
}

function SourceIcon({ kind }: { kind: ThreadSourceCandidate["kind"] }): React.ReactElement {
  if (kind === "web") return <LinkMiniIcon />;
  if (kind === "file") return <FileMiniIcon />;
  return <ToolMiniIcon />;
}

function PanelIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.5" y="4.5" width="15" height="15" rx="3" />
      <path d="M14 7.5v9" />
    </svg>
  );
}

function CloseSmallIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m7 7 10 10M17 7 7 17" />
    </svg>
  );
}

function PlusSmallIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 5.5v13M5.5 12h13" />
    </svg>
  );
}

function ChevronMini(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function FileMiniIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 3.75h6.5L18 8.25v12H7z" />
      <path d="M13.5 3.75v4.5H18" />
    </svg>
  );
}

function LinkMiniIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M10.5 7.5 12 6a4 4 0 0 1 5.7 5.6l-1.5 1.5" />
      <path d="M13.5 16.5 12 18a4 4 0 0 1-5.7-5.6l1.5-1.5" />
    </svg>
  );
}

function ArtifactMiniIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 7.5 12 4l7 3.5v9L12 20l-7-3.5z" />
      <path d="m5 7.5 7 3.5 7-3.5" />
      <path d="M12 11v9" />
    </svg>
  );
}

function ToolMiniIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M14.5 5.5a4.5 4.5 0 0 0 4 6.9l-6.1 6.1a2.4 2.4 0 0 1-3.4-3.4l6.1-6.1a4.5 4.5 0 0 0-.6-3.5Z" />
    </svg>
  );
}

function TurnIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M5 6.5h14" />
      <path d="M5 12h10" />
      <path d="M5 17.5h7" />
    </svg>
  );
}

function CommitIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 7.5v9" />
      <circle cx="12" cy="6" r="2.2" />
      <circle cx="12" cy="18" r="2.2" />
    </svg>
  );
}
