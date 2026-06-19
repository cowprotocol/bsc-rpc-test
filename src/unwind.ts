import type { Address, Hex } from 'viem';
import { ROUTER_ABI, V3_SWAP_ROUTER_ABI } from './abi.js';
import { CONFIG } from './config.js';
import { publicClient, walletFor } from './clients.js';
import { balanceOf, tokenDecimals } from './tokens.js';
import { deepestV3Pool, fetchV3RefPriceHuman } from './refprice.js';

export interface UnwindResult {
  venue: 'v2' | 'v3';
  hash: Hex;
  soldOut: bigint; // TOKEN_OUT sold
  gotIn: bigint;   // TOKEN_IN received/expected
}

/**
 * Sell the wallet's entire TOKEN_OUT balance back to TOKEN_IN so capital recycles
 * across iterations. Venue per CONFIG.unwindVenue:
 *  - 'v2': the same thin pool, opposite direction (re-dislocates it — caller must
 *    waitForReversion() afterwards).
 *  - 'v3': the deep V3 pool (near-zero impact, leaves the measured V2 pool untouched).
 * Always broadcasts via the public RPC. v3 falls back to v2 if no V3 pool is found.
 */
export async function unwindToUsdt(pk: Hex): Promise<UnwindResult | null> {
  const from = walletFor(pk).account.address;
  const bal = await balanceOf(CONFIG.tokenOut, from);
  if (bal === 0n) return null;

  if (CONFIG.unwindVenue === 'v3') {
    const v3 = await unwindV3(pk, from, bal);
    if (v3) return v3;
    console.warn('[unwind] no V3 pool/ref available — falling back to V2');
  }
  return unwindV2(pk, from, bal);
}

/** Unwind on PancakeSwap V2 (same thin pool, reverse direction). */
async function unwindV2(pk: Hex, from: Address, bal: bigint): Promise<UnwindResult> {
  const wallet = walletFor(pk);
  const reversePath = [CONFIG.tokenOut, CONFIG.tokenIn] as const;
  const amounts = (await publicClient.readContract({
    address: CONFIG.router, abi: ROUTER_ABI, functionName: 'getAmountsOut', args: [bal, [...reversePath]],
  })) as readonly bigint[];
  const out = amounts[amounts.length - 1] ?? 0n;
  const minOut = (out * BigInt(10_000 - CONFIG.slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  const hash = await wallet.writeContract({
    address: CONFIG.router, abi: ROUTER_ABI, functionName: 'swapExactTokensForTokens',
    args: [bal, minOut, [...reversePath], from, deadline],
  });
  await publicClient.waitForTransactionReceipt({ hash, timeout: CONFIG.inclusionTimeoutMs });
  return { venue: 'v2', hash, soldOut: bal, gotIn: out };
}

/**
 * Unwind on the deep V3 pool via exactInputSingle through the V3 SwapRouter. The
 * min-out is derived from the live V3 mid price minus slippage (the pool is deep,
 * so a small sell barely moves it). Requires TOKEN_OUT approved to the V3
 * SwapRouter (handled by `prepare:wallets` when UNWIND_VENUE=v3).
 */
async function unwindV3(pk: Hex, from: Address, bal: bigint): Promise<UnwindResult | null> {
  const info = await deepestV3Pool();
  const refHuman = await fetchV3RefPriceHuman(); // TOKEN_OUT per 1 TOKEN_IN
  if (!info || refHuman === null || refHuman <= 0) return null;

  const [decIn, decOut] = await Promise.all([tokenDecimals(CONFIG.tokenIn), tokenDecimals(CONFIG.tokenOut)]);
  // Selling `bal` TOKEN_OUT for TOKEN_IN: expected TOKEN_IN raw = bal * 10^(decIn-decOut) / refHuman.
  const expectedIn = (Number(bal) * 10 ** (decIn - decOut)) / refHuman;
  const minOut = BigInt(Math.floor((expectedIn * (10_000 - CONFIG.slippageBps)) / 10_000));
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  const hash = await walletFor(pk).writeContract({
    address: CONFIG.v3SwapRouter, abi: V3_SWAP_ROUTER_ABI, functionName: 'exactInputSingle',
    args: [{
      tokenIn: CONFIG.tokenOut,
      tokenOut: CONFIG.tokenIn,
      fee: info.fee,
      recipient: from,
      deadline,
      amountIn: bal,
      amountOutMinimum: minOut,
      sqrtPriceLimitX96: 0n,
    }],
  });
  await publicClient.waitForTransactionReceipt({ hash, timeout: CONFIG.inclusionTimeoutMs });
  return { venue: 'v3', hash, soldOut: bal, gotIn: BigInt(Math.floor(expectedIn)) };
}
