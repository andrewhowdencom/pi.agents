import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { PiRpcClient } from '../src/rpc-client.js';
import { executeSubagent } from '../src/subagent-tools.js';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  writeFile: vi.fn().mockResolvedValue(undefined),
  unlink: vi.fn().mockResolvedValue(undefined),
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

const originalStart = PiRpcClient.prototype.start;

beforeEach(() => {
  vi.clearAllMocks();
  PiRpcClient.prototype.start = async () => {};
});

afterEach(() => {
  PiRpcClient.prototype.start = originalStart;
});

describe('executeSubagent', () => {
  it('forwards error events to onProgress', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const onProgress = vi.fn();

    const agent = {
      name: 'test-agent',
      description: 'test',
      role: ['delegate'],
      content: 'system prompt',
      path: '/fake/path.md',
    };

    const resultPromise = executeSubagent(
      agent as any,
      { goal: 'test goal' },
      new AbortController().signal,
      undefined,
      onProgress,
    );

    // Emit error after executeSubagent has reached waitForCompletion
    setTimeout(() => {
      mockProc.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'error', message: 'test failure' }) + '\n',
        ),
      );
    }, 0);

    const result = await resultPromise;

    expect(onProgress).toHaveBeenCalledWith({
      type: 'error',
      message: 'test failure',
    });
    expect(result.output).toContain('test-agent failed');
  });

  it('returns output containing the error message when waitForCompletion rejects', async () => {
    const mockProc = createMockProcess();
    vi.mocked(spawn).mockReturnValue(mockProc as any);

    const agent = {
      name: 'test-agent',
      description: 'test',
      role: ['delegate'],
      content: 'system prompt',
      path: '/fake/path.md',
    };

    const resultPromise = executeSubagent(
      agent as any,
      { goal: 'test goal' },
      new AbortController().signal,
    );

    setTimeout(() => {
      mockProc.stdout.emit(
        'data',
        Buffer.from(
          JSON.stringify({ type: 'error', message: 'test failure' }) + '\n',
        ),
      );
    }, 0);

    const result = await resultPromise;

    expect(result.output).toBe(
      'Subagent test-agent failed: Subagent RPC error: test failure',
    );
  });
});
