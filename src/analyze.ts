import { getAbiItem, type Address, type Hex } from 'viem';
import { FACTORY_ABI, PAIR_ABI } from './abi.js';
import { CONFIG } from './config.js';
import { publicClient } from './clients.js';
import { tokenDecimals } from './tokens.js';
import type { PoolSwap, RunFindings } from './types.js';

const SWAP_EVENT = getAbiItem({ abi: PAIR_ABI, name: 'Swap' });

interface PairInfo {
  pair: Address;
  baseIsToken0: boolean; // is TOKEN_IN == token0 ?
  decIn: number;
  decOut: number;
}
let cachedPair: PairInfo | undefined;

export async function getPairInfo(): Promise<PairInfo> {
  if (cachedPair) return cachedPair;
  const pair = (await publicClient.readContract({
    address: CONFIG.factory, abi: FACTORY_ABI, functionName: 'getPair', args: [CONFIG.tokenIn, CONFIG.tokenOut],
  })) as Address;
  if (pair === '0x0000000000000000000000000000000000000000') throw new Error('No PancakeV2 pair for TOKEN_IN/TOKEN_OUT');
  const token0 = (await publicClient.readContract({ address: pair, abi: PAIR_ABI, functionName: 'token0' })) as Address;
  const baseIsToken0 = token0.toLowerCase() === CONFIG.tokenIn.toLowerCase();
  const [decIn, decOut] = await Promise.all([tokenDecimals(CONFIG.tokenIn), tokenDecimals(CONFIG.tokenOut)]);
  cachedPair = { pair, baseIsToken0, decIn, decOut };
  return cachedPair;
}

async function reservesAt(blockNumber: bigint): Promise<{ base: bigint; quote: bigint }> {
  const { pair, baseIsToken0 } = await getPairInfo();
  const [r0, r1] = (await publicClient.readContract({
    address: pair, abi: PAIR_ABI, functionName: 'getReserves', blockNumber,
  })) as readonly [bigint, bigint, number];
  return baseIsToken0 ? { base: r0, quote: r1 } : { base: r1, quote: r0 };
}

/** Decoded pool swaps in a block, ordered by logIndex. */
async function poolSwapsInBlock(blockNumber: bigint): Promise<PoolSwap[]> {
  const { pair, baseIsToken0 } = await getPairInfo();
  const logs = await publicClient.getLogs({ address: pair, event: SWAP_EVENT, fromBlock: blockNumber, toBlock: blockNumber });
  const swaps = logs.map((l): PoolSwap => {
    const a = l.args as { amount0In: bigint; amount1In: bigint; amount0Out: bigint; amount1Out: bigint; to: Address };
    const baseIn = baseIsToken0 ? a.amount0In > 0n : a.amount1In > 0n;
    const amountInRaw = baseIsToken0 ? (baseIn ? a.amount0In : a.amount1In) : (baseIn ? a.amount1In : a.amount0In);
    const amountOutRaw = baseIsToken0 ? (baseIn ? a.amount1Out : a.amount0Out) : (baseIn ? a.amount0Out : a.amount1Out);
    return { txHash: l.transactionHash!, logIndex: l.logIndex!, to: a.to, baseIn, amountInRaw, amountOutRaw };
  });
  return swaps.sort((x, y) => x.logIndex - y.logIndex);
}

/**
 * Analyze the block our swap landed in:
 *  - frontrun: a same-direction pool swap ordered before ours (another sender)
 *  - backrun : an opposite-direction pool swap ordered after ours (another sender)
 *  - sandwich: same address on both sides
 *  - priceImpactBps + backrunOpportunityOut: dislocation our swap created vs a
 *    reference price (REF_PRICE, else the pre-trade pool mid).
 */
export async function analyzeRun(opts: { ourTxHash: Hex; blockNumber: bigint }): Promise<{
  findings: RunFindings;
  realizedOut?: bigint;
}> {
  const { decIn, decOut } = await getPairInfo();
  const swaps = await poolSwapsInBlock(opts.blockNumber);
  const ours = swaps.find((s) => s.txHash.toLowerCase() === opts.ourTxHash.toLowerCase());

  const before = swaps.filter((s) => ours && s.logIndex < ours.logIndex);
  const after = swaps.filter((s) => ours && s.logIndex > ours.logIndex);

  const fr = ours ? before.find((s) => s.baseIn === ours.baseIn && s.txHash !== ours.txHash) : undefined;
  const br = ours ? after.find((s) => s.baseIn !== ours.baseIn && s.txHash !== ours.txHash) : undefined;
  const sandwichAddr = fr && br && fr.to.toLowerCase() === br.to.toLowerCase() ? fr.to : undefined;

  // Reserves before the block, folded forward to just after our swap.
  const pre = await reservesAt(opts.blockNumber - 1n);
  let base = pre.base, quote = pre.quote;
  if (ours) {
    for (const s of swaps) {
      // apply in order up to and including ours
      if (s.baseIn) { base += s.amountInRaw; quote -= s.amountOutRaw; }
      else { quote += s.amountInRaw; base -= s.amountOutRaw; }
      if (s.logIndex === ours.logIndex) break;
    }
  }

  const priceRaw = (b: bigint, q: bigint) => Number(q) / Number(b); // quote per base (raw)
  const pRef = CONFIG.refPrice
    ? Number(CONFIG.refPrice) * 10 ** (decOut - decIn) // human quote/base -> raw ratio
    : priceRaw(pre.base, pre.quote);
  const pAfter = priceRaw(base, quote);
  const priceImpactBps = pRef > 0 ? Math.abs((pRef - pAfter) / pRef) * 10_000 : 0;

  return {
    findings: {
      frontrun: { detected: !!fr, byTx: fr?.txHash, byAddress: fr?.to },
      backrun: { detected: !!br, byTx: br?.txHash, byAddress: br?.to },
      sandwich: { detected: !!sandwichAddr, byAddress: sandwichAddr },
      backrunOpportunityOut: optimalBackrunProfitOut(base, quote, pRef),
      priceImpactBps,
    },
    realizedOut: ours?.amountOutRaw,
  };
}

/**
 * Optimal single-pool arbitrage profit (in raw TOKEN_OUT units) available against
 * an external reference price `pRefRaw` (quote per base), given pool reserves
 * `(base, quote)` immediately after our swap. First-order, fee-free estimate —
 * an upper bound on what a backrunner could extract from the dislocation we made.
 * See README "Methodology & limitations".
 */
function optimalBackrunProfitOut(base: bigint, quote: bigint, pRefRaw: number): bigint {
  const B = Number(base), Q = Number(quote);
  const k = B * Q;
  const targetBase = Math.sqrt(k / pRefRaw);
  const targetQuote = Math.sqrt(k * pRefRaw);
  // We sold base -> base reserve is high, pool base is cheap -> backrunner buys base.
  const baseBought = B - targetBase;        // >0 when pool base is underpriced
  const quotePaid = targetQuote - Q;        // >0
  if (baseBought <= 0 || quotePaid <= 0) return 0n;
  const profitQuote = baseBought * pRefRaw - quotePaid;
  return profitQuote > 0 ? BigInt(Math.round(profitQuote)) : 0n;
}
