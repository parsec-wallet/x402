// Parsec x402 — Bazaar discovery.
//
// The `bazaar` extension lets a resource server declare, in its own 402 challenge, what
// the endpoint takes and returns; facilitators index those declarations into a catalogue
// at `/discovery/*`. That catalogue is how an agent finds something to pay for without a
// human first pasting a URL, and it is what makes Parsec's Agents tier a market rather
// than a bookmark list.
//
// Everything here is read-only and free. Nothing in a catalogue entry is trusted beyond
// display: the price a payment is made against is the one in the live 402 challenge, read
// at payment time, never the one the directory remembered.
//
// SPDX-FileCopyrightText: 2026 BANKON
// SPDX-License-Identifier: Apache-2.0

import { describeAsset, describeNetwork, sameNetwork } from './networks';
import { normalizeRequirement, type PaymentRequirements } from './protocol';
import { getX402Settings } from './settings';
import { canPay } from './rails';

/** The discovery declaration a server publishes about its endpoint. */
export interface BazaarInfo {
  input?: {
    type?: 'http' | 'mcp';
    method?: string;
    bodyType?: string;
    body?: Record<string, unknown>;
    queryParams?: Record<string, unknown>;
    headers?: Record<string, string>;
    name?: string;
  };
  output?: { type?: string; example?: unknown };
}

export interface BazaarResource {
  id: string;
  resourceUrl: string;
  method: string;
  description: string;
  mimeType?: string;
  merchantId?: string;
  accepts: PaymentRequirements[];
  info?: BazaarInfo;
  /** How many payments the facilitator has settled for it — the only usage signal in the catalogue. */
  settleCount?: number;
  firstSeen?: string;
  lastSeen?: string;
}

export interface BazaarPage {
  items: BazaarResource[];
  total: number;
  limit: number;
  offset: number;
}

export interface BazaarQuery {
  search?: string;
  network?: string;
  method?: string;
  merchantId?: string;
  limit?: number;
  offset?: number;
  /** Drop entries no registered rail can pay. On by default — an unpayable listing is noise. */
  payableOnly?: boolean;
  /** Include testnet resources. Off by default. */
  includeTestnets?: boolean;
  /** Ceiling in atomic units of the quoted asset. */
  maxAmount?: bigint;
}

const TIMEOUT = 20_000;

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
}

function parseResource(raw: unknown): BazaarResource {
  const r = asRecord(raw);
  const accepts = Array.isArray(r.accepts) ? r.accepts.map(normalizeRequirement) : [];
  const info = (r.discoveryInfo ?? extensionInfo(accepts)) as BazaarInfo | undefined;
  return {
    id: String(r.id ?? r.resourceUrl ?? ''),
    resourceUrl: String(r.resourceUrl ?? ''),
    method: String(r.method ?? info?.input?.method ?? 'GET').toUpperCase(),
    description: String(r.description ?? ''),
    mimeType: typeof r.mimeType === 'string' ? r.mimeType : undefined,
    merchantId: typeof r.merchantId === 'string' ? r.merchantId : undefined,
    accepts,
    info,
    settleCount: typeof r.settleCount === 'number' ? r.settleCount : undefined,
    firstSeen: typeof r.firstSeen === 'string' ? r.firstSeen : undefined,
    lastSeen: typeof r.lastSeen === 'string' ? r.lastSeen : undefined,
  };
}

/** Some catalogue entries carry the bazaar declaration inside the requirement's own extensions. */
function extensionInfo(accepts: PaymentRequirements[]): BazaarInfo | undefined {
  for (const a of accepts) {
    const ext = asRecord((a as unknown as { extensions?: unknown }).extensions);
    const bazaar = asRecord(ext.bazaar);
    if (bazaar.info) return bazaar.info as BazaarInfo;
  }
  return undefined;
}

/** Read the `bazaar` extension out of a live 402 challenge's `extensions` block. */
export function bazaarInfoFrom(extensions: Record<string, unknown> | undefined): BazaarInfo | null {
  const bazaar = asRecord(asRecord(extensions).bazaar);
  return bazaar.info ? (bazaar.info as BazaarInfo) : null;
}

/** List the catalogue. Filters the facilitator understands go on the wire; the rest are applied here. */
export async function listResources(query: BazaarQuery = {}): Promise<BazaarPage> {
  const { facilitatorUrl } = getX402Settings();
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search);
  if (query.network) params.set('network', query.network);
  if (query.method) params.set('method', query.method);
  if (query.merchantId) params.set('merchantId', query.merchantId);
  params.set('limit', String(query.limit ?? 50));
  params.set('offset', String(query.offset ?? 0));

  const res = await fetch(`${facilitatorUrl.replace(/\/$/, '')}/discovery/resources?${params}`, {
    signal: AbortSignal.timeout(TIMEOUT),
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`bazaar ${res.status} ${res.statusText}`);
  const body = asRecord(await res.json());
  const rawItems = Array.isArray(body.items) ? body.items : [];
  const pagination = asRecord(body.pagination);

  let items = rawItems.map(parseResource);
  items = items.filter((item) => filterResource(item, query));

  return {
    items,
    total: typeof pagination.total === 'number' ? pagination.total : items.length,
    limit: typeof pagination.limit === 'number' ? pagination.limit : items.length,
    offset: typeof pagination.offset === 'number' ? pagination.offset : 0,
  };
}

function filterResource(item: BazaarResource, query: BazaarQuery): boolean {
  const payableOnly = query.payableOnly !== false;
  const accepts = item.accepts.filter((a) => {
    if (payableOnly && !canPay(a)) return false;
    if (!query.includeTestnets && describeNetwork(a.network).testnet) return false;
    if (query.network && !sameNetwork(a.network, query.network)) return false;
    if (query.maxAmount !== undefined && BigInt(a.amount || '0') > query.maxAmount) return false;
    return true;
  });
  if (!accepts.length) return false;
  item.accepts = accepts;
  return true;
}

/** Search the catalogue. Same endpoint, a `search` term, and the local filters. */
export async function searchResources(term: string, query: BazaarQuery = {}): Promise<BazaarPage> {
  return listResources({ ...query, search: term });
}

/** One resource by its URL. The facilitator has no get-by-id, so this is search-then-match. */
export async function getResource(resourceUrl: string): Promise<BazaarResource | null> {
  const page = await listResources({ search: resourceUrl, limit: 50, payableOnly: false, includeTestnets: true });
  return page.items.find((r) => r.resourceUrl === resourceUrl) ?? null;
}

/** The cheapest payable offer on a resource, as a display string like `0.25 USDC · Algorand Mainnet`. */
export function describePrice(resource: BazaarResource): string {
  const offers = resource.accepts.filter(canPay);
  if (!offers.length) return 'no payable offer';
  const best = offers.reduce((a, b) => (BigInt(a.amount) <= BigInt(b.amount) ? a : b));
  const asset = describeAsset(best.network, best.asset);
  const decimals = typeof best.extra?.decimals === 'number' ? best.extra.decimals : asset.decimals;
  const whole = Number(BigInt(best.amount)) / 10 ** decimals;
  return `${whole.toLocaleString(undefined, { maximumFractionDigits: decimals })} ${asset.symbol} · ${describeNetwork(best.network).label}`;
}
