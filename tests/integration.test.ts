import { vi, describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PiRpcClient } from '../src/rpc-client.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

function createMockProcess() {
  const proc = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: { write: vi.fn(), end: vi.fn() },
    killed: false,
  });
  proc.kill = vi.fn(() => {
    proc.killed = true;
  });
  return proc;
}

describe('PiRpcClient integration', () => {
  it('parses an error event from stdout and rejects waitForCompletion', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const client = new PiRpcClient(['--mode', 'rpc']);
    await client.start();
    await client.sendPrompt('test');

    const completionPromise = client.waitForCompletion({});

    // Simulate Pi RPC emitting an error event on stdout
    mockProc.stdout.emit(
      'data',
      Buffer.from(
        JSON.stringify({ type: 'error', message: 'mock model failure' }) +
          '\n',
      ),
    );

    await expect(completionPromise).rejects.toThrow(
      'Subagent RPC error: mock model failure',
    );
  });
});
