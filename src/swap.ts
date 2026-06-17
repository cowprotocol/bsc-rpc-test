import { encodeFunctionData, keccak256, parseGwei, type Address, type Hex } from 'viem';
import { ROUTER_ABI } from './abi.js';
import { CONFIG, PATH } from './config.js';
import { publicClient, walletFor } from './clients.js';
import type { Route, SignedSwap } from './types.js';

/** getAmountsOut quote for our fixed amountIn over PATH. */
export async function quote(amountIn: bigint): Promise<bigint> {
  const amounts = (await publicClient.readContract({
    address: CONFIG.router,
    abi: ROUTER_ABI,
    functionName: 'getAmountsOut',
    args: [amountIn, [...PATH]],
  })) as readonly bigint[];
  const out = amounts[amounts.length - 1];
  if (out === undefined) throw new Error('quote returned empty amounts');
  return out;
}

/** Resolve the gas price used identically for both routes (fairness). */
export async function resolveGasPrice(): Promise<bigint> {
  if (CONFIG.gasPriceGwei) return parseGwei(CONFIG.gasPriceGwei);
  return publicClient.getGasPrice();
}

/**
 * Build and sign one swap from `pk`, addressed to that wallet, for the given route.
 * The tx is NOT broadcast here — we return the serialized payload + its hash so the
 * caller can fire both routes simultaneously.
 */
export async function buildSignedSwap(params: {
  pk: Hex;
  route: Route;
  amountIn: bigint;
  quotedOut: bigint;
  gasPrice: bigint;
}): Promise<SignedSwap> {
  const { pk, route, amountIn, quotedOut, gasPrice } = params;
  const wallet = walletFor(pk);
  const from = wallet.account.address as Address;

  const amountOutMin = (quotedOut * BigInt(10_000 - CONFIG.slippageBps)) / 10_000n;
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

  const data = encodeFunctionData({
    abi: ROUTER_ABI,
    functionName: 'swapExactTokensForTokens',
    args: [amountIn, amountOutMin, [...PATH], from, deadline],
  });

  const nonce = await publicClient.getTransactionCount({ address: from, blockTag: 'pending' });

  const serialized = await wallet.signTransaction({
    to: CONFIG.router,
    data,
    value: 0n,
    gas: CONFIG.gasLimit,
    gasPrice,
    nonce,
    type: 'legacy',
    chainId: CONFIG.chainId,
  });

  return {
    route,
    from,
    to: from,
    hash: keccak256(serialized),
    serialized,
    nonce,
    amountIn,
    amountOutMin,
    quotedOut,
    gasPrice,
  };
}
