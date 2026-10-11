import type { PrivateKeyAccount } from "viem";
import type { AutomatonConfig, ConwayClient } from "../types.js";
import type { ChainType } from "../identity/chain.js";
import { isStrictLocal } from "../inference/local-mode.js";
import { bootstrapTopup } from "./topup.js";
import { createLogger } from "../observability/logger.js";

const logger = createLogger("bootstrap");

export async function bootstrapInferenceCredits(config: AutomatonConfig, conway: ConwayClient, account: PrivateKeyAccount, resolvedChainType: ChainType): Promise<void> {
  if (isStrictLocal(config)) return;
  // Bootstrap topup: buy minimum credits ($5) from USDC so the agent can start.
  // The agent decides larger topups itself via the topup_credits tool.
  try {
    let bootstrapTimer: ReturnType<typeof setTimeout>;
    const bootstrapTimeout = new Promise<null>((_, reject) => {
      bootstrapTimer = setTimeout(() => reject(new Error("bootstrap topup timed out")), 15_000);
    });
    try {
      await Promise.race([
        (async () => {
          const creditsCents = await conway.getCreditsBalance().catch(() => 0);
          const topupResult = await bootstrapTopup({
            apiUrl: config.conwayApiUrl,
            account,
            creditsCents,
            chainType: resolvedChainType,
          });
          if (topupResult?.success) {
            logger.info(
              `[${new Date().toISOString()}] Bootstrap topup: +$${topupResult.amountUsd} credits from USDC`,
            );
          }
        })(),
        bootstrapTimeout,
      ]);
    } finally {
      clearTimeout(bootstrapTimer!);
    }
  } catch (err: any) {
    logger.warn(`[${new Date().toISOString()}] Bootstrap topup skipped: ${err.message}`);
  }

}
