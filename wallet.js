// @ts-check
// The wallet as the trading account. Inside the wallet's own browser the
// page finds `window.tintWallet` (the contract is in ../WALLET.md) and
// asks it for the account and for signatures; the key stays in the
// wallet. The page trusts the wallet no further than it must: every
// signature that comes back is checked against the account before the
// transaction goes anywhere.

import { fromHex, toHex } from "./tx.js";

/** The version of the contract this page speaks. */
const VERSION = 1;
/** The event a wallet may fire if it puts the provider on the page late. */
export const READY_EVENT = "tintwallet:ready";
/** How long the wallet has to say whether the page is already connected. */
const RESTORE_TIMEOUT_MS = 3_000;

/** What a wallet may refuse with; anything else is read as `failed`. */
const CODES = new Set([
  "rejected",
  "locked",
  "not_connected",
  "wrong_chain",
  "wrong_account",
  "bad_request",
  "bad_tx",
  "unsupported",
  "busy",
]);

/** The wallet said no, or said something the page cannot use. */
export class WalletError extends Error {
  /** @param {string} code */
  constructor(code) {
    super(`the wallet: ${code}`);
    this.name = "WalletError";
    /** One of the contract's codes, or `failed`, `bad_reply`, `bad_signature`. */
    this.code = code;
  }
}

/**
 * The wallet this page was opened in, if any.
 * @param {{ tintWallet?: unknown }} [host] where to look; the page itself by default
 * @returns {WalletProvider | null}
 */
export function provider(host = globalThis) {
  const candidate = host.tintWallet;
  if (typeof candidate !== "object" || candidate === null) {
    return null;
  }
  const { version, request } = /** @type {{ version?: unknown, request?: unknown }} */ (candidate);
  if (version !== VERSION || typeof request !== "function") {
    return null;
  }
  return /** @type {WalletProvider} */ (candidate);
}

/**
 * @param {WalletProvider} wallet
 * @param {string} method
 * @param {Record<string, string>} params
 * @returns {Promise<unknown>}
 */
async function ask(wallet, method, params) {
  try {
    return await wallet.request(method, params);
  } catch (error) {
    const code = typeof error === "object" && error !== null ? /** @type {{ code?: unknown }} */ (error).code : undefined;
    throw new WalletError(typeof code === "string" && CODES.has(code) ? code : "failed");
  }
}

/**
 * @param {Uint8Array} publicKey
 * @param {Uint8Array} message
 * @param {Uint8Array} signature
 * @returns {Promise<boolean>}
 */
async function verifies(publicKey, message, signature) {
  try {
    const key = await crypto.subtle.importKey("raw", new Uint8Array(publicKey), { name: "Ed25519" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "Ed25519" }, key, new Uint8Array(signature), new Uint8Array(message));
  } catch {
    return false;
  }
}

/**
 * Reads the wallet's answer about the account.
 * @param {WalletProvider} wallet
 * @param {bigint} chainId
 * @param {unknown} reply
 * @returns {Account}
 */
function accountFrom(wallet, chainId, reply) {
  const hex = typeof reply === "object" && reply !== null ? /** @type {{ account?: unknown }} */ (reply).account : undefined;
  const publicKey = typeof hex === "string" ? fromHex(hex) : null;
  if (publicKey === null || publicKey.length !== 32) {
    throw new WalletError("bad_reply");
  }
  return {
    publicKey,
    hex: toHex(publicKey),
    source: "wallet",
    sign: async (id, unsigned) => {
      // The wallet gets the whole transaction, never a bare hash: it
      // shows the person what is being signed and works the identifier
      // out itself.
      const answer = await ask(wallet, "dex_sign", { chainId: chainId.toString(), tx: toHex(unsigned) });
      const text =
        typeof answer === "object" && answer !== null ? /** @type {{ signature?: unknown }} */ (answer).signature : undefined;
      const signature = typeof text === "string" ? fromHex(text) : null;
      if (signature === null || signature.length !== 64) {
        throw new WalletError("bad_reply");
      }
      if (!(await verifies(publicKey, id, signature))) {
        throw new WalletError("bad_signature");
      }
      return signature;
    },
  };
}

/**
 * The account, if the person has already let this page see it. Asks the
 * person nothing.
 * @param {WalletProvider} wallet
 * @param {bigint} chainId
 * @returns {Promise<Account | null>}
 */
export async function restore(wallet, chainId) {
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const late = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), RESTORE_TIMEOUT_MS);
  });
  try {
    const reply = await Promise.race([ask(wallet, "dex_account", { chainId: chainId.toString() }), late]);
    return reply === null || reply === undefined ? null : accountFrom(wallet, chainId, reply);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks the person, through the wallet, to let this page see the account
 * and send it transactions to sign. Throws a `WalletError` on a refusal.
 * @param {WalletProvider} wallet
 * @param {bigint} chainId
 * @returns {Promise<Account>}
 */
export async function connect(wallet, chainId) {
  return accountFrom(wallet, chainId, await ask(wallet, "dex_connect", { chainId: chainId.toString() }));
}
