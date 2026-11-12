// @ts-check
// A pretend EVM wallet for the demo copy, so the connect flow can be tried
// without installing one. It is offered ONLY on a demo page (see
// `offerDemoWallet`), and only when no real wallet announced itself. Its
// secret is random, kept in this browser, and worth nothing: the address
// starts with `dead00` on purpose.

import { toHex } from "./tx.js";

/** Where the demo wallet's secret is kept. */
const STORE_KEY = "tint-demo-wallet";
/** The test network the demo's withdrawals name (Sepolia). */
const CHAIN_HEX = "0xaa36a7";

/** @returns {string} 64 hex digits */
function randomSecret() {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/**
 * The kept secret, made on first use. A browser without storage gets one
 * that lasts until the page is closed.
 * @param {Pick<Storage, "getItem" | "setItem"> | null} storage
 * @returns {string}
 */
export function secretFrom(storage) {
  try {
    const kept = storage?.getItem(STORE_KEY) ?? null;
    if (kept !== null && /^[0-9a-f]{64}$/.test(kept)) {
      return kept;
    }
    const made = randomSecret();
    storage?.setItem(STORE_KEY, made);
    return made;
  } catch {
    return randomSecret();
  }
}

/**
 * @param {string} text
 * @returns {Promise<Uint8Array>} SHA-256
 */
async function sha256(text) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
}

/**
 * The address a secret stands for: obviously fake, never a real one.
 * @param {string} secret
 * @returns {Promise<string>}
 */
export async function addressOf(secret) {
  const hash = await sha256(`tint-demo-wallet/address/${secret}`);
  return `0xdead00${toHex(hash.subarray(0, 17))}`;
}

/**
 * A fixed 65-byte "signature" for a message: the same secret and message
 * always give the same bytes, so the trading key comes out the same.
 * @param {string} secret
 * @param {string} message
 * @returns {Promise<string>} 0x and 130 hex digits
 */
export async function signatureFor(secret, message) {
  const first = await sha256(`tint-demo-wallet/sign/1/${secret}/${message}`);
  const second = await sha256(`tint-demo-wallet/sign/2/${secret}/${message}`);
  const out = new Uint8Array(65);
  out.set(first, 0);
  out.set(second, 32);
  out[64] = 0x1b;
  return `0x${toHex(out)}`;
}

/**
 * The fake EIP-1193 provider.
 * @param {string} secret
 * @returns {import("./evm.js").EvmProvider}
 */
export function demoProvider(secret) {
  return {
    request: async ({ method, params = [] }) => {
      const address = await addressOf(secret);
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [address];
        case "eth_chainId":
          return CHAIN_HEX;
        case "wallet_switchEthereumChain":
          return null;
        case "eth_signTypedData_v4": {
          const [from, json] = params;
          if (typeof from !== "string" || from.toLowerCase() !== address || typeof json !== "string") {
            throw Object.assign(new Error("bad request"), { code: -32602 });
          }
          return signatureFor(secret, json);
        }
        default:
          throw Object.assign(new Error("not supported by the demo wallet"), { code: 4200 });
      }
    },
    on: () => undefined,
    removeListener: () => undefined,
  };
}

/**
 * The demo wallet as the connect list shows it.
 * @param {Pick<Storage, "getItem" | "setItem"> | null} storage
 * @returns {import("./evm.js").EvmWallet}
 */
export function demoWallet(storage) {
  return {
    id: "tint.demo-wallet",
    name: "Демо-кошелёк (только в демо)",
    icon: null,
    provider: demoProvider(secretFrom(storage)),
  };
}

/**
 * The wallets to offer: the real ones, or on a demo page, when there is
 * none, the pretend one. Outside a demo this returns `found` unchanged.
 * @param {import("./evm.js").EvmWallet[]} found
 * @param {boolean} demo whether the page is a demo copy
 * @param {Pick<Storage, "getItem" | "setItem"> | null} storage
 * @returns {import("./evm.js").EvmWallet[]}
 */
export function offerDemoWallet(found, demo, storage) {
  return demo && found.length === 0 ? [demoWallet(storage)] : found;
}

