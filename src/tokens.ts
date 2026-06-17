import type { Address } from 'viem';
import { ERC20_ABI } from './abi.js';
import { publicClient } from './clients.js';

const decimalsCache = new Map<string, number>();

export async function tokenDecimals(token: Address): Promise<number> {
  const key = token.toLowerCase();
  const cached = decimalsCache.get(key);
  if (cached !== undefined) return cached;
  const d = (await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' })) as number;
  decimalsCache.set(key, d);
  return d;
}

export async function tokenSymbol(token: Address): Promise<string> {
  try {
    return (await publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' })) as string;
  } catch {
    return token.slice(0, 8);
  }
}

export function balanceOf(token: Address, owner: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [owner] }) as Promise<bigint>;
}

export function allowance(token: Address, owner: Address, spender: Address): Promise<bigint> {
  return publicClient.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [owner, spender] }) as Promise<bigint>;
}
