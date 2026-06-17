# blink vs public mempool — BSC inclusion experiment

Measures, for the **same swap** sent from **two wallets at the same instant** down two
submission paths on BNB Smart Chain — the **public mempool** and the **blink** private
relay — three things:

- **(a) backrun opportunity** — how much extractable value our swap left on the table
  (price dislocation it created), and whether a backrun actually captured it;
- **(b) inclusion time** — how fast each path landed (blocks waited, in-block index,
  wall-clock latency);
- **(c) frontrun** — whether our swap got front-run / sandwiched.

The only intended difference between the two txs is the **submission path**. Same swap,
same amount, same path, **identical gas price**, fired simultaneously.

## How it works

1. Build one identical `swapExactTokensForTokens` (PancakeSwap V2) from each of two
   funded wallets, addressed to itself, signed but not yet sent.
2. Start a public-mempool watcher (for leak / first-seen timing).
3. Fire both raw txs at the same instant — one via the public RPC
   (`eth_sendRawTransaction`), one via the **blink** endpoint (also
   `eth_sendRawTransaction`, just a private endpoint).
4. Wait for both to be mined.
5. For each, read the pool's `Swap` events in the inclusion block, ordered by log index,
   to classify front-run (same-direction swap before ours by another sender), back-run
   (opposite-direction after ours), and sandwich (same address on both sides); reconstruct
   reserves to size the dislocation our swap created; and check whether the blink tx ever
   appeared in the public mempool.

Over many iterations it **alternates which wallet uses which path** (`ALTERNATE_PATHS`)
so per-wallet and in-block ordering effects cancel out.

## Setup

```bash
npm install
cp .env.example .env      # then edit .env
```

Fill in `.env`:

- `PUBLIC_RPC_HTTP` / `PUBLIC_RPC_WS` — a BSC node you trust (WS needed for mempool/leak timing).
- `BLINK_ENDPOINT` (+ optional `BLINK_AUTH_HEADER` / `BLINK_AUTH_VALUE`) — the blink private RPC.
- `WALLET_A_PK`, `WALLET_B_PK` — two funded sender wallets (**secrets, never commit**).
- swap params (`TOKEN_IN`/`TOKEN_OUT`/`AMOUNT_IN`/…) — default is sell 0.05 WBNB → USDT.

Check balances and approve the router:

```bash
npm run prepare:wallets            # report only
APPROVE=true npm run prepare:wallets   # also send approvals
```

## Run

Dry run first (no broadcast — validates RPC, pair, quote, and the plan):

```bash
npm run experiment                 # DRY_RUN=true by default
```

Live run (spends real funds, sends real swaps on mainnet):

```bash
DRY_RUN=false ITERATIONS=20 npm run experiment
```

Results print a per-iteration comparison and an aggregate table, and are written to
`results/run-<timestamp>.json`.

## Methodology & limitations

- **Backrun opportunity** is a *first-order, fee-free* estimate: the optimal single-pool
  arb profit (in `TOKEN_OUT`) to push the pool back to a reference price, using reserves
  reconstructed to the point just after our swap. Reference price defaults to the
  pre-trade pool mid; set `REF_PRICE` (TOKEN_OUT per TOKEN_IN) to use an external mark
  (e.g. a CEX/Binance price) for a truer opportunity figure. It ignores the 0.25% LP fee
  and gas, so treat it as an **upper bound** on extractable value, separate from the
  **realized** backrun we detect on-chain.
- **Same-block interaction:** if both wallets land in the same block they affect each
  other's price; `ALTERNATE_PATHS` cancels the bias only in aggregate. For clean
  per-trade numbers, consider spacing the two sends or running many iterations.
- **Reserve reads** at `block-1` need a node that serves recent historical state
  (any full node does for recent blocks; a public dataseed may prune older ones).
- **Mempool/leak detection** depends on the WS node supporting `newPendingTransactions`;
  without `PUBLIC_RPC_WS` the leak/first-seen columns are blank.
- Only PancakeSwap **V2** single-hop swaps are modeled. Multi-hop or V3 would need the
  swap builder and the pool-event decoder extended.
- Honest framing: blink should win on **frontrun avoidance** and **leak=no**; whether it
  wins on **inclusion speed** is exactly the open question this harness measures — don't
  assume it.

## Layout

| File | Role |
|---|---|
| `src/config.ts` | env parsing + validation |
| `src/clients.ts` | viem public/WS/wallet clients |
| `src/swap.ts` | quote, gas, build + sign the swap |
| `src/senders.ts` | pluggable public / blink `eth_sendRawTransaction` senders |
| `src/monitor.ts` | public mempool watch + inclusion wait |
| `src/analyze.ts` | front/back-run detection, price impact, backrun sizing |
| `src/experiment.ts` | orchestrator + reporting (entry point) |
| `src/prepare.ts` | balances + router approvals |
