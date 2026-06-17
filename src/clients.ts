import { createPublicClient, createWalletClient, http, webSocket, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { bsc } from 'viem/chains';
import { CONFIG } from './config.js';

/** HTTP client used for reads + receipt polling against the public node. */
export const publicClient = createPublicClient({
  chain: bsc,
  transport: http(CONFIG.publicRpcHttp),
});

/** WebSocket client used to watch the public pending-tx pool. Null if no WS endpoint. */
export const wsClient = CONFIG.publicRpcWs
  ? createPublicClient({ chain: bsc, transport: webSocket(CONFIG.publicRpcWs) })
  : null;

/** Wallet client for a given private key (used only for signing, not broadcasting). */
export function walletFor(pk: Hex) {
  const account = privateKeyToAccount(pk);
  return createWalletClient({ account, chain: bsc, transport: http(CONFIG.publicRpcHttp) });
}
