// @ts-check
// The price chart: candles, volume bars and the last price, drawn as SVG.
// Colours come from the style sheet through class names; nothing is
// styled inline.

import { clock, formatPrice } from "./units.js";

const NS = "http://www.w3.org/2000/svg";
/** Width of the price axis on the right: room for "64 000,00". */
const AXIS = 72;
/** Height of the band the volume bars stand in. */
const VOLUME_BAND = 46;
const TOP = 8;
/** Room for the time labels under the plot. */
const BOTTOM = 18;
/** Narrowest slot a candle is drawn in. */
const SLOT = 9;
/** How near to the last price's box an axis label may stand, in pixels. */
const LABEL_CLEARANCE = 18;

/**
 * @param {string} tag
 * @param {string} cls
 * @param {Record<string, number | string>} attrs
 * @returns {SVGElement}
 */
function shape(tag, cls, attrs) {
  const node = document.createElementNS(NS, tag);
  node.setAttribute("class", cls);
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, typeof value === "number" ? value.toFixed(1) : value);
  }
  return node;
}

/**
 * @param {string} cls
 * @param {number} x
 * @param {number} y
 * @param {string} anchor
 * @param {string} content
 * @returns {SVGElement}
 */
function label(cls, x, y, anchor, content) {
  const node = shape("text", cls, { x, y, "text-anchor": anchor });
  node.textContent = content;
  return node;
}

/**
 * Draws the chart into `host`, replacing what was there.
 * @param {SVGSVGElement} host
 * @param {Candle[]} candles oldest first
 * @param {bigint | null} last the last price in ticks
 * @param {Scale} scale
 * @param {string} emptyText what to say when there is nothing to draw
 */
export function drawChart(host, candles, last, scale, emptyText) {
  const width = Math.max(280, host.clientWidth);
  const height = Math.max(200, host.clientHeight);
  host.setAttribute("viewBox", `0 0 ${width} ${height}`);
  /** @type {SVGElement[]} */
  const parts = [];

  const plotW = width - AXIS;
  const plotH = height - VOLUME_BAND - TOP - BOTTOM;
  const shown = candles.slice(-Math.max(1, Math.floor(plotW / SLOT)));
  if (shown.length === 0) {
    parts.push(label("empty", width / 2, height / 2, "middle", emptyText));
    host.replaceChildren(...parts);
    return;
  }

  let lo = Infinity;
  let hi = -Infinity;
  let volumeMax = 0;
  for (const candle of shown) {
    lo = Math.min(lo, Number(candle.l));
    hi = Math.max(hi, Number(candle.h));
    volumeMax = Math.max(volumeMax, Number(candle.v));
  }
  const lastTicks = last === null ? null : Number(last);
  if (lastTicks !== null) {
    lo = Math.min(lo, lastTicks);
    hi = Math.max(hi, lastTicks);
  }
  // A flat market still gets a band to draw in.
  const pad = Math.max(2, (hi - lo) * 0.08);
  lo = Math.max(0, lo - pad);
  hi += pad;
  /** @param {number} ticks */
  const y = (ticks) => TOP + ((hi - ticks) / (hi - lo)) * plotH;

  const lastAt = lastTicks === null ? null : y(lastTicks);
  for (let line = 0; line <= 4; line += 1) {
    const ticks = lo + ((hi - lo) * line) / 4;
    parts.push(shape("line", "grid-line", { x1: 0, x2: plotW, y1: y(ticks), y2: y(ticks) }));
    // The box with the last price stands on the same axis: a label it
    // would cover is left out.
    if (lastAt === null || Math.abs(y(ticks) - lastAt) >= LABEL_CLEARANCE) {
      parts.push(label("", width - 4, y(ticks) + 4, "end", formatPrice(BigInt(Math.round(ticks)), scale)));
    }
  }

  const step = plotW / shown.length;
  const body = Math.max(3, Math.min(14, step * 0.62));
  shown.forEach((candle, index) => {
    const x = index * step + step / 2;
    const open = Number(candle.o);
    const close = Number(candle.c);
    const way = close >= open ? "up" : "down";
    parts.push(shape("line", `wick ${way}`, { x1: x, x2: x, y1: y(Number(candle.h)), y2: y(Number(candle.l)) }));
    parts.push(
      shape("rect", `body ${way}`, {
        x: x - body / 2,
        y: y(Math.max(open, close)),
        width: body,
        height: Math.max(2, Math.abs(y(open) - y(close))),
        rx: Math.min(2, body / 2),
      }),
    );
    const bar = volumeMax > 0 ? (Number(candle.v) / volumeMax) * (VOLUME_BAND - 8) : 0;
    parts.push(shape("rect", "volume", { x: x - body / 2, y: height - BOTTOM - bar, width: body, height: bar, rx: 1 }));
  });

  const labels = Math.min(4, shown.length);
  for (let slot = 0; slot < labels; slot += 1) {
    const index = Math.min(shown.length - 1, Math.floor((shown.length * (slot + 0.5)) / labels));
    const candle = shown[index];
    if (candle !== undefined) {
      parts.push(label("", index * step + step / 2, height - 3, "middle", clock(candle.t, false)));
    }
  }

  if (last !== null && lastAt !== null) {
    const at = lastAt;
    parts.push(shape("line", "last-line", { x1: 0, x2: plotW, y1: at, y2: at }));
    parts.push(shape("rect", "last-box", { x: plotW + 2, y: at - 10, width: AXIS - 4, height: 20, rx: 4 }));
    parts.push(label("last-text", width - 6, at + 4, "end", formatPrice(last, scale)));
  }
  host.replaceChildren(...parts);
}
