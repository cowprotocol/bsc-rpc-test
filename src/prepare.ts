import { formatEther, formatUnits, maxUint256, type Hex } from 'viem';
import { CONFIG } from './config.js';
import { publicClient, walletFor } from './clients.js';
import { ERC20_ABI } from './abi.js';
import { allowance, balanceOf, tokenDecimals, tokenSymbol } from './tokens.js';

const APPROVE = (process.env.APPROVE ?? '').toLowerCase() === 'true';

async function inspect(label: string, pk: Hex, decIn: number, symIn: string) {
  if (!pk) { console.log(`${label}: no key set`); return; }
  const wallet = walletFor(pk);
  const addr = wallet.account.address;
  const [bnb, tin, allow] = await Promise.all([
    publicClient.getBalance({ address: addr }),
    balanceOf(CONFIG.tokenIn, addr),
    allowance(CONFIG.tokenIn, addr, CONFIG.router),
  ]);
  const need = tin >= 0n;
  console.log(`${label} ${addr}`);
  console.log(`   BNB: ${formatEther(bnb)}   ${symIn}: ${formatUnits(tin, decIn)}   allowance: ${allow >= maxUint256 / 2n ? 'MAX' : formatUnits(allow, decIn)}`);
  if (APPROVE && allow < maxUint256 / 2n) {
    console.log(`   approving router ${CONFIG.router} ...`);
    const hash = await wallet.writeContract({ address: CONFIG.tokenIn, abi: ERC20_ABI, functionName: 'approve', args: [CONFIG.router, maxUint256] });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`   approved (${hash})`);
  } else if (!APPROVE && allow < maxUint256 / 2n) {
    console.log('   ⚠ not approved — re-run with APPROVE=true to approve the router');
  }
  void need;
}

async function main() {
  const [decIn, symIn] = await Promise.all([tokenDecimals(CONFIG.tokenIn), tokenSymbol(CONFIG.tokenIn)]);
  console.log(`Wallet prep — selling ${symIn} via router ${CONFIG.router}\n`);
  await inspect('Wallet A', CONFIG.walletAPk, decIn, symIn);
  await inspect('Wallet B', CONFIG.walletBPk, decIn, symIn);
  console.log('\nEach wallet needs: enough', symIn, 'for the swap amount + BNB for gas + router approval.');
}

main().catch((e) => { console.error(e); process.exit(1); });
