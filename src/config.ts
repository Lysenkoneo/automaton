/**
 * Automaton Configuration
 *
 * Loads and saves the automaton's configuration from ~/.automaton/automaton.json
 */

import { assertSafeLocalEnvironment } from "./inference/safe-local-test.js";
import fs from "fs";
import path from "path";
import type { AutomatonConfig, TreasuryPolicy, ModelStrategyConfig, SoulConfig } from "./types.js";
import { DEFAULT_CONFIG, DEFAULT_TREASURY_POLICY, DEFAULT_MODEL_STRATEGY_CONFIG, DEFAULT_SOUL_CONFIG } from "./types.js";
import { getAutomatonDir } from "./identity/wallet.js";
import { loadApiKeyFromConfig } from "./identity/provision.js";
import { createLogger } from "./observability/logger.js";
import type { ChainType } from "./identity/chain.js";

const logger = createLogger("config");
const CONFIG_FILENAME = "automaton.json";

export function getConfigPath(): string {
  return path.join(getAutomatonDir(), CONFIG_FILENAME);
}

/**
 * Load the automaton config from disk.
 * Merges with defaults for any missing fields.
 */
export function loadConfig(options: { inferenceMode?: "local" | "remote" } = {}): AutomatonConfig | null {
  let strictLocal = options.inferenceMode === "local";
  const configPath = getConfigPath();
  try {
    if (!fs.existsSync(configPath)) {
      if (strictLocal) throw new Error("Configuration file is missing");
      return null;
    }
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Configuration must be a JSON object");
    }
    strictLocal = (options.inferenceMode ?? raw.inferenceMode) === "local";
    if (strictLocal) validateLocalConfig(raw);
    const apiKey = raw.conwayApiKey || loadApiKeyFromConfig();

    // Deep-merge treasury policy with defaults
    const treasuryPolicy: TreasuryPolicy = {
      ...DEFAULT_TREASURY_POLICY,
      ...(raw.treasuryPolicy ?? {}),
    };

    // Validate all treasury values are positive numbers
    for (const [key, value] of Object.entries(treasuryPolicy)) {
      if (key === "x402AllowedDomains") continue; // array, not number
      if (typeof value === "number" && (value < 0 || !Number.isFinite(value))) {
        logger.warn(`Invalid treasury value for ${key}: ${value}, using default`);
        (treasuryPolicy as any)[key] = (DEFAULT_TREASURY_POLICY as any)[key];
      }
    }

    // Deep-merge model strategy config with defaults
    const modelStrategy: ModelStrategyConfig = {
      ...DEFAULT_MODEL_STRATEGY_CONFIG,
      ...(raw.modelStrategy ?? {}),
    };

    // Deep-merge soul config with defaults
    const soulConfig: SoulConfig = {
      ...DEFAULT_SOUL_CONFIG,
      ...(raw.soulConfig ?? {}),
    };

    return {
      ...DEFAULT_CONFIG,
      ...raw,
      ...(options.inferenceMode ? { inferenceMode: options.inferenceMode } : {}),
      sandboxId:
        typeof raw.sandboxId === "string"
          ? raw.sandboxId.trim()
          : DEFAULT_CONFIG.sandboxId,
      conwayApiKey: apiKey,
      treasuryPolicy,
      modelStrategy,
      soulConfig,
      chainType: raw.chainType || "evm",
    } as AutomatonConfig;
  } catch {
    if (strictLocal) {
      // Never include file contents, parser excerpts, or credential values.
      throw new Error("Strict local startup refused: configuration is missing, unreadable or invalid; setup wizard is disabled");
    }
    return null;
  }
}

/** Minimum shape and runtime field types needed for safe local initialization. */
function validateLocalConfig(raw: Record<string, unknown>): void {
  for (const field of ["name", "genesisPrompt", "creatorAddress"]) {
    if (typeof raw[field] !== "string" || !(raw[field] as string).trim()) throw new Error("Invalid required field");
  }
  for (const field of ["dbPath", "heartbeatConfigPath", "skillsDir", "ollamaBaseUrl", "inferenceModel", "conwayApiUrl", "creatorAddress", "walletAddress", "chainType", "logLevel"]) {
    if (raw[field] !== undefined && (typeof raw[field] !== "string" || !(raw[field] as string).trim())) throw new Error("Invalid configuration field");
  }
  for (const field of ["maxTokensPerTurn", "maxTurnsPerCycle", "maxChildren", "childSandboxMemoryMb"]) {
    const value = raw[field];
    if (value !== undefined && (typeof value !== "number" || !Number.isInteger(value) || value < (field === "maxChildren" ? 0 : 1))) throw new Error("Invalid numeric configuration field");
  }
  for (const field of ["modelStrategy", "treasuryPolicy", "soulConfig"]) {
    const value = raw[field];
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) throw new Error("Invalid configuration section");
  }
  for (const field of ["conwayApiKey", "openaiApiKey", "anthropicApiKey", "sandboxId", "creatorMessage", "parentAddress", "socialRelayUrl", "rpcUrl"]) {
    // This validator runs only in strict local mode, where Conway credentials are optional.
    if (field === "conwayApiKey" && raw[field] === null) continue;
    if (raw[field] !== undefined && typeof raw[field] !== "string") throw new Error("Invalid configuration field");
  }
  if (raw.registeredWithConway !== undefined && typeof raw.registeredWithConway !== "boolean") throw new Error("Invalid registration flag");
  if (raw.inferenceMode !== undefined && raw.inferenceMode !== "local" && raw.inferenceMode !== "remote") throw new Error("Invalid inference mode");
  for (const [section, defaults] of [["modelStrategy", DEFAULT_MODEL_STRATEGY_CONFIG], ["treasuryPolicy", DEFAULT_TREASURY_POLICY], ["soulConfig", DEFAULT_SOUL_CONFIG]] as const) {
    const values = raw[section] as Record<string, unknown> | undefined;
    if (!values) continue;
    const knownDefaults = new Map<string, unknown>(Object.entries(defaults));
    for (const [key, value] of Object.entries(values)) {
      const expected = knownDefaults.get(key);
      if (expected === undefined) continue;
      if (Array.isArray(expected)) {
        if (!Array.isArray(value) || value.some(item => typeof item !== "string")) throw new Error("Invalid configuration list");
      } else if (typeof value !== typeof expected || (typeof value === "number" && (!Number.isFinite(value) || value < 0))) {
        throw new Error("Invalid configuration section value");
      }
    }
  }
  if (raw.chainType !== undefined && raw.chainType !== "evm" && raw.chainType !== "solana") throw new Error("Invalid chain type");
  if (raw.logLevel !== undefined && !["debug", "info", "warn", "error"].includes(raw.logLevel as string)) throw new Error("Invalid log level");
}

/** Resolve an explicit mode before any first-run setup, without changing installed config. */
export async function loadStartupConfig(requestedMode: string | undefined = process.env.AUTOMATON_INFERENCE_MODE): Promise<AutomatonConfig> {
  const safeLocalTest = assertSafeLocalEnvironment(requestedMode);
  if (requestedMode !== undefined && requestedMode !== "local" && requestedMode !== "remote") {
    throw new Error("Invalid AUTOMATON_INFERENCE_MODE: expected local or remote");
  }
  const inferenceMode = requestedMode as "local" | "remote" | undefined;
  const config = loadConfig({ inferenceMode });
  if (config) return { ...config, safeLocalTest };
  // loadConfig throws instead of returning null when local is explicitly requested.
  const { runSetupWizard } = await import("./setup/wizard.js");
  const created = await runSetupWizard();
  return inferenceMode ? { ...created, inferenceMode } : created;
}

/**
 * Save the automaton config to disk.
 * Includes treasuryPolicy in the persisted config.
 */
export function saveConfig(config: AutomatonConfig): void {
  const dir = getAutomatonDir();
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  const configPath = getConfigPath();
  const toSave = {
    ...config,
    treasuryPolicy: config.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    modelStrategy: config.modelStrategy ?? DEFAULT_MODEL_STRATEGY_CONFIG,
    soulConfig: config.soulConfig ?? DEFAULT_SOUL_CONFIG,
  };
  fs.writeFileSync(configPath, JSON.stringify(toSave, null, 2), {
    mode: 0o600,
  });
}

/**
 * Resolve ~ paths to absolute paths.
 */
export function resolvePath(p: string): string {
  if (p.startsWith("~")) {
    return path.join(process.env.HOME || "/root", p.slice(1));
  }
  return p;
}

/**
 * Create a fresh config from setup wizard inputs.
 */
export function createConfig(params: {
  name: string;
  genesisPrompt: string;
  creatorMessage?: string;
  creatorAddress: string;
  registeredWithConway: boolean;
  sandboxId: string;
  walletAddress: string;
  apiKey: string;
  openaiApiKey?: string;
  anthropicApiKey?: string;
  ollamaBaseUrl?: string;
  parentAddress?: string;
  treasuryPolicy?: TreasuryPolicy;
  chainType?: ChainType;
}): AutomatonConfig {
  const normalizedSandboxId = (params.sandboxId || "").trim();
  return {
    name: params.name,
    genesisPrompt: params.genesisPrompt,
    creatorMessage: params.creatorMessage,
    creatorAddress: params.creatorAddress,
    registeredWithConway: params.registeredWithConway,
    sandboxId: normalizedSandboxId,
    conwayApiUrl:
      DEFAULT_CONFIG.conwayApiUrl || "https://api.conway.tech",
    conwayApiKey: params.apiKey,
    openaiApiKey: params.openaiApiKey,
    anthropicApiKey: params.anthropicApiKey,
    ollamaBaseUrl: params.ollamaBaseUrl,
    inferenceModel: DEFAULT_CONFIG.inferenceModel || "gpt-5.2",
    maxTokensPerTurn: DEFAULT_CONFIG.maxTokensPerTurn || 4096,
    heartbeatConfigPath:
      DEFAULT_CONFIG.heartbeatConfigPath || "~/.automaton/heartbeat.yml",
    dbPath: DEFAULT_CONFIG.dbPath || "~/.automaton/state.db",
    logLevel: (DEFAULT_CONFIG.logLevel as AutomatonConfig["logLevel"]) || "info",
    walletAddress: params.walletAddress,
    version: DEFAULT_CONFIG.version || "0.2.1",
    skillsDir: DEFAULT_CONFIG.skillsDir || "~/.automaton/skills",
    maxChildren: DEFAULT_CONFIG.maxChildren || 3,
    parentAddress: params.parentAddress,
    treasuryPolicy: params.treasuryPolicy ?? DEFAULT_TREASURY_POLICY,
    chainType: params.chainType || "evm",
  };
}
