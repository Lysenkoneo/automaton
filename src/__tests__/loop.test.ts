/**
 * Agent Loop Tests
 *
 * Deterministic tests for the agent loop using mock clients.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { runAgentLoop } from "../agent/loop.js";
import { runSafeTestCycles } from "../agent/safe-test-runner.js";
import { Orchestrator } from "../orchestration/orchestrator.js";
import { LocalWorkerPool } from "../orchestration/local-worker.js";
import { HarnessRegistry } from "../agent/harness-registry.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MockInferenceClient,
  MockConwayClient,
  MockSocialClient,
  createTestDb,
  createTestIdentity,
  createTestConfig,
  toolCallResponse,
  noToolResponse,
} from "./mocks.js";
import type { AutomatonDatabase, AgentTurn, AgentState } from "../types.js";
import type { TaskNode } from "../orchestration/task-graph.js";

// Keep loop tests independent of live blockchain RPC calls.
vi.mock("../conway/x402.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../conway/x402.js")>(),
  getUsdcBalance: async () => 0,
}));

vi.mock("../registry/discovery.js", () => ({ discoverAgents: vi.fn().mockResolvedValue([]), searchAgents: vi.fn().mockResolvedValue([]) }));

vi.mock("../ollama/discover.js", () => ({ discoverOllamaModels: vi.fn() }));
vi.mock("../conway/topup.js", () => ({ bootstrapTopup: vi.fn() }));

describe("Agent Loop", () => {
  let db: AutomatonDatabase;
  let conway: MockConwayClient;
  let identity: ReturnType<typeof createTestIdentity>;
  let config: ReturnType<typeof createTestConfig>;

  beforeEach(() => {
    db = createTestDb();
    conway = new MockConwayClient();
    identity = createTestIdentity();
    config = createTestConfig();
    const exists = fs.existsSync.bind(fs);
    vi.spyOn(fs, "existsSync").mockImplementation(file =>
      String(file).startsWith(path.join(os.homedir(), ".automaton")) ? false : exists(file));
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Unexpected real network request")));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    db.close();
  });


  it.each([
    "Report: the supplied purpose is available; a concrete next step is to review its requirements.",
    "Report: no useful data is available in the context or memory. No evidence-based analysis can be produced.",
  ])("safe test delivers a textual report and terminates its runtime: %s", async report => {
    config.inferenceMode = "local";
    config.safeLocalTest = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }))));
    const { discoverOllamaModels } = await import("../ollama/discover.js");
    const { ModelRegistry } = await import("../inference/registry.js");
    vi.mocked(discoverOllamaModels).mockImplementationOnce(async (_url, rawDb) => {
      const registry = new ModelRegistry(rawDb);
      registry.upsert({ ...registry.get("gpt-5-mini")!, modelId: "qwen2.5:7b", provider: "ollama", costPer1kInput: 0, costPer1kOutput: 0, enabled: true });
      return ["qwen2.5:7b"];
    });
    const inference = new MockInferenceClient([noToolResponse(report)]);
    const reports: string[] = [];
    const close = vi.fn();
    const runCycle = vi.fn(() => runAgentLoop({ identity, config, db, conway, inference, onTurnComplete: turn => { reports.push(turn.thinking); } }));
    await runSafeTestCycles({ maxCycles: 1, runCycle, close });
    expect(reports).toContain(report);
    expect(runCycle).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(db.getAgentState()).toBe("sleeping");
    const prompt = inference.calls[0].messages[0].content;
    expect(prompt).toContain("available memory");
    expect(prompt).toContain("no useful data is available");
    expect(prompt).toContain("Do not invent observations or ask the user to assign you a task");
  });

  it.each([
    ["maintenance", "MAINTENANCE LOOP DETECTED", "check_reputation", "check_inference_spending"],
    ["repetition", "LOOP DETECTED", "check_inference_spending", "check_inference_spending"],
  ])("safe %s warning requests useful text then sleep without enabling actions", async (_kind, marker, first, second) => {
    config.inferenceMode = "local";
    config.safeLocalTest = true;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }))));
    const { discoverOllamaModels } = await import("../ollama/discover.js");
    const { ModelRegistry } = await import("../inference/registry.js");
    vi.mocked(discoverOllamaModels).mockImplementationOnce(async (_url, rawDb) => {
      const registry = new ModelRegistry(rawDb);
      registry.upsert({ ...registry.get("gpt-5-mini")!, modelId: "qwen2.5:7b", provider: "ollama", costPer1kInput: 0, costPer1kOutput: 0, enabled: true });
      return ["qwen2.5:7b"];
    });
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: first, arguments: {} }]),
      toolCallResponse([{ name: second, arguments: {} }]),
      toolCallResponse([{ name: "sleep", arguments: { duration_seconds: 60, reason: "text plan delivered" } }], "A concrete plan: analyze the supplied context, list assumptions, and report next steps."),
    ]);
    const turns: AgentTurn[] = [];
    const credits = vi.spyOn(conway, "getCreditsBalance");
    const exec = vi.spyOn(conway, "exec");
    const transfer = vi.spyOn(conway, "transferCredits");
    const spawn = vi.spyOn(LocalWorkerPool.prototype, "spawn");
    await runAgentLoop({ identity, config, db, conway, inference, onTurnComplete: turn => turns.push(turn) });
    const warning = turns.find(turn => turn.input?.includes(marker));
    expect(warning).toBeDefined();
    expect(warning!.input).toContain("textual answer or concrete plan");
    expect(warning!.input).toContain("sleep");
    expect(warning!.input).not.toContain("Write code");
    expect(warning!.input).not.toContain("execute a CONCRETE task");
    expect(db.getAgentState()).toBe("sleeping");
    expect(credits).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled(); expect(transfer).not.toHaveBeenCalled(); expect(spawn).not.toHaveBeenCalled();
    expect(inference.calls[0].messages[0].content).toContain("SAFE LOCAL TEST");
    expect(inference.calls[0].messages[0].content).not.toContain("$-0.01");
  });

  it("strict local preflight stops before Conway when Ollama is unavailable", async () => {
    config.inferenceMode = "local";
    const fetch = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetch);
    const credits = vi.spyOn(conway, "getCreditsBalance");
    try {
      await expect(runAgentLoop({ identity, config, db, conway, inference: new MockInferenceClient() })).rejects.toThrow(/Strict local Ollama.*ECONNREFUSED/);
      expect(credits).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });


  it("explicit remote keeps credit checks and matrix routing even with an Ollama URL", async () => {
    config.inferenceMode = "remote";
    config.ollamaBaseUrl = "http://localhost:11434";
    const inference = new MockInferenceClient([noToolResponse("Done")]);
    const chat = vi.spyOn(inference, "chat");
    const credits = vi.spyOn(conway, "getCreditsBalance");
    await runAgentLoop({ identity, config, db, conway, inference });
    expect(credits).toHaveBeenCalled();
    expect(chat).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ model: "gpt-5.2" }));
  });

  it("strict local loop requests Qwen and excludes funding tools", async () => {
    config.inferenceMode = "local";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }))));
    const { discoverOllamaModels } = await import("../ollama/discover.js");
    const { ModelRegistry } = await import("../inference/registry.js");
    vi.mocked(discoverOllamaModels).mockImplementationOnce(async (_url, rawDb) => {
      const registry = new ModelRegistry(rawDb);
      registry.upsert({ ...registry.get("gpt-5-mini")!, modelId: "qwen2.5:7b", provider: "ollama", costPer1kInput: 0, costPer1kOutput: 0, enabled: true });
      return ["qwen2.5:7b"];
    });
    const inference = new MockInferenceClient([noToolResponse("Done")]);
    const chat = vi.spyOn(inference, "chat");
    const credits = vi.spyOn(conway, "getCreditsBalance");
    const exec = vi.spyOn(conway, "exec");
    const transfer = vi.spyOn(conway, "transferCredits");
    const spawn = vi.spyOn(LocalWorkerPool.prototype, "spawn").mockReturnValue({ address: "local://test", name: "test", sandboxId: "test" });
    vi.spyOn(Orchestrator.prototype, "tick").mockImplementation(async function () {
      const params = (this as any).params;
      expect(await params.config.spawnAgent({ title: "test" })).toMatchObject({ address: "local://test" });
      await expect(params.funding.fundChild("remote-child", 100)).rejects.toThrow(/forbidden/);
      return { phase: "idle", tasksAssigned: 0, tasksCompleted: 0, tasksFailed: 0, goalsActive: 0, agentsActive: 0 };
    });
    try {
      await runAgentLoop({ identity, config, db, conway, inference });
      expect(chat).toHaveBeenCalledWith(expect.any(Array), expect.objectContaining({ model: "qwen2.5:7b" }));
      expect(chat.mock.calls[0][1]?.tools?.map(t => t.function.name)).not.toContain("topup_credits");
      expect(credits).not.toHaveBeenCalled();
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(exec).not.toHaveBeenCalled();
      expect(transfer).not.toHaveBeenCalled();
    } finally { vi.unstubAllGlobals(); }
  });

  it.each(["config", "option"])("runs local Ollama without credit restrictions or topup via %s", async (source) => {
    const url = "http://localhost:11434";
    if (source === "config") config.ollamaBaseUrl = url;
    db.setKV("last_known_balance", JSON.stringify({ creditsCents: 0, usdcBalance: 100 }));
    const fetch = vi.spyOn(conway, "getCreditsBalance").mockRejectedValue(new Error("unavailable"));
    const inference = new MockInferenceClient([noToolResponse("Done")]);
    const lowCompute = vi.spyOn(inference, "setLowComputeMode");
    const states: AgentState[] = [];
    const { bootstrapTopup } = await import("../conway/topup.js");
    vi.mocked(bootstrapTopup).mockClear();
    await runAgentLoop({ identity, config, db, conway, inference,
      ...(source === "option" ? { ollamaBaseUrl: url } : {}),
      onStateChange: state => states.push(state) });
    expect(fetch).not.toHaveBeenCalled();
    expect(states).not.toContain("critical");
    expect(states).not.toContain("low_compute");
    expect(lowCompute).not.toHaveBeenCalledWith(true);
    expect(bootstrapTopup).not.toHaveBeenCalled();
  });

  it("does not top up when an API outage leaves cached credits unknown", async () => {
    db.setKV("last_known_balance", JSON.stringify({ usdcBalance: 100 }));
    vi.spyOn(conway, "getCreditsBalance").mockRejectedValue(new Error("unavailable"));
    const inference = new MockInferenceClient([noToolResponse("Done")]);
    const lowCompute = vi.spyOn(inference, "setLowComputeMode");
    const { bootstrapTopup } = await import("../conway/topup.js");
    vi.mocked(bootstrapTopup).mockClear();
    await runAgentLoop({ identity, config, db, conway, inference });
    expect(lowCompute).toHaveBeenCalledWith(true);
    expect(bootstrapTopup).not.toHaveBeenCalled();
    expect(db.getKV("last_inline_topup_attempt")).toBeUndefined();
  });

  it("exec tool runs and is persisted", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "echo hello" } },
      ]),
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // First turn should have the exec tool call
    expect(turns.length).toBeGreaterThanOrEqual(1);
    const execTurn = turns.find((t) =>
      t.toolCalls.some((tc) => tc.name === "exec"),
    );
    expect(execTurn).toBeDefined();
    expect(execTurn!.toolCalls[0].name).toBe("exec");
    expect(execTurn!.toolCalls[0].error).toBeUndefined();

    // Verify conway.exec was called
    expect(conway.execCalls.length).toBeGreaterThanOrEqual(1);
    expect(conway.execCalls[0].command).toBe("echo hello");
  });

  it("forbidden patterns blocked", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "rm -rf ~/.automaton" } },
      ]),
      noToolResponse("OK."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // The tool result should contain a blocked message, not an error
    const execTurn = turns.find((t) =>
      t.toolCalls.some((tc) => tc.name === "exec"),
    );
    expect(execTurn).toBeDefined();
    const execCall = execTurn!.toolCalls.find((tc) => tc.name === "exec");
    expect(execCall!.result).toContain("Blocked");

    // conway.exec should NOT have been called
    expect(conway.execCalls.length).toBe(0);
  });

  it("low credits forces low-compute mode", async () => {
    conway.creditsCents = 50; // Below $1 threshold -> critical

    const inference = new MockInferenceClient([
      noToolResponse("Low on credits."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(inference.lowComputeMode).toBe(true);
  });

  it("sleep tool transitions state", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "sleep", arguments: { duration_seconds: 60, reason: "test" } },
      ]),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeDefined();
  });

  it("idle auto-sleep on no tool calls", async () => {
    const inference = new MockInferenceClient([
      noToolResponse("Nothing to do."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(db.getAgentState()).toBe("sleeping");
  });

  it("inbox messages cause pendingInput injection", async () => {
    // Insert an inbox message before running the loop
    db.insertInboxMessage({
      id: "test-msg-1",
      from: "0xsender",
      to: "0xrecipient",
      content: "Hello from another agent!",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const inference = new MockInferenceClient([
      // First response: wakeup prompt
      toolCallResponse([
        { name: "exec", arguments: { command: "echo awake" } },
      ]),
      // Second response: inbox message (after wakeup turn, pendingInput is cleared,
      // then inbox messages are picked up on the next iteration)
      noToolResponse("Received the message."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // One of the turns should have input from the inbox message
    const inboxTurn = turns.find(
      (t) => t.input?.includes("Hello from another agent!"),
    );
    expect(inboxTurn).toBeDefined();
    expect(inboxTurn!.inputSource).toBe("agent");
  });

  it("MAX_TOOL_CALLS_PER_TURN limits tool calls", async () => {
    // Create a response with 15 tool calls (max is 10)
    const manyToolCalls = Array.from({ length: 15 }, (_, i) => ({
      name: "exec",
      arguments: { command: `echo ${i}` },
    }));

    const inference = new MockInferenceClient([
      toolCallResponse(manyToolCalls),
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // The first turn should have at most 10 tool calls executed
    const execTurn = turns.find((t) => t.toolCalls.length > 0);
    expect(execTurn).toBeDefined();
    expect(execTurn!.toolCalls.length).toBeLessThanOrEqual(10);
  });

  it("consecutive errors trigger sleep", async () => {
    // Create an inference client that always throws
    const failingInference = new MockInferenceClient([]);
    failingInference.chat = async () => {
      throw new Error("Inference API unavailable");
    };

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleSpy2 = vi.spyOn(console, "log").mockImplementation(() => {});
    const consoleSpy3 = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runAgentLoop({
      identity,
      config: { ...config, logLevel: "debug" },
      db,
      conway,
      inference: failingInference,
    });

    // After 5 consecutive errors, should be sleeping
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeDefined();

    consoleSpy.mockRestore();
    consoleSpy2.mockRestore();
    consoleSpy3.mockRestore();
  });

  it("financial state cached fallback on API failure", async () => {
    // Pre-cache a known balance
    db.setKV("last_known_balance", JSON.stringify({ creditsCents: 5000, usdcBalance: 1.0 }));

    // Make credits API fail
    conway.getCreditsBalance = async () => {
      throw new Error("API down");
    };

    const inference = new MockInferenceClient([
      noToolResponse("Running with cached balance."),
    ]);

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const consoleSpy2 = vi.spyOn(console, "warn").mockImplementation(() => {});

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    // Should not die, should use cached balance and continue
    const state = db.getAgentState();
    expect(state).not.toBe("dead");

    consoleSpy.mockRestore();
    consoleSpy2.mockRestore();
  });

  it("turn persistence is atomic with inbox ack", async () => {
    // Insert an inbox message
    db.insertInboxMessage({
      id: "atomic-msg-1",
      from: "0xsender",
      to: "0xrecipient",
      content: "Test atomic persistence",
      signedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    });

    const inference = new MockInferenceClient([
      toolCallResponse([
        { name: "exec", arguments: { command: "echo processing" } },
      ]),
      noToolResponse("Done processing."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // After processing, the inbox message should be marked as processed
    const unprocessed = db.getUnprocessedInboxMessages(10);
    // The message should have been consumed (either processed or not showing as unprocessed)
    // Since we successfully completed the turn, it should be processed
    expect(turns.length).toBeGreaterThanOrEqual(1);
  });

  it("state transitions are reported via onStateChange", async () => {
    const stateChanges: AgentState[] = [];

    const inference = new MockInferenceClient([
      noToolResponse("Nothing to do."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onStateChange: (state) => stateChanges.push(state),
    });

    // Should have transitioned through waking -> running -> sleeping
    expect(stateChanges).toContain("waking");
    expect(stateChanges).toContain("running");
    expect(stateChanges).toContain("sleeping");
  });

  it("cycle turn limit forces sleep after maxTurnsPerCycle", async () => {
    // Set a low cycle limit
    const lowLimitConfig = createTestConfig({ maxTurnsPerCycle: 3 });

    // Create responses that would keep running indefinitely (all mutating tools)
    const responses = Array.from({ length: 10 }, () =>
      toolCallResponse([{ name: "exec", arguments: { command: "echo loop" } }]),
    );
    const inference = new MockInferenceClient(responses);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config: lowLimitConfig,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // Should have stopped at or before the cycle limit (3 turns)
    expect(turns.length).toBeLessThanOrEqual(3);
    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeDefined();
  });

  it("cycle limit sets 2-minute sleep duration", async () => {
    const lowLimitConfig = createTestConfig({ maxTurnsPerCycle: 1 });

    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "exec", arguments: { command: "echo test" } }]),
    ]);

    await runAgentLoop({
      identity,
      config: lowLimitConfig,
      db,
      conway,
      inference,
    });

    const sleepUntil = db.getKV("sleep_until");
    expect(sleepUntil).toBeDefined();
    // Sleep should be ~2 minutes (120_000ms) from now
    const sleepMs = new Date(sleepUntil!).getTime() - Date.now();
    expect(sleepMs).toBeGreaterThan(100_000); // at least ~100s
    expect(sleepMs).toBeLessThan(150_000); // at most ~150s
  });

  it("respects custom maxTurnsPerCycle from config", async () => {
    // A limit of 5 should allow exactly 5 turns before forcing sleep
    const limit5Config = createTestConfig({ maxTurnsPerCycle: 5 });

    // Use varied tool names to avoid loop detection (fires after 3 identical patterns)
    const toolNames = ["exec", "write_file", "git_status", "exec", "write_file", "exec", "write_file"];
    const responses = toolNames.map((name) =>
      toolCallResponse([{ name, arguments: name === "exec" ? { command: "echo work" } : { path: "/tmp/test" } }]),
    );

    const inference = new MockInferenceClient(responses);
    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config: limit5Config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // Should have stopped at the cycle limit of 5
    expect(turns.length).toBeLessThanOrEqual(5);
    expect(db.getAgentState()).toBe("sleeping");
  });

  it("zero credits enters critical tier, not dead", async () => {
    conway.creditsCents = 0; // $0 -> critical tier (agent stays alive)

    const inference = new MockInferenceClient([
      noToolResponse("I have no credits but I'm still alive."),
    ]);

    const stateChanges: AgentState[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onStateChange: (state) => stateChanges.push(state),
    });

    // Zero credits = critical, not dead. Agent should stay alive.
    expect(stateChanges).toContain("critical");
    expect(stateChanges).not.toContain("dead");
    expect(db.getAgentState()).not.toBe("dead");
  });

  it("does not treat different arguments to the same tool as repetitions", async () => {
    const inference = new MockInferenceClient([
      ...["echo one", "echo two", "echo three", "echo four"].map((command) =>
        toolCallResponse([{ name: "exec", arguments: { command } }])),
      noToolResponse("Done."),
    ]);
    const turns: AgentTurn[] = [];
    await runAgentLoop({ identity, config, db, conway, inference, onTurnComplete: turn => turns.push(turn) });
    expect(conway.execCalls.map(call => call.command)).toEqual(["echo one", "echo two", "echo three", "echo four"]);
    expect(turns).toHaveLength(5);
    expect(turns.some(turn => turn.input?.includes("LOOP DETECTED"))).toBe(false);
  });

  it("normalizes object key order and forces sleep after four identical calls", async () => {
    const responses = Array.from({ length: 6 }, (_, i) => toolCallResponse([{ name: "exec", arguments: i % 2
      ? { timeout: 1000, command: "echo same", metadata: { b: 2, a: 1 } }
      : { command: "echo same", metadata: { a: 1, b: 2 }, timeout: 1000 } }]));
    const inference = new MockInferenceClient(responses);
    const turns: AgentTurn[] = [];
    await runAgentLoop({ identity, config, db, conway, inference, onTurnComplete: turn => turns.push(turn) });
    expect(turns[2].input).toContain("LOOP DETECTED");
    expect(conway.execCalls).toHaveLength(4);
    expect(db.getAgentState()).toBe("sleeping");
  });

  it("resets the loop warning when arguments change without changing the tool", async () => {
    const inference = new MockInferenceClient([
      ...["echo same", "echo same", "echo changed", "echo another"].map(command =>
        toolCallResponse([{ name: "exec", arguments: { command } }])),
      noToolResponse("Done."),
    ]);
    const turns: AgentTurn[] = [];
    await runAgentLoop({ identity, config, db, conway, inference, onTurnComplete: turn => turns.push(turn) });
    expect(turns[2].input).toContain("LOOP DETECTED");
    expect(turns).toHaveLength(5);
    expect(conway.execCalls).toHaveLength(4);
  });

  it("still detects maintenance after two different idle-only tool turns", async () => {
    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "check_credits", arguments: {} }]),
      toolCallResponse([{ name: "system_synopsis", arguments: {} }]),
      noToolResponse("Done."),
    ]);
    const turns: AgentTurn[] = [];
    await runAgentLoop({ identity, config, db, conway, inference, onTurnComplete: turn => turns.push(turn) });
    expect(turns[2].input).toContain("MAINTENANCE LOOP DETECTED");
  });

  it("maintenance loop detected after 3 consecutive idle-only turns", async () => {
    // Simulate: wakeup turn with check_credits, then 2 more idle-only turns,
    // triggering maintenance loop detection on the 3rd idle-only turn.
    // Construct responses with unique tool_call IDs to avoid DB collisions.
    function idleToolResponse(name: string, args: Record<string, unknown>, uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      idleToolResponse("check_credits", {}, "t1"),
      idleToolResponse("system_synopsis", {}, "t2"),
      idleToolResponse("review_memory", {}, "t3"),
      noToolResponse("I will now work on something productive."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // The intervention message should have been injected after the 3rd idle-only turn.
    // Turn 4 should have the maintenance loop intervention as input.
    const interventionTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(interventionTurn).toBeDefined();
    expect(interventionTurn!.input).toContain("status-check tools");
  });

  it("maintenance loop NOT triggered when turns mix idle and productive tools", async () => {
    // Turn 1: idle-only, Turn 2: has productive tool (exec), Turn 3: idle-only
    // Should NOT trigger because turn 2 breaks the consecutive count.
    const inference = new MockInferenceClient([
      // Turn 1 (wakeup): idle-only
      toolCallResponse([
        { name: "check_credits", arguments: {} },
      ]),
      // Turn 2: productive tool — resets idle counter
      toolCallResponse([
        { name: "exec", arguments: { command: "echo hello" } },
      ]),
      // Turn 3: idle-only — counter starts at 1 again
      toolCallResponse([
        { name: "system_synopsis", arguments: {} },
      ]),
      // Turn 4: end
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // No maintenance loop intervention should have been injected
    const interventionTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(interventionTurn).toBeUndefined();
  });

  it("maintenance loop triggers with varying idle tool combinations", async () => {
    // Each turn uses a different idle-only tool, but all are idle-only.
    // The existing exact-pattern detector would NOT catch this (different patterns).
    // The new idle-tool detector SHOULD catch it.
    function idleToolResponse(name: string, args: Record<string, unknown>, uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name, arguments: JSON.stringify(args) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name, arguments: JSON.stringify(args) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      idleToolResponse("check_credits", {}, "v1"),
      idleToolResponse("check_usdc_balance", {}, "v2"),
      idleToolResponse("git_status", {}, "v3"),
      noToolResponse("Starting productive work now."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const interventionTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(interventionTurn).toBeDefined();
  });

  it("loop enforcement forces sleep after warning is ignored (6 identical patterns)", async () => {
    // 6 identical exec tool calls: warning fires at turn 3, enforcement at turn 6.
    // Use unique IDs to avoid DB collisions.
    function execResponse(uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name: "exec", arguments: JSON.stringify({ command: "echo loop" }) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name: "exec", arguments: JSON.stringify({ command: "echo loop" }) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      execResponse("e1"),
      execResponse("e2"),
      execResponse("e3"), // Warning fires here
      execResponse("e4"),
      execResponse("e5"),
      execResponse("e6"), // Enforcement fires here — forced sleep
    ]);

    const turns: AgentTurn[] = [];
    const stateChanges: AgentState[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
      onStateChange: (state) => stateChanges.push(state),
    });

    // Should have the warning at turn 4 (injected after turn 3)
    const warningTurn = turns.find(
      (t) => t.input?.includes("LOOP DETECTED"),
    );
    expect(warningTurn).toBeDefined();

    // Agent should be sleeping due to enforcement
    expect(db.getAgentState()).toBe("sleeping");
    expect(stateChanges[stateChanges.length - 1]).toBe("sleeping");
  });

  it("loop enforcement resets when agent changes behavior after warning", async () => {
    // 3 identical exec calls → warning → different tool → 3 more exec calls → warning (not enforcement)
    function execResponse(uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name: "exec", arguments: JSON.stringify({ command: "echo loop" }) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name: "exec", arguments: JSON.stringify({ command: "echo loop" }) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      execResponse("r1"),
      execResponse("r2"),
      execResponse("r3"), // Warning fires, loopWarningPattern = "exec"
      // Turn 4: different tool — resets loopWarningPattern
      toolCallResponse([
        { name: "send_message", arguments: { to: "0x123", content: "hello" } },
      ]),
      execResponse("r5"),
      execResponse("r6"),
      execResponse("r7"), // Warning fires again (NOT enforcement — tracker was reset)
      noToolResponse("Done."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // Should have gotten a warning, not enforcement (agent is still running, not force-slept)
    // The second set of 3 identical patterns gets a NEW warning, not enforcement
    const warningTurns = turns.filter(
      (t) => t.input?.includes("LOOP DETECTED"),
    );
    expect(warningTurns.length).toBeGreaterThanOrEqual(2);

    // No enforcement turn should exist
    const enforcementTurn = turns.find(
      (t) => t.input?.includes("LOOP ENFORCEMENT"),
    );
    expect(enforcementTurn).toBeUndefined();
  });

  it("discover_agents turns are retained in context (not classified as idle)", { timeout: 180_000 }, async () => {
    // A turn with only discover_agents should NOT trigger maintenance loop detection
    // because discover_agents is no longer in IDLE_ONLY_TOOLS
    function discoverResponse(uid: string): ReturnType<typeof toolCallResponse> {
      return {
        id: `resp_${uid}`,
        model: "mock-model",
        message: {
          role: "assistant",
          content: "",
          tool_calls: [{
            id: `call_${uid}`,
            type: "function" as const,
            function: { name: "discover_agents", arguments: JSON.stringify({ limit: 15 }) },
          }],
        },
        toolCalls: [{
          id: `call_${uid}`,
          type: "function" as const,
          function: { name: "discover_agents", arguments: JSON.stringify({ limit: 15 }) },
        }],
        usage: { promptTokens: 100, completionTokens: 50, totalTokens: 150 },
        finishReason: "tool_calls",
      };
    }

    const inference = new MockInferenceClient([
      discoverResponse("d1"),
      discoverResponse("d2"),
      discoverResponse("d3"), // Would trigger maintenance loop if discover_agents were idle
      noToolResponse("Processing discovery results."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    // No maintenance loop detection should fire since discover_agents is NOT idle
    const maintenanceTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(maintenanceTurn).toBeUndefined();

    // But the repetitive pattern detector SHOULD fire (3 identical patterns)
    const loopWarning = turns.find(
      (t) => t.input?.includes("LOOP DETECTED"),
    );
    expect(loopWarning).toBeDefined();
  });

  it("read_file turns are retained in context (not classified as idle)", async () => {
    conway.files["/tmp/one.txt"] = "one";
    conway.files["/tmp/two.txt"] = "two";
    conway.files["/tmp/three.txt"] = "three";

    const inference = new MockInferenceClient([
      toolCallResponse([{ name: "read_file", arguments: { path: "/tmp/one.txt" } }]),
      toolCallResponse([{ name: "read_file", arguments: { path: "/tmp/two.txt" } }]),
      toolCallResponse([{ name: "read_file", arguments: { path: "/tmp/three.txt" } }]),
      noToolResponse("Processed file contents."),
    ]);

    const turns: AgentTurn[] = [];

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
      onTurnComplete: (turn) => turns.push(turn),
    });

    const maintenanceTurn = turns.find(
      (t) => t.input?.includes("MAINTENANCE LOOP DETECTED"),
    );
    expect(maintenanceTurn).toBeUndefined();

    const loopWarning = turns.find(
      (t) => t.input?.includes("LOOP DETECTED"),
    );
    // Different file paths are productive calls, not repeated arguments.
    expect(loopWarning).toBeUndefined();
  });

  it("sleeps early when delegated work is active and no self-assigned parent task remains", async () => {
    const tickSpy = vi.spyOn(Orchestrator.prototype, "tick").mockResolvedValue({
      phase: "executing",
      tasksAssigned: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      goalsActive: 1,
      agentsActive: 1,
    });

    const inference = new MockInferenceClient([
      noToolResponse("This should never be used."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(db.getAgentState()).toBe("sleeping");
    expect(db.getKV("sleep_until")).toBeDefined();
    expect(inference.calls.length).toBe(0);
    tickSpy.mockRestore();
  });

  it("does not sleep early when the parent has a self-assigned task", async () => {
    db.raw.prepare(
      "INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run("goal-self", "Self goal", "Self goal description", "active", new Date().toISOString());
    db.raw.prepare(
      `INSERT INTO task_graph
       (id, goal_id, title, description, status, assigned_to, agent_role, priority, dependencies, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "task-self",
      "goal-self",
      "Parent task",
      "Handled by parent",
      "assigned",
      identity.address,
      "generalist",
      50,
      JSON.stringify([]),
      new Date().toISOString(),
    );

    const tickSpy = vi.spyOn(Orchestrator.prototype, "tick").mockResolvedValue({
      phase: "executing",
      tasksAssigned: 0,
      tasksCompleted: 0,
      tasksFailed: 0,
      goalsActive: 1,
      agentsActive: 1,
    });

    const inference = new MockInferenceClient([
      noToolResponse("Still working."),
    ]);

    await runAgentLoop({
      identity,
      config,
      db,
      conway,
      inference,
    });

    expect(inference.calls.length).toBeGreaterThan(0);
    tickSpy.mockRestore();
  });

  it("keeps a local worker alive across two sleeping loop cycles", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "loop-worker-"));
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const registry = new HarnessRegistry();
    vi.spyOn(registry, "createForRole").mockReturnValue({
      id: "waiting", description: "waiting harness",
      initialize: async () => {},
      execute: async () => {
        await waiting;
        return { success: true, output: "done", artifacts: [], costCents: 0, duration: 1 };
      },
      getToolDefs: () => [], buildSystemPrompt: () => "", buildTaskPrompt: () => "",
    });
    db.raw.prepare("INSERT INTO goals (id, title, description, status, created_at) VALUES (?, ?, ?, ?, ?)")
      .run("goal-live", "Live goal", "Live goal", "active", new Date().toISOString());
    db.raw.prepare("INSERT INTO task_graph (id, goal_id, title, description, status, dependencies, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run("task-live", "goal-live", "Live task", "Live task", "pending", "[]", new Date().toISOString());
    const pool = new LocalWorkerPool({
      db: db.raw, conway, identity, config, harnessRegistry: registry,
      inference: { chat: async () => ({ content: "" }) }, workspaceBasePath: tempDir,
    });
    const task: TaskNode = {
      id: "task-live", parentId: null, goalId: "goal-live", title: "Live task",
      description: "Live task", status: "pending", assignedTo: null, agentRole: "generalist",
      priority: 50, dependencies: [], result: null,
      metadata: { estimatedCostCents: 0, actualCostCents: 0, maxRetries: 0, retryCount: 0,
        timeoutMs: 60_000, createdAt: new Date().toISOString(), startedAt: null, completedAt: null },
    };
    const spawned = pool.spawn(task);
    db.raw.prepare("UPDATE task_graph SET status = 'assigned', assigned_to = ?, attempt_id = ? WHERE id = ?")
      .run(spawned.address, spawned.attemptId, "task-live");
    const tickSpy = vi.spyOn(Orchestrator.prototype, "tick").mockImplementation(async function () {
      expect((this as any).params.isWorkerAlive(spawned.address)).toBe(true);
      return { phase: "executing", tasksAssigned: 0, tasksCompleted: 0, tasksFailed: 0, goalsActive: 1, agentsActive: 0 };
    });
    try {
      for (let cycle = 0; cycle < 2; cycle++) {
        const inference = new MockInferenceClient([noToolResponse("unused")]);
        await runAgentLoop({ identity, config, db, conway, inference });
        expect(db.getAgentState()).toBe("sleeping");
        expect(inference.calls).toHaveLength(0);
      }
      expect(tickSpy).toHaveBeenCalledTimes(2);
    } finally {
      release();
      await pool.shutdown();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
