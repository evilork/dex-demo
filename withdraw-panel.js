// @ts-check
// The "Вывести" panel in the coins tile: drawing and clicks only. The
// steps and every check are in `withdraw.js`.

import { WithdrawError, createWithdrawal, explainWithdraw, spendText, stepText } from "./withdraw.js";
import { formatUnits } from "./units.js";
import { el } from "./view.js";

/**
 * @typedef {import("./withdraw.js").WithdrawHost & { demo: boolean }} PanelHost
 */

const DEMO_NOTE = "Это демо: монеты никуда не отправляются, списание видно только на этой странице.";

/**
 * "от 1 до 5 000 USDC" under the amount, when the coin has limits.
 * @param {import("./withdraw.js").Choice | undefined} coin
 * @returns {string}
 */
function rangeText(coin) {
  if (coin === undefined || coin.rule === null) {
    return "";
  }
  const { minimum, maximum, granularity } = coin.rule;
  const digits = Math.min(coin.tokenDecimals, 8);
  const range = `от ${formatUnits(minimum, coin.tokenDecimals, digits)} до ${formatUnits(maximum, coin.tokenDecimals, digits)} ${coin.symbol}`;
  if (granularity <= 1n) {
    return range;
  }
  const step = stepText(granularity, coin.tokenDecimals);
  return coin.fee === null
    ? `${range}; за вычетом комиссии сети Tint сумма делится на ${step}`
    : `${range}; сумма делится на ${step}`;
}

/**
 * Wires the panel into `#withdraw-panel` and the button that opens it.
 * @param {PanelHost} host
 * @returns {() => void} a redraw: closes the panel when withdrawing stops being possible
 */
export function mountWithdraw(host) {
  const root = document.getElementById("withdraw-panel");
  const opener = document.getElementById("withdraw");
  if (root === null || opener === null) {
    throw new Error("the page has no withdraw panel");
  }
  const flow = createWithdrawal(host);
  let open = false;
  /** Rewrites the free-balance line of the drawn panel. @type {() => void} */
  let showFree = () => {};

  /**
   * @param {HTMLElement} status
   * @param {string} text
   * @param {"" | "bad" | "good"} cls
   */
  function show(status, text, cls) {
    status.className = cls;
    status.textContent = text;
  }

  /** @param {string} text */
  function note(text) {
    root?.replaceChildren(el("h3", "", "Вывести в кошелёк"), ...(host.demo ? [el("p", "", DEMO_NOTE)] : []), el("p", "", text));
  }

  async function start() {
    note("Спрашиваем у моста, что можно вывести…");
    try {
      const options = await flow.load();
      if (options.length === 0) {
        note("Вывод в кошелёк появится, когда мост будет запущен.");
        return;
      }
      draw(options);
    } catch (error) {
      note(explainWithdraw(error));
    }
  }

  /** @param {import("./withdraw.js").NetworkChoice[]} options */
  function draw(options) {
    const net = el("select");
    net.setAttribute("aria-label", "Сеть");
    const coin = el("select");
    coin.setAttribute("aria-label", "Монета");
    const input = el("input");
    input.type = "text";
    input.inputMode = "decimal";
    input.placeholder = "Сумма";
    input.autocomplete = "off";
    input.maxLength = 40;
    input.setAttribute("aria-label", "Сумма");
    const box = el("div", "box");
    box.append(input);
    const balance = el("p");
    const limits = el("p");
    const spend = el("p");
    const prepare = el("button", "pill small", "Подготовить");
    prepare.type = "button";
    const sign = el("button", "pill small hidden", "Подписать и вывести");
    sign.type = "button";
    const status = el("p");
    net.replaceChildren(
      ...options.map((option, index) => {
        const item = el("option", "", option.name);
        item.value = String(index);
        return item;
      }),
    );

    const chosenNet = () => options[Number(net.value)];
    const chosenCoin = () => chosenNet()?.coins[Number(coin.value)];

    const refill = () => {
      coin.replaceChildren(
        ...(chosenNet()?.coins ?? []).map((c, index) => {
          const item = el("option", "", c.symbol);
          item.value = String(index);
          return item;
        }),
      );
      changed();
    };
    const changed = () => {
      flow.reset();
      sign.classList.add("hidden");
      const c = chosenCoin();
      const label = c?.fee === null || c === undefined ? "Сумма" : "Получить";
      input.placeholder = label;
      input.setAttribute("aria-label", label);
      limits.textContent = rangeText(c);
      spend.textContent = spendText(c, input.value);
      showFree();
    };
    showFree = () => {
      const c = chosenCoin();
      balance.textContent =
        c === undefined ? "" : `Свободно на бирже: ${formatUnits(host.free(c.asset), c.decimals, Math.min(c.decimals, 8))} ${c.symbol}`;
    };
    const lock = (/** @type {boolean} */ on) => {
      prepare.disabled = on;
      sign.disabled = on;
    };

    net.addEventListener("change", refill);
    coin.addEventListener("change", changed);
    input.addEventListener("input", () => {
      spend.textContent = spendText(chosenCoin(), input.value);
      flow.reset();
      sign.classList.add("hidden");
    });
    prepare.addEventListener("click", () => {
      const n = chosenNet();
      const c = chosenCoin();
      if (n === undefined || c === undefined) {
        show(status, explainWithdraw(new WithdrawError("no_choice")), "bad");
        return;
      }
      lock(true);
      show(status, "Готовим вывод…", "");
      flow.prepare({ chainId: n.chainId, asset: c.asset, amountText: input.value }).then(
        (text) => {
          show(status, text, "");
          sign.classList.remove("hidden");
          lock(false);
        },
        (error) => {
          show(status, explainWithdraw(error), "bad");
          sign.classList.add("hidden");
          lock(false);
        },
      );
    });
    sign.addEventListener("click", () => {
      lock(true);
      show(status, "Подписываем и отправляем. Это может занять до минуты, не закрывайте страницу…", "");
      flow.submit().then(
        ({ txid, text }) => {
          status.className = "good";
          status.replaceChildren(text, " Номер операции: ", el("span", "hash", txid), ".");
          sign.classList.add("hidden");
          lock(false);
        },
        (error) => {
          show(status, explainWithdraw(error), "bad");
          sign.classList.add("hidden");
          lock(false);
        },
      );
    });

    root?.replaceChildren(
      el("h3", "", "Вывести в кошелёк"),
      net,
      coin,
      box,
      limits,
      spend,
      balance,
      prepare,
      sign,
      status,
      ...(host.demo ? [el("p", "", DEMO_NOTE)] : []),
      el("p", "", "Монеты придут только на подключённый кошелёк. Мост кастодиальный: он держит монеты, пока не отправит их в сеть."),
    );
    refill();
  }

  opener.addEventListener("click", () => {
    if (flow.busy) {
      return;
    }
    open = !open;
    root.classList.toggle("hidden", !open);
    if (open) {
      void start();
    }
  });

  return function redraw() {
    const possible = host.account() !== null && host.owner() !== null;
    if (!possible && open) {
      open = false;
      flow.reset();
      root.classList.add("hidden");
    }
    if (open) {
      showFree();
    }
  };
}
