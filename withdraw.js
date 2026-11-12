// @ts-check
// Withdrawal from the exchange to the connected EVM wallet.
//
// A relay (reached through the gateway's /api/v1/withdraw/*) builds the
// chain withdrawal; this page signs it with the trading key and the
// bridge then pays the token out on the EVM network. The relay is not
// trusted: before anything is signed the page recomputes the signature
// hash from what IT asked for (the coin, the amount, its own account,
// the chain it knows) and refuses a reply that disagrees. The bytes
// that are signed are made here, never taken from the relay.
//
// No DOM in this file: `withdraw-panel.js` draws, the tests drive it.

import { blake2b } from "./blake2b.js";
import { formatUnits, pow10, shortHex } from "./units.js";
import { fromHex, toHex } from "./tx.js";

/** Personalization of every transaction signature hash. */
const SIGHASH_PERSONAL = new TextEncoder().encode("Tint_SigHash___1");
/** Prefix of the message a withdrawal's account signature covers. */
export const WITHDRAWAL_CONTEXT = new TextEncoder().encode("Tint_ExWithdraw1");
/** `TxKind::Withdrawal.tag()` of the chain's core. */
const WITHDRAWAL_TAG = 4;
/** How many blocks ahead of the head a withdrawal may expire. */
export const MAX_EXPIRY_AHEAD = 40;
/** The chain's own limit on how far ahead a transaction may expire. */
export const MAX_EXPIRY_BLOCKS = 1_000;
/** How long a signed withdrawal may wait for its block, at most. */
const EXPIRY_WINDOW_MS = 300_000;

/**
 * How many blocks ahead of the head a withdrawal may expire.
 * @param {number | undefined} intervalMs the chain's block interval
 * @returns {number}
 */
export function expiryAhead(intervalMs) {
  if (intervalMs === undefined || !Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
    return MAX_EXPIRY_AHEAD;
  }
  return Math.min(MAX_EXPIRY_BLOCKS, Math.max(MAX_EXPIRY_AHEAD, Math.ceil(EXPIRY_WINDOW_MS / intervalMs)));
}
/** The exchange counts every coin in this many decimals. */
export const EXCHANGE_DECIMALS = 8;

const U64_MAX = (1n << 64n) - 1n;
const U32_MAX = (1n << 32n) - 1n;

/** Failures of a submit after which the node may or may not have taken the withdrawal. */
const UNKNOWN_OUTCOME = new Set(["node_unreachable", "unreachable", "relay_unreachable", "bad_relay_reply", "bad_reply"]);

const QUICK_MS = 15_000;
const PROVING_MS = 100_000;

/** A withdrawal that cannot go on; `code` is a word `explainWithdraw` knows. */
export class WithdrawError extends Error {
  /**
   * @param {string} code
   * @param {string} [detail] what exactly, for logs and tests
   * @param {string} [text] what to tell the person, when the word alone is not enough
   */
  constructor(code, detail, text) {
    super(detail ?? code);
    this.name = "WithdrawError";
    this.code = code;
    this.text = text ?? null;
  }
}

/** What each word comes to for a person. */
const REASONS = {
  no_withdrawals: "Вывод в кошелёк появится, когда мост будет запущен.",
  bad_request: "Запрос на вывод составлен неверно. Обновите страницу и попробуйте ещё раз.",
  too_large: "Запрос на вывод слишком большой. Обновите страницу и попробуйте ещё раз.",
  not_a_key: "Это не торговый ключ. Включите торговлю заново.",
  unknown_network: "Эта сеть недоступна для вывода.",
  unknown_coin: "Эту монету нельзя вывести в выбранную сеть.",
  inexact_amount: "Сеть принимает эту монету только целым числом знаков после запятой. Округлите сумму.",
  too_small: "Сумма слишком мала: она не покрывает комиссию вывода.",
  insufficient_funds: "На бирже не хватает свободных монет для этого вывода.",
  unknown_id: "Подготовка вывода устарела. Нажмите «Подготовить» ещё раз.",
  expired: "Подготовка вывода истекла. Нажмите «Подготовить» ещё раз.",
  bad_signature: "Мост не принял подпись. Нажмите «Подготовить» ещё раз.",
  busy: "Мост занят другим выводом. Подождите минуту и попробуйте снова.",
  rate_limited: "Слишком много запросов. Подождите минуту и попробуйте снова.",
  node_unreachable: "Узел сети Tint не отвечает. Попробуйте позже.",
  node_behind: "Узел моста ещё догоняет сеть Tint. Монеты не списаны, попробуйте через минуту.",
  node_refused: "Узел сети Tint не принял вывод. Монеты не списаны, попробуйте ещё раз позже.",
  relay_unreachable: "Сервис вывода не отвечает. Монеты не списаны, попробуйте позже.",
  bad_relay_reply: "Сервис вывода ответил непонятно. Монеты не списаны.",
  forbidden: "Страница не может обратиться к бирже с этого адреса.",
  unreachable: "Биржа не отвечает. Если вы уже подписали вывод, проверьте историю перед повтором.",
  bad_reply: "Сервис вывода ответил непонятно. Монеты не подписаны.",
  mismatch: "Сервис вывода предложил не то, о чём вы просили. Ничего не подписано.",
  stale: "Подготовка вывода не подходит по сроку. Нажмите «Подготовить» ещё раз.",
  bad_amount: "Введите сумму больше нуля, не более 8 знаков после запятой.",
  over_balance: "Сумма больше свободного остатка этой монеты на бирже.",
  no_key: "Включите торговлю: вывод подписывается торговым ключом.",
  no_wallet: "Подключите кошелёк EVM: вывод идёт только на него.",
  no_choice: "Выберите сеть и монету.",
  not_prepared: "Сначала нажмите «Подготовить».",
  token_closed: "Вывод этой монеты в выбранную сеть сейчас закрыт.",
  below_minimum: "Сумма меньше минимальной для вывода этой монеты.",
  above_maximum: "Сумма больше максимальной для одного вывода этой монеты.",
  bad_granularity: "Сумма за вычетом комиссии сети Tint должна делиться на шаг, указанный под полем: добавьте комиссию к круглой сумме.",
  evm_unreachable: "Сеть EVM сейчас не отвечает мосту. Монеты не списаны, попробуйте позже.",
  daily_limit: "Дневной лимит вывода исчерпан. Попробуйте завтра или выведите меньше.",
  outcome_unknown: "Не удалось узнать, принял ли узел вывод. Проверьте баланс через минуту, прежде чем выводить снова.",
  fee_exceeds_balance: "Свободных монет на бирже не хватает даже на комиссию сети Tint.",
  failed: "Не получилось вывести. Попробуйте ещё раз.",
};

/**
 * A short Russian text for any failure of the withdrawal.
 * @param {unknown} error
 * @returns {string}
 */
export function explainWithdraw(error) {
  if (error instanceof WithdrawError) {
    if (error.text !== null) {
      return error.text;
    }
    return /** @type {Record<string, string>} */ (REASONS)[error.code] ?? `Вывод не удался: ${error.code}.`;
  }
  return REASONS.failed;
}

/**
 * Typed coins as exchange units, exactly: no rounding, no cutting. `null`
 * for anything that is not a positive number with at most `decimals`
 * digits after the point, or that does not fit a `u64`.
 * @param {string} text
 * @param {number} [decimals]
 * @returns {bigint | null}
 */
export function parseAmount(text, decimals = EXCHANGE_DECIMALS) {
  const clean = text.replace(/[\s  ]/g, "").replace(",", ".");
  const match = /^(\d{1,19})(?:\.(\d{1,19}))?$|^\.(\d{1,19})$/.exec(clean);
  if (match === null) {
    return null;
  }
  const whole = match[1] ?? "0";
  const fraction = match[2] ?? match[3] ?? "";
  if (fraction.length > decimals) {
    return null;
  }
  const units = BigInt(whole) * pow10(decimals) + BigInt(fraction.padEnd(decimals, "0"));
  return units > 0n && units <= U64_MAX ? units : null;
}

/**
 * @param {bigint} value
 * @param {number} bytes
 * @returns {Uint8Array} little endian
 */
function le(value, bytes) {
  if (value < 0n || value >= 1n << BigInt(bytes * 8)) {
    throw new RangeError("the number does not fit");
  }
  const out = new Uint8Array(bytes);
  let rest = value;
  for (let i = 0; i < bytes; i += 1) {
    out[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return out;
}

/**
 * The hash both the account's key and the withdrawal's bundle sign:
 * `withdrawal_signature_hash` of the core (BLAKE2b-256, personalized).
 * @param {object} fields
 * @param {bigint} fields.chainId the exchange chain's id (u64)
 * @param {number} fields.asset the coin (u32)
 * @param {bigint} fields.expiryHeight (u64)
 * @param {Uint8Array} fields.commitment the bundle commitment, 32 bytes
 * @param {Uint8Array} fields.account the trading account, 32 bytes
 * @param {bigint} fields.amount units leaving the account (u64)
 * @returns {Uint8Array} 32 bytes
 */
export function withdrawalSighash({ chainId, asset, expiryHeight, commitment, account, amount }) {
  if (commitment.length !== 32 || account.length !== 32) {
    throw new RangeError("a commitment and an account are 32 bytes");
  }
  if (!Number.isInteger(asset) || BigInt(asset) > U32_MAX) {
    throw new RangeError("a coin id is a u32");
  }
  const parts = [
    le(chainId, 8),
    Uint8Array.of(WITHDRAWAL_TAG),
    le(BigInt(asset), 4),
    le(expiryHeight, 8),
    commitment,
    account,
    le(amount, 8),
  ];
  const input = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    input.set(part, at);
    at += part.length;
  }
  return blake2b(input, 32, SIGHASH_PERSONAL);
}

/**
 * What the trading key signs: the context, then the hash.
 * @param {Uint8Array} sighash 32 bytes
 * @returns {Uint8Array} 48 bytes
 */
export function withdrawalMessage(sighash) {
  if (sighash.length !== 32) {
    throw new RangeError("a signature hash is 32 bytes");
  }
  const message = new Uint8Array(WITHDRAWAL_CONTEXT.length + 32);
  message.set(WITHDRAWAL_CONTEXT, 0);
  message.set(sighash, WITHDRAWAL_CONTEXT.length);
  return message;
}

/**
 * @typedef {object} Rule what a token's withdrawals must keep to, in token units
 * @property {bigint} minimum
 * @property {bigint} maximum
 * @property {bigint} granularity the token amount is a multiple of this
 */

/**
 * @typedef {object} WithdrawToken
 * @property {Rule | null} rule
 * @property {bigint | null} fee Tint's withdrawal fee for the coin in exchange units, when listed
 * @property {number} asset
 * @property {string} token the token's address, 0x and 40 hex digits
 * @property {number} decimals the token's own decimals
 */

/**
 * @typedef {object} RelayNetwork
 * @property {number} chainId
 * @property {WithdrawToken[]} tokens
 */

/**
 * @typedef {object} Prepared what the relay offered and this page checked
 * @property {string} id
 * @property {Uint8Array} sighash computed here
 * @property {bigint} fee
 * @property {bigint} receive units of the exchange coin the wallet gets
 * @property {bigint} tokenAmount in the token's own units
 * @property {number} decimals the token's decimals
 * @property {string} token
 * @property {bigint} expiryHeight
 */

/**
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
function record(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new WithdrawError("bad_reply", "not an object");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {unknown} value
 * @returns {bigint}
 */
function units(value) {
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value)) {
    throw new WithdrawError("bad_reply", "not a number string");
  }
  const parsed = BigInt(value);
  if (parsed > U64_MAX) {
    throw new WithdrawError("bad_reply", "too large");
  }
  return parsed;
}

/**
 * @param {unknown} value
 * @param {number} bytes
 * @returns {Uint8Array}
 */
function hexBytes(value, bytes) {
  const raw = typeof value === "string" && value.length === bytes * 2 ? fromHex(value) : null;
  if (raw === null) {
    throw new WithdrawError("bad_reply", `not ${bytes} bytes of hex`);
  }
  return raw;
}

/**
 * A token's limits, in the token's own units, as the relay lists them.
 * Missing or `null` is no limits; unknown extra fields are ignored.
 * @param {unknown} value
 * @returns {Rule | null}
 */
export function readRule(value) {
  if (value === undefined || value === null) {
    return null;
  }
  const rule = record(value);
  const big = (/** @type {unknown} */ field) => {
    if (typeof field !== "string" || !/^\d{1,40}$/.test(field)) {
      throw new WithdrawError("bad_reply", "rule");
    }
    return BigInt(field);
  };
  const minimum = big(rule.minimum);
  const maximum = big(rule.maximum);
  const granularity = big(rule.granularity);
  if (granularity === 0n || maximum < minimum) {
    throw new WithdrawError("bad_reply", "rule");
  }
  return { minimum, maximum, granularity };
}

/**
 * Exchange units as the token's own units, rounded down.
 * @param {bigint} amount
 * @param {number} decimals the token's decimals
 * @returns {bigint}
 */
export function toTokenUnits(amount, decimals) {
  return decimals <= EXCHANGE_DECIMALS
    ? amount / pow10(EXCHANGE_DECIMALS - decimals)
    : amount * pow10(decimals - EXCHANGE_DECIMALS);
}

/**
 * The relay's list of networks, read strictly.
 * @param {unknown} body
 * @returns {RelayNetwork[]}
 */
export function readNetworks(body) {
  const list = record(body).networks;
  if (!Array.isArray(list)) {
    throw new WithdrawError("bad_reply", "no networks");
  }
  return list.map((item) => {
    const net = record(item);
    const chainId = net.chain_id;
    if (typeof chainId !== "number" || !Number.isSafeInteger(chainId) || chainId <= 0) {
      throw new WithdrawError("bad_reply", "chain id");
    }
    if (!Array.isArray(net.tokens)) {
      throw new WithdrawError("bad_reply", "tokens");
    }
    const tokens = net.tokens.map((entry) => {
      const token = record(entry);
      const { asset, decimals } = token;
      if (typeof asset !== "number" || !Number.isInteger(asset) || asset < 0 || asset > 0xffff_ffff) {
        throw new WithdrawError("bad_reply", "asset");
      }
      if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
        throw new WithdrawError("bad_reply", "decimals");
      }
      if (typeof token.token !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(token.token)) {
        throw new WithdrawError("bad_reply", "token address");
      }
      const fee = token.fee === undefined || token.fee === null ? null : units(token.fee);
      return { asset, token: token.token.toLowerCase(), decimals, rule: readRule(token.rule), fee };
    });
    return { chainId, tokens };
  });
}

/**
 * What was asked of the relay: the only inputs the hash may be made of.
 * @typedef {object} Asked
 * @property {bigint} chainId the exchange chain, from `info`
 * @property {number} asset
 * @property {bigint} amount
 * @property {Uint8Array} account this page's trading account
 * @property {number} evmChain
 * @property {string} to the connected EVM address
 */

/**
 * Checks the relay's `prepare` reply against what was asked, and
 * recomputes the signature hash. Throws `WithdrawError` with `mismatch`
 * or `stale` unless everything agrees.
 * @param {unknown} body
 * @param {Asked} asked
 * @param {readonly RelayNetwork[]} networks what the relay listed
 * @param {number} height the latest block this page knows
 * @param {number} [intervalMs] the chain's block interval; with it the
 *   expiry may be up to five minutes of blocks ahead (never fewer than
 *   `MAX_EXPIRY_AHEAD`, never more than `MAX_EXPIRY_BLOCKS`)
 * @returns {Prepared}
 */
export function checkPrepared(body, asked, networks, height, intervalMs) {
  const reply = record(body);
  const id = typeof reply.id === "string" && /^[0-9a-f]{32}$/.test(reply.id) ? reply.id : null;
  if (id === null) {
    throw new WithdrawError("bad_reply", "id");
  }
  const claimed = hexBytes(reply.sighash, 32);
  const commitment = hexBytes(reply.bundle_commitment, 32);
  const amount = units(reply.amount);
  const fee = units(reply.fee);
  const receive = units(reply.receive);
  const tokenAmount = units(reply.token_amount);
  const expiryHeight = reply.expiry_height;
  if (typeof expiryHeight !== "number" || !Number.isSafeInteger(expiryHeight) || expiryHeight < 0) {
    throw new WithdrawError("bad_reply", "expiry");
  }
  const decimals = reply.decimals;
  if (typeof decimals !== "number" || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new WithdrawError("bad_reply", "decimals");
  }
  if (typeof reply.token !== "string") {
    throw new WithdrawError("bad_reply", "token");
  }
  const chain = typeof reply.tint_chain_id === "string" && /^\d{1,20}$/.test(reply.tint_chain_id)
    ? BigInt(reply.tint_chain_id)
    : null;

  // The relay answers about the coin and the amount that were asked for.
  if (reply.asset !== asked.asset) {
    throw new WithdrawError("mismatch", "asset");
  }
  if (amount !== asked.amount) {
    throw new WithdrawError("mismatch", "amount");
  }
  // And on the chain this page is on.
  if (chain === null || chain !== asked.chainId) {
    throw new WithdrawError("mismatch", "chain");
  }
  // The amount is split into what the wallet gets and the fee, nothing lost.
  if (receive + fee !== amount || receive === 0n) {
    throw new WithdrawError("mismatch", "split");
  }
  // The token is the one the relay itself lists for this coin and network.
  const listed = networks
    .find((net) => net.chainId === asked.evmChain)
    ?.tokens.find((token) => token.asset === asked.asset);
  if (listed === undefined || listed.token !== reply.token.toLowerCase() || listed.decimals !== decimals) {
    throw new WithdrawError("mismatch", "token");
  }
  // The fee is the one listed: the person receives what they typed.
  if (listed.fee !== null && listed.fee !== fee) {
    throw new WithdrawError("mismatch", "fee");
  }
  // The token units are exactly the received exchange units, rescaled.
  const exact =
    decimals <= EXCHANGE_DECIMALS
      ? tokenAmount * pow10(EXCHANGE_DECIMALS - decimals) === receive
      : tokenAmount === receive * pow10(decimals - EXCHANGE_DECIMALS);
  if (!exact || tokenAmount === 0n) {
    throw new WithdrawError("mismatch", "token amount");
  }
  // The withdrawal may not wait long, and may not be past.
  if (!Number.isSafeInteger(height) || expiryHeight < height || expiryHeight > height + expiryAhead(intervalMs)) {
    throw new WithdrawError("stale", "expiry");
  }
  const sighash = withdrawalSighash({
    chainId: asked.chainId,
    asset: asked.asset,
    expiryHeight: BigInt(expiryHeight),
    commitment,
    account: asked.account,
    amount: asked.amount,
  });
  if (toHex(sighash) !== toHex(claimed)) {
    throw new WithdrawError("mismatch", "sighash");
  }
  return {
    id,
    sighash,
    fee,
    receive,
    tokenAmount,
    decimals,
    token: listed.token,
    expiryHeight: BigInt(expiryHeight),
  };
}

/**
 * @typedef {(input: string, init: RequestInit) => Promise<{ status: number, json: () => Promise<unknown> }>} Fetcher
 */

/**
 * One call to the gateway's withdrawal API. The relay's errors are
 * `{"error": "code"}`, the gateway's `{"error": {"code"}}`; both are read.
 * @param {Fetcher} fetcher
 * @param {string} path
 * @param {unknown} [body] sent as JSON with POST when given
 * @param {number} [timeoutMs]
 * @returns {Promise<Record<string, unknown>>}
 */
export async function relayCall(fetcher, path, body, timeoutMs = QUICK_MS) {
  /** @type {RequestInit} */
  const init = { cache: "no-store", signal: AbortSignal.timeout(timeoutMs) };
  if (body !== undefined) {
    init.method = "POST";
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  /** @type {number} */
  let status;
  /** @type {unknown} */
  let parsed;
  try {
    const response = await fetcher(path, init);
    status = response.status;
    parsed = await response.json();
  } catch {
    throw new WithdrawError("unreachable");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new WithdrawError("bad_reply");
  }
  const reply = /** @type {Record<string, unknown>} */ (parsed);
  if (status < 200 || status > 299) {
    const error = reply.error;
    const code =
      typeof error === "string"
        ? error
        : typeof error === "object" && error !== null && typeof (/** @type {{ code?: unknown }} */ (error)).code === "string"
          ? String(/** @type {{ code: string }} */ (error).code)
          : "failed";
    throw new WithdrawError(code);
  }
  return reply;
}

/**
 * @typedef {object} Choice a coin that can be withdrawn on a network
 * @property {number} asset
 * @property {string} symbol
 * @property {number} decimals the exchange's decimals for the coin
 * @property {number} tokenDecimals the token's own decimals on this network
 * @property {Rule | null} rule
 * @property {bigint | null} fee the fee taken on top of what the person receives
 */

/**
 * @typedef {object} NetworkChoice
 * @property {number} chainId
 * @property {string} name
 * @property {Choice[]} coins
 */

/**
 * A step in token units as a decimal without trailing zeros: 10 000
 * units of 6 decimals is "0,01".
 * @param {bigint} granularity
 * @param {number} tokenDecimals
 * @returns {string}
 */
export function stepText(granularity, tokenDecimals) {
  let digits = tokenDecimals;
  let rest = granularity;
  while (digits > 0 && rest % 10n === 0n) {
    rest /= 10n;
    digits -= 1;
  }
  return formatUnits(granularity, tokenDecimals, Math.min(digits, 8));
}

/**
 * What leaves the exchange for what a person typed: the typed amount is
 * what they receive when the fee is known, else the total.
 * @param {bigint} typed
 * @param {bigint | null} fee
 * @returns {bigint}
 */
export function totalFor(typed, fee) {
  return fee === null ? typed : typed + fee;
}

/**
 * "Спишется с биржи X, из них комиссия сети Tint Y" under the amount, or
 * an empty text when there is no fee or no valid amount yet.
 * @param {Choice | undefined} coin
 * @param {string} text what was typed
 * @returns {string}
 */
export function spendText(coin, text) {
  if (coin === undefined || coin.fee === null) {
    return "";
  }
  const receive = parseAmount(text, EXCHANGE_DECIMALS);
  if (receive === null || receive + coin.fee > U64_MAX) {
    return "";
  }
  const shown = (/** @type {bigint} */ value) => formatUnits(value, EXCHANGE_DECIMALS, EXCHANGE_DECIMALS);
  return `Спишется с биржи ${shown(receive + coin.fee)} ${coin.symbol}, из них комиссия сети Tint ${shown(coin.fee)}`;
}

/** Names of well-known EVM networks, for a network the bridge list does not name. */
const KNOWN_CHAINS = new Map([
  [1, "Ethereum"],
  [10, "OP Mainnet"],
  [56, "BNB Chain"],
  [137, "Polygon"],
  [8453, "Base"],
  [42161, "Arbitrum One"],
  [11155111, "Sepolia"],
]);

/**
 * A network's name: the bridge list's, else a well-known one, else its number.
 * @param {number} chainId
 * @param {string | null} listed
 * @returns {string}
 */
export function chainName(chainId, listed) {
  return listed ?? KNOWN_CHAINS.get(chainId) ?? `№ ${chainId}`;
}

/**
 * The relay's networks joined with the exchange's coins: only coins the
 * exchange lists are offered, only networks that have such a coin.
 * @param {readonly RelayNetwork[]} networks
 * @param {readonly Asset[]} assets
 * @param {(chainId: number) => string | null} nameOf
 * @returns {NetworkChoice[]}
 */
export function choices(networks, assets, nameOf) {
  /** @type {NetworkChoice[]} */
  const out = [];
  for (const net of networks) {
    /** @type {Choice[]} */
    const coins = [];
    for (const token of net.tokens) {
      const asset = assets.find((a) => a.id === token.asset);
      if (asset !== undefined) {
        coins.push({
          asset: asset.id,
          symbol: asset.symbol,
          decimals: asset.decimals,
          tokenDecimals: token.decimals,
          rule: token.rule,
          fee: token.fee,
        });
      }
    }
    if (coins.length > 0) {
      out.push({ chainId: net.chainId, name: chainName(net.chainId, nameOf(net.chainId)), coins });
    }
  }
  return out;
}

/**
 * The promise shown before signing.
 * @param {object} fields
 * @param {Prepared} fields.prepared
 * @param {string} fields.symbol
 * @param {string} fields.networkName
 * @param {string} fields.to the EVM address
 * @returns {string}
 */
export function promise({ prepared, symbol, networkName, to }) {
  const got = formatUnits(prepared.tokenAmount, prepared.decimals, prepared.decimals);
  const fee = formatUnits(prepared.fee, EXCHANGE_DECIMALS, EXCHANGE_DECIMALS);
  return `Получите ${got} ${symbol} на ${shortHex(to)} в сети ${networkName}; комиссия сети Tint ${fee} ${symbol}.`;
}

/**
 * @typedef {object} WithdrawHost
 * @property {Fetcher} fetch
 * @property {() => Info | null} info
 * @property {() => number | null} height the latest block known
 * @property {() => Account | null} account the trading key, if enabled
 * @property {() => string | null} owner the connected EVM address
 * @property {(asset: number) => bigint} free the account's free balance of a coin
 * @property {(chainId: number) => string | null} networkName
 */

/**
 * The steps of a withdrawal, without any drawing.
 * @param {WithdrawHost} host
 */
export function createWithdrawal(host) {
  /** @type {RelayNetwork[]} */
  let listed = [];
  /** @type {{ prepared: Prepared, asked: Asked, symbol: string, networkName: string } | null} */
  let pending = null;
  let busy = false;

  /** @returns {{ info: Info, account: Account, owner: string }} */
  function ready() {
    const info = host.info();
    const account = host.account();
    const owner = host.owner();
    if (owner === null) {
      throw new WithdrawError("no_wallet");
    }
    if (account === null || account.source !== "evm" || info === null) {
      throw new WithdrawError("no_key");
    }
    return { info, account, owner };
  }

  /**
   * @template T
   * @param {() => Promise<T>} work
   * @returns {Promise<T>}
   */
  async function exclusive(work) {
    if (busy) {
      throw new WithdrawError("busy");
    }
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  }

  return {
    /** Whether a call is under way. */
    get busy() {
      return busy;
    },

    /**
     * Asks the relay what it can pay out. Throws `no_withdrawals` while
     * the bridge is not launched.
     * @returns {Promise<NetworkChoice[]>}
     */
    async load() {
      const { info } = ready();
      listed = readNetworks(await relayCall(host.fetch, "/api/v1/withdraw/networks"));
      return choices(listed, info.assets, host.networkName);
    },

    /**
     * Asks the relay to build a withdrawal and checks its reply.
     * @param {{ chainId: number, asset: number, amountText: string }} input
     * @returns {Promise<string>} what the person is promised
     */
    prepare(input) {
      return exclusive(async () => {
        pending = null;
        const { info, account, owner } = ready();
        const coin = info.assets.find((a) => a.id === input.asset);
        const name = host.networkName(input.chainId);
        if (coin === undefined || !listed.some((n) => n.chainId === input.chainId)) {
          throw new WithdrawError("no_choice");
        }
        const typed = parseAmount(input.amountText);
        if (typed === null) {
          throw new WithdrawError("bad_amount");
        }
        const token = listed
          .find((n) => n.chainId === input.chainId)
          ?.tokens.find((t) => t.asset === coin.id);
        const fee = token?.fee ?? null;
        const free = host.free(coin.id);
        if (fee !== null && free <= fee) {
          throw new WithdrawError("fee_exceeds_balance");
        }
        // With a known fee the typed amount is what the wallet receives.
        const amount = totalFor(typed, fee);
        if (amount > U64_MAX || amount > free) {
          throw new WithdrawError("over_balance");
        }
        if (token !== undefined && fee !== null) {
          // Exact checks: the received amount is what the rule is about.
          if (token.decimals < EXCHANGE_DECIMALS && typed % pow10(EXCHANGE_DECIMALS - token.decimals) !== 0n) {
            throw new WithdrawError("inexact_amount");
          }
          const wanted = toTokenUnits(typed, token.decimals);
          const rule = token.rule;
          if (rule !== null) {
            if (wanted < rule.minimum) {
              throw new WithdrawError("below_minimum");
            }
            if (wanted > rule.maximum) {
              throw new WithdrawError("above_maximum");
            }
            if (wanted % rule.granularity !== 0n) {
              throw new WithdrawError(
                "bad_granularity",
                "local",
                `Сумма должна делиться на ${stepText(rule.granularity, token.decimals)} ${coin.symbol}.`,
              );
            }
          }
        } else if (token?.rule) {
          // The fee is not listed: only what is certain is checked here.
          const wanted = toTokenUnits(amount, token.decimals);
          if (wanted < token.rule.minimum) {
            throw new WithdrawError("below_minimum");
          }
          if (wanted > token.rule.maximum) {
            throw new WithdrawError("above_maximum");
          }
        }
        const height = host.height();
        if (height === null) {
          throw new WithdrawError("stale", "no height");
        }
        const asked = {
          chainId: info.chainId,
          asset: coin.id,
          amount,
          account: account.publicKey,
          evmChain: input.chainId,
          to: owner.toLowerCase(),
        };
        const reply = await relayCall(host.fetch, "/api/v1/withdraw/prepare", {
          asset: asked.asset,
          amount: amount.toString(),
          account: account.hex,
          chain_id: asked.evmChain,
          to: asked.to,
        });
        const prepared = checkPrepared(reply, asked, listed, height, info.intervalMs);
        const networkName = chainName(input.chainId, name);
        pending = { prepared, asked, symbol: coin.symbol, networkName };
        return promise({ prepared, symbol: coin.symbol, networkName, to: owner });
      });
    },

    /**
     * Signs what `prepare` checked and sends it. The message is built
     * here from the checked hash.
     * @returns {Promise<{ txid: string, text: string }>}
     */
    submit() {
      return exclusive(async () => {
        const taken = pending;
        if (taken === null) {
          throw new WithdrawError("not_prepared");
        }
        pending = null;
        const { account } = ready();
        const height = host.height();
        if (height === null || taken.prepared.expiryHeight < BigInt(height)) {
          throw new WithdrawError("stale", "expired while waiting");
        }
        const signature = await account.sign(withdrawalMessage(taken.prepared.sighash));
        if (signature.length !== 64) {
          throw new WithdrawError("failed", "signature size");
        }
        // After the signature has gone out, a failure that says nothing
        // about the node's decision leaves the outcome unknown: the
        // person is told to check the balance, not to try again.
        /** @type {Record<string, unknown>} */
        let reply;
        try {
          reply = await relayCall(
            host.fetch,
            "/api/v1/withdraw/submit",
            { id: taken.prepared.id, signature: toHex(signature) },
            PROVING_MS,
          );
        } catch (error) {
          throw error instanceof WithdrawError && UNKNOWN_OUTCOME.has(error.code)
            ? new WithdrawError("outcome_unknown", error.code)
            : error;
        }
        const txid = typeof reply.txid === "string" && /^[0-9a-f]{64}$/.test(reply.txid) ? reply.txid : null;
        if (txid === null) {
          throw new WithdrawError("outcome_unknown", "txid");
        }
        const sent = formatUnits(taken.prepared.tokenAmount, taken.prepared.decimals, taken.prepared.decimals);
        return {
          txid,
          text: `Монеты списаны с биржи. Мост отправит ${sent} ${taken.symbol} на ваш кошелёк после подтверждения блока; мост кастодиальный.`,
        };
      });
    },

    /** Forgets a prepared withdrawal (the form changed). */
    reset() {
      pending = null;
    },
  };
}
