# Plan: Stream Subagent Output and Track Costs

## Objective

Make subagent execution visible and accountable within the parent session by streaming per-turn output updates, tracking cumulative token usage and cost, and surfacing this data in the tool result details and UI. The current implementation is a black box: the subagent tool shows only a loading indicator and returns only the final assistant text with turn count and timeout status. Users cannot see what the subagent is doing across its turns, nor understand the tokens and dollars spent on its behalf.

## Context

### Repository Topology

The `pi.agents` project is a Pi extension (TypeScript, `type: "module"`) that registers agent-switching commands, the `switch_agent` tool, and dynamic subagent tools. Key files:

- **`src/index.ts`** — Extension factory. Registers the `/agent` command, `switch_agent` tool, and per-agent subagent tools. The subagent tool `execute` handler receives `onUpdate` and `ctx` but currently ignores both (named `_onUpdate`, `_ctx`). It also has `hasUI` guard and `setStatus`/`setWorkingMessage` usage for agent switching.
- **`src/subagent-tools.ts`** — `buildSubagentToolSchema()` and `executeSubagent()`. The latter spawns `pi --mode rpc`, composes the prompt, writes a temp system-prompt file, and blocks until `agent_end`. It returns `{ output, turnCount, timedOut }`. No streaming, no usage tracking.
- **`src/rpc-client.ts`** — `PiRpcClient` class. Spawns `pi` as a child process, parses JSONL events from stdout. Currently handles only `turn_end` (increments `turnCount`) and `agent_end` (resolves `waitForCompletion`). No event listener API; the full `turn_end` payload (including the `AgentMessage` with `usage`) is discarded after counting.
- **`src/agent-discovery.ts`** — `discoverAgents()` reads `.md` files from `~/.pi/agent/agents/` and `.pi/agents/`, parses YAML frontmatter, caches results.

### Pi Extension API Surface (Relevant to This Plan)

From `@mariozechner/pi-coding-agent/dist/core/extensions/types.d.ts`:

- **`ToolDefinition.execute`** signature: `execute(toolCallId, params, signal, onUpdate, ctx)`. `onUpdate: AgentToolUpdateCallback<TDetails> | undefined` can be called repeatedly to stream partial tool results during execution.
- **`AgentToolUpdateCallback<T>`**: `(partialResult: AgentToolResult<T>) => void`. `AgentToolResult` contains `{ content: (TextContent|ImageContent)[], details: T, terminate?: boolean }`.
- **`ExtensionContext.ui`**: `ExtensionUIContext` with `setWorkingMessage()`, `setWorkingVisible()`, `setStatus()`, `notify()`, `setWidget()`.
- **`ExtensionContext.hasUI`**: boolean indicating whether UI methods are available.

From `@mariozechner/pi-agent-core/dist/types.d.ts`:

- **`AgentEvent` turn_end**: `{ type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }`. `AgentMessage` (when `role === "assistant"`) carries `usage: Usage`.
- **`Usage`**: `{ input, output, cacheRead, cacheWrite, totalTokens, cost: { input, output, cacheRead, cacheWrite, total } }`.

From `@mariozechner/pi-coding-agent/dist/core/agent-session.d.ts`:

- **`SessionStats`**: `{ tokens: { input, output, cacheRead, cacheWrite, total }, cost: number, ... }`. Computed by `AgentSession.getSessionStats()` from assistant-message `usage` fields in the conversation.

### Current Subagent RPC Protocol

The `PiRpcClient` communicates with `pi --mode rpc` via JSONL on stdin/stdout:
- Input: `{ type: "prompt", message: string }`
- Output events (relevant): `turn_end` and `agent_end`
- The `turn_end` event contains the full assistant `AgentMessage` (including `content`, `usage`, `model`, etc.), but `PiRpcClient.handleEvent` only checks `event.type === "turn_end"` and increments a counter.

### Why Native Cost Integration Is Not Possible from an Extension

Pi's session cost totals (`SessionStats`) are computed by summing `AssistantMessage.usage` objects that are part of the parent session's conversation history. The subagent runs in a **separate** `pi --mode rpc` process launched with `--no-session`. Its assistant messages never enter the parent session. There is no public Extension API to inject external token/cost data into the parent's `SessionStats`. Therefore, subagent costs must be tracked **independently** and surfaced prominently in tool details and UI.

## Architectural Blueprint

### Selected Approach: Per-Turn Streaming with Aggregated Usage Reporting

1. **Event Listener Pattern in `PiRpcClient`**: Add an `onEvent(listener)` registration method. Listeners receive the full parsed JSON event object (including `turn_end` with its `message` payload). This mirrors the built-in `RpcClient` design in Pi and is backward-compatible with `waitForCompletion`.

2. **Usage Accumulation in `PiRpcClient`**: Each `turn_end` listener extracts `message.usage` (when the message is an assistant message) and accumulates it into a running total. Provide `getAccumulatedUsage()` that returns the aggregated `Usage` snapshot.

3. **Streaming Partial Results in `executeSubagent`**: After registering a `turn_end` listener, call `onUpdate` with an `AgentToolResult` whose:
   - `content` contains a text block summarizing the current turn's assistant output (e.g., "**Turn 2/5**\n[assistant text]")
   - `details` contains progress metadata: `{ turnCount, maxTurns, subagentName, cumulativeUsage }`
   This hooks into Pi's native tool-execution streaming UI.

4. **UI Progress Indicator**: When `ctx.hasUI` is true, call `ctx.ui.setWorkingMessage()` with a concise status like `"Subagent reviewer: turn 2/5, ~$0.003"`. This updates the loading indicator text while the subagent runs.

5. **Final Result Enrichment**: The final `AgentToolResult` returned from the tool `execute` includes:
   - `content`: the full subagent output (unchanged behavior)
   - `details`: `{ turnCount, timedOut, subagentDepth, cumulativeUsage }` where `cumulativeUsage` is the aggregated `Usage` object from all turns

6. **Aggregated Subagent Cost Widget (Optional Phase 2)**: A module-level accumulator of all subagent costs across the session, displayed via `ctx.ui.setWidget()` or `setStatus()` when interactive. This is a follow-up enhancement not required for the MVP.

### Evaluated Alternatives (Tree-of-Thought)

| Path | Description | Trade-off | Verdict |
|---|---|---|---|
| **A (Selected)** | Stream `turn_end` output via `onUpdate` after each completed turn | Simple, reliable, reuses Pi's streaming infra; only shows completed turns, not intra-turn tokens | ✅ Best balance of value and complexity |
| B | Parse `message_update` events for real-time token streaming | Would show subagent "thinking" in real time; `pi --mode rpc` may not consistently emit `message_update` for all providers, and filtering assistant-only deltas is fragile | ❌ Too complex and unreliable |
| C | Call `get_session_stats` RPC command after each turn | Gives total session stats, but adds an extra JSONL round-trip per turn; `turn_end` already contains `usage` | ❌ Redundant and slower |
| D | Send custom session messages for each turn | Would add subagent internals to the parent conversation history, cluttering context and potentially confusing the parent LLM | ❌ Pollutes parent session |

## Requirements

1. Subagent tool execution must stream a partial result after each completed turn, showing the turn number and the turn's assistant output.
2. Subagent tool execution must accumulate token usage and cost data from all `turn_end` events.
3. The final tool result `details` must include the aggregated `Usage` object (input, output, cacheRead, cacheWrite, totalTokens, cost).
4. When running in interactive mode (`ctx.hasUI`), the working/loading indicator must display subagent progress (e.g., turn count, estimated cost).
5. The implementation must be backward-compatible: subagent tools that do not use the new streaming features continue to work unchanged.
6. The plan must document why subagent costs cannot be merged into Pi's native session cost totals.

## Task Breakdown

### Task 1: Add Event Listener API to `PiRpcClient`
- **Goal**: Enable subscribers to receive full RPC events (including `turn_end` payloads).
- **Dependencies**: None.
- **Files Affected**: `src/rpc-client.ts`
- **New Files**: None.
- **Interfaces**:
  ```typescript
  export type RpcEvent = Record<string, unknown>;
  export type RpcEventListener = (event: RpcEvent) => void;

  // Add to PiRpcClient class:
  onEvent(listener: RpcEventListener): () => void;
  ```
- **Details**:
  1. Add a private `eventListeners: RpcEventListener[] = []` array to `PiRpcClient`.
  2. Implement `onEvent(listener)` that appends the listener and returns an unsubscribe function.
  3. In `handleEvent(event)`, before the existing `if/else` logic, broadcast the raw event to all listeners: `this.eventListeners.forEach(l => l(event))`.
  4. Ensure listeners are not called after the client is killed.

### Task 2: Accumulate Usage from `turn_end` Events in `PiRpcClient`
- **Goal**: Track cumulative token and cost data across all subagent turns.
- **Dependencies**: Task 1.
- **Files Affected**: `src/rpc-client.ts`
- **New Files**: None.
- **Interfaces**:
  ```typescript
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

  // Add to PiRpcClient class:
  getAccumulatedUsage(): AccumulatedUsage | undefined;
  ```
- **Details**:
  1. Add a private `accumulatedUsage: AccumulatedUsage | undefined` field initialized to `undefined`.
  2. In `handleEvent`, when `event.type === "turn_end"`:
     - Extract `event.message` (type-guard for `Record<string, unknown>`).
     - If `message.role === "assistant"` and `message.usage` exists, accumulate its fields into `accumulatedUsage`.
     - Handle missing fields gracefully (default to 0).
  3. Implement `getAccumulatedUsage()` returning the current snapshot (or `undefined` if no usage has been seen).
  4. Reset `accumulatedUsage` to `undefined` in `kill()` to prevent stale data on reuse.

### Task 3: Stream Partial Results via `onUpdate` in `executeSubagent`
- **Goal**: After each completed turn, emit a partial tool result so the parent session UI shows subagent progress.
- **Dependencies**: Task 1, Task 2.
- **Files Affected**: `src/subagent-tools.ts`
- **New Files**: None.
- **Interfaces**:
  ```typescript
  // executeSubagent gains an optional onUpdate parameter:
  export async function executeSubagent(
    agent: AgentDefinition,
    params: Record<string, unknown>,
    signal: AbortSignal,
    timeoutMs: number,
    maxTurns: number,
    onUpdate?: AgentToolUpdateCallback<unknown>,
  ): Promise<{ output: string; turnCount: number; timedOut: boolean; usage?: AccumulatedUsage }>
  ```
- **Details**:
  1. Add `onUpdate` as the last parameter to `executeSubagent`.
  2. After `client.start()` and `client.sendPrompt()`, register a `turn_end` listener via `client.onEvent()`.
  3. In the listener:
     - Extract the assistant text from `event.message.content` (handle string and array-of-blocks formats, same logic currently used for final output extraction).
     - If `onUpdate` is provided, call it with:
       ```typescript
       {
         content: [{ type: "text", text: `**Turn ${client.getTurnCount()}/${maxTurns}**\n\n${turnOutput}` }],
         details: {
           turnCount: client.getTurnCount(),
           maxTurns,
           subagentName: agent.name,
           usage: client.getAccumulatedUsage(),
         },
       }
       ```
     - If `ctx` (or a UI notifier callback) is available, update the working message. Since `executeSubagent` does not currently receive `ctx`, this is handled in Task 4.
  4. Unsubscribe the listener in a `finally` block or before `client.kill()`.
  5. Include `usage: client.getAccumulatedUsage()` in the final return object.

### Task 4: Wire UI Progress into Tool `execute` Handler
- **Goal**: When interactive, show live subagent progress in the loading indicator.
- **Dependencies**: Task 3.
- **Files Affected**: `src/index.ts`
- **New Files**: None.
- **Interfaces**: None new; uses existing `ExtensionContext.ui.setWorkingMessage()`.
- **Details**:
  1. In the subagent tool `execute` handler, remove the `_` prefix from `_onUpdate` and `_ctx` (rename to `onUpdate` and `ctx`).
  2. Before calling `executeSubagent`, if `ctx.hasUI`, set an initial working message:
     ```typescript
     ctx.ui.setWorkingMessage(`Invoking ${agent.name}...`);
     ```
  3. Pass a callback wrapper to `executeSubagent` instead of raw `onUpdate`:
     ```typescript
     const onSubagentUpdate = (partial: AgentToolResult<unknown>) => {
       onUpdate?.(partial);
       if (ctx.hasUI) {
         const details = partial.details as { turnCount?: number; maxTurns?: number; usage?: AccumulatedUsage } | undefined;
         const turn = details?.turnCount ?? 0;
         const total = details?.maxTurns ?? maxTurns;
         const cost = details?.usage?.cost?.total ?? 0;
         ctx.ui.setWorkingMessage(`${agent.name}: turn ${turn}/${total}, ~$${cost.toFixed(4)}`);
       }
     };
     ```
  4. After `executeSubagent` resolves (success or failure), if `ctx.hasUI`, clear the working message:
     ```typescript
     ctx.ui.setWorkingMessage();
     ```
  5. Include `usage` in the final tool result `details`:
     ```typescript
     details: {
       turnCount: result.turnCount,
       timedOut: result.timedOut,
       subagentDepth: depth + 1,
       usage: result.usage,
     }
     ```

### Task 5: Update README with Streaming and Cost Documentation
- **Goal**: Document the new behavior, the cost tracking limitation, and how users can observe subagent progress.
- **Dependencies**: Task 4.
- **Files Affected**: `README.md`
- **New Files**: None.
- **Interfaces**: None.
- **Details**:
  1. In the **Subagents** section, add a new subsection **"Live Progress and Cost Tracking"**.
  2. Describe that each completed turn's output is streamed back to the parent session.
  3. Explain that cumulative token usage and cost are tracked and included in the tool result `details`.
  4. Add a **"Known Limitations"** note: subagent costs are tracked independently and are **not** merged into the parent session's built-in cost totals, because the subagent runs in a separate RPC process and Pi does not expose an API to inject external usage data.
  5. Update any examples that show `invoke_reviewer` to mention the visible progress.

### Task 6: Reflexive Verification and Manual Test
- **Goal**: Validate the implementation works end-to-end without regressions.
- **Dependencies**: Task 4 (Task 5 is documentation-only and can happen in parallel).
- **Files Affected**: None (verification task).
- **New Files**: None.
- **Interfaces**: None.
- **Details**:
  1. Create a test agent with `subagent: true` in a `.pi/agents/` directory.
  2. Invoke it from an interactive Pi session and verify:
     - The loading indicator shows turn progress.
     - Each turn's output appears in the streaming tool execution component.
     - The final tool result details contain `usage` with `input`, `output`, `totalTokens`, and `cost.total`.
  3. Verify non-interactive mode (`-p` / `--mode json`) still works and returns the same `details` without UI calls.
  4. Verify timeout, cancellation, and error paths still behave correctly.

## Dependency Graph

```
Task 1 ──→ Task 2 ──→ Task 3 ──→ Task 4 ──→ Task 6
                              │
Task 5 (docs) ◄───────────────┘
```

- Task 1 and Task 5 can start in parallel, but Task 5 should be finalized after Task 4 for accuracy.
- Task 2 depends on Task 1.
- Task 3 depends on Task 1 and Task 2.
- Task 4 depends on Task 3.
- Task 6 depends on Task 4.

## Risks & Mitigations

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| `turn_end` event `message` is not always an `AssistantMessage` with `usage` (e.g., if the turn ends with an error or abort) | Medium (missing cost data) | Medium | Type-guard the `message` object before extracting `usage`. Default all numeric fields to 0. Document that cost is best-effort. |
| `onUpdate` called with very large assistant text per turn could flood the UI | Low | Low | Only include the current turn's text (not cumulative). Pi's tool execution component already truncates long text. |
| `ctx.ui.setWorkingMessage()` called rapidly across many turns could cause UI flicker | Low | Low | Throttle to at most one update per 500ms, or only update on `turn_end` (naturally throttled by LLM latency). |
| Subagent emits `turn_end` with `message.content` as array of non-text blocks (e.g., tool calls only) | Low | Low | The turn-output extraction logic should filter for `type === "text"` blocks, falling back to empty string if none exist. |
| Backward incompatibility if `executeSubagent` signature changes | High | Low | Add `onUpdate` as an **optional** trailing parameter. Existing callers that pass 5 args are unaffected. |
| Cost formatting (`~$0.003`) may be misleading for providers with zero configured cost | Low | Low | Only show cost in `setWorkingMessage` when `cost.total > 0`. Otherwise show only turn count. |

## Validation Criteria

- [ ] After invoking a subagent, the tool execution component in interactive mode shows at least one partial update after each completed turn (e.g., "**Turn 1/5**\n...").
- [ ] The interactive loading indicator displays the subagent name, current turn, max turns, and estimated cost while the subagent runs.
- [ ] The final tool result `details` includes a `usage` object with `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, and `cost.total` (all numbers, non-negative).
- [ ] When a subagent completes with zero turns (e.g., immediate error or abort), `usage` is `undefined` (not malformed).
- [ ] Non-interactive mode (`pi -p`) produces identical `details.usage` without throwing UI-related errors.
- [ ] Existing subagent guardrails (self-invocation, depth limit, timeout, max turns) continue to function exactly as before.
- [ ] `PiRpcClient.onEvent()` returns an unsubscribe function that prevents the listener from receiving events after being called.
- [ ] README documents the streaming behavior, the `usage` field in `details`, and the known limitation about native session cost integration.
