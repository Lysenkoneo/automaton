import type { AutomatonConfig, FinancialState } from "../types.js";
import { isLocalInference } from "../inference/local-mode.js";
import { isSafeLocalTest } from "../inference/safe-local-test.js";

export function formatConwayCredits(config: AutomatonConfig, financial: FinancialState): string {
  return isLocalInference(config)
    ? "Conway balance not queried in local mode (local inference does not require Conway credits)"
    : `$${(financial.creditsCents / 100).toFixed(2)}`;
}

export const SAFE_LOCAL_TASK = `SAFE LOCAL TEST: Autonomously analyze only the available conversation, supplied context and available memory.
The installed wallet is unavailable; your identity has no signing capability.
Payments, signatures, blockchain transactions, workers, heartbeats and system commands are unavailable.
Do not check or fund Conway credits, delegate tasks, write files, or request unavailable tools.
Produce one brief, concrete textual report: observations supported by the available data, limitations, and a concrete plan if justified.
If there is no useful context or memory, explicitly report that no useful data is available. Do not invent observations or ask the user to assign you a task just to proceed.
Then call sleep. The bounded test runtime will terminate instead of waking indefinitely. Do not repeat maintenance checks or claim that planned actions were executed.`;

export function loopRecoveryInstruction(config: AutomatonConfig, ordinary: string): string {
  return isSafeLocalTest(config)
    ? "In this safe local test, produce a useful textual answer or concrete plan from the available context, then call sleep. If unable to progress, explain why and sleep. Do not repeat status checks or request unavailable actions."
    : ordinary;
}
