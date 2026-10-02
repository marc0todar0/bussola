// ---------------------------------------------------------------------------
// The inbox: drafts waiting for a person
// ---------------------------------------------------------------------------
// A bank notification arrives from a phone (POST /api/inbox, with a personal
// token -- auth/tokens.js) and becomes a pending item: what it said, and what
// Bussola proposes to make of it. Nothing becomes a transaction here. The
// person opens the item in the interface, corrects whatever needs correcting
// in the ordinary transaction form, and accepts it (POST /api/inbox/:id/
// accept), which creates the transaction through the same code as POST
// /api/transactions -- or dismisses it.
//
// Everything below runs inside withTenant (withToken or withWallet*): RLS
// keeps each wallet's items, accounts and history to itself. An id a draft
// names is looked up under that same RLS, so an account of another wallet is
// simply not found, and dropped.
//
// A notification can say more than a transaction does (the last digits of a
// card, a balance), so its text is kept only while the item is pending and
// cleared the moment it is resolved.
//
// The text is read by a language model (services/inbox/extract.js) when the
// instance has one, in the background: see readItem below.
const db = require("../dbConn");
const DataError = require("../services/dataError");
const { aiEnabled, readNotification } = require("../services/inbox/extract");
const { similarPast } = require("../services/inbox/history");
const { createQueue } = require("../services/inbox/queue");
const { readerContext } = require("../auth/bankNames");
const notifier = require("../services/notify");
const { writersByWallet } = require("../auth/wallets");
const transactions = require("./transactions_controller");

const EXPENSE = 1;
const INCOME = 2;
const TRANSFER = 3;
const TYPE_BY_CODE = { EXPENSE, INCOME, TRANSFER };

const TEXT_MAX = 2000;
const SOURCE_MAX = 64;
const MERCHANT_MAX = 255;

// Tells the people who can confirm it, outside the browser, that an item is
// waiting (Web Push, services/notify.js). Called only after the item's
// transaction has committed, never for a dropped item, and never allowed to
// fail its caller. The details (amount, merchant) only travel if the
// administrator turned them on; the notification's text never does.
const announce = async (userId, walletId, kind, item = {}) => {
  if (!notifier.enabled()) return;
  try {
    const { currency } = await readerContext(userId, walletId);
    notifier.notify({
      walletId,
      kind,
      amount: item.amount,
      currency: item.currency || currency,
      merchant: item.merchant,
    });
  } catch (error) {
    console.error(`[notify] ${error.code || "FAILED"}`);
  }
};

const invalid = (code, message) => new DataError(400, code, message);

const cleanText = (value, max) => {
  if (value === undefined || value === null) return null;
  const s = String(value).replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
};

// A positive amount in the wallet's unit, with at most two decimals. A string
// is accepted as a JSON number would be ("12.40"), not as prose.
const draftAmount = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = typeof value === "number" ? value : /^\s*\d+(?:\.\d+)?\s*$/.test(String(value)) ? Number(value) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n >= 1e12 || Math.round(n * 100) !== n * 100) {
    throw invalid("INVALID_AMOUNT", "The amount must be a positive number with at most two decimals");
  }
  return n;
};

const pad = (n) => String(n).padStart(2, "0");

// YYYY-MM-DD, YYYYMMDD, or an ISO date and time (kept to the second, as the
// time of day the payment happened). Stored as a timestamp without zone, the
// way transactions keep theirs.
const draftDate = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const s = String(value).trim();
  const m = s.match(/^(\d{4})-?(\d{2})-?(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/);
  if (!m) throw invalid("INVALID_DATE", "The date must be written as YYYY-MM-DD");
  const [, y, mo, d, hh, mi, ss = "00", zone] = m;
  const day = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  if (day.getUTCFullYear() !== Number(y) || day.getUTCMonth() !== Number(mo) - 1 || day.getUTCDate() !== Number(d)) {
    throw invalid("INVALID_DATE", "The date must be written as YYYY-MM-DD");
  }
  if (hh === undefined) return `${y}-${mo}-${d} 00:00:00`;
  if (zone) {
    // A moment with a zone becomes the server's local wall time, as a
    // transaction typed in the form would be.
    const at = new Date(s);
    if (Number.isNaN(at.getTime())) throw invalid("INVALID_DATE", "The date must be written as YYYY-MM-DD");
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
  }
  return `${y}-${mo}-${d} ${hh}:${mi}:${ss}`;
};

const draftType = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const id = TYPE_BY_CODE[String(value).trim().toUpperCase()];
  if (!id) throw invalid("INVALID_TYPE", "The type must be EXPENSE, INCOME or TRANSFER");
  return id;
};

// An id the sender claims. Anything that is not a plausible id is dropped
// like an id that does not exist: the sender guessed, and a guess is not an
// error.
const draftId = (value) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : null;
};

const draftConfidence = (value) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= 1 ? Math.round(n * 100) / 100 : null;
};

// Keeps the two ends only if they exist in this wallet (RLS decides what
// "exists" means) and fit the movement: the source is always a bank account,
// the destination a category of the right kind or, for a transfer, another
// account. A destination that is a category and a type nobody gave: the
// category says which.
const checkEnds = async (item) => {
  const ids = [item.fromId, item.toId].filter((id) => id != null);
  if (!ids.length) return item;
  const { rows } = await db.query(
    `select id, type_id, is_account from accounts where id = any($1::int[]) and not archived`,
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const out = { ...item };

  const from = byId.get(out.fromId);
  if (!from || !from.is_account) {
    out.fromId = null;
    out.accountConfidence = null;
  }

  const to = byId.get(out.toId);
  if (to && out.typeId == null && !to.is_account) out.typeId = to.type_id === INCOME ? INCOME : EXPENSE;
  const fits =
    to &&
    (out.typeId === TRANSFER
      ? to.is_account && to.id !== out.fromId
      : out.typeId === EXPENSE
        ? !to.is_account && to.type_id === 1
        : out.typeId === INCOME
          ? !to.is_account && to.type_id === 2
          : false);
  if (!fits) {
    out.toId = null;
    out.categoryConfidence = null;
  }
  return out;
};

// ---------------------------------------------------------------------------
// POST /api/inbox -- with a token
// ---------------------------------------------------------------------------
// Body: { source, text } -- the notification, which the model reads
// (readItem, below) -- or { source, draft: { amount, date, description, type,
// from_id, to_id, confidence: { type, category, account } } } when the sender
// already did the reading. A draft is taken as it is, text or no text: the
// model is only asked when there is nothing but the text.
//
// With no model, a notification that is only text is refused (409
// AI_DISABLED) and nothing of it is kept: without a reader it could only be
// noise or a draft with nothing filled in, and an offer or a code must not
// become a draft. A sender that did the reading and sends a draft is taken as
// ever. A model that is on but cannot answer (down, a quota) is another
// matter: the item stays, for the hand.
//
// The answer is 201 at once. Reading takes seconds and a phone must not wait
// for it: the item is stored with extraction = 'pending' and the queue fills
// it in once this request's transaction is over.
exports.createItem = async (req, res) => {
  const body = req.body || {};
  const source = cleanText(body.source, SOURCE_MAX) || "api";

  if (body.text !== undefined && body.text !== null && typeof body.text !== "string") {
    throw invalid("INVALID_REQUEST", "text must be a string");
  }
  const text = typeof body.text === "string" && body.text.trim() ? body.text.trim() : null;
  if (text && text.length > TEXT_MAX) {
    throw invalid("INBOX_TEXT_TOO_LONG", `The text has ${text.length} characters; at most ${TEXT_MAX} are accepted`);
  }
  const draft = body.draft && typeof body.draft === "object" && !Array.isArray(body.draft) ? body.draft : null;
  if (!text && !draft) {
    throw invalid(
      "INBOX_EMPTY",
      "Nothing to read: send the notification's text as a text/plain body (or JSON with \"text\"), or a draft",
    );
  }
  if (!draft && !aiEnabled()) {
    throw new DataError(
      409,
      "AI_DISABLED",
      "Not kept: this Bussola has no reading model configured, so a notification with only text cannot be read. Send a draft, or ask the administrator to set BUSSOLA_AI_URL and BUSSOLA_AI_MODEL",
    );
  }

  // What the sender said, validated; its ids kept only if they exist in this
  // wallet and fit the movement.
  const item = draft
    ? await checkEnds({
        amount: draftAmount(draft.amount),
        date: draftDate(draft.date),
        merchant: cleanText(draft.description ?? draft.merchant, MERCHANT_MAX),
        typeId: draftType(draft.type),
        fromId: draft.from_id == null ? null : draftId(draft.from_id),
        toId: draft.to_id == null ? null : draftId(draft.to_id),
        typeConfidence: draftConfidence(draft.confidence && draft.confidence.type),
        categoryConfidence: draftConfidence(draft.confidence && draft.confidence.category),
        accountConfidence: draftConfidence(draft.confidence && draft.confidence.account),
      })
    : {};
  const extraction = draft ? "off" : "pending";

  // No day: the item takes the moment it arrived, since a notification comes
  // when the payment happens.
  const { rows } = await db.query(
    `insert into inbox_items
       (source, raw_text, amount, tx_date, merchant, type_id, from_id, to_id,
        type_confidence, category_confidence, account_confidence, extraction)
     values ($1, $2, $3, coalesce($4::timestamp, localtimestamp(0)), $5, $6, $7, $8, $9, $10, $11, $12)
     returning id`,
    [
      source,
      text,
      item.amount ?? null,
      item.date ?? null,
      item.merchant ?? null,
      item.typeId ?? null,
      item.fromId ?? null,
      item.toId ?? null,
      item.typeConfidence ?? null,
      item.categoryConfidence ?? null,
      item.accountConfidence ?? null,
      extraction,
    ],
  );
  const id = rows[0].id;

  // Queued once the answer has gone out, which withToken does only after its
  // transaction is over: the reader, in a transaction of its own, has to see
  // the row. A request that failed after all queues nothing.
  const job = { id, walletId: req.token.walletId, userId: req.token.userId };
  if (extraction === "pending") {
    res.once("finish", () => {
      if (res.statusCode === 201) queue.push(job);
    });
  } else {
    // A ready-made draft is already in the inbox: say so once it is committed.
    res.once("finish", () => {
      if (res.statusCode === 201) void announce(job.userId, job.walletId, "ready", item);
    });
  }

  res.status(201);
  return receipt({ id, source, text, draft: Boolean(draft) });
};

// What POST /api/inbox answers, readable on its own: an automation app on a
// phone shows little more than the status code and the body it saved, so the
// body says what was understood and what happens next. Only what the sender
// already knows, and never the text itself: its length is enough to tell a
// real notification from an empty or unreplaced one.
const receipt = ({ id, source, text, draft }) => {
  const chars = text ? text.length : 0;
  return {
    id,
    status: "pending",
    received: { kind: draft ? "draft" : "text", chars },
    reading: draft ? "not_needed" : "queued",
    source,
    message: draft
      ? `Received a draft from ${source} (item ${id}): it waits in the inbox to be confirmed`
      : `Received ${chars} characters from ${source} (item ${id}): reading them in the background. ` +
        "A movement will wait in the inbox to be confirmed; anything else is dropped",
  };
};
exports.receipt = receipt;

// ---------------------------------------------------------------------------
// The reader: one notification at a time, in the background
// ---------------------------------------------------------------------------
// Three steps, so that no database transaction stays open while the model
// thinks: read the item and the wallet's names inside RLS, as the person whose
// token sent it; ask the model with nothing open; write the answer inside RLS
// again, where every id is checked once more (checkEnds). An item accepted or
// dismissed in the meantime is left alone: the UPDATE only touches pending ones.
const readItem = async ({ id, walletId, userId }) => {
  const tenant = { userId, walletId };
  const context = await db.withTenant(tenant, async () => {
    const { rows } = await db.query(
      `select raw_text, source, to_char(localtimestamp, 'YYYY-MM-DD') as today
         from inbox_items
        where id = $1 and status = 'pending' and extraction = 'pending' and raw_text is not null`,
      [id],
    );
    if (!rows.length) return null;
    const names = async (where) =>
      (await db.query(`select id, name from accounts where ${where} and not archived order by lower(name), id`)).rows;
    return {
      text: rows[0].raw_text,
      source: rows[0].source,
      today: rows[0].today,
      accounts: await names("is_account"),
      expenseCategories: await names("not is_account and type_id = 1"),
      incomeCategories: await names("not is_account and type_id = 2"),
      history: await similarPast(rows[0].raw_text),
    };
  });
  if (!context) return;
  Object.assign(context, await readerContext(userId, walletId));

  let result;
  try {
    result = await readNotification(context, { label: `inbox item ${id}` });
  } catch (error) {
    result = { ok: false, reason: error.code || "AI_FAILED" };
  }

  // What became of the item once the reading was written: "ready" (a draft
  // to confirm), "unread" (left for manual entry) or nothing (dropped as not a
  // movement, or resolved by someone while the model thought).
  const outcome = await db.withTenant({ ...tenant, write: true }, async () => {
    if (!result.ok) {
      const failed = await db.query(
        `update inbox_items set extraction = 'failed', extracted_at = now()
          where id = $1 and status = 'pending' and extraction = 'pending'`,
        [id],
      );
      return failed.rowCount ? { kind: "unread" } : null;
    }
    if (result.skip) {
      // Not a movement (an offer, a tip, a summary): resolved on the spot, as
      // if dismissed, so no text is kept and nothing is shown. The UPDATE only
      // touches an item that is still waiting for this reading.
      await db.query(
        `update inbox_items
            set extraction = 'done', extracted_at = now(),
                status = 'dismissed', resolved_at = now(), raw_text = null
          where id = $1 and status = 'pending' and extraction = 'pending'`,
        [id],
      );
      return null;
    }
    const d = await checkEnds({ ...result.draft });
    // The day it arrived keeps the time it arrived; another day starts at
    // midnight, as a day typed in the form does.
    const done = await db.query(
      `update inbox_items
          set extraction = 'done', extracted_at = now(),
              amount = $2, currency = $3,
              tx_date = case when $4::date is null or $4::date = tx_date::date then tx_date
                             else $4::date::timestamp end,
              merchant = $5, type_id = $6, from_id = $7, to_id = $8,
              type_confidence = null, category_confidence = null, account_confidence = null
        where id = $1 and status = 'pending' and extraction = 'pending'`,
      [id, d.amount, d.currency, d.date, d.merchant, d.typeId, d.fromId, d.toId],
    );
    return done.rowCount ? { kind: "ready", amount: d.amount, currency: d.currency, merchant: d.merchant } : null;
  });
  // After the commit, with nothing open.
  if (outcome) await announce(userId, walletId, outcome.kind, outcome);
};

// Exposed for api/test/notify.js, which runs one reading without a database.
exports._readItem = readItem;

const queue = createQueue(async (job) => {
  try {
    await readItem(job);
  } catch (error) {
    // The database's trouble, not the model's: logged without the text, and
    // the item stays pending until the next start queues it again.
    console.error(`[ai] inbox item ${job.id}: ${error.message}`);
  }
});

// At startup: items still waiting for the model from before a restart. With
// no model configured any more they are marked off instead, so the interface
// does not say "Reading..." for ever. Each wallet is visited as one of the
// members who may write there; an item is read as its own sender when they
// still may.
exports.resumePending = async () => {
  const enabled = aiEnabled();
  let queued = 0;
  for (const wallet of await writersByWallet()) {
    const actor = wallet.writers[0];
    try {
      const items = await db.withTenant({ userId: actor, walletId: wallet.id, write: !enabled }, async () => {
        if (!enabled) {
          // Text that was waiting for a model that is gone: dropped, like any
          // text sent with no model, and with nothing of it kept.
          await db.query(
            `update inbox_items
                set extraction = 'off', status = 'dismissed', resolved_at = now(), raw_text = null
              where extraction = 'pending' and status = 'pending'`,
          );
          return [];
        }
        const { rows } = await db.query(
          `select id, created_by from inbox_items
            where extraction = 'pending' and status = 'pending'
            order by id`,
        );
        return rows;
      });
      for (const item of items) {
        const userId = wallet.writers.includes(item.created_by) ? item.created_by : actor;
        queue.push({ id: item.id, walletId: wallet.id, userId });
        queued += 1;
      }
    } catch (error) {
      console.error(`[ai] could not look for pending items in wallet ${wallet.id}: ${error.message}`);
    }
  }
  if (queued) console.log(`[ai] ${queued} notification(s) queued for reading`);
  return queued;
};

// ---------------------------------------------------------------------------
// GET /api/inbox/context -- with a token
// ---------------------------------------------------------------------------
// What an app on the phone needs to make its own proposals before it sends
// one (a model that runs on the device): the wallet's currency, its accounts
// and categories by name, and which category each merchant usually went to.
// Nothing else -- no balances, no amounts, no dates.
exports.getContext = async (req) => {
  const pickNames = async (where) =>
    (
      await db.query(
        `select id, name from accounts where ${where} and not archived order by lower(name), id`,
      )
    ).rows;

  const { rows: merchants } = await db.query(
    `select min(btrim(t.description)) as merchant, tt.code as type, t.to_id as category_id, count(*)::int as count
       from transactions t
       join transaction_types tt on (tt.id = t.type_id)
       join accounts c on (c.id = t.to_id and c.wallet_id = t.wallet_id and not c.archived)
      where t.type_id in (1, 2)
        and nullif(btrim(t.description), '') is not null
      group by lower(btrim(t.description)), tt.code, t.to_id
      order by max(t.tx_date) desc, count(*) desc
      limit 200`,
  );

  return {
    currency: req.token.walletCurrency,
    accounts: await pickNames("is_account and type_id = 3"),
    expenseCategories: await pickNames("not is_account and type_id = 1"),
    incomeCategories: await pickNames("not is_account and type_id = 2"),
    merchants,
  };
};

// ---------------------------------------------------------------------------
// The interface's side -- with the session
// ---------------------------------------------------------------------------
const ITEM_COLUMNS = `
  i.id,
  i.source,
  i.received_at,
  i.raw_text,
  (i.raw_text is not null) as has_text,
  i.amount,
  to_char(i.tx_date, 'YYYYMMDD') as tx_date,
  i.merchant,
  i.type_id,
  tt.code as type_code,
  i.from_id,
  fa.name as from_name,
  i.to_id,
  ta.name as to_name,
  i.type_confidence,
  i.category_confidence,
  i.account_confidence,
  i.extraction,
  i.currency`;

const shape = ({ type_confidence, category_confidence, account_confidence, ...row }) => ({
  ...row,
  confidence: { type: type_confidence, category: category_confidence, account: account_confidence },
});

// The pending items, newest first, with the names of what they propose.
exports.getPending = async () => {
  const { rows } = await db.query(
    `select ${ITEM_COLUMNS}
       from inbox_items i
       left join transaction_types tt on (tt.id = i.type_id)
       left join accounts fa on (fa.id = i.from_id and fa.wallet_id = i.wallet_id)
       left join accounts ta on (ta.id = i.to_id and ta.wallet_id = i.wallet_id)
      where i.status = 'pending'
      order by i.received_at desc, i.id desc
      limit 200`,
  );
  return rows.map(shape);
};

const itemId = (value) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw notFound();
  return n;
};

const notFound = () => new DataError(404, "INBOX_NOT_FOUND", "This item is not in the inbox");
const resolved = () => new DataError(409, "INBOX_RESOLVED", "This item was already accepted or dismissed");

// Resolving is one UPDATE that only a pending row passes, so two people (or
// two clicks) resolving the same item cannot both succeed: the second waits
// for the first's row lock, finds the item no longer pending and gets 409.
// It answers the row's has_text -- whether any text is left on it: never,
// since the same statement clears it; the answer is there so a test can see
// it happen -- and the currency the reading found, for accept().
const resolve = async (id, status) => {
  const { rows } = await db.query(
    `update inbox_items
        set status = $2, raw_text = null, resolved_at = now()
      where id = $1 and status = 'pending'
      returning (raw_text is not null) as has_text, currency`,
    [id, status],
  );
  if (rows.length) return rows[0];
  const { rows: seen } = await db.query(`select 1 from inbox_items where id = $1`, [id]);
  throw seen.length ? resolved() : notFound();
};

exports.dismiss = async (req) => {
  const id = itemId(req.params.id);
  const { has_text: hasText } = await resolve(id, "dismissed");
  return { id, status: "dismissed", has_text: hasText };
};

// The body is a whole transaction, the one the person confirmed in the form,
// in the shape POST /api/transactions takes. It is created by the same
// function, balances included; the item is marked first, so a second accept
// racing this one stops at the 409 before anything is created. One database
// transaction: if the insert fails, the item is still pending.
//
// An item whose currency was read as something other than the wallet's is
// refused (409 INBOX_CURRENCY_MISMATCH): the body's amount would be stored in
// the wallet's unit, so 50 USD would become 50 EUR. Nothing converts it; the
// person enters it by hand, in the wallet's currency, and dismisses the item.
// The refusal is thrown inside the transaction, which rolls back, so the item
// stays pending. An item with no currency is taken to be in the wallet's.
const currencyMismatch = (itemCurrency, walletCurrency) => {
  const item = String(itemCurrency || "").trim().toUpperCase();
  const wallet = String(walletCurrency || "").trim().toUpperCase();
  return Boolean(item && wallet && item !== wallet);
};
exports.currencyMismatch = currencyMismatch;

exports.accept = async (req) => {
  const id = itemId(req.params.id);
  const { has_text: hasText, currency } = await resolve(id, "accepted");
  const walletCurrency = req.user && req.user.wallet ? req.user.wallet.currency : null;
  if (currencyMismatch(currency, walletCurrency)) {
    throw new DataError(
      409,
      "INBOX_CURRENCY_MISMATCH",
      "This notification is in another currency than the wallet's: enter it by hand",
      { currency: String(currency).trim().toUpperCase(), walletCurrency: String(walletCurrency).trim().toUpperCase() },
    );
  }
  const transactionId = await transactions.insertTransaction(req.body || {});
  await db.query(`update inbox_items set transaction_id = $2 where id = $1`, [id, transactionId]);
  return { id, status: "accepted", transaction_id: transactionId, has_text: hasText };
};
