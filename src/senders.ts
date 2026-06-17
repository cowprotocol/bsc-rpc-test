import type { Hex } from 'viem';
import { CONFIG } from './config.js';

/**
 * A submission path. Both the public mempool and blink are, from the client's
 * point of view, just an endpoint that accepts a signed raw tx via
 * `eth_sendRawTransaction`. The difference is which endpoint, and whether the
 * tx becomes publicly visible before inclusion.
 */
export interface Sender {
  readonly name: 'public' | 'blink';
  readonly endpoint: string;
  sendRawTransaction(raw: Hex): Promise<Hex>;
}

async function jsonRpc(endpoint: string, method: string, params: unknown[], headers: Record<string, string> = {}): Promise<Hex> {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`${method} HTTP ${res.status} from ${endpoint}`);
  const body = (await res.json()) as { result?: Hex; error?: { message: string } };
  if (body.error) throw new Error(`${method} RPC error: ${body.error.message}`);
  if (!body.result) throw new Error(`${method}: empty result from ${endpoint}`);
  return body.result;
}

class EndpointSender implements Sender {
  constructor(
    readonly name: 'public' | 'blink',
    readonly endpoint: string,
    private readonly headers: Record<string, string> = {},
  ) {}
  sendRawTransaction(raw: Hex): Promise<Hex> {
    return jsonRpc(this.endpoint, 'eth_sendRawTransaction', [raw], this.headers);
  }
}

export function publicSender(): Sender {
  return new EndpointSender('public', CONFIG.publicRpcHttp);
}

export function blinkSender(): Sender {
  if (!CONFIG.blink.endpoint) throw new Error('BLINK_ENDPOINT not configured');
  const headers: Record<string, string> = {};
  if (CONFIG.blink.authHeader && CONFIG.blink.authValue) {
    headers[CONFIG.blink.authHeader] = CONFIG.blink.authValue;
  }
  return new EndpointSender('blink', CONFIG.blink.endpoint, headers);
}
