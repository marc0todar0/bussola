// ---------------------------------------------------------------------------
// "Something is waiting in the inbox": the Web Push notification
// ---------------------------------------------------------------------------
// Each time an item becomes visible in a wallet's inbox (a draft sent
// ready-made, a notification the model read, or one it could not read and
// that waits for the hand), the devices of that wallet's active members who
// may write there are told, through Web Push (services/push.js). Off unless
// Web Push is: BUSSOLA_PUBLIC_URL set, see docs/notifications.md.
//
//   BUSSOLA_NOTIFY_DETAILS    "on" adds amount and merchant. Default off: the
//                             message only says that something is waiting.
//
// What a message never contains: the notification's text, balances, account
// names or numbers. Details (when on) are the draft's amount and merchant.
// The payload is { title, body, url, tag }: url is the same-origin path the
// tap opens, tag collapses repeats on the phone.
//
// Rate limit, one rule per wallet: the first message goes out at once;
// anything arriving within the next WINDOW (60 s) is counted, and when the
// window ends one summary ("3 items are waiting...") replaces them. So a burst
// of five notifications is two buzzes, never five. In memory: a restart
// forgets the count, which costs at most one missed summary.
//
// Language: each recipient gets the message in their own interface language
// (users.locale), which is why it is built per recipient.
//
// Fire and forget: notify() returns at once, never throws, never runs inside
// a database transaction (callers invoke it after commit); services/push.js
// times out after 5 s, does not retry, and logs a failure as a code and the
// push service's host only.
const push = require("./push");

const MESSAGES = {
  en: { one: "A transaction is waiting for you to confirm", many: "{n} items are waiting for you to confirm", unread: "A notification could not be read: add it by hand", test: "Notifications are working on this device" },
  it: { one: "Un movimento aspetta la tua conferma", many: "{n} elementi aspettano la tua conferma", unread: "Una notifica non si è potuta leggere: inseriscila a mano", test: "Le notifiche funzionano su questo dispositivo" },
  fr: { one: "Une transaction attend votre confirmation", many: "{n} éléments attendent votre confirmation", unread: "Une notification n'a pas pu être lue : saisissez-la à la main", test: "Les notifications fonctionnent sur cet appareil" },
  de: { one: "Eine Buchung wartet auf deine Bestätigung", many: "{n} Einträge warten auf deine Bestätigung", unread: "Eine Benachrichtigung konnte nicht gelesen werden: bitte von Hand erfassen", test: "Benachrichtigungen funktionieren auf diesem Gerät" },
  es: { one: "Un movimiento espera tu confirmación", many: "{n} elementos esperan tu confirmación", unread: "No se pudo leer una notificación: introdúcela a mano", test: "Las notificaciones funcionan en este dispositivo" },
  zh: { one: "有一笔交易等待你确认", many: "有 {n} 条记录等待你确认", unread: "有一条通知无法读取：请手动录入", test: "此设备上的通知运行正常" },
};

const settings = { windowMs: 60_000 };
// For the tests: a shorter window.
const configure = (options = {}) => Object.assign(settings, options);

const detailsOn = () => /^(on|true|1|yes)$/i.test(String(process.env.BUSSOLA_NOTIFY_DETAILS || "").trim());

const pick = (locale) => MESSAGES[String(locale || "").slice(0, 2).toLowerCase()] || MESSAGES.en;

// What the service worker receives. url is a path on this origin; the worker
// refuses anything else. tag makes a new message replace the previous one.
const payload = (body, tag = "bussola-inbox") => ({ title: "Bussola", body, url: "/transactions", tag });

const enabled = () => push.enabled();

// One wallet's window: the first event goes out at once, the rest of the
// window is counted and summarised when it ends.
const windows = new Map(); // walletId -> { lastSent, held, heldEvent, timer }

// The text for one item: with details on and a draft the person can confirm,
// the amount and the merchant on the line above the sentence.
const bodyFor = (event, m) => {
  let body = event.kind === "unread" ? m.unread : m.one;
  if (event.kind !== "unread" && detailsOn()) {
    const amount = Number(event.amount);
    const parts = [];
    if (Number.isFinite(amount)) parts.push(`${amount.toFixed(2)}${event.currency ? ` ${event.currency}` : ""}`);
    if (event.merchant) parts.push(String(event.merchant).slice(0, 80));
    if (parts.length) body = `${parts.join(" · ")}\n${body}`;
  }
  return body;
};

const sendNow = (walletId, makeBody) => {
  void push.toWallet(walletId, (locale) => payload(makeBody(pick(locale))));
};

const flush = (walletId) => {
  const w = windows.get(walletId);
  if (!w) return;
  w.timer = null;
  const n = w.held;
  const only = w.heldEvent;
  w.held = 0;
  w.heldEvent = null;
  if (n === 0) return;
  w.lastSent = Date.now();
  // A single held item is told like any other (with its details, if on); two
  // or more become one count, with no details.
  sendNow(walletId, (m) => (n === 1 && only ? bodyFor(only, m) : m.many.replace("{n}", String(n))));
};

// event: { walletId, kind: "ready" | "unread", amount, currency, merchant }.
// "ready" is a draft the person can confirm; "unread" an item that waits for
// manual entry. Details are used for a message about a single item, whether it
// went out at once or was held for the rest of the window; a summary of two or
// more has none.
const notify = (event = {}) => {
  try {
    if (!enabled() || !Number.isInteger(event.walletId)) return;
    const walletId = event.walletId;
    const now = Date.now();
    let w = windows.get(walletId);
    if (!w) {
      w = { lastSent: 0, held: 0, heldEvent: null, timer: null };
      windows.set(walletId, w);
    }
    if (!w.timer && now - w.lastSent >= settings.windowMs) {
      w.lastSent = now;
      sendNow(walletId, (m) => bodyFor(event, m));
      return;
    }
    w.held += 1;
    w.heldEvent = event;
    if (!w.timer) {
      w.timer = setTimeout(() => flush(walletId), Math.max(0, w.lastSent + settings.windowMs - now));
      w.timer.unref();
    }
  } catch (error) {
    console.error(`[notify] ${error.code || "FAILED"}`);
  }
};

// The test button of the Profile page: one message to one person's own
// devices, in their language. Resolves to how many devices accepted it.
const sendTest = (userId) => push.toUser(userId, (locale) => payload(pick(locale).test, "bussola-test"));

// Tests only: forget every window and any pending summary.
const reset = () => {
  for (const w of windows.values()) if (w.timer) clearTimeout(w.timer);
  windows.clear();
};

module.exports = { notify, sendTest, configure, reset, enabled, MESSAGES };
