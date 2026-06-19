import type { Address } from 'viem';
import { V3_FACTORY_ABI, V3_POOL_ABI } from './abi.js';
import { CONFIG } from './config.js';
import { publicClient } from './clients.js';
import { balanceOf, tokenDecimals } from './tokens.js';

const ZERO = '0x0000000000000000000000000000000000000000';

export interface V3PoolInfo { pool: Address; fee: number; }
let cachedPool: V3PoolInfo | null | undefined; // undefined = unresolved, null = none found

/** Pick the deepest PancakeSwap V3 pool (address + fee tier) for TOKEN_IN/TOKEN_OUT. */
export async function deepestV3Pool(): Promise<V3PoolInfo | null> {
  if (cachedPool !== undefined) return cachedPool;
  let best: V3PoolInfo | null = null;
  let bestBal = -1n;
  for (const fee of CONFIG.v3FeeTiers) {
    let pool: Address;
    try {
      pool = (await publicClient.readContract({
        address: CONFIG.v3Factory, abi: V3_FACTORY_ABI, functionName: 'getPool',
        args: [CONFIG.tokenIn, CONFIG.tokenOut, fee],
      })) as Address;
    } catch { continue; }
    if (pool.toLowerCase() === ZERO) continue;
    const bal = await balanceOf(CONFIG.tokenOut, pool).catch(() => 0n);
    if (bal > bestBal) { bestBal = bal; best = { pool, fee }; }
  }
  cachedPool = best;
  if (best) console.log(`[ref] using V3 pool ${best.pool} (fee ${best.fee}) as price reference`);
  else console.warn('[ref] no V3 pool found — falling back to V2 pre-trade mid');
  return best;
}

/**
 * Current reference price as TOKEN_OUT per 1 TOKEN_IN (human units), read from the
 * deepest V3 pool's slot0. Returns null if no V3 pool exists (caller falls back to
 * the V2 pre-trade mid).
 */
export async function fetchV3RefPriceHuman(): Promise<number | null> {
  const info = await deepestV3Pool();
  if (!info) return null;
  const pool = info.pool;
  const [token0, slot0, decIn, decOut] = await Promise.all([
    publicClient.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'token0' }) as Promise<Address>,
    publicClient.readContract({ address: pool, abi: V3_POOL_ABI, functionName: 'slot0' }) as Promise<readonly [bigint, number, number, number, number, number, boolean]>,
    tokenDecimals(CONFIG.tokenIn),
    tokenDecimals(CONFIG.tokenOut),
  ]);
  const sqrtP = Number(slot0[0]) / 2 ** 96;
  const pRaw = sqrtP * sqrtP; // token1 per token0, in raw (smallest) units
  const baseIsToken0 = token0.toLowerCase() === CONFIG.tokenIn.toLowerCase();
  if (baseIsToken0) {
    // pRaw = quote/base raw -> human quote per base
    return pRaw * 10 ** (decIn - decOut);
  }
  // token0 = quote, token1 = base: pRaw = base/quote raw -> human base per quote -> invert
  const basePerQuoteHuman = pRaw * 10 ** (decOut - decIn);
  return basePerQuoteHuman > 0 ? 1 / basePerQuoteHuman : null;
}
