// @ts-check
// "Enable trading": a trading key made from an EVM wallet's signature.
//
// The wallet signs one fixed EIP-712 message. The signature is hashed
// into an ed25519 seed, so signing the same message on any device gives
// the same key and so the same exchange account. The page keeps the key
// in the browser's store, not extractable, like a key made here. That key
// can only trade and move coins of the exchange account; it controls
// nothing in the EVM wallet.

import { account, readSlot, removeSlot, writeSlot } from "./keys.js";
import { call, EvmError } from "./evm.js";
import { fromHex, toHex } from "./tx.js";

/** The text the wallet shows next to the request. */
export const ACTION = "Создать торговый ключ Tint. Подписывайте только на странице биржи.";

/** Mixed into the seed so the signature is useful for nothing else. */
const SEED_LABEL = "tint-trading-key/v1";

/** The signing wallet gave two different answers for the same message. */
export class UnstableSignatureError extends Error {
  constructor() {
    super("the wallet signs differently each time");
    this.name = "UnstableSignatureError";
  }
}

/**
 * The EIP-712 request, as `eth_signTypedData_v4` takes it. The domain has
 * no chain id on purpose: the same account results on any EVM network.
 * @param {string} address
 * @param {bigint} tintChain the exchange chain's id
 * @returns {string}
 */
export function typedData(address, tintChain) {
  return JSON.stringify({
    domain: { name: "Tint", version: "1" },
    primaryType: "TradingKey",
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
      ],
      TradingKey: [
        { name: "action", type: "string" },
        { name: "tintChain", type: "string" },
        { name: "wallet", type: "address" },
        { name: "nonce", type: "uint64" },
      ],
    },
    message: { action: ACTION, tintChain: tintChain.toString(), wallet: address.toLowerCase(), nonce: 0 },
  });
}

/**
 * ed25519 seed = SHA-256("tint-trading-key/v1" || signature).
 * @param {Uint8Array} signature the wallet's 65 bytes
 * @returns {Promise<Uint8Array>}
 */
export async function seedFrom(signature) {
  if (signature.length !== 65) {
    throw new RangeError("a signature is 65 bytes");
  }
  const label = new TextEncoder().encode(SEED_LABEL);
  const input = new Uint8Array(label.length + signature.length);
  input.set(label, 0);
  input.set(signature, label.length);
  return new Uint8Array(await crypto.subtle.digest("SHA-256", input));
}

const PKCS8_PREFIX = fromHex("302e020100300506032b657004220420") ?? new Uint8Array();

/**
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function base64url(bytes) {
  let text = "";
  for (const byte of bytes) {
    text += String.fromCharCode(byte);
  }
  return btoa(text).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * @param {string} text
 * @returns {Uint8Array}
 */
function unbase64url(text) {
  const raw = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

/**
 * The key a seed stands for: the private half cannot be exported, the
 * public half is plain bytes.
 * @param {Uint8Array} seed 32 bytes
 * @returns {Promise<{ privateKey: CryptoKey, publicKey: Uint8Array }>}
 */
export async function keyFromSeed(seed) {
  if (seed.length !== 32) {
    throw new RangeError("a seed is 32 bytes");
  }
  const pkcs8 = new Uint8Array(PKCS8_PREFIX.length + 32);
  pkcs8.set(PKCS8_PREFIX, 0);
  pkcs8.set(seed, PKCS8_PREFIX.length);
  const loose = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, ["sign"]);
  const jwk = await crypto.subtle.exportKey("jwk", loose);
  if (typeof jwk.x !== "string") {
    throw new Error("the browser gave no public key");
  }
  const publicKey = unbase64url(jwk.x);
  // The extractable copy goes out of scope here; the kept key is a new,
  // non-extractable import of the same bytes.
  const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, false, ["sign"]);
  pkcs8.fill(0);
  if (publicKey.length !== 32) {
    throw new Error("the browser made a key of the wrong size");
  }
  return { privateKey, publicKey };
}

/**
 * @param {unknown} reply
 * @returns {Uint8Array}
 */
function signatureBytes(reply) {
  const bytes = typeof reply === "string" && reply.startsWith("0x") ? fromHex(reply.slice(2)) : null;
  if (bytes === null || bytes.length !== 65) {
    throw new EvmError("bad_reply");
  }
  return bytes;
}

/**
 * Asks the wallet twice for the same signature and derives the key. Throws
 * `UnstableSignatureError` when the answers differ: such a wallet could not
 * give the same account on another device.
 * @param {import("./evm.js").EvmProvider} provider
 * @param {string} address
 * @param {bigint} tintChain
 * @returns {Promise<{ privateKey: CryptoKey, publicKey: Uint8Array }>}
 */
export async function deriveKey(provider, address, tintChain) {
  const json = typedData(address, tintChain);
  const first = signatureBytes(await call(provider, "eth_signTypedData_v4", [address, json]));
  const second = signatureBytes(await call(provider, "eth_signTypedData_v4", [address, json]));
  if (toHex(first) !== toHex(second)) {
    throw new UnstableSignatureError();
  }
  return keyFromSeed(await seedFrom(first));
}

/**
 * @param {string} address
 * @returns {string}
 */
const slot = (address) => `evm:${address.toLowerCase()}`;

/**
 * The trading key already kept for this EVM address, if any.
 * @param {string} address
 * @returns {Promise<Account | null>}
 */
export async function load(address) {
  const kept = await readSlot(slot(address));
  if (typeof kept !== "object" || kept === null) {
    return null;
  }
  const { privateKey, publicKey } = /** @type {{ privateKey?: unknown, publicKey?: unknown }} */ (kept);
  if (!(privateKey instanceof CryptoKey) || !(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
    return null;
  }
  return account(privateKey, publicKey, "evm");
}

/**
 * Derives the key (two signatures) and keeps it under the address.
 * @param {import("./evm.js").EvmProvider} provider
 * @param {string} address
 * @param {bigint} tintChain
 * @returns {Promise<Account>}
 */
export async function enable(provider, address, tintChain) {
  const { privateKey, publicKey } = await deriveKey(provider, address, tintChain);
  await writeSlot(slot(address), { privateKey, publicKey });
  return account(privateKey, publicKey, "evm");
}

/**
 * Forgets the kept key; signing again brings the same one back.
 * @param {string} address
 * @returns {Promise<void>}
 */
export async function forget(address) {
  await removeSlot(slot(address));
}
