// @ts-check
// The node's HTTP API, read into the terminal's own shapes. Amounts come
// as decimal strings and become BigInt here; a reply that does not have
// the expected shape is an error, not a guess.

import { networkOf } from "./networks.js";

const TIMEOUT_MS = 5_000;

/** A refusal by the node, or a failure to reach it. */
export class ApiError extends Error {
  /**
   * @param {number} status HTTP status, 0 when the node did not answer
   * @param {string} code the node's word for the reason
   * @param {string} message
   * @param {number | null} [blocks] blocks to wait, when the node says
   */
  constructor(status, code, message, blocks) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.blocks = blocks ?? null;
  }
}

/** @returns {ApiError} */
function badReply() {
  return new ApiError(0, "bad_reply", "the node's reply is not what the terminal expects");
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function record(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badReply();
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function list(value) {
  if (!Array.isArray(value)) {
    throw badReply();
  }
  return value;
}

/**
 * A whole number that came as digits or as a JSON number.
 * @param {unknown} value
 * @returns {bigint}
 */
function big(value) {
  if (typeof value === "string" && /^\d{1,20}$/.test(value)) {
    return BigInt(value);
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw badReply();
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function num(value) {
  const whole = big(value);
  if (whole > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw badReply();
  }
  return Number(whole);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function text(value) {
  if (typeof value !== "string") {
    throw badReply();
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {Side}
 */
function side(value) {
  if (value !== "buy" && value !== "sell") {
    throw badReply();
  }
  return value;
}

/**
 * @param {unknown} value
 * @returns {Candle}
 */
function candle(value) {
  const c = record(value);
  return { t: num(c.t), o: big(c.o), h: big(c.h), l: big(c.l), c: big(c.c), v: big(c.v) };
}

/**
 * @param {unknown} value
 * @returns {Level}
 */
function level(value) {
  const pair = list(value);
  return { ticks: big(pair[0]), lots: big(pair[1]) };
}

/**
 * @param {string} path
 * @param {unknown} [body] sent as JSON with POST when given
 * @returns {Promise<Record<string, unknown>>}
 */
async function call(path, body) {
  /** @type {RequestInit} */
  const init = { cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) };
  if (body !== undefined) {
    init.method = "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  /** @type {number} */
  let status;
  /** @type {unknown} */
  let parsed;
  try {
    const demo = demoSeed();
    if (demo !== null) {
      // A copy published without a node: see demo.js.
      const { reply } = await import("./demo.js");
      ({ status, body: parsed } = await reply(demo, path, body));
    } else {
      const response = await fetch(path, init);
      status = response.status;
      parsed = await response.json();
    }
  } catch {
    throw new ApiError(0, "unreachable", "the node does not answer");
  }
  const reply = record(parsed);
  if (status < 200 || status > 299) {
    const error = record(reply.error);
    const blocks = typeof error.blocks === "number" ? error.blocks : null;
    throw new ApiError(status, text(error.code), text(error.message), blocks);
  }
  return reply;
}

/**
 * Whether this page is a demo copy, which has no node.
 * @returns {boolean}
 */
export function isDemo() {
  return demoSeed() !== null;
}

/**
 * `fetch` for the terminal's own API, demo-aware: on a demo copy the call
 * is answered by demo.js (which plays the node and the withdrawal relay),
 * otherwise it goes out as it is. The answer has the parts of a Response
 * the withdrawal flow reads.
 * @param {string} path
 * @param {RequestInit} init
 * @returns {Promise<{ status: number, json: () => Promise<unknown> }>}
 */
export async function appFetch(path, init) {
  const demo = demoSeed();
  if (demo === null) {
    return fetch(path, init);
  }
  /** @type {unknown} */
  let body;
  if (init.method === "POST") {
    try {
      body = typeof init.body === "string" ? JSON.parse(init.body) : {};
    } catch {
      body = null;
    }
  }
  const { reply } = await import("./demo.js");
  const answer = await reply(demo, path, body);
  return { status: answer.status, json: async () => answer.body };
}

/**
 * The demo recording's file name when the page is a demo copy, else null.
 * Only demo/make.py writes the line this looks for.
 * @returns {string | null}
 */
function demoSeed() {
  if (typeof document === "undefined") {
    return null;
  }
  const file = document.querySelector('meta[name="dex-demo"]')?.getAttribute("content") ?? null;
  return file !== null && /^[a-z0-9-]{1,40}\.json$/.test(file) ? file : null;
}

/**
 * @param {unknown} value
 * @returns {Asset}
 */
function asset(value) {
  const a = record(value);
  const decimals = num(a.decimals);
  if (decimals > 18) {
    throw badReply();
  }
  const symbol = text(a.symbol);
  // The symbol goes into the page's address and into its text.
  if (!/^[A-Za-z0-9]{1,12}$/.test(symbol)) {
    throw badReply();
  }
  // Shown as text only, never as markup; kept short and plain all the same.
  const network = text(a.network);
  if (!/^[\p{L}\p{N}][\p{L}\p{N} .-]{0,31}$/u.test(network)) {
    throw badReply();
  }
  return { id: num(a.id), symbol, decimals, network };
}

/**
 * What the node is, its coins and how its markets count.
 * @returns {Promise<Info>}
 */
export async function getInfo() {
  const reply = await call("/api/v1/info");
  const faucet = record(reply.faucet);
  const assets = list(reply.assets).map(asset);
  /** @param {unknown} id */
  const coin = (id) => {
    const found = assets.find((a) => a.id === num(id));
    if (found === undefined) {
      throw badReply();
    }
    return found;
  };
  const markets = list(reply.markets).map((item) => {
    const market = record(item);
    const base = coin(market.base);
    const quote = coin(market.quote);
    const lot = big(market.lot_size);
    const tick = big(market.tick_size);
    if (lot === 0n || tick === 0n) {
      throw badReply();
    }
    return {
      id: num(market.id),
      base,
      quote,
      name: `${base.symbol} / ${quote.symbol}`,
      slug: `${base.symbol}-${quote.symbol}`,
      scale: { lot, tick, baseDecimals: base.decimals, quoteDecimals: quote.decimals },
      minLots: big(market.min_qty),
      makerFeePpm: big(market.maker_fee_ppm),
      takerFeePpm: big(market.taker_fee_ppm),
    };
  });
  if (markets.length === 0 || markets.length > 500) {
    throw badReply();
  }
  return {
    name: text(reply.name).slice(0, 24),
    network: networkOf(reply.network),
    chainId: big(reply.chain_id),
    intervalMs: num(reply.interval_ms),
    maxLifetime: num(reply.max_lifetime),
    assets,
    markets,
    faucet: list(faucet.coins).map((item) => {
      const gift = record(item);
      return { asset: coin(gift.asset), amount: big(gift.amount) };
    }),
  };
}

/**
 * @param {unknown} value
 * @returns {AccountView}
 */
function accountView(value) {
  const a = record(value);
  /** @type {Map<number, Balance>} */
  const balances = new Map();
  for (const item of list(a.balances)) {
    const b = record(item);
    balances.set(num(b.asset), { free: big(b.free), locked: big(b.locked) });
  }
  return {
    funded: a.funded === true,
    balances,
    orders: list(a.orders).map((item) => {
      const o = record(item);
      return {
        id: big(o.id),
        side: side(o.side),
        ticks: big(o.price),
        remaining: big(o.remaining),
        placed: o.placed === null || o.placed === undefined ? null : big(o.placed),
      };
    }),
    fills: list(a.fills).map((item) => {
      const f = record(item);
      return {
        seq: num(f.seq),
        side: side(f.side),
        ticks: big(f.price),
        lots: big(f.lots),
        fee: big(f.fee),
        feeAsset: num(f.fee_asset),
        maker: f.maker === true,
        timeMs: num(f.time_ms),
      };
    }),
    reports: list(a.reports).map((item) => {
      const r = record(item);
      const status = r.status;
      if (status !== "executed" && status !== "refused" && status !== "expired" && status !== "dropped") {
        throw badReply();
      }
      return { id: text(r.id), height: num(r.height), status, code: typeof r.code === "string" ? r.code : null };
    }),
    transfers: list(a.transfers).map((item) => {
      const t = record(item);
      return {
        asset: num(t.asset),
        amount: big(t.amount),
        deposit: t.kind === "deposit",
        height: num(t.height),
        timeMs: num(t.time_ms),
      };
    }),
    faucetWait: num(a.faucet_wait),
  };
}

/**
 * One market of the exchange at its latest block.
 * @param {number} market the market's number
 * @param {number} minutes candle width: 1, 5, 15 or 60
 * @param {string | null} account the account to report on, in hex
 * @returns {Promise<Snapshot>}
 */
export async function getSnapshot(market, minutes, account) {
  const query = new URLSearchParams({ market: String(market), interval: String(minutes) });
  if (account !== null) {
    query.set("account", account);
  }
  const reply = await call("/api/v1/snapshot?" + query.toString());
  const book = record(reply.book);
  return {
    market: num(reply.market),
    markets: list(reply.markets).map((item) => {
      const m = record(item);
      return {
        id: num(m.id),
        last: m.last_price === null ? null : big(m.last_price),
        day: m.day === null ? null : candle(m.day),
      };
    }),
    height: num(reply.height),
    timeMs: num(reply.time_ms),
    stateRoot: text(reply.state_root),
    last: reply.last_price === null ? null : big(reply.last_price),
    day: reply.day === null ? null : candle(reply.day),
    asks: list(book.asks).map(level),
    bids: list(book.bids).map(level),
    trades: list(reply.trades).map((item) => {
      const t = record(item);
      return { seq: num(t.seq), ticks: big(t.price), lots: big(t.lots), side: side(t.side), timeMs: num(t.time_ms) };
    }),
    candles: list(reply.candles).map(candle),
    account: reply.account === null ? null : accountView(reply.account),
  };
}

/**
 * Hands a signed transaction to the node.
 * @param {string} hex the signed bytes
 * @returns {Promise<string>} the identifier the node knows it by
 */
export async function sendTx(hex) {
  return text((await call("/api/v1/tx", { tx: hex })).id);
}

/**
 * Asks the node's faucet for test coins.
 * @param {string} account in hex
 * @returns {Promise<void>}
 */
export async function askFaucet(account) {
  await call("/api/v1/faucet", { account });
}
