// @ts-check
// The exchange's transactions: bytes, identifier, signature. The format
// is the node's (dex/entry/src/tx.rs); the test vectors in ../test are
// made by the node's own code and keep the two from drifting apart.

import { blake2b } from "./blake2b.js";

const VERSION = 1;
const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = 0xffff_ffff;
const PERSONAL = new TextEncoder().encode("TintDex_TxId___1");

const ACTION_PLACE = 0;
const ACTION_CANCEL = 1;
const ACTION_CANCEL_ALL = 2;
const ACTION_REPLACE = 3;
const ACTION_PLACE_WITH_ID = 4;
const ACTION_REPLACE_WITH_ID = 5;
const ACTION_CANCEL_BY_CLIENT_ID = 6;
const ACTION_SET_DEADMAN = 7;
const KIND_LIMIT = 0;
const KIND_MARKET = 1;
const KIND_MARKET_WITH_WORST = 2;

/** @type {Record<Side, number>} */
const SIDES = { buy: 0, sell: 1 };
/** @type {Record<TimeInForce, number>} */
const TIFS = { gtc: 0, ioc: 1, fok: 2, post_only: 3 };
/** @type {Record<SelfTrade, number>} */
const SELF_TRADES = { cancel_resting: 0, cancel_incoming: 1, cancel_both: 2 };

/** Collects a transaction's bytes. */
class Writer {
  constructor() {
    /** @type {number[]} */
    this.bytes = [];
  }

  /** @param {number} value */
  u8(value) {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new RangeError("a byte is 0 to 255");
    }
    this.bytes.push(value);
  }

  /** @param {number} value */
  u32(value) {
    if (!Number.isInteger(value) || value < 0 || value > U32_MAX) {
      throw new RangeError("the number does not fit 32 bits");
    }
    for (let shift = 0; shift < 32; shift += 8) {
      this.bytes.push(Math.floor(value / 2 ** shift) % 256);
    }
  }

  /** @param {bigint} value */
  u64(value) {
    if (typeof value !== "bigint" || value < 0n || value > U64_MAX) {
      throw new RangeError("the number does not fit 64 bits");
    }
    for (let shift = 0n; shift < 64n; shift += 8n) {
      this.bytes.push(Number((value >> shift) & 0xffn));
    }
  }

  /** @param {Uint8Array} value */
  raw(value) {
    for (const byte of value) {
      this.bytes.push(byte);
    }
  }
}

/**
 * The client order id as the format wants it: absent or 0n means none.
 * @param {bigint | undefined} clientId
 * @returns {bigint}
 */
function clientIdOf(clientId) {
  const id = clientId ?? 0n;
  if (typeof id !== "bigint" || id < 0n || id > U64_MAX) {
    throw new RangeError("the client order id does not fit 64 bits");
  }
  return id;
}

/**
 * @param {Writer} out
 * @param {Action} action
 */
function encodeAction(out, action) {
  switch (action.type) {
    case "place": {
      const clientId = clientIdOf(action.clientId);
      if (clientId === 0n) {
        out.u8(ACTION_PLACE);
      } else {
        out.u8(ACTION_PLACE_WITH_ID);
        out.u64(clientId);
      }
      out.u32(action.market);
      out.u8(SIDES[action.side]);
      out.u64(action.lots);
      const order = action.order;
      switch (order.kind) {
        case "limit":
          out.u8(KIND_LIMIT);
          out.u64(order.ticks);
          out.u8(TIFS[order.tif]);
          break;
        case "market":
          out.u8(KIND_MARKET);
          break;
        case "market_worst":
          out.u8(KIND_MARKET_WITH_WORST);
          out.u64(order.ticks);
          break;
        default:
          throw new RangeError("unknown kind of order");
      }
      out.u8(SELF_TRADES[action.selfTrade ?? "cancel_resting"]);
      break;
    }
    case "cancel":
      out.u8(ACTION_CANCEL);
      out.u64(action.order);
      break;
    case "cancel_all":
      out.u8(ACTION_CANCEL_ALL);
      out.u32(action.market);
      break;
    case "replace": {
      const clientId = clientIdOf(action.clientId);
      if (clientId === 0n) {
        out.u8(ACTION_REPLACE);
      } else {
        out.u8(ACTION_REPLACE_WITH_ID);
        out.u64(clientId);
      }
      out.u64(action.order);
      out.u64(action.ticks);
      out.u64(action.lots);
      out.u8(action.postOnly ? 1 : 0);
      out.u8(SELF_TRADES[action.selfTrade ?? "cancel_resting"]);
      break;
    }
    case "cancel_by_client_id": {
      const clientId = clientIdOf(action.clientId);
      if (clientId === 0n) {
        throw new RangeError("a client order id of 0 means none; there is nothing to cancel by it");
      }
      out.u8(ACTION_CANCEL_BY_CLIENT_ID);
      out.u64(clientId);
      break;
    }
    case "set_deadman":
      out.u8(ACTION_SET_DEADMAN);
      out.u64(action.deadline);
      break;
    default:
      throw new RangeError("unknown action");
  }
}

/**
 * The bytes a transaction is identified and signed by.
 * @param {Tx} tx
 * @returns {Uint8Array}
 */
export function encodeUnsigned(tx) {
  if (!(tx.account instanceof Uint8Array) || tx.account.length !== 32) {
    throw new RangeError("the account is 32 bytes");
  }
  const out = new Writer();
  out.u8(VERSION);
  out.raw(tx.account);
  out.u64(tx.nonce);
  out.u64(tx.expiresAt);
  encodeAction(out, tx.action);
  return Uint8Array.from(out.bytes);
}

/**
 * A transaction's identifier on a chain: what the account signs, and
 * what the node reports the outcome under.
 * @param {bigint} chainId
 * @param {Uint8Array} unsigned
 * @returns {Uint8Array}
 */
export function txId(chainId, unsigned) {
  const chain = new Writer();
  chain.u64(chainId);
  const input = new Uint8Array(8 + unsigned.length);
  input.set(chain.bytes, 0);
  input.set(unsigned, 8);
  return blake2b(input, 32, PERSONAL);
}

/**
 * Signs a transaction for a chain.
 * @param {bigint} chainId
 * @param {Tx} tx
 * @param {Signer} sign
 * @returns {Promise<{ id: string, bytes: Uint8Array }>} the identifier in
 * hex and the bytes to submit
 */
export async function signTx(chainId, tx, sign) {
  const unsigned = encodeUnsigned(tx);
  const id = txId(chainId, unsigned);
  const signature = await sign(id, unsigned);
  if (signature.length !== 64) {
    throw new RangeError("the signature is 64 bytes");
  }
  const bytes = new Uint8Array(unsigned.length + 64);
  bytes.set(unsigned, 0);
  bytes.set(signature, unsigned.length);
  return { id: toHex(id), bytes };
}

/**
 * A number nobody else is likely to pick: it tells two otherwise equal
 * orders apart.
 * @returns {bigint}
 */
export function randomNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }
  return value;
}

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function toHex(bytes) {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * @param {string} hex
 * @returns {Uint8Array | null} `null` if the text is not hex
 */
export function fromHex(hex) {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    return null;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
