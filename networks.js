// @ts-check
// The networks the terminal can switch between, and what a switch does.
//
// Each network has a terminal of its own, at its own address. Switching
// opens that address; it never points this page at another node. So the
// browser keeps each network's trading key in that site's own store, and
// a key made on the test network can never sign on the main one.
//
// The addresses live here, in the terminal's own files, and never come
// from a node: a node that could name the main network's address could
// send people to a site of its choosing.

/** @typedef {"test" | "main"} NetworkId */

/**
 * @typedef {object} Network
 * @property {NetworkId} id
 * @property {string} label what the switch says
 * @property {string | null} url the network's terminal; null while the
 *   network is not running
 * @property {readonly import("./evm.js").EvmNetwork[]} bridge the EVM
 *   networks coins can be deposited from; empty while the bridge is not
 *   launched
 */

/** @type {readonly Network[]} */
export const NETWORKS = Object.freeze([
  Object.freeze({ id: /** @type {NetworkId} */ ("test"), label: "Тестовая", url: null, bridge: Object.freeze([]) }),
  // The bridge lists stay empty until a bridge contract is launched; an
  // entry is `{ chainId, name, contract, confirmations, tokens: [{ symbol,
  // address, decimals, asset }] }`, and it lives here, never from a node.
  // The main network is not running: there is no main Tint chain with the
  // exchange in it yet. Its address goes here once it is.
  Object.freeze({ id: /** @type {NetworkId} */ ("main"), label: "Основная", url: null, bridge: Object.freeze([]) }),
]);

/**
 * Which network a node is on, from the `network` word in its `info`. Only
 * "mainnet" is the main network; anything else, missing or unknown, is
 * the test network, so a page never claims real money by mistake.
 * @param {unknown} word
 * @returns {NetworkId}
 */
export function networkOf(word) {
  return word === "mainnet" ? "main" : "test";
}

/**
 * What choosing a network comes to.
 * - `stay`: it is the network this page is on;
 * - `closed`: the network is not running, so the page says so and stays;
 * - `open`: the page opens the network's terminal at `url`.
 * @param {readonly Network[]} networks
 * @param {NetworkId} here the network this page is on
 * @param {string} wanted
 * @returns {{ kind: "stay" } | { kind: "closed", network: Network } | { kind: "open", url: string }}
 */
export function switchTo(networks, here, wanted) {
  const network = networks.find((n) => n.id === wanted);
  if (network === undefined || network.id === here) {
    return { kind: "stay" };
  }
  const url = safeUrl(network.url);
  return url === null ? { kind: "closed", network } : { kind: "open", url };
}

/**
 * The address if it is one a switch may open: https with a host, no
 * credentials. Anything else counts as no address.
 * @param {string | null} value
 * @returns {string | null}
 */
export function safeUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    return null;
  }
  /** @type {URL} */
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname === "" || url.username !== "" || url.password !== "") {
    return null;
  }
  return url.href;
}

/**
 * The EVM networks a deposit can come from on a Tint network.
 * @param {readonly Network[]} networks
 * @param {NetworkId} id
 * @returns {readonly import("./evm.js").EvmNetwork[]}
 */
export function bridgeOf(networks, id) {
  return networks.find((n) => n.id === id)?.bridge ?? [];
}
