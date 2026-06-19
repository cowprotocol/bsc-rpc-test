// Convert any remaining TOKEN_OUT (ADA) back to TOKEN_IN (USDT) on the most
// efficient route — quotes PancakeSwap V2 and every configured V3 fee tier, then
// executes on whichever returns the most USDT.
//
//   npm run sweep                 # preview: best route per wallet, no tx sent
//   EXECUTE=true npm run sweep     # actually convert
//
// With no wallet keys set it just prints the best route for a sample amount.
import { formatUnits, parseUnits, maxUint256, type Address, type Hex } from 'viem';
import { ROUTER_ABI, V3_SWAP_ROUTER_ABI, QUOTER_V2_ABI, ERC20_ABI } from './abi.js';
import { CONFIG } from './config.js';
import { publicClient, walletFor } from './clients.js';
import { allowance, balanceOf, tokenDecimals, tokenSymbol } from './tokens.js';

const EXECUTE = (process.env.EXECUTE ?? '').toLowerCase() === 'true';
// Min-out tolerance for the sweep. The deep V3 route barely moves from our own
// trade, but ADA's price can drift >1% between quote and inclusion (a 100 bps
// default reverted with "Too little received"), so default to 300 bps. Override
// with SWEEP_SLIPPAGE_BPS — tighten once you confirm it lands.
const SLIPPAGE_BPS = Number(process.env.SWEEP_SLIPPAGE_BPS ?? 300);

interface Quote { venue: 'v2' | 'v3'; fee?: number; out: bigint; }

// All quotes sell `amountIn` of TOKEN_OUT (ADA) for TOKEN_IN (USDT).
async function quoteV2(amountIn: bigint): Promise<Quote | null> {
  try {
    const amounts = (await publicClient.readContract({
      address: CONFIG.router, abi: ROUTER_ABI, functionName: 'getAmountsOut',
      args: [amountIn, [CONFIG.tokenOut, CONFIG.tokenIn]],
    })) as readonly bigint[];
    const out = amounts[amounts.length - 1] ?? 0n;
    return out > 0n ? { venue: 'v2', out } : null;
  } catch { return null; }
}

async function quoteV3(amountIn: bigint, fee: number): Promise<Quote | null> {
  try {
    const res = (await publicClient.readContract({
      address: CONFIG.quoterV2, abi: QUOTER_V2_ABI, functionName: 'quoteExactInputSingle',
      args: [{ tokenIn: CONFIG.tokenOut, tokenOut: CONFIG.tokenIn, amountIn, fee, sqrtPriceLimitX96: 0n }],
    })) as readonly [bigint, bigint, number, bigint];
    return res[0] > 0n ? { venue: 'v3', fee, out: res[0] } : null;
  } catch { return null; }
}

/** All available quotes, best (most TOKEN_IN out) first. */
async function quotes(amountIn: bigint): Promise<Quote[]> {
  const all = await Promise.all([quoteV2(amountIn), ...CONFIG.v3FeeTiers.map((f) => quoteV3(amountIn, f))]);
  return all.filter((q): q is Quote => q !== null).sort((a, b) => (b.out > a.out ? 1 : b.out < a.out ? -1 : 0));
}

async function ensureApproval(pk: Hex, spender: Address) {
  const wallet = walletFor(pk);
  if ((await allowance(CONFIG.tokenOut, wallet.account.address, spender)) >= maxUint256 / 2n) return;
  console.log(`    approving ${spender} to spend ADA…`);
  const hash = await wallet.writeContract({ address: CONFIG.tokenOut, abi: ERC20_ABI, functionName: 'approve', args: [spender, maxUint256] });
  await publicClient.waitForTransactionReceipt({ hash });
}

async function execute(pk: Hex, q: Quote, amountIn: bigint): Promise<Hex> {
  const wallet = walletFor(pk);
  const from = wallet.account.address;
  const minOut = (q.out * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
  if (q.venue === 'v2') {
    await ensureApproval(pk, CONFIG.router);
    return wallet.writeContract({
      address: CONFIG.router, abi: ROUTER_ABI, functionName: 'swapExactTokensForTokens',
      args: [amountIn, minOut, [CONFIG.tokenOut, CONFIG.tokenIn], from, deadline],
    });
  }
  await ensureApproval(pk, CONFIG.v3SwapRouter);
  return wallet.writeContract({
    address: CONFIG.v3SwapRouter, abi: V3_SWAP_ROUTER_ABI, functionName: 'exactInputSingle',
    args: [{ tokenIn: CONFIG.tokenOut, tokenOut: CONFIG.tokenIn, fee: q.fee!, recipient: from, deadline, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
  });
}

interface Tokens { decIn: number; decOut: number; symIn: string; symOut: string; }

function printQuotes(qs: Quote[], t: Tokens) {
  for (const q of qs) console.log(`    ${q.venue}${q.fee ? ` fee=${q.fee}` : '      '}  →  ${formatUnits(q.out, t.decIn)} ${t.symIn}`);
}

async function sweepWallet(label: string, pk: Hex, t: Tokens) {
  if (!pk) return;
  const from = walletFor(pk).account.address;
  const bal = await balanceOf(CONFIG.tokenOut, from);
  console.log(`\n${label} ${from}`);
  if (bal === 0n) { console.log(`  no ${t.symOut} to convert`); return; }
  console.log(`  balance: ${formatUnits(bal, t.decOut)} ${t.symOut}`);
  const qs = await quotes(bal);
  if (qs.length === 0) { console.log('  no route found'); return; }
  printQuotes(qs, t);
  const best = qs[0]!;
  console.log(`  best route: ${best.venue}${best.fee ? ` (fee ${best.fee})` : ''} → ${formatUnits(best.out, t.decIn)} ${t.symIn}`);
  if (!EXECUTE) { console.log('  preview only — set EXECUTE=true to convert'); return; }
  const hash = await execute(pk, best, bal);
  await publicClient.waitForTransactionReceipt({ hash, timeout: CONFIG.inclusionTimeoutMs });
  const after = await balanceOf(CONFIG.tokenIn, from);
  console.log(`  converted via ${best.venue} — tx ${hash}`);
  console.log(`  ${t.symIn} balance now: ${formatUnits(after, t.decIn)}`);
}

async function main() {
  const [decIn, decOut, symIn, symOut] = await Promise.all([
    tokenDecimals(CONFIG.tokenIn), tokenDecimals(CONFIG.tokenOut),
    tokenSymbol(CONFIG.tokenIn), tokenSymbol(CONFIG.tokenOut),
  ]);
  const t: Tokens = { decIn, decOut, symIn, symOut };
  console.log(`Sweep ${symOut} → ${symIn} via most efficient of V2 + V3 tiers  ${EXECUTE ? `[EXECUTE, slippage ${SLIPPAGE_BPS}bps]` : '[preview]'}`);

  if (!CONFIG.walletAPk && !CONFIG.walletBPk) {
    const sample = parseUnits('50', decOut);
    console.log(`\n(no wallet keys set — best route for a sample ${formatUnits(sample, decOut)} ${symOut})`);
    printQuotes(await quotes(sample), t);
    return;
  }
  await sweepWallet('Wallet A', CONFIG.walletAPk, t);
  await sweepWallet('Wallet B', CONFIG.walletBPk, t);
}

main().catch((e) => { console.error(e); process.exit(1); });
