// @ts-check
// Choosing a pair: which pairs a search shows and in what order, which
// pair the page opens on, and what the page remembers. No page here:
// these are plain functions, so they are tested without a browser.

/** The group that shows every pair. */
export const ALL = "all";
/** The group that shows the pairs the person starred. */
export const STARRED = "starred";

/** Most starred pairs remembered. */
const MAX_STARRED = 200;

/**
 * What a person types, made comparable: capitals, with nothing but
 * letters and digits.
 * @param {string} text
 * @returns {string}
 */
function plain(text) {
  return text.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Whether a pair answers a search. "tint", "TINT/TUSD", "tint tusd",
 * "usd" and "tusdtint" all find TINT / TUSD; the name of the network the
 * base coin comes from finds it too ("solana", "bnb chain"); a search of
 * nothing finds everything.
 * @param {Market} market
 * @param {string} query
 * @returns {boolean}
 */
export function matches(market, query) {
  const wanted = plain(query);
  if (wanted === "") {
    return true;
  }
  const base = market.base.symbol.toUpperCase();
  const quote = market.quote.symbol.toUpperCase();
  return (
    (base + quote).includes(wanted) || (quote + base).includes(wanted) || plain(market.base.network).includes(wanted)
  );
}

/**
 * The groups a list of pairs can be narrowed to: all, the starred ones,
 * then each coin prices are quoted in, in the order the pairs come.
 * @param {Market[]} markets
 * @returns {string[]}
 */
export function groups(markets) {
  /** @type {string[]} */
  const quotes = [];
  for (const market of markets) {
    if (!quotes.includes(market.quote.symbol)) {
      quotes.push(market.quote.symbol);
    }
  }
  return [ALL, STARRED, ...quotes];
}

/**
 * The pairs to show: those of the group that answer the search, the
 * starred ones first, each part in the order the node lists them.
 * @param {Market[]} markets
 * @param {string} query
 * @param {string} group `ALL`, `STARRED` or a quote coin's symbol
 * @param {ReadonlySet<string>} starred slugs of the starred pairs
 * @returns {Market[]}
 */
export function shown(markets, query, group, starred) {
  const fit = markets.filter(
    (market) =>
      matches(market, query) &&
      (group === ALL || (group === STARRED ? starred.has(market.slug) : market.quote.symbol === group)),
  );
  return [...fit.filter((market) => starred.has(market.slug)), ...fit.filter((market) => !starred.has(market.slug))];
}

/**
 * The pair a slug names, whatever its case; `null` if there is none.
 * @param {Market[]} markets
 * @param {string | null | undefined} slug like "TINT-TUSD", with or without a leading "#"
 * @returns {Market | null}
 */
export function bySlug(markets, slug) {
  if (typeof slug !== "string") {
    return null;
  }
  const wanted = slug.replace(/^#/, "").toUpperCase();
  return markets.find((market) => market.slug.toUpperCase() === wanted) ?? null;
}

/**
 * The pair the page opens on: the one its address names, else the one
 * opened last time, else the first the node lists.
 * @param {Market[]} markets never empty
 * @param {string} hash the address's part after "#", with it or without
 * @param {string | null} remembered the slug kept from last time
 * @returns {Market}
 */
export function initial(markets, hash, remembered) {
  const first = markets[0];
  if (first === undefined) {
    throw new Error("the node lists no pairs");
  }
  return bySlug(markets, hash) ?? bySlug(markets, remembered) ?? first;
}

/**
 * The starred pairs as they were stored; anything that is not a list of
 * slugs reads as none.
 * @param {string | null} stored
 * @returns {Set<string>}
 */
export function readStarred(stored) {
  /** @type {Set<string>} */
  const starred = new Set();
  if (stored === null) {
    return starred;
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return starred;
  }
  if (!Array.isArray(parsed)) {
    return starred;
  }
  for (const item of parsed) {
    if (typeof item === "string" && /^[A-Za-z0-9]{1,12}-[A-Za-z0-9]{1,12}$/.test(item) && starred.size < MAX_STARRED) {
      starred.add(item);
    }
  }
  return starred;
}

/**
 * The starred pairs as they are stored.
 * @param {ReadonlySet<string>} starred
 * @returns {string}
 */
export function writeStarred(starred) {
  return JSON.stringify([...starred].slice(0, MAX_STARRED));
}

/**
 * The starred pairs with one more or one fewer.
 * @param {ReadonlySet<string>} starred
 * @param {string} slug
 * @returns {Set<string>}
 */
export function toggled(starred, slug) {
  const next = new Set(starred);
  if (!next.delete(slug)) {
    next.add(slug);
  }
  return next;
}

/**
 * The row the arrow keys move to.
 * @param {number} active the row now, -1 if none
 * @param {number} step +1 for down, -1 for up
 * @param {number} count rows in the list
 * @returns {number} -1 when the list is empty
 */
export function moved(active, step, count) {
  if (count <= 0) {
    return -1;
  }
  if (active < 0) {
    return step > 0 ? 0 : count - 1;
  }
  return (active + step + count) % count;
}
