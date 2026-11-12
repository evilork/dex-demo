// @ts-check
// The list of pairs that opens from the strip: a search, groups, a row
// per pair with its price and its day, a star to keep a pair on top.
// What to show is decided in pairs.js; this file draws it and listens.

import * as pairs from "./pairs.js";
import { change, formatPrice, formatUnits } from "./units.js";
import { buttonById, byId, el, inputById, setText } from "./view.js";

const STARRED_KEY = "dex.starred";

/** @type {Record<string, string>} */
const GROUP_NAMES = { [pairs.ALL]: "Все", [pairs.STARRED]: "★ Мои" };

/**
 * Reads the browser's store; a browser that keeps none reads as empty.
 * @param {string} key
 * @returns {string | null}
 */
export function recall(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Writes to the browser's store, if it keeps one.
 * @param {string} key
 * @param {string} value
 */
export function remember(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Nothing is lost but the convenience.
  }
}

/**
 * A day's volume of a pair, in its base coin.
 * @param {Market} market
 * @param {bigint} lots
 * @returns {string}
 */
export function volumeText(market, lots) {
  const units = lots * market.scale.lot;
  const whole = units / 10n ** BigInt(market.base.decimals);
  return `${formatUnits(units, market.base.decimals, whole >= 1_000n ? 0 : 2)} ${market.base.symbol}`;
}

/**
 * Sets up the list of pairs.
 * @param {(market: Market) => void} choose called when the person picks a pair
 * @returns {{ update: (info: Info, briefs: MarketBrief[], current: Market) => void, close: () => void }}
 */
export function createPicker(choose) {
  const button = buttonById("pair");
  const panel = byId("pairs");
  const search = inputById("pair-search");
  const groupsHost = byId("pair-groups");
  const listHost = byId("pair-list");
  const empty = byId("pair-empty");

  const state = {
    open: false,
    /** @type {Market[]} */
    markets: [],
    /** @type {Map<number, MarketBrief>} */
    briefs: new Map(),
    /** @type {number | null} */
    current: null,
    group: pairs.ALL,
    starred: pairs.readStarred(recall(STARRED_KEY)),
    /** The row the keys are on. */
    active: -1,
    /** What the list shows now. @type {Market[]} */
    rows: [],
  };

  /** @returns {HTMLElement} */
  function makeRow() {
    const row = el("div", "pair-row");
    row.setAttribute("role", "option");
    const star = el("button", "star", "★");
    star.setAttribute("type", "button");
    const name = el("span", "pair-cell");
    const line = el("span");
    line.append(el("b"), el("span", "quiet"));
    name.append(line, el("small", "net"));
    row.append(star, name, el("span", "num"), el("span", "num"), el("span", "num quiet"));
    return row;
  }

  /**
   * @param {Element} row
   * @param {number} index
   * @returns {HTMLElement}
   */
  function part(row, index) {
    const node = row.children[index];
    if (!(node instanceof HTMLElement)) {
      throw new Error("a pair's row lost its cell");
    }
    return node;
  }

  /** Draws the groups and the rows from the state. */
  function draw() {
    const names = pairs.groups(state.markets);
    if (!names.includes(state.group)) {
      state.group = pairs.ALL;
    }
    if (groupsHost.children.length !== names.length) {
      groupsHost.replaceChildren(
        ...names.map((name) => {
          const tab = el("button", "", GROUP_NAMES[name] ?? name);
          tab.setAttribute("type", "button");
          tab.dataset.group = name;
          return tab;
        }),
      );
    }
    for (const tab of groupsHost.children) {
      tab.setAttribute("aria-pressed", String(tab instanceof HTMLElement && tab.dataset.group === state.group));
    }

    state.rows = pairs.shown(state.markets, search.value, state.group, state.starred);
    if (state.active >= state.rows.length) {
      state.active = state.rows.length - 1;
    }
    while (listHost.children.length > state.rows.length) {
      listHost.lastElementChild?.remove();
    }
    while (listHost.children.length < state.rows.length) {
      listHost.append(makeRow());
    }
    state.rows.forEach((market, index) => {
      const row = part(listHost, index);
      const isCurrent = market.id === state.current;
      row.className = `pair-row${index === state.active ? " active" : ""}${isCurrent ? " current" : ""}`;
      row.dataset.market = String(market.id);
      row.setAttribute("aria-selected", String(isCurrent));

      const star = part(row, 0);
      const starred = state.starred.has(market.slug);
      star.dataset.star = market.slug;
      star.setAttribute("aria-pressed", String(starred));
      star.setAttribute("aria-label", starred ? `Убрать ${market.name} из моих` : `Добавить ${market.name} в мои`);

      const name = part(row, 1);
      const line = part(name, 0);
      setText(part(line, 0), market.base.symbol);
      setText(part(line, 1), ` / ${market.quote.symbol}`);
      setText(part(name, 1), market.base.network);

      const brief = state.briefs.get(market.id);
      const last = brief?.last ?? null;
      const day = brief?.day ?? null;
      setText(part(row, 2), last === null ? "—" : formatPrice(last, market.scale));
      const moved = last === null || day === null ? null : change(last, day.o);
      const cell = part(row, 3);
      cell.className = `num ${moved === null ? "quiet" : last !== null && day !== null && last < day.o ? "down" : "up"}`;
      setText(cell, moved ?? "—");
      setText(part(row, 4), day === null ? "—" : volumeText(market, day.v));
    });
    const nothing = state.rows.length === 0;
    empty.classList.toggle("hidden", !nothing);
    setText(
      empty,
      state.group === pairs.STARRED && search.value.trim() === ""
        ? "Здесь будут пары, которые вы отметите звёздочкой."
        : "Таких пар нет.",
    );
  }

  /** @param {boolean} open */
  function setOpen(open) {
    if (state.open === open) {
      return;
    }
    state.open = open;
    panel.classList.toggle("hidden", !open);
    button.setAttribute("aria-expanded", String(open));
    if (open) {
      search.value = "";
      state.active = -1;
      draw();
      search.focus();
    }
  }

  /** @param {number} index */
  function pick(index) {
    const market = state.rows[index];
    if (market !== undefined) {
      setOpen(false);
      button.focus();
      choose(market);
    }
  }

  button.addEventListener("click", () => setOpen(!state.open));
  search.addEventListener("input", () => {
    // The first match is one Enter away.
    state.active = search.value.trim() === "" ? -1 : 0;
    draw();
  });
  panel.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
      button.focus();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      state.active = pairs.moved(state.active, event.key === "ArrowDown" ? 1 : -1, state.rows.length);
      draw();
      listHost.children[state.active]?.scrollIntoView({ block: "nearest" });
    } else if (event.key === "Enter" && event.target === search) {
      event.preventDefault();
      pick(state.active >= 0 ? state.active : 0);
    }
  });
  groupsHost.addEventListener("click", (event) => {
    const tab = event.target instanceof Element ? event.target.closest("button") : null;
    const group = tab instanceof HTMLElement ? tab.dataset.group : undefined;
    if (group !== undefined) {
      state.group = group;
      state.active = -1;
      draw();
      search.focus();
    }
  });
  listHost.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    const star = target?.closest("button");
    if (star instanceof HTMLElement && star.dataset.star !== undefined) {
      state.starred = pairs.toggled(state.starred, star.dataset.star);
      remember(STARRED_KEY, pairs.writeStarred(state.starred));
      draw();
      return;
    }
    const row = target?.closest(".pair-row");
    if (row instanceof HTMLElement && row.parentElement === listHost) {
      pick([...listHost.children].indexOf(row));
    }
  });
  // A click anywhere else, or the focus leaving, closes the list.
  document.addEventListener("pointerdown", (event) => {
    if (state.open && event.target instanceof Node && !byId("picker").contains(event.target)) {
      setOpen(false);
    }
  });
  byId("picker").addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (state.open && next instanceof Node && !byId("picker").contains(next)) {
      setOpen(false);
    }
  });

  return {
    update(info, briefs, current) {
      state.markets = info.markets;
      state.briefs = new Map(briefs.map((brief) => [brief.id, brief]));
      state.current = current.id;
      if (state.open) {
        draw();
      }
    },
    close() {
      setOpen(false);
    },
  };
}
