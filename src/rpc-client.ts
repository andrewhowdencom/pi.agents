import { spawn, type ChildProcess } from "node:child_process";

export interface AgentMessage {
  role: string;
  content:
    | string
    | Array<{ type: string; text?: string; thinking?: string }>;
}

export interface AgentEndEvent {
  type: "agent_end";
  messages: AgentMessage[];
}

export interface PiRpcClientOptions {
  timeoutMs?: number;
  maxTurns?: number;
  signal?: AbortSignal;
}

export type RpcEvent = Record<string, unknown>;
export type RpcEventListener = (event: RpcEvent) => void;

export interface AccumulatedUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

export class PiRpcClient {
  private proc: ChildProcess;
  private buffer = "";
  private decoder = new TextDecoder();
  private resolveCompletion: ((value: AgentEndEvent) => void) | null = null;
  private rejectCompletion: ((reason: Error) => void) | null = null;
  private turnCount = 0;
  private maxTurns: number | undefined;
  private idleTimeoutId: NodeJS.Timeout | null = null;
  private idleTimeoutMs: number | undefined = undefined;
  private killed = false;
  private eventListeners: RpcEventListener[] = [];
  private accumulatedUsage: AccumulatedUsage | undefined;
  private exitInfo: { code: number | null; signal: string | null } | null = null;

  constructor(args: string[]) {
    this.proc = spawn("pi", args, {
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.proc.stdout?.on("data", (chunk: Buffer) => {
      this.onStdoutData(chunk);
    });

    this.proc.stderr?.on("data", (chunk: Buffer) => {
      console.error("[pi-agents subagent stderr]", chunk.toString());
    });

    this.proc.on("error", (err) => {
      if (this.rejectCompletion) {
        this.rejectCompletion(
          new Error(`Subagent process error: ${err.message}`),
        );
        this.rejectCompletion = null;
        this.resolveCompletion = null;
      }
    });

    this.proc.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };

      if (this.idleTimeoutId) {
        clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }

      const reason = signal
        ? `Subagent process killed by signal ${signal}`
        : `Subagent process exited with code ${code}`;

      if (this.rejectCompletion) {
        this.rejectCompletion(new Error(reason));
        this.rejectCompletion = null;
        this.resolveCompletion = null;
      }
    });
  }

  private onStdoutData(chunk: Buffer) {
    if (this.rejectCompletion && this.idleTimeoutMs) {
      this.setIdleTimeout(this.rejectCompletion);
    }
    this.buffer += this.decoder.decode(chunk, { stream: true });

    while (true) {
      const nlIndex = this.buffer.indexOf("\n");
      if (nlIndex === -1) break;

      let line = this.buffer.slice(0, nlIndex);
      this.buffer = this.buffer.slice(nlIndex + 1);

      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }

      if (!line.trim()) continue;

      try {
        const event = JSON.parse(line);
        this.handleEvent(event);
      } catch {
        console.error("[pi-agents] Failed to parse RPC event:", line);
      }
    }
  }

  private handleEvent(event: Record<string, unknown>) {
    if (!this.killed) {
      for (const listener of this.eventListeners) {
        try {
          listener(event);
        } catch {
          // Ignore listener errors to avoid breaking the RPC stream
        }
      }
    }

    if (event.type === "turn_end") {
      this.turnCount++;

      // Accumulate token usage and cost from the turn's assistant message
      const message = event.message;
      if (
        message &&
        typeof message === "object" &&
        (message as Record<string, unknown>).role === "assistant"
      ) {
        const usage = (message as Record<string, unknown>).usage;
        if (usage && typeof usage === "object") {
          const u = usage as Record<string, unknown>;
          const cost = u.cost;
          let costObj: AccumulatedUsage["cost"] | undefined;
          if (cost && typeof cost === "object") {
            const c = cost as Record<string, unknown>;
            costObj = {
              input: typeof c.input === "number" ? c.input : 0,
              output: typeof c.output === "number" ? c.output : 0,
              cacheRead: typeof c.cacheRead === "number" ? c.cacheRead : 0,
              cacheWrite: typeof c.cacheWrite === "number" ? c.cacheWrite : 0,
              total: typeof c.total === "number" ? c.total : 0,
            };
          }
          const input = typeof u.input === "number" ? u.input : 0;
          const output = typeof u.output === "number" ? u.output : 0;
          const cacheRead = typeof u.cacheRead === "number" ? u.cacheRead : 0;
          const cacheWrite = typeof u.cacheWrite === "number" ? u.cacheWrite : 0;
          const totalTokens = typeof u.totalTokens === "number" ? u.totalTokens : 0;

          if (!this.accumulatedUsage) {
            this.accumulatedUsage = {
              input,
              output,
              cacheRead,
              cacheWrite,
              totalTokens,
              cost: costObj ?? {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                total: 0,
              },
            };
          } else {
            this.accumulatedUsage.input += input;
            this.accumulatedUsage.output += output;
            this.accumulatedUsage.cacheRead += cacheRead;
            this.accumulatedUsage.cacheWrite += cacheWrite;
            this.accumulatedUsage.totalTokens += totalTokens;
            if (costObj) {
              this.accumulatedUsage.cost.input += costObj.input;
              this.accumulatedUsage.cost.output += costObj.output;
              this.accumulatedUsage.cost.cacheRead += costObj.cacheRead;
              this.accumulatedUsage.cost.cacheWrite += costObj.cacheWrite;
              this.accumulatedUsage.cost.total += costObj.total;
            }
          }
        }
      }

      if (this.maxTurns && this.turnCount > this.maxTurns) {
        this.sendCommand({ type: "abort" });
        this.kill();
        if (this.rejectCompletion) {
          this.rejectCompletion(
            new Error(`Subagent exceeded maximum ${this.maxTurns} turns`),
          );
          this.rejectCompletion = null;
          this.resolveCompletion = null;
        }
      }
    } else if (event.type === "agent_end") {
      if (this.idleTimeoutId) {
        clearTimeout(this.idleTimeoutId);
        this.idleTimeoutId = null;
      }
      this.idleTimeoutMs = undefined;
      if (this.resolveCompletion) {
        this.resolveCompletion(event as AgentEndEvent);
        this.resolveCompletion = null;
        this.rejectCompletion = null;
      }
    }
  }

  private setIdleTimeout(reject: (reason: Error) => void): void {
    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    if (this.idleTimeoutMs !== undefined && this.idleTimeoutMs > 0) {
      this.idleTimeoutId = setTimeout(() => {
        this.kill();
        reject(new Error("Subagent execution timed out after inactivity"));
      }, this.idleTimeoutMs);
    }
  }

  private sendCommand(cmd: Record<string, unknown>): void {
    if (!this.proc.stdin || this.killed) return;
    this.proc.stdin.write(JSON.stringify(cmd) + "\n");
  }

  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (err: Error) => {
        reject(
          new Error(`Failed to start subagent process: ${err.message}`),
        );
      };
      this.proc.once("error", onError);

      setTimeout(() => {
        this.proc.off("error", onError);
        resolve();
      }, 500);
    });
  }

  async sendPrompt(message: string): Promise<void> {
    this.sendCommand({ type: "prompt", message });
  }

  async abort(): Promise<void> {
    this.sendCommand({ type: "abort" });
  }

  async waitForCompletion(options: PiRpcClientOptions): Promise<AgentEndEvent> {
    this.maxTurns = options.maxTurns;

    return new Promise((resolve, reject) => {
      this.resolveCompletion = resolve;
      this.rejectCompletion = reject;

      if (this.exitInfo) {
        const reason = this.exitInfo.signal
          ? `Subagent process killed by signal ${this.exitInfo.signal}`
          : `Subagent process exited with code ${this.exitInfo.code}`;
        reject(new Error(reason));
        this.rejectCompletion = null;
        this.resolveCompletion = null;
        return;
      }

      if (options.timeoutMs !== undefined && options.timeoutMs > 0) {
        this.idleTimeoutMs = options.timeoutMs;
        this.setIdleTimeout(reject);
      }

      if (options.signal) {
        options.signal.addEventListener("abort", () => {
          this.kill();
          reject(new Error("Subagent execution cancelled"));
        });
      }
    });
  }

  getTurnCount(): number {
    return this.turnCount;
  }

  onEvent(listener: RpcEventListener): () => void {
    this.eventListeners.push(listener);
    return () => {
      const index = this.eventListeners.indexOf(listener);
      if (index !== -1) {
        this.eventListeners.splice(index, 1);
      }
    };
  }

  getAccumulatedUsage(): AccumulatedUsage | undefined {
    return this.accumulatedUsage;
  }

  kill(): void {
    if (this.killed) return;
    this.killed = true;
    this.eventListeners = [];
    this.accumulatedUsage = undefined;

    if (this.idleTimeoutId) {
      clearTimeout(this.idleTimeoutId);
      this.idleTimeoutId = null;
    }
    this.idleTimeoutMs = undefined;

    this.proc.stdin?.end();

    setTimeout(() => {
      if (!this.proc.killed) {
        this.proc.kill();
      }
    }, 100);
  }
}
