import fs from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadStartupConfig } from "../config.js";
import { getWallet } from "../identity/wallet.js";
import { loadApiKeyFromConfig, provision } from "../identity/provision.js";
import { runSetupWizard } from "../setup/wizard.js";

vi.mock("../identity/wallet.js", () => ({ getAutomatonDir: () => "/mock/automaton", getWallet: vi.fn() }));
vi.mock("../identity/provision.js", () => ({ loadApiKeyFromConfig: vi.fn().mockReturnValue(null), provision: vi.fn() }));
vi.mock("../setup/wizard.js", () => ({ runSetupWizard: vi.fn() }));

const valid = { name: "test", genesisPrompt: "Do useful work", creatorAddress: "mock-creator", inferenceMode: "remote" };
const error = /Strict local startup refused.*configuration.*setup wizard is disabled/;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(loadApiKeyFromConfig).mockReturnValue(null);
  vi.stubEnv("AUTOMATON_INFERENCE_MODE", undefined);
  vi.stubEnv("AUTOMATON_SAFE_LOCAL_TEST", undefined);
  vi.spyOn(fs, "existsSync").mockReturnValue(true);
  vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify(valid));
  vi.spyOn(fs, "writeFileSync").mockImplementation(() => { throw new Error("Unexpected write"); });
  vi.spyOn(fs, "mkdirSync").mockImplementation(() => { throw new Error("Unexpected directory creation"); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

function expectNoInitialization(): void {
  expect(runSetupWizard).not.toHaveBeenCalled();
  expect(getWallet).not.toHaveBeenCalled();
  expect(provision).not.toHaveBeenCalled();
  expect(fs.writeFileSync).not.toHaveBeenCalled();
  expect(fs.mkdirSync).not.toHaveBeenCalled();
}

describe("startup mode before configuration loading", () => {
  it.each([undefined, "remote"])("safe test refuses mode %s before configuration reads or setup", async mode => {
    vi.stubEnv("AUTOMATON_SAFE_LOCAL_TEST", "1");
    await expect(loadStartupConfig(mode)).rejects.toThrow(/requires AUTOMATON_INFERENCE_MODE=local/);
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expectNoInitialization();
  });
  it("propagates safe test explicitly without wallet, setup, or config writes", async () => {
    vi.stubEnv("AUTOMATON_SAFE_LOCAL_TEST", "1");
    vi.stubEnv("AUTOMATON_INFERENCE_MODE", "local");
    expect((await loadStartupConfig()).safeLocalTest).toBe(true);
    expectNoInitialization();
  });
  it("cannot activate runtime safety from a stored flag without the environment", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ ...valid, safeLocalTest: true }));
    expect((await loadStartupConfig("remote")).safeLocalTest).toBe(false);
    expectNoInitialization();
  });
  it.each([
    [null, "null"],
    [undefined, "absent"],
    ["", "empty string"],
    ["mock-conway-key", "string"],
  ])("accepts an optional Conway key (%s, %s) in environment-selected local mode", async (key) => {
    vi.stubEnv("AUTOMATON_INFERENCE_MODE", "local");
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ ...valid, conwayApiKey: key }));
    const config = await loadStartupConfig();
    expect(config.inferenceMode).toBe("local");
    expect(config.conwayApiKey).toBe(key || null);
    expectNoInitialization();
  });
  it("also accepts null Conway credentials when local mode comes from the file", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ ...valid, inferenceMode: "local", conwayApiKey: null }));
    expect((await loadStartupConfig()).inferenceMode).toBe("local");
    expectNoInitialization();
  });
  it("preserves the historical null Conway key behavior in explicit remote mode", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ ...valid, conwayApiKey: null }));
    const config = await loadStartupConfig("remote");
    expect(config.inferenceMode).toBe("remote");
    expect(config.conwayApiKey).toBeNull();
    expectNoInitialization();
  });
  it.each([
    [123, "number"], [false, "boolean"], [[], "array"], [{}, "object"],
  ])("still rejects invalid Conway credential type %s (%s) in local mode", async (key) => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ ...valid, conwayApiKey: key }));
    await expect(loadStartupConfig("local")).rejects.toThrow(error);
    expectNoInitialization();
  });
  it.each(["openaiApiKey", "anthropicApiKey"])("does not allow null for other credentials: %s", async field => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ ...valid, [field]: null }));
    await expect(loadStartupConfig("local")).rejects.toThrow(error);
    expectNoInitialization();
  });
  it("environment local overrides remote in the file without rewriting it", async () => {
    vi.stubEnv("AUTOMATON_INFERENCE_MODE", "local");
    const config = await loadStartupConfig();
    expect(config.inferenceMode).toBe("local");
    expect(config.name).toBe("test");
    expectNoInitialization();
  });
  it("refuses missing configuration in explicit local mode", async () => {
    vi.spyOn(fs, "existsSync").mockReturnValue(false);
    await expect(loadStartupConfig("local")).rejects.toThrow(error);
    expectNoInitialization();
  });
  it("refuses unreadable configuration without leaking the underlying error", async () => {
    vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("EACCES private-secret-value"); });
    const result = loadStartupConfig("local");
    await expect(result).rejects.toThrow(error);
    await expect(result).rejects.not.toThrow(/private-secret-value/);
    expectNoInitialization();
  });
  it.each([
    ['{"private-secret-value":', "malformed JSON"],
    ["null", "null"],
    ["[]", "array"],
    ['"text"', "primitive"],
    ["{}", "missing required fields"],
    [JSON.stringify({ ...valid, name: 42 }), "invalid name"],
    [JSON.stringify({ ...valid, dbPath: null }), "invalid path"],
    [JSON.stringify({ ...valid, maxTokensPerTurn: "4096" }), "invalid numeric field"],
    [JSON.stringify({ ...valid, maxTurnsPerCycle: -1 }), "negative turn budget"],
    [JSON.stringify({ ...valid, modelStrategy: [] }), "invalid section"],
    [JSON.stringify({ ...valid, treasuryPolicy: { maxSingleTransferCents: "unlimited" } }), "invalid policy value"],
    [JSON.stringify({ ...valid, chainType: "unknown" }), "invalid chain"],
    [JSON.stringify({ ...valid, inferenceMode: "unknown" }), "invalid file mode"],
  ])("refuses %s (%s) before setup", async (contents) => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(contents);
    await expect(loadStartupConfig("local")).rejects.toThrow(error);
    expectNoInitialization();
  });
  it.each(["", "LOCAL", "typo"])("refuses invalid requested mode %s before file reads", async mode => {
    await expect(loadStartupConfig(mode)).rejects.toThrow(/Invalid AUTOMATON_INFERENCE_MODE/);
    expect(fs.existsSync).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expectNoInitialization();
  });
  it("also refuses an invalid configuration declaring local mode in the file", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ inferenceMode: "local" }));
    await expect(loadStartupConfig()).rejects.toThrow(error);
    expectNoInitialization();
  });
  it("preserves file local mode when no override is provided", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ ...valid, inferenceMode: "local" }));
    expect((await loadStartupConfig()).inferenceMode).toBe("local");
    expectNoInitialization();
  });
  it("explicit remote overrides file local mode", async () => {
    vi.spyOn(fs, "readFileSync").mockReturnValue(JSON.stringify({ ...valid, inferenceMode: "local" }));
    expect((await loadStartupConfig("remote")).inferenceMode).toBe("remote");
    expectNoInitialization();
  });
  it.each(["missing", "malformed"])("preserves remote first-run setup for %s configuration", async failure => {
    if (failure === "missing") vi.spyOn(fs, "existsSync").mockReturnValue(false);
    else vi.spyOn(fs, "readFileSync").mockReturnValue("{");
    vi.mocked(runSetupWizard).mockResolvedValue({ ...valid, inferenceMode: "local" } as any);
    const config = await loadStartupConfig("remote");
    expect(config.inferenceMode).toBe("remote");
    expect(runSetupWizard).toHaveBeenCalledTimes(1);
    expect(getWallet).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
  });
});
