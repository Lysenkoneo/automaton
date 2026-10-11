import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildSystemPrompt, buildWakeupPrompt } from "../agent/system-prompt.js";
import { formatConwayCredits, loopRecoveryInstruction } from "../agent/local-test-prompt.js";
import { createBuiltinTools, toolsToInferenceFormat } from "../agent/tools.js";
import { createDatabase } from "../state/database.js";
import { createTestConfig, createTestIdentity } from "./mocks.js";
import { saveProcedure } from "../memory/tools.js";
import { createInferenceClient } from "../conway/inference.js";

let db: ReturnType<typeof createDatabase>;
const financial = { creditsCents: -1, usdcBalance: 0, lastChecked: "2026-01-01T00:00:00Z" };
const safe = () => createTestConfig({ inferenceMode: "local", safeLocalTest: true });
beforeEach(() => {
  vi.stubEnv("AUTOMATON_SAFE_LOCAL_TEST", undefined);
  vi.stubEnv("AUTOMATON_INFERENCE_MODE", undefined);
  db = createDatabase(":memory:");
  // Never read installed configuration, constitution, SOUL or WORKLOG in these tests.
  vi.spyOn(fs, "existsSync").mockReturnValue(false);
  vi.spyOn(fs, "readFileSync").mockImplementation(() => { throw new Error("Unexpected disk read"); });
});
afterEach(() => { db.close(); vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });
function system(config = safe(), state = financial) {
  return buildSystemPrompt({ identity: createTestIdentity(), config, financial: state, state: "running", db, tools: createBuiltinTools(""), isFirstRun: true });
}

describe("local test prompt coherence", () => {
  it("labels local credits as unqueried instead of formatting the sentinel as money", () => {
    expect(formatConwayCredits(safe(), financial)).toMatch(/Conway balance not queried/);
    expect(formatConwayCredits(safe(), financial)).not.toContain("$-0.01");
  });
  it("does not classify strict local sentinel as dead even without the safe flag", () => {
    const prompt = system(createTestConfig({ inferenceMode: "local" }));
    expect(prompt).toContain("Credits: Conway balance not queried");
    expect(prompt).toContain("Survival tier: normal");
    expect(prompt).not.toContain("$-0.01");
  });
  it("provides a feasible textual task and explicitly describes unavailable capabilities", () => {
    const prompt = system();
    expect(prompt).toContain("SAFE LOCAL TEST");
    expect(prompt).toContain("concrete plan");
    expect(prompt).toContain("Then call sleep");
    expect(prompt).toContain("Payments, signatures, blockchain transactions, workers, heartbeats and system commands are unavailable");
    expect(prompt).toContain("installed wallet is unavailable");
    expect(prompt).toContain("Inference model: qwen2.5:7b");
    expect(prompt).not.toContain("Pay for compute or die");
    expect(prompt).not.toContain("MUST call create_goal");
    expect(prompt).not.toContain("UPDATE THIS");
    expect(prompt).not.toContain("Survival tier: dead");
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });
  it("safe wakeup asks for text then sleep rather than financial maintenance", () => {
    const prompt = buildWakeupPrompt({ identity: createTestIdentity(), config: safe(), financial, db });
    expect(prompt).toContain("Conway balance was not queried");
    expect(prompt).toContain("Then call sleep");
    expect(prompt).not.toContain("Review your financial situation");
    expect(prompt).not.toContain("Set up your heartbeat");
    expect(prompt).not.toContain("$-0.01");
  });
  it("ordinary local wakeup also avoids sentinel money formatting", () => {
    const prompt = buildWakeupPrompt({ identity: createTestIdentity(), config: createTestConfig({ inferenceMode: "local" }), financial, db });
    expect(prompt).toContain("Conway balance not queried");
    expect(prompt).not.toContain("$-0.01");
  });
  it("preserves remote credit formatting, survival and historical operational instructions", () => {
    const config = createTestConfig({ inferenceMode: "remote" });
    const state = { ...financial, creditsCents: 1000 };
    const prompt = system(config, state);
    expect(formatConwayCredits(config, state)).toBe("$10.00");
    expect(prompt).toContain("Credits: $10.00");
    expect(prompt).toContain("Survival tier: normal");
    expect(prompt).toContain("Pay for compute or die");
    expect(prompt).toContain("MUST call create_goal");
    expect(prompt).not.toContain("SAFE LOCAL TEST");
    expect(system(config)).toContain("Credits: $-0.01");
    expect(system(config)).toContain("Survival tier: dead");
    const wakeup = buildWakeupPrompt({ identity: createTestIdentity(), config, financial: state, db });
    expect(wakeup).toContain("You have $10.00 in compute credits");
    expect(wakeup).toContain("Review your financial situation");
    expect(wakeup).toContain("Set up your heartbeat schedule");
  });
  it.each(["repetition", "maintenance", "enforcement"])("safe %s recovery only requests useful text or sleep", kind => {
    const remoteInstruction = kind === "maintenance" ? "Write code, create a file, register a service, or build something new." : "Pick ONE concrete task from your genesis prompt and execute it.";
    const text = loopRecoveryInstruction(safe(), remoteInstruction);
    expect(text).toContain("textual answer or concrete plan"); expect(text).toContain("sleep");
    expect(text).not.toContain("Write code"); expect(text).not.toContain("register a service");
    expect(loopRecoveryInstruction(createTestConfig({ inferenceMode: "remote" }), remoteInstruction)).toBe(remoteInstruction);
  });
});

describe("recall_procedure contract", () => {
  const tool = () => createBuiltinTools("").find(tool => tool.name === "recall_procedure")!;
  it("preserves historical procedure names with surrounding spaces", async () => {
    saveProcedure(db.raw, { name: " prepare-plan ", description: "historical", steps: [] });
    expect(await tool().execute({ name: " prepare-plan " }, { config: safe(), db } as any)).toContain("historical");
    expect(await tool().execute({ name: "prepare-plan" }, { config: safe(), db } as any)).toContain("Procedure not found");
  });
  it.each([{}, { name: "" }, { query: "" }, { name: " ", query: "\t" }])("rejects missing or blank search arguments: %j", async args => {
    expect(await tool().execute(args, { config: safe(), db } as any)).toBe("Please provide a name or query to search.");
  });
  it.each([{ name: "prepare-plan" }, { query: "prepare" }])("retrieves stored procedures using %j", async args => {
    saveProcedure(db.raw, { name: "prepare-plan", description: "prepare a text plan", steps: JSON.stringify([{ order: 1, description: "Analyze context", tool: null, argsTemplate: null, expectedOutcome: null, onFailure: null }]) });
    expect(await tool().execute(args, { config: safe(), db } as any)).toContain("prepare-plan");
  });
  it("declares at least one nonempty argument and forwards its schema unchanged to mocked Ollama", async () => {
    const schema = tool().parameters as any;
    expect(schema.anyOf).toEqual([{ required: ["name"] }, { required: ["query"] }]);
    for (const key of ["name", "query"]) {
      expect(schema.properties[key].minLength).toBe(1);
      expect(new RegExp(schema.properties[key].pattern).test("   ")).toBe(false);
    }
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "mock" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })));
    vi.stubGlobal("fetch", fetch);
    const client = createInferenceClient({ apiUrl: "https://unused.invalid", apiKey: "", defaultModel: "qwen2.5:7b", maxTokens: 100, localOnly: true, ollamaBaseUrl: "http://localhost:11434" });
    await client.chat([{ role: "user", content: "simulated request" }], { tools: toolsToInferenceFormat([tool()]) });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.tools[0].function.parameters).toEqual(schema);
    expect(body.model).toBe("qwen2.5:7b");
    expect(String(fetch.mock.calls[0][0])).toContain("localhost:11434");
  });
});
