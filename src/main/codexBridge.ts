import { EventEmitter } from "node:events";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";

type PendingRequest = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
};

export type CodexJsonMessage = {
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

export class CodexBridge extends EventEmitter {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number | string, PendingRequest>();
  private initialized = false;

  get ready(): boolean {
    return this.initialized && this.proc !== null && !this.proc.killed;
  }

  async start(): Promise<void> {
    if (this.proc) return;

    this.proc = spawn("codex", ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on("line", (line) => this.handleLine(line));

    this.proc.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) this.emit("stderr", text);
    });

    this.proc.on("exit", (code, signal) => {
      this.initialized = false;
      this.emit("exit", { code, signal });
      for (const [id, pending] of this.pending.entries()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`Codex app-server exited before ${pending.method} completed.`));
        this.pending.delete(id);
      }
      this.proc = null;
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex_voice",
        title: "Codex Voice Agent",
        version: "0.0.1",
      },
      capabilities: {
        experimentalApi: true,
      },
    });
    this.notify("initialized", {});
    this.initialized = true;
  }

  async request(method: string, params?: unknown, timeoutMs = 120_000): Promise<unknown> {
    if (!this.proc) {
      throw new Error("Codex app-server is not running.");
    }
    const id = this.nextId++;
    const message =
      params === undefined
        ? { id, method }
        : { id, method, params };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for app-server method ${method}.`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timeout });
      this.write(message);
    });
  }

  notify(method: string, params?: unknown): void {
    if (!this.proc) return;
    this.write(params === undefined ? { method } : { method, params });
  }

  respond(id: number | string, result: unknown): void {
    this.write({ id, result });
  }

  rejectRequest(id: number | string, message: string): void {
    this.write({ id, error: { code: -32000, message } });
  }

  stop(): void {
    if (!this.proc) return;
    this.proc.kill();
    this.proc = null;
    this.initialized = false;
  }

  private write(message: unknown): void {
    if (!this.proc) {
      throw new Error("Cannot write to stopped Codex app-server.");
    }
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: CodexJsonMessage;
    try {
      message = JSON.parse(line) as CodexJsonMessage;
    } catch {
      this.emit("parseError", line);
      return;
    }

    if (message.method && message.id !== undefined) {
      this.emit("serverRequest", message);
      return;
    }

    if (message.method) {
      this.emit("notification", message);
      return;
    }

    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        this.emit("orphanResponse", message);
        return;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `Codex request ${pending.method} failed.`));
      } else {
        pending.resolve(message.result);
      }
    }
  }
}
