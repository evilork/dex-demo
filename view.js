// @ts-check
// Draws the exchange's state into the page. Rows are kept and updated in
// place rather than rebuilt, so a click that starts on a row still lands
// on it when a new block arrives in between.

import { shortAddress } from "./evm.js";
import { change, clock, formatPrice, formatQty, formatUnits, qtyDigits, shortHex } from "./units.js";

/** Height of a row of the book and of the tape, as the style sheet sets it. */
const ROW_PX = 24;
/** Fewest and most price levels shown on each side of the book. */
const MIN_LEVELS = 3;
const MAX_LEVELS = 20;
/** Fewest and most trades shown in the tape. */
const MIN_TAPE = 5;
const MAX_TAPE = 40;
/** Rows shown in the lists of own trades and transfers. */
const HISTORY_ROWS = 30;
/** Digits after the comma for coin amounts outside the book. */
const COIN_DIGITS = 2;

/**
 * The page's element with this id.
 * @param {string} id
 * @returns {HTMLElement}
 */
export function byId(id) {
  const node = document.getElementById(id);
  if (node === null) {
    throw new Error(`the page has no #${id}`);
  }
  return node;
}

/**
 * @param {string} id
 * @returns {HTMLInputElement}
 */
export function inputById(id) {
  const node = byId(id);
  if (!(node instanceof HTMLInputElement)) {
    throw new Error(`#${id} is not an input`);
  }
  return node;
}

/**
 * @param {string} id
 * @returns {HTMLButtonElement}
 */
export function buttonById(id) {
  const node = byId(id);
  if (!(node instanceof HTMLButtonElement)) {
    throw new Error(`#${id} is not a button`);
  }
  return node;
}

/**
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [cls]
 * @param {string} [content]
 * @returns {HTMLElementTagNameMap[K]}
 */
export function el(tag, cls, content) {
  const node = document.createElement(tag);
  if (cls !== undefined && cls !== "") {
    node.className = cls;
  }
  if (content !== undefined) {
    node.textContent = content;
  }
  return node;
}

/**
 * Sets an element's text only if it differs: no needless repaint.
 * @param {Element} node
 * @param {string} content
 */
export function setText(node, content) {
  if (node.textContent !== content) {
    node.textContent = content;
  }
}

/**
 * Child `index` of a row this file built.
 * @param {Element} row
 * @param {number} index
 * @returns {HTMLElement}
 */
function cell(row, index) {
  const node = row.children[index];
  if (!(node instanceof HTMLElement)) {
    throw new Error("a row lost its cell");
  }
  return node;
}

/**
 * Makes `host` hold one row per item, reusing the rows it has.
 * @template T
 * @param {HTMLElement} host
 * @param {string} kind what the rows are; a host that held another kind is emptied first
 * @param {T[]} items
 * @param {() => HTMLElement} make
 * @param {(row: HTMLElement, item: T) => void} update
 */
function sync(host, kind, items, make, update) {
  if (host.dataset.kind !== kind) {
    host.replaceChildren();
    host.dataset.kind = kind;
  }
  while (host.children.length > items.length) {
    host.lastElementChild?.remove();
  }
  while (host.children.length < items.length) {
    host.append(make());
  }
  items.forEach((item, index) => update(cell(host, index), item));
}

/**
 * Marks the pressed button of a group.
 * @param {HTMLElement} group
 * @param {string} attribute the data attribute that names a button
 * @param {string} chosen
 */
export function press(group, attribute, chosen) {
  for (const button of group.querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(button.dataset[attribute] === chosen));
  }
}

/**
 * @param {Side} side
 * @param {HTMLElement} chip
 */
function sideChip(chip, side) {
  chip.className = side === "buy" ? "chip mint" : "chip peach";
  setText(chip, side === "buy" ? "Покупка" : "Продажа");
}

/**
 * The letter a coin's badge shows.
 * @param {Asset} asset
 * @returns {string}
 */
export function badgeOf(asset) {
  return asset.symbol.endsWith("USD") ? "$" : asset.symbol.slice(0, 1);
}

/**
 * How many rows of `ROW_PX` fit into `host` as it is laid out now.
 * @param {HTMLElement} host
 * @param {number} least
 * @param {number} most
 * @returns {number}
 */
function rowsThatFit(host, least, most) {
  return Math.max(least, Math.min(most, Math.floor(host.clientHeight / ROW_PX)));
}

/**
 * The names that depend on the node and on the pair: the exchange's and
 * the coins'.
 * @param {Info} info
 * @param {Market} market
 */
export function renderNames(info, market) {
  const { base, quote, scale } = market;
  document.title = `${info.name} · ${market.name}`;
  setText(byId("logo"), info.name);
  setText(byId("pair-name"), market.name);
  setText(byId("pair-badge"), badgeOf(base));
  setText(byId("unit"), `${quote.symbol} за ${base.symbol}`);
  for (const id of ["book-price-head", "tape-price-head"]) {
    setText(byId(id), `Цена, ${quote.symbol}`);
  }
  for (const id of ["book-qty-head", "tape-qty-head"]) {
    setText(byId(id), `Объём, ${base.symbol}`);
  }
  setText(byId("price-unit"), quote.symbol);
  setText(byId("amount-unit"), base.symbol);
  setText(byId("step"), `шаг ${formatPrice(1n, scale)}`);
  byId("chart").setAttribute("aria-label", `График цены ${base.symbol} в ${quote.symbol}`);
  inputById("amount").placeholder = formatUnits(0n, 0, qtyDigits(scale));
}

/**
 * The header's line about the network.
 * @param {boolean} online
 * @param {number | null} height
 */
export function renderNetwork(online, height) {
  byId("net").classList.toggle("hidden", online);
  setText(byId("height"), height === null ? "блок —" : `блок ${formatUnits(BigInt(height), 0, 0)}`);
}

/**
 * The last price and the day's figures.
 * @param {Market} market
 * @param {Snapshot} snap
 */
export function renderMarket(market, snap) {
  const scale = market.scale;
  setText(byId("last"), snap.last === null ? "—" : formatPrice(snap.last, scale));
  const chip = byId("day-change");
  const day = snap.day;
  const moved = day === null || snap.last === null ? null : change(snap.last, day.o);
  if (day === null || moved === null) {
    chip.className = "chip ground";
    setText(chip, "за сутки сделок не было");
    for (const id of ["day-high", "day-low", "day-volume"]) {
      setText(byId(id), "—");
    }
    return;
  }
  const fell = snap.last !== null && snap.last < day.o;
  chip.className = fell ? "chip peach" : "chip mint";
  setText(chip, `${moved} за сутки`);
  setText(byId("day-high"), formatPrice(day.h, scale));
  setText(byId("day-low"), formatPrice(day.l, scale));
  const volume = day.v * scale.lot;
  const digits = volume / 10n ** BigInt(scale.baseDecimals) >= 1_000n ? 0 : 2;
  setText(byId("day-volume"), `${formatUnits(volume, scale.baseDecimals, digits)} ${market.base.symbol}`);
}

/** @returns {HTMLElement} */
function makeLevel() {
  const row = el("button", "level num");
  row.setAttribute("type", "button");
  row.append(el("i"), el("span"), el("span"), el("span"));
  return row;
}

/**
 * One side of the book.
 * @param {HTMLElement} host
 * @param {"ask" | "bid"} kind
 * @param {Level[]} levels best first
 * @param {Scale} scale
 * @param {number} count levels to show
 */
function renderSide(host, kind, levels, scale, count) {
  let running = 0n;
  const rows = levels.slice(0, count).map((level) => {
    running += level.lots;
    return { level, total: running };
  });
  const deepest = running;
  // Asks hang above the spread with the best one nearest to it.
  const ordered = kind === "ask" ? rows.reverse() : rows;
  sync(host, kind, ordered, makeLevel, (row, item) => {
    row.className = `level num ${kind}`;
    row.dataset.ticks = item.level.ticks.toString();
    const share = deepest > 0n ? Number((item.total * 1000n) / deepest) / 10 : 0;
    cell(row, 0).style.width = `${share}%`;
    setText(cell(row, 1), formatPrice(item.level.ticks, scale));
    setText(cell(row, 2), formatQty(item.level.lots, scale));
    setText(cell(row, 3), formatQty(item.total, scale));
  });
}

/**
 * The order book and the gap between its sides: as many levels a side
 * as the tile has room for, the same number on both.
 * @param {Market} market
 * @param {Snapshot} snap
 */
export function renderBook(market, snap) {
  const scale = market.scale;
  const asks = byId("asks");
  const bids = byId("bids");
  const count = Math.min(rowsThatFit(asks, MIN_LEVELS, MAX_LEVELS), rowsThatFit(bids, MIN_LEVELS, MAX_LEVELS));
  renderSide(asks, "ask", snap.asks, scale, count);
  renderSide(bids, "bid", snap.bids, scale, count);
  setText(byId("mid"), snap.last === null ? "—" : formatPrice(snap.last, scale));
  const ask = snap.asks[0];
  const bid = snap.bids[0];
  const gap = ask !== undefined && bid !== undefined && ask.ticks > bid.ticks ? ask.ticks - bid.ticks : null;
  setText(byId("gap"), gap === null ? "—" : formatPrice(gap, scale));
}

/**
 * The latest trades of the market, newest first, as many as fit.
 * @param {Market} market
 * @param {Snapshot} snap
 */
export function renderTape(market, snap) {
  const scale = market.scale;
  const host = byId("tape");
  const newest = snap.trades.slice(-rowsThatFit(host, MIN_TAPE, MAX_TAPE)).reverse();
  byId("tape-empty").classList.toggle("hidden", newest.length > 0);
  sync(
    host,
    "trade",
    newest,
    () => {
      const row = el("div", "trade num");
      row.append(el("span"), el("span"), el("span"));
      return row;
    },
    (row, trade) => {
      const price = cell(row, 0);
      price.className = trade.side;
      setText(price, formatPrice(trade.ticks, scale));
      setText(cell(row, 1), formatQty(trade.lots, scale));
      setText(cell(row, 2), clock(trade.timeMs, true));
    },
  );
}

/**
 * @param {AccountView | null} view
 * @param {number} asset
 * @returns {Balance}
 */
export function balanceOf(view, asset) {
  return view?.balances.get(asset) ?? { free: 0n, locked: 0n };
}

/**
 * A list in words: "a", "a и b", "a, b и c".
 * @param {string[]} items
 * @returns {string}
 */
function listed(items) {
  const last = items[items.length - 1] ?? "";
  return items.length < 2 ? last : `${items.slice(0, -1).join(", ")} и ${last}`;
}

/**
 * The pair's coins the account holds on the exchange.
 * @param {Info} info
 * @param {Market} market
 * @param {Account | null} account
 * @param {AccountView | null} view
 * @param {boolean} inWallet the page is open inside the wallet's browser
 * @param {string | null} [evmAddress] the EVM wallet connected, if any
 */
export function renderWallet(info, market, account, view, inWallet, evmAddress = null) {
  for (const [prefix, asset] of /** @type {[string, Asset][]} */ ([["base", market.base], ["quote", market.quote]])) {
    const balance = balanceOf(view, asset.id);
    setText(byId(`${prefix}-symbol`), asset.symbol);
    setText(byId(`${prefix}-badge`), badgeOf(asset));
    setText(byId(`${prefix}-free`), formatUnits(balance.free, asset.decimals, COIN_DIGITS));
    setText(byId(`${prefix}-locked`), `ещё ${formatUnits(balance.locked, asset.decimals, COIN_DIGITS)} в заявках`);
  }
  const wait = view?.faucetWait ?? 0;
  const deposit = buttonById("deposit");
  deposit.disabled = account === null || wait > 0;
  // A network without a faucet (a chain node behind the gateway): coins
  // come onto the exchange from a Tint wallet, so there is no button.
  const hasFaucet = info.faucet.length > 0;
  deposit.classList.toggle("hidden", !hasFaucet);
  // Two coins by name, the rest in a word: a list of a dozen says nothing.
  const named = info.faucet.slice(0, 2).map(({ asset, amount }) => {
    const whole = amount % 10n ** BigInt(asset.decimals) === 0n;
    return `${formatUnits(amount, asset.decimals, whole ? 0 : 2)} ${asset.symbol}`;
  });
  const rest = info.faucet.length - named.length;
  const gift = rest > 1 ? `${named.join(", ")} и понемногу остальных монет` : listed(info.faucet.map(({ asset, amount }) => {
    const whole = amount % 10n ** BigInt(asset.decimals) === 0n;
    return `${formatUnits(amount, asset.decimals, whole ? 0 : 2)} ${asset.symbol}`;
  }));
  let note = hasFaucet
    ? `Это тестовая сеть: «Пополнить» выдаёт ${gift}, они ничего не стоят.`
    : "Монеты попадают на счёт биржи переводом из кошелька Tint и уходят с неё так же.";
  if (account === null && evmAddress !== null) {
    note = "Кошелёк подключён. Нажмите «Включить торговлю» в форме заявки: кошелёк подпишет одно сообщение, и появится счёт биржи.";
  } else if (account === null) {
    note = inWallet
      ? "Сначала подключите кошелёк: ключ счёта останется в нём, странице он не передаётся."
      : "Сначала создайте счёт: его ключ появится в этом браузере и никуда не уйдёт.";
  } else if (hasFaucet && wait > 0) {
    note = `Тестовые монеты выданы. Ещё раз — через ${wait} бл.`;
  }
  if (account?.source === "evm") {
    note = `${note} Торговый ключ хранится в этом браузере и может только торговать и переводить монеты этого счёта биржи. Вывести можно только в этот же кошелёк.`;
  }
  setText(byId("wallet-note"), hasFaucet && account?.source !== "evm" ? `${note} Вывод появится, когда биржа подключится к сети.` : note);
  const canWithdraw = account?.source === "evm" && evmAddress !== null;
  /** @type {HTMLButtonElement} */ (byId("withdraw")).disabled = !canWithdraw;
  byId("withdraw").setAttribute(
    "title",
    canWithdraw ? "Вывести монеты в подключённый кошелёк" : "Вывод появится, когда биржа подключится к сети",
  );

  const pill = byId("account");
  byId("account-dot").classList.toggle("hidden", account === null && evmAddress === null);
  const name = account === null ? "Подключить" : shortHex(account.hex);
  setText(
    byId("account-name"),
    evmAddress !== null ? shortAddress(evmAddress) : account?.source === "wallet" ? `Кошелёк · ${name}` : name,
  );
  pill.title =
    account === null && evmAddress === null ? "Подключить кошелёк для торговли" : "Счёт, кошелёк и выход: нажмите, чтобы открыть меню";
}

/** @returns {HTMLElement} */
function makeRow() {
  const row = el("div", "order");
  const first = el("span");
  first.append(el("span", "chip"));
  const bar = el("span", "bar-cell");
  const track = el("span", "fill");
  track.append(el("i"));
  bar.append(track, el("small"));
  row.append(first, el("span", "num"), el("span", "num"), bar, el("span", "num tail"));
  return row;
}

/** @returns {HTMLElement} */
function makeOrderRow() {
  const row = makeRow();
  const cancel = el("button", "round ground tiny", "✕");
  cancel.setAttribute("type", "button");
  cancel.setAttribute("aria-label", "Снять заявку");
  cell(row, 4).replaceWith(cancel);
  return row;
}

/**
 * @param {HTMLElement} row
 * @returns {{ chip: HTMLElement, a: HTMLElement, b: HTMLElement, track: HTMLElement, bar: HTMLElement, note: HTMLElement, tail: HTMLElement }}
 */
function parts(row) {
  const barCell = cell(row, 3);
  const track = cell(barCell, 0);
  return {
    chip: cell(cell(row, 0), 0),
    a: cell(row, 1),
    b: cell(row, 2),
    track,
    bar: cell(track, 0),
    note: cell(barCell, 1),
    tail: cell(row, 4),
  };
}

/**
 * The account's open orders and trades in the pair, or its transfers, as
 * the chosen tab says.
 * @param {Info} info
 * @param {Market} market
 * @param {AccountView | null} view
 * @param {"orders" | "fills" | "transfers"} tab
 */
export function renderActivity(info, market, view, tab) {
  const scale = market.scale;
  const orders = view?.orders ?? [];
  setText(byId("tab-orders"), orders.length > 0 ? `Открытые заявки · ${orders.length}` : "Открытые заявки");
  press(byId("tabs"), "tab", tab);
  byId("cancel-all").classList.toggle("hidden", tab !== "orders" || orders.length === 0);
  const host = byId("activity");
  const empty = byId("activity-empty");
  const heads = {
    orders: ["Сторона", "Цена", "Осталось", "Исполнено", ""],
    fills: ["Сторона", "Цена", "Объём", "Комиссия", "Время"],
    transfers: ["Вид", "Сумма", "Блок", "", "Время"],
  }[tab];
  byId("activity-head").classList.toggle("wide", tab !== "orders");
  heads.forEach((head, index) => setText(cell(byId("activity-head"), index), head));

  if (tab === "orders") {
    setText(
      empty,
      view === null ? "Заявки появятся здесь, когда у вас будет счёт." : `Открытых заявок в паре ${market.name} нет.`,
    );
    empty.classList.toggle("hidden", orders.length > 0);
    sync(host, "orders", orders, makeOrderRow, (row, order) => {
      const p = parts(row);
      sideChip(p.chip, order.side);
      setText(p.a, formatPrice(order.ticks, scale));
      setText(p.b, formatQty(order.remaining, scale));
      const placed = order.placed !== null && order.placed >= order.remaining ? order.placed : null;
      const filled = placed === null ? 0n : placed - order.remaining;
      p.bar.style.width = placed === null || placed === 0n ? "0%" : `${Number((filled * 100n) / placed)}%`;
      setText(
        p.note,
        placed === null || filled === 0n
          ? "ждёт в стакане"
          : `${formatQty(filled, scale)} из ${formatQty(placed, scale)} ${market.base.symbol}`,
      );
      p.tail.dataset.order = order.id.toString();
    });
    return;
  }

  if (tab === "fills") {
    const fills = (view?.fills ?? []).slice(-HISTORY_ROWS).reverse();
    setText(empty, `Сделок в паре ${market.name} пока нет.`);
    empty.classList.toggle("hidden", fills.length > 0);
    sync(host, "fills", fills, makeRow, (row, fill) => {
      row.className = "order wide";
      const p = parts(row);
      sideChip(p.chip, fill.side);
      setText(p.a, formatPrice(fill.ticks, scale));
      setText(p.b, formatQty(fill.lots, scale));
      p.track.classList.add("hidden");
      const coin = fill.feeAsset === market.base.id ? market.base : market.quote;
      const fee = fill.fee === 0n ? "без комиссии" : `${formatUnits(fill.fee, coin.decimals, 4)} ${coin.symbol}`;
      setText(p.note, `${fee} · ${fill.maker ? "из стакана" : "сразу"}`);
      setText(p.tail, clock(fill.timeMs, true));
    });
    return;
  }

  const transfers = (view?.transfers ?? []).slice(-HISTORY_ROWS).reverse();
  setText(empty, "Пополнений и выводов пока нет.");
  empty.classList.toggle("hidden", transfers.length > 0);
  sync(host, "transfers", transfers, makeRow, (row, transfer) => {
    row.className = "order wide";
    const p = parts(row);
    p.chip.className = transfer.deposit ? "chip mint" : "chip peach";
    setText(p.chip, transfer.deposit ? "Пополнение" : "Вывод");
    const coin = info.assets.find((asset) => asset.id === transfer.asset);
    setText(
      p.a,
      coin === undefined
        ? `монета № ${transfer.asset}`
        : `${formatUnits(transfer.amount, coin.decimals, COIN_DIGITS)} ${coin.symbol}`,
    );
    setText(p.b, formatUnits(BigInt(transfer.height), 0, 0));
    p.track.classList.add("hidden");
    setText(p.note, "");
    setText(p.tail, clock(transfer.timeMs, true));
  });
}

/**
 * The block the page shows and the root of the exchange's state in it.
 * @param {Snapshot} snap
 */
export function renderProof(snap) {
  setText(byId("proof-height"), formatUnits(BigInt(snap.height), 0, 0));
  const root = byId("proof-root");
  setText(root, shortHex(snap.stateRoot));
  root.title = snap.stateRoot;
}

/**
 * The line under the order form that says what happened.
 * @param {string} content
 * @param {"plain" | "good" | "bad"} tone
 */
export function say(content, tone) {
  const line = byId("notice");
  line.className = tone === "plain" ? "notice" : `notice ${tone}`;
  setText(line, content);
}
