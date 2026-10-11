import { afterEach, describe, expect, it, vi } from "vitest";
import { assertLocalOllamaAvailable, assertLocalOllamaUrl, isLocalInference, restrictConwayClient, LOCAL_MODEL } from "../inference/local-mode.js";
import { bootstrapInferenceCredits } from "../conway/bootstrap.js";
import { bootstrapTopup } from "../conway/topup.js";
import { createInferenceClient } from "../conway/inference.js";
import { executeTool } from "../agent/tools.js";
import { BUILTIN_TASKS } from "../heartbeat/tasks.js";
import { buildTickContext } from "../heartbeat/tick-context.js";
import { createTestConfig, createTestDb, createTestIdentity, MockConwayClient, MockInferenceClient } from "./mocks.js";

vi.mock("../conway/topup.js", () => ({ bootstrapTopup: vi.fn().mockResolvedValue(null) }));

const baseOptions = { apiUrl: "https://api.conway.tech", apiKey: "mock-key", defaultModel: "gpt-5.2", maxTokens: 100 };
const completion = () => new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }), { status: 200 });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("explicit inference mode", () => {
  it("remote overrides the presence of a loopback Ollama URL", () => {
    expect(isLocalInference({ inferenceMode: "remote", ollamaBaseUrl: "http://localhost:11434" })).toBe(false);
    expect(isLocalInference({ inferenceMode: "local" })).toBe(true);
  });
  it.each(["http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434"])("accepts local origin %s", url => {
    expect(() => assertLocalOllamaUrl(url)).not.toThrow();
  });
  it.each(["https://api.example.com", "http://localhost:11434/v1", "http://user:secret@localhost:11434", "file:///tmp/model"])("rejects nonlocal or ambiguous origin %s", url => {
    expect(() => assertLocalOllamaUrl(url)).toThrow(/loopback/);
  });
  it("verifies the exact required model and refuses redirects", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ models: [{ name: LOCAL_MODEL }] })));
    vi.stubGlobal("fetch", fetch);
    await assertLocalOllamaAvailable("http://localhost:11434");
    expect(fetch).toHaveBeenCalledWith("http://localhost:11434/api/tags", expect.objectContaining({ redirect: "error" }));
  });
  it.each(["network", "missing", "http", "malformed"])("fails explicitly on %s without any other request", async failure => {
    const fetch = vi.fn();
    if (failure === "network") fetch.mockRejectedValue(new Error("ECONNREFUSED"));
    else if (failure === "http") fetch.mockResolvedValue(new Response("failed", { status: 503 }));
    else fetch.mockResolvedValue(new Response(JSON.stringify(failure === "missing" ? { models: [{ name: "other" }] } : {})));
    vi.stubGlobal("fetch", fetch);
    await expect(assertLocalOllamaAvailable("http://localhost:11434")).rejects.toThrow(/Strict local Ollama.*unavailable/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("strict inference client", () => {
  it("always sends Qwen to Ollama despite external keys, model overrides and low compute", async () => {
    const fetch = vi.fn().mockImplementation(completion);
    vi.stubGlobal("fetch", fetch);
    const client = createInferenceClient({ ...baseOptions, localOnly: true, ollamaBaseUrl: "http://localhost:11434", openaiApiKey: "mock-openai", anthropicApiKey: "mock-anthropic", getModelProvider: () => "openai" });
    client.setLowComputeMode(true);
    await client.chat([{ role: "user", content: "hello" }], { model: "gpt-5.2" });
    expect(client.getDefaultModel()).toBe(LOCAL_MODEL);
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect(JSON.parse(init.body).model).toBe(LOCAL_MODEL);
    expect(init.redirect).toBe("error");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("reports a failed request without external fallback", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("model failed", { status: 400 }));
    vi.stubGlobal("fetch", fetch);
    const client = createInferenceClient({ ...baseOptions, localOnly: true, ollamaBaseUrl: "http://localhost:11434", openaiApiKey: "mock-openai" });
    await expect(client.chat([{ role: "user", content: "hello" }])).rejects.toThrow(/Strict local Ollama.*request failed.*400/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("preserves Conway inference outside strict mode", async () => {
    const fetch = vi.fn().mockImplementation(completion);
    vi.stubGlobal("fetch", fetch);
    const client = createInferenceClient(baseOptions);
    await client.chat([{ role: "user", content: "hello" }]);
    expect(fetch.mock.calls[0][0]).toBe("https://api.conway.tech/v1/chat/completions");
    expect(JSON.parse(fetch.mock.calls[0][1].body).model).toBe("gpt-5.2");
  });
});

describe("strict funding protection", () => {
  it("blocks Conway calls at the client boundary and preserves the remote client", async () => {
    const conway = new MockConwayClient();
    const transfer = vi.spyOn(conway, "transferCredits");
    const exec = vi.spyOn(conway, "exec");
    const restricted = restrictConwayClient(conway, { inferenceMode: "local" });
    await expect(restricted.transferCredits("mock-recipient", 5, "test")).rejects.toThrow(/forbidden/);
    await expect(restricted.exec("echo hello")).rejects.toThrow(/forbidden/);
    expect(transfer).not.toHaveBeenCalled(); expect(exec).not.toHaveBeenCalled();
    expect(restrictConwayClient(conway, { inferenceMode: "remote" })).toBe(conway);
  });

  it.each(["local", "remote"] as const)("startup credits respect explicit %s mode", async inferenceMode => {
    vi.mocked(bootstrapTopup).mockClear();
    const conway = new MockConwayClient();
    const credits = vi.spyOn(conway, "getCreditsBalance");
    await bootstrapInferenceCredits({ ...createTestConfig(), inferenceMode }, conway, createTestIdentity().account, "evm");
    expect(credits).toHaveBeenCalledTimes(inferenceMode === "local" ? 0 : 1);
    expect(bootstrapTopup).toHaveBeenCalledTimes(inferenceMode === "local" ? 0 : 1);
  });

  it.each(["topup_credits", "transfer_credits", "fund_child", "spawn_child", "x402_fetch"])("blocks %s before executing its implementation", async name => {
    const db = createTestDb();
    try {
      const execute = vi.fn();
      const ctx = { config: { ...createTestConfig(), inferenceMode: "local" as const }, identity: createTestIdentity(), db, conway: new MockConwayClient(), inference: new MockInferenceClient() };
      const result = await executeTool(name, {}, [{ name, execute } as any], ctx);
      expect(result.error).toMatch(/forbidden.*strict local/);
      expect(execute).not.toHaveBeenCalled();
    } finally { db.close(); }
  });
  it("heartbeat neither queries Conway nor buys credits even with a funded balance", async () => {
    const db = createTestDb();
    try {
      const conway = new MockConwayClient();
      const credits = vi.spyOn(conway, "getCreditsBalance");
      const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
      const config = { ...createTestConfig(), inferenceMode: "local" as const };
      const ctx = await buildTickContext(db.raw, conway, { entries: [], defaultIntervalMs: 60000 }, createTestIdentity().address, "evm", undefined, "local");
      await BUILTIN_TASKS.check_usdc_balance({ ...ctx, creditBalance: 0, usdcBalance: 100 }, { config, identity: createTestIdentity(), db, conway });
      expect(credits).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
      expect(db.getKV("last_auto_topup_attempt")).toBeUndefined();
    } finally { db.close(); }
  });
});
