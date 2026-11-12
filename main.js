// @ts-check
// The terminal: asks the node for the exchange's state after every block,
// draws it, and turns the order form into signed transactions.

import { ApiError, askFaucet, getInfo, getSnapshot, sendTx } from "./api.js";
import { drawChart } from "./chart.js";
import * as keys from "./keys.js";
import { NETWORKS, switchTo } from "./networks.js";
import * as pairs from "./pairs.js";
import { createPicker, recall, remember } from "./picker.js";
import { randomNonce, signTx, toHex } from "./tx.js";
import * as walletLink from "./wallet.js";
import { feeOn, formatPrice, formatQty, formatUnits, lotsFor, parsePrice, parseQty, quoteFor } from "./units.js";
import {
  balanceOf,
  buttonById,
  byId,
  inputById,
  press,
  renderActivity,
  renderBook,
  renderMarket,
  renderNames,
  renderNetwork,
  renderProof,
  renderTape,
  renderWallet,
  say,
  setText,
} from "./view.js";

/** Blocks a transaction stays valid for: ten seconds at two blocks a second. */
const LIFETIME = 20;
/** The same when a person has to confirm it in the wallet first: a minute. */
const WALLET_LIFETIME = 120;
/** How far a market order may move the price: one part in this many. */
const SLIPPAGE_PART = 100n;
/** The page asks no more often and no more rarely than this, in milliseconds. */
const FASTEST = 250;
const SLOWEST = 2_000;
/** Pause between tries while the node does not answer or the page is hidden. */
const IDLE = 3_000;

/** Where the browser keeps the pair opened last. */
const PAIR_KEY = "dex.pair";

/** @typedef {"place" | "cancel" | "cancel_all"} Sent */
/** @typedef {"orders" | "fills" | "transfers"} Tab */

const state = {
  /** @type {Info | null} */
  info: null,
  /** The pair on the screen. @type {Market | null} */
  market: null,
  /** @type {Snapshot | null} */
  snap: null,
  /** @type {Account | null} */
  account: null,
  /** The wallet whose browser the page is open in, if it is. @type {WalletProvider | null} */
  wallet: null,
  /** Whether the wallet was asked if it already knows this page. */
  restored: false,
  /** @type {Side} */
  side: "buy",
  /** @type {"limit" | "market"} */
  kind: "limit",
  postOnly: false,
  minutes: 5,
  /** @type {Tab} */
  tab: "orders",
  /** @type {"book" | "tape"} */
  bookTab: "book",
  /** Transactions sent and not yet reported on, by identifier. @type {Map<string, Sent>} */
  pending: new Map(),
  /** Reports already shown or older than this page. @type {Set<string>} */
  seen: new Set(),
  /** Whether the reports that predate the page have been set aside. */
  primed: false,
  online: false,
  /** A request of the person's is on its way. */
  busy: false,
  /** The price field has a number: the market's at first, then the person's. */
  priceSet: false,
  /** What the chart was last drawn from. */
  drawn: "",
};

/** What the node's words for a refusal mean to a person. @type {Record<string, string>} */
const REASONS = {
  unknown_asset: "Такой монеты на бирже нет.",
  unknown_market: "Такого рынка на бирже нет.",
  unknown_order: "Этой заявки уже нет: она исполнилась или снята.",
  unknown_client_id: "Открытой заявки с таким номером нет: она исполнилась или снята.",
  client_id_in_use: "Этот номер уже у другой открытой заявки.",
  not_owner: "Это не ваша заявка.",
  zero_amount: "Количество должно быть больше нуля.",
  zero_quantity: "Количество должно быть больше нуля.",
  zero_price: "Цена должна быть больше нуля.",
  below_minimum: "Заявка меньше наименьшей разрешённой.",
  out_of_range: "Число слишком большое.",
  insufficient_funds: "На бирже не хватает монет для этой заявки.",
  cap_exceeded: "Биржа достигла предела по этой монете.",
  would_cross: "Заявка «только в стакан» исполнилась бы сразу, поэтому не принята. Поставьте цену дальше от рынка.",
  not_fillable: "В стакане нет встречных заявок по такой цене.",
  too_many_orders: "Слишком много открытых заявок. Снимите часть.",
  nothing_to_change: "Снимать нечего.",
  unfunded: "На счёте пусто. Сначала получите тестовые монеты.",
  expired: "Заявка устарела, пока шла. Отправьте ещё раз.",
  lifetime_too_long: "Узел не принял срок действия заявки.",
  bad_deadman_deadline: "Узел не принял срок автоотмены заявок.",
  bad_signature: "Узел не принял подпись. Обновите страницу и попробуйте снова.",
  replayed: "Такая заявка уже отправлена.",
  busy: "Узел занят. Попробуйте через пару секунд.",
  too_many_waiting: "У вас слишком много заявок в очереди. Подождите блок-другой.",
  faucet_full: "Кран тестовых монет исчерпан до перезапуска узла.",
  unreachable: "Нет связи с узлом.",
  demo: "Это демо без узла: заявки и тестовые монеты здесь не выдаются.",
  bad_reply: "Узел ответил не то, что ждёт терминал. Обновите страницу.",
};

/** What the wallet's refusals mean to a person. @type {Record<string, string>} */
const WALLET_REASONS = {
  rejected: "Вы отклонили запрос в кошельке.",
  locked: "Кошелёк заблокирован. Откройте его и попробуйте снова.",
  not_connected: "Кошелёк больше не подключён к этой странице. Подключите его снова.",
  wrong_chain: "Кошелёк работает в другой сети, не в той, что эта биржа.",
  wrong_account: "В кошельке теперь другой счёт. Подключите кошелёк заново.",
  bad_request: "Кошелёк не понял запрос. Обновите кошелёк или страницу.",
  bad_tx: "Кошелёк не смог прочитать заявку. Она не отправлена.",
  unsupported: "Этот кошелёк ещё не умеет работать с биржей. Обновите его.",
  busy: "Кошелёк ждёт вашего ответа на прошлый запрос.",
  bad_reply: "Кошелёк ответил не то, что ждёт терминал. Заявка не отправлена.",
  bad_signature: "Подпись кошелька не подходит к счёту. Заявка не отправлена.",
  failed: "Кошелёк не ответил. Попробуйте ещё раз.",
};

/**
 * @param {unknown} error
 * @returns {string}
 */
function explain(error) {
  if (error instanceof walletLink.WalletError) {
    return WALLET_REASONS[error.code] ?? WALLET_REASONS.failed ?? "";
  }
  if (error instanceof ApiError) {
    if (error.code === "faucet_wait" && error.blocks !== null) {
      return `Тестовые монеты уже выданы. Ещё раз — через ${error.blocks} бл.`;
    }
    return REASONS[error.code] ?? `Узел отказал: ${error.code}.`;
  }
  return "Не получилось. Обновите страницу и попробуйте снова.";
}

/**
 * The price a market order must not go beyond: the best opposite price
 * moved by the allowed slippage. `null` when the other side is empty.
 * @param {Snapshot} snap
 * @param {Side} side
 * @returns {bigint | null}
 */
function marketBound(snap, side) {
  const best = side === "buy" ? snap.asks[0] : snap.bids[0];
  if (best === undefined) {
    return null;
  }
  if (side === "buy") {
    return best.ticks + best.ticks / SLIPPAGE_PART + 1n;
  }
  const bound = best.ticks - best.ticks / SLIPPAGE_PART - 1n;
  return bound > 0n ? bound : 1n;
}

/**
 * What the order form holds, checked.
 * @returns {{ lots: bigint | null, ticks: bigint | null, free: bigint, cost: bigint | null, problem: string | null }}
 */
function draft() {
  const { market, snap, side } = state;
  if (market === null || snap === null) {
    return { lots: null, ticks: null, free: 0n, cost: null, problem: REASONS.unreachable ?? "" };
  }
  const { scale, base, quote } = market;
  const view = snap.account;
  const free = balanceOf(view, side === "buy" ? quote.id : base.id).free;
  const lots = parseQty(inputById("amount").value, scale);
  const ticks = state.kind === "limit" ? parsePrice(inputById("price").value, scale) : marketBound(snap, side);
  const cost = lots === null || ticks === null ? null : quoteFor(lots, ticks, scale);

  /** @type {string | null} */
  let problem = null;
  if (state.kind === "market" && ticks === null) {
    problem = "В стакане нет встречных заявок.";
  } else if (ticks === null) {
    problem = "Введите цену.";
  } else if (ticks === 0n) {
    problem = `Цена должна быть не меньше ${formatPrice(1n, scale)}.`;
  } else if (lots === null || lots === 0n) {
    problem = side === "buy" ? "Введите, сколько купить." : "Введите, сколько продать.";
  } else if (lots < market.minLots) {
    problem = `Наименьшая заявка — ${formatQty(market.minLots, scale)} ${base.symbol}.`;
  } else if (side === "buy" && cost !== null && cost > free) {
    problem = `Не хватает ${quote.symbol}: нужно ${formatUnits(cost, quote.decimals, 2)}, доступно ${formatUnits(free, quote.decimals, 2)}.`;
  } else if (side === "sell" && lots * scale.lot > free) {
    problem = `Не хватает ${base.symbol}: доступно ${formatUnits(free, base.decimals, 2)}.`;
  }
  return { lots, ticks, free, cost, problem };
}

/** Where the person is on the way to a first order. */
function stage() {
  if (state.account === null) {
    return "account";
  }
  return state.snap?.account?.funded === true ? "trade" : "coins";
}

/** Redraws the order form's figures and its button. */
function renderForm() {
  const { market, snap, side } = state;
  const form = byId("form");
  form.classList.toggle("mint", side === "buy");
  form.classList.toggle("peach", side === "sell");
  press(byId("side"), "side", side);
  press(byId("kind"), "kind", state.kind);
  byId("price-field").classList.toggle("hidden", state.kind !== "limit");
  byId("bound-line").classList.toggle("hidden", state.kind !== "market");
  const post = byId("post");
  post.classList.toggle("hidden", state.kind !== "limit");
  post.setAttribute("aria-checked", String(state.postOnly));

  const submit = buttonById("submit");
  submit.disabled = state.busy || market === null || snap === null;
  if (market === null || snap === null) {
    setText(submit, "Ждём узел…");
    return;
  }
  const now = stage();
  setText(
    submit,
    now === "account"
      ? state.wallet === null
        ? "Создать счёт"
        : "Подключить кошелёк"
      : now === "coins"
        ? "Получить тестовые монеты"
        : `${side === "buy" ? "Купить" : "Продать"} ${market.base.symbol}`,
  );

  const { scale, base, quote } = market;
  const current = draft();
  const spend = side === "buy" ? quote : base;
  setText(byId("avail"), `${formatUnits(current.free, spend.decimals, 2)} ${spend.symbol}`);
  setText(byId("bound"), current.ticks === null ? "—" : `${formatPrice(current.ticks, scale)} ${quote.symbol}`);
  const approx = state.kind === "market" ? "до " : "";
  setText(
    byId("total"),
    current.cost === null ? "—" : `${approx}${formatUnits(current.cost, quote.decimals, 2)} ${quote.symbol}`,
  );
  // The taker pays, in the coin it receives; an order that only rests
  // pays nothing.
  let fee = "—";
  const resting = state.kind === "limit" && state.postOnly;
  if (resting || market.takerFeePpm === 0n) {
    fee = "нет";
  } else if (current.lots !== null && current.cost !== null) {
    const received = side === "buy" ? current.lots * scale.lot : current.cost;
    const coin = side === "buy" ? base : quote;
    const owed = feeOn(received, market.takerFeePpm);
    // Four places, or all of the coin's when four would show a nought.
    const digits = owed > 0n && owed < 10n ** BigInt(Math.max(0, coin.decimals - 4)) ? coin.decimals : 4;
    fee = `до ${formatUnits(owed, coin.decimals, digits)} ${coin.symbol}`;
  }
  setText(byId("fee"), fee);
}

/** Redraws everything from the latest snapshot. */
function render() {
  const { info, market, snap } = state;
  renderNetwork(state.online, snap?.height ?? null);
  if (info === null || market === null || snap === null) {
    renderForm();
    return;
  }
  picker.update(info, snap.markets, market);
  renderMarket(market, snap);
  renderRows();
  renderWallet(info, market, state.account, snap.account, state.wallet !== null);
  renderActivity(info, market, snap.account, state.tab);
  renderProof(snap);
  renderForm();
  drawChartIfChanged(false);
}

/** Redraws the book or the tape, whichever is shown: its row count follows the tile's height. */
function renderRows() {
  const { market, snap } = state;
  if (market === null || snap === null) {
    return;
  }
  if (state.bookTab === "book") {
    renderBook(market, snap);
  } else {
    renderTape(market, snap);
  }
}

/** Shows the book or the tape. */
function showBookTab() {
  press(byId("book-tabs"), "view", state.bookTab);
  byId("book-pane").classList.toggle("hidden", state.bookTab !== "book");
  byId("tape-pane").classList.toggle("hidden", state.bookTab !== "tape");
  renderRows();
}

/**
 * Puts another pair on the screen. What was typed for the old pair is
 * dropped: a price or an amount means nothing in another pair.
 * @param {Market} market
 */
function choose(market) {
  const info = state.info;
  if (info === null) {
    return;
  }
  const slug = `#${market.slug}`;
  if (location.hash !== slug) {
    history.replaceState(null, "", slug);
  }
  remember(PAIR_KEY, market.slug);
  if (state.market?.id === market.id) {
    return;
  }
  state.market = market;
  state.snap = null;
  state.priceSet = false;
  state.drawn = "";
  inputById("price").value = "";
  inputById("amount").value = "";
  for (const id of ["asks", "bids", "tape", "activity"]) {
    byId(id).replaceChildren();
  }
  renderNames(info, market);
  say("", "plain");
  void poll();
}

/**
 * Draws the chart when its data or its size changed.
 * @param {boolean} force
 */
function drawChartIfChanged(force) {
  const { market, snap } = state;
  if (market === null || snap === null) {
    return;
  }
  const host = byId("chart");
  if (!(host instanceof SVGSVGElement)) {
    return;
  }
  const newest = snap.candles[snap.candles.length - 1];
  const key = [state.minutes, snap.candles.length, newest?.t, newest?.c, newest?.h, newest?.l, newest?.v, snap.last, host.clientWidth, host.clientHeight].join("|");
  if (force || key !== state.drawn) {
    state.drawn = key;
    drawChart(host, snap.candles, snap.last, market.scale, "Сделок пока не было");
  }
}

/**
 * Tells the person how the transactions they sent ended.
 * @param {Snapshot} snap
 */
function absorbReports(snap) {
  const reports = snap.account?.reports ?? [];
  if (!state.primed) {
    for (const report of reports) {
      state.seen.add(report.id);
    }
    state.primed = snap.account !== null;
    return;
  }
  for (const report of reports) {
    if (state.seen.has(report.id)) {
      continue;
    }
    state.seen.add(report.id);
    const sent = state.pending.get(report.id);
    if (sent === undefined) {
      continue;
    }
    state.pending.delete(report.id);
    if (report.status === "executed") {
      const done = { place: "Заявка прошла", cancel: "Заявка снята", cancel_all: "Заявки сняты" }[sent];
      say(`${done} в блоке ${formatUnits(BigInt(report.height), 0, 0)}.`, "good");
    } else if (report.status === "refused") {
      say(REASONS[report.code ?? ""] ?? `Биржа отказала: ${report.code ?? "причина не названа"}.`, "bad");
    } else {
      say("Заявка не успела попасть в блок. Отправьте ещё раз.", "bad");
    }
  }
  if (state.seen.size > 2_000) {
    state.seen = new Set(reports.map((report) => report.id));
  }
}

/** Forgets what belonged to another account or another run of the node. */
function forgetReports() {
  state.pending.clear();
  state.seen.clear();
  state.primed = false;
}

/** @type {ReturnType<typeof setTimeout> | undefined} */
let timer;

/** The list of pairs in the strip. */
const picker = createPicker(choose);

/** Asks the node once and schedules the next question. */
async function poll() {
  clearTimeout(timer);
  let wait = IDLE;
  try {
    if (state.info === null) {
      const info = await getInfo();
      state.info = info;
      press(byId("networks"), "net", info.network);
      state.market = pairs.initial(info.markets, location.hash, recall(PAIR_KEY));
      history.replaceState(null, "", `#${state.market.slug}`);
      renderNames(info, state.market);
    }
    const market = state.market;
    if (market === null) {
      throw new ApiError(0, "bad_reply", "no pair is chosen");
    }
    if (state.wallet !== null && !state.restored) {
      // Once: a page the person has already let in gets its account
      // back without a question.
      state.restored = true;
      state.account = await walletLink.restore(state.wallet, state.info.chainId);
    }
    const snap = await getSnapshot(market.id, state.minutes, state.account?.hex ?? null);
    if (snap.market !== state.market?.id) {
      // The person switched pairs while this answer was on its way.
      return;
    }
    if (state.snap !== null && snap.height < state.snap.height) {
      // The node started over: nothing sent before will be reported.
      forgetReports();
    }
    state.snap = snap;
    state.online = true;
    absorbReports(snap);
    if (!state.priceSet) {
      // Once: a field that follows the market would change under the
      // person's hand.
      const start = (state.side === "buy" ? snap.bids[0]?.ticks : snap.asks[0]?.ticks) ?? snap.last;
      if (start !== null && start !== undefined) {
        inputById("price").value = formatPrice(start, market.scale);
        state.priceSet = true;
      }
    }
    if (!document.hidden) {
      wait = Math.min(SLOWEST, Math.max(FASTEST, state.info.intervalMs));
    }
  } catch (error) {
    state.online = false;
    if (error instanceof ApiError && error.code === "bad_reply") {
      say(explain(error), "bad");
    }
  }
  render();
  timer = setTimeout(poll, wait);
}

/**
 * Signs an action and hands it to the node.
 * @param {Action} action
 * @param {Sent} sent
 * @param {string} waiting what to say while the block is awaited
 */
async function send(action, sent, waiting) {
  const { info, snap, account } = state;
  if (info === null || snap === null || account === null || state.busy) {
    return;
  }
  state.busy = true;
  renderForm();
  /** @type {string | null} */
  let id = null;
  try {
    const wanted = account.source === "wallet" ? WALLET_LIFETIME : LIFETIME;
    const lifetime = Math.max(1, Math.min(wanted, info.maxLifetime));
    const tx = { account: account.publicKey, nonce: randomNonce(), expiresAt: BigInt(snap.height + lifetime), action };
    const signed = await signTx(info.chainId, tx, account.sign);
    id = signed.id;
    // Known before it is sent, so that a report cannot arrive first.
    state.pending.set(id, sent);
    await sendTx(toHex(signed.bytes));
    say(waiting, "plain");
  } catch (error) {
    if (id !== null) {
      state.pending.delete(id);
    }
    if (error instanceof walletLink.WalletError && (error.code === "not_connected" || error.code === "wrong_account")) {
      // The wallet no longer stands behind this account.
      state.account = null;
      forgetReports();
    }
    say(explain(error), "bad");
  } finally {
    state.busy = false;
    render();
  }
}

/** Asks the wallet, and through it the person, for the trading account. */
async function connectWallet() {
  const { info, wallet } = state;
  if (info === null || wallet === null || state.busy) {
    return;
  }
  state.busy = true;
  renderForm();
  say("Подтвердите подключение в кошельке…", "plain");
  try {
    state.account = await walletLink.connect(wallet, info.chainId);
    forgetReports();
    say("Кошелёк подключён. Ключ счёта остаётся в нём; каждую заявку кошелёк подписывает сам.", "good");
  } catch (error) {
    say(explain(error), "bad");
  } finally {
    state.busy = false;
  }
  void poll();
}

/** The first step: an account from the wallet, or one made here. */
async function openAccount() {
  await (state.wallet === null ? createAccount() : connectWallet());
}

/**
 * Takes up the wallet if the page is inside its browser. The wallet's
 * account then replaces one kept in this browser, which stays untouched.
 */
function adoptWallet() {
  if (state.wallet !== null) {
    return;
  }
  const found = walletLink.provider();
  if (found === null) {
    return;
  }
  state.wallet = found;
  state.restored = false;
  state.account = null;
  forgetReports();
}

/** Makes the account's key in this browser. */
async function createAccount() {
  if (state.busy) {
    return;
  }
  state.busy = true;
  renderForm();
  try {
    state.account = await keys.create();
    forgetReports();
    say("Счёт создан. Его ключ хранится в этом браузере. Теперь получите тестовые монеты.", "good");
  } catch {
    say("Этот браузер не умеет подписывать заявки. Обновите его или откройте страницу в другом.", "bad");
  } finally {
    state.busy = false;
  }
  void poll();
}

/** Asks the node's faucet for test coins. */
async function takeCoins() {
  const account = state.account;
  if (account === null || state.busy) {
    return;
  }
  state.busy = true;
  renderForm();
  try {
    await askFaucet(account.hex);
    say("Тестовые монеты придут со следующим блоком.", "good");
  } catch (error) {
    say(explain(error), "bad");
  } finally {
    state.busy = false;
  }
  void poll();
}

/** The order form's button: the next step towards a trade, or the trade. */
async function submit() {
  const now = stage();
  if (now === "account") {
    await openAccount();
    return;
  }
  if (now === "coins") {
    await takeCoins();
    return;
  }
  const market = state.market;
  const current = draft();
  if (market === null || current.problem !== null || current.lots === null || current.ticks === null) {
    say(current.problem ?? REASONS.unreachable ?? "", "bad");
    return;
  }
  /** @type {OrderKind} */
  const order =
    state.kind === "limit"
      ? { kind: "limit", ticks: current.ticks, tif: state.postOnly ? "post_only" : "gtc" }
      : { kind: "market_worst", ticks: current.ticks };
  await send(
    { type: "place", market: market.id, side: state.side, lots: current.lots, order },
    "place",
    "Заявка отправлена, ждём блок…",
  );
}

/**
 * Fills the quantity with a share of what the account can afford.
 * @param {bigint} percent
 */
function fillShare(percent) {
  const { market, snap } = state;
  if (market === null || snap === null) {
    return;
  }
  const scale = market.scale;
  const current = draft();
  let lots = 0n;
  if (state.side === "sell") {
    lots = (current.free * percent) / 100n / scale.lot;
  } else if (current.ticks !== null) {
    lots = lotsFor((current.free * percent) / 100n, current.ticks, scale);
  }
  inputById("amount").value = lots > 0n ? formatQty(lots, scale) : "";
  renderForm();
}

/**
 * The value of `name` on the button a click landed on, within `host`.
 * @param {Event} event
 * @param {string} name a data attribute
 * @returns {string | null}
 */
function clicked(event, name) {
  const target = event.target;
  if (!(target instanceof Element)) {
    return null;
  }
  const button = target.closest("button");
  return button instanceof HTMLButtonElement && !button.disabled ? (button.dataset[name] ?? null) : null;
}

/** Connects the page's controls. */
function wire() {
  byId("side").addEventListener("click", (event) => {
    const side = clicked(event, "side");
    if (side === "buy" || side === "sell") {
      state.side = side;
      renderForm();
    }
  });
  byId("kind").addEventListener("click", (event) => {
    const kind = clicked(event, "kind");
    if (kind === "limit" || kind === "market") {
      state.kind = kind;
      renderForm();
    }
  });
  byId("post").addEventListener("click", () => {
    state.postOnly = !state.postOnly;
    renderForm();
  });
  byId("quarters").addEventListener("click", (event) => {
    const share = clicked(event, "share");
    if (share !== null && /^\d{1,3}$/.test(share)) {
      fillShare(BigInt(share));
    }
  });
  inputById("price").addEventListener("input", () => {
    state.priceSet = true;
    renderForm();
  });
  inputById("amount").addEventListener("input", renderForm);
  byId("order-form").addEventListener("submit", (event) => {
    event.preventDefault();
    void submit();
  });

  for (const id of ["asks", "bids"]) {
    byId(id).addEventListener("click", (event) => {
      const ticks = clicked(event, "ticks");
      const market = state.market;
      if (ticks !== null && market !== null && /^\d{1,20}$/.test(ticks)) {
        state.kind = "limit";
        state.priceSet = true;
        inputById("price").value = formatPrice(BigInt(ticks), market.scale);
        renderForm();
      }
    });
  }

  byId("networks").addEventListener("click", (event) => {
    const wanted = clicked(event, "net");
    if (wanted === null) {
      return;
    }
    const here = state.info?.network ?? "test";
    const choice = switchTo(NETWORKS, here, wanted);
    if (choice.kind === "open") {
      location.assign(choice.url);
    } else if (choice.kind === "closed") {
      setText(
        byId("net-note-text"),
        choice.network.id === "main"
          ? "Основная сеть ещё не запущена: настоящие монеты здесь пока не торгуются. Сейчас открыта только тестовая сеть, её монеты ничего не стоят. Когда основную сеть запустят, эта кнопка откроет её."
          : "Тестовая сеть сейчас не открыта.",
      );
      byId("net-note").classList.remove("hidden");
      buttonById("net-note-close").focus();
    } else {
      byId("net-note").classList.add("hidden");
    }
  });
  buttonById("net-note-close").addEventListener("click", () => {
    byId("net-note").classList.add("hidden");
  });
  byId("frames").addEventListener("click", (event) => {
    const minutes = Number(clicked(event, "minutes"));
    if ([1, 5, 15, 60].includes(minutes)) {
      state.minutes = minutes;
      press(byId("frames"), "minutes", String(minutes));
      void poll();
    }
  });
  byId("book-tabs").addEventListener("click", (event) => {
    const view = clicked(event, "view");
    if (view === "book" || view === "tape") {
      state.bookTab = view;
      showBookTab();
    }
  });
  byId("tabs").addEventListener("click", (event) => {
    const tab = clicked(event, "tab");
    if (tab === "orders" || tab === "fills" || tab === "transfers") {
      state.tab = tab;
      render();
    }
  });
  byId("activity").addEventListener("click", (event) => {
    const order = clicked(event, "order");
    if (order !== null && /^\d{1,20}$/.test(order)) {
      void send({ type: "cancel", order: BigInt(order) }, "cancel", "Снимаем заявку, ждём блок…");
    }
  });
  byId("cancel-all").addEventListener("click", () => {
    const market = state.market;
    if (market !== null) {
      void send({ type: "cancel_all", market: market.id }, "cancel_all", "Снимаем заявки, ждём блок…");
    }
  });

  byId("deposit").addEventListener("click", () => void takeCoins());
  byId("account").addEventListener("click", () => {
    const account = state.account;
    if (account === null) {
      void openAccount();
      return;
    }
    navigator.clipboard.writeText(account.hex).then(
      () => say("Номер счёта скопирован.", "plain"),
      () => say(`Ваш счёт: ${account.hex}`, "plain"),
    );
  });

  window.addEventListener(walletLink.READY_EVENT, () => {
    adoptWallet();
    void poll();
  });
  window.addEventListener("hashchange", () => {
    const market = state.info === null ? null : pairs.bySlug(state.info.markets, location.hash);
    if (market !== null) {
      picker.close();
      choose(market);
    }
  });
  // The book, the tape and the chart are as big as their tiles: a tile
  // that changes size is redrawn once per frame at most.
  let queued = false;
  const resized = new ResizeObserver(() => {
    if (queued) {
      return;
    }
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      renderRows();
      drawChartIfChanged(false);
    });
  });
  for (const id of ["chart", "asks", "bids", "tape"]) {
    const node = byId(id).parentElement;
    if (node !== null) {
      resized.observe(node);
    }
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      void poll();
    }
  });
}

/** Starts the terminal. */
async function start() {
  wire();
  press(byId("frames"), "minutes", String(state.minutes));
  showBookTab();
  renderForm();
  adoptWallet();
  if (state.wallet === null) {
    try {
      const kept = await keys.load();
      // The wallet may have announced itself meanwhile.
      if (state.wallet === null) {
        state.account = kept;
      }
    } catch {
      // A browser that keeps no store still shows the market.
      state.account = null;
    }
  }
  await poll();
}

void start();
