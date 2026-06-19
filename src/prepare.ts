import { formatEther, formatUnits, maxUint256, type Address, type Hex } from 'viem';
import { CONFIG } from './config.js';
import { publicClient, walletFor } from './clients.js';
import { ERC20_ABI } from './abi.js';
import { allowance, balanceOf, tokenDecimals, tokenSymbol } from './tokens.js';

const APPROVE = (process.env.APPROVE ?? '').toLowerCase() === 'true';

async function ensureApproval(pk: Hex, token: Address, spender: Address, label: string) {
  const wallet = walletFor(pk);
  const allow = await allowance(token, wallet.account.address, spender);
  if (allow >= maxUint256 / 2n) { console.log(`   ${label}: approved`); return; }
  if (!APPROVE) { console.log(`   ${label}: NOT approved — re-run with APPROVE=true`); return; }
  console.log(`   ${label}: approving ${spender}…`);
  const hash = await wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [spender, maxUint256] });
  await publicClient.waitForTransactionReceipt({ hash });
  console.log(`   ${label}: approved (${hash})`);
}

async function inspect(label: string, pk: Hex) {
  if (!pk) { console.log(`${label}: no key set`); return; }
  const addr = walletFor(pk).account.address;
  const [decIn, decOut, symIn, symOut] = await Promise.all([
    tokenDecimals(CONFIG.tokenIn), tokenDecimals(CONFIG.tokenOut),
    tokenSymbol(CONFIG.tokenIn), tokenSymbol(CONFIG.tokenOut),
  ]);
  const [bnb, tin, tout] = await Promise.all([
    publicClient.getBalance({ address: addr }),
    balanceOf(CONFIG.tokenIn, addr),
    balanceOf(CONFIG.tokenOut, addr),
  ]);
  console.log(`${label} ${addr}`);
  console.log(`   BNB ${formatEther(bnb)} | ${symIn} ${formatUnits(tin, decIn)} | ${symOut} ${formatUnits(tout, decOut)}`);
  // Forward leg sells TOKEN_IN on the V2 router; the unwind sells TOKEN_OUT on
  // whichever venue is configured (V2 router or the V3 SwapRouter).
  const unwindSpender = CONFIG.unwindVenue === 'v3' ? CONFIG.v3SwapRouter : CONFIG.router;
  await ensureApproval(pk, CONFIG.tokenIn, CONFIG.router, `${symIn}→V2router`);
  await ensureApproval(pk, CONFIG.tokenOut, unwindSpender, `${symOut}→${CONFIG.unwindVenue === 'v3' ? 'V3router' : 'V2router'}`);
}

async function main() {
  console.log('Wallet prep — each wallet needs TOKEN_IN inventory + BNB gas + router approval on both tokens\n');
  await inspect('Wallet A', CONFIG.walletAPk);
  await inspect('Wallet B', CONFIG.walletBPk);
}

main().catch((e) => { console.error(e); process.exit(1); });
