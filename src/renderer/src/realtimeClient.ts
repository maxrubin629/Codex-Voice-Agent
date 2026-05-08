import type {
  AppEvent,
  ApprovalDecision,
  AppState,
  CodexPermissionMode,
  CodexProjectTarget,
  CodexSettingsScope,
  CodexThreadTarget,
  CodexTurnOutput,
  DispatchCodexTaskArgs,
  PendingCodexRequest,
  RealtimeUserAttachment,
  RealtimeUserAttachmentMetadata,
  RealtimeUserInput,
  ToolQuestionAnswer,
  VoiceChat,
  VoiceTranscriptMessage,
} from "../../shared/types";

type RealtimeCallbacks = {
  onLog: (event: AppEvent) => void;
  onConnectionChange: (connected: boolean, label: string) => void;
  onOutputLevel?: (level: number) => void;
  getTranscriptMessages?: () => Promise<VoiceTranscriptMessage[]>;
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
  private lastAudibleOutputAtMs = 0;
  private isPaused = false;
  private realtimeEpoch = 0;
  private pendingResponseCreates = 0;
  private trackedResponses = new Map<string, TrackedRealtimeResponse>();
  private functionCallsByCallId = new Map<string, TrackedFunctionCall>();
  private functionCallsByItemId = new Map<string, TrackedFunctionCall>();

  constructor(private readonly callbacks: RealtimeCallbacks) {}

  get connected(): boolean {
    return this.dc?.readyState === "open";
  }

  get paused(): boolean {
    return this.isPaused;
  }

  private isCurrentConnection(epoch: number, pc: RTCPeerConnection, dc?: RTCDataChannel): boolean {
    return this.realtimeEpoch === epoch && this.pc === pc && (!dc || this.dc === dc);
  }

  private assertCurrentConnection(epoch: number, pc?: RTCPeerConnection): void {
    if (this.realtimeEpoch !== epoch || (pc && this.pc !== pc)) {
      throw new Error("Realtime connection was cancelled.");
    }
  }

  async connect(): Promise<void> {
    if (this.pc) return;
    const epoch = this.realtimeEpoch;
    this.callbacks.onConnectionChange(false, "Creating Realtime session.");
    const secret = await window.codexVoice.createRealtimeClientSecret();
    this.assertCurrentConnection(epoch);

    const pc = new RTCPeerConnection();
    const audioEl = document.createElement("audio");
    this.pc = pc;
    this.audioEl = audioEl;
    audioEl.autoplay = true;
    pc.ontrack = (event) => {
      if (this.pc !== pc || this.realtimeEpoch !== epoch) return;
      const [remoteStream] = event.streams;
      audioEl.srcObject = remoteStream;
      if (remoteStream) this.setupOutputAnalyser(remoteStream);
    };

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      if (!this.isCurrentConnection(epoch, pc)) {
        stream.getTracks().forEach((track) => track.stop());
        throw new Error("Realtime connection was cancelled.");
      }
      this.localStream = stream;
      pc.addTrack(stream.getAudioTracks()[0], stream);

      const dc = pc.createDataChannel("oai-events");
      this.dc = dc;
      dc.addEventListener("open", () => {
        if (!this.isCurrentConnection(epoch, pc, dc)) return;
        this.setPaused(false);
        this.callbacks.onConnectionChange(
          true,
          `Connected to ${secret.model} (${secret.voice}, reasoning ${secret.reasoningEffort}).`,
        );
        this.log("connection", "Realtime data channel opened.");
        void this.injectTranscriptHistoryContext();
      });
      dc.addEventListener("close", () => {
        if (!this.isCurrentConnection(epoch, pc, dc)) return;
        this.callbacks.onConnectionChange(false, "Realtime data channel closed.");
        this.log("connection", "Realtime data channel closed.");
      });
      dc.addEventListener("message", (event) => this.handleMessage(event));

      const offer = await pc.createOffer();
      this.assertCurrentConnection(epoch, pc);
      await pc.setLocalDescription(offer);
      this.assertCurrentConnection(epoch, pc);

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

      const answerSdp = await response.text();
      this.assertCurrentConnection(epoch, pc);
      await pc.setRemoteDescription({
        type: "answer",
        sdp: answerSdp,
      });
      this.assertCurrentConnection(epoch, pc);
    } catch (error) {
      if (this.realtimeEpoch === epoch) {
        this.disconnect();
      }
      throw error;
    }
  }

  disconnect(): void {
    const hadConnection = Boolean(this.pc || this.dc || this.localStream || this.audioEl);
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
    if (hadConnection) {
      this.callbacks.onConnectionChange(false, "Realtime disconnected.");
    }
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

  sendUserInput(input: RealtimeUserInput): void {
    const text = input.text.trim();
    const attachments = input.attachments ?? [];
    if (!text && attachments.length === 0) {
      throw new Error("Message or image is required.");
    }

    this.interruptActiveResponse(
      "userInput",
      "Interrupted active Realtime response for new user text input.",
      { text, attachmentCount: attachments.length },
    );
    const content: Array<Record<string, unknown>> = [];
    if (text) {
      content.push({
        type: "input_text",
        text,
      });
    }
    for (const attachment of attachments) {
      content.push({
        type: "input_image",
        image_url: attachment.dataUrl,
      });
    }

    this.send({
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content,
      },
    });
    this.log("userInput", userInputLogMessage(text, attachments), {
      type: "conversation.item.create",
      userInputId: `user-input-${Date.now()}`,
      text,
      attachments: attachments.map(sanitizeAttachmentForLog),
    });
    this.send({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
      },
    });
  }

  notifyCodexTurnCompleted(event: AppEvent): void {
    if (!this.connected) return;
    const update = codexCompletionUpdateText(event);
    if (!update) return;

    this.sendConversationText(update);
    this.log("codexCompletion", event.message, event.raw);
    if (this.paused) return;

    this.send({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: codexCompletionSpeechInstructions(event),
      },
    });
  }

  injectCodexTurnOutput(output: CodexTurnOutput): void {
    if (!this.connected) return;
    this.sendConversationText(codexTurnOutputContextText(output));
    this.log("codexTurnOutputContext", "Injected Codex final output into Realtime context.", output);
    if (this.paused) return;

    this.send({
      type: "response.create",
      response: {
        output_modalities: ["audio"],
        instructions: [
          "App-provided Codex final output was just added to the conversation.",
          "Give the user a short natural completion nudge, not a full summary.",
          "Prefer the shape: 'Hey, just wanted to let you know Codex finished ...' but vary the wording naturally.",
          "Use the final output to decide whether the blank should be a specific task/outcome, a blocker, or no extra detail.",
          "Share at most one specific detail unless the final output says Codex failed or the user needs to act.",
          "If no concise specific detail is obvious, simply say Codex finished.",
          "Do not read long paths, logs, lists, or test output aloud.",
          "Use one short sentence, or two only if there is an important next step.",
          "Do not call tools.",
        ].join("\n"),
      },
    });
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

  private async injectTranscriptHistoryContext(): Promise<void> {
    if (!this.callbacks.getTranscriptMessages || !this.connected) return;
    try {
      const context = transcriptHistoryContext(await this.callbacks.getTranscriptMessages());
      if (!context || !this.connected) return;
      this.sendConversationText(context.text);
      this.log("transcriptHistoryContext", `Injected ${context.count} prior transcript messages.`, {
        count: context.count,
      });
    } catch (error) {
      this.log(
        "transcriptHistoryContextFailed",
        error instanceof Error ? error.message : "Unable to inject transcript history.",
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

    if (payload.type === "input_audio_buffer.speech_stopped") {
      this.log("userSpeechStopped", "User speech stopped.", payload);
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

    if (payload.type === "conversation.item.input_audio_transcription.failed") {
      this.log("userTranscriptFailed", payload.error?.message ?? "User transcription failed.", payload);
      return;
    }

    if (payload.type === "response.output_audio_transcript.done" && payload.transcript) {
      this.log("assistantTranscript", payload.transcript, payload);
      return;
    }

    if (payload.type === "response.created") {
      const responseId = stringValue(payload.response?.id);
      if (this.pendingResponseCreates > 0) this.pendingResponseCreates -= 1;
      if (responseId) {
        const record = this.ensureTrackedResponse(responseId);
        record.status = stringValue(payload.response?.status) ?? record.status ?? "in_progress";
      }
    }

    if (payload.type === "response.cancelled") {
      if (this.pendingResponseCreates > 0) this.pendingResponseCreates -= 1;
      const responseId = stringValue(payload.response_id) ?? stringValue(payload.response?.id);
      const record = responseId ? this.trackedResponses.get(responseId) : null;
      if (record) {
        record.status = "cancelled";
        this.skipFunctionCalls(record, "Realtime response was cancelled.");
      }
      this.log("response.cancelled", "Realtime response cancelled.", payload);
      return;
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

  private interruptActiveResponse(kind: string, message: string, raw?: unknown): void {
    const shouldCancelResponse = this.hasInterruptibleResponse();
    this.invalidatePendingToolCalls(kind, raw);
    if (!shouldCancelResponse) return;

    this.send({ type: "response.cancel" });
    if (this.hasRecentOutputPlayback()) {
      this.send({ type: "output_audio_buffer.clear" });
    }
    this.callbacks.onOutputLevel?.(0);
    this.log("responseInterrupted", message, raw);
  }

  private hasInterruptibleResponse(): boolean {
    if (this.pendingResponseCreates > 0) return true;
    for (const record of this.trackedResponses.values()) {
      if (!isTerminalRealtimeResponseStatus(record.status)) return true;
    }
    return false;
  }

  private hasRecentOutputPlayback(): boolean {
    return Date.now() - this.lastAudibleOutputAtMs < 1_500;
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
      this.send({ type: "response.create" });
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
    this.dc.send(JSON.stringify(payload));
    if (outgoingEventType(payload) === "response.create") {
      this.pendingResponseCreates += 1;
    }
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
      if (rawLevel > 0.018 || this.smoothedOutputLevel > 0.03) {
        this.lastAudibleOutputAtMs = Date.now();
      }
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
}

async function callVoiceTool(
  name: string,
  args: Record<string, unknown>,
  registerCancel?: (cancel: () => Promise<void>) => void,
): Promise<unknown> {
  if (name === "submit_to_codex") {
    const request = stringArg(args.request);
    const context = optionalString(args.context);
    const chatId = await resolveChatId(optionalString(args.chatId), optionalString(args.chatName), optionalString(args.threadHandle));
    const result = await window.codexVoice.sendToCodex(
      context ? `${request}\n\nVoice conversation context:\n${context}` : request,
      chatId,
      optionalString(args.workspacePath),
    );
    return {
      ok: true,
      message: result.message,
      turnId: result.turnId,
      projectHandle: result.projectHandle,
      threadHandle: result.threadHandle,
      project: result.project,
      chat: result.chat,
      thread: result.chat,
    };
  }

  if (name === "dispatch_codex_task") {
    const request = stringArg(args.request);
    const task: DispatchCodexTaskArgs = {
      request,
      context: optionalString(args.context),
      project: projectTargetFromArgs(args),
      thread: threadTargetFromArgs(args),
    };
    const result = await window.codexVoice.dispatchCodexTask(task);
    return {
      ok: true,
      message: result.message,
      turnId: result.turnId,
      projectHandle: result.projectHandle,
      threadHandle: result.threadHandle,
      project: result.project,
      chat: result.chat,
      thread: result.chat,
    };
  }

  if (name === "steer_codex") {
    const project = projectTargetFromArgs(args);
    const chatId = project
      ? (await resolveChatIdInProject(project, optionalString(args.chatId), optionalString(args.chatName), optionalString(args.threadHandle), true)) ??
        (await resolveActiveChatIdInProject(project))
      : await resolveChatId(optionalString(args.chatId), optionalString(args.chatName), optionalString(args.threadHandle));
    const result = await window.codexVoice.steerCodex(
      stringArg(args.message),
      chatId,
    );
    return { ok: true, message: "Codex received the update.", ...result };
  }

  if (name === "interrupt_codex") {
    const project = projectTargetFromArgs(args);
    const chatId = project
      ? (await resolveChatIdInProject(project, optionalString(args.chatId), optionalString(args.chatName), optionalString(args.threadHandle), true)) ??
        (await resolveActiveChatIdInProject(project))
      : await resolveChatId(optionalString(args.chatId), optionalString(args.chatName), optionalString(args.threadHandle));
    await window.codexVoice.interruptCodex(
      chatId,
    );
    return { ok: true, message: "Codex interruption was requested." };
  }

  if (name === "get_codex_status") {
    const state = await window.codexVoice.getState();
    const activeProject = state.activeProject;
    const activeThread = activeProject ? activeChat(visibleChats(activeProject.chats), activeProject.activeChatId) : null;
    return {
      ok: true,
      activeProject,
      activeThread,
      activeChat: activeThread,
      runtime: state.runtime,
      codexSettings: state.codexSettings,
    };
  }

  if (name === "web_search") {
    const requestId = `web-search-${Date.now()}-${crypto.randomUUID()}`;
    registerCancel?.(() => window.codexVoice.cancelWebSearch(requestId));
    const result = await window.codexVoice.webSearch({
      query: stringArg(args.query),
      context: optionalString(args.context),
      requestId,
    });
    return { ok: true, ...result };
  }

  if (name === "exec_command") {
    const result = await window.codexVoice.execCommand({
      cmd: stringArg(args.cmd),
      workdir: optionalString(args.workdir),
      shell: optionalString(args.shell),
      tty: optionalBoolean(args.tty),
      login: optionalBoolean(args.login),
      yield_time_ms: optionalNumber(args.yield_time_ms),
      max_output_tokens: optionalNumber(args.max_output_tokens),
    });
    return { ok: true, ...result };
  }

  if (name === "write_stdin") {
    const result = await window.codexVoice.writeStdin({
      session_id: numberArg(args.session_id),
      chars: typeof args.chars === "string" ? args.chars : "",
      yield_time_ms: optionalNumber(args.yield_time_ms),
      max_output_tokens: optionalNumber(args.max_output_tokens),
    });
    return { ok: true, ...result };
  }

  if (name === "apply_patch") {
    const result = await window.codexVoice.applyPatch(stringArg(args.input));
    return { ok: true, ...result };
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

  if (name === "create_new_codex_thread" || name === "create_new_codex_chat") {
    const project = await window.codexVoice.createThread({
      name: stringArg(args.name),
      context: optionalString(args.context),
      project: projectTargetFromArgs(args, "createProjectIfMissing"),
      forceNew: optionalBoolean(args.forceNew),
    });
    const activeThread = activeChat(visibleChats(project.chats), project.activeChatId);
    return { ok: true, message: `Created thread ${stringArg(args.name)}.`, project, activeThread, activeChat: activeThread };
  }

  if (name === "list_codex_threads" || name === "list_codex_chats") {
    if (optionalBoolean(args.allProjects) || projectTargetFromArgs(args)) {
      const projects = await window.codexVoice.listProjectThreads({ project: projectTargetFromArgs(args) });
      return { ok: true, projects };
    }
    const state = await window.codexVoice.getState();
    const activeProject = state.activeProject;
    return {
      ok: true,
      activeChatId: state.runtime.activeChatId,
      threads: visibleChats(activeProject?.chats ?? []),
      chats: visibleChats(activeProject?.chats ?? []),
      statuses: state.runtime.chats,
    };
  }

  if (name === "get_all_codex_thread_status") {
    const projects = await window.codexVoice.getAllThreadStatus({ project: projectTargetFromArgs(args) });
    return { ok: true, projects };
  }

  if (name === "switch_codex_thread" || name === "switch_codex_chat") {
    const targetProject = projectTargetFromArgs(args);
    const chatId = targetProject
      ? await resolveChatIdInProject(targetProject, optionalString(args.chatId), optionalString(args.name), optionalString(args.threadHandle))
      : await resolveChatId(optionalString(args.chatId), optionalString(args.name), optionalString(args.threadHandle));
    if (!chatId) throw new Error("No thread matched that request.");
    const project = await window.codexVoice.switchChat(chatId);
    const activeThread = activeChat(visibleChats(project.chats), project.activeChatId);
    return { ok: true, message: "Switched active thread.", project, activeThread, activeChat: activeThread };
  }

  if (name === "get_codex_thread_status" || name === "get_codex_chat_status") {
    const project = projectTargetFromArgs(args);
    if (project && !optionalString(args.chatId) && !optionalString(args.name) && !optionalString(args.threadHandle)) {
      const projects = await window.codexVoice.getAllThreadStatus({ project });
      return { ok: true, projects };
    }
    const chatId = project
      ? await resolveChatIdInProject(project, optionalString(args.chatId), optionalString(args.name), optionalString(args.threadHandle), true)
      : await resolveChatId(optionalString(args.chatId), optionalString(args.name), optionalString(args.threadHandle), true);
    const statuses = await window.codexVoice.getChatStatus(chatId);
    return { ok: true, statuses };
  }

  if (name === "show_open_codex_threads" || name === "show_open_codex_chats") {
    await window.codexVoice.showProjectChats(true);
    const state = await window.codexVoice.getState();
    const activeProject = state.activeProject;
    return {
      ok: true,
      message: "Showing open threads.",
      threads: visibleChats(activeProject?.chats ?? []),
      chats: visibleChats(activeProject?.chats ?? []),
      statuses: state.runtime.chats,
    };
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
        projectHandle: state.runtime.projectThreads.find((runtime) => runtime.projectId === project.id)?.projectHandle,
        chats: visibleChats(project.chats),
        threads: state.runtime.projectThreads.find((runtime) => runtime.projectId === project.id)?.chats ?? [],
      })),
    };
  }

  if (name === "continue_codex_project") {
    const state = await window.codexVoice.getState();
    const projectId = (await resolveProjectId(projectTargetFromArgs(args))) || state.projects[0]?.id;
    if (!projectId) throw new Error("No recent Codex voice projects exist yet.");
    const project = await window.codexVoice.resumeProject(projectId);
    return { ok: true, project };
  }

  if (name === "summarize_recent_project") {
    const projectId = await resolveProjectId(projectTargetFromArgs(args));
    const chatId = projectId
      ? await resolveChatIdInProject({ projectId }, optionalString(args.chatId), optionalString(args.chatName), optionalString(args.threadHandle), true)
      : await resolveChatId(optionalString(args.chatId), optionalString(args.chatName), optionalString(args.threadHandle), true);
    const summary = await window.codexVoice.summarizeProject(projectId, chatId);
    return { ok: true, summary };
  }

  if (name === "rename_codex_project") {
    const projectId = await resolveProjectId(projectTargetFromArgs(args));
    if (!projectId) throw new Error("Project target is required.");
    const project = await window.codexVoice.renameProject(projectId, stringArg(args.name));
    return { ok: true, project };
  }

  if (name === "rename_codex_thread") {
    const project = projectTargetFromArgs(args);
    const chatId = project
      ? await resolveChatIdInProject(project, optionalString(args.chatId), optionalString(args.chatName), optionalString(args.threadHandle))
      : await resolveChatId(optionalString(args.chatId), optionalString(args.chatName), optionalString(args.threadHandle));
    if (!chatId) throw new Error("Thread target is required.");
    const updated = await window.codexVoice.renameChat(chatId, stringArg(args.name));
    return { ok: true, project: updated };
  }

  if (name === "remove_codex_project") {
    const projectId = await resolveProjectId(projectTargetFromArgs(args));
    if (!projectId) throw new Error("Project target is required.");
    const project = await window.codexVoice.removeProject(projectId);
    return { ok: true, project };
  }

  if (name === "remove_codex_thread") {
    const project = projectTargetFromArgs(args);
    const chatId = project
      ? await resolveChatIdInProject(project, optionalString(args.chatId), optionalString(args.chatName), optionalString(args.threadHandle))
      : await resolveChatId(optionalString(args.chatId), optionalString(args.chatName), optionalString(args.threadHandle));
    if (!chatId) throw new Error("Thread target is required.");
    const updated = await window.codexVoice.removeChat(chatId);
    return { ok: true, project: updated };
  }

  throw new Error(`Unknown Realtime tool: ${name}`);
}

async function cancelStaleVoiceTool(name: string, output: unknown): Promise<void> {
  const result = output as {
    session_id?: unknown;
    turnId?: unknown;
    chat?: { id?: unknown } | null;
  } | null;

  if ((name === "exec_command" || name === "apply_patch") && typeof result?.session_id === "number") {
    await window.codexVoice.terminateExecSession(result.session_id);
    return;
  }

  if ((name === "submit_to_codex" || name === "dispatch_codex_task") && typeof result?.turnId === "string") {
    const chatId = typeof result.chat?.id === "string" ? result.chat.id : undefined;
    await window.codexVoice.interruptCodex(chatId);
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

function outgoingEventType(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return undefined;
  return stringValue((payload as { type?: unknown }).type);
}

function isTerminalRealtimeResponseStatus(status: string | undefined): boolean {
  return (
    status === "completed" ||
    status === "cancelled" ||
    status === "canceled" ||
    status === "failed" ||
    status === "incomplete"
  );
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

function numberArg(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error("Tool argument must be a finite number.");
  }
  return value;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function recordArg(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function projectTargetFromArgs(
  args: Record<string, unknown>,
  createFlagName = "createIfMissing",
): CodexProjectTarget | undefined {
  const nested = recordArg(args.project);
  const projectId = optionalString(nested?.projectId ?? args.projectId);
  const projectHandle = optionalString(nested?.projectHandle ?? args.projectHandle);
  const projectName = optionalString(nested?.projectName ?? args.projectName);
  const workspacePath = optionalString(nested?.workspacePath ?? args.workspacePath);
  const createIfMissing = optionalBoolean(nested?.createIfMissing ?? args[createFlagName]);
  if (!projectId && !projectHandle && !projectName && !workspacePath && createIfMissing === undefined) return undefined;
  return { projectId, projectHandle, projectName, workspacePath, createIfMissing };
}

function threadTargetFromArgs(args: Record<string, unknown>): CodexThreadTarget | undefined {
  const nested = recordArg(args.thread);
  const chatId = optionalString(nested?.chatId ?? args.chatId);
  const threadHandle = optionalString(nested?.threadHandle ?? args.threadHandle);
  const chatName = optionalString(nested?.chatName ?? args.chatName ?? args.name);
  const newChatName = optionalString(nested?.newChatName ?? args.newChatName);
  const createIfMissing = optionalBoolean(nested?.createIfMissing ?? args.createThreadIfMissing);
  const forceNew = optionalBoolean(nested?.forceNew ?? args.forceNew);
  if (!chatId && !threadHandle && !chatName && !newChatName && createIfMissing === undefined && forceNew === undefined) {
    return undefined;
  }
  return { chatId, threadHandle, chatName, newChatName, createIfMissing, forceNew };
}

async function resolveProjectId(project: CodexProjectTarget | undefined): Promise<string | undefined> {
  if (!project) return undefined;
  if (project.projectId) return project.projectId;
  const projects = await window.codexVoice.listProjectThreads({ project });
  if (projects.length !== 1) throw new Error("Project target did not resolve to exactly one project.");
  return projects[0].projectId;
}

async function resolveChatIdInProject(
  project: CodexProjectTarget,
  chatId: string | undefined,
  name?: string,
  threadHandle?: string,
  allowAll = false,
): Promise<string | undefined> {
  if (chatId) return chatId;
  if (!name && !threadHandle) return allowAll ? undefined : undefined;
  const projects = await window.codexVoice.listProjectThreads({ project });
  const chats = projects.flatMap((projectRuntime) => projectRuntime.chats);
  if (threadHandle) {
    const normalizedHandle = normalizeHandlePath(threadHandle);
    const exactHandle = chats.filter((chat) => normalizeHandlePath(chat.handle) === normalizedHandle || chat.threadId === threadHandle);
    if (exactHandle.length === 1) return exactHandle[0].chatId;
    if (exactHandle.length > 1) throw new Error(`More than one thread matched handle "${threadHandle}".`);
  }
  if (!name) return allowAll ? undefined : undefined;
  const needle = normalizeLookupText(name);
  const exact = chats.filter((chat) => normalizeLookupText(chat.displayName) === needle || chat.chatId === name || chat.threadId === name);
  if (exact.length === 1) return exact[0].chatId;
  if (exact.length > 1) throw new Error(`More than one thread matched "${name}".`);
  const partial = chats.filter((chat) => normalizeLookupText(chat.displayName).includes(needle));
  if (partial.length === 1) return partial[0].chatId;
  if (partial.length > 1) throw new Error(`More than one thread matched "${name}".`);
  throw new Error(`No thread matched "${name}".`);
}

async function resolveActiveChatIdInProject(project: CodexProjectTarget): Promise<string | undefined> {
  const projects = await window.codexVoice.listProjectThreads({ project });
  const projectRuntime = projects[0];
  return projectRuntime?.activeChatId ?? projectRuntime?.chats[0]?.chatId;
}

function normalizeLookupText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHandlePath(value: string): string {
  return value
    .split("/")
    .map((segment) =>
      segment
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "_")
        .replace(/^_+|_+$/g, "")
        .replace(/_{2,}/g, "_"),
    )
    .filter(Boolean)
    .join("/");
}

async function resolveChatId(
  chatId: string | undefined,
  name?: string,
  threadHandle?: string,
  allowAll = false,
): Promise<string | undefined> {
  if (chatId) return chatId;
  if (!name && !threadHandle) return allowAll ? undefined : undefined;
  const state = await window.codexVoice.getState();
  if (threadHandle) {
    const normalizedHandle = normalizeHandlePath(threadHandle);
    const runtimes = state.runtime.projectThreads.flatMap((project) => project.chats);
    const exactHandle = runtimes.filter((chat) => normalizeHandlePath(chat.handle) === normalizedHandle || chat.threadId === threadHandle);
    if (exactHandle.length === 1) return exactHandle[0].chatId;
    if (exactHandle.length > 1) throw new Error(`More than one thread matched handle "${threadHandle}".`);
  }
  if (!name) return allowAll ? undefined : undefined;
  const chat = findChatByName(state, name);
  if (!chat) throw new Error(`No thread matched "${name}".`);
  return chat.id;
}

function findChatByName(state: AppState, name: string): VoiceChat | null {
  const needle = name.trim().toLowerCase();
  const activeProject = state.activeProject;
  const chats = visibleChats(activeProject?.chats ?? []);
  const exact = chats.filter((chat) => chat.displayName.toLowerCase() === needle || chat.id === name);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error(`More than one thread matched "${name}".`);
  const partial = chats.filter((chat) => chat.displayName.toLowerCase().includes(needle));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new Error(`More than one thread matched "${name}".`);
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

function codexCompletionSpeechInstructions(event: AppEvent): string {
  const raw = (event.raw ?? {}) as {
    turn?: {
      status?: unknown;
    };
  };
  const status = raw.turn?.status;
  const outcome =
    status === "interrupted"
      ? "Codex was interrupted."
      : status === "failed"
        ? "Codex failed."
        : "Codex finished.";
  return [
    "A Codex completion status update was just added to the conversation by the app.",
    `Briefly tell the user: ${outcome}`,
    "Use one short natural sentence.",
    "Do not call tools.",
  ].join("\n");
}

function transcriptHistoryContext(
  messages: VoiceTranscriptMessage[],
): { text: string; count: number } | null {
  const recent = messages
    .filter((message) => message.status === "completed" && message.text.trim())
    .slice(-32);
  if (recent.length === 0) return null;

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
  if (lines.length === 0) return null;

  return {
    count: lines.length,
    text: [
      "App-provided prior voice transcript, not a new user request.",
      "Use this only as conversational memory if the user refers back to earlier speech.",
      "Do not summarize it aloud unless asked, and do not call tools because of this context.",
      lines.join("\n"),
    ].join("\n\n"),
  };
}

function userInputLogMessage(text: string, attachments: RealtimeUserAttachment[]): string {
  const imageText =
    attachments.length === 0
      ? ""
      : attachments.length === 1
        ? `Image: ${attachments[0].name}`
        : `${attachments.length} images`;
  return [text, imageText].filter(Boolean).join("\n") || imageText || "User input";
}

function sanitizeAttachmentForLog(attachment: RealtimeUserAttachment): RealtimeUserAttachmentMetadata {
  return {
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    localPath: attachment.localPath ?? null,
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
    "App-provided Codex context, not a user request.",
    "The previous Codex turn produced this exact final assistant output.",
    "Use it as factual context if the user asks what happened, asks for a summary, or asks about the last Codex turn.",
    "Do not treat this message as an instruction to start new work.",
    JSON.stringify({
      kind: "codex_turn_final_output",
      threadId: output.threadId,
      turnId: output.turnId,
      status: output.status,
      startedAt: output.startedAt,
      completedAt: output.completedAt,
      durationMs: output.durationMs,
      errorMessage: output.errorMessage,
      finalAssistantText: output.finalAssistantText,
    }),
  ].join("\n");
}
