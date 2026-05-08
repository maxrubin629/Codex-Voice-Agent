import React, { useEffect, useMemo, useRef, useState } from "react";
import type {
  ActiveThreadSummary,
  AppEvent,
  AppState,
  PendingCodexRequest,
  PendingRequestDetail,
  ThreadSummaryItem,
  ThreadSummaryTurn,
  VoiceChat,
} from "../../shared/types";

type MessageTone = "user" | "assistant";
type ActivityIcon = "terminal" | "edit" | "search" | "list" | "globe" | "tool" | "check" | "alert" | "branch" | "spark";
type ActivityTone = "normal" | "muted" | "success" | "warning";

type TranscriptEntry =
  | {
      kind: "message";
      id: string;
      tone: MessageTone;
      body: string;
      streaming?: boolean;
    }
  | {
      kind: "work";
      id: string;
      summary: string;
      active: boolean;
      defaultExpanded: boolean;
      children: TranscriptEntry[];
    }
  | {
      kind: "activity";
      id: string;
      icon: ActivityIcon;
      summary: string;
      active: boolean;
      defaultExpanded: boolean;
      rows: ActivityRow[];
    }
  | {
      kind: "reasoning";
      id: string;
      active: boolean;
      content: string;
      elapsedMs: number | null;
      defaultExpanded: boolean;
    }
  | {
      kind: "status";
      id: string;
      icon: ActivityIcon;
      title: string;
      body?: string;
      rows?: ActivityRow[];
      active?: boolean;
    };

type ActivityRow = {
  id: string;
  icon?: ActivityIcon;
  label: string;
  meta?: string;
  additions?: number;
  deletions?: number;
  tone?: ActivityTone;
};

type TimelineItem =
  | { kind: "entry"; entry: TranscriptEntry }
  | { kind: "turn"; turnId: string };

type TurnDraft = {
  id: string;
  chatId: string | null;
  threadId: string | null;
  startedAtMs: number | null;
  completedAtMs: number | null;
  durationMs: number | null;
  status: string | null;
  userMessages: TranscriptEntry[];
  assistantDraft: string;
  assistantFinal: string | null;
  itemOrder: string[];
  items: Map<string, TurnItemDraft>;
  pendingGroups: TranscriptEntry[];
};

type TurnItemDraft = {
  id: string;
  type: string;
  raw: Record<string, unknown>;
  startedAtMs: number | null;
  completedAtMs: number | null;
  progress: string[];
};

type ActivitySource = {
  id: string;
  category: "exploration" | "file" | "command" | "web" | "tool" | "status";
  icon: ActivityIcon;
  active: boolean;
  rows: ActivityRow[];
  counts: Partial<ActivityCounts>;
  sourceName?: string;
};

type ActivityCounts = {
  created: number;
  edited: number;
  deleted: number;
  explored: number;
  searches: number;
  lists: number;
  commands: number;
  web: number;
  tools: number;
  subagents: number;
  approved: number;
  denied: number;
};

type NormalizedTurnEntry = ActivitySource | Extract<TranscriptEntry, { kind: "reasoning" | "status" }>;

const emptyCounts: ActivityCounts = {
  created: 0,
  edited: 0,
  deleted: 0,
  explored: 0,
  searches: 0,
  lists: 0,
  commands: 0,
  web: 0,
  tools: 0,
  subagents: 0,
  approved: 0,
  denied: 0,
};

export function VoiceTranscriptContent({
  open = true,
  state,
  events,
  summary,
  className,
}: {
  open?: boolean;
  state: AppState;
  events: AppEvent[];
  summary?: ActiveThreadSummary | null;
  className?: string;
}): React.ReactElement {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const entries = useMemo(() => buildTranscriptEntries(events, state, summary ?? null), [events, state, summary]);
  const latestEntryId = entries.length > 0 ? entries[entries.length - 1].id : "";

  useEffect(() => {
    if (!open) return;
    const node = scrollRef.current;
    if (!node) return;
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [latestEntryId, open]);

  return (
    <div ref={scrollRef} className={["voice-transcript-list", className].filter(Boolean).join(" ")}>
      {entries.length === 0 ? (
        <div className="voice-transcript-empty">
          <TranscriptIcon icon="spark" />
          <strong>No messages yet</strong>
          <small>Your conversation and Codex activity will appear here.</small>
        </div>
      ) : (
        entries.map((entry) => <VoiceConversationEntry key={entry.id} entry={entry} />)
      )}
    </div>
  );
}

function VoiceConversationEntry({ entry }: { entry: TranscriptEntry }): React.ReactElement {
  if (entry.kind === "message") {
    if (entry.tone === "user") {
      return (
        <article className="voice-transcript-entry user">
          <p>{entry.body}</p>
        </article>
      );
    }
    return (
      <article className={`voice-transcript-entry assistant${entry.streaming ? " streaming" : ""}`}>
        <MarkdownBlock text={entry.body} />
      </article>
    );
  }

  if (entry.kind === "work") return <WorkEntry entry={entry} />;
  if (entry.kind === "activity") return <ActivityEntry entry={entry} />;
  if (entry.kind === "reasoning") return <ReasoningEntry entry={entry} />;
  return <StatusEntry entry={entry} />;
}

function WorkEntry({ entry }: { entry: Extract<TranscriptEntry, { kind: "work" }> }): React.ReactElement {
  const [expanded, setExpanded] = useState(entry.defaultExpanded);

  useEffect(() => {
    if (entry.active) setExpanded(true);
  }, [entry.active]);

  return (
    <section className={`voice-work-group${entry.active ? " active" : ""}`}>
      <button
        type="button"
        className="voice-work-toggle"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
      >
        <span>{entry.summary}</span>
        <ChevronIcon expanded={expanded} />
      </button>
      {expanded && (
        <div className="voice-work-children">
          {entry.children.map((child) => (
            <VoiceConversationEntry key={child.id} entry={child} />
          ))}
        </div>
      )}
    </section>
  );
}

function ActivityEntry({ entry }: { entry: Extract<TranscriptEntry, { kind: "activity" }> }): React.ReactElement {
  const [expanded, setExpanded] = useState(entry.defaultExpanded);
  const canExpand = entry.rows.length > 0;

  useEffect(() => {
    if (entry.active) setExpanded(true);
  }, [entry.active]);

  return (
    <section className={`voice-activity-group${entry.active ? " active" : ""}`}>
      <button
        type="button"
        className="voice-activity-summary"
        aria-expanded={expanded}
        onClick={() => canExpand && setExpanded((value) => !value)}
      >
        <TranscriptIcon icon={entry.icon} />
        <span>{entry.summary}</span>
        {canExpand && <ChevronIcon expanded={expanded} />}
      </button>
      {expanded && canExpand && (
        <div className="voice-activity-rows">
          {entry.rows.map((row) => (
            <ActivityDetailRow key={row.id} row={row} fallbackIcon={entry.icon} />
          ))}
        </div>
      )}
    </section>
  );
}

function ReasoningEntry({ entry }: { entry: Extract<TranscriptEntry, { kind: "reasoning" }> }): React.ReactElement {
  const [expanded, setExpanded] = useState(entry.defaultExpanded);
  const hasBody = entry.content.trim().length > 0;
  const label = entry.active ? "Thinking" : entry.elapsedMs ? `Thought for ${formatDuration(entry.elapsedMs)}` : "Thought";

  useEffect(() => {
    if (entry.active) setExpanded(true);
  }, [entry.active]);

  return (
    <section className={`voice-reasoning${entry.active ? " active" : ""}`}>
      <button
        type="button"
        className="voice-reasoning-summary"
        aria-expanded={expanded}
        onClick={() => hasBody && setExpanded((value) => !value)}
      >
        <TranscriptIcon icon="spark" />
        <span>{label}</span>
        {hasBody && <ChevronIcon expanded={expanded} />}
      </button>
      {expanded && hasBody && (
        <div className="voice-reasoning-body">
          <MarkdownBlock text={stripReasoningHeading(entry.content)} />
        </div>
      )}
    </section>
  );
}

function StatusEntry({ entry }: { entry: Extract<TranscriptEntry, { kind: "status" }> }): React.ReactElement {
  return (
    <section className={`voice-status-entry${entry.active ? " active" : ""}`}>
      <div className="voice-status-summary">
        <TranscriptIcon icon={entry.icon} />
        <span>{entry.title}</span>
      </div>
      {entry.body && <p>{entry.body}</p>}
      {entry.rows && entry.rows.length > 0 && (
        <div className="voice-activity-rows">
          {entry.rows.map((row) => (
            <ActivityDetailRow key={row.id} row={row} fallbackIcon={entry.icon} />
          ))}
        </div>
      )}
    </section>
  );
}

function ActivityDetailRow({ row, fallbackIcon }: { row: ActivityRow; fallbackIcon: ActivityIcon }): React.ReactElement {
  return (
    <div className={`voice-activity-row ${row.tone ?? "normal"}`}>
      <TranscriptIcon icon={row.icon ?? fallbackIcon} />
      <span className="voice-activity-row-label">{row.label}</span>
      {row.additions !== undefined && <span className="voice-diff-add">+{row.additions}</span>}
      {row.deletions !== undefined && <span className="voice-diff-del">-{row.deletions}</span>}
      {row.meta && <span className="voice-activity-row-meta">{row.meta}</span>}
    </div>
  );
}

function MarkdownBlock({ text }: { text: string }): React.ReactElement {
  return <div className="voice-markdown">{renderMarkdownBlocks(text)}</div>;
}

function renderMarkdownBlocks(markdown: string): React.ReactNode[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const nodes: React.ReactNode[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index] ?? "")) {
        codeLines.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      nodes.push(
        <pre key={`code-${index}`}>
          <code>{codeLines.join("\n")}</code>
        </pre>,
      );
      continue;
    }

    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const level = heading[1].length;
      const content = renderInlineMarkdown(heading[2], `h-${index}`);
      if (level === 1) nodes.push(<h3 key={`h-${index}`}>{content}</h3>);
      else if (level === 2) nodes.push(<h4 key={`h-${index}`}>{content}</h4>);
      else nodes.push(<h5 key={`h-${index}`}>{content}</h5>);
      index += 1;
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index] ?? "")) {
        const item = (lines[index] ?? "").replace(/^\s*[-*]\s+/, "");
        items.push(<li key={`li-${index}`}>{renderInlineMarkdown(item, `li-${index}`)}</li>);
        index += 1;
      }
      nodes.push(<ul key={`ul-${index}`}>{items}</ul>);
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: React.ReactNode[] = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index] ?? "")) {
        const item = (lines[index] ?? "").replace(/^\s*\d+\.\s+/, "");
        items.push(<li key={`oli-${index}`}>{renderInlineMarkdown(item, `oli-${index}`)}</li>);
        index += 1;
      }
      nodes.push(<ol key={`ol-${index}`}>{items}</ol>);
      continue;
    }

    const paragraphLines = [line.trim()];
    index += 1;
    while (
      index < lines.length &&
      lines[index]?.trim() &&
      !/^```/.test(lines[index] ?? "") &&
      !/^(#{1,3})\s+/.test(lines[index] ?? "") &&
      !/^\s*[-*]\s+/.test(lines[index] ?? "") &&
      !/^\s*\d+\.\s+/.test(lines[index] ?? "")
    ) {
      paragraphLines.push((lines[index] ?? "").trim());
      index += 1;
    }
    nodes.push(<p key={`p-${index}`}>{renderInlineMarkdown(paragraphLines.join(" "), `p-${index}`)}</p>);
  }

  return nodes;
}

function renderInlineMarkdown(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text))) {
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index));
    const token = match[0];
    const key = `${keyPrefix}-${match.index}`;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      if (link) {
        nodes.push(
          <a key={key} href={link[2]} target="_blank" rel="noreferrer">
            {link[1]}
          </a>,
        );
      } else {
        nodes.push(token);
      }
    }
    cursor = match.index + token.length;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

function buildTranscriptEntries(
  events: AppEvent[],
  state: AppState,
  summary: ActiveThreadSummary | null,
): TranscriptEntry[] {
  const activeChat = activeChatFromState(state);
  const activeChatId = state.runtime.activeChatId ?? activeChat?.id ?? null;
  const activeThreadId = activeChat?.codexThreadId ?? state.activeProject?.codexThreadId ?? null;
  const chronologicalEvents = [...events].reverse();
  const completedRealtimeStreams = new Set<string>();
  const realtimeStreamingEntryIndexes = new Map<string, number>();
  const seenPendingRequestIds = new Set<string>();
  const turns = new Map<string, TurnDraft>();
  const timeline: TimelineItem[] = [];
  const timelineTurnIds = new Set<string>();

  const ensureTurn = (turnId: string): TurnDraft => {
    const existing = turns.get(turnId);
    if (existing) return existing;
    const turn: TurnDraft = {
      id: turnId,
      chatId: null,
      threadId: null,
      startedAtMs: null,
      completedAtMs: null,
      durationMs: null,
      status: null,
      userMessages: [],
      assistantDraft: "",
      assistantFinal: null,
      itemOrder: [],
      items: new Map(),
      pendingGroups: [],
    };
    turns.set(turnId, turn);
    if (!timelineTurnIds.has(turnId)) {
      timelineTurnIds.add(turnId);
      timeline.push({ kind: "turn", turnId });
    }
    return turn;
  };

  const pushEntry = (entry: TranscriptEntry): void => {
    timeline.push({ kind: "entry", entry });
  };

  hydrateThreadSummary(summary, activeChatId, activeThreadId, ensureTurn);

  for (const event of chronologicalEvents) {
    const raw = recordFromUnknown(event.raw);
    if (event.source === "realtime" && isRealtimeUserTranscript(event.kind)) {
      completedRealtimeStreams.add(realtimeStreamKey("user", raw, event));
    }
    if (event.source === "realtime" && isRealtimeAssistantTranscript(event.kind)) {
      completedRealtimeStreams.add(realtimeStreamKey("assistant", raw, event));
    }
  }

  for (const event of chronologicalEvents) {
    if (!eventBelongsToActiveChat(event, activeChatId, activeThreadId)) continue;
    const raw = recordFromUnknown(event.raw);
    const realtimeDelta = realtimeStreamingEntryFromEvent(event, completedRealtimeStreams);
    if (realtimeDelta) {
      const existingIndex = realtimeStreamingEntryIndexes.get(realtimeDelta.key);
      if (existingIndex !== undefined) {
        const item = timeline[existingIndex];
        if (item?.kind === "entry" && item.entry.kind === "message") {
          item.entry = {
            ...item.entry,
            body: `${item.entry.body}${realtimeDelta.delta}`,
          };
        }
      } else {
        realtimeStreamingEntryIndexes.set(realtimeDelta.key, timeline.length);
        pushEntry(realtimeDelta.entry);
      }
      continue;
    }

    if (event.source === "app" && event.kind === "turnStarted") {
      const text = stringFromUnknown(raw?.text);
      const turnId = stringFromUnknown(raw?.turnId);
      if (text && turnId) {
        const turn = ensureTurn(turnId);
        turn.chatId = stringFromUnknown(raw?.chatId) ?? turn.chatId;
        turn.startedAtMs = turn.startedAtMs ?? dateMs(event.at);
        pushUniqueMessage(turn.userMessages, {
          kind: "message",
          id: `user-${turnId}`,
          tone: "user",
          body: text,
        });
      } else if (text) {
        pushEntry({ kind: "message", id: stableEventId(event), tone: "user", body: text });
      }
      continue;
    }

    if (event.source === "app" && event.kind === "turnSteered") {
      const text = stringFromUnknown(raw?.text);
      if (text) pushEntry({ kind: "message", id: stableEventId(event), tone: "user", body: text });
      continue;
    }

    if (event.source === "codex" && event.kind === "turn/started") {
      const turnId = turnIdFromRaw(raw);
      if (turnId) {
        const turn = ensureTurn(turnId);
        turn.threadId = stringFromUnknown(raw?.threadId) ?? turn.threadId;
        const turnRecord = recordFromUnknown(raw?.turn);
        turn.startedAtMs = codexTimestampMs(turnRecord?.startedAt) ?? turn.startedAtMs ?? dateMs(event.at);
        turn.status = "in_progress";
      }
      continue;
    }

    if (event.source === "codex" && event.kind === "turn/completed") {
      const turnId = turnIdFromRaw(raw);
      if (turnId) {
        const turn = ensureTurn(turnId);
        const turnRecord = recordFromUnknown(raw?.turn);
        turn.threadId = stringFromUnknown(raw?.threadId) ?? turn.threadId;
        turn.status = stringFromUnknown(turnRecord?.status) ?? "completed";
        turn.completedAtMs = codexTimestampMs(turnRecord?.completedAt) ?? turn.completedAtMs ?? dateMs(event.at);
        turn.durationMs = numberFromUnknown(turnRecord?.durationMs) ?? turn.durationMs;
      }
      continue;
    }

    if (event.source === "codex" && event.kind === "turn/finalOutput") {
      const turnId = stringFromUnknown(raw?.turnId);
      const body = stringFromUnknown(raw?.finalAssistantText);
      if (turnId && body) {
        const turn = ensureTurn(turnId);
        turn.threadId = stringFromUnknown(raw?.threadId) ?? turn.threadId;
        turn.status = stringFromUnknown(raw?.status) ?? turn.status;
        turn.startedAtMs = codexTimestampMs(raw?.startedAt) ?? turn.startedAtMs;
        turn.completedAtMs = codexTimestampMs(raw?.completedAt) ?? turn.completedAtMs;
        turn.durationMs = numberFromUnknown(raw?.durationMs) ?? turn.durationMs;
        turn.assistantFinal = body;
        hydrateStoredItems(turn, raw?.items);
      }
      continue;
    }

    if (event.source === "codex" && (event.kind === "item/started" || event.kind === "item/completed")) {
      const turnId = stringFromUnknown(raw?.turnId);
      const item = recordFromUnknown(raw?.item);
      if (turnId && item) mergeTurnItem(ensureTurn(turnId), item, event);
      continue;
    }

    if (event.source === "codex" && handleCodexDeltaEvent(event, raw, ensureTurn)) continue;

    if (event.source === "codex" && event.kind === "serverRequest") {
      if (raw?.requestId !== undefined) seenPendingRequestIds.add(String(raw.requestId));
      const requestEntry = pendingRequestEntryFromRaw(raw, stableEventId(event), true);
      if (!requestEntry) continue;
      const turnId = stringFromUnknown(raw?.turnId);
      if (turnId) ensureTurn(turnId).pendingGroups.push(requestEntry);
      else pushEntry(requestEntry);
      continue;
    }

    const entry = looseEntryFromEvent(event);
    if (entry) pushEntry(entry);
  }

  hydrateStoredOutput(activeChat, turns, timeline, timelineTurnIds);

  for (const request of state.runtime.pendingRequests) {
    const requestId = String(request.requestId);
    if (seenPendingRequestIds.has(requestId)) continue;
    if (request.chatId && activeChatId && request.chatId !== activeChatId) continue;
    if (request.threadId && activeThreadId && request.threadId !== activeThreadId) continue;
    const entry = pendingRequestEntry(request);
    if (request.turnId) ensureTurn(request.turnId).pendingGroups.push(entry);
    else pushEntry(entry);
  }

  const entries = timeline.flatMap((item): TranscriptEntry[] => {
    if (item.kind === "entry") return [item.entry];
    const turn = turns.get(item.turnId);
    return turn ? entriesFromTurn(turn) : [];
  });

  return entries;
}

function hydrateThreadSummary(
  summary: ActiveThreadSummary | null,
  activeChatId: string | null,
  activeThreadId: string | null,
  ensureTurn: (turnId: string) => TurnDraft,
): void {
  if (!summary || summary.status !== "ready") return;
  if (summary.chatId && activeChatId && summary.chatId !== activeChatId) return;
  if (summary.threadId && activeThreadId && summary.threadId !== activeThreadId) return;

  for (const summaryTurn of summary.turns) {
    const turn = ensureTurn(summaryTurn.id);
    turn.chatId = summary.chatId;
    turn.threadId = summary.threadId;
    turn.status = summaryTurn.status;
    turn.startedAtMs = codexTimestampMs(summaryTurn.startedAt) ?? turn.startedAtMs;
    turn.completedAtMs = codexTimestampMs(summaryTurn.completedAt) ?? turn.completedAtMs;
    turn.durationMs = summaryTurn.durationMs ?? turn.durationMs;

    const userText = summaryTurn.userText ?? userTextFromSummaryItems(summaryTurn.items);
    if (userText) {
      pushUniqueMessage(turn.userMessages, {
        kind: "message",
        id: `summary-user-${summaryTurn.id}`,
        tone: "user",
        body: userText,
      });
    }

    hydrateSummaryItems(turn, summaryTurn);
    if (summaryTurn.assistantText?.trim()) {
      turn.assistantFinal = summaryTurn.assistantText.trim();
    }
  }
}

function hydrateSummaryItems(turn: TurnDraft, summaryTurn: ThreadSummaryTurn): void {
  const timestamp =
    codexTimestampMs(summaryTurn.completedAt) ?? codexTimestampMs(summaryTurn.startedAt) ?? Date.now();
  const at = new Date(timestamp).toISOString();
  for (const item of summaryTurn.items) {
    const raw = recordFromUnknown(item.raw) ?? {};
    mergeTurnItem(
      turn,
      {
        ...raw,
        id: itemId(raw) ?? item.id,
        type: stringFromUnknown(raw.type) ?? item.type,
        status: stringFromUnknown(raw.status) ?? item.status ?? undefined,
      },
      {
        at,
        source: "codex",
        kind: "item/completed",
        message: "stored thread item",
        raw: { item: raw },
      },
    );
  }
}

function entriesFromTurn(turn: TurnDraft): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [...turn.userMessages];
  const workChildren = buildTurnWorkEntries(turn);
  if (workChildren.length > 0) {
    entries.push({
      kind: "work",
      id: `work-${turn.id}`,
      summary: workSummary(turn),
      active: turnIsInProgress(turn.status) || workChildren.some((entry) => entryActive(entry)),
      defaultExpanded: turnIsInProgress(turn.status) || !turn.assistantFinal,
      children: workChildren,
    });
  }

  const assistantText = turn.assistantFinal ?? turn.assistantDraft;
  if (assistantText.trim()) {
    entries.push({
      kind: "message",
      id: `assistant-${turn.id}`,
      tone: "assistant",
      body: assistantText.trim(),
      streaming: !turn.assistantFinal,
    });
  }
  return entries;
}

function buildTurnWorkEntries(turn: TurnDraft): TranscriptEntry[] {
  const normalized: NormalizedTurnEntry[] = [];
  for (const itemId of turn.itemOrder) {
    const item = turn.items.get(itemId);
    if (!item) continue;
    const entry = normalizeTurnItem(item);
    if (entry) normalized.push(entry);
  }
  normalized.push(...turn.pendingGroups.filter((entry): entry is Extract<TranscriptEntry, { kind: "status" }> => entry.kind === "status"));
  return groupActivityEntries(normalized);
}

function groupActivityEntries(entries: NormalizedTurnEntry[]): TranscriptEntry[] {
  const grouped: TranscriptEntry[] = [];
  let pending: ActivitySource[] = [];
  const flush = (): void => {
    if (pending.length === 0) return;
    grouped.push(activityGroupFromSources(pending));
    pending = [];
  };

  for (const entry of entries) {
    if ("category" in entry) {
      pending.push(entry);
      continue;
    }
    flush();
    grouped.push(entry);
  }
  flush();
  return grouped;
}

function activityGroupFromSources(sources: ActivitySource[]): Extract<TranscriptEntry, { kind: "activity" }> {
  const counts = { ...emptyCounts };
  const sourceNames = new Map<string, number>();
  let active = false;
  const rows: ActivityRow[] = [];

  for (const source of sources) {
    active = active || source.active;
    rows.push(...source.rows);
    if (source.sourceName) sourceNames.set(source.sourceName, (sourceNames.get(source.sourceName) ?? 0) + 1);
    for (const key of Object.keys(emptyCounts) as Array<keyof ActivityCounts>) {
      counts[key] += source.counts[key] ?? 0;
    }
  }

  return {
    kind: "activity",
    id: `activity-${sources.map((source) => source.id).join("-")}`,
    icon: dominantActivityIcon(counts, sources),
    summary: activitySummary(counts, sourceNames, active),
    active,
    defaultExpanded: active,
    rows: rows.slice(0, 24),
  };
}

function normalizeTurnItem(item: TurnItemDraft): NormalizedTurnEntry | null {
  const raw = item.raw;
  switch (item.type) {
    case "reasoning":
      return reasoningEntry(item);
    case "commandExecution":
      return commandActivity(item);
    case "fileChange":
      return fileChangeActivity(item);
    case "mcpToolCall":
      return mcpActivity(item);
    case "dynamicToolCall":
      return dynamicToolActivity(item);
    case "webSearch":
      return webSearchActivity(item);
    case "collabAgentToolCall":
      return collabActivity(item);
    case "todoList":
      return todoListEntry(item);
    case "plan":
      return statusEntry(`plan-${item.id}`, "check", "Updated plan", planText(raw) ?? undefined, false);
    case "generatedImage":
      return generatedImageEntry(item);
    case "contextCompaction":
      return statusEntry(`context-${item.id}`, "spark", "Compacted context", undefined, false);
    default:
      return null;
  }
}

function commandActivity(item: TurnItemDraft): ActivitySource {
  const raw = item.raw;
  const command = stringFromUnknown(raw.command) ?? "command";
  const active = itemIsActive(item);
  const actions = arrayRecords(raw.commandActions);
  const rows: ActivityRow[] = [];
  const counts = { ...emptyCounts };
  let allExploration = actions.length > 0;

  for (const [index, action] of actions.entries()) {
    const actionType = stringFromUnknown(action.type);
    if (actionType === "read") {
      counts.explored += 1;
      rows.push({
        id: `${item.id}-read-${index}`,
        icon: "search",
        label: `${active ? "Reading" : "Read"} ${displayPath(stringFromUnknown(action.path) ?? stringFromUnknown(action.name) ?? "file")}`,
      });
      continue;
    }
    if (actionType === "search") {
      counts.searches += 1;
      rows.push({
        id: `${item.id}-search-${index}`,
        icon: "search",
        label: searchLabel(action, active),
      });
      continue;
    }
    if (actionType === "listFiles") {
      counts.lists += 1;
      rows.push({
        id: `${item.id}-list-${index}`,
        icon: "list",
        label: `${active ? "Listing" : "Listed"} files${suffixInPath(stringFromUnknown(action.path))}`,
      });
      continue;
    }
    allExploration = false;
  }

  if (rows.length === 0 || !allExploration) {
    counts.commands += 1;
    rows.push({
      id: `${item.id}-command`,
      icon: "terminal",
      label: `${active ? "Running" : terminalCommandFailed(raw) ? "Stopped" : "Ran"} ${compactValue(command, 160)}`,
      meta: durationMeta(raw),
      tone: terminalCommandFailed(raw) ? "warning" : "normal",
    });
  }

  return {
    id: item.id,
    category: allExploration ? "exploration" : "command",
    icon: allExploration ? "search" : "terminal",
    active,
    rows,
    counts,
  };
}

function fileChangeActivity(item: TurnItemDraft): ActivitySource {
  const changes = arrayRecords(item.raw.changes);
  const active = itemIsActive(item);
  const rows: ActivityRow[] = [];
  const counts = { ...emptyCounts };

  for (const [index, change] of changes.entries()) {
    const path = displayPath(stringFromUnknown(change.path) ?? "file");
    const kind = patchKind(change.kind);
    const diff = stringFromUnknown(change.diff) ?? "";
    const diffCounts = countDiffLines(diff);
    if (kind === "add") counts.created += 1;
    else if (kind === "delete") counts.deleted += 1;
    else counts.edited += 1;
    rows.push({
      id: `${item.id}-change-${index}`,
      icon: "edit",
      label: `${active ? presentParticiple(kind) : pastParticiple(kind)} ${path}`,
      additions: diffCounts.additions,
      deletions: diffCounts.deletions,
      tone: patchFailed(item.raw) ? "warning" : "normal",
    });
  }

  if (rows.length === 0) {
    counts.edited += 1;
    rows.push({
      id: `${item.id}-change`,
      icon: "edit",
      label: active ? "Preparing file changes" : "Updated files",
      tone: patchFailed(item.raw) ? "warning" : "normal",
    });
  }

  return {
    id: item.id,
    category: "file",
    icon: "edit",
    active,
    rows,
    counts,
  };
}

function mcpActivity(item: TurnItemDraft): ActivitySource {
  const server = stringFromUnknown(item.raw.server) ?? "app";
  const tool = stringFromUnknown(item.raw.tool) ?? "tool";
  const sourceName = readableSourceName(server);
  const active = itemIsActive(item);
  const rows: ActivityRow[] = [
    {
      id: `${item.id}-mcp`,
      icon: "tool",
      label: `${active ? "Using" : mcpFailed(item.raw) ? "Tried" : "Used"} ${sourceName}${tool ? ` ${readableToolName(tool)}` : ""}`,
      meta: firstReadableArgument(item.raw.arguments) ?? latestProgress(item),
      tone: mcpFailed(item.raw) ? "warning" : "normal",
    },
  ];
  return {
    id: item.id,
    category: "tool",
    icon: "tool",
    active,
    rows,
    counts: { tools: 1 },
    sourceName,
  };
}

function dynamicToolActivity(item: TurnItemDraft): ActivitySource {
  const namespace = stringFromUnknown(item.raw.namespace);
  const tool = stringFromUnknown(item.raw.tool) ?? "tool";
  const sourceName = readableSourceName(namespace ?? "tool");
  const active = itemIsActive(item);
  return {
    id: item.id,
    category: "tool",
    icon: "tool",
    active,
    rows: [
      {
        id: `${item.id}-dynamic`,
        icon: "tool",
        label: `${active ? "Using" : "Used"} ${[sourceName, readableToolName(tool)].filter(Boolean).join(" ")}`,
        meta: firstReadableArgument(item.raw.arguments),
      },
    ],
    counts: { tools: 1 },
    sourceName,
  };
}

function webSearchActivity(item: TurnItemDraft): ActivitySource {
  const query = webSearchQuery(item.raw);
  const active = itemIsActive(item);
  return {
    id: item.id,
    category: "web",
    icon: "globe",
    active,
    rows: [
      {
        id: `${item.id}-web`,
        icon: "globe",
        label: query ? `${active ? "Searching web for" : "Searched web for"} ${query}` : active ? "Searching web" : "Searched web",
      },
    ],
    counts: { web: 1 },
  };
}

function collabActivity(item: TurnItemDraft): ActivitySource {
  const tool = stringFromUnknown(item.raw.tool) ?? "agent";
  const active = itemIsActive(item);
  return {
    id: item.id,
    category: "tool",
    icon: "branch",
    active,
    rows: [
      {
        id: `${item.id}-agent`,
        icon: "branch",
        label: `${active ? "Coordinating" : "Coordinated"} ${readableToolName(tool)}`,
        meta: stringFromUnknown(item.raw.model) ?? undefined,
      },
    ],
    counts: { subagents: 1 },
  };
}

function todoListEntry(item: TurnItemDraft): Extract<TranscriptEntry, { kind: "status" }> {
  const tasks = todoTaskRecords(item.raw);
  const completed = tasks.filter((task) => taskIsCompleted(task)).length;
  const rows = tasks.slice(0, 12).map((task, index) => ({
    id: `${item.id}-todo-${index}`,
    icon: taskIsCompleted(task) ? "check" as ActivityIcon : "list" as ActivityIcon,
    label: taskTitle(task) ?? `Task ${index + 1}`,
    meta: stringFromUnknown(task.status) ?? undefined,
    tone: taskIsCompleted(task) ? "success" as ActivityTone : "normal" as ActivityTone,
  }));
  return statusEntry(
    `todo-${item.id}`,
    "list",
    "Updated to do list",
    tasks.length > 0 ? `${completed} of ${tasks.length} complete` : planText(item.raw) ?? undefined,
    itemIsActive(item),
    rows.length > 0 ? rows : undefined,
  );
}

function generatedImageEntry(item: TurnItemDraft): Extract<TranscriptEntry, { kind: "status" }> {
  return statusEntry(
    `image-${item.id}`,
    "spark",
    itemIsActive(item) ? "Generating image" : "Generated image",
    firstText(item.raw, ["prompt", "description", "url", "path", "filePath"]) ?? undefined,
    itemIsActive(item),
  );
}

function reasoningEntry(item: TurnItemDraft): Extract<TranscriptEntry, { kind: "reasoning" }> {
  const active = itemIsActive(item);
  const content = reasoningText(item.raw);
  return {
    kind: "reasoning",
    id: `reasoning-${item.id}`,
    active,
    content,
    elapsedMs: active ? null : elapsedMs(item.startedAtMs, item.completedAtMs),
    defaultExpanded: active,
  };
}

function statusEntry(
  id: string,
  icon: ActivityIcon,
  title: string,
  body: string | undefined,
  active: boolean,
  rows?: ActivityRow[],
): Extract<TranscriptEntry, { kind: "status" }> {
  return { kind: "status", id, icon, title, body, active, rows };
}

function pendingRequestEntry(request: PendingCodexRequest): TranscriptEntry {
  const rows = (request.details ?? []).map((detail, index) => ({
    id: `pending-${request.requestId}-${index}`,
    icon: "tool" as ActivityIcon,
    label: detail.label,
    meta: readablePendingDetailValue(detail.label, detail.value) ?? undefined,
  }));
  return statusEntry(
    `pending-${request.requestId}`,
    request.kind === "approval" ? "alert" : "tool",
    request.title,
    request.body,
    true,
    rows.length > 0 ? rows : undefined,
  );
}

function pendingRequestEntryFromRaw(raw: Record<string, unknown> | null, id: string, active: boolean): TranscriptEntry | null {
  if (!raw) return null;
  const title = stringFromUnknown(raw.title) ?? "Codex request";
  const body = stringFromUnknown(raw.body);
  const rows = pendingDetailsFromRecord(raw)?.map((detail, index) => ({
    id: `${id}-detail-${index}`,
    icon: "tool" as ActivityIcon,
    label: detail.label,
    meta: detail.value,
  }));
  return statusEntry(id, "alert", title, body ?? undefined, active, rows);
}

function looseEntryFromEvent(event: AppEvent): TranscriptEntry | null {
  const raw = recordFromUnknown(event.raw);

  if (event.source === "realtime" && isRealtimeUserTranscript(event.kind)) {
    const body = realtimeTranscriptText(event, raw);
    return body ? { kind: "message", id: stableEventId(event), tone: "user", body } : null;
  }

  if (event.source === "realtime" && isRealtimeAssistantTranscript(event.kind)) {
    const body = realtimeTranscriptText(event, raw);
    return body ? { kind: "message", id: stableEventId(event), tone: "assistant", body } : null;
  }

  if (event.source === "realtime" && event.kind === "toolCall") {
    const name = stringFromUnknown(raw?.name) ?? toolNameFromMessage(event.message) ?? "tool";
    const args = toolArgumentsFromRaw(raw);
    return {
      kind: "activity",
      id: stableEventId(event),
      icon: name.includes("codex") ? "branch" : "tool",
      summary: `Voice used ${readableToolName(name)}`,
      active: true,
      defaultExpanded: false,
      rows: realtimeToolRows(name, args, stableEventId(event)),
    };
  }

  if (event.source === "realtime" && event.kind === "toolResult") {
    const name = stringFromUnknown(raw?.name) ?? toolNameFromMessage(event.message) ?? "tool";
    const result = recordFromUnknown(raw?.output);
    return {
      kind: "activity",
      id: stableEventId(event),
      icon: "check",
      summary: `${readableToolName(name)} completed`,
      active: false,
      defaultExpanded: false,
      rows: realtimeToolResultRows(name, result, event.message, stableEventId(event)),
    };
  }

  if (event.source === "codex" && event.kind === "error") {
    return statusEntry(stableEventId(event), "alert", "Codex error", event.message, false);
  }

  return null;
}

function handleCodexDeltaEvent(
  event: AppEvent,
  raw: Record<string, unknown> | null,
  ensureTurn: (turnId: string) => TurnDraft,
): boolean {
  if (!raw) return false;
  const turnId = stringFromUnknown(raw.turnId);
  if (!turnId) return false;

  if (event.kind === "item/agentMessage/delta") {
    const delta = streamedStringFromUnknown(raw.delta);
    if (!delta) return true;
    const turn = ensureTurn(turnId);
    turn.assistantDraft += delta;
    mergeTurnItem(turn, { id: stringFromUnknown(raw.itemId) ?? `agent-${turnId}`, type: "agentMessage", text: turn.assistantDraft }, event);
    return true;
  }

  if (event.kind === "item/reasoning/textDelta" || event.kind === "item/reasoning/summaryTextDelta") {
    const delta = streamedStringFromUnknown(raw.delta);
    const itemId = stringFromUnknown(raw.itemId);
    if (!delta || !itemId) return true;
    const turn = ensureTurn(turnId);
    const item = ensureTurnItem(turn, itemId, "reasoning", event);
    const key = event.kind === "item/reasoning/textDelta" ? "content" : "summary";
    const index = numberFromUnknown(event.kind === "item/reasoning/textDelta" ? raw.contentIndex : raw.summaryIndex) ?? 0;
    const current = Array.isArray(item.raw[key]) ? [...(item.raw[key] as unknown[])] : [];
    current[index] = `${typeof current[index] === "string" ? current[index] : ""}${delta}`;
    item.raw[key] = current;
    return true;
  }

  if (event.kind === "item/fileChange/patchUpdated") {
    const itemId = stringFromUnknown(raw.itemId);
    if (!itemId) return true;
    const item = ensureTurnItem(ensureTurn(turnId), itemId, "fileChange", event);
    item.raw.status = "inProgress";
    item.raw.changes = raw.changes;
    return true;
  }

  if (event.kind === "item/mcpToolCall/progress") {
    const itemId = stringFromUnknown(raw.itemId);
    const message = stringFromUnknown(raw.message);
    if (!itemId || !message) return true;
    const item = ensureTurnItem(ensureTurn(turnId), itemId, "mcpToolCall", event);
    item.progress.push(message);
    return true;
  }

  return false;
}

function mergeTurnItem(turn: TurnDraft, rawItem: Record<string, unknown>, event: AppEvent): void {
  const rawType = stringFromUnknown(rawItem.type) ?? "unknown";
  const type = normalizeTranscriptItemType(rawType);
  const id = itemId(rawItem) ?? `${type}-${turn.itemOrder.length + 1}`;
  if (type === "agentMessage") {
    const text = messageItemText(rawItem);
    if (text && isFinalMessagePhase(rawItem.phase ?? rawItem.status)) turn.assistantFinal = text;
    else if (text) turn.assistantDraft = text;
    return;
  }
  if (type === "userMessage" && turn.userMessages.length === 0) {
    const text = userMessageText(rawItem);
    if (text) {
      pushUniqueMessage(turn.userMessages, {
        kind: "message",
        id: `stored-user-${turn.id}`,
        tone: "user",
        body: text,
      });
    }
    return;
  }
  const item = ensureTurnItem(turn, id, type, event);
  item.type = type;
  item.raw = { ...item.raw, ...rawItem, originalType: rawType, type };
  if (event.kind === "item/completed") item.completedAtMs = dateMs(event.at);
}

function ensureTurnItem(turn: TurnDraft, itemId: string, type: string, event: AppEvent): TurnItemDraft {
  const existing = turn.items.get(itemId);
  if (existing) return existing;
  const item: TurnItemDraft = {
    id: itemId,
    type,
    raw: { id: itemId, type },
    startedAtMs: dateMs(event.at),
    completedAtMs: null,
    progress: [],
  };
  turn.items.set(itemId, item);
  turn.itemOrder.push(itemId);
  return item;
}

function hydrateStoredOutput(
  activeChat: VoiceChat | null,
  turns: Map<string, TurnDraft>,
  timeline: TimelineItem[],
  timelineTurnIds: Set<string>,
): void {
  const output = activeChat?.lastTurnOutput;
  if (!output?.finalAssistantText) return;
  let turn = turns.get(output.turnId);
  if (!turn) {
    turn = {
      id: output.turnId,
      chatId: activeChat?.id ?? null,
      threadId: output.threadId,
      startedAtMs: null,
      completedAtMs: null,
      durationMs: null,
      status: output.status,
      userMessages: [],
      assistantDraft: "",
      assistantFinal: null,
      itemOrder: [],
      items: new Map(),
      pendingGroups: [],
    };
    turns.set(output.turnId, turn);
    if (!timelineTurnIds.has(output.turnId)) {
      timelineTurnIds.add(output.turnId);
      timeline.push({ kind: "turn", turnId: output.turnId });
    }
  }
  turn.threadId = output.threadId;
  turn.status = output.status;
  turn.startedAtMs = codexTimestampMs(output.startedAt) ?? turn.startedAtMs;
  turn.completedAtMs = codexTimestampMs(output.completedAt) ?? turn.completedAtMs;
  turn.durationMs = output.durationMs ?? turn.durationMs;
  turn.assistantFinal = output.finalAssistantText;
  hydrateStoredItems(turn, output.items);
}

function hydrateStoredItems(turn: TurnDraft, value: unknown): void {
  if (!Array.isArray(value)) return;
  for (const item of value) {
    const record = recordFromUnknown(item);
    if (!record) continue;
    mergeTurnItem(turn, record, {
      at: new Date(turn.completedAtMs ?? turn.startedAtMs ?? Date.now()).toISOString(),
      source: "codex",
      kind: "item/completed",
      message: "stored item",
      raw: { item: record },
    });
  }
}

function itemIsActive(item: TurnItemDraft): boolean {
  const status = normalizeStatusName(item.raw.status);
  if (status === "inprogress" || status === "running" || status === "pending") return true;
  if (
    status === "completed" ||
    status === "complete" ||
    status === "done" ||
    status === "failed" ||
    status === "declined" ||
    status === "cancelled" ||
    status === "canceled"
  ) {
    return false;
  }
  return item.completedAtMs == null;
}

function entryActive(entry: TranscriptEntry): boolean {
  if (entry.kind === "work") return entry.active;
  if (entry.kind === "activity") return entry.active;
  if (entry.kind === "reasoning") return entry.active;
  if (entry.kind === "status") return entry.active === true;
  return entry.streaming === true;
}

function workSummary(turn: TurnDraft): string {
  const duration = turn.durationMs ?? elapsedMs(turn.startedAtMs, turn.completedAtMs);
  if (turnIsInProgress(turn.status)) {
    return duration && duration >= 1000 ? `Working for ${formatDuration(duration)}` : "Working";
  }
  return duration ? `Worked for ${formatDuration(duration)}` : "Worked";
}

function activitySummary(
  counts: ActivityCounts,
  sourceNames: Map<string, number>,
  active: boolean,
): string {
  const segments: string[] = [];
  const push = (value: string | null): void => {
    if (!value) return;
    segments.push(segments.length === 0 ? capitalize(value) : lowerFirst(value));
  };

  push(counts.created ? `${active ? "Creating" : "Created"} ${plural(counts.created, "file")}` : null);
  push(counts.edited ? `${active ? "Editing" : "Edited"} ${plural(counts.edited, "file")}` : null);
  push(counts.deleted ? `${active ? "Deleting" : "Deleted"} ${plural(counts.deleted, "file")}` : null);
  push(explorationSummary(counts, active));
  push(counts.web ? `${active ? "Searching" : "Searched"} web` : null);
  push(counts.commands ? `${active ? "Running" : "Ran"} ${plural(counts.commands, "command")}` : null);
  push(counts.approved ? `Approved ${plural(counts.approved, "request")}` : null);
  push(counts.denied ? `Denied ${plural(counts.denied, "request")}` : null);
  if (counts.tools) push(toolSummary(sourceNames, counts.tools, active));
  push(counts.subagents ? `${active ? "Coordinating" : "Coordinated"} ${plural(counts.subagents, "agent")}` : null);

  return segments.join(", ") || (active ? "Working" : "Completed work");
}

function explorationSummary(counts: ActivityCounts, active: boolean): string | null {
  const parts = [
    counts.explored ? plural(counts.explored, "file") : null,
    counts.searches ? plural(counts.searches, "search", "searches") : null,
    counts.lists ? plural(counts.lists, "list") : null,
  ].filter((part): part is string => Boolean(part));
  if (parts.length === 0) return null;
  if (counts.explored === 0 && counts.searches === 0 && counts.lists > 0) {
    return `${active ? "Listing" : "Listed"} files`;
  }
  return `${active ? "Exploring" : "Explored"} ${parts.join(", ")}`;
}

function toolSummary(sourceNames: Map<string, number>, count: number, active: boolean): string {
  const sources = [...sourceNames.keys()];
  if (sources.length === 1) return `${active ? "Using" : "Used"} ${sources[0]}`;
  if (sources.length > 1 && sources.length <= 3) return `${active ? "Using" : "Used"} ${sources.join(", ")}`;
  return `${active ? "Calling" : "Called"} ${plural(count, "tool")}`;
}

function dominantActivityIcon(counts: ActivityCounts, sources: ActivitySource[]): ActivityIcon {
  if (counts.web > 0) return "globe";
  if (counts.created + counts.edited + counts.deleted > 0) return "edit";
  if (counts.explored + counts.searches + counts.lists > 0) return counts.lists > counts.searches + counts.explored ? "list" : "search";
  if (counts.commands > 0) return "terminal";
  if (counts.subagents > 0) return "branch";
  if (counts.tools > 0) return "tool";
  return sources[0]?.icon ?? "tool";
}

function commandCountsForAction(action: Record<string, unknown>): Partial<ActivityCounts> {
  const type = stringFromUnknown(action.type);
  if (type === "read") return { explored: 1 };
  if (type === "search") return { searches: 1 };
  if (type === "listFiles") return { lists: 1 };
  return { commands: 1 };
}

function userTextFromSummaryItems(items: ThreadSummaryItem[]): string | null {
  const messages = items
    .filter((item) => normalizeTranscriptItemType(item.type) === "userMessage")
    .map((item) => {
      const raw = recordFromUnknown(item.raw);
      return raw ? userMessageText(raw) : null;
    })
    .filter((text): text is string => Boolean(text));
  return messages.length > 0 ? messages.join("\n\n") : null;
}

function searchLabel(action: Record<string, unknown>, active: boolean): string {
  const query = stringFromUnknown(action.query);
  const path = stringFromUnknown(action.path);
  if (query && path) return `${active ? "Searching" : "Searched"} for ${query} in ${displayPath(path)}`;
  if (query) return `${active ? "Searching" : "Searched"} for ${query}`;
  return active ? "Searching" : "Searched";
}

function normalizeTranscriptItemType(value: string): string {
  const normalized = value
    .replace(/([a-z])([A-Z])/g, "$1-$2")
    .replace(/_/g, "-")
    .toLowerCase();
  if (normalized === "agent-message" || normalized === "assistant-message") return "agentMessage";
  if (normalized === "user-message" || normalized === "user-input") return "userMessage";
  if (normalized === "command-execution" || normalized === "exec") return "commandExecution";
  if (normalized === "file-change" || normalized === "patch" || normalized === "turn-diff") return "fileChange";
  if (normalized === "mcp-tool-call" || normalized === "tool-call" || normalized === "mcp-server-elicitation") {
    return "mcpToolCall";
  }
  if (normalized === "dynamic-tool-call") return "dynamicToolCall";
  if (normalized === "web-search") return "webSearch";
  if (
    normalized === "collab-agent-tool-call" ||
    normalized === "multi-agent-action" ||
    normalized === "remote-task-created" ||
    normalized === "worked-for" ||
    normalized === "sub-agent"
  ) {
    return "collabAgentToolCall";
  }
  if (normalized === "todo-list") return "todoList";
  if (normalized === "proposed-plan" || normalized === "plan-implementation") return "plan";
  if (normalized === "context-compaction") return "contextCompaction";
  if (normalized === "generated-image" || normalized === "image-generation") return "generatedImage";
  return value;
}

function firstText(record: Record<string, unknown>, fields: string[]): string | null {
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (Array.isArray(value)) {
      const text = arrayStrings(value).join("\n").trim();
      if (text) return text;
    }
  }
  return null;
}

function messageItemText(item: Record<string, unknown>): string | null {
  return firstText(item, ["text", "message", "content"]);
}

function isFinalMessagePhase(value: unknown): boolean {
  const normalized = normalizeStatusName(value);
  return normalized === "finalanswer" || normalized === "final" || normalized === "completed" || normalized === "complete";
}

function normalizeStatusName(value: unknown): string {
  return typeof value === "string" ? value.toLowerCase().replace(/[_\s-]+/g, "") : "";
}

function turnIsInProgress(status: string | null): boolean {
  return normalizeStatusName(status) === "inprogress";
}

function planText(raw: Record<string, unknown>): string | null {
  return firstText(raw, ["text", "summary", "description", "title"]);
}

function todoTaskRecords(raw: Record<string, unknown>): Record<string, unknown>[] {
  for (const field of ["items", "tasks", "todos"]) {
    const value = raw[field];
    if (Array.isArray(value)) return value.map(recordFromUnknown).filter((task): task is Record<string, unknown> => Boolean(task));
  }
  return [];
}

function taskTitle(task: Record<string, unknown>): string | null {
  return firstText(task, ["title", "text", "content", "label", "description"]);
}

function taskIsCompleted(task: Record<string, unknown>): boolean {
  const status = normalizeStatusName(task.status);
  return status === "completed" || status === "complete" || status === "done";
}

function userMessageText(item: Record<string, unknown>): string | null {
  const direct = firstText(item, ["text", "message", "content"]);
  if (direct) return direct;
  const content = item.content;
  if (!Array.isArray(content)) return null;
  const parts = content
    .map((part) => {
      const record = recordFromUnknown(part);
      return typeof part === "string" ? part : stringFromUnknown(record?.text) ?? stringFromUnknown(record?.content);
    })
    .filter((part): part is string => Boolean(part));
  return parts.join("\n").trim() || null;
}

function reasoningText(raw: Record<string, unknown>): string {
  const summary = arrayStrings(raw.summary);
  const content = arrayStrings(raw.content);
  return [...summary, ...content, ...arrayStrings(raw.text)].join("\n\n").trim();
}

function stripReasoningHeading(value: string): string {
  return value.replace(/^\s*\*\*([^*]+)\*\*\s*/, "").trim();
}

function patchKind(value: unknown): "add" | "delete" | "update" {
  const record = recordFromUnknown(value);
  const type = stringFromUnknown(record?.type);
  if (type === "add" || type === "delete") return type;
  return "update";
}

function pastParticiple(kind: "add" | "delete" | "update"): string {
  if (kind === "add") return "Created";
  if (kind === "delete") return "Deleted";
  return "Edited";
}

function presentParticiple(kind: "add" | "delete" | "update"): string {
  if (kind === "add") return "Creating";
  if (kind === "delete") return "Deleting";
  return "Editing";
}

function countDiffLines(diff: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diff.replace(/\r\n/g, "\n").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}

function terminalCommandFailed(raw: Record<string, unknown>): boolean {
  const status = stringFromUnknown(raw.status);
  const exitCode = numberFromUnknown(raw.exitCode);
  return status === "failed" || status === "declined" || (exitCode !== null && exitCode !== 0);
}

function patchFailed(raw: Record<string, unknown>): boolean {
  const status = stringFromUnknown(raw.status);
  return status === "failed" || status === "declined";
}

function mcpFailed(raw: Record<string, unknown>): boolean {
  const status = stringFromUnknown(raw.status);
  return status === "failed" || recordFromUnknown(raw.error) !== null;
}

function webSearchQuery(raw: Record<string, unknown>): string | null {
  const direct = stringFromUnknown(raw.query);
  if (direct) return direct;
  const action = recordFromUnknown(raw.action);
  const query = stringFromUnknown(action?.query);
  if (query) return query;
  const queries = Array.isArray(action?.queries) ? action.queries.filter((item): item is string => typeof item === "string") : [];
  return queries[0] ?? null;
}

function realtimeToolRows(name: string, args: Record<string, unknown> | null, id: string): ActivityRow[] {
  const details = args ? humanReadableArgumentDetails(args) : [];
  const label = realtimeToolCallBody(name, args);
  return [
    { id: `${id}-main`, icon: name.includes("codex") ? "branch" : "tool", label },
    ...details.map((detail, index) => ({
      id: `${id}-detail-${index}`,
      icon: "tool" as ActivityIcon,
      label: detail.label,
      meta: detail.value,
      tone: "muted" as ActivityTone,
    })),
  ];
}

function realtimeToolResultRows(
  name: string,
  result: Record<string, unknown> | null,
  fallbackMessage: string,
  id: string,
): ActivityRow[] {
  const main = realtimeToolResultBody(name, result, fallbackMessage);
  const output = result ? plainToolOutput(result) : null;
  return [
    { id: `${id}-main`, icon: "check", label: main, tone: main.includes("could not") ? "warning" : "success" },
    ...(output ? [{ id: `${id}-output`, icon: "terminal" as ActivityIcon, label: "Output", meta: output, tone: "muted" as ActivityTone }] : []),
  ];
}

function realtimeToolCallBody(name: string, args: Record<string, unknown> | null): string {
  const toolName = readableToolName(name);
  if (name === "exec_command") {
    const command = stringFromUnknown(args?.cmd);
    return command ? `Running ${compactValue(command, 160)}` : "Running a command";
  }
  if (name === "write_stdin") return "Sending input to a running command";
  if (name === "apply_patch") return "Applying a file change";
  if (name === "submit_to_codex") return "Sending a request to Codex";
  if (name === "steer_codex") return "Sending an update to the active Codex turn";
  if (name === "interrupt_codex") return "Asking Codex to stop";
  if (name === "answer_codex_approval") return "Answering a Codex approval request";
  if (name === "answer_codex_question") return "Answering a Codex question";
  if (name.startsWith("set_codex_")) return "Updating Codex settings";
  if (name.includes("chat")) return `${toolName} is updating the chat view`;
  if (name.includes("project")) return `${toolName} is updating projects`;
  return `${toolName} is running`;
}

function realtimeToolResultBody(
  name: string,
  result: Record<string, unknown> | null,
  fallbackMessage: string,
): string {
  const toolName = readableToolName(name);
  const error = stringFromUnknown(result?.error);
  const ok = typeof result?.ok === "boolean" ? result.ok : null;
  if (error || ok === false) return `${toolName} could not finish: ${error ?? "the tool reported a problem."}`;
  const message = stringFromUnknown(result?.message);
  if (message && !looksLikeRawJson(message)) return compactValue(message, 180);
  if (name === "exec_command") return "Command completed";
  if (name === "write_stdin") return "Input sent";
  if (name === "apply_patch") return "File change applied";
  if (name === "submit_to_codex") return "Codex received the request";
  if (name === "steer_codex") return "Codex received the update";
  if (name === "interrupt_codex") return "Interruption requested";
  if (fallbackMessage && !looksLikeRawJson(fallbackMessage)) return compactValue(fallbackMessage, 140);
  return `${toolName} completed`;
}

function humanReadableArgumentDetails(args: Record<string, unknown>): PendingRequestDetail[] {
  return [
    transcriptDetail("Command", stringFromUnknown(args.cmd) ?? stringFromUnknown(args.command)),
    transcriptDetail("Message", stringFromUnknown(args.message)),
    transcriptDetail("Request", stringFromUnknown(args.request)),
    transcriptDetail("Answer", stringFromUnknown(args.answer)),
    transcriptDetail("Name", stringFromUnknown(args.name)),
    transcriptDetail("Workspace", stringFromUnknown(args.workspacePath) ?? stringFromUnknown(args.workdir)),
  ].filter((detail): detail is PendingRequestDetail => Boolean(detail));
}

function pendingDetailsFromRecord(record: Record<string, unknown> | null): PendingRequestDetail[] | undefined {
  const details = record?.details;
  if (!Array.isArray(details)) return undefined;
  const normalized = details
    .map((detail) => {
      const item = recordFromUnknown(detail);
      const label = stringFromUnknown(item?.label);
      const value = stringFromUnknown(item?.value);
      const readableValue = value ? readablePendingDetailValue(label, value) : null;
      return label && readableValue ? { label, value: readableValue } : null;
    })
    .filter((detail): detail is PendingRequestDetail => Boolean(detail));
  return normalized.length > 0 ? normalized : undefined;
}

function transcriptDetail(label: string, value: string | null | undefined): PendingRequestDetail | null {
  if (!value) return null;
  return { label, value: compactValue(stripAnsi(value), 220) };
}

function readablePendingDetailValue(label: string | null, value: string): string | null {
  const clean = stripAnsi(value).trim();
  if (!clean) return null;
  if (!looksLikeRawJson(clean)) return compactValue(clean, 220);
  const parsed = parseJsonRecord(clean);
  if (!parsed) return readableJsonArraySummary(label, clean);
  const friendly = humanReadableArgumentDetails(parsed).map((detail) => `${detail.label}: ${detail.value}`);
  if (friendly.length > 0) return compactValue(friendly.join("; "), 220);
  return null;
}

function readableJsonArraySummary(label: string | null, value: string): string | null {
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const noun = label?.toLowerCase().includes("file") ? "file" : "item";
    return plural(parsed.length, noun);
  } catch {
    return null;
  }
}

function firstReadableArgument(value: unknown): string | undefined {
  if (typeof value === "string") {
    const clean = stripAnsi(value).trim();
    if (!looksLikeRawJson(clean)) return compactValue(clean, 150);
    return firstReadableArgument(parseJsonRecord(clean));
  }
  const record = recordFromUnknown(value);
  if (!record) return undefined;
  const detail = humanReadableArgumentDetails(record)[0];
  return detail ? `${detail.label}: ${detail.value}` : undefined;
}

function plainToolOutput(result: Record<string, unknown>): string | null {
  const output = stringFromUnknown(result.output);
  if (!output || looksLikeRawJson(output)) return null;
  return compactValue(stripAnsi(output), 220);
}

function toolArgumentsFromRaw(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  const args = raw?.arguments;
  if (typeof args === "string") return parseJsonRecord(args);
  return recordFromUnknown(args);
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    return recordFromUnknown(JSON.parse(value));
  } catch {
    return null;
  }
}

function activeChatFromState(state: AppState): VoiceChat | null {
  const project = state.activeProject;
  if (!project) return null;
  const chats = project.chats.filter((chat) => !chat.archivedAt);
  return (
    chats.find((chat) => chat.id === state.runtime.activeChatId) ??
    chats.find((chat) => chat.id === project.activeChatId) ??
    chats.find((chat) => chat.codexThreadId === project.codexThreadId) ??
    chats[0] ??
    null
  );
}

function eventBelongsToActiveChat(event: AppEvent, activeChatId: string | null, activeThreadId: string | null): boolean {
  const raw = recordFromUnknown(event.raw);
  const chatId = stringFromUnknown(raw?.chatId);
  const threadId = stringFromUnknown(raw?.threadId);
  if (chatId && activeChatId) return chatId === activeChatId;
  if (threadId && activeThreadId) return threadId === activeThreadId;
  return true;
}

function realtimeStreamingEntryFromEvent(
  event: AppEvent,
  completedStreams: Set<string>,
): { key: string; delta: string; entry: Extract<TranscriptEntry, { kind: "message" }> } | null {
  if (event.source !== "realtime") return null;
  const raw = recordFromUnknown(event.raw);
  const delta = realtimeDeltaText(event, raw);
  if (!delta) return null;

  if (isRealtimeUserTranscriptDelta(event.kind)) {
    const key = realtimeStreamKey("user", raw, event);
    if (completedStreams.has(key)) return null;
    return { key, delta, entry: { kind: "message", id: `stream-${key}`, tone: "user", body: delta, streaming: true } };
  }

  if (isRealtimeAssistantTranscriptDelta(event.kind)) {
    const key = realtimeStreamKey("assistant", raw, event);
    if (completedStreams.has(key)) return null;
    return { key, delta, entry: { kind: "message", id: `stream-${key}`, tone: "assistant", body: delta, streaming: true } };
  }

  return null;
}

function isRealtimeUserTranscript(kind: string): boolean {
  return kind === "userTranscript" || kind === "conversation.item.input_audio_transcription.completed";
}

function isRealtimeUserTranscriptDelta(kind: string): boolean {
  return kind === "userTranscriptDelta" || kind === "conversation.item.input_audio_transcription.delta";
}

function isRealtimeAssistantTranscript(kind: string): boolean {
  return kind === "assistantTranscript" || kind === "response.output_audio_transcript.done";
}

function isRealtimeAssistantTranscriptDelta(kind: string): boolean {
  return kind === "voiceDelta" || kind === "assistantTranscriptDelta" || kind === "response.output_audio_transcript.delta";
}

function realtimeTranscriptText(event: AppEvent, raw: Record<string, unknown> | null): string | null {
  const text = stringFromUnknown(raw?.transcript) ?? stringFromUnknown(raw?.text);
  if (text) return text;
  const fallback = stringFromUnknown(event.message);
  if (!fallback || fallback === event.kind || fallback.includes("_audio_transcript")) return null;
  return fallback;
}

function realtimeDeltaText(event: AppEvent, raw: Record<string, unknown> | null): string | null {
  const delta = streamedStringFromUnknown(raw?.delta);
  if (delta) return delta;
  const fallback = streamedStringFromUnknown(event.message);
  if (!fallback || fallback === event.kind) return null;
  return fallback;
}

function realtimeStreamKey(role: "user" | "assistant", raw: Record<string, unknown> | null, event: AppEvent): string {
  const itemId = stringFromUnknown(raw?.item_id) ?? stringFromUnknown(raw?.itemId);
  const responseId = stringFromUnknown(raw?.response_id) ?? stringFromUnknown(raw?.responseId);
  const outputIndex = numberFromUnknown(raw?.output_index) ?? numberFromUnknown(raw?.outputIndex);
  const contentIndex = numberFromUnknown(raw?.content_index) ?? numberFromUnknown(raw?.contentIndex);
  return [role, itemId, responseId, outputIndex, contentIndex].filter(Boolean).join(":") || `${role}:${event.at}`;
}

function itemId(item: Record<string, unknown>): string | null {
  return (
    stringFromUnknown(item.id) ??
    stringFromUnknown(item.itemId) ??
    stringFromUnknown(item.callId) ??
    stringFromUnknown(item.call_id)
  );
}

function turnIdFromRaw(raw: Record<string, unknown> | null): string | null {
  const turn = recordFromUnknown(raw?.turn);
  return stringFromUnknown(raw?.turnId) ?? stringFromUnknown(turn?.id);
}

function pushUniqueMessage(messages: TranscriptEntry[], entry: Extract<TranscriptEntry, { kind: "message" }>): void {
  if (messages.some((message) => message.id === entry.id)) return;
  messages.push(entry);
}

function arrayRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(recordFromUnknown).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

function arrayStrings(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) return [value.trim()];
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (typeof item === "string") return item.trim();
      const record = recordFromUnknown(item);
      return record ? firstText(record, ["text", "summary", "content", "message"]) : null;
    })
    .filter((item): item is string => Boolean(item));
}

function recordFromUnknown(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function stringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function streamedStringFromUnknown(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numberFromUnknown(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function dateMs(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function codexTimestampMs(value: unknown): number | null {
  const timestamp = numberFromUnknown(value);
  if (!timestamp || timestamp < 0) return null;
  return timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
}

function elapsedMs(startedAtMs: number | null, completedAtMs: number | null): number | null {
  if (!startedAtMs) return null;
  return Math.max((completedAtMs ?? Date.now()) - startedAtMs, 0);
}

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function durationMeta(raw: Record<string, unknown>): string | undefined {
  const durationMs = numberFromUnknown(raw.durationMs);
  return durationMs ? formatDuration(durationMs) : undefined;
}

function suffixInPath(path: string | null): string {
  return path ? ` in ${displayPath(path)}` : "";
}

function displayPath(path: string): string {
  const clean = path.replace(/\\/g, "/");
  const parts = clean.split("/").filter(Boolean);
  return parts.at(-1) ?? clean;
}

function latestProgress(item: TurnItemDraft): string | undefined {
  return item.progress.at(-1) ? compactValue(item.progress.at(-1) ?? "", 140) : undefined;
}

function readableSourceName(value: string): string {
  return value
    .split(/[._/-]+/)
    .filter(Boolean)
    .map(capitalize)
    .join(" ");
}

function readableToolName(name: string): string {
  return name
    .replace(/^submit_to_codex$/, "Submit to Codex")
    .replace(/^steer_codex$/, "Steer Codex")
    .replace(/^interrupt_codex$/, "Interrupt Codex")
    .replace(/^get_codex_status$/, "Get status")
    .replace(/^exec_command$/, "Shell command")
    .replace(/^write_stdin$/, "Write stdin")
    .replace(/^apply_patch$/, "Apply patch")
    .replace(/_/g, " ")
    .split(/\s+/)
    .map((part, index) => (index === 0 ? capitalize(part) : part))
    .join(" ");
}

function toolNameFromMessage(message: string): string | null {
  const [name] = message.trim().split(/\s+/);
  return name || null;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function capitalize(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function lowerFirst(value: string): string {
  return value ? `${value[0].toLowerCase()}${value.slice(1)}` : value;
}

function looksLikeRawJson(value: string): boolean {
  const trimmed = value.trim();
  return (
    ((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]"))) &&
    /["{}[\]:,]/.test(trimmed)
  );
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function compactValue(value: string, maxLength: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}...`;
}

function stableEventId(event: AppEvent): string {
  const raw = recordFromUnknown(event.raw);
  const suffix =
    stringFromUnknown(raw?.turnId) ??
    stringFromUnknown(raw?.requestId) ??
    stringFromUnknown(raw?.call_id) ??
    stringFromUnknown(raw?.callId) ??
    event.message.slice(0, 24);
  return `${event.at}-${event.source}-${event.kind}-${suffix}`;
}

function TranscriptIcon({ icon }: { icon: ActivityIcon }): React.ReactElement {
  switch (icon) {
    case "terminal":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 7.5h16v9H4z" />
          <path d="m7.5 10 2.25 2-2.25 2" />
          <path d="M12 14h4" />
        </svg>
      );
    case "edit":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m4.5 16.5-.5 3.5 3.5-.5L18.8 8.2l-3-3L4.5 16.5z" />
          <path d="m14.8 6.2 3 3" />
        </svg>
      );
    case "search":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="10.5" cy="10.5" r="5.5" />
          <path d="m15 15 5 5" />
        </svg>
      );
    case "list":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M8 7h12" />
          <path d="M8 12h12" />
          <path d="M8 17h12" />
          <path d="M4 7h.01" />
          <path d="M4 12h.01" />
          <path d="M4 17h.01" />
        </svg>
      );
    case "globe":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="8" />
          <path d="M4 12h16" />
          <path d="M12 4a12 12 0 0 1 0 16" />
          <path d="M12 4a12 12 0 0 0 0 16" />
        </svg>
      );
    case "check":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m5 12 4 4 10-10" />
        </svg>
      );
    case "alert":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 4 3.5 19h17L12 4z" />
          <path d="M12 9v4" />
          <path d="M12 17h.01" />
        </svg>
      );
    case "branch":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="6" cy="6" r="2" />
          <circle cx="18" cy="6" r="2" />
          <circle cx="12" cy="18" r="2" />
          <path d="M8 6h8" />
          <path d="M12 16V9" />
        </svg>
      );
    case "spark":
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3v5" />
          <path d="M12 16v5" />
          <path d="M3 12h5" />
          <path d="M16 12h5" />
          <path d="m6.5 6.5 3 3" />
          <path d="m14.5 14.5 3 3" />
          <path d="m17.5 6.5-3 3" />
          <path d="m9.5 14.5-3 3" />
        </svg>
      );
    case "tool":
    default:
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M14.5 5.5a4 4 0 0 0 4 4L10 18l-4-4 8.5-8.5z" />
          <path d="m6 14 4 4" />
        </svg>
      );
  }
}

function ChevronIcon({ expanded }: { expanded: boolean }): React.ReactElement {
  return (
    <svg className={`voice-chevron${expanded ? " expanded" : ""}`} viewBox="0 0 24 24" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}
