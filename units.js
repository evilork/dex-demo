// @ts-check
// Numbers as the terminal shows and reads them. Every amount is a BigInt
// in base units (or lots, or ticks); nothing here goes through a float.

const GROUP = " ";

/**
 * Ten to the power `n`.
 * @param {number} n
 * @returns {bigint}
 */
export function pow10(n) {
  return 10n ** BigInt(Math.max(0, n));
}

/**
 * `amount / 10^decimals` as text with `shown` digits after the comma,
 * rounded towards zero, digits grouped by three.
 * @param {bigint} amount
 * @param {number} decimals
 * @param {number} shown
 * @returns {string}
 */
export function formatUnits(amount, decimals, shown) {
  const negative = amount < 0n;
  let value = negative ? -amount : amount;
  value = shown < decimals ? value / pow10(decimals - shown) : value * pow10(shown - decimals);
  const digits = value.toString().padStart(shown + 1, "0");
  const whole = digits.slice(0, digits.length - shown).replace(/\B(?=(\d{3})+$)/g, GROUP);
  const fraction = shown > 0 ? "," + digits.slice(digits.length - shown) : "";
  return (negative && value > 0n ? "−" : "") + whole + fraction;
}

/**
 * Reads a decimal number a person typed (comma or dot, spaces allowed)
 * as base units. Digits beyond `decimals` are cut, never rounded up.
 * `null` if the text is not a number.
 * @param {string} text
 * @param {number} decimals
 * @returns {bigint | null}
 */
export function parseUnits(text, decimals) {
  const clean = text.replace(/[\s  ]/g, "").replace(",", ".");
  const match = /^(\d{0,18})(?:\.(\d{0,18}))?$/.exec(clean);
  if (!match) {
    return null;
  }
  const whole = match[1] ?? "";
  const fraction = match[2] ?? "";
  if (whole === "" && fraction === "") {
    return null;
  }
  return BigInt((whole === "" ? "0" : whole) + fraction.slice(0, decimals).padEnd(decimals, "0"));
}

/**
 * How many digits after the comma a value that moves in steps of `step`
 * base units needs, for a coin of `decimals` digits.
 * @param {bigint} step
 * @param {number} decimals
 * @returns {number}
 */
export function digitsFor(step, decimals) {
  let digits = decimals;
  let rest = step;
  while (digits > 0 && rest > 0n && rest % 10n === 0n) {
    rest /= 10n;
    digits -= 1;
  }
  return digits;
}

/**
 * Quote base units that one whole base coin costs at a price of one
 * tick.
 * @param {Scale} scale
 * @returns {bigint}
 */
function priceStep(scale) {
  return (scale.tick * pow10(scale.baseDecimals)) / scale.lot;
}

/**
 * Digits after the comma in a price.
 * @param {Scale} scale
 * @returns {number}
 */
export function priceDigits(scale) {
  return digitsFor(priceStep(scale), scale.quoteDecimals);
}

/**
 * Digits after the comma in a quantity.
 * @param {Scale} scale
 * @returns {number}
 */
export function qtyDigits(scale) {
  return digitsFor(scale.lot, scale.baseDecimals);
}

/**
 * A price in ticks as quote coins per whole base coin.
 * @param {bigint} ticks
 * @param {Scale} scale
 * @returns {string}
 */
export function formatPrice(ticks, scale) {
  const units = (ticks * scale.tick * pow10(scale.baseDecimals)) / scale.lot;
  return formatUnits(units, scale.quoteDecimals, priceDigits(scale));
}

/**
 * A quantity in lots as base coins.
 * @param {bigint} lots
 * @param {Scale} scale
 * @returns {string}
 */
export function formatQty(lots, scale) {
  return formatUnits(lots * scale.lot, scale.baseDecimals, qtyDigits(scale));
}

/**
 * Reads a typed price as ticks, rounded down to the price step. `null`
 * if it is not a number.
 * @param {string} text
 * @param {Scale} scale
 * @returns {bigint | null}
 */
export function parsePrice(text, scale) {
  const units = parseUnits(text, scale.quoteDecimals);
  if (units === null) {
    return null;
  }
  const whole = scale.tick * pow10(scale.baseDecimals);
  return whole === 0n ? null : (units * scale.lot) / whole;
}

/**
 * Reads a typed quantity as lots, rounded down to the lot. `null` if it
 * is not a number.
 * @param {string} text
 * @param {Scale} scale
 * @returns {bigint | null}
 */
export function parseQty(text, scale) {
  const units = parseUnits(text, scale.baseDecimals);
  return units === null || scale.lot === 0n ? null : units / scale.lot;
}

/**
 * Quote base units that `lots` cost at `ticks`.
 * @param {bigint} lots
 * @param {bigint} ticks
 * @param {Scale} scale
 * @returns {bigint}
 */
export function quoteFor(lots, ticks, scale) {
  return lots * ticks * scale.tick;
}

/**
 * The most lots `quote` base units buy at `ticks`.
 * @param {bigint} quote
 * @param {bigint} ticks
 * @param {Scale} scale
 * @returns {bigint}
 */
export function lotsFor(quote, ticks, scale) {
  const each = ticks * scale.tick;
  return each > 0n ? quote / each : 0n;
}

/**
 * A fee of `ppm` millionths of `amount`, rounded up: the most it can be.
 * @param {bigint} amount
 * @param {bigint} ppm
 * @returns {bigint}
 */
export function feeOn(amount, ppm) {
  return (amount * ppm + 999_999n) / 1_000_000n;
}

/**
 * The change from `then` to `now` in percent with two digits, signed,
 * like "+2,14 %". `null` when there is nothing to compare with.
 * @param {bigint} now
 * @param {bigint} then
 * @returns {string | null}
 */
export function change(now, then) {
  if (then <= 0n) {
    return null;
  }
  const hundredths = ((now - then) * 10_000n) / then;
  const sign = hundredths > 0n ? "+" : "";
  return sign + formatUnits(hundredths, 2, 2) + " %";
}

/**
 * The start and the end of a long hex string.
 * @param {string} hex
 * @returns {string}
 */
export function shortHex(hex) {
  return hex.length <= 12 ? hex : hex.slice(0, 4) + "…" + hex.slice(-4);
}

/**
 * @param {number} value
 * @returns {string}
 */
function two(value) {
  return String(value).padStart(2, "0");
}

/**
 * The time of day of a moment, by the browser's clock.
 * @param {number} ms Unix milliseconds
 * @param {boolean} seconds
 * @returns {string}
 */
export function clock(ms, seconds) {
  const date = new Date(ms);
  const text = two(date.getHours()) + ":" + two(date.getMinutes());
  return seconds ? text + ":" + two(date.getSeconds()) : text;
}
