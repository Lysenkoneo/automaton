import type { AutomatonConfig, ConwayClient } from "../types.js";

export const LOCAL_MODEL = "qwen2.5:7b";
export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export function isStrictLocal(config: Pick<AutomatonConfig, "inferenceMode">): boolean {
  if (config.inferenceMode !== undefined && !["local", "remote"].includes(config.inferenceMode)) {
    throw new Error("Invalid inferenceMode: expected local or remote");
  }
  return config.inferenceMode === "local";
}

export function isLocalInference(config: Pick<AutomatonConfig, "inferenceMode" | "ollamaBaseUrl">): boolean {
  if (config.inferenceMode === "remote") return false;
  if (isStrictLocal(config)) return true;
  return !!config.ollamaBaseUrl && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:\/|$)/i.test(config.ollamaBaseUrl);
}

/** Read-only preflight: no model download, provisioning or external fallback. */
export function assertLocalOllamaUrl(baseUrl: string): void {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname.toLowerCase()) ||
      url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error("Strict local mode requires an Ollama loopback origin URL");
  }
}

export async function assertLocalOllamaAvailable(baseUrl: string): Promise<void> {
  assertLocalOllamaUrl(baseUrl);
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/api/tags`, {
      signal: AbortSignal.timeout(5_000), redirect: "error",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { models?: { name?: string; model?: string }[] };
    if (!Array.isArray(data.models) || !data.models.some(m => (m.name || m.model) === LOCAL_MODEL)) {
      throw new Error(`Required model ${LOCAL_MODEL} is absent`);
    }
  } catch (error) {
    throw new Error(`Strict local Ollama (${LOCAL_MODEL}) unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Prevent even fallback-first tool implementations from contacting Conway. */
export function restrictConwayClient(client: ConwayClient, config: Pick<AutomatonConfig, "inferenceMode">): ConwayClient {
  if (!isStrictLocal(config)) return client;
  return new Proxy(client, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      return async () => { throw new Error(`Conway ${String(property)} is forbidden in strict local mode`); };
    },
  });
}
