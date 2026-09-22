// Parsec Wallet — Exact Money Arithmetic
//
// cypherpunk4096 commitment IV, "precision without approximation":
//
//   "Quantities that can be exact ARE exact. Full-width decimals carried end
//    to end... Rounding is a display decision, never a storage decision."
//
// JavaScript numbers are IEEE-754 doubles. `0.1 + 0.2 !== 0.3`, and every
// `parseFloat(price)` / `x * 1e6` / `.toFixed(6)` in a value path silently
// converts an exact quantity into an approximation — then rounds it into
// storage, which is the specific thing the commitment forbids.
//
// Everything here is `bigint` scaled by a declared number of decimals. No
// dependencies: this is one screen of hand-rolled arithmetic, auditable in
// place, which is commitment II as well.
//
// Convention: a value is always a pair of (scaled bigint, decimals). Algorand
// microALGO is decimals=6; USD is carried at USD_DECIMALS below.

/** Decimals used for USD amounts internally. Six is enough for sub-cent
 *  pricing and matches Algorand's own scale, so USD↔ALGO needs no rescale. */
export const USD_DECIMALS = 6;

/** Algorand's smallest unit: 1 ALGO = 1_000_000 microALGO. */
export const ALGO_DECIMALS = 6;

/** How to resolve a division that is not exact. */
export type Rounding = 'floor' | 'ceil' | 'half-up';

function pow10(n: number): bigint {
  if (n < 0) throw new RangeError(`negative decimals: ${n}`);
  return 10n ** BigInt(n);
}

/**
 * Parse a decimal string into a scaled bigint — exactly, without ever
 * constructing a float.
 *
 * Accepts an optional sign, digits, and an optional fractional part. Extra
 * fractional digits beyond `decimals` are rejected rather than silently
 * truncated: quietly dropping a digit of someone's money is precisely the
 * failure this module exists to prevent.
 */
export function parseDecimal(input: string, decimals: number): bigint {
  const s = input.trim();
  const m = /^([+-]?)(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new SyntaxError(`not a decimal number: ${JSON.stringify(input)}`);

  const [, sign, whole, frac = ''] = m;
  if (frac.length > decimals) {
    throw new RangeError(
      `${JSON.stringify(input)} has ${frac.length} decimal places; only ${decimals} are representable`,
    );
  }
  const padded = frac.padEnd(decimals, '0');
  const magnitude = BigInt(whole + padded);
  return sign === '-' ? -magnitude : magnitude;
}

/** Render a scaled bigint for display. This is the ONLY place rounding for
 *  presentation is allowed. */
export function formatDecimal(
  value: bigint,
  decimals: number,
  opts: { maxFractionDigits?: number; trim?: boolean } = {},
): string {
  const neg = value < 0n;
  const abs = neg ? -value : value;
  const scale = pow10(decimals);

  const whole = abs / scale;
  let frac = (abs % scale).toString().padStart(decimals, '0');

  const max = opts.maxFractionDigits;
  if (max !== undefined && max < frac.length) frac = frac.slice(0, max);
  if (opts.trim !== false) frac = frac.replace(/0+$/, '');

  const body = frac ? `${whole}.${frac}` : `${whole}`;
  return neg ? `-${body}` : body;
}

/**
 * (a * b) / c in one step, at full width, with explicit rounding.
 *
 * Doing this as `a * b` then `/ c` keeps every intermediate exact — bigint has
 * no overflow — so no precision is lost between the two operations.
 */
export function mulDiv(a: bigint, b: bigint, c: bigint, rounding: Rounding = 'floor'): bigint {
  if (c === 0n) throw new RangeError('division by zero');

  const numerator = a * b;
  const negative = (numerator < 0n) !== (c < 0n);
  const absNum = numerator < 0n ? -numerator : numerator;
  const absDen = c < 0n ? -c : c;

  let q = absNum / absDen;
  const r = absNum % absDen;

  if (r !== 0n) {
    if (rounding === 'ceil') q += 1n;
    else if (rounding === 'half-up' && r * 2n >= absDen) q += 1n;
  }
  return negative ? -q : q;
}

/**
 * Convert a scaled value from one decimal scale to another, exactly.
 */
export function rescale(
  value: bigint,
  fromDecimals: number,
  toDecimals: number,
  rounding: Rounding = 'floor',
): bigint {
  if (fromDecimals === toDecimals) return value;
  return toDecimals > fromDecimals
    ? value * pow10(toDecimals - fromDecimals)
    : mulDiv(value, 1n, pow10(fromDecimals - toDecimals), rounding);
}

/**
 * Apply a whole-number percentage discount exactly.
 *
 * `applyPercentOff(1_000_000n, 50)` → `500_000n`. The remainder is floored, so
 * a discount can never round *up* into charging more than the list price.
 */
export function applyPercentOff(value: bigint, percentOff: number): bigint {
  if (!Number.isInteger(percentOff)) {
    throw new RangeError(`percentOff must be a whole number, got ${percentOff}`);
  }
  if (percentOff <= 0) return value;
  if (percentOff >= 100) return 0n;
  return mulDiv(value, BigInt(100 - percentOff), 100n, 'floor');
}

/**
 * Convert a USD amount to the smallest unit of an asset, given that asset's
 * price in USD — both as scaled bigints.
 *
 * Rounds UP by default: the payer covers any remainder rather than underpaying
 * and having the payment rejected.
 */
export function usdToAssetUnits(
  usd: bigint,
  usdDecimals: number,
  assetUsdPrice: bigint,
  priceDecimals: number,
  assetDecimals: number,
  rounding: Rounding = 'ceil',
): bigint {
  if (assetUsdPrice <= 0n) throw new RangeError('asset price must be positive');
  // units = usd / price, carried at assetDecimals:
  //   (usd * 10^priceDecimals * 10^assetDecimals) / (price * 10^usdDecimals)
  return mulDiv(
    usd * pow10(priceDecimals),
    pow10(assetDecimals),
    assetUsdPrice * pow10(usdDecimals),
    rounding,
  );
}
