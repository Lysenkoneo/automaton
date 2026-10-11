import type { AutomatonConfig, AutomatonTool } from "../types.js";
import type { PrivateKeyAccount } from "viem";
import type { ChainIdentity } from "../identity/chain.js";

export function assertSafeLocalEnvironment(mode = process.env.AUTOMATON_INFERENCE_MODE): boolean {
  const flag = process.env.AUTOMATON_SAFE_LOCAL_TEST;
  if (flag !== undefined && flag !== "0" && flag !== "1") throw new Error("AUTOMATON_SAFE_LOCAL_TEST must be 0 or 1");
  if (flag === "1" && (mode !== "local" || process.env.AUTOMATON_INFERENCE_MODE !== "local")) throw new Error("Safe local test requires AUTOMATON_INFERENCE_MODE=local");
  return flag === "1";
}

export function assertSafeLocalCommand(args: string[]): void {
  if (assertSafeLocalEnvironment() && (args.length !== 1 || args[0] !== "--run")) {
    throw new Error("Safe local test permits only --run; administrative commands are disabled");
  }
}

export function isSafeLocalTest(config: Pick<AutomatonConfig, "inferenceMode" | "safeLocalTest">): boolean {
  const enabled = assertSafeLocalEnvironment() || config.safeLocalTest === true;
  if (enabled && config.inferenceMode !== "local") throw new Error("Safe local test requires strict local inference");
  return enabled;
}

const LOCAL_BLOCKED = new Set(["topup_credits", "transfer_credits", "fund_child", "spawn_child", "x402_fetch", "register_erc8004", "give_feedback"]);
// Fail closed: new tools are not automatically available in the controlled test.
const SAFE_TOOLS = new Set(["sleep", "check_reputation", "check_inference_spending", "recall_facts", "recall_procedure", "review_memory", "list_goals", "get_plan", "orchestrator_status"]);
export function isToolAllowed(config: AutomatonConfig, tool: Pick<AutomatonTool, "name" | "category">): boolean {
  if (isSafeLocalTest(config)) return SAFE_TOOLS.has(tool.name);
  return config.inferenceMode !== "local" || (tool.category !== "conway" && !LOCAL_BLOCKED.has(tool.name));
}

/** No wallet file, generated key, or signing capability. */
export function createSafeTestIdentity() {
  const address = "0x0000000000000000000000000000000000000000" as const;
  const refuse = async (): Promise<never> => { throw new Error("Signing is forbidden in safe local test mode"); };
  const account = { address, publicKey: "0x", source: "custom", type: "local", sign: refuse, signMessage: refuse, signTypedData: refuse, signTransaction: refuse } as unknown as PrivateKeyAccount;
  const chainIdentity: ChainIdentity = { address, chainType: "evm", signMessage: refuse };
  return { account, chainIdentity, chainType: "evm" as const, isNew: false };
}

export function prepareSafeTestConfig(config: AutomatonConfig): AutomatonConfig {
  if (!isSafeLocalTest(config)) return config;
  return { ...config, safeLocalTest: true, dbPath: ":memory:", socialRelayUrl: undefined, chainType: "evm" };
}
