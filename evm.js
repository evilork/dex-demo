// @ts-check
// Injected EVM wallets (EIP-1193 providers found through EIP-6963) and the
// plain byte work around them: the bridge's calldata, the exchange target
// a deposit names, and exact decimal amounts. No library: the encoder is
// a few lines and is checked against foundry's `cast` in the tests.

import { toHex } from "./tx.js";

/**
 * @typedef {object} EvmProvider
 * @property {(args: { method: string, params?: unknown[] }) => Promise<unknown>} request
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} [on]
 * @property {(event: string, listener: (...args: any[]) => void) => unknown} [removeListener]
 */

/**
 * @typedef {object} EvmWallet
 * @property {string} id the wallet's reverse-DNS name, or "injected"
 * @property {string} name
 * @property {string | null} icon a `data:image/` address, or null
 * @property {EvmProvider} provider
 */

/** How long to wait for wallets to announce themselves. */
export const ANNOUNCE_MS = 300;

/**
 * @param {unknown} value
 * @returns {value is EvmProvider}
 */
function isProvider(value) {
  return typeof value === "object" && value !== null && typeof /** @type {{ request?: unknown }} */ (value).request === "function";
}

/**
 * An icon is used only if it is an image carried in the address itself;
 * anything else could make the page fetch from somewhere.
 * @param {unknown} value
 * @returns {string | null}
 */
export function safeIcon(value) {
  if (typeof value !== "string" || value.length > 200_000) {
    return null;
  }
  return /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml|avif)[;,]/i.test(value) ? value : null;
}

/**
 * Finds the wallets installed in the browser. Wallets that follow
 * EIP-6963 are listed by name; if none announces itself in time and the
 * page has `window.ethereum`, that one is offered as a browser wallet.
 * @param {{ addEventListener: Function, removeEventListener: Function, dispatchEvent: Function, ethereum?: unknown }} host
 * @param {number} [wait]
 * @returns {Promise<EvmWallet[]>}
 */
export function discover(host, wait = ANNOUNCE_MS) {
  return new Promise((resolve) => {
    /** @type {Map<string, EvmWallet>} */
    const found = new Map();
    /** @param {unknown} event */
    const heard = (event) => {
      const detail = /** @type {{ detail?: { info?: Record<string, unknown>, provider?: unknown } }} */ (event).detail;
      const info = detail?.info;
      if (typeof info !== "object" || info === null || !isProvider(detail?.provider)) {
        return;
      }
      const rdns = typeof info.rdns === "string" ? info.rdns : "";
      const uuid = typeof info.uuid === "string" ? info.uuid : "";
      const name = typeof info.name === "string" ? info.name.trim().slice(0, 40) : "";
      const id = rdns || uuid;
      if (id === "" || name === "") {
        return;
      }
      // One wallet may announce under several uuids (or twice); the
      // reverse-DNS name, when it has one, is the wallet.
      if (!found.has(id) && !(uuid !== "" && found.has(uuid))) {
        found.set(id, { id, name, icon: safeIcon(info.icon), provider: detail.provider });
      }
    };
    host.addEventListener("eip6963:announceProvider", heard);
    host.dispatchEvent(new Event("eip6963:requestProvider"));
    setTimeout(() => {
      host.removeEventListener("eip6963:announceProvider", heard);
      const list = [...found.values()];
      if (list.length === 0 && isProvider(host.ethereum)) {
        list.push({ id: "injected", name: "Браузерный кошелёк", icon: null, provider: host.ethereum });
      }
      resolve(list);
    }, wait);
  });
}

/** What a wallet's error says, read as a person would need it. */
export class EvmError extends Error {
  /**
   * @param {"rejected" | "pending" | "unsupported" | "failed" | "bad_reply"} code
   * @param {unknown} [cause]
   */
  constructor(code, cause) {
    super(`the EVM wallet: ${code}`);
    this.name = "EvmError";
    this.code = code;
    this.cause = cause;
  }
}

/**
 * @param {EvmProvider} provider
 * @param {string} method
 * @param {unknown[]} [params]
 * @returns {Promise<unknown>}
 */
export async function call(provider, method, params = []) {
  try {
    return await provider.request({ method, params });
  } catch (error) {
    const code = typeof error === "object" && error !== null ? /** @type {{ code?: unknown }} */ (error).code : undefined;
    if (code === 4001) {
      throw new EvmError("rejected", error);
    }
    if (code === -32002) {
      throw new EvmError("pending", error);
    }
    if (code === 4200 || code === -32601) {
      throw new EvmError("unsupported", error);
    }
    throw new EvmError("failed", error);
  }
}

/**
 * The first account of a wallet's answer, lower-cased, or null.
 * @param {unknown} reply
 * @returns {string | null}
 */
export function firstAddress(reply) {
  if (!Array.isArray(reply) || typeof reply[0] !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(reply[0])) {
    return null;
  }
  return reply[0].toLowerCase();
}

/**
 * Asks the person to let the page see an account.
 * @param {EvmProvider} provider
 * @returns {Promise<string>}
 */
export async function requestAddress(provider) {
  const address = firstAddress(await call(provider, "eth_requestAccounts"));
  if (address === null) {
    throw new EvmError("bad_reply");
  }
  return address;
}

/**
 * The account the page may already see; asks the person nothing.
 * @param {EvmProvider} provider
 * @returns {Promise<string | null>}
 */
export async function knownAddress(provider) {
  try {
    return firstAddress(await call(provider, "eth_accounts"));
  } catch {
    return null;
  }
}

/**
 * `0x1234…abcd`.
 * @param {string} address
 * @returns {string}
 */
export function shortAddress(address) {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

// ---- Bridge calldata ------------------------------------------------------

/** `allowance(address,address)`. */
export const ALLOWANCE = "dd62ed3e";
/** `approve(address,uint256)`. */
export const APPROVE = "095ea7b3";
/** `deposit(address,uint256,bytes)`. */
export const DEPOSIT = "49bdc2b8";

/**
 * @param {string} address
 * @returns {string} 32 bytes of hex, the address on the right
 */
function word(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    throw new RangeError("not an address");
  }
  return address.slice(2).toLowerCase().padStart(64, "0");
}

/**
 * @param {bigint} value
 * @returns {string}
 */
function uint(value) {
  if (value < 0n || value >= 1n << 256n) {
    throw new RangeError("not a uint256");
  }
  return value.toString(16).padStart(64, "0");
}

/**
 * @param {string} owner
 * @param {string} spender
 * @returns {string}
 */
export function encodeAllowance(owner, spender) {
  return `0x${ALLOWANCE}${word(owner)}${word(spender)}`;
}

/**
 * @param {string} spender
 * @param {bigint} amount
 * @returns {string}
 */
export function encodeApprove(spender, amount) {
  return `0x${APPROVE}${word(spender)}${uint(amount)}`;
}

/**
 * `deposit(address token, uint256 amount, bytes target)`: two static
 * words, the offset of the bytes (3 words in), then their length and
 * content padded to whole words.
 * @param {string} token
 * @param {bigint} amount
 * @param {Uint8Array} target
 * @returns {string}
 */
export function encodeDeposit(token, amount, target) {
  const padded = Math.ceil(target.length / 32) * 32;
  return `0x${DEPOSIT}${word(token)}${uint(amount)}${uint(96n)}${uint(BigInt(target.length))}${toHex(target).padEnd(padded * 2, "0")}`;
}

/** The exchange target's length: "TDX1", the account, seven zero bytes. */
export const TARGET_LENGTH = 43;

/**
 * Where a deposit goes on the exchange.
 * @param {Uint8Array} account the trading key's public key
 * @returns {Uint8Array}
 */
export function tintTarget(account) {
  if (account.length !== 32) {
    throw new RangeError("an account is 32 bytes");
  }
  const out = new Uint8Array(TARGET_LENGTH);
  out.set([0x54, 0x44, 0x58, 0x31], 0);
  out.set(account, 4);
  return out;
}

/**
 * Reads a decimal amount exactly, as units of the smallest part. Returns
 * null for an empty, negative, malformed, zero or too precise amount, and
 * for one that does not fit a uint256.
 * @param {string} text
 * @param {number} decimals
 * @returns {bigint | null}
 */
export function parseUnits(text, decimals) {
  const match = /^(\d{1,60})(?:[.,](\d{1,60}))?$/.exec(text.trim());
  if (match === null || !Number.isInteger(decimals) || decimals < 0 || decimals > 77) {
    return null;
  }
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) {
    return null;
  }
  const units = BigInt(match[1] + fraction.padEnd(decimals, "0"));
  return units > 0n && units < 1n << 256n ? units : null;
}

/**
 * @param {unknown} reply an `eth_call` answer holding one uint256
 * @returns {bigint | null}
 */
export function readUint(reply) {
  if (typeof reply !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(reply)) {
    return null;
  }
  return BigInt(reply);
}

/**
 * @param {number} chainId
 * @returns {string}
 */
export function chainHex(chainId) {
  return `0x${chainId.toString(16)}`;
}

/**
 * @typedef {object} BridgeToken
 * @property {string} symbol
 * @property {string} address
 * @property {number} decimals
 * @property {number} asset the exchange's id for the coin
 */

/**
 * @typedef {object} EvmNetwork
 * @property {number} chainId
 * @property {string} name
 * @property {string} contract
 * @property {number} confirmations
 * @property {readonly BridgeToken[]} tokens
 */

/**
 * Sends a deposit from the wallet: switches the chain if needed, raises
 * the allowance if it is short, then calls the bridge. Reports each step
 * through `step`. Returns the deposit's transaction hash.
 * @param {object} args
 * @param {EvmProvider} args.provider
 * @param {string} args.owner
 * @param {EvmNetwork} args.network
 * @param {BridgeToken} args.token
 * @param {bigint} args.amount
 * @param {Uint8Array} args.account the trading key's public key
 * @param {(step: "switch" | "approve" | "deposit") => void} [args.step]
 * @returns {Promise<string>}
 */
export async function deposit({ provider, owner, network, token, amount, account, step = () => {} }) {
  const target = tintTarget(account);
  const here = await call(provider, "eth_chainId");
  if (typeof here !== "string" || BigInt(here) !== BigInt(network.chainId)) {
    step("switch");
    await call(provider, "wallet_switchEthereumChain", [{ chainId: chainHex(network.chainId) }]);
  }
  const allowed = readUint(
    await call(provider, "eth_call", [{ to: token.address, data: encodeAllowance(owner, network.contract) }, "latest"]),
  );
  if (allowed === null) {
    throw new EvmError("bad_reply");
  }
  if (allowed < amount) {
    step("approve");
    const sent = await call(provider, "eth_sendTransaction", [
      { from: owner, to: token.address, data: encodeApprove(network.contract, amount) },
    ]);
    if (typeof sent !== "string") {
      throw new EvmError("bad_reply");
    }
    await mined(provider, sent);
  }
  step("deposit");
  const hash = await call(provider, "eth_sendTransaction", [
    { from: owner, to: network.contract, data: encodeDeposit(token.address, amount, target) },
  ]);
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    throw new EvmError("bad_reply");
  }
  return hash;
}

/**
 * Waits until a transaction has a receipt: the deposit must not be sent
 * before the allowance it relies on exists.
 * @param {EvmProvider} provider
 * @param {string} hash
 * @param {number} [pause] milliseconds between looks
 * @param {number} [tries]
 * @returns {Promise<void>}
 */
async function mined(provider, hash, pause = 2_000, tries = 90) {
  for (let i = 0; i < tries; i += 1) {
    const receipt = await call(provider, "eth_getTransactionReceipt", [hash]);
    if (typeof receipt === "object" && receipt !== null) {
      if (/** @type {{ status?: unknown }} */ (receipt).status === "0x0") {
        throw new EvmError("failed");
      }
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, pause));
  }
  throw new EvmError("failed");
}
