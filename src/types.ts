import type { Address, Hex } from 'viem';

export type Route = 'public' | 'blink';

/** A signed, ready-to-broadcast swap from one wallet. */
export interface SignedSwap {
  route: Route;
  from: Address;
  to: Address;
  hash: Hex;            // tx hash, derived from the signed payload before sending
  serialized: Hex;      // raw signed tx for eth_sendRawTransaction
  nonce: number;
  amountIn: bigint;
  amountOutMin: bigint;
  quotedOut: bigint;    // getAmountsOut quote at build time
  gasPrice: bigint;
}

/** Result of broadcasting one swap. */
export interface Submission {
  route: Route;
  hash: Hex;
  submittedAtMs: number;       // local high-res submit time
  accepted: boolean;
  error?: string;
  mempoolFirstSeenMs?: number; // when first seen in the PUBLIC mempool (leak signal)
}

/** A decoded pool swap (from a Pair `Swap` event) used for run analysis. */
export interface PoolSwap {
  txHash: Hex;
  logIndex: number;
  to: Address;
  baseIn: boolean;       // true = this swap sold TOKEN_IN into the pool (same direction as ours)
  amountInRaw: bigint;
  amountOutRaw: bigint;
}

export interface InclusionMetrics {
  included: boolean;
  blockNumber?: bigint;
  blockTimestamp?: number;
  txIndex?: number;            // position within the block
  blocksWaited?: number;       // inclusionBlock - submitBlock
  inclusionLatencyMs?: number; // wall-clock ms: receipt-observed time − submittedAtMs (blocksWaited is the primary metric)
  realizedOut?: bigint;        // actual TOKEN_OUT received
  slippageVsQuoteBps?: number; // (quotedOut - realizedOut) / quotedOut
}

export interface RunFindings {
  frontrun: { detected: boolean; byTx?: Hex; byAddress?: Address };
  backrun: { detected: boolean; byTx?: Hex; byAddress?: Address };
  sandwich: { detected: boolean; byAddress?: Address };
  // Theoretical backrun opportunity our swap created, in TOKEN_OUT units.
  backrunOpportunityOut: bigint;
  priceImpactBps: number;
  // Reference price used (TOKEN_OUT per 1 TOKEN_IN): from V3 auto-fetch or REF_PRICE; undefined = V2 pre-trade mid.
  refPrice?: number;
  // Whether the tx leaked into the public mempool before inclusion.
  leakedToPublicMempool?: boolean;
}

export interface RouteResult {
  route: Route;
  submission: Submission;
  inclusion: InclusionMetrics;
  findings: RunFindings;
}

export interface Reversion {
  reverted: boolean;       // did the V2 pool return to within threshold of the V3 ref?
  elapsedMs: number;       // time until reversion (≈ backrun latency), or timeout
  startGapBps: number;     // |V2 - V3| right after our swap
  endGapBps: number;       // |V2 - V3| when we stopped waiting
}

export interface PairedRun {
  iteration: number;
  startedAt: string;
  public: RouteResult;
  blink: RouteResult;
  reversion?: Reversion;   // arb-back observed after the forward legs
}
