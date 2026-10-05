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
// instance has one, in the background: see readItem below. A reading that
// fails for a passing reason is tried again later (services/inbox/retry.js,
// claimDue below).
const db = require("../dbConn");
const DataError = require("../services/dataError");
const { aiEnabled, readNotification } = require("../services/inbox/extract");
const { similarPast } = require("../services/inbox/history");
const { createQueue } = require("../services/inbox/queue");
const { nextDelayMs, MAX_ATTEMPTS } = require("../services/inbox/retry");
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
const NOTIFICATION_ID_MAX = 100;

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

// The sender's own id for this notification (migration 007), from the JSON
// body's notification_id, ?notification_id= or the X-Bussola-Notification-Id header, in that order
// (a text/plain body can only use the last two). Trimmed, 1 to 100 characters;
// anything else is refused rather than ignored, since a sender that meant to
// name its notification and did not would get the duplicates it was avoiding.
// Absent: null, and the notification is simply stored.
const notificationIdOf = (req) => {
  const body = req.body || {};
  const query = req.query || {};
  const header = typeof req.get === "function" ? req.get("x-bussola-notification-id") : undefined;
  const value = body.notification_id !== undefined ? body.notification_id : query.notification_id !== undefined ? query.notification_id : header;
  if (value === undefined) return null;
  const s = typeof value === "string" ? value.trim() : null;
  if (!s || s.length > NOTIFICATION_ID_MAX) {
    throw invalid("INVALID_NOTIFICATION_ID", `notification_id must be text of 1 to ${NOTIFICATION_ID_MAX} characters`);
  }
  return s;
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
//
// A sender that names its notification (notification_id, see notificationIdOf) can send it
// again safely: an id this wallet has already seen answers 200 with the
// receipt of the item it became -- "duplicate": true -- and stores and queues
// nothing, whatever became of the item since (read, accepted, dismissed; the
// id outlives the text). Whatever the second body says, it is the same
// notification. Two copies racing each other are settled by the unique index
// (wallet_id, notification_id): the INSERT ... ON CONFLICT DO NOTHING of the second
// waits for the first to commit, inserts nothing, and the item is looked up.
// RLS keeps the lookup in this wallet, and the index is per wallet, so another
// wallet's id is neither seen nor in the way.
exports.createItem = async (req, res) => {
  const body = req.body || {};
  const source = cleanText(body.source, SOURCE_MAX) || "api";
  const notificationId = notificationIdOf(req);

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
  const received = { text, draft: Boolean(draft) };
  if (notificationId) {
    // Already here: looked up before anything else is checked, so that a
    // retry is answered the same way even if the instance changed since (its
    // model switched off, an account in the draft deleted).
    const seen = await byNotificationId(notificationId);
    if (seen) {
      res.status(200);
      return duplicateReceipt(seen, received);
    }
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
        type_confidence, category_confidence, account_confidence, extraction, notification_id)
     values ($1, $2, $3, coalesce($4::timestamp, localtimestamp(0)), $5, $6, $7, $8, $9, $10, $11, $12, $13)
     on conflict (wallet_id, notification_id) where notification_id is not null do nothing
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
      notificationId,
    ],
  );
  if (!rows.length) {
    // The same notification_id, committed by a request that raced this one.
    const seen = await byNotificationId(notificationId);
    if (!seen) throw new DataError(409, "REQUEST_CONFLICT", "The request conflicted with another one: send it again");
    res.status(200);
    return duplicateReceipt(seen, received);
  }
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
  return receipt({ id, source, ...received });
};

// The item a notification_id became, in this wallet (RLS), whatever its state.
const byNotificationId = async (notificationId) => {
  const { rows } = await db.query(
    `select id, source, status, extraction, attempts from inbox_items where notification_id = $1`,
    [notificationId],
  );
  return rows[0] || null;
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

// What a second POST with a notification_id already seen answers: the receipt's
// shape, about the item the first one became and as it is now, plus
// "duplicate": true. `received` is what this request carried; nothing of it
// was stored. `reading` may now also be "retrying", "done" or "failed".
const READING_NOW = { done: "done", failed: "failed", off: "not_needed" };
const duplicateReceipt = (item, { text, draft }) => {
  const reading =
    item.extraction === "pending"
      ? item.attempts > 0
        ? "retrying"
        : "queued"
      : READING_NOW[item.extraction] || "not_needed";
  return {
    id: item.id,
    status: item.status,
    received: { kind: draft ? "draft" : "text", chars: text ? text.length : 0 },
    reading,
    source: item.source,
    duplicate: true,
    message:
      `Already received from ${item.source} (item ${item.id}, now ${item.status}): ` +
      "this copy has the same notification_id, so nothing new was stored",
  };
};

// ---------------------------------------------------------------------------
// The reader: one notification at a time, in the background
// ---------------------------------------------------------------------------
// Three steps, so that no database transaction stays open while the model
// thinks: read the item and the wallet's names inside RLS, as the person whose
// token sent it; ask the model with nothing open; write the answer inside RLS
// again, where every id is checked once more (checkEnds). An item accepted or
// dismissed in the meantime is left alone: the UPDATE only touches pending ones.
//
// A failure waiting can mend (a quota, a server error, a timeout, the endpoint
// down: extract.isTransient) keeps the item pending, one attempt more, and
// sets when it may be tried again (retry.js); the scheduler (claimDue) brings
// it back then. Nobody is told about those: only the last failure, or one
// waiting cannot mend, leaves the item 'failed' and says so, as before.
const readItem = async ({ id, walletId, userId }) => {
  const tenant = { userId, walletId };
  const context = await db.withTenant(tenant, async () => {
    const { rows } = await db.query(
      `select raw_text, source, attempts, to_char(localtimestamp, 'YYYY-MM-DD') as today
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
      attempts: Number(rows[0].attempts) || 0,
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
      const failures = context.attempts + 1;
      const delay = result.transient ? nextDelayMs(failures, result.retryAfterMs) : null;
      if (delay != null) {
        const later = await db.query(
          `update inbox_items
              set attempts = attempts + 1, next_attempt_at = now() + $2::int * interval '1 millisecond'
            where id = $1 and status = 'pending' and extraction = 'pending'`,
          [id, delay],
        );
        if (later.rowCount) {
          console.log(`[ai] inbox item ${id}: attempt ${failures} of ${MAX_ATTEMPTS} failed, next in ${Math.round(delay / 1000)} s`);
        }
        return null;
      }
      const failed = await db.query(
        `update inbox_items
            set extraction = 'failed', extracted_at = now(), attempts = attempts + 1, next_attempt_at = null
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
            set extraction = 'done', extracted_at = now(), next_attempt_at = null,
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
          set extraction = 'done', extracted_at = now(), next_attempt_at = null,
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

// Finding the readings to do, across wallets
//
// Items are data under RLS, so they are looked for wallet by wallet, each
// visited as one of the members who may write there; an item is read as its
// own sender when they still may.
//
// A reading is *claimed* before it is queued: one UPDATE ... RETURNING over
// the due rows, FOR UPDATE SKIP LOCKED, moves their next_attempt_at a lease
// ahead. Two API replicas looking at once take disjoint rows -- a row the other
// has locked is skipped, a row it has claimed is no longer due -- and the
// lease is what brings an item back if the process that claimed it dies
// before writing its reading. readItem then overwrites next_attempt_at with
// whatever comes next (nothing, or the backoff). The lease outlasts a reading
// (two minutes at most, extract.js CHAT_TIMEOUT_MS) with room for a queue.
//
// `fresh` also takes the items nobody scheduled -- next_attempt_at NULL, just
// received, whose receiver queued them in memory -- which only the startup
// does: a restart lost that memory.
const LEASE_MS = 10 * 60 * 1000;

const claimDue = async ({ fresh = false } = {}) => {
  let queued = 0;
  for (const wallet of await writersByWallet()) {
    const actor = wallet.writers[0];
    try {
      const items = await db.withTenant({ userId: actor, walletId: wallet.id, write: true }, async () => {
        const { rows } = await db.query(
          `update inbox_items
              set next_attempt_at = now() + $1::int * interval '1 millisecond'
            where id in (select id from inbox_items
                          where extraction = 'pending' and status = 'pending'
                            and (next_attempt_at <= now()${fresh ? " or next_attempt_at is null" : ""})
                          order by id
                          for update skip locked)
            returning id, created_by`,
          [LEASE_MS],
        );
        return rows;
      });
      for (const item of [...items].sort((a, b) => a.id - b.id)) {
        const userId = wallet.writers.includes(item.created_by) ? item.created_by : actor;
        queue.push({ id: item.id, walletId: wallet.id, userId });
        queued += 1;
      }
    } catch (error) {
      console.error(`[ai] could not look for pending items in wallet ${wallet.id}: ${error.message}`);
    }
  }
  return queued;
};
exports._claimDue = claimDue;
exports._queue = () => queue;

// At startup: items still waiting for the model from before a restart, and
// any whose retry has come due meanwhile (a scheduled one not yet due waits
// for its time). With no model configured any more they are marked off
// instead, so the interface does not say "Reading..." for ever.
exports.resumePending = async () => {
  if (!aiEnabled()) {
    for (const wallet of await writersByWallet()) {
      try {
        await db.withTenant({ userId: wallet.writers[0], walletId: wallet.id, write: true }, async () => {
          // Text that was waiting for a model that is gone: dropped, like any
          // text sent with no model, and with nothing of it kept.
          await db.query(
            `update inbox_items
                set extraction = 'off', next_attempt_at = null,
                    status = 'dismissed', resolved_at = now(), raw_text = null
              where extraction = 'pending' and status = 'pending'`,
          );
        });
      } catch (error) {
        console.error(`[ai] could not look for pending items in wallet ${wallet.id}: ${error.message}`);
      }
    }
    return 0;
  }
  const queued = await claimDue({ fresh: true });
  if (queued) console.log(`[ai] ${queued} notification(s) queued for reading`);
  return queued;
};

// The retries: every half minute, the readings whose time has come are
// claimed and queued. In process, like the queue; a run still going when the
// next is due is not doubled. Off with no model.
const SCHEDULE_MS = 30 * 1000;
let scheduler = null;
exports.startRetryScheduler = (everyMs = SCHEDULE_MS) => {
  if (scheduler || !aiEnabled()) return;
  let busy = false;
  scheduler = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const queued = await claimDue();
      if (queued) console.log(`[ai] ${queued} notification(s) queued to be read again`);
    } catch (error) {
      console.error(`[ai] could not look for readings to retry: ${error.message}`);
    } finally {
      busy = false;
    }
  }, everyMs);
  scheduler.unref();
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
  i.currency,
  i.attempts,
  case when i.extraction = 'pending' and i.attempts > 0 then i.next_attempt_at end as next_attempt_at`;

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
