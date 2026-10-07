// ---------------------------------------------------------------------------
// The demo's inbox -- api/controllers/inbox_controller.js, session half
// ---------------------------------------------------------------------------
// In the real application a phone posts bank notifications with a personal
// token and they wait here as drafts. The demo has no phone and no tokens
// (the token endpoints answer 401, creating one 403 DEMO_DISABLED), so it
// starts with two invented notifications already waiting: a supermarket
// payment and a salary. Reviewing one opens the transaction form prefilled;
// accepting it creates the transaction through the demo ledger's own create,
// balances and all, exactly as the API does through POST /api/transactions.
//
// scripts/demo-check.mjs posts the same two drafts to a real API (through a
// token) and compares the answers.
import { DemoError, byId, dashed, ymd } from "./state.js";
import * as ledger from "./ledger.js";

const TYPE_CODES = { 1: "EXPENSE", 2: "INCOME", 3: "TRANSFER" };
const TYPE_IDS = { EXPENSE: 1, INCOME: 2, TRANSFER: 3 };

// Names, not ids: the fixture's ids are whatever the instance that generated
// it handed out.
const DEMO_ITEMS = [
  {
    source: "iPhone",
    text: "Pagamento di 42,80 € con carta *1234 presso SUPERMERCATO CENTRALE",
    daysAgo: 0,
    minutesAgo: 12,
    amount: 42.8,
    description: "Supermercato Centrale",
    type: "EXPENSE",
    from: "Cartesio Bank",
    to: "Groceries",
    confidence: { type: 0.95, category: 0.82, account: 0.9 },
  },
  {
    source: "Android",
    text: "Accredito stipendio da ACME S.p.A. di 1.850,00 EUR",
    daysAgo: 1,
    minutesAgo: 60 * 20,
    amount: 1850,
    description: "Salary",
    type: "INCOME",
    from: "Cartesio Bank",
    to: "Salary",
    confidence: { type: 1, category: 1, account: 1 },
  },
];

const idByName = (db, name, isAccount) =>
  db.accounts.find((a) => a.name === name && a.is_account === isAccount && !a.archived)?.id ?? null;

// The two drafts as POST /api/inbox takes them ({ source, text, draft }),
// oldest first, with the fixture's ids and days relative to the demo's today.
export const demoInboxDrafts = (db) =>
  [...DEMO_ITEMS].reverse().map((item) => {
    const day = new Date(db.today);
    day.setDate(day.getDate() - item.daysAgo);
    return {
      source: item.source,
      text: item.text,
      draft: {
        amount: item.amount,
        date: dashed(ymd(day)),
        description: item.description,
        type: item.type,
        from_id: idByName(db, item.from, true),
        to_id: idByName(db, item.to, false),
        confidence: item.confidence,
      },
    };
  });

// The pending items the demo opens with, stored the way the table stores them.
export const seedInbox = (db, now = new Date()) => {
  const drafts = demoInboxDrafts(db);
  db.inbox = drafts.map(({ source, text, draft }, index) => {
    const spec = DEMO_ITEMS[DEMO_ITEMS.length - 1 - index];
    return {
      id: index + 1,
      source,
      received_at: new Date(now.getTime() - spec.minutesAgo * 60000).toISOString(),
      raw_text: text,
      amount: draft.amount,
      tx_date: draft.date.replace(/-/g, ""),
      merchant: draft.description,
      type_id: TYPE_IDS[draft.type],
      from_id: draft.from_id,
      to_id: draft.to_id,
      confidence: { ...draft.confidence },
      // Drafts, not text for a model to read: the API marks them off too.
      extraction: "off",
      currency: null,
      status: "pending",
      transaction_id: null,
      resolved_at: null,
    };
  });
};

const nameOf = (db, id) => (id == null ? null : (byId(db.accounts, id)?.name ?? null));

export const getPending = (db) =>
  (db.inbox || [])
    .filter((i) => i.status === "pending")
    .sort((a, b) => (a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : b.id - a.id))
    .map((i) => ({
      id: i.id,
      source: i.source,
      received_at: i.received_at,
      raw_text: i.raw_text,
      has_text: i.raw_text != null,
      amount: i.amount,
      tx_date: i.tx_date,
      merchant: i.merchant,
      type_id: i.type_id,
      type_code: TYPE_CODES[i.type_id] ?? null,
      from_id: i.from_id,
      from_name: nameOf(db, i.from_id),
      to_id: i.to_id,
      to_name: nameOf(db, i.to_id),
      confidence: { ...i.confidence },
      extraction: i.extraction ?? "off",
      currency: i.currency ?? null,
      // The demo has no reading model: nothing is ever retried.
      attempts: 0,
      next_attempt_at: null,
    }));

const notFound = () => new DemoError(404, "INBOX_NOT_FOUND", "This item is not in the inbox");
const resolved = () => new DemoError(409, "INBOX_RESOLVED", "This item was already accepted or dismissed");

const pendingItem = (db, rawId) => {
  const id = Number(rawId);
  if (!Number.isInteger(id) || id <= 0 || id > 2147483647) throw notFound();
  const item = (db.inbox || []).find((i) => i.id === id);
  if (!item) throw notFound();
  if (item.status !== "pending") throw resolved();
  return item;
};

const settle = (item, status) => {
  item.status = status;
  item.raw_text = null;
  item.resolved_at = new Date().toISOString();
};

export const dismiss = (db, rawId) => {
  const item = pendingItem(db, rawId);
  settle(item, "dismissed");
  return { id: item.id, status: "dismissed", has_text: false };
};

// The ledger's create validates before it changes anything, so a refused
// body leaves the item pending -- as the API's rolled-back transaction does.
// An item read in another currency than the wallet's is refused, as by the
// API (inbox_controller.accept): its amount would be recorded in the wallet's.
export const accept = (db, rawId, body) => {
  const item = pendingItem(db, rawId);
  const itemCurrency = String(item.currency || "").trim().toUpperCase();
  const walletCurrency = String(db.wallet.currency || "").trim().toUpperCase();
  if (itemCurrency && walletCurrency && itemCurrency !== walletCurrency) {
    throw new DemoError(
      409,
      "INBOX_CURRENCY_MISMATCH",
      "This notification is in another currency than the wallet's: enter it by hand",
      { currency: itemCurrency, walletCurrency },
    );
  }
  const { actualReset } = ledger.createTransaction(db, body || {}, db.user);
  settle(item, "accepted");
  item.transaction_id = db.sequences.transactions;
  return { id: item.id, status: "accepted", transaction_id: item.transaction_id, has_text: false, actualReset };
};
