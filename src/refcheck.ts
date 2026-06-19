// Quick sanity check: print the V3 reference price, the current V2 mid, and the
// gap between them for the configured pair.
//   npm run ref:check
import { CONFIG } from './config.js';
import { fetchV3RefPriceHuman } from './refprice.js';
import { currentV2PriceHuman } from './analyze.js';
import { tokenSymbol } from './tokens.js';

async function main() {
  const [symIn, symOut] = await Promise.all([tokenSymbol(CONFIG.tokenIn), tokenSymbol(CONFIG.tokenOut)]);
  const [v3, v2] = await Promise.all([fetchV3RefPriceHuman(), currentV2PriceHuman()]);
  if (v3 === null) { console.log('No V3 reference pool found for the configured pair.'); return; }
  const gapBps = (Math.abs(v2 - v3) / v3) * 10_000;
  console.log(`V3 ref : 1 ${symIn} = ${v3} ${symOut}`);
  console.log(`V2 mid : 1 ${symIn} = ${v2} ${symOut}`);
  console.log(`gap    : ${gapBps.toFixed(1)} bps  (how far the V2 pool currently sits from the V3 reference)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
