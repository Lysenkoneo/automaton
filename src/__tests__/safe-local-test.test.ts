import fs from "node:fs";
import { exec } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSafeLocalEnvironment, assertSafeLocalCommand, isSafeLocalTest, isToolAllowed, createSafeTestIdentity, prepareSafeTestConfig } from "../inference/safe-local-test.js";
import { createBuiltinTools, executeTool } from "../agent/tools.js";
import { CodingHarness } from "../agent/harnesses/coding-harness.js";
import { GeneralHarness } from "../agent/harnesses/general-harness.js";
import { createHeartbeatDaemon } from "../heartbeat/daemon.js";
import { DurableScheduler } from "../heartbeat/scheduler.js";
import { discoverOllamaModels } from "../ollama/discover.js";
import { LocalWorkerPool } from "../orchestration/local-worker.js";
import { createTestConfig, MockConwayClient } from "./mocks.js";

vi.mock("node:child_process", () => ({ exec: vi.fn(() => { throw new Error("Unexpected system command"); }), execSync: vi.fn(), execFileSync: vi.fn(), spawn: vi.fn() }));
const safe = () => createTestConfig({ inferenceMode: "local", safeLocalTest: true });
beforeEach(() => { vi.stubEnv("AUTOMATON_SAFE_LOCAL_TEST", undefined); vi.stubEnv("AUTOMATON_INFERENCE_MODE", undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("safe local test boundaries", () => {
  it.each([undefined, "remote", "LOCAL"])("refuses safe environment without explicit local: %s", mode => {
    vi.stubEnv("AUTOMATON_SAFE_LOCAL_TEST", "1");
    expect(() => assertSafeLocalEnvironment(mode)).toThrow(/requires/);
  });
  it("accepts only explicit local and validates the flag", () => {
    vi.stubEnv("AUTOMATON_SAFE_LOCAL_TEST", "1");
    vi.stubEnv("AUTOMATON_INFERENCE_MODE", "local");
    expect(isSafeLocalTest(safe())).toBe(true);
    vi.stubEnv("AUTOMATON_SAFE_LOCAL_TEST", "yes");
    expect(() => assertSafeLocalEnvironment()).toThrow(/0 or 1/);
  });
  it.each([[[]], [["--setup"]], [["--init"]], [["--provision"]], [["--run", "--setup"]]])("refuses unsafe CLI arguments %j before entry-point initialization", (args) => {
    vi.stubEnv("AUTOMATON_SAFE_LOCAL_TEST", "1");
    vi.stubEnv("AUTOMATON_INFERENCE_MODE", "local");
    expect(() => assertSafeLocalCommand(args as string[])).toThrow(/administrative commands/);
    expect(() => assertSafeLocalCommand(["--run"])).not.toThrow();
  });
  it("leaves remote configuration unchanged when disabled", () => {
    const config = createTestConfig({ inferenceMode: "remote" });
    expect(prepareSafeTestConfig(config)).toBe(config);
    expect(isToolAllowed(config, { name: "register_erc8004", category: "registry" })).toBe(true);
  });
  it("isolates database and removes social configuration without mutating the original", () => {
    const config = safe();
    const original = { ...config };
    const result = prepareSafeTestConfig(config);
    expect(result.dbPath).toBe(":memory:");
    expect(result.socialRelayUrl).toBeUndefined();
    expect(config).toEqual(original);
  });
  it("creates no wallet and rejects every signing entry point", async () => {
    const read = vi.spyOn(fs, "readFileSync");
    const write = vi.spyOn(fs, "writeFileSync");
    const mkdir = vi.spyOn(fs, "mkdirSync");
    const { account, chainIdentity } = createSafeTestIdentity();
    for (const name of ["sign", "signMessage", "signTypedData", "signTransaction"] as const) {
      await expect((account[name] as any)({})).rejects.toThrow(/Signing is forbidden/);
    }
    await expect(chainIdentity.signMessage("test")).rejects.toThrow(/Signing is forbidden/);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled(); expect(mkdir).not.toHaveBeenCalled();
  });
  it.each(["register_erc8004", "give_feedback", "topup_credits", "transfer_credits", "fund_child", "spawn_child", "x402_fetch", "send_message", "message_child", "exec", "git_push", "install_npm_package", "unknown_future_tool"])("blocks catalog and execution of %s before signing, sending or running", async name => {
    const sign = vi.fn(); const send = vi.fn(); const network = vi.fn();
    const implementation = vi.fn(async () => { sign(); send(); network(); return "unexpected"; });
    const tool = { name, category: "registry", execute: implementation } as any;
    expect(isToolAllowed(safe(), tool)).toBe(false);
    const result = await executeTool(name, {}, [tool], { config: safe() } as any);
    expect(result.error).toMatch(/forbidden/);
    expect(implementation).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it.each(["register_erc8004", "give_feedback"])("also blocks %s in strict local mode without the safe flag", async name => {
    const config = createTestConfig({ inferenceMode: "local" });
    const tool = createBuiltinTools("").find(tool => tool.name === name)!;
    expect(isToolAllowed(config, tool)).toBe(false);
    const execute = vi.spyOn(tool, "execute");
    expect((await executeTool(name, {}, [tool], { config } as any)).error).toMatch(/forbidden/);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(["register_erc8004", "give_feedback", "send_message", "x402_fetch"])("refuses direct built-in implementation access to %s", async name => {
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const sign = vi.fn(); const send = vi.fn();
    const tool = createBuiltinTools("").find(tool => tool.name === name)!;
    expect(await tool.execute({}, { config: safe(), identity: { account: { signTypedData: sign } }, social: { send } } as any)).toMatch(/Blocked:/);
    expect(network).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it("retains audited database-only read tools", () => {
    const tools = createBuiltinTools("").filter(tool => isToolAllowed(safe(), tool));
    expect(tools.map(tool => tool.name)).toContain("check_reputation");
    expect(tools.map(tool => tool.name)).not.toContain("register_erc8004");
  });
  it.each([CodingHarness, GeneralHarness])("blocks %s commands even with a blocked Conway client", async Harness => {
    const conwayExec = vi.fn().mockRejectedValue(new Error("Conway blocked"));
    const harness = new Harness();
    (harness as any).context = { config: safe(), conway: { exec: conwayExec }, toolCatalog: [] };
    const tool = harness.getToolDefs().find(tool => tool.name === "exec")!;
    expect(await tool.execute({ command: "echo test" })).toMatch(/system commands are disabled/);
    expect(conwayExec).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
  });
  it("blocks direct general-harness social polling before signing", async () => {
    const poll = vi.fn(); const unreadCount = vi.fn();
    const harness = new GeneralHarness();
    (harness as any).context = { config: safe(), toolCatalog: [], toolContext: { social: { poll, unreadCount } } };
    expect(await harness.getToolDefs().find(tool => tool.name === "check_social_inbox")!.execute({})).toMatch(/social signing is disabled/);
    expect(poll).not.toHaveBeenCalled(); expect(unreadCount).not.toHaveBeenCalled();
  });
  it("disables the daemon before seeding schedules, ticking, or contacting any service", async () => {
    const rawDb = { prepare: vi.fn(), exec: vi.fn() };
    const conway = new MockConwayClient();
    const network = vi.fn(); vi.stubGlobal("fetch", network);
    const daemon = createHeartbeatDaemon({ config: safe(), rawDb, conway } as any);
    daemon.start(); expect(daemon.isRunning()).toBe(false);
    await expect(daemon.forceRun("check_social_inbox")).rejects.toThrow(/disabled/);
    expect(rawDb.prepare).not.toHaveBeenCalled(); expect(rawDb.exec).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it("blocks scheduler tick and direct task execution before any task or DB access", async () => {
    const db = { prepare: vi.fn() };
    const task = vi.fn(); const network = vi.fn(); vi.stubGlobal("fetch", network);
    const scheduler = new DurableScheduler(db as any, {} as any, new Map([["check_social_inbox", task]]), { config: safe() } as any);
    await scheduler.tick();
    await expect(scheduler.executeTask("check_social_inbox", {} as any)).rejects.toThrow(/disabled/);
    expect(task).not.toHaveBeenCalled(); expect(db.prepare).not.toHaveBeenCalled(); expect(network).not.toHaveBeenCalled();
  });
  it("refuses worker creation before scheduling, workspace creation or inference", () => {
    const inference = { chat: vi.fn() }; const db = { prepare: vi.fn() };
    const pool = new LocalWorkerPool({ config: safe(), db, inference } as any);
    expect(() => pool.spawn({} as any)).toThrow(/Worker creation is disabled/);
    expect(db.prepare).not.toHaveBeenCalled(); expect(inference.chat).not.toHaveBeenCalled();
  });
  it("Ollama discovery refuses redirects and does not make a fallback request", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("redirect refused")); vi.stubGlobal("fetch", fetch);
    const db = { prepare: vi.fn() };
    expect(await discoverOllamaModels("http://localhost:11434", db as any)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith("http://localhost:11434/api/tags", expect.objectContaining({ redirect: "error" }));
    expect(db.prepare).not.toHaveBeenCalled();
  });
});
