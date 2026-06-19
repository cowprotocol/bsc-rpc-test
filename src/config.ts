import 'dotenv/config';
import { getAddress, parseUnits, type Address, type Hex } from 'viem';

function req(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name} (see .env.example)`);
  return v;
}
function opt(name: string): string | undefined {
  const v = process.env[name];
  return v && v.length > 0 ? v : undefined;
}
function bool(name: string, def: boolean): boolean {
  const v = process.env[name];
  if (v === undefined) return def;
  return v.toLowerCase() === 'true' || v === '1';
}
function num(name: string, def: number): number {
  const v = process.env[name];
  return v ? Number(v) : def;
}

export const DRY_RUN = bool('DRY_RUN', true);

export const CONFIG = {
  dryRun: DRY_RUN,
  chainId: 56,
  publicRpcHttp: process.env.PUBLIC_RPC_HTTP ?? 'https://bsc-dataseed.bnbchain.org',
  publicRpcWs: opt('PUBLIC_RPC_WS'),
  blink: {
    endpoint: opt('BLINK_ENDPOINT'),
    authHeader: opt('BLINK_AUTH_HEADER'),
    authValue: opt('BLINK_AUTH_VALUE'),
  },
  // Wallet keys are only required for a live run.
  walletAPk: (opt('WALLET_A_PK') ?? '') as Hex,
  walletBPk: (opt('WALLET_B_PK') ?? '') as Hex,

  router: getAddress(process.env.ROUTER ?? '0x10ED43C718714eb63d5aA57B78B54704E256024E'),
  factory: getAddress(process.env.FACTORY ?? '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73'),
  tokenIn: getAddress(req('TOKEN_IN')),
  tokenOut: getAddress(req('TOKEN_OUT')),
  amountInHuman: process.env.AMOUNT_IN ?? '0.05',
  slippageBps: num('SLIPPAGE_BPS', 300),

  gasPriceGwei: opt('GAS_PRICE_GWEI'),
  gasLimit: BigInt(process.env.GAS_LIMIT ?? '300000'),
  refPrice: opt('REF_PRICE'),
  autoRefV3: bool('AUTO_REF_V3', true),
  v3Factory: getAddress(process.env.V3_FACTORY ?? '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865'),
  v3FeeTiers: (process.env.V3_FEE_TIERS ?? '100,500,2500,10000').split(',').map((s) => Number(s.trim())),
  v3SwapRouter: getAddress(process.env.V3_SWAP_ROUTER ?? '0x1b81D678ffb9C0263b24A97847620C99d213eB14'),
  quoterV2: getAddress(process.env.V3_QUOTER ?? '0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997'),

  iterations: num('ITERATIONS', 1),
  intervalMs: num('INTERVAL_MS', 15000),
  alternatePaths: bool('ALTERNATE_PATHS', true),
  inclusionTimeoutMs: num('INCLUSION_TIMEOUT_MS', 60000),

  // After the forward legs, wait for the thin pool to be arbed back toward the V3
  // reference before the next iteration (keeps iterations independent).
  waitForRevert: bool('WAIT_FOR_REVERT', true),
  revertThresholdBps: num('REVERT_THRESHOLD_BPS', 50),
  revertTimeoutMs: num('REVERT_TIMEOUT_MS', 90000),
  revertPollMs: num('REVERT_POLL_MS', 2000),
  // Sell the received TOKEN_OUT back to TOKEN_IN each iteration (recycles capital).
  unwind: bool('UNWIND', true),
  // Unwind venue: 'v2' = same thin pool (re-dislocates it), 'v3' = deep V3 pool
  // (near-zero impact, leaves the measured V2 pool untouched).
  unwindVenue: ((process.env.UNWIND_VENUE ?? 'v2').toLowerCase() === 'v3' ? 'v3' : 'v2') as 'v2' | 'v3',
} as const;

/** Validates the config needed to actually broadcast. Throws with a clear message. */
export function assertLiveConfig(): void {
  if (!CONFIG.walletAPk || !CONFIG.walletBPk) throw new Error('WALLET_A_PK and WALLET_B_PK are required for a live run.');
  if (!CONFIG.blink.endpoint) throw new Error('BLINK_ENDPOINT is required for a live run.');
}

export function tokenInAmount(decimals: number): bigint {
  return parseUnits(CONFIG.amountInHuman, decimals);
}

export const PATH: readonly Address[] = [CONFIG.tokenIn, CONFIG.tokenOut];
