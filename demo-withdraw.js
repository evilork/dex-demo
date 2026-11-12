// @ts-check
// The demo copy's stand-in for the withdrawal relay. It keeps the real
// relay's contract (field names, error codes, what `checkPrepared`
// checks) so the page's whole withdrawal flow can be tried, but nothing
// leaves the page: a "withdrawal" only lowers the demo balance.

import { fromHex, toHex } from "./tx.js";
import { EXCHANGE_DECIMALS, expiryAhead, withdrawalMessage, withdrawalSighash } from "./withdraw.js";

/** The test network the demo pays out on (Sepolia). */
export const DEMO_EVM_CHAIN = 11155111;
const U64_MAX = (1n << 64n) - 1n;

/**
 * The demo's tokens, made-up addresses on purpose. Only coins the seed's
 * `info` lists are offered.
 * @type {readonly { asset: number, token: string, decimals: number, fee: bigint, minimum: bigint, maximum: bigint, granularity: bigint }[]}
 */
const TOKENS = [
  { asset: 1, token: `0x${"0".repeat(39)}1`, decimals: 6, fee: 100_000n, minimum: 1_000_000n, maximum: 1_000_000_000n, granularity: 10_000n },
  { asset: 3, token: `0x${"0".repeat(39)}2`, decimals: 18, fee: 10_000n, minimum: 10n ** 15n, maximum: 10n ** 19n, granularity: 10n ** 12n },
];

/**
 * @typedef {object} Prepared
 * @property {string} account
 * @property {number} asset
 * @property {bigint} amount
 * @property {Uint8Array} sighash
 * @property {number} expiry
 */

/**
 * What the demo ledger must hold for withdrawals.
 * @typedef {object} Ledger
 * @property {Record<string, unknown>} info
 * @property {number} height
 * @property {number} interval
 * @property {Map<number, bigint>} initial what a new demo account holds, per coin
 * @property {Map<string, Map<number, bigint>>} free per account, per coin
 * @property {Map<string, Record<string, unknown>[]>} transfers per account
 * @property {Map<string, Prepared>} prepared by id, until used
 */

/**
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
function fail(status, code, message) {
  // The real relay's shape: a flat error.
  return { status, body: { error: code, message } };
}

/**
 * @param {Ledger} ledger
 * @returns {number[]} the coins the seed lists
 */
function listedAssets(ledger) {
  const assets = Array.isArray(ledger.info.assets) ? ledger.info.assets : [];
  return assets.flatMap((a) => (typeof a === "object" && a !== null && typeof (/** @type {{ id?: unknown }} */ (a)).id === "number" ? [/** @type {{ id: number }} */ (a).id] : []));
}

/**
 * The demo balance of an account's coin.
 * @param {Ledger} ledger
 * @param {string} account
 * @param {number} asset
 * @returns {bigint}
 */
function freeOf(ledger, account, asset) {
  return coinsOf(ledger, account).get(asset) ?? 0n;
}

/**
 * An account's coins: the account's own, or the start every account has.
 * @param {Ledger} ledger
 * @param {string} account
 * @returns {Map<number, bigint>}
 */
export function coinsOf(ledger, account) {
  let coins = ledger.free.get(account);
  if (coins === undefined) {
    coins = new Map(ledger.initial);
    ledger.free.set(account, coins);
  }
  return coins;
}

/**
 * @param {Ledger} ledger
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
export function networks(ledger) {
  const offered = listedAssets(ledger);
  return {
    status: 200,
    body: {
      networks: [
        {
          chain_id: DEMO_EVM_CHAIN,
          tokens: TOKENS.filter((t) => offered.includes(t.asset)).map((t) => ({
            asset: t.asset,
            token: t.token,
            decimals: t.decimals,
            fee: t.fee.toString(),
            rule: { minimum: t.minimum.toString(), maximum: t.maximum.toString(), granularity: t.granularity.toString() },
          })),
        },
      ],
    },
  };
}

/**
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
function object(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : null;
}

/**
 * The same refusals, in the same order, as the relay's `prepare`.
 * @param {Ledger} ledger
 * @param {unknown} body
 * @returns {{ status: number, body: Record<string, unknown> }}
 */
export function prepare(ledger, body) {
  const req = object(body);
  if (req === null) {
    return fail(400, "bad_request", "the body is not an object");
  }
  const { asset, amount, account, chain_id: chain, to } = req;
  if (
    typeof asset !== "number" || !Number.isInteger(asset) || asset < 0 ||
    typeof amount !== "string" || !/^\d{1,20}$/.test(amount) || BigInt(amount) > U64_MAX ||
    typeof chain !== "number" ||
    typeof to !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(to)
  ) {
    return fail(400, "bad_request", "a field is missing or malformed");
  }
  if (typeof account !== "string" || !/^[0-9a-f]{64}$/.test(account)) {
    return fail(400, "not_a_key", "the account is not a 32-byte key in hex");
  }
  if (chain !== DEMO_EVM_CHAIN) {
    return fail(404, "unknown_network", "the demo pays out on Sepolia only");
  }
  const token = TOKENS.find((t) => t.asset === asset && listedAssets(ledger).includes(asset));
  if (token === undefined) {
    return fail(404, "unknown_coin", "this coin cannot be withdrawn to that network");
  }
  const total = BigInt(amount);
  if (total <= token.fee) {
    return fail(422, "too_small", "the amount does not cover the fee");
  }
  const receive = total - token.fee;
  const scale = 10n ** BigInt(Math.abs(token.decimals - EXCHANGE_DECIMALS));
  if (token.decimals < EXCHANGE_DECIMALS && receive % scale !== 0n) {
    return fail(422, "inexact_amount", "the amount does not convert exactly to the token");
  }
  const tokenAmount = token.decimals < EXCHANGE_DECIMALS ? receive / scale : receive * scale;
  if (tokenAmount < token.minimum) {
    return fail(422, "below_minimum", "below the minimum");
  }
  if (tokenAmount > token.maximum) {
    return fail(422, "above_maximum", "above the maximum");
  }
  if (tokenAmount % token.granularity !== 0n) {
    return fail(422, "bad_granularity", "not a multiple of the step");
  }
  if (freeOf(ledger, account, asset) < total) {
    return fail(422, "insufficient_funds", "the account holds too little");
  }
  const chainId = BigInt(String(ledger.info.chain_id ?? "0"));
  const expiry = ledger.height + Math.max(1, Math.floor(expiryAhead(ledger.interval) / 2));
  const commitment = crypto.getRandomValues(new Uint8Array(32));
  const sighash = withdrawalSighash({
    chainId,
    asset,
    expiryHeight: BigInt(expiry),
    commitment,
    account: fromHex(account) ?? new Uint8Array(32),
    amount: total,
  });
  const id = toHex(crypto.getRandomValues(new Uint8Array(16)));
  ledger.prepared.set(id, { account, asset, amount: total, sighash, expiry });
  return {
    status: 200,
    body: {
      id,
      sighash: toHex(sighash),
      bundle_commitment: toHex(commitment),
      expiry_height: expiry,
      tint_chain_id: chainId.toString(),
      asset,
      amount,
      fee: token.fee.toString(),
      receive: receive.toString(),
      token: token.token,
      decimals: token.decimals,
      token_amount: tokenAmount.toString(),
    },
  };
}

/**
 * Checks the account's signature over the message the page made, then
 * lowers the demo balance and records the withdrawal.
 * @param {Ledger} ledger
 * @param {unknown} body
 * @param {number} now milliseconds
 * @returns {Promise<{ status: number, body: Record<string, unknown> }>}
 */
export async function submit(ledger, body, now) {
  const req = object(body);
  if (req === null || typeof req.id !== "string" || !/^[0-9a-f]{32}$/.test(req.id) || typeof req.signature !== "string" || !/^[0-9a-f]{128}$/.test(req.signature)) {
    return fail(400, "bad_request", "an id and a 64-byte signature are needed");
  }
  const found = ledger.prepared.get(req.id);
  if (found === undefined) {
    return fail(404, "unknown_id", "no such preparation, or it was used");
  }
  if (ledger.height > found.expiry) {
    ledger.prepared.delete(req.id);
    return fail(410, "expired", "the preparation has expired");
  }
  const signature = fromHex(req.signature);
  const publicKey = fromHex(found.account);
  let valid = false;
  try {
    if (signature !== null && publicKey !== null) {
      const key = await crypto.subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
      valid = await crypto.subtle.verify({ name: "Ed25519" }, key, signature, withdrawalMessage(found.sighash));
    }
  } catch {
    valid = false;
  }
  if (!valid) {
    return fail(400, "bad_signature", "the signature does not match");
  }
  // A preparation is good for one submit, right or wrong.
  if (ledger.prepared.get(req.id) !== found) {
    return fail(404, "unknown_id", "no such preparation, or it was used");
  }
  ledger.prepared.delete(req.id);
  const left = freeOf(ledger, found.account, found.asset);
  if (left < found.amount) {
    return fail(422, "insufficient_funds", "the account holds too little");
  }
  coinsOf(ledger, found.account).set(found.asset, left - found.amount);
  const list = ledger.transfers.get(found.account) ?? [];
  list.push({ asset: found.asset, amount: found.amount.toString(), kind: "withdrawal", height: ledger.height, time_ms: now });
  ledger.transfers.set(found.account, list);
  return { status: 200, body: { txid: toHex(found.sighash) } };
}

/**
 * Answers a withdrawal call, or null when the path is not one.
 * @param {Ledger} ledger
 * @param {string} path
 * @param {unknown} body present for POST
 * @param {number} now milliseconds
 * @returns {Promise<{ status: number, body: Record<string, unknown> } | null>}
 */
export async function withdrawReply(ledger, path, body, now) {
  if (path === "/api/v1/withdraw/networks" && body === undefined) {
    return networks(ledger);
  }
  if (path === "/api/v1/withdraw/prepare" && body !== undefined) {
    return prepare(ledger, body);
  }
  if (path === "/api/v1/withdraw/submit" && body !== undefined) {
    return submit(ledger, body, now);
  }
  return null;
}
