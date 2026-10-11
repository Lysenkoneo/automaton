import { afterEach, describe, expect, it, vi } from "vitest";
import { runSafeTestCycles, safeTestCycleLimit, closeSafeTestResources, flushSafeTestOutput, exitSafeTestProcess, withSafeTestResources, waitForSafeInference } from "../agent/safe-test-runner.js";

afterEach(() => vi.unstubAllEnvs());

describe("bounded safe test runtime", () => {
  it("closes the opened database on an initialization failure before the runner", async () => {
    const close = vi.fn();
    await expect(withSafeTestResources(async () => { throw new Error("initialization failed"); }, close)).rejects.toThrow("initialization failed");
    expect(close).toHaveBeenCalledOnce();
  });
  it("orders stop, inference cancellation, cleanup and delayed output before exit", async () => {
    const controller = new AbortController();
    const events: string[] = [];
    let resolveInference!: (value: string) => void;
    const inference = new Promise<string>(resolve => { resolveInference = resolve; });
    const runCycle = vi.fn(async () => {
      try { await waitForSafeInference(() => inference, controller.signal); }
      catch { events.push("cycle stopped"); }
    });
    const running = runSafeTestCycles({ maxCycles: 3, signal: controller.signal, runCycle, close: () => { events.push("closed"); } });
    events.push("stop"); controller.abort();
    await running;
    resolveInference("late response");
    let resolveFlush!: () => void;
    const pending = exitSafeTestProcess(0, () => new Promise<void>(resolve => { resolveFlush = resolve; }), () => { events.push("exit"); });
    expect(events).toEqual(["stop", "cycle stopped", "closed"]);
    events.push("flushed"); resolveFlush(); await pending;
    expect(events).toEqual(["stop", "cycle stopped", "closed", "flushed", "exit"]);
    expect(runCycle).toHaveBeenCalledOnce();
  });
  it("bounds a permanently blocked output flush", async () => {
    vi.useFakeTimers();
    try {
      const exit = vi.fn();
      const pending = exitSafeTestProcess(0, () => new Promise(() => {}), exit);
      await vi.advanceTimersByTimeAsync(5_000);
      await pending;
      expect(exit).toHaveBeenCalledWith(1);
    } finally { vi.useRealTimers(); }
  });
  it.each(["heartbeat", "state", "both"])("closes SQLite when %s cleanup fails", failure => {
    const closeDb = vi.fn();
    const removeListeners = vi.fn();
    expect(() => closeSafeTestResources([
      () => { if (failure !== "state") throw new Error("heartbeat failed"); },
      () => { if (failure !== "heartbeat") throw new Error("state failed"); },
      closeDb, removeListeners,
    ])).toThrow(/failed/);
    expect(closeDb).toHaveBeenCalledOnce();
    expect(removeListeners).toHaveBeenCalledOnce();
  });
  it("preserves runtime and cleanup errors together", async () => {
    const runtime = new Error("inference failed");
    const cleanup = new Error("cleanup failed");
    const result = runSafeTestCycles({ maxCycles: 1, runCycle: async () => { throw runtime; }, close: () => { throw cleanup; } });
    await expect(result).rejects.toMatchObject({ errors: [runtime, cleanup], message: "inference failed; cleanup failed" });
  });
  it("waits for both output callbacks before exiting, after the report write", async () => {
    const events = ["report written"];
    const callbacks: Array<(error?: Error | null) => void> = [];
    const streams = [0, 1].map(() => ({ write: vi.fn((_text, callback) => { callbacks.push(callback); }) })) as unknown as Parameters<typeof flushSafeTestOutput>[0];
    const exit = vi.fn(() => { events.push("exit"); });
    const pending = exitSafeTestProcess(0, () => flushSafeTestOutput(streams), exit);
    expect(exit).not.toHaveBeenCalled();
    callbacks[0]();
    await Promise.resolve();
    expect(exit).not.toHaveBeenCalled();
    events.push("report flushed");
    callbacks[1]();
    await pending;
    expect(events).toEqual(["report written", "report flushed", "exit"]);
    expect(exit).toHaveBeenCalledWith(0);
  });
  it("retains failure exit codes and fails closed on output errors", async () => {
    const exit = vi.fn();
    await exitSafeTestProcess(1, async () => {}, exit);
    expect(exit).toHaveBeenLastCalledWith(1);
    await exitSafeTestProcess(0, async () => { throw new Error("broken pipe"); }, exit);
    expect(exit).toHaveBeenLastCalledWith(1);
  });
  it("defaults to one cycle", () => {
    vi.stubEnv("AUTOMATON_SAFE_LOCAL_TEST_MAX_CYCLES", undefined);
    expect(safeTestCycleLimit()).toBe(1);
  });
  it.each(["", "0", "-1", "1.5", "NaN", "9007199254740992"])("rejects invalid limit %s", value => {
    expect(() => safeTestCycleLimit(value)).toThrow(/positive safe integer/);
  });
  it("reads the explicit cycle limit", () => {
    vi.stubEnv("AUTOMATON_SAFE_LOCAL_TEST_MAX_CYCLES", "2");
    expect(safeTestCycleLimit()).toBe(2);
  });
  it("returns and closes once at the limit without a sleep timer or restart", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    const close = vi.fn();
    const runCycle = vi.fn().mockResolvedValue(undefined);
    await runSafeTestCycles({ maxCycles: 2, runCycle, close });
    await Promise.resolve();
    expect(runCycle).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
    expect(timers).not.toHaveBeenCalled();
    timers.mockRestore();
  });
  it("closes and propagates errors without retrying", async () => {
    const close = vi.fn();
    const runCycle = vi.fn().mockRejectedValue(new Error("Ollama unavailable"));
    await expect(runSafeTestCycles({ maxCycles: 3, runCycle, close })).rejects.toThrow("Ollama unavailable");
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });
});
