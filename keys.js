// @ts-check
// The trading account's key. It is made by the browser, marked as not
// extractable and kept in the browser's own store (IndexedDB): the page
// can ask for a signature but cannot read the key, and nothing sends it
// anywhere. Clearing the site's data loses the key and the account.

import { toHex } from "./tx.js";

const DB_NAME = "dex-terminal";
const STORE = "keys";
const SLOT = "account";

/**
 * @template T
 * @param {IDBRequest<T>} request
 * @returns {Promise<T>}
 */
function settled(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the browser's store failed"));
  });
}

/** @returns {Promise<IDBDatabase>} */
function open() {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    request.result.createObjectStore(STORE);
  };
  return settled(request);
}

/**
 * @param {CryptoKey} privateKey
 * @param {Uint8Array} publicKey
 * @returns {Account}
 */
function account(privateKey, publicKey) {
  return {
    publicKey,
    hex: toHex(publicKey),
    source: "browser",
    sign: async (id) => {
      const data = new Uint8Array(id);
      return new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, privateKey, data));
    },
  };
}

/**
 * Whether this page may make keys at all: browsers allow it on secure
 * pages only (https, or this computer itself).
 * @returns {boolean}
 */
export function available() {
  return typeof indexedDB !== "undefined" && typeof crypto !== "undefined" && crypto.subtle !== undefined;
}

/**
 * The account kept in this browser, if there is one.
 * @returns {Promise<Account | null>}
 */
export async function load() {
  if (!available()) {
    return null;
  }
  const db = await open();
  try {
    /** @type {unknown} */
    const kept = await settled(db.transaction(STORE, "readonly").objectStore(STORE).get(SLOT));
    if (typeof kept !== "object" || kept === null) {
      return null;
    }
    const { privateKey, publicKey } = /** @type {{ privateKey?: unknown, publicKey?: unknown }} */ (kept);
    if (!(privateKey instanceof CryptoKey) || !(publicKey instanceof Uint8Array) || publicKey.length !== 32) {
      return null;
    }
    return account(privateKey, publicKey);
  } finally {
    db.close();
  }
}

/**
 * Makes a new account and keeps it in this browser, replacing the old
 * one. Throws if the browser cannot sign with Ed25519.
 * @returns {Promise<Account>}
 */
export async function create() {
  if (!available()) {
    throw new Error("this page cannot make keys");
  }
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, false, ["sign", "verify"]);
  if (!("privateKey" in pair)) {
    throw new Error("the browser made no key pair");
  }
  const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
  if (publicKey.length !== 32) {
    throw new Error("the browser made a key of the wrong size");
  }
  const db = await open();
  try {
    const store = db.transaction(STORE, "readwrite").objectStore(STORE);
    await settled(store.put({ privateKey: pair.privateKey, publicKey }, SLOT));
  } finally {
    db.close();
  }
  return account(pair.privateKey, publicKey);
}
