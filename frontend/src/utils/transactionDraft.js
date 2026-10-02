// ---------------------------------------------------------------------------
// A new transaction's starting values, from a link or an inbox item
// ---------------------------------------------------------------------------
// /transactions/new?amount=12.40&description=Coffee&date=2026-09-29&type=expense&from=3&to=12
//
// is a link an iPhone Shortcut ("Open URL") or anything else can open to land
// on the transaction form already filled in. Every parameter is optional and
// every one is checked here: a value that does not parse is dropped, not
// guessed at. The ids are only numbers at this point -- the form keeps them
// only if they are among its accounts and categories of the right kind.

const TYPES = { expense: 1, income: 2, transfer: 3 };

const pad = (n) => String(n).padStart(2, "0");

// "12.40", "12,40" -> 12.4; positive, at most two decimals.
export const draftAmount = (value) => {
  if (value == null) return null;
  const s = String(value).trim().replace(",", ".");
  if (!/^\d{1,12}(?:\.\d{1,2})?$/.test(s)) return null;
  const n = Number(s);
  return n > 0 ? n : null;
};

// YYYYMMDD or YYYY-MM-DD -> YYYYMMDD, if the day exists.
export const draftDay = (value) => {
  if (value == null) return null;
  const m = String(value).trim().match(/^(\d{4})-?(\d{2})-?(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) return null;
  return `${y}${pad(mo)}${pad(d)}`;
};

// "expense" | "income" | "transfer" (any case), or 1 | 2 | 3.
export const draftType = (value) => {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase();
  if (TYPES[s]) return TYPES[s];
  const n = Number(s);
  return [1, 2, 3].includes(n) ? n : null;
};

const draftId = (value) => {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
};

export const draftFromQuery = (search) => {
  const q = new URLSearchParams(search);
  const description = (q.get("description") || q.get("note") || "").trim().slice(0, 255);
  return {
    amount: draftAmount(q.get("amount")),
    tx_date: draftDay(q.get("date")),
    description: description || null,
    type_id: draftType(q.get("type")),
    from_id: draftId(q.get("from")),
    to_id: draftId(q.get("to")),
  };
};

// An inbox item, as GET /api/inbox answers it, as the form's draft.
export const draftFromInboxItem = (item) => ({
  amount: item.amount ?? null,
  tx_date: item.tx_date ?? null,
  description: item.merchant ?? null,
  type_id: item.type_id ?? null,
  from_id: item.from_id ?? null,
  to_id: item.to_id ?? null,
});

// What an inbox item still lacks before it could be recorded without the
// form: the fields POST /inbox/:id/accept needs, as suffixes of the
// `inbox.missing*` keys. A model still reading the notification (or one that
// failed) leaves them all empty, so those items come out incomplete too.
export const missingInboxFields = (item) => {
  const missing = [];
  if (draftAmount(item.amount) == null) missing.push("Amount");
  if (![1, 2, 3].includes(item.type_id)) missing.push("Type");
  if (item.from_id == null) missing.push("From");
  if (item.to_id == null) missing.push("To");
  if (!draftDay(item.tx_date)) missing.push("Date");
  return missing;
};

// The item's currency when it is not the wallet's, else null. The amount is
// stored as a number in the wallet's unit, so 50 USD accepted as it stands
// would be recorded as 50 EUR: such an item must go through the form, where
// the amount can be converted by hand. An unknown wallet currency counts as
// different -- refusing a click is cheaper than a wrong amount.
export const inboxOtherCurrency = (item, walletCurrency) => {
  const c = item.currency ? String(item.currency).trim().toUpperCase() : "";
  if (!c) return null;
  return walletCurrency && c === String(walletCurrency).trim().toUpperCase() ? null : c;
};

// Whether one-click Accept may record the item as it stands: nothing missing
// and the amount in the wallet's currency.
export const canAcceptInboxItem = (item, walletCurrency) =>
  missingInboxFields(item).length === 0 && inboxOtherCurrency(item, walletCurrency) == null;

// The body the form would send for this item left unedited
// (TransactionForm.handleSubmit): the same keys, the description from the
// merchant, the day as YYYYMMDD.
export const acceptBodyFromInboxItem = (item) => ({
  from_id: item.from_id,
  to_id: item.to_id,
  amount: item.amount,
  type_id: item.type_id,
  description: item.merchant ?? "",
  tx_date: draftDay(item.tx_date),
});
