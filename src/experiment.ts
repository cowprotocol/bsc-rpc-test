import { mkdirSync, writeFileSync } from 'node:fs';
import { formatUnits, parseUnits, type Hex } from 'viem';
import { CONFIG, assertLiveConfig } from './config.js';
import { publicClient } from './clients.js';
import { quote, resolveGasPrice, buildSignedSwap } from './swap.js';
import { publicSender, blinkSender } from './senders.js';
import { startMempoolWatch, waitForInclusion } from './monitor.js';
import { analyzeRun, getPairInfo } from './analyze.js';
import { tokenSymbol } from './tokens.js';
import type { PairedRun, Route, RouteResult, SignedSwap } from './types.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jsonReplacer = (_k: string, v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

async function runOne(iteration: number, decIn: number, decOut: number, symOut: string): Promise<PairedRun> {
  const startedAt = new Date(Date.now()).toISOString();
  const amountIn = parseUnits(CONFIG.amountInHuman, decIn);
  const quotedOut = await quote(amountIn);
  const gasPrice = await resolveGasPrice();

  // Alternate which wallet drives which route to cancel per-wallet / ordering bias.
  const flip = CONFIG.alternatePaths && iteration % 2 === 1;
  const pkForPublic = flip ? CONFIG.walletBPk : CONFIG.walletAPk;
  const pkForBlink = flip ? CONFIG.walletAPk : CONFIG.walletBPk;

  console.log(`\n── iteration ${iteration} ── sell ${CONFIG.amountInHuman} TOKEN_IN, quote ≈ ${formatUnits(quotedOut, decOut)} ${symOut}, gas ${formatUnits(gasPrice, 9)} gwei`);
  console.log(`   path assignment: public=${flip ? 'B' : 'A'}  blink=${flip ? 'A' : 'B'}`);

  if (CONFIG.dryRun) {
    console.log('   DRY RUN — not broadcasting. (set DRY_RUN=false for a live run)');
    const stub = (route: Route): RouteResult => ({
      route,
      submission: { route, hash: '0x' as Hex, submittedAtMs: 0, accepted: false, error: 'dry-run' },
      inclusion: { included: false },
      findings: { frontrun: { detected: false }, backrun: { detected: false }, sandwich: { detected: false }, backrunOpportunityOut: 0n, priceImpactBps: 0 },
    });
    return { iteration, startedAt, public: stub('public'), blink: stub('blink') };
  }

  // Build + sign both swaps before firing either.
  const signed: Record<Route, SignedSwap> = {
    public: await buildSignedSwap({ pk: pkForPublic, route: 'public', amountIn, quotedOut, gasPrice }),
    blink: await buildSignedSwap({ pk: pkForBlink, route: 'blink', amountIn, quotedOut, gasPrice }),
  };

  const watch = startMempoolWatch([signed.public.hash, signed.blink.hash]);
  const submitBlock = await publicClient.getBlockNumber();
  const pub = publicSender();
  const blk = blinkSender();

  // Fire simultaneously.
  const submittedAtMs = Date.now();
  const [pubSend, blkSend] = await Promise.allSettled([
    pub.sendRawTransaction(signed.public.serialized),
    blk.sendRawTransaction(signed.blink.serialized),
  ]);
  console.log(`   submitted: public ${pubSend.status}, blink ${blkSend.status}`);

  // Wait for inclusion of both.
  const [pubInc, blkInc] = await Promise.all([
    waitForInclusion(signed.public.hash, CONFIG.inclusionTimeoutMs),
    waitForInclusion(signed.blink.hash, CONFIG.inclusionTimeoutMs),
  ]);
  watch.stop();

  const assemble = async (route: Route, send: PromiseSettledResult<Hex>, inc: Awaited<ReturnType<typeof waitForInclusion>>): Promise<RouteResult> => {
    const s = signed[route];
    const result: RouteResult = {
      route,
      submission: {
        route, hash: s.hash, submittedAtMs,
        accepted: send.status === 'fulfilled',
        error: send.status === 'rejected' ? String(send.reason).slice(0, 200) : undefined,
        mempoolFirstSeenMs: watch.firstSeen.get(s.hash),
      },
      inclusion: { included: false },
      findings: { frontrun: { detected: false }, backrun: { detected: false }, sandwich: { detected: false }, backrunOpportunityOut: 0n, priceImpactBps: 0 },
    };
    if (inc) {
      const { findings, realizedOut } = await analyzeRun({ ourTxHash: s.hash, blockNumber: inc.blockNumber });
      findings.leakedToPublicMempool = route === 'blink' ? watch.firstSeen.has(s.hash) : undefined;
      const slippageBps = realizedOut !== undefined && s.quotedOut > 0n
        ? Number(((s.quotedOut - realizedOut) * 10_000n) / s.quotedOut) : undefined;
      result.inclusion = {
        included: inc.status === 'success',
        blockNumber: inc.blockNumber,
        blockTimestamp: inc.blockTimestamp,
        txIndex: inc.txIndex,
        blocksWaited: Number(inc.blockNumber - submitBlock),
        inclusionLatencyMs: inc.blockTimestamp * 1000 - submittedAtMs,
        realizedOut,
        slippageVsQuoteBps: slippageBps,
      };
      result.findings = findings;
    }
    return result;
  };

  return {
    iteration, startedAt,
    public: await assemble('public', pubSend, pubInc),
    blink: await assemble('blink', blkSend, blkInc),
  };
}

function printRun(run: PairedRun, decOut: number, symOut: string) {
  const row = (r: RouteResult) => {
    const i = r.inclusion;
    const f = r.findings;
    const inc = i.included ? `blk +${i.blocksWaited} idx#${i.txIndex} ${i.inclusionLatencyMs}ms` : 'NOT INCLUDED';
    const fr = f.frontrun.detected ? `YES(${f.frontrun.byAddress?.slice(0, 10)})` : 'no';
    const br = f.backrun.detected ? `YES(${f.backrun.byAddress?.slice(0, 10)})` : 'no';
    const opp = `${formatUnits(f.backrunOpportunityOut, decOut)} ${symOut} / ${f.priceImpactBps.toFixed(1)}bps`;
    const leak = r.route === 'blink' ? `  leaked=${f.leakedToPublicMempool ? 'YES' : 'no'}` : '';
    return `   ${r.route.padEnd(6)} | ${inc} | frontrun ${fr} | backrun ${br} | opp ${opp}${leak}`;
  };
  console.log(row(run.public));
  console.log(row(run.blink));
}

async function main() {
  console.log('blink vs public mempool — BSC inclusion experiment');
  if (!CONFIG.dryRun) assertLiveConfig();
  const { pair, baseIsToken0, decIn, decOut } = await getPairInfo();
  const symOut = await tokenSymbol(CONFIG.tokenOut);
  console.log(`chain 56 | pair ${pair} | base=token${baseIsToken0 ? '0' : '1'} | iterations ${CONFIG.iterations} | dryRun ${CONFIG.dryRun}`);

  const runs: PairedRun[] = [];
  for (let i = 0; i < CONFIG.iterations; i++) {
    try {
      const run = await runOne(i, decIn, decOut, symOut);
      runs.push(run);
      if (!CONFIG.dryRun) printRun(run, decOut, symOut);
    } catch (e) {
      console.error(`iteration ${i} failed: ${(e as Error).message}`);
    }
    if (i < CONFIG.iterations - 1) await sleep(CONFIG.intervalMs);
  }

  if (!CONFIG.dryRun && runs.length) {
    mkdirSync('results', { recursive: true });
    const file = `results/run-${runs[0]!.startedAt.replace(/[:.]/g, '-')}.json`;
    writeFileSync(file, JSON.stringify({ config: { ...CONFIG, walletAPk: undefined, walletBPk: undefined }, runs }, jsonReplacer, 2));
    printAggregate(runs, decOut, symOut);
    console.log(`\nresults written to ${file}`);
  } else {
    console.log('\nDry run complete — config, RPC, pair, and quote all resolved. Set DRY_RUN=false to broadcast.');
  }
}

function printAggregate(runs: PairedRun[], decOut: number, symOut: string) {
  const stats = (sel: (r: PairedRun) => RouteResult) => {
    const rs = runs.map(sel).filter((r) => r.inclusion.included);
    const n = rs.length || 1;
    const avg = (f: (r: RouteResult) => number) => rs.reduce((a, r) => a + f(r), 0) / n;
    return {
      included: rs.length,
      avgBlocks: avg((r) => r.inclusion.blocksWaited ?? 0),
      avgLatency: avg((r) => r.inclusion.inclusionLatencyMs ?? 0),
      frontrun: rs.filter((r) => r.findings.frontrun.detected).length,
      backrun: rs.filter((r) => r.findings.backrun.detected).length,
      avgOpp: avg((r) => Number(formatUnits(r.findings.backrunOpportunityOut, decOut))),
      leaked: rs.filter((r) => r.findings.leakedToPublicMempool).length,
    };
  };
  const p = stats((r) => r.public), b = stats((r) => r.blink);
  console.log(`\n══ aggregate over ${runs.length} runs ══`);
  console.log(`              ${'public'.padStart(12)} ${'blink'.padStart(12)}`);
  console.log(`included      ${String(p.included).padStart(12)} ${String(b.included).padStart(12)}`);
  console.log(`avg blocks    ${p.avgBlocks.toFixed(2).padStart(12)} ${b.avgBlocks.toFixed(2).padStart(12)}`);
  console.log(`avg latency ms${p.avgLatency.toFixed(0).padStart(12)} ${b.avgLatency.toFixed(0).padStart(12)}`);
  console.log(`frontrun runs ${String(p.frontrun).padStart(12)} ${String(b.frontrun).padStart(12)}`);
  console.log(`backrun runs  ${String(p.backrun).padStart(12)} ${String(b.backrun).padStart(12)}`);
  console.log(`avg opp ${symOut.slice(0,5)}  ${p.avgOpp.toFixed(4).padStart(12)} ${b.avgOpp.toFixed(4).padStart(12)}`);
  console.log(`blink leaked  ${''.padStart(12)} ${String(b.leaked).padStart(12)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
