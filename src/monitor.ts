import type { Hex } from 'viem';
import { publicClient, wsClient } from './clients.js';

export interface MempoolWatch {
  /** hash -> local ms timestamp it was first seen in the PUBLIC pending pool. */
  firstSeen: Map<Hex, number>;
  stop: () => void;
}

/**
 * Watch the public pending-tx pool for the given hashes. Records the first time
 * each is observed. For the public-route tx this is the propagation/leak time;
 * for the blink-route tx, ANY observation means the private tx leaked into the
 * public mempool (a key thing we want to detect).
 *
 * No-op (empty map) if no WS endpoint is configured or the node rejects the
 * newPendingTransactions subscription.
 */
export function startMempoolWatch(hashes: Hex[]): MempoolWatch {
  const firstSeen = new Map<Hex, number>();
  const tracked = new Set(hashes.map((h) => h.toLowerCase()));
  if (!wsClient || tracked.size === 0) {
    return { firstSeen, stop: () => {} };
  }
  let unwatch: (() => void) | undefined;
  try {
    unwatch = wsClient.watchPendingTransactions({
      onTransactions: (incoming) => {
        const now = Date.now();
        for (const h of incoming) {
          const key = h.toLowerCase();
          if (tracked.has(key) && !firstSeen.has(h as Hex)) firstSeen.set(h as Hex, now);
        }
      },
      onError: (e) => console.warn(`[mempool] subscription error: ${e.message}`),
    });
  } catch (e) {
    console.warn(`[mempool] could not subscribe to pending txs: ${(e as Error).message}`);
  }
  return { firstSeen, stop: () => unwatch?.() };
}

export interface InclusionReceipt {
  blockNumber: bigint;
  blockTimestamp: number;
  observedAtMs: number; // local wall-clock when the receipt was first observed
  txIndex: number;
  status: 'success' | 'reverted';
}

/** Wait for a tx to be mined, returning inclusion details or null on timeout. */
export async function waitForInclusion(hash: Hex, timeoutMs: number): Promise<InclusionReceipt | null> {
  try {
    // Tight polling so the observed time approximates true inclusion latency.
    const receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: timeoutMs, pollingInterval: 250 });
    const observedAtMs = Date.now(); // capture before the extra getBlock round-trip
    const block = await publicClient.getBlock({ blockNumber: receipt.blockNumber });
    return {
      blockNumber: receipt.blockNumber,
      blockTimestamp: Number(block.timestamp),
      observedAtMs,
      txIndex: receipt.transactionIndex,
      status: receipt.status,
    };
  } catch {
    return null;
  }
}
