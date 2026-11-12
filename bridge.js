// @ts-check
// The "deposit from the wallet" panel in the coins tile. Shown only while
// an EVM wallet is connected and trading is enabled.

import { EvmError, deposit, parseUnits } from "./evm.js";
import { el } from "./view.js";

/**
 * @typedef {object} BridgeHost
 * @property {() => import("./evm.js").EvmProvider | null} provider
 * @property {() => string | null} owner the EVM address
 * @property {() => Uint8Array | null} account the trading key's public key
 * @property {() => readonly import("./evm.js").EvmNetwork[]} networks
 */

const REASONS = {
  rejected: "Вы отклонили запрос в кошельке.",
  pending: "В кошельке уже есть незавершённый запрос. Откройте кошелёк.",
  unsupported: "Кошелёк не поддерживает этот запрос.",
  failed: "Кошелёк не выполнил запрос. Проверьте сеть и баланс и попробуйте ещё раз.",
  bad_reply: "Кошелёк ответил непонятно. Попробуйте ещё раз.",
};

/**
 * @param {unknown} error
 * @returns {string}
 */
export function explainEvm(error) {
  return error instanceof EvmError ? REASONS[error.code] : REASONS.failed;
}

/**
 * @param {string} text
 * @param {string} [cls]
 * @returns {HTMLElement}
 */
function line(text, cls = "") {
  return el("p", cls, text);
}

/**
 * Builds the panel into `#bridge` and returns a redraw function.
 * @param {BridgeHost} host
 * @returns {() => void}
 */
export function mountBridge(host) {
  const root = document.getElementById("bridge");
  if (root === null) {
    throw new Error("the page has no #bridge");
  }
  let busy = false;
  let shownFor = "";
  /** @type {{ net: HTMLSelectElement, coin: HTMLSelectElement, amount: HTMLInputElement, send: HTMLButtonElement, status: HTMLElement } | null} */
  let form = null;

  /** @returns {import("./evm.js").EvmNetwork | null} */
  function chosenNetwork() {
    const nets = host.networks();
    return form === null ? null : (nets[Number(form.net.value)] ?? null);
  }

  /** Refills the coin list for the chosen network. */
  function fillCoins() {
    const net = chosenNetwork();
    if (form === null || net === null) {
      return;
    }
    form.coin.replaceChildren(
      ...net.tokens.map((token, index) => {
        const option = el("option", "", token.symbol);
        option.value = String(index);
        return option;
      }),
    );
  }

  async function send() {
    const net = chosenNetwork();
    const provider = host.provider();
    const owner = host.owner();
    const account = host.account();
    if (form === null || net === null || provider === null || owner === null || account === null || busy) {
      return;
    }
    const token = net.tokens[Number(form.coin.value)];
    if (token === undefined) {
      return;
    }
    const amount = parseUnits(form.amount.value, token.decimals);
    if (amount === null) {
      form.status.className = "bad";
      form.status.textContent = `Введите сумму больше нуля, не более ${token.decimals} знаков после запятой.`;
      return;
    }
    busy = true;
    form.send.disabled = true;
    const status = form.status;
    status.className = "";
    try {
      const hash = await deposit({
        provider,
        owner,
        network: net,
        token,
        amount,
        account,
        step: (step) => {
          status.textContent =
            step === "switch"
              ? `Подтвердите смену сети на ${net.name} в кошельке…`
              : step === "approve"
                ? "Подтвердите разрешение на списание монеты, потом дождёмся его записи…"
                : "Подтвердите пополнение в кошельке…";
        },
      });
      status.className = "good";
      status.replaceChildren(
        `Пополнение отправлено. Номер операции: `,
        el("span", "hash", hash),
        `. Монеты появятся на бирже после ${net.confirmations} подтверждений сети ${net.name}.`,
      );
    } catch (error) {
      status.className = "bad";
      status.textContent = explainEvm(error);
    } finally {
      busy = false;
      form.send.disabled = false;
    }
  }

  /** @returns {NonNullable<typeof form>} */
  function build() {
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
    const button = el("button", "pill small", "Пополнить из кошелька");
    button.type = "button";
    const status = el("p");
    net.addEventListener("change", fillCoins);
    button.addEventListener("click", () => void send());
    root?.replaceChildren(
      el("h3", "", "Пополнить из кошелька"),
      net,
      coin,
      box,
      button,
      status,
      line("Мост кастодиальный: монеты на время пополнения остаются на его счёте."),
    );
    return { net, coin, amount: input, send: button, status };
  }

  return function redraw() {
    const provider = host.provider();
    const ready = provider !== null && host.owner() !== null && host.account() !== null;
    root.classList.toggle("hidden", !ready);
    if (!ready) {
      return;
    }
    const nets = host.networks();
    const key = nets.map((n) => `${n.chainId}:${n.tokens.length}`).join("|");
    if (key === shownFor && root.childElementCount > 0) {
      return;
    }
    shownFor = key;
    if (nets.length === 0) {
      form = null;
      root.replaceChildren(
        el("h3", "", "Пополнить из кошелька"),
        line("Пополнение из кошелька появится, когда мост будет запущен."),
      );
      return;
    }
    form = build();
    form.net.replaceChildren(
      ...nets.map((n, index) => {
        const option = el("option", "", n.name);
        option.value = String(index);
        return option;
      }),
    );
    fillCoins();
  };
}
