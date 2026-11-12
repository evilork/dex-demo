// @ts-check
// A stand-in for the node, for a copy of the terminal published without
// one. Only `demo/make.py` switches it on, by putting
// <meta name="dex-demo" content="demo-seed.json"> into the page; a page a
// node serves never has that line.
//
// It answers the API from a recording of a local node and keeps every
// market moving with made-up trades around the recorded book. It refuses
// orders and the faucet with the code `demo`: nothing leaves the page.

/** @typedef {{ t: number, o: number, h: number, l: number, c: number, v: number }} Bar */
/** @typedef {{ seq: number, price: number, lots: number, side: "buy" | "sell", time: number }} Print */
/** @typedef {{ off: number, lots: number, now: number }} Step */
/**
 * @typedef {object} Market
 * @property {number} id
 * @property {number | null} last
 * @property {Bar | null} day
 * @property {number} bid best bid in ticks
 * @property {number} spread best ask minus best bid, at least 1
 * @property {Step[]} asks offsets above the best ask
 * @property {Step[]} bids offsets below the best bid
 * @property {Print[]} trades oldest first
 * @property {Map<number, Bar[]>} candles by width in minutes
 * @property {number[]} sizes trade sizes seen in the recording
 * @property {number} seq
 */
/**
 * @typedef {object} Demo
 * @property {Record<string, unknown>} info
 * @property {Market[]} markets
 * @property {number} height
 * @property {string} root
 * @property {number} interval
 * @property {number} clock time of the last made block
 * @property {Record<string, unknown>[]} balances what a demo account holds
 */
/** @typedef {{ status: number, body: Record<string, unknown> }} Reply */

const WIDTHS = [1, 5, 15, 60];
const HOUR_MS = 3_600_000;
const MAX_CATCH_UP = 240;
const MAX_TRADES = 40;
const MAX_BARS = 120;
const TRADE_CHANCE = 0.35;
const MOVE_CHANCE = 0.12;
const REFUSAL = "Это демо без узла: заявки и тестовые монеты здесь не выдаются.";

/** @type {Promise<Demo> | null} */
let loading = null;

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function obj(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("demo seed: an object was expected");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function arr(value) {
  if (!Array.isArray(value)) {
    throw new Error("demo seed: a list was expected");
  }
  return value;
}

/**
 * A whole number from digits or a JSON number, small enough for Number.
 * @param {unknown} value
 * @returns {number}
 */
function int(value) {
  const n = typeof value === "string" && /^\d{1,16}$/.test(value) ? Number(value) : value;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw new Error("demo seed: a whole number was expected");
  }
  return n;
}

/**
 * @param {unknown} value
 * @param {number} shift
 * @returns {Bar}
 */
function bar(value, shift) {
  const b = obj(value);
  return { t: int(b.t) + shift, o: int(b.o), h: int(b.h), l: int(b.l), c: int(b.c), v: int(b.v) };
}

/** @param {Bar} b */
function barOut(b) {
  return { t: b.t, o: String(b.o), h: String(b.h), l: String(b.l), c: String(b.c), v: String(b.v) };
}

/**
 * @param {number} lots
 * @returns {number}
 */
function jitter(lots) {
  return Math.max(1, Math.round(lots * (0.8 + 0.4 * Math.random())));
}

/**
 * @param {unknown} value one market of the seed
 * @param {number} barShift moves candle times to now, whole hours
 * @param {number} timeShift moves trade times to now
 * @returns {Market}
 */
function market(value, barShift, timeShift) {
  const m = obj(value);
  const book = obj(m.book);
  /** @param {unknown} level */
  const pair = (level) => arr(level).map(int);
  const asks = arr(book.asks).map(pair);
  const bids = arr(book.bids).map(pair);
  const trades = arr(m.trades).map((item) => {
    const t = obj(item);
    const side = t.side === "sell" ? "sell" : "buy";
    return { seq: int(t.seq), price: int(t.price), lots: int(t.lots), side, time: int(t.time_ms) + timeShift };
  });
  const last = m.last_price === null ? null : int(m.last_price);
  const topAsk = asks[0]?.[0] ?? (last ?? 1) + 1;
  const topBid = bids[0]?.[0] ?? Math.max(1, topAsk - 1);
  /** @type {Map<number, Bar[]>} */
  const candles = new Map();
  const recorded = obj(m.candles);
  for (const width of WIDTHS) {
    candles.set(width, arr(recorded[String(width)]).map((item) => bar(item, barShift)));
  }
  /** @type {Print[]} */
  const prints = trades.map((t) => ({ ...t, side: /** @type {"buy" | "sell"} */ (t.side) }));
  return {
    id: int(m.id),
    last,
    day: m.day === null ? null : bar(m.day, barShift),
    bid: topBid,
    spread: Math.max(1, topAsk - topBid),
    asks: asks.map(([price = 0, lots = 1]) => ({ off: price - topAsk, lots, now: lots })),
    bids: bids.map(([price = 0, lots = 1]) => ({ off: topBid - price, lots, now: lots })),
    trades: prints,
    candles,
    sizes: trades.length > 0 ? trades.map((t) => t.lots) : [1],
    seq: trades.reduce((top, t) => Math.max(top, t.seq), 0),
  };
}

/**
 * @param {string} file
 * @returns {Promise<Demo>}
 */
async function load(file) {
  const response = await fetch(file, { cache: "no-store" });
  if (!response.ok) {
    throw new Error("demo seed: not found");
  }
  const seed = obj(await response.json());
  const info = obj(seed.info);
  const recordedAt = int(seed.time_ms);
  const now = Date.now();
  const timeShift = now - recordedAt;
  const barShift = Math.floor(timeShift / HOUR_MS) * HOUR_MS;
  const faucet = obj(info.faucet);
  return {
    info,
    markets: arr(seed.markets).map((m) => market(m, barShift, timeShift)),
    height: int(seed.height),
    root: typeof seed.state_root === "string" ? seed.state_root : "",
    interval: Math.max(50, int(info.interval_ms)),
    clock: now,
    balances: arr(faucet.coins).map((item) => {
      const coin = obj(item);
      return { asset: int(coin.asset), free: String(int(coin.amount)), locked: "0" };
    }),
  };
}

/**
 * Adds one trade to the market's candles at every width.
 * @param {Market} m
 * @param {number} price
 * @param {number} lots
 * @param {number} time
 */
function chart(m, price, lots, time) {
  for (const [width, bars] of m.candles) {
    const span = width * 60_000;
    const t = Math.floor(time / span) * span;
    const top = bars[bars.length - 1];
    if (top !== undefined && top.t === t) {
      top.h = Math.max(top.h, price);
      top.l = Math.min(top.l, price);
      top.c = price;
      top.v += lots;
    } else if (top === undefined || t > top.t) {
      bars.push({ t, o: price, h: price, l: price, c: price, v: lots });
      if (bars.length > MAX_BARS) {
        bars.shift();
      }
    }
  }
  if (m.day !== null) {
    m.day.h = Math.max(m.day.h, price);
    m.day.l = Math.min(m.day.l, price);
    m.day.c = price;
    m.day.v += lots;
  }
}

/**
 * One block in one market.
 * @param {Market} m
 * @param {number} time
 */
function step(m, time) {
  if (Math.random() < MOVE_CHANCE) {
    m.bid = Math.max(1, m.bid + (Math.random() < 0.5 ? -1 : 1));
  }
  for (const level of [...m.asks, ...m.bids]) {
    if (Math.random() < 0.2) {
      level.now = jitter(level.lots);
    }
  }
  if (Math.random() >= TRADE_CHANCE) {
    return;
  }
  const side = Math.random() < 0.5 ? "buy" : "sell";
  const price = side === "buy" ? m.bid + m.spread : m.bid;
  const size = m.sizes[Math.floor(Math.random() * m.sizes.length)] ?? 1;
  const lots = jitter(size);
  m.seq += 1;
  m.trades.push({ seq: m.seq, price, lots, side, time });
  if (m.trades.length > MAX_TRADES) {
    m.trades.shift();
  }
  m.last = price;
  chart(m, price, lots, time);
}

/**
 * Makes the blocks that are due by now.
 * @param {Demo} demo
 */
function advance(demo) {
  const now = Date.now();
  const due = Math.floor((now - demo.clock) / demo.interval);
  if (due <= 0) {
    return;
  }
  const made = Math.min(due, MAX_CATCH_UP);
  for (let k = made; k > 0; k -= 1) {
    const time = now - (k - 1) * demo.interval;
    for (const m of demo.markets) {
      step(m, time);
    }
  }
  demo.height += due;
  demo.clock += due * demo.interval;
}

/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {Reply}
 */
function refuse(status, code, message) {
  return { status, body: { error: { code, message } } };
}

/**
 * @param {Demo} demo
 * @param {URLSearchParams} query
 * @returns {Reply}
 */
function snapshot(demo, query) {
  const id = Number(query.get("market") ?? "0");
  const width = Number(query.get("interval") ?? "1");
  const m = demo.markets.find((item) => item.id === id);
  if (m === undefined) {
    return refuse(404, "unknown_market", "no such market");
  }
  const bars = m.candles.get(width);
  if (bars === undefined) {
    return refuse(400, "bad_interval", "the candle width must be 1, 5, 15 or 60");
  }
  const ask = m.bid + m.spread;
  const account = query.get("account");
  return {
    status: 200,
    body: {
      market: m.id,
      markets: demo.markets.map((item) => ({
        id: item.id,
        last_price: item.last === null ? null : String(item.last),
        day: item.day === null ? null : barOut(item.day),
      })),
      height: demo.height,
      time_ms: Date.now(),
      state_root: demo.root,
      last_price: m.last === null ? null : String(m.last),
      day: m.day === null ? null : barOut(m.day),
      book: {
        asks: m.asks.map((level) => [String(ask + level.off), String(level.now)]),
        bids: m.bids
          .filter((level) => m.bid - level.off > 0)
          .map((level) => [String(m.bid - level.off), String(level.now)]),
      },
      trades: m.trades.map((t) => ({ seq: t.seq, price: String(t.price), lots: String(t.lots), side: t.side, time_ms: t.time })),
      candles: bars.map(barOut),
      account:
        account === null
          ? null
          : { funded: true, balances: demo.balances, orders: [], fills: [], reports: [], transfers: [], faucet_wait: 0 },
    },
  };
}

/**
 * Answers one API call the way the node would.
 * @param {string} file the recording, next to the page
 * @param {string} path the API path with its query
 * @param {unknown} body present for POST
 * @returns {Promise<Reply>}
 */
export async function reply(file, path, body) {
  loading ??= load(file);
  const demo = await loading;
  advance(demo);
  const url = new URL(path, "https://demo.invalid");
  if (body !== undefined) {
    return refuse(403, "demo", REFUSAL);
  }
  if (url.pathname === "/api/v1/info") {
    return { status: 200, body: demo.info };
  }
  if (url.pathname === "/api/v1/snapshot") {
    return snapshot(demo, url.searchParams);
  }
  return refuse(404, "not_found", "no such call");
}
