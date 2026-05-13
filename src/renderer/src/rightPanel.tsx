import React, { useEffect, useState } from "react";
import { transcriptMessageFromEvent } from "../../shared/transcriptMessages";
import type {
  ActiveThreadSummary,
  AppEvent,
  AppState,
  CodexTodoItem,
  PendingCodexRequest,
  PendingRequestQuestion,
  ThreadProgressItem,
  ToolQuestionAnswer,
  VoiceChat,
  VoiceTranscriptMessage,
} from "../../shared/types";

type RightPanelTabId = "transcript" | "approvals" | "todos";

export function RightPanel({
  open,
  state,
  events,
  activateTranscriptRequest,
  inspectedThread,
  onClose,
  onAction,
}: {
  open: boolean;
  state: AppState;
  events: AppEvent[];
  activateTranscriptRequest: number;
  inspectedThread: { threadId: string; label: string } | null;
  onClose: () => void;
  onAction: (action: () => Promise<unknown>) => Promise<void>;
}): React.ReactElement {
  const [activeTabId, setActiveTabId] = useState<RightPanelTabId>("transcript");
  const [messages, setMessages] = useState<VoiceTranscriptMessage[]>([]);
  const [threadSummary, setThreadSummary] = useState<ActiveThreadSummary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeChat = activeChatForState(state);
  const todos = todosForActiveChat(state, activeChat);
  const inspectedRequests = inspectedThread
    ? state.runtime.pendingRequests.filter((request) => request.threadId === inspectedThread.threadId)
    : state.runtime.pendingRequests;
  const inspectedProgress = inspectedThread ? threadSummary?.progress ?? [] : [];
  const tabs: Array<{ id: RightPanelTabId; title: string; count?: number }> = [
    { id: "transcript", title: "Transcript" },
    { id: "approvals", title: "Approvals", count: inspectedRequests.length },
    { id: "todos", title: inspectedThread ? "Progress" : "Todos", count: inspectedThread ? inspectedProgress.length : todos.length },
  ];

  useEffect(() => {
    if (!open || activateTranscriptRequest === 0) return;
    setActiveTabId("transcript");
  }, [activateTranscriptRequest, open]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    const chatId = activeChat?.id;
    if (!chatId) {
      setMessages([]);
      setError(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void window.codexVoice
      .getTranscriptMessages(chatId)
      .then((nextMessages) => {
        if (cancelled) return;
        setMessages(nextMessages);
        setError(null);
      })
      .catch((caught) => {
        if (!cancelled) setError(errorMessage(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [activeChat?.id, open]);

  useEffect(() => {
    if (!open || !inspectedThread) {
      setThreadSummary(null);
      return;
    }
    let cancelled = false;
    void window.codexVoice
      .getThreadSummary(inspectedThread.threadId)
      .then((summary) => {
        if (!cancelled) setThreadSummary(summary);
      })
      .catch(() => {
        if (!cancelled) setThreadSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [inspectedThread?.threadId, open]);

  function activateRelativeTab(offset: number): void {
    const index = tabs.findIndex((tab) => tab.id === activeTabId);
    const nextIndex = (Math.max(0, index) + offset + tabs.length) % tabs.length;
    setActiveTabId(tabs[nextIndex].id);
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
      setActiveTabId(tabs[0].id);
    } else if (event.key === "End") {
      event.preventDefault();
      setActiveTabId(tabs.at(-1)?.id ?? "approvals");
    }
  }

  return (
    <aside
      className="voice-future-pane voice-right-panel"
      aria-hidden={!open}
      inert={!open}
      aria-label="Codex right panel"
    >
      <div className="voice-right-inner">
        <div className="voice-right-tabbar">
          <div className="voice-right-tabs" role="tablist" aria-label="Right panel tabs" onKeyDown={handleTabListKeyDown}>
            {tabs.map((tab) => (
              <div key={tab.id} className={`voice-right-tab-shell ${tab.id === activeTabId ? "active" : ""}`}>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab.id === activeTabId}
                  aria-controls={`voice-right-panel-${tab.id}`}
                  id={`voice-right-tab-${tab.id}`}
                  onClick={() => setActiveTabId(tab.id)}
                >
                  <PanelIcon />
                  <span>{tab.title}</span>
                  {tab.count ? <b>{tab.count}</b> : null}
                </button>
              </div>
            ))}
          </div>
        </div>

        <section
          className={`voice-right-body ${activeTabId === "transcript" ? "transcript-active" : ""}`}
          role="tabpanel"
          id={`voice-right-panel-${activeTabId}`}
          aria-labelledby={`voice-right-tab-${activeTabId}`}
        >
          {inspectedThread && (
            <ThreadInspectBanner inspectedThread={inspectedThread} summary={threadSummary} />
          )}
          {activeTabId === "transcript" && (
            inspectedThread ? (
              <ThreadSummaryTranscript summary={threadSummary} label={inspectedThread.label} />
            ) : (
              <TranscriptTab
                chatId={activeChat?.id ?? null}
                events={events}
                loading={loading}
                error={error}
                messages={messages}
              />
            )
          )}
          {activeTabId === "approvals" && (
            <ApprovalsTab requests={inspectedRequests} onAction={onAction} />
          )}
          {activeTabId === "todos" && (
            inspectedThread ? (
              <ThreadProgressTab progress={inspectedProgress} label={inspectedThread.label} />
            ) : (
              <TodosTab todos={todos} chatName={activeChat?.displayName ?? null} />
            )
          )}
        </section>
      </div>
    </aside>
  );
}

function ThreadInspectBanner({
  inspectedThread,
  summary,
}: {
  inspectedThread: { threadId: string; label: string };
  summary: ActiveThreadSummary | null;
}): React.ReactElement {
  return (
    <div className="voice-thread-inspect">
      <span>
        <small>Inspecting</small>
        <strong>{inspectedThread.label}</strong>
      </span>
      <code>{summary?.latestTurnStatus ?? summary?.status ?? inspectedThread.threadId}</code>
    </div>
  );
}

function ThreadSummaryTranscript({
  summary,
  label,
}: {
  summary: ActiveThreadSummary | null;
  label: string;
}): React.ReactElement {
  if (!summary) {
    return <RightPanelEmpty title="Loading thread" detail={`Loading ${label}.`} />;
  }
  if (summary.status !== "ready") {
    return <RightPanelEmpty title="Thread unavailable" detail={summary.errorMessage ?? "Could not load this thread."} />;
  }
  const entries = summary.turns.flatMap((turn) => [
    ...(turn.userText ? [{ id: `${turn.id}:user`, role: "user" as const, text: turn.userText }] : []),
    ...(turn.assistantText ? [{ id: `${turn.id}:assistant`, role: "assistant" as const, text: turn.assistantText }] : []),
  ]);
  if (entries.length === 0) {
    return <RightPanelEmpty title="No thread messages" detail={`${label} has no readable messages yet.`} />;
  }
  return (
    <div className="voice-transcript-list">
      {entries.map((message) => (
        <article key={message.id} className={`voice-transcript-entry ${message.role}`}>
          <span>{message.role === "user" ? "User" : "Codex"}</span>
          <p>{message.text}</p>
        </article>
      ))}
    </div>
  );
}

function TodosTab({
  todos,
  chatName,
}: {
  todos: CodexTodoItem[];
  chatName: string | null;
}): React.ReactElement {
  if (todos.length === 0) {
    return (
      <RightPanelEmpty
        title="No live todos"
        detail={chatName ? `App-server todos for ${chatName} will appear here.` : "Select a chat with live todos."}
      />
    );
  }
  return (
    <div className="voice-todo-list">
      {todos.map((todo) => (
        <article key={todo.id} className={`voice-todo-row ${todo.status}`}>
          <span aria-hidden="true" />
          <p>{todo.text}</p>
          <small>{todo.status.replace("_", " ")}</small>
        </article>
      ))}
    </div>
  );
}

function ThreadProgressTab({
  progress,
  label,
}: {
  progress: ThreadProgressItem[];
  label: string;
}): React.ReactElement {
  if (progress.length === 0) {
    return <RightPanelEmpty title="No thread progress" detail={`${label} has no live progress items.`} />;
  }
  return (
    <div className="voice-todo-list">
      {progress.map((item) => (
        <article key={item.id} className={`voice-todo-row ${progressTodoClass(item.status)}`}>
          <span aria-hidden="true" />
          <p>{item.detail ? `${item.label}: ${item.detail}` : item.label}</p>
          <small>{item.status.replace("_", " ")}</small>
        </article>
      ))}
    </div>
  );
}

function TranscriptTab({
  chatId,
  events,
  loading,
  error,
  messages,
}: {
  chatId: string | null;
  events: AppEvent[];
  loading: boolean;
  error: string | null;
  messages: VoiceTranscriptMessage[];
}): React.ReactElement {
  const entries = transcriptEntries(messages, events, chatId);
  if (entries.length === 0) {
    return (
      <RightPanelEmpty
        title={loading ? "Loading transcript" : "No transcript yet"}
        detail={error ?? "Realtime voice messages will appear here."}
      />
    );
  }

  return (
    <div className="voice-transcript-list">
      {entries.map((message) => (
        <article key={message.id} className={`voice-transcript-entry ${message.role}`}>
          <span>{message.role === "user" ? "You" : "Realtime"}</span>
          <p>{message.text}</p>
        </article>
      ))}
      {error && <p className="voice-right-inline-empty">{error}</p>}
    </div>
  );
}

function transcriptEntries(
  storedMessages: VoiceTranscriptMessage[],
  events: AppEvent[],
  chatId: string | null,
): VoiceTranscriptMessage[] {
  const byId = new Map<string, VoiceTranscriptMessage>();
  for (const message of storedMessages) {
    if (!chatId || message.chatId === chatId) byId.set(message.id, message);
  }

  for (const event of [...events].reverse()) {
    const message = transcriptMessageFromEvent(event);
    if (!message || (chatId && message.chatId !== chatId)) continue;
    const existing = byId.get(message.id);
    if (!existing || message.status === "completed" || message.text.length >= existing.text.length) {
      byId.set(message.id, message);
    }
  }

  return [...byId.values()].sort((left, right) =>
    (left.completedAt ?? left.createdAt).localeCompare(right.completedAt ?? right.createdAt),
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
            <button
              type="button"
              className="primary"
              onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "accept"))}
            >
              Accept
            </button>
          )}
          {(request.options ?? []).includes("acceptForSession") && (
            <button
              type="button"
              onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "acceptForSession"))}
            >
              Session
            </button>
          )}
          {(request.options ?? []).includes("decline") && (
            <button
              type="button"
              onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "decline"))}
            >
              Decline
            </button>
          )}
          {(request.options ?? ["cancel"]).includes("cancel") && (
            <button
              type="button"
              className="danger"
              onClick={() => void onAction(() => window.codexVoice.answerApproval(request.requestId, "cancel"))}
            >
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

function SectionHeader({
  title,
  detail,
}: {
  title: string;
  detail?: string | null;
}): React.ReactElement {
  return (
    <header className="voice-right-section-header">
      <span>
        <h3>{title}</h3>
        {detail && <small>{detail}</small>}
      </span>
    </header>
  );
}

function RightPanelEmpty({
  title,
  detail,
}: {
  title: string;
  detail: string;
}): React.ReactElement {
  return (
    <div className="voice-right-empty">
      <span aria-hidden="true">
        <PanelIcon />
      </span>
      <h3>{title}</h3>
      <p>{detail}</p>
    </div>
  );
}

function InlineEmpty({ children }: { children: React.ReactNode }): React.ReactElement {
  return <p className="voice-right-inline-empty">{children}</p>;
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

function todosForActiveChat(state: AppState, activeChat: VoiceChat | null): CodexTodoItem[] {
  if (!activeChat) return [];
  const runtime = state.runtime.chats.find((chat) => chat.chatId === activeChat.id);
  return runtime?.todos ?? [];
}

function progressTodoClass(status: ThreadProgressItem["status"]): CodexTodoItem["status"] {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "in_progress";
  return "pending";
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function PanelIcon(): React.ReactElement {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="4.5" y="4.5" width="15" height="15" rx="3" />
      <path d="M14 7.5v9" />
    </svg>
  );
}
