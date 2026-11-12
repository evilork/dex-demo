// @ts-check
// The wallet picker and the account menu: one modal window, built from
// plain nodes (never from wallet-supplied markup).

import { el } from "./view.js";
import { shortAddress } from "./evm.js";

/** @returns {HTMLElement} */
function node(id) {
  const found = document.getElementById(id);
  if (found === null) {
    throw new Error(`the page has no #${id}`);
  }
  return found;
}

/** Hides the window. */
export function closeModal() {
  node("modal").classList.add("hidden");
}

/** @returns {boolean} */
export function modalOpen() {
  return !node("modal").classList.contains("hidden");
}

/** @returns {boolean} whether the window now shows the picker */
export function pickerShown() {
  return node("modal-title").textContent === "Подключить кошелёк";
}

/** Wires the close button, the backdrop and Escape. */
export function wireModal() {
  node("modal-close").addEventListener("click", closeModal);
  node("modal").addEventListener("click", (event) => {
    if (event.target === node("modal")) {
      closeModal();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && modalOpen()) {
      closeModal();
    }
  });
}

/**
 * @param {string} title
 * @param {Node[]} content
 */
function show(title, content) {
  node("modal-title").textContent = title;
  node("modal-body").replaceChildren(...content);
  node("modal").classList.remove("hidden");
}

/**
 * @param {string} label
 * @param {string | null} hint
 * @param {Node | string} badge
 * @param {() => void} onPick
 * @returns {HTMLElement}
 */
function choice(label, hint, badge, onPick) {
  const button = el("button", "choice");
  button.type = "button";
  const slot = el("span", "logo-slot");
  slot.append(badge);
  const text = el("span");
  text.append(label);
  if (hint !== null) {
    text.append(el("small", "", hint));
  }
  button.append(slot, text);
  button.addEventListener("click", onPick);
  return button;
}

/**
 * @param {import("./evm.js").EvmWallet} wallet
 * @returns {Node | string}
 */
function badgeOf(wallet) {
  if (wallet.icon !== null) {
    const image = document.createElement("img");
    image.alt = "";
    image.src = wallet.icon;
    return image;
  }
  return (wallet.name.trim()[0] ?? "?").toUpperCase();
}

/**
 * Lists what a person can connect.
 * @param {object} args
 * @param {import("./evm.js").EvmWallet[] | null} args.wallets null while the search runs
 * @param {boolean} args.tintWallet
 * @param {boolean} args.key whether this browser can keep a key
 * @param {(wallet: import("./evm.js").EvmWallet) => void} args.onEvm
 * @param {() => void} args.onTint
 * @param {() => void} args.onKey
 */
export function showPicker({ wallets, tintWallet, key, onEvm, onTint, onKey }) {
  const list = el("div", "choices");
  for (const wallet of wallets ?? []) {
    list.append(choice(wallet.name, null, badgeOf(wallet), () => onEvm(wallet)));
  }
  if (tintWallet) {
    list.append(choice("Tint Wallet", "кошелёк, в котором открыта страница", "T", onTint));
  }
  if (key) {
    list.append(choice("Ключ в этом браузере", "ключ хранится только в этом браузере", "⚿", onKey));
  }
  /** @type {Node[]} */
  const body = [list];
  if (wallets === null) {
    body.push(el("p", "muted", "Ищем кошельки…"));
  } else if (wallets.length === 0) {
    body.push(
      el("p", "muted", "Кошелёк для сети EVM не найден. Можно установить MetaMask, Rabby или другой кошелёк и обновить страницу."),
    );
  }
  show("Подключить кошелёк", body);
}

/**
 * The menu of a connected account.
 * @param {object} args
 * @param {string | null} args.address the EVM address, if connected through one
 * @param {string | null} args.account the exchange account, if trading is on
 * @param {boolean} args.canForget whether a kept key can be forgotten
 * @param {() => void} args.onCopy
 * @param {() => void} args.onSwitch
 * @param {() => void} args.onDisconnect
 * @param {() => void} args.onForget
 */
export function showMenu({ address, account, canForget, onCopy, onSwitch, onDisconnect, onForget }) {
  /** @type {Node[]} */
  const body = [];
  if (address !== null) {
    body.push(el("p", "muted", `Кошелёк: ${shortAddress(address)}`));
  }
  body.push(
    el(
      "p",
      "muted",
      account === null
        ? "Торговля не включена: нажмите «Включить торговлю» в форме заявки."
        : `Счёт на бирже: ${shortAddress(account)}. Торговый ключ хранится в этом браузере и может только торговать и переводить монеты этого счёта биржи.`,
    ),
  );
  const row = el("div", "row-end");
  const copy = el("button", "pill small light", "Скопировать счёт");
  copy.type = "button";
  copy.disabled = account === null;
  copy.addEventListener("click", onCopy);
  const change = el("button", "pill small light", "Сменить");
  change.type = "button";
  change.addEventListener("click", onSwitch);
  row.append(copy, change);
  body.push(row);
  if (address !== null) {
    const out = el("div", "row-end");
    const off = el("button", "pill small light", "Отключить");
    off.type = "button";
    off.addEventListener("click", onDisconnect);
    out.append(off);
    body.push(out);
    if (canForget) {
      const confirm = el("p", "muted bad", "");
      const forget = el("button", "pill small light", "Забыть ключ");
      forget.type = "button";
      let asked = false;
      forget.addEventListener("click", () => {
        if (!asked) {
          asked = true;
          confirm.textContent = "Ключ исчезнет из этого браузера. Подпишите в кошельке снова, и тот же счёт вернётся. Нажмите ещё раз, чтобы забыть.";
          forget.textContent = "Да, забыть ключ";
          return;
        }
        onForget();
      });
      out.append(forget);
      body.push(confirm);
    }
  }
  show("Счёт", body);
}
