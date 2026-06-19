import { CONFIG } from './config.js';
import { currentV2PriceHuman } from './analyze.js';
import { fetchV3RefPriceHuman } from './refprice.js';
import type { Reversion } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const gapBps = (v2: number, ref: number) => (ref > 0 ? Math.abs(v2 - ref) / ref * 10_000 : 0);

/**
 * Poll the thin V2 pool's price against the live V3 reference until the gap our
 * swap opened has been arbed back under `revertThresholdBps`, or we time out.
 * The elapsed time is effectively the backrun latency for this pool.
 */
export async function waitForReversion(): Promise<Reversion> {
  const start = Date.now();
  const ref0 = await fetchV3RefPriceHuman();
  const v2_0 = await currentV2PriceHuman();
  if (ref0 === null) return { reverted: false, elapsedMs: 0, startGapBps: 0, endGapBps: 0 };
  const startGapBps = gapBps(v2_0, ref0);
  let endGapBps = startGapBps;

  while (Date.now() - start < CONFIG.revertTimeoutMs) {
    const [v2, ref] = await Promise.all([currentV2PriceHuman(), fetchV3RefPriceHuman()]);
    endGapBps = gapBps(v2, ref ?? ref0);
    if (endGapBps <= CONFIG.revertThresholdBps) {
      return { reverted: true, elapsedMs: Date.now() - start, startGapBps, endGapBps };
    }
    await sleep(CONFIG.revertPollMs);
  }
  return { reverted: false, elapsedMs: Date.now() - start, startGapBps, endGapBps };
}
