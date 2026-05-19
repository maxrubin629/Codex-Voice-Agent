import { app } from "electron";
import { createHmac, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http, { type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http";
import path from "node:path";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import type {
  AppEvent,
  PhoneCallLogEntry,
  PhoneSettingsUpdate,
  PhoneSettings,
  PhoneStatus,
} from "../shared/types";
import { getOpenAiApiKey } from "./apiKeyStore";
import { realtimeConfig, realtimeTools } from "./realtime";

const SETTINGS_FILE_NAME = "cva-phone-settings.json";
const OPENAI_CALLS_ENDPOINT = "https://api.openai.com/v1/realtime/calls";
const WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS = 300;
const DEFAULT_WEBHOOK_PATH = "/phone/realtime-webhook";
const DEFAULT_LOCAL_PORT = 8765;
const MAX_LOGS = 25;

type PhoneSettingsFile = {
  version: 1;
  enabled?: boolean;
  webhookPath?: string | null;
  localPort?: number | null;
  publicUrl?: string | null;
  allowUnsignedDevWebhooks?: boolean;
  webhookSecret?: string | null;
  allowedCallerNumbers?: string[];
  updatedAt?: string;
};

export type PhoneRealtimeAdapter = {
  acceptCall(callId: string, payload: unknown): Promise<void>;
  rejectCall(callId: string, statusCode?: number): Promise<void>;
  hangupCall(callId: string): Promise<void>;
};

export type PhoneToolHandler = (
  name: string,
  args: Record<string, unknown>,
  registerCancel?: (cancel: () => Promise<void>) => void,
) => Promise<unknown>;

export type PhoneCallSession = {
  start(): Promise<void>;
  close(): void;
};

type PhoneCallSessionFactory = (
  call: NonNullable<PhoneStatus["activeCall"]>,
  hooks: {
    apiKey: string;
    toolHandler?: PhoneToolHandler;
    emitEvent: (kind: string, message: string, raw?: unknown) => void;
    onClosed: (reason: string) => void;
  },
) => PhoneCallSession | null;

type PhoneControllerOptions = {
  toolHandler?: PhoneToolHandler;
  callSessionFactory?: PhoneCallSessionFactory;
};

type IncomingCallEvent = {
  eventId: string | null;
  callId: string;
  from: string | null;
};

type ParsedWebhookResult =
  | { ok: true; event: IncomingCallEvent }
  | { ok: false; statusCode: number; reason: string };

export class PhoneController extends EventEmitter {
  private server: http.Server | null = null;
  private listenerError: string | null = null;
  private activeCall: PhoneStatus["activeCall"] = null;
  private activeSession: PhoneCallSession | null = null;
  private logs: PhoneCallLogEntry[] = [];
  private processedWebhookIds = new Set<string>();
  private endingCallIds = new Set<string>();
  private readonly toolHandler?: PhoneToolHandler;
  private readonly callSessionFactory: PhoneCallSessionFactory;

  constructor(
    private readonly adapter: PhoneRealtimeAdapter = new OpenAiPhoneRealtimeAdapter(),
    options: PhoneControllerOptions = {},
  ) {
    super();
    this.toolHandler = options.toolHandler;
    this.callSessionFactory =
      options.callSessionFactory ??
      ((call, hooks) =>
        hooks.toolHandler
          ? new RealtimeSipCallSession(call.callId, hooks.apiKey, hooks.toolHandler, hooks)
          : null);
  }

  status(): PhoneStatus {
    const settings = phoneConfig();
    return {
      settings,
      listener: {
        running: Boolean(this.server?.listening),
        url: this.server?.listening ? localWebhookUrl(settings) : null,
        error: this.listenerError,
      },
      activeCall: this.activeCall,
      logs: this.logs,
    };
  }

  async initialize(): Promise<void> {
    if (phoneConfig().enabled) await this.startListener();
  }

  async shutdown(): Promise<void> {
    await this.stopListener();
    if (this.activeCall) await this.hangupActiveCall().catch(() => undefined);
  }

  async updateSettings(settings: PhoneSettingsUpdate): Promise<PhoneStatus> {
    const before = phoneConfig();
    savePhoneSettings(settings);
    const after = phoneConfig();
    const needsRestart =
      before.enabled !== after.enabled ||
      before.localPort !== after.localPort ||
      before.webhookPath !== after.webhookPath;

    if (needsRestart) {
      await this.stopListener();
      if (after.enabled) await this.startListener();
    }

    this.emitState();
    return this.status();
  }

  async hangupActiveCall(): Promise<PhoneStatus> {
    if (!this.activeCall) return this.status();
    const call = this.activeCall;
    this.activeCall = { ...call, status: "ending" };
    const session = this.activeSession;
    this.activeSession = null;
    this.endingCallIds.add(call.callId);
    this.emitState();

    try {
      await this.adapter.hangupCall(call.callId);
      session?.close();
      this.appendLog({
        id: randomLogId(),
        callId: call.callId,
        from: call.from,
        at: new Date().toISOString(),
        status: "ended",
        reason: "Hung up phone Realtime session.",
      });
    } finally {
      this.endingCallIds.delete(call.callId);
      this.activeCall = null;
      this.emitState();
    }

    return this.status();
  }

  private async startListener(): Promise<void> {
    const settings = phoneConfig();
    if (this.server?.listening) return;
    this.listenerError = null;
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response);
    });

    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) return reject(new Error("Phone listener was not created."));
      const onError = (error: Error) => {
        this.listenerError = error.message;
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(settings.localPort, "127.0.0.1");
    }).catch((error) => {
      this.emitEvent("app", "phoneListenerError", `Phone webhook listener failed: ${error.message}`, {
        localPort: settings.localPort,
      });
      this.emitState();
    });

    if (this.server?.listening) {
      this.emitEvent("app", "phoneListenerStarted", `Phone webhook listener started at ${localWebhookUrl(settings)}.`);
      this.emitState();
    }
  }

  private async stopListener(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (!server) return;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.emitState();
  }

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const settings = phoneConfig();
    if (request.method !== "POST" || request.url?.split("?")[0] !== settings.webhookPath) {
      response.writeHead(404).end("Not found");
      return;
    }

    const body = await readRequestBody(request);
    const parsed = parseIncomingCallWebhook({
      body,
      headers: request.headers,
      settings,
    });

    if (!parsed.ok) {
      response.writeHead(parsed.statusCode).end(parsed.reason);
      return;
    }

    if (parsed.event.eventId && this.processedWebhookIds.has(parsed.event.eventId)) {
      response.writeHead(200).end("duplicate");
      return;
    }
    if (parsed.event.eventId) this.processedWebhookIds.add(parsed.event.eventId);

    response.writeHead(200).end("ok");
    await this.handleIncomingCall(parsed.event);
  }

  private async handleIncomingCall(event: IncomingCallEvent): Promise<void> {
    const settings = phoneConfig();
    const allowed = isAllowedCaller(event.from, settings.allowedCallerNumbers);
    if (!settings.enabled) {
      await this.rejectIncomingCall(event, 480, "Phone listener is disabled.");
      return;
    }
    if (!allowed) {
      await this.rejectIncomingCall(event, 603, "Caller is not on the allowlist.");
      return;
    }
    if (this.activeCall) {
      await this.rejectIncomingCall(event, 486, "Another phone call is already active.");
      return;
    }
    const apiKey = getOpenAiApiKey();
    if (!apiKey) {
      await this.rejectIncomingCall(event, 480, "OpenAI API key is not configured.");
      return;
    }

    this.activeCall = {
      callId: event.callId,
      from: event.from,
      startedAt: new Date().toISOString(),
      status: "accepting",
    };
    this.emitState();

    try {
      await this.adapter.acceptCall(event.callId, phoneAcceptPayload());
      const call = this.activeCall;
      const session = call
        ? this.callSessionFactory(call, {
            apiKey,
            toolHandler: this.toolHandler,
            emitEvent: (kind, message, raw) => this.emitEvent("realtime", kind, message, raw),
            onClosed: (reason) => this.handleCallSessionClosed(event.callId, reason),
          })
        : null;
      this.activeSession = session;
      if (session) await session.start();
      if (this.activeCall) this.activeCall = { ...this.activeCall, status: "active" };
      this.appendLog({
        id: randomLogId(),
        callId: event.callId,
        from: event.from,
        at: new Date().toISOString(),
        status: "accepted",
        reason: "Accepted inbound Realtime SIP call.",
      });
      this.emitEvent("app", "phoneCallAccepted", `Accepted phone call from ${event.from ?? "unknown caller"}.`, {
        callId: event.callId,
      });
    } catch (error) {
      const session = this.activeSession;
      this.activeSession = null;
      this.activeCall = null;
      session?.close();
      await this.adapter.hangupCall(event.callId).catch(() => undefined);
      const message = error instanceof Error ? error.message : String(error);
      this.appendLog({
        id: randomLogId(),
        callId: event.callId,
        from: event.from,
        at: new Date().toISOString(),
        status: "error",
        reason: message,
      });
      this.emitEvent("app", "phoneCallError", `Phone call setup failed: ${message}`, {
        callId: event.callId,
      });
    } finally {
      this.emitState();
    }
  }

  private handleCallSessionClosed(callId: string, reason: string): void {
    if (this.endingCallIds.has(callId)) return;
    if (this.activeCall?.callId !== callId) return;
    const call = this.activeCall;
    this.activeSession = null;
    this.activeCall = null;
    this.appendLog({
      id: randomLogId(),
      callId,
      from: call.from,
      at: new Date().toISOString(),
      status: "ended",
      reason,
    });
    this.emitEvent("app", "phoneCallEnded", `Phone call ended: ${reason}`, { callId });
    this.emitState();
  }

  private async rejectIncomingCall(
    event: IncomingCallEvent,
    statusCode: number,
    reason: string,
  ): Promise<void> {
    await this.adapter.rejectCall(event.callId, statusCode).catch((error) => {
      this.emitEvent("app", "phoneCallRejectError", `Phone call reject failed: ${String(error)}`, {
        callId: event.callId,
      });
    });
    this.appendLog({
      id: randomLogId(),
      callId: event.callId,
      from: event.from,
      at: new Date().toISOString(),
      status: "rejected",
      reason,
    });
    this.emitEvent("app", "phoneCallRejected", `Rejected phone call: ${reason}`, {
      callId: event.callId,
      from: event.from,
      statusCode,
    });
    this.emitState();
  }

  private appendLog(entry: PhoneCallLogEntry): void {
    this.logs = [entry, ...this.logs].slice(0, MAX_LOGS);
  }

  private emitState(): void {
    this.emit("state", this.status());
  }

  private emitEvent(source: AppEvent["source"], kind: string, message: string, raw?: unknown): void {
    this.emit("event", {
      at: new Date().toISOString(),
      source,
      kind,
      message,
      raw,
    } satisfies AppEvent);
  }
}

type TrackedPhoneFunctionCall = {
  callId: string;
  itemId?: string;
  name: string;
  arguments: string;
  running: boolean;
  outputSent: boolean;
  stale: boolean;
  cancel?: () => Promise<void>;
  pendingOutput?: unknown;
};

type TrackedPhoneResponse = {
  responseId: string;
  epoch: number;
  calls: Map<string, TrackedPhoneFunctionCall>;
};

class RealtimeSipCallSession implements PhoneCallSession {
  private ws: WebSocket | null = null;
  private connectTimer: NodeJS.Timeout | null = null;
  private epoch = 0;
  private opened = false;
  private closed = false;
  private trackedResponses = new Map<string, TrackedPhoneResponse>();
  private functionCallsByCallId = new Map<string, TrackedPhoneFunctionCall>();
  private functionCallsByItemId = new Map<string, TrackedPhoneFunctionCall>();

  constructor(
    private readonly callId: string,
    private readonly apiKey: string,
    private readonly toolHandler: PhoneToolHandler,
    private readonly hooks: {
      emitEvent: (kind: string, message: string, raw?: unknown) => void;
      onClosed: (reason: string) => void;
    },
  ) {}

  start(): Promise<void> {
    if (this.ws) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const url = `wss://api.openai.com/v1/realtime?call_id=${encodeURIComponent(this.callId)}`;
      const ws = new WebSocket(url, {
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
        },
      });
      this.ws = ws;

      const failStartup = (error: Error) => {
        this.clearConnectTimer();
        ws.off("open", handleOpen);
        ws.off("error", failStartup);
        this.close();
        reject(error);
      };

      const handleOpen = () => {
        this.clearConnectTimer();
        ws.off("error", failStartup);
        this.opened = true;
        this.hooks.emitEvent("phoneRealtimeOpened", "Phone Realtime WebSocket connected.", {
          callId: this.callId,
        });
        this.send({
          type: "response.create",
          response: {
            output_modalities: ["audio"],
            instructions: "Greet the caller briefly and ask which Codex project or chat they want to use.",
          },
        });
        resolve();
      };

      this.connectTimer = setTimeout(() => {
        failStartup(new Error("Timed out connecting to the phone Realtime WebSocket."));
      }, 10_000);

      ws.once("open", handleOpen);
      ws.once("error", failStartup);
      ws.on("message", (data) => this.handleMessage(data));
      ws.on("error", (error) => {
        if (!this.opened) return;
        this.hooks.emitEvent("phoneRealtimeError", error.message, { callId: this.callId });
      });
      ws.on("close", (code, reason) => {
        this.clearConnectTimer();
        this.closed = true;
        this.trackedResponses.clear();
        this.functionCallsByCallId.clear();
        this.functionCallsByItemId.clear();
        const detail = reason.length > 0 ? reason.toString("utf8") : `code ${code}`;
        this.hooks.onClosed(`Realtime SIP WebSocket closed (${detail}).`);
      });
    });
  }

  close(): void {
    this.clearConnectTimer();
    this.closed = true;
    this.epoch += 1;
    this.trackedResponses.clear();
    this.functionCallsByCallId.clear();
    this.functionCallsByItemId.clear();
    const ws = this.ws;
    this.ws = null;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.close();
    } else if (ws && ws.readyState === WebSocket.CONNECTING) {
      ws.terminate();
    }
  }

  private clearConnectTimer(): void {
    if (!this.connectTimer) return;
    clearTimeout(this.connectTimer);
    this.connectTimer = null;
  }

  private handleMessage(data: WebSocket.RawData): void {
    const text = data.toString();
    let payload: Record<string, any>;
    try {
      payload = JSON.parse(text) as Record<string, any>;
    } catch {
      this.hooks.emitEvent("phoneRealtimeParseError", text, { callId: this.callId });
      return;
    }

    if (payload.type === "input_audio_buffer.speech_started") {
      this.invalidatePendingToolCalls("phoneUserSpeechStarted", payload);
      return;
    }

    if (payload.type === "conversation.item.input_audio_transcription.completed" && payload.transcript) {
      this.hooks.emitEvent("phoneUserTranscript", String(payload.transcript), payload);
      return;
    }

    if (payload.type === "response.output_audio_transcript.done" && payload.transcript) {
      this.hooks.emitEvent("phoneAssistantTranscript", String(payload.transcript), payload);
      return;
    }

    if (payload.type === "response.created") {
      const responseId = stringField(payload.response?.id);
      if (responseId) this.ensureTrackedResponse(responseId);
    }

    if (payload.type === "response.output_item.added" && payload.item?.type === "function_call") {
      this.upsertFunctionCall(stringField(payload.response_id) ?? undefined, payload.item);
    }

    if (payload.type === "response.function_call_arguments.delta") {
      const call = this.findFunctionCall(payload);
      if (call && typeof payload.delta === "string") {
        call.arguments += payload.delta;
      }
    }

    if (payload.type === "response.function_call_arguments.done") {
      const call = this.findOrCreateFunctionCallFromArgumentEvent(payload);
      if (call) {
        call.arguments = typeof payload.arguments === "string" ? payload.arguments : call.arguments;
        call.name = stringField(payload.name) ?? call.name;
      }
    }

    if (payload.type === "response.output_item.done" && payload.item?.type === "function_call") {
      this.upsertFunctionCall(stringField(payload.response_id) ?? undefined, payload.item);
    }

    if (payload.type === "response.done") {
      const responseId = stringField(payload.response?.id);
      const status = stringField(payload.response?.status) ?? "completed";
      const record = responseId ? this.ensureTrackedResponse(responseId) : null;
      if (Array.isArray(payload.response?.output)) {
        for (const item of payload.response.output) {
          if (item?.type === "function_call") this.upsertFunctionCall(responseId ?? undefined, item);
        }
      }
      if (record) {
        if (status === "completed") {
          void this.handleFunctionCalls(record);
        } else {
          this.skipFunctionCalls(record, `Realtime response ended with status ${status}.`);
        }
      }
    }

    if (payload.type === "error") {
      this.hooks.emitEvent("phoneRealtimeError", payload.error?.message ?? "Realtime SIP error.", payload);
    }
  }

  private ensureTrackedResponse(responseId: string): TrackedPhoneResponse {
    const existing = this.trackedResponses.get(responseId);
    if (existing) return existing;
    const record: TrackedPhoneResponse = {
      responseId,
      epoch: this.epoch,
      calls: new Map(),
    };
    this.trackedResponses.set(responseId, record);
    return record;
  }

  private upsertFunctionCall(responseId: string | undefined, item: Record<string, unknown>): TrackedPhoneFunctionCall | null {
    const callId = stringField(item.call_id);
    const itemId = stringField(item.id) ?? undefined;
    const name = stringField(item.name);
    if (!callId || !name) return null;

    const record = responseId ? this.ensureTrackedResponse(responseId) : null;
    const existing = this.functionCallsByCallId.get(callId) ?? (itemId ? this.functionCallsByItemId.get(itemId) : undefined);
    const call =
      existing ??
      ({
        callId,
        itemId,
        name,
        arguments: "",
        running: false,
        outputSent: false,
        stale: false,
      } satisfies TrackedPhoneFunctionCall);

    call.name = name;
    call.itemId = itemId ?? call.itemId;
    if (typeof item.arguments === "string" && item.arguments.trim()) {
      call.arguments = item.arguments;
    }

    this.functionCallsByCallId.set(callId, call);
    if (call.itemId) this.functionCallsByItemId.set(call.itemId, call);
    record?.calls.set(callId, call);
    return call;
  }

  private findFunctionCall(payload: Record<string, unknown>): TrackedPhoneFunctionCall | null {
    const callId = stringField(payload.call_id);
    const itemId = stringField(payload.item_id);
    return (
      (callId ? this.functionCallsByCallId.get(callId) : undefined) ??
      (itemId ? this.functionCallsByItemId.get(itemId) : undefined) ??
      null
    );
  }

  private findOrCreateFunctionCallFromArgumentEvent(payload: Record<string, unknown>): TrackedPhoneFunctionCall | null {
    const existing = this.findFunctionCall(payload);
    if (existing) return existing;

    const responseId = stringField(payload.response_id);
    const callId = stringField(payload.call_id);
    const name = stringField(payload.name);
    if (!responseId || !callId || !name) return null;
    return this.upsertFunctionCall(responseId, {
      type: "function_call",
      call_id: callId,
      id: stringField(payload.item_id) ?? undefined,
      name,
      arguments: typeof payload.arguments === "string" ? payload.arguments : "",
    });
  }

  private invalidatePendingToolCalls(kind: string, raw?: unknown): void {
    this.epoch += 1;
    let invalidated = 0;
    for (const record of this.trackedResponses.values()) {
      for (const call of record.calls.values()) {
        if (call.outputSent) continue;
        call.stale = true;
        if (call.running && call.cancel) void call.cancel().catch(() => undefined);
        invalidated += 1;
      }
    }
    if (invalidated > 0) {
      this.hooks.emitEvent(kind, `Invalidated ${invalidated} pending phone tool call${invalidated === 1 ? "" : "s"}.`, raw);
    }
  }

  private skipFunctionCalls(record: TrackedPhoneResponse, reason: string): void {
    for (const call of record.calls.values()) {
      call.stale = true;
      call.outputSent = true;
    }
    this.hooks.emitEvent("phoneToolCallsSkipped", reason, { callId: this.callId, responseId: record.responseId });
    this.cleanupTrackedResponse(record);
  }

  private async handleFunctionCalls(record: TrackedPhoneResponse): Promise<void> {
    const calls = [...record.calls.values()].filter((call) => !call.outputSent);
    if (calls.length === 0) {
      this.cleanupTrackedResponse(record);
      return;
    }

    const outputs: Array<{ call: TrackedPhoneFunctionCall; output: unknown }> = [];
    for (const call of calls) {
      if (call.stale || record.epoch !== this.epoch) {
        call.outputSent = true;
        continue;
      }

      let output: unknown;
      const args = safeJsonRecord(call.arguments);
      if ("pendingOutput" in call) {
        output = call.pendingOutput;
      } else {
        call.running = true;
        this.hooks.emitEvent("phoneToolCall", `${call.name} ${JSON.stringify(args)}`, {
          callId: this.callId,
          realtimeCallId: call.callId,
        });
        try {
          output = await this.toolHandler(call.name, args, (cancel) => {
            call.cancel = cancel;
          });
        } catch (error) {
          output = {
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          };
        } finally {
          call.running = false;
          call.cancel = undefined;
        }
        call.pendingOutput = output;
      }

      if (call.stale || record.epoch !== this.epoch || !this.isOpen()) {
        call.outputSent = true;
        await cancelStalePhoneTool(this.toolHandler, call.name, output).catch(() => undefined);
        this.cleanupTrackedResponse(record);
        return;
      }

      outputs.push({ call, output });
    }

    if (outputs.length === 0 || !this.isOpen() || record.epoch !== this.epoch) {
      this.cleanupTrackedResponse(record);
      return;
    }

    for (const { call, output } of outputs) {
      this.send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: call.callId,
          output: JSON.stringify(output),
        },
      });
      call.outputSent = true;
      call.pendingOutput = undefined;
    }
    this.send({ type: "response.create" });
    this.cleanupTrackedResponse(record);
  }

  private cleanupTrackedResponse(record: TrackedPhoneResponse): void {
    this.trackedResponses.delete(record.responseId);
    for (const call of record.calls.values()) {
      this.functionCallsByCallId.delete(call.callId);
      if (call.itemId) this.functionCallsByItemId.delete(call.itemId);
    }
  }

  private send(payload: unknown): void {
    if (!this.isOpen()) throw new Error("Phone Realtime WebSocket is not open.");
    this.ws?.send(JSON.stringify(payload));
  }

  private isOpen(): boolean {
    return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN && !this.closed);
  }
}

class OpenAiPhoneRealtimeAdapter implements PhoneRealtimeAdapter {
  async acceptCall(callId: string, payload: unknown): Promise<void> {
    await callControlRequest(callId, "accept", payload);
  }

  async rejectCall(callId: string, statusCode = 603): Promise<void> {
    await callControlRequest(callId, "reject", { status_code: statusCode });
  }

  async hangupCall(callId: string): Promise<void> {
    await callControlRequest(callId, "hangup");
  }
}

async function callControlRequest(callId: string, action: "accept" | "reject" | "hangup", body?: unknown): Promise<void> {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) throw new Error("Missing OpenAI API key.");

  const response = await fetch(`${OPENAI_CALLS_ENDPOINT}/${encodeURIComponent(callId)}/${action}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    throw new Error(`Realtime call ${action} failed: ${response.status} ${await response.text()}`);
  }
}

export function phoneConfig(): PhoneSettings {
  const file = readPhoneSettings();
  return {
    enabled: file.enabled ?? false,
    webhookPath: normalizeWebhookPath(file.webhookPath),
    localPort: normalizePort(file.localPort),
    publicUrl: normalizeOptionalString(file.publicUrl),
    allowUnsignedDevWebhooks: file.allowUnsignedDevWebhooks ?? false,
    webhookSecretConfigured: Boolean(normalizeOptionalString(file.webhookSecret)),
    allowedCallerNumbers: normalizePhoneAllowlist(file.allowedCallerNumbers),
  };
}

export function defaultPhoneStatus(): PhoneStatus {
  return {
    settings: phoneConfig(),
    listener: {
      running: false,
      url: null,
      error: null,
    },
    activeCall: null,
    logs: [],
  };
}

function savePhoneSettings(settings: PhoneSettingsUpdate): PhoneSettings {
  const current = readPhoneSettings();
  const next: PhoneSettingsFile = {
    ...current,
    version: 1,
    updatedAt: new Date().toISOString(),
  };

  if (settings.enabled !== undefined) next.enabled = Boolean(settings.enabled);
  if (settings.webhookPath !== undefined) next.webhookPath = normalizeWebhookPath(settings.webhookPath);
  if (settings.localPort !== undefined) next.localPort = normalizePort(settings.localPort);
  if (settings.publicUrl !== undefined) next.publicUrl = normalizeOptionalString(settings.publicUrl);
  if (settings.allowUnsignedDevWebhooks !== undefined) {
    next.allowUnsignedDevWebhooks = Boolean(settings.allowUnsignedDevWebhooks);
  }
  if (settings.allowedCallerNumbers !== undefined) {
    next.allowedCallerNumbers = normalizePhoneAllowlist(settings.allowedCallerNumbers);
  }
  if (settings.webhookSecret !== undefined) {
    next.webhookSecret = normalizeOptionalString(settings.webhookSecret);
  }

  writePhoneSettings(next);
  return phoneConfig();
}

export function parseIncomingCallWebhook({
  body,
  headers,
  settings,
  webhookSecret = readPhoneSettings().webhookSecret ?? null,
  now = Math.floor(Date.now() / 1000),
}: {
  body: string;
  headers: IncomingHttpHeaders;
  settings: PhoneSettings;
  webhookSecret?: string | null;
  now?: number;
}): ParsedWebhookResult {
  if (webhookSecret) {
    const verification = verifyOpenAiWebhookSignature({ body, headers, secret: webhookSecret, now });
    if (!verification.ok) return { ok: false, statusCode: 400, reason: verification.reason };
  } else if (!settings.allowUnsignedDevWebhooks) {
    return { ok: false, statusCode: 400, reason: "Unsigned phone webhooks are disabled." };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return { ok: false, statusCode: 400, reason: "Invalid JSON." };
  }

  if (!isRecord(payload) || payload.type !== "realtime.call.incoming" || !isRecord(payload.data)) {
    return { ok: false, statusCode: 202, reason: "Ignored webhook event." };
  }

  const callId = stringField(payload.data.call_id);
  if (!callId) return { ok: false, statusCode: 400, reason: "Missing call_id." };

  return {
    ok: true,
    event: {
      eventId: stringField(payload.id),
      callId,
      from: callerFromSipHeaders(payload.data.sip_headers),
    },
  };
}

export function verifyOpenAiWebhookSignature({
  body,
  headers,
  secret,
  now = Math.floor(Date.now() / 1000),
}: {
  body: string;
  headers: IncomingHttpHeaders;
  secret: string;
  now?: number;
}): { ok: true } | { ok: false; reason: string } {
  const id = headerValue(headers["webhook-id"]);
  const timestamp = headerValue(headers["webhook-timestamp"]);
  const signature = headerValue(headers["webhook-signature"]);
  if (!id || !timestamp || !signature) return { ok: false, reason: "Missing webhook signature headers." };

  const timestampNumber = Number(timestamp);
  if (!Number.isInteger(timestampNumber)) return { ok: false, reason: "Invalid webhook timestamp." };
  if (Math.abs(now - timestampNumber) > WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: "Webhook timestamp is outside the allowed window." };
  }

  const signedPayload = `${id}.${timestamp}.${body}`;
  const expected = createHmac("sha256", webhookSecretBytes(secret)).update(signedPayload).digest();
  const candidates = signature
    .split(" ")
    .flatMap((part) => part.split(","))
    .filter((part) => part && part !== "v1")
    .map((part) => part.replace(/^v1=/, ""));

  for (const candidate of candidates) {
    const actual = Buffer.from(candidate, "base64");
    if (actual.length === expected.length && timingSafeEqual(actual, expected)) return { ok: true };
  }

  return { ok: false, reason: "Invalid webhook signature." };
}

export function callerFromSipHeaders(value: unknown): string | null {
  if (!Array.isArray(value)) return null;
  const from = value.find((header) => isRecord(header) && String(header.name).toLowerCase() === "from");
  if (!isRecord(from)) return null;
  const raw = stringField(from.value);
  if (!raw) return null;
  return normalizePhoneNumber(raw.match(/\+?[0-9][0-9 .()-]{6,}/)?.[0] ?? raw);
}

export function isAllowedCaller(from: string | null, allowlist: string[]): boolean {
  if (allowlist.length === 0) return false;
  if (!from) return false;
  const normalizedFrom = normalizePhoneNumber(from);
  return allowlist.some((allowed) => normalizePhoneNumber(allowed) === normalizedFrom);
}

function phoneAcceptPayload(): unknown {
  const config = realtimeConfig();
  return {
    type: "realtime",
    model: config.model,
    ...(config.reasoningEffort
      ? {
          reasoning: {
            effort: config.reasoningEffort,
          },
        }
      : {}),
    output_modalities: ["audio"],
    instructions: phoneRoutingInstructions(),
    audio: {
      input: {
        transcription: {
          model: "gpt-4o-mini-transcribe",
        },
        turn_detection: {
          type: "semantic_vad",
          create_response: true,
          interrupt_response: true,
        },
      },
      output: {
        voice: config.voice,
      },
    },
    tools: realtimeTools(),
    tool_choice: "auto",
  };
}

function phoneRoutingInstructions(): string {
  return [
    "You are the inbound phone layer for Codex Voice Agent.",
    "Start by asking the caller which recent Codex chat or project they want to use, or whether they want to create a new one.",
    "Do not submit work to Codex, steer a running Codex turn, or claim any computer action has started until the caller has clearly chosen a destination.",
    "If the caller asks for coding work before choosing a destination, briefly route them first.",
    "Keep responses short and suitable for a phone call.",
  ].join("\n");
}

function readPhoneSettings(): PhoneSettingsFile {
  try {
    const filePath = phoneSettingsPath();
    if (!existsSync(filePath)) return { version: 1 };
    const file = JSON.parse(readFileSync(filePath, "utf8")) as PhoneSettingsFile;
    return { ...file, version: 1 };
  } catch {
    return { version: 1 };
  }
}

function writePhoneSettings(settings: PhoneSettingsFile): void {
  const filePath = phoneSettingsPath();
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(settings, null, 2), { mode: 0o600 });
}

function phoneSettingsPath(): string {
  return path.join(app.getPath("userData"), SETTINGS_FILE_NAME);
}

function localWebhookUrl(settings: PhoneSettings): string {
  return `http://127.0.0.1:${settings.localPort}${settings.webhookPath}`;
}

function normalizeWebhookPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return DEFAULT_WEBHOOK_PATH;
  const trimmed = value.trim();
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizePort(value: unknown): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return DEFAULT_LOCAL_PORT;
  return port;
}

function normalizeOptionalString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePhoneAllowlist(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(value.map((item) => normalizePhoneNumber(String(item))).filter((item) => item.length > 0)),
  );
}

function normalizePhoneNumber(value: string): string {
  const trimmed = value.trim();
  const hasPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  return digits ? `${hasPlus ? "+" : ""}${digits}` : "";
}

function webhookSecretBytes(secret: string): Buffer | string {
  const trimmed = secret.trim();
  if (trimmed.startsWith("whsec_")) {
    return Buffer.from(trimmed.slice("whsec_".length), "base64");
  }
  return trimmed;
}

function safeJsonRecord(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

async function cancelStalePhoneTool(
  toolHandler: PhoneToolHandler,
  name: string,
  output: unknown,
): Promise<void> {
  if (name !== "queue_codex_request" || !output || typeof output !== "object" || Array.isArray(output)) return;
  const result = output as { queued?: unknown; queuedId?: unknown; chatId?: unknown };
  if (result.queued !== true || typeof result.queuedId !== "string") return;
  await toolHandler("cancel_queued_codex_request", {
    queuedId: result.queuedId,
    ...(typeof result.chatId === "string" ? { chatId: result.chatId } : {}),
  });
}

function headerValue(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function randomLogId(): string {
  return `phone_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}
