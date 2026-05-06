import { vi, describe, it, expect, beforeEach } from 'vitest';
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

beforeEach(() => {
  vi.clearAllMocks();
});

describe('PiRpcClient', () => {
  describe('handleEvent', () => {
    it('rejects with error message when error event has a message', async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);

      const client = new PiRpcClient(['--mode', 'rpc']);
      const completionPromise = client.waitForCompletion({});

      (client as any).handleEvent({ type: 'error', message: 'auth failed' });

      await expect(completionPromise).rejects.toThrow(
        'Subagent RPC error: auth failed',
      );
      expect((client as any).killed).toBe(true);
    });

    it('rejects with fallback message when error event lacks a message', async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);

      const client = new PiRpcClient(['--mode', 'rpc']);
      const completionPromise = client.waitForCompletion({});

      (client as any).handleEvent({ type: 'error' });

      await expect(completionPromise).rejects.toThrow(
        'Subagent RPC error: Unknown RPC error',
      );
      expect((client as any).killed).toBe(true);
    });

    it('does not throw and still kills when rejectCompletion is null', () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);

      const client = new PiRpcClient(['--mode', 'rpc']);
      // Do NOT call waitForCompletion, so rejectCompletion stays null

      expect(() => {
        (client as any).handleEvent({ type: 'error', message: 'boom' });
      }).not.toThrow();

      expect((client as any).killed).toBe(true);
    });

    it('rejects only once on consecutive error events', async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);

      const client = new PiRpcClient(['--mode', 'rpc']);
      const completionPromise = client.waitForCompletion({});

      (client as any).handleEvent({ type: 'error', message: 'first' });
      (client as any).handleEvent({ type: 'error', message: 'second' });

      await expect(completionPromise).rejects.toThrow(
        'Subagent RPC error: first',
      );
    });

    it('clears idle timeout on error event', async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);

      const client = new PiRpcClient(['--mode', 'rpc']);
      const completionPromise = client.waitForCompletion({ timeoutMs: 10000 });

      expect((client as any).idleTimeoutId).not.toBeNull();
      expect((client as any).idleTimeoutMs).toBe(10000);

      (client as any).handleEvent({ type: 'error', message: 'timeout test' });

      expect((client as any).idleTimeoutId).toBeNull();
      expect((client as any).idleTimeoutMs).toBeUndefined();
      await expect(completionPromise).rejects.toThrow(
        'Subagent RPC error: timeout test',
      );
    });

    it('resolves correctly on agent_end event (regression safety)', async () => {
      const mockProc = createMockProcess();
      vi.mocked(spawn).mockReturnValue(mockProc as any);

      const client = new PiRpcClient(['--mode', 'rpc']);
      const completionPromise = client.waitForCompletion({});

      (client as any).handleEvent({ type: 'agent_end', messages: [] });

      const result = await completionPromise;
      expect(result).toEqual({ type: 'agent_end', messages: [] });
      expect((client as any).idleTimeoutId).toBeNull();
    });
  });
});
