import type {
  AppEvent,
  ApprovalDecision,
  AppState,
  ActiveThreadSummary,
  CodexPermissionMode,
  CodexSettingsScope,
  CodexTurnOutput,
  PendingCodexRequest,
  RealtimeContextRequest,
  ToolQuestionAnswer,
  VoiceChat,
  VoiceTranscriptMessage,
} from "../../shared/types";
import { shouldCreateRealtimeResponseAfterToolOutputs } from "../../shared/realtimeSpeechPolicy";

type RealtimeCallbacks = {
  onLog: (event: AppEvent) => void;
  onConnectionChange: (connected: boolean, label: string) => void;
  onSessionStarted?: () => Promise<void>;
  onSessionEnded?: () => Promise<void>;
  onOutputLevel?: (level: number) => void;
  getTranscriptMessages?: (chatId: string) => Promise<VoiceTranscriptMessage[]>;
};

export type RealtimeChatContext = {
  projectId: string;
  projectName: string;
  chatId: string;
  chatName: string;
  threadId: string | null;
};

type FunctionCallItem = {
  type: "function_call";
  name: string;
  call_id: string;
  id?: string;
  status?: string;
  arguments?: string;
};

type TrackedFunctionCall = {
  callId: string;
  itemId?: string;
  name: string;
  arguments: string;
  status?: string;
  running: boolean;
  outputSent: boolean;
  stale: boolean;
  cancel?: () => Promise<void>;
  pendingOutput?: unknown;
};

type TrackedRealtimeResponse = {
  responseId: string;
  status?: string;
  epoch: number;
  calls: Map<string, TrackedFunctionCall>;
};

export class RealtimeVoiceClient {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private localStream: MediaStream | null = null;
  private audioEl: HTMLAudioElement | null = null;
  private outputAudioContext: AudioContext | null = null;
  private outputAudioSource: MediaStreamAudioSourceNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private outputSamples: Uint8Array<ArrayBuffer> | null = null;
  private outputLevelFrame: number | null = null;
  private smoothedOutputLevel = 0;
  private isPaused = false;
  private realtimeEpoch = 0;
  private activeChatContext: RealtimeChatContext | null = null;
  private injectedTranscriptFingerprints = new Map<string, string>();
  private chatContextInjectionSeq = 0;
  private trackedResponses = new Map<string, TrackedRealtimeResponse>();
  private functionCallsByCallId = new Map<string, TrackedFunctionCall>();
  private functionCallsByItemId = new Map<string, TrackedFunctionCall>();
  private sessionLifecycleActive = false;
  private startupContextIncluded = false;

  constructor(private readonly callbacks: RealtimeCallbacks) {}

  get connected(): boolean {
    return this.dc?.readyState === "open";
  }

  get paused(): boolean {
    return this.isPaused;
  }

  async connect(): Promise<void> {
    if (this.pc) return;
    this.callbacks.onConnectionChange(false, "Creating Realtime session.");
    const secret = await window.codexVoice.createRealtimeClientSecret();
    this.startupContextIncluded = Boolean(secret.startupContextIncluded);

    const pc = new RTCPeerConnection();
    const audioEl = document.createElement("audio");
    this.pc = pc;
    this.audioEl = audioEl;
    audioEl.autoplay = true;
    pc.ontrack = (event) => {
      const [remoteStream] = event.streams;
      audioEl.srcObject = remoteStream;
      if (remoteStream) this.setupOutputAnalyser(remoteStream);
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.localStream = stream;
      pc.addTrack(stream.getAudioTracks()[0], stream);

      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.addEventListener("open", () => {
        this.setPaused(false);
        this.callbacks.onConnectionChange(
          true,
          `Connected to ${secret.model} (${secret.voice}, reasoning ${secret.reasoningEffort}).`,
        );
        this.log("connection", "Realtime data channel opened.");
        this.notifySessionStarted();
        if (!this.startupContextIncluded) void this.injectActiveChatContext("connect");
      });
      dc.addEventListener("close", () => {
        this.notifySessionEnded();
        this.callbacks.onConnectionChange(false, "Realtime data channel closed.");
        this.log("connection", "Realtime data channel closed.");
      });
      dc.addEventListener("message", (event) => this.handleMessage(event));

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const response = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST",
        body: offer.sdp,
        headers: {
          Authorization: `Bearer ${secret.value}`,
          "Content-Type": "application/sdp",
        },
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Realtime WebRTC connection failed: ${response.status} ${text}`);
      }

      await pc.setRemoteDescription({
        type: "answer",
        sdp: await response.text(),
      });
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  disconnect(): void {
    this.notifySessionEnded();
    this.realtimeEpoch += 1;
    this.trackedResponses.clear();
    this.functionCallsByCallId.clear();
    this.functionCallsByItemId.clear();
    this.localStream?.getTracks().forEach((track) => track.stop());
    this.dc?.close();
    this.pc?.close();
    this.pc = null;
    this.dc = null;
    this.localStream = null;
    this.audioEl = null;
    this.teardownOutputAnalyser();
    this.isPaused = false;
    this.callbacks.onConnectionChange(false, "Realtime disconnected.");
  }

  setPaused(paused: boolean): void {
    const changed = this.isPaused !== paused;
    this.isPaused = paused;
    this.localStream?.getAudioTracks().forEach((track) => {
      track.enabled = !paused;
    });
    if (this.audioEl) {
      this.audioEl.muted = paused;
    }
    if (paused) this.callbacks.onOutputLevel?.(0);
    if (changed) {
      this.log(paused ? "voicePaused" : "voiceResumed", paused ? "Realtime voice paused." : "Realtime voice resumed.");
    }
  }

  setActiveChatContext(context: RealtimeChatContext | null): void {
    const previousKey = chatContextKey(this.activeChatContext);
    const nextKey = chatContextKey(context);
    this.activeChatContext = context;
    if (!this.connected || !nextKey || previousKey === nextKey) return;
    void this.injectActiveChatContext("switch");
  }

  speakStatus(message: string): void {
    if (!this.connected || this.paused || !message.trim()) return;
    this.send({
      type: "response.create",
      response: {
        conversation: "none",
        output_modalities: ["audio"],
        instructions: `Briefly tell the user this Codex status update in natural spoken English: ${JSON.stringify(
          message,
        )}`,
      },
    });
  }

  notifyCodexTurnCompleted(event: AppEvent): void {
    if (!this.connected) return;
    const update = codexCompletionUpdateText(event);
    if (!update) return;

    this.sendConversationText(update);
    this.log("codexCompletion", event.message, event.raw);
  }

  speakQueuedCodexTransition(raw: unknown): void {
    if (!this.connected) return;
    const update = queuedCodexTransitionText(raw);
    if (!update) return;

    this.sendConversationText(update.contextText);
    this.log("queuedCodexTransition", update.message, raw);
  }

  injectCodexTurnOutput(output: CodexTurnOutput): void {
    if (!this.connected) return;
    this.sendConversationText(codexTurnOutputContextText(output));
    this.log("codexTurnOutputContext", "Injected Codex final output into Realtime context.", output);
  }

  speakPendingRequest(request: PendingCodexRequest): void {
    if (!this.connected || this.paused) return;
    const isQuestion = request.kind === "question";
    const instructions = isQuestion
      ? [
          "Codex is asking the user a question.",
          "Briefly ask it in natural spoken English.",
          "Tell the user they can answer out loud.",
          `Question details: ${JSON.stringify(summarizePendingRequestForSpeech(request))}`,
        ].join("\n")
      : [
          "Codex is waiting for user approval.",
          "Ask for permission in natural spoken English.",
          "Mention the concrete command, file change, or tool details if present.",
          "Tell the user they can say allow, allow for this session, decline, or cancel.",
          `Approval details: ${JSON.stringify(summarizePendingRequestForSpeech(request))}`,
        ].join("\n");
    this.send({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions,
      },
    });
  }

  private sendConversationText(text: string): void {
    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text,
          },
        ],
      },
    });
  }

  private async injectActiveChatContext(reason: "connect" | "switch"): Promise<void> {
    const context = this.activeChatContext;
    const contextKey = chatContextKey(context);
    if (!context || !contextKey || !this.connected) return;

    const injectionSeq = ++this.chatContextInjectionSeq;
    try {
      const realtimeContext = await window.codexVoice.getRealtimeContext({
        scope: "active_focus",
        chatId: context.chatId,
      });
      if (
        !this.connected ||
        injectionSeq !== this.chatContextInjectionSeq ||
        chatContextKey(this.activeChatContext) !== contextKey
      ) {
        return;
      }

      const previousFingerprint = this.injectedTranscriptFingerprints.get(contextKey);
      if (realtimeContext.fingerprint && previousFingerprint === realtimeContext.fingerprint) return;
      this.sendConversationText(realtimeContext.text);
      if (realtimeContext.fingerprint) this.injectedTranscriptFingerprints.set(contextKey, realtimeContext.fingerprint);
      this.log("activeChatContext", `Injected active chat context for ${context.chatName}.`, {
        reason,
        chatId: context.chatId,
        threadId: context.threadId,
        contextScope: realtimeContext.scope,
        contextFingerprint: realtimeContext.fingerprint,
      });
    } catch (error) {
      this.log(
        "activeChatContextFailed",
        error instanceof Error ? error.message : "Unable to inject active chat context.",
        {
          reason,
          chatId: context.chatId,
        },
      );
    }
  }

  private handleMessage(event: MessageEvent<string>): void {
    let payload: any;
    try {
      payload = JSON.parse(event.data);
    } catch {
      this.log("parseError", event.data);
      return;
    }

    if (payload.type === "input_audio_buffer.speech_started") {
      this.log("userSpeechStarted", "User speech started.", payload);
      this.invalidatePendingToolCalls("userSpeechStarted", payload);
      return;
    }

    if (payload.type === "response.output_audio_transcript.delta" && payload.delta) {
      this.log("voiceDelta", payload.delta, payload);
      return;
    }

    if (payload.type === "conversation.item.input_audio_transcription.delta" && payload.delta) {
      this.log("userTranscriptDelta", payload.delta, payload);
      return;
    }

    if (payload.type === "conversation.item.input_audio_transcription.completed" && payload.transcript) {
      this.log("userTranscript", payload.transcript, payload);
      return;
    }

    if (payload.type === "response.output_audio_transcript.done" && payload.transcript) {
      this.log("assistantTranscript", payload.transcript, payload);
      return;
    }

    if (payload.type === "response.created") {
      const responseId = stringValue(payload.response?.id);
      if (responseId) this.ensureTrackedResponse(responseId);
    }

    if (payload.type === "response.output_item.added") {
      const item = payload.item;
      if (item?.type === "function_call") {
        this.upsertFunctionCall(stringValue(payload.response_id), item as FunctionCallItem);
      }
    }

    if (payload.type === "response.function_call_arguments.delta") {
      const call = this.findFunctionCall(payload);
      if (call && typeof payload.delta === "string") {
        call.arguments += payload.delta;
        this.log("toolArgsDelta", `${call.name} ${payload.delta}`, payload);
      }
    }

    if (payload.type === "response.function_call_arguments.done") {
      const call = this.findOrCreateFunctionCallFromArgumentEvent(payload);
      if (call) {
        call.arguments = typeof payload.arguments === "string" ? payload.arguments : call.arguments;
        call.name = stringValue(payload.name) ?? call.name;
        this.log("toolArgsDone", `${call.name} ${call.arguments}`, payload);
      }
    }

    if (payload.type === "response.output_item.done") {
      const item = payload.item;
      if (item?.type === "function_call") {
        this.upsertFunctionCall(stringValue(payload.response_id), item as FunctionCallItem);
      }
    }

    if (payload.type === "response.done") {
      const responseId = stringValue(payload.response?.id);
      const responseStatus = stringValue(payload.response?.status) ?? "completed";
      const record = responseId ? this.ensureTrackedResponse(responseId) : null;
      if (record) record.status = responseStatus;

      const output = payload.response?.output;
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item?.type === "function_call") {
            this.upsertFunctionCall(responseId, item as FunctionCallItem);
          }
        }
      }

      if (record) {
        if (responseStatus === "completed") {
          void this.handleFunctionCalls(record);
        } else {
          this.skipFunctionCalls(record, `Realtime response ended with status ${responseStatus}.`);
        }
      }
    }

    if (payload.type === "error") {
      this.log("error", payload.error?.message ?? "Realtime error.", payload);
      return;
    }

    this.log(payload.type ?? "event", payload.type ?? "Realtime event.", payload);
  }

  private ensureTrackedResponse(responseId: string): TrackedRealtimeResponse {
    const existing = this.trackedResponses.get(responseId);
    if (existing) return existing;
    const record: TrackedRealtimeResponse = {
      responseId,
      epoch: this.realtimeEpoch,
      calls: new Map(),
    };
    this.trackedResponses.set(responseId, record);
    return record;
  }

  private upsertFunctionCall(responseId: string | undefined, item: FunctionCallItem): TrackedFunctionCall | null {
    const callId = stringValue(item.call_id);
    const itemId = stringValue(item.id);
    const name = stringValue(item.name);
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
      } satisfies TrackedFunctionCall);

    call.name = name;
    call.itemId = itemId ?? call.itemId;
    call.status = stringValue(item.status) ?? call.status;
    if (typeof item.arguments === "string" && item.arguments.trim()) {
      call.arguments = item.arguments;
    }

    this.functionCallsByCallId.set(callId, call);
    if (call.itemId) this.functionCallsByItemId.set(call.itemId, call);
    record?.calls.set(callId, call);
    return call;
  }

  private findFunctionCall(payload: any): TrackedFunctionCall | null {
    const callId = stringValue(payload.call_id);
    const itemId = stringValue(payload.item_id);
    return (
      (callId ? this.functionCallsByCallId.get(callId) : undefined) ??
      (itemId ? this.functionCallsByItemId.get(itemId) : undefined) ??
      null
    );
  }

  private findOrCreateFunctionCallFromArgumentEvent(payload: any): TrackedFunctionCall | null {
    const existing = this.findFunctionCall(payload);
    if (existing) return existing;

    const responseId = stringValue(payload.response_id);
    const callId = stringValue(payload.call_id);
    const name = stringValue(payload.name);
    if (!responseId || !callId || !name) return null;

    return this.upsertFunctionCall(responseId, {
      type: "function_call",
      call_id: callId,
      id: stringValue(payload.item_id),
      name,
      arguments: typeof payload.arguments === "string" ? payload.arguments : "",
    });
  }

  private invalidatePendingToolCalls(kind: string, raw?: unknown): void {
    this.realtimeEpoch += 1;
    let invalidated = 0;
    for (const record of this.trackedResponses.values()) {
      for (const call of record.calls.values()) {
        if (!call.outputSent) {
          call.stale = true;
          if (call.running && call.cancel) {
            void call.cancel().catch((error) => {
              this.log("toolCancelFailed", `${call.name} cancellation failed.`, {
                responseId: record.responseId,
                callId: call.callId,
                error: error instanceof Error ? error.message : String(error),
              });
            });
          }
          invalidated += 1;
        }
      }
    }
    if (invalidated > 0) {
      this.log(kind, `Invalidated ${invalidated} pending Realtime tool call${invalidated === 1 ? "" : "s"}.`, raw);
    }
  }

  private skipFunctionCalls(record: TrackedRealtimeResponse, reason: string): void {
    let skipped = 0;
    for (const call of record.calls.values()) {
      if (!call.outputSent) {
        call.stale = true;
        call.outputSent = true;
        skipped += 1;
      }
    }
    if (skipped > 0) this.log("toolCallsSkipped", reason, { responseId: record.responseId, skipped });
    this.cleanupTrackedResponse(record);
  }

  private async handleFunctionCalls(record: TrackedRealtimeResponse): Promise<void> {
    const calls = [...record.calls.values()].filter((call) => !call.outputSent);
    if (calls.length === 0) {
      this.cleanupTrackedResponse(record);
      return;
    }

    const outputs: Array<{ call: TrackedFunctionCall; output: unknown }> = [];
    for (const call of calls) {
      if (call.stale || record.epoch !== this.realtimeEpoch) {
        call.outputSent = true;
        this.log("toolCallSkipped", `${call.name} skipped because the Realtime response was interrupted.`, {
          responseId: record.responseId,
          callId: call.callId,
        });
        continue;
      }

      let output: unknown;
      const args = safeJson(call.arguments);
      if ("pendingOutput" in call) {
        output = call.pendingOutput;
      } else {
        call.running = true;
        this.log("toolCall", `${call.name} ${JSON.stringify(args)}`, {
          responseId: record.responseId,
          callId: call.callId,
          arguments: call.arguments,
        });

        try {
          output = await callVoiceTool(call.name, args, (cancel) => {
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

      if (call.stale || record.epoch !== this.realtimeEpoch || !this.connected) {
        call.outputSent = true;
        await cancelStaleVoiceTool(call.name, output).catch((error) => {
          this.log("toolCancelFailed", `${call.name} stale-result cleanup failed.`, {
            responseId: record.responseId,
            callId: call.callId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
        this.log("toolResultDiscarded", `${call.name} completed after interruption; result was not sent to Realtime.`, {
          responseId: record.responseId,
          callId: call.callId,
          output,
        });
        this.cleanupTrackedResponse(record);
        return;
      }

      this.log("toolResult", `${call.name} completed.`, {
        responseId: record.responseId,
        name: call.name,
        callId: call.callId,
        arguments: args,
        output,
      });
      outputs.push({ call, output });
    }

    if (outputs.length === 0 || !this.connected || record.epoch !== this.realtimeEpoch) {
      this.cleanupTrackedResponse(record);
      return;
    }

    try {
      for (const { call, output } of outputs) {
        this.send({
          type: "conversation.item.create",
          item: {
            type: "function_call_output",
            call_id: call.callId,
            output: JSON.stringify(output),
          },
        });
      }
      if (shouldCreateRealtimeResponseAfterToolOutputs(outputs.map(({ call }) => call.name))) {
        this.send({ type: "response.create" });
      }
    } catch (error) {
      this.log("toolOutputSendFailed", "Could not send Realtime tool output.", {
        responseId: record.responseId,
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.connected && record.epoch === this.realtimeEpoch) {
        window.setTimeout(() => {
          if (this.trackedResponses.has(record.responseId)) {
            void this.handleFunctionCalls(record);
          }
        }, 250);
      } else {
        this.cleanupTrackedResponse(record);
      }
      return;
    }

    for (const { call } of outputs) {
      call.outputSent = true;
      call.pendingOutput = undefined;
    }
    this.cleanupTrackedResponse(record);
  }

  private cleanupTrackedResponse(record: TrackedRealtimeResponse): void {
    this.trackedResponses.delete(record.responseId);
    for (const call of record.calls.values()) {
      this.functionCallsByCallId.delete(call.callId);
      if (call.itemId) this.functionCallsByItemId.delete(call.itemId);
    }
  }

  private send(payload: unknown): void {
    if (!this.dc || this.dc.readyState !== "open") {
      throw new Error("Realtime data channel is not open.");
    }
    this.log("outbound", realtimeOutboundLabel(payload), payload);
    this.dc.send(JSON.stringify(payload));
  }

  private setupOutputAnalyser(stream: MediaStream): void {
    this.teardownOutputAnalyser();
    const AudioContextConstructor =
      window.AudioContext ??
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextConstructor) return;

    try {
      const audioContext = new AudioContextConstructor();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.12;
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(analyser);

      this.outputAudioContext = audioContext;
      this.outputAudioSource = source;
      this.outputAnalyser = analyser;
      this.outputSamples = new Uint8Array(analyser.fftSize);
      this.smoothedOutputLevel = 0;
      void audioContext.resume().catch(() => undefined);
      this.startOutputLevelLoop();
    } catch (error) {
      this.log("audioAnalyserError", error instanceof Error ? error.message : String(error));
      this.teardownOutputAnalyser();
    }
  }

  private teardownOutputAnalyser(): void {
    if (this.outputLevelFrame !== null) {
      window.cancelAnimationFrame(this.outputLevelFrame);
      this.outputLevelFrame = null;
    }
    this.outputAudioSource?.disconnect();
    this.outputAudioSource = null;
    this.outputAnalyser = null;
    this.outputSamples = null;
    this.smoothedOutputLevel = 0;
    const audioContext = this.outputAudioContext;
    this.outputAudioContext = null;
    if (audioContext && audioContext.state !== "closed") {
      void audioContext.close().catch(() => undefined);
    }
    this.callbacks.onOutputLevel?.(0);
  }

  private startOutputLevelLoop(): void {
    if (!this.outputAnalyser || !this.outputSamples || this.outputLevelFrame !== null) return;

    const tick = () => {
      if (!this.outputAnalyser || !this.outputSamples) {
        this.outputLevelFrame = null;
        return;
      }

      this.outputAnalyser.getByteTimeDomainData(this.outputSamples);
      let sumSquares = 0;
      for (const sample of this.outputSamples) {
        const centered = (sample - 128) / 128;
        sumSquares += centered * centered;
      }
      const rms = Math.sqrt(sumSquares / this.outputSamples.length);
      const rawLevel = Math.max(0, Math.min(1, (rms - 0.012) / 0.16));
      const smoothing = rawLevel > this.smoothedOutputLevel ? 0.36 : 0.12;
      this.smoothedOutputLevel += (rawLevel - this.smoothedOutputLevel) * smoothing;
      this.callbacks.onOutputLevel?.(this.isPaused ? 0 : this.smoothedOutputLevel);
      this.outputLevelFrame = window.requestAnimationFrame(tick);
    };

    this.outputLevelFrame = window.requestAnimationFrame(tick);
  }

  private log(kind: string, message: string, raw?: unknown): void {
    this.callbacks.onLog({
      at: new Date().toISOString(),
      source: "realtime",
      kind,
      message,
      raw,
    });
  }

  private notifySessionStarted(): void {
    if (this.sessionLifecycleActive) return;
    this.sessionLifecycleActive = true;
    void this.callbacks.onSessionStarted?.().catch((error) => {
      this.log("sessionLifecycleFailed", error instanceof Error ? error.message : "Unable to mark realtime started.");
    });
  }

  private notifySessionEnded(): void {
    if (!this.sessionLifecycleActive) return;
    this.sessionLifecycleActive = false;
    void this.callbacks.onSessionEnded?.().catch((error) => {
      this.log("sessionLifecycleFailed", error instanceof Error ? error.message : "Unable to mark realtime ended.");
    });
  }
}

async function callVoiceTool(
  name: string,
  args: Record<string, unknown>,
  registerCancel?: (cancel: () => Promise<void>) => void,
): Promise<unknown> {
  void registerCancel;
  if (name === "remain_silent") {
    return { ok: true, silent: true };
  }

  if (name === "submit_to_codex") {
    const request = stringArg(args.request);
    const context = optionalString(args.context);
    const chatId = await resolveChatId(optionalString(args.chatId), optionalString(args.chatName));
    const result = await window.codexVoice.sendToCodex(
      request,
      chatId,
      optionalString(args.workspacePath),
      { source: "realtime", transcriptDelta: context },
    );
    return {
      ok: true,
      message: "Work started.",
      turnId: result.turnId,
      project: result.project,
      chat: result.chat,
    };
  }

  if (name === "steer_codex") {
    const result = await window.codexVoice.steerCodex(
      stringArg(args.message),
      await resolveChatId(optionalString(args.chatId), optionalString(args.chatName)),
    );
    return { ok: true, message: "Update received.", ...result };
  }

  if (name === "queue_codex_request") {
    const request = stringArg(args.request);
    const context = optionalString(args.context);
    const result = await window.codexVoice.queueCodexRequest(
      request,
      await resolveChatId(optionalString(args.chatId), optionalString(args.chatName)),
      optionalString(args.workspacePath),
      { source: "realtime", transcriptDelta: context },
    );
    return { ok: true, ...result };
  }

  if (name === "cancel_queued_codex_request") {
    const result = await window.codexVoice.cancelQueuedCodexRequest(
      optionalString(args.queuedId),
      await resolveChatId(optionalString(args.chatId), optionalString(args.chatName)),
    );
    return { ok: true, ...result };
  }

  if (name === "interrupt_codex") {
    await window.codexVoice.interruptCodex(await resolveChatId(optionalString(args.chatId), optionalString(args.chatName)));
    return { ok: true, message: "Codex interruption was requested." };
  }

  if (name === "get_codex_status") {
    const state = await window.codexVoice.getState();
    const activeProject = state.activeProject;
    return {
      ok: true,
      activeProject,
      activeChat: activeProject ? activeChat(visibleChats(activeProject.chats), activeProject.activeChatId) : null,
      runtime: state.runtime,
      codexSettings: state.codexSettings,
    };
  }

  if (name === "get_codex_context") {
    const result = await window.codexVoice.getRealtimeContext({
      scope: realtimeContextScopeArg(args.scope),
      chatId: optionalString(args.chatId),
      chatName: optionalString(args.chatName),
    });
    return { ...result, context: result.text };
  }

  if (name === "list_codex_subagents") {
    const result = await window.codexVoice.listSubagents(
      await resolveChatId(optionalString(args.chatId), optionalString(args.chatName), true),
    );
    return { ok: true, ...result };
  }

  if (name === "inspect_codex_subagent") {
    const result = await window.codexVoice.inspectSubagent(
      optionalString(args.target),
      await resolveChatId(optionalString(args.chatId), optionalString(args.chatName), true),
    );
    return { ok: true, ...summarizeSubagentInspection(result) };
  }

  if (name === "steer_codex_subagent") {
    const result = await window.codexVoice.steerSubagent(
      optionalString(args.target),
      stringArg(args.message),
      await resolveChatId(optionalString(args.chatId), optionalString(args.chatName), true),
    );
    return { ok: true, message: "Child subagent received the update.", ...result };
  }

  if (name === "answer_codex_approval") {
    const state = await window.codexVoice.getState();
    const request = findPendingRequest(
      state.runtime.pendingRequests,
      optionalString(args.requestId),
      canAnswerWithApprovalDecision,
      "approval",
    );
    const decision = approvalDecisionArg(args.decision);
    await window.codexVoice.answerApproval(request.requestId, decision);
    return {
      ok: true,
      message: approvalDecisionMessage(decision),
      request: summarizePendingRequest(request),
    };
  }

  if (name === "answer_codex_question") {
    const answer = stringArg(args.answer);
    const state = await window.codexVoice.getState();
    const request = findPendingRequest(
      state.runtime.pendingRequests,
      optionalString(args.requestId),
      (candidate) => candidate.kind === "question",
      "question",
    );
    const answers = answersForQuestionRequest(request, optionalString(args.questionId), answer);
    await window.codexVoice.answerToolQuestion(request.requestId, answers);
    return {
      ok: true,
      message: "Answered Codex's question.",
      request: summarizePendingRequest(request),
      answers,
    };
  }

  if (name === "set_codex_model") {
    const settings = await window.codexVoice.setCodexSettings(
      { model: stringArg(args.model) },
      scopeArg(args.scope),
    );
    return { ok: true, message: "Updated Codex model settings.", settings };
  }

  if (name === "set_codex_reasoning_effort") {
    const settings = await window.codexVoice.setCodexSettings(
      { reasoningEffort: reasoningEffortArg(args.reasoningEffort) },
      scopeArg(args.scope),
    );
    return { ok: true, message: "Updated Codex reasoning effort settings.", settings };
  }

  if (name === "set_codex_permissions") {
    const settings = await window.codexVoice.setCodexSettings(
      { permissionMode: permissionModeArg(args.permissionMode) },
      scopeArg(args.scope),
    );
    return { ok: true, message: "Updated Codex permission settings.", settings };
  }

  if (name === "create_new_codex_project") {
    const project = await window.codexVoice.createProject(optionalString(args.name), optionalString(args.workspacePath));
    return { ok: true, project };
  }

  if (name === "create_new_codex_chat") {
    const project = await window.codexVoice.createChat(stringArg(args.name));
    return { ok: true, message: `Created chat ${stringArg(args.name)}.`, project, activeChat: activeChat(visibleChats(project.chats), project.activeChatId) };
  }

  if (name === "list_codex_chats") {
    const state = await window.codexVoice.getState();
    const activeProject = state.activeProject;
    return {
      ok: true,
      activeChatId: state.runtime.activeChatId,
      chats: visibleChats(activeProject?.chats ?? []),
      statuses: state.runtime.chats,
    };
  }

  if (name === "switch_codex_chat") {
    const chatId = await resolveChatId(optionalString(args.chatId), optionalString(args.name));
    if (!chatId) throw new Error("No chat matched that request.");
    const project = await window.codexVoice.switchChat(chatId);
    return { ok: true, message: "Switched active chat.", project, activeChat: activeChat(visibleChats(project.chats), project.activeChatId) };
  }

  if (name === "get_codex_chat_status") {
    const chatId = await resolveChatId(optionalString(args.chatId), optionalString(args.name), true);
    const statuses = await window.codexVoice.getChatStatus(chatId);
    return { ok: true, statuses };
  }

  if (name === "show_open_codex_chats") {
    await window.codexVoice.showProjectChats(true);
    const state = await window.codexVoice.getState();
    const activeProject = state.activeProject;
    return { ok: true, message: "Showing open chats.", chats: visibleChats(activeProject?.chats ?? []), statuses: state.runtime.chats };
  }

  if (name === "list_recent_codex_projects") {
    const state = await window.codexVoice.getState();
    const projects = state.projects;
    return {
      ok: true,
      projects: projects.slice(0, 8).map((project) => ({
        id: project.id,
        displayName: project.displayName,
        updatedAt: project.updatedAt,
        folderPath: project.folderPath,
        workspacePath: project.workspacePath,
        lastSummary: project.lastSummary,
        activeChatId: project.activeChatId,
        chats: visibleChats(project.chats),
      })),
    };
  }

  if (name === "continue_codex_project") {
    const state = await window.codexVoice.getState();
    const projectId = optionalString(args.projectId) || state.projects[0]?.id;
    if (!projectId) throw new Error("No recent Codex voice projects exist yet.");
    const project = await window.codexVoice.resumeProject(projectId);
    return { ok: true, project };
  }

  if (name === "summarize_recent_project") {
    const summary = await window.codexVoice.summarizeProject(optionalString(args.projectId), await resolveChatId(optionalString(args.chatId), optionalString(args.chatName), true));
    return { ok: true, summary };
  }

  throw new Error(`Unknown Realtime tool: ${name}`);
}

async function cancelStaleVoiceTool(name: string, output: unknown): Promise<void> {
  const result = output as {
    queued?: unknown;
    queuedId?: unknown;
    chatId?: unknown;
  } | null;

  if (name === "queue_codex_request" && result?.queued === true && typeof result.queuedId === "string") {
    const chatId = typeof result.chatId === "string" ? result.chatId : undefined;
    await window.codexVoice.cancelQueuedCodexRequest(result.queuedId, chatId);
  }
}

function safeJson(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function realtimeOutboundLabel(payload: unknown): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "Realtime outbound message.";
  const type = stringValue((payload as { type?: unknown }).type) ?? "message";
  if (type === "conversation.item.create") {
    const item = (payload as { item?: { type?: unknown } }).item;
    const itemType = item && typeof item === "object" ? stringValue(item.type) : undefined;
    return `Realtime outbound ${type}${itemType ? ` (${itemType})` : ""}.`;
  }
  if (type === "response.create") return "Realtime outbound response.create.";
  return `Realtime outbound ${type}.`;
}

function summarizeSubagentInspection(result: { subagent: unknown; summary: ActiveThreadSummary }): Record<string, unknown> {
  const summary = result.summary;
  return {
    subagent: result.subagent,
    summary: {
      status: summary.status,
      latestTurnStatus: summary.latestTurnStatus,
      latestAssistantText: summary.latestAssistantText,
      turnCount: summary.turnCount,
      progress: summary.progress.slice(-8).map((item) => ({
        label: item.label,
        detail: item.detail,
        status: item.status,
        sourceType: item.sourceType,
      })),
    },
  };
}

function stringArg(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Tool argument must be a non-empty string.");
  }
  return value.trim();
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function realtimeContextScopeArg(value: unknown): RealtimeContextRequest["scope"] {
  const scope = optionalString(value);
  const allowed: Array<NonNullable<RealtimeContextRequest["scope"]>> = [
    "startup",
    "active_focus",
    "current_thread",
    "recent_work",
    "workspace_map",
    "subagents",
    "plugins",
    "all",
  ];
  return allowed.includes(scope as NonNullable<RealtimeContextRequest["scope"]>)
    ? scope as RealtimeContextRequest["scope"]
    : undefined;
}

async function resolveChatId(
  chatId: string | undefined,
  name?: string,
  allowAll = false,
): Promise<string | undefined> {
  if (chatId) return chatId;
  if (!name) return allowAll ? undefined : undefined;
  const state = await window.codexVoice.getState();
  const chat = findChatByName(state, name);
  if (!chat) throw new Error(`No chat matched "${name}".`);
  return chat.id;
}

function findChatByName(state: AppState, name: string): VoiceChat | null {
  const needle = name.trim().toLowerCase();
  const activeProject = state.activeProject;
  const chats = visibleChats(activeProject?.chats ?? []);
  const exact = chats.filter((chat) => chat.displayName.toLowerCase() === needle || chat.id === name);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`More than one chat matched "${name}".`);
  const partial = chats.filter((chat) => chat.displayName.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`More than one chat matched "${name}".`);
  return null;
}

function activeChat(chats: VoiceChat[], activeChatId: string | null): VoiceChat | null {
  const visible = visibleChats(chats);
  return visible.find((chat) => chat.id === activeChatId) ?? visible[0] ?? null;
}

function visibleChats(chats: VoiceChat[]): VoiceChat[] {
  return chats.filter((chat) => !chat.archivedAt);
}

function scopeArg(value: unknown): CodexSettingsScope {
  return value === "nextTurn" ? "nextTurn" : "chat";
}

function reasoningEffortArg(value: unknown): "none" | "minimal" | "low" | "medium" | "high" | "xhigh" {
  const effort = stringArg(value);
  const allowed = ["none", "minimal", "low", "medium", "high", "xhigh"] as const;
  if (!allowed.includes(effort as (typeof allowed)[number])) {
    throw new Error(`Unknown reasoning effort: ${effort}`);
  }
  return effort as (typeof allowed)[number];
}

function permissionModeArg(value: unknown): CodexPermissionMode {
  const mode = stringArg(value).toLowerCase();
  const normalized = mode.replace(/[_\s]+/g, "-");
  if (["default", "default-permissions", "normal"].includes(normalized)) return "default";
  if (["auto", "auto-review", "autoreview"].includes(normalized)) return "auto-review";
  if (["full", "full-access", "danger", "danger-full-access"].includes(normalized)) return "full-access";
  if (
    ["custom", "custom-config", "custom-config-toml", "custom-config.toml", "config", "config-toml", "config.toml"].includes(
      normalized,
    )
  ) {
    return "custom-config";
  }
  throw new Error(`Unknown permission mode: ${mode}`);
}

function approvalDecisionArg(value: unknown): ApprovalDecision {
  const raw = stringArg(value).toLowerCase();
  if (["accept", "allow", "approve", "yes", "ok", "okay", "go ahead"].includes(raw)) {
    return "accept";
  }
  if (["acceptforsession", "accept_for_session", "allowforsession", "session", "always"].includes(raw)) {
    return "acceptForSession";
  }
  if (["decline", "deny", "no", "do not allow", "don't allow"].includes(raw)) {
    return "decline";
  }
  if (["cancel", "abort", "stop"].includes(raw)) {
    return "cancel";
  }
  throw new Error(`Unknown approval decision: ${raw}`);
}

function findPendingRequest(
  requests: PendingCodexRequest[],
  requestId: string | undefined,
  predicate: (request: PendingCodexRequest) => boolean,
  label: string,
): PendingCodexRequest {
  const matching = requests.filter(predicate);
  if (requestId) {
    const request = matching.find((candidate) => String(candidate.requestId) === requestId);
    if (!request) throw new Error(`No pending Codex ${label} matched request id ${requestId}.`);
    return request;
  }
  if (matching.length === 1) return matching[0];
  if (matching.length === 0) throw new Error(`There is no pending Codex ${label}.`);
  throw new Error(`There is more than one pending Codex ${label}; ask which one to answer.`);
}

function canAnswerWithApprovalDecision(request: PendingCodexRequest): boolean {
  return request.kind === "approval" || request.kind === "elicitation" || request.kind === "tool" || request.kind === "auth";
}

function answersForQuestionRequest(
  request: PendingCodexRequest,
  questionId: string | undefined,
  answer: string,
): ToolQuestionAnswer[] {
  const raw = request.raw as { raw?: { params?: { questions?: Array<any> } }; params?: { questions?: Array<any> } };
  const questions = request.questions ?? raw.params?.questions ?? raw.raw?.params?.questions ?? [];
  if (questions.length === 0) {
    if (!questionId) throw new Error("Codex question payload did not include question ids.");
    return [{ questionId, answers: [answer] }];
  }
  if (questionId && !questions.some((question) => question.id === questionId)) {
    throw new Error(`No pending Codex question matched question id ${questionId}.`);
  }
  if (questionId) {
    const question = questions.find((candidate) => candidate.id === questionId);
    return [{ questionId, answers: [answerForQuestion(question, answer)] }];
  }
  if (!questionId && questions.length > 1) {
    throw new Error("There is more than one Codex question; ask which one to answer.");
  }
  return questions.map((question) => ({
    questionId: question.id,
    answers: [answerForQuestion(question, answer)],
  }));
}

function answerForQuestion(
  question: { options?: Array<{ label: string }> | null } | undefined,
  answer: string,
): string {
  const spoken = answer.trim();
  const options = question?.options ?? [];
  const exact = options.find((option) => option.label.toLowerCase() === spoken.toLowerCase());
  if (exact) return exact.label;
  return spoken;
}

function approvalDecisionMessage(decision: ApprovalDecision): string {
  if (decision === "accept") return "Approved Codex's request.";
  if (decision === "acceptForSession") return "Approved Codex's request for this session.";
  if (decision === "decline") return "Declined Codex's request.";
  return "Cancelled Codex's request.";
}

function summarizePendingRequest(request: PendingCodexRequest): Record<string, unknown> {
  return {
    requestId: request.requestId,
    method: request.method,
    kind: request.kind,
    title: request.title,
    subtitle: request.subtitle,
    body: request.body,
    chat: request.chatName,
    details: request.details,
    questions: request.questions,
  };
}

function summarizePendingRequestForSpeech(request: PendingCodexRequest): Record<string, unknown> {
  return {
    title: request.title,
    subtitle: request.subtitle,
    chat: request.chatName,
    body: request.body,
    details: request.details,
    questions: request.questions?.map((question) => ({
      header: question.header,
      question: question.question,
      options: question.options?.map((option) => option.label),
    })),
  };
}

function codexCompletionUpdateText(event: AppEvent): string | null {
  const message = event.message.trim();
  if (!message) return null;
  const raw = (event.raw ?? {}) as {
    threadId?: unknown;
    turn?: {
      id?: unknown;
      status?: unknown;
      error?: { message?: unknown };
    };
  };
  const turn = raw.turn ?? {};
  const lines = [
    "App status update from Codex, not a user request.",
    "Codex turn completed.",
    `Status: ${message}`,
  ];
  if (typeof raw.threadId === "string" && raw.threadId.trim()) {
    lines.push(`Thread ID: ${raw.threadId}`);
  }
  if (typeof turn.id === "string" && turn.id.trim()) {
    lines.push(`Turn ID: ${turn.id}`);
  }
  if (typeof turn.status === "string" && turn.status.trim()) {
    lines.push(`Turn status: ${turn.status}`);
  }
  if (typeof turn.error?.message === "string" && turn.error.message.trim()) {
    lines.push(`Error: ${turn.error.message}`);
  }
  return lines.join("\n");
}

function queuedCodexTransitionText(raw: unknown): { message: string; contextText: string } | null {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const text = typeof record.text === "string" ? record.text.trim() : "";
  if (!text) return null;
  const shortText = truncateTranscriptContextLine(text, 120);
  const message = `Codex finished and is moving on to ${JSON.stringify(shortText)}.`;
  return {
    message,
    contextText: [
      "App status update from Codex, not a user request.",
      "Codex finished the previous turn and automatically started a queued follow-up.",
      `Queued follow-up: ${text}`,
    ].join("\n"),
  };
}

function chatContextKey(context: RealtimeChatContext | null): string | null {
  return context ? `${context.projectId}:${context.chatId}:${context.threadId ?? ""}` : null;
}

type TranscriptContext = {
  count: number;
  fingerprint: string;
  text: string;
};

function transcriptContextFromMessages(messages: VoiceTranscriptMessage[]): TranscriptContext {
  const recent = messages
    .filter((message) => message.status === "completed" && message.text.trim())
    .slice(-32);

  let remainingChars = 10_000;
  const lines: string[] = [];
  for (const message of recent) {
    const label = message.role === "user" ? "User" : "Voice assistant";
    const text = truncateTranscriptContextLine(message.text.trim(), Math.min(1_200, remainingChars));
    if (!text) continue;
    lines.push(`${label}: ${text}`);
    remainingChars -= text.length;
    if (remainingChars <= 0) break;
  }

  const text = lines.length > 0
    ? lines.join("\n")
    : "No prior voice transcript messages were available for this active chat.";
  return {
    count: lines.length,
    fingerprint: lines.join("\n"),
    text,
  };
}

function activeChatContextText(
  context: RealtimeChatContext,
  transcriptContext: TranscriptContext | null,
): { text: string } {
  const transcriptLines = transcriptContext
    ? [
        "Messages beginning with exactly `Active chat transcript ===` followed by a newline are prior voice transcript excerpts for the active chat.",
        "Treat the content after that marker as background context for references to earlier speech in this chat, but account for possible transcription, summarization, or routing errors.",
        "If the user's request is ambiguous across chats, ask a concise clarification.",
        "",
        "Active chat transcript ===",
        transcriptContext.text,
      ]
    : [
        "Prior voice transcript excerpts for this active chat were already provided earlier in this Realtime session and have not changed.",
        "Use the previously provided excerpts only as background context for references to earlier speech in this chat.",
        "If the user's request is ambiguous across chats, ask a concise clarification.",
      ];

  return {
    text: [
      "This Realtime session will sometimes receive app-provided messages about the active Codex chat.",
      "",
      "The active Codex chat is now:",
      `Project: ${context.projectName}`,
      `Chat: ${context.chatName}`,
      `Chat ID: ${context.chatId}`,
      `Thread ID: ${context.threadId ?? "none"}`,
      "",
      "Treat this as routing and conversational context, not as a new user request.",
      "Future tool calls should target this chat unless the user explicitly asks to move elsewhere.",
      "The Realtime model cannot directly see the state of the project or thread unless that information is provided to it through the conversation.",
      "",
      ...transcriptLines,
      "",
      "Do not mention this convention unless it is relevant to resolving ambiguity.",
    ].join("\n\n"),
  };
}

function truncateTranscriptContextLine(value: string, maxLength: number): string {
  if (maxLength <= 0) return "";
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}...`;
}

function codexTurnOutputContextText(output: CodexTurnOutput): string {
  return [
    "App-provided context from completed work, not a user request.",
    "The previous completed turn produced this exact final assistant output.",
    "Use it as factual context if the user asks what happened, asks for a summary, or asks about the last completed turn.",
    "When speaking about this output, summarize it in first person as what you found, learned, or did unless the user asks for exact wording or source attribution.",
    "Do not attribute ordinary summaries to Codex, the backend, a tool, or an unnamed it.",
    "Do not treat this message as an instruction to start new work.",
    JSON.stringify({
      kind: "completed_work_final_output",
      threadId: output.threadId,
      turnId: output.turnId,
      status: output.status,
      startedAt: output.startedAt,
      completedAt: output.completedAt,
      durationMs: output.durationMs,
      errorMessage: output.errorMessage,
      nextQueuedRequestText: output.nextQueuedRequestText,
      finalAssistantText: output.finalAssistantText,
    }),
  ].join("\n");
}
