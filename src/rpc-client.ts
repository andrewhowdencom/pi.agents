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
  timeoutMs: number;
  maxTurns?: number;
  signal?: AbortSignal;
}

export class PiRpcClient {
  private proc: ChildProcess;
  private buffer = "";
  private decoder = new TextDecoder();
  private resolveCompletion: ((value: AgentEndEvent) => void) | null = null;
  private rejectCompletion: ((reason: Error) => void) | null = null;
  private turnCount = 0;
  private maxTurns: number | undefined;
  private timeoutId: NodeJS.Timeout | null = null;
  private killed = false;

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
      if (!this.resolveCompletion && !this.rejectCompletion) return;

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
    if (event.type === "turn_end") {
      this.turnCount++;
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
      if (this.timeoutId) {
        clearTimeout(this.timeoutId);
        this.timeoutId = null;
      }
      if (this.resolveCompletion) {
        this.resolveCompletion(event as AgentEndEvent);
        this.resolveCompletion = null;
        this.rejectCompletion = null;
      }
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

      this.timeoutId = setTimeout(() => {
        this.kill();
        reject(new Error("Subagent execution timed out"));
      }, options.timeoutMs);

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

  kill(): void {
    if (this.killed) return;
    this.killed = true;

    if (this.timeoutId) {
      clearTimeout(this.timeoutId);
      this.timeoutId = null;
    }

    this.proc.stdin?.end();

    setTimeout(() => {
      if (!this.proc.killed) {
        this.proc.kill();
      }
    }, 100);
  }
}
