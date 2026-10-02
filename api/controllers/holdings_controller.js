const db = require("../dbConn");
const quoteProvider = require("../services/quotes");
const DataError = require("../services/dataError");

// Recomputes the account's actual balance as the sum of its holdings' values.
const recomputeActualBalanceQuery = (accountId) => ({
  text: `update accounts
         set actual_amount = (
           select coalesce(sum(amount), 0)
           from holdings
           where account_id = $1
         )
         where id = $1`,
  params: [accountId],
});

// amount = quantity x price when both are present (automatic), otherwise the
// value passed in by hand (manual override).
const computeAmount = ({ amount, quantity, current_price }) => {
  const q = Number(quantity);
  const p = Number(current_price);
  const hasQ = quantity != null && quantity !== "" && !Number.isNaN(q);
  const hasP = current_price != null && current_price !== "" && !Number.isNaN(p);
  if (hasQ && hasP) return q * p;
  return Number(amount) || 0;
};

const numOrNull = (v) => (v == null || v === "" || Number.isNaN(Number(v)) ? null : Number(v));
const strOrNull = (v) => (v == null || v === "" ? null : v);
const dateOrNull = (v) => (v == null || v === "" ? null : v);

exports.getPillars = async () => {
  const { rows } = await db.query(`select id, code, name, color from pillars order by id`);
  return rows;
};

// The seeded taxonomy (wallet_id null, shared by every wallet) plus the types
// this wallet invented: RLS shows both and nothing else.
// `custom` tells the form which ones may be removed.
exports.getHoldingTypes = async () => {
  const { rows } = await db.query(
    `select id, code, name, color, wallet_id is not null as custom
       from holding_types
      order by name`,
  );
  return rows;
};

exports.createHoldingType = async (body = {}) => {
  const { name, color } = body;
  if (!name || !String(name).trim()) {
    throw new DataError(400, "INVALID_REQUEST", "The holding type needs a name");
  }
  // No code: codes belong to the seeded taxonomy. A type the user invents is
  // displayed by its name, exactly as typed, and belongs to the wallet in
  // context -- the column's default fills wallet_id in, and the insert policy
  // refuses any other. A name the wallet can already see is reused rather
  // than added twice.
  await db.query(
    `insert into holding_types (id, name, color)
     select nextval('seq_holding_types'), $1::text, $2::text
      where not exists (select 1 from holding_types where lower(trim(name)) = lower($1::text))`,
    [String(name).trim(), strOrNull(color)],
  );
  return exports.getHoldingTypes();
};

// Only a type this wallet invented: RLS filters out the seeded ones and
// every other wallet's, so their ids delete nothing and answer 404. The
// holdings that used it are left without a type (ON DELETE SET NULL); their
// amounts do not depend on it.
exports.deleteHoldingType = async (id) => {
  const typeId = Number(id);
  const { rowCount } = Number.isInteger(typeId)
    ? await db.query(`delete from holding_types where id = $1`, [typeId])
    : { rowCount: 0 };
  if (!rowCount) throw new DataError(404, "HOLDING_TYPE_NOT_FOUND", "Holding type not found");
  return exports.getHoldingTypes();
};

// Distinct values feeding the form's datalists (the field is whitelisted).
// The suggestions are only your own: without RLS this query would show the
// issuers and countries of every user on the instance.
exports.getDistinctValues = async (field) => {
  const COLUMNS = { issuer: "issuer", country: "country" };
  const col = COLUMNS[field];
  if (!col) throw new DataError(400, "INVALID_REQUEST", "Invalid field");

  const { rows } = await db.query(
    `select distinct ${col} as value
     from holdings
     where ${col} is not null and ${col} <> ''
     order by value`,
  );
  return rows.map((r) => r.value);
};

exports.getHoldings = async (accountId) => {
  const { rows } = await db.query(
    `select
       h.id,
       h.account_id,
       h.name,
       h.pillar_id,
       h.amount,
       h.description,
       h.type_id,
       h.issuer,
       h.country,
       h.currency,
       h.isin,
       h.quantity,
       h.purchase_price,
       to_char(h.purchase_date, 'YYYY-MM-DD') as purchase_date,
       h.current_price,
       case
         when h.purchase_price is not null and h.purchase_price <> 0
              and h.current_price is not null
         then (h.current_price - h.purchase_price) / h.purchase_price * 100
       end as total_return,
       case
         when h.purchase_price is not null and h.purchase_price <> 0
              and h.current_price is not null
              and h.purchase_date is not null
              and (CURRENT_DATE - h.purchase_date) > 0
         then (power(
                 (h.current_price / h.purchase_price)::double precision,
                 (365.0 / (CURRENT_DATE - h.purchase_date))::double precision
               ) - 1) * 100
       end as annualised_return,
       h.price_updated_at,
       h.auto_update,
       p.code  as pillar_code,
       p.name  as pillar_name,
       p.color as pillar_color,
       t.code  as type_code,
       t.name  as type_name,
       t.color as type_color
     from holdings h
     join pillars p on (h.pillar_id = p.id)
     left join holding_types t on (h.type_id = t.id)
     where h.account_id = $1
     order by h.amount desc`,
    [accountId],
  );
  return rows;
};

// The insert and the update take the same fields in the same order, so the
// parameter list is built once.
const holdingParams = (body) => {
  const {
    name,
    pillar_id,
    amount,
    description,
    type_id,
    issuer,
    country,
    currency,
    isin,
    quantity,
    purchase_price,
    purchase_date,
    current_price,
    auto_update,
  } = body;

  return [
    name,
    pillar_id || 1,
    computeAmount({ amount, quantity, current_price }),
    strOrNull(description),
    numOrNull(type_id),
    strOrNull(issuer),
    strOrNull(country),
    strOrNull(currency),
    strOrNull(isin),
    numOrNull(quantity),
    numOrNull(purchase_price),
    dateOrNull(purchase_date),
    numOrNull(current_price),
    auto_update === false ? false : true,
  ];
};

exports.createHolding = async (accountId, body) => {
  // Holdings belong to bank accounts only; a category id, or one RLS hides,
  // is a 404 rather than a holding hanging off a category.
  const { rows } = await db.query(`select id from accounts where id = $1 and is_account`, [accountId]);
  if (rows.length === 0) throw new DataError(404, "ACCOUNT_NOT_FOUND", "No such account");

  await db.queryTransaction([
    {
      text: `insert into holdings
               (id, account_id, name, pillar_id, amount, description,
                type_id, issuer, country, currency, isin,
                quantity, purchase_price, purchase_date, current_price, auto_update)
             values (nextval('seq_holdings'), $1, $2, $3, $4, $5,
                     $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      params: [accountId, ...holdingParams(body)],
    },
    recomputeActualBalanceQuery(accountId),
  ]);
  return exports.getHoldings(accountId);
};

// Every write to a holding has to find which account it belongs to first, so
// the actual balance can be recomputed in the same transaction.
const accountOf = async (holdingId) => {
  const { rows } = await db.query(`select account_id from holdings where id = $1`, [holdingId]);
  if (rows.length <= 0) throw new DataError(404, "HOLDING_NOT_FOUND", "Holding not found");
  return rows[0].account_id;
};

exports.updateHolding = async (hid, body) => {
  const accountId = await accountOf(hid);

  await db.queryTransaction([
    {
      text: `update holdings
             set name = $2, pillar_id = $3, amount = $4, description = $5,
                 type_id = $6, issuer = $7, country = $8, currency = $9,
                 isin = $10, quantity = $11, purchase_price = $12,
                 purchase_date = $13, current_price = $14, auto_update = $15,
                 updated_at = CURRENT_TIMESTAMP
             where id = $1`,
      params: [hid, ...holdingParams(body)],
    },
    recomputeActualBalanceQuery(accountId),
  ]);
  return exports.getHoldings(accountId);
};

exports.deleteHolding = async (hid) => {
  const accountId = await accountOf(hid);

  await db.queryTransaction([
    { text: `delete from holdings where id = $1`, params: [hid] },
    recomputeActualBalanceQuery(accountId),
  ]);
  return exports.getHoldings(accountId);
};

// ---------------------------------------------------------------------------
// Quote refresh: read, fetch, write -- three steps, and only two touch the
// database
// ---------------------------------------------------------------------------
// The three refresh endpoints run under withWalletPhased
// (auth/middleware.js), which hands them `tx(write, fn)` instead of an
// open transaction. The shape is always the same:
//
//   1. a short READ ONLY transaction finds the holdings to quote;
//   2. the quotes are fetched with no transaction open and no connection
//      held -- four at a time, each provider call bounded by its own timeout
//      (services/quotes/), the same instrument asked once however
//      many holdings carry it;
//   3. a short write transaction stores every price in one statement and
//      recomputes each affected account once.
//
// It used to be one transaction around a sequential loop -- read, fetch,
// write, recompute, re-read the whole account -- per holding: a pooled
// connection and the row locks on the accounts held for the sum of every
// provider's latency, with no timeout on any of them.
//
// Prices are in the WALLET's currency. The amount of a holding is added up
// with the wallet's balances everywhere -- the Accounts total, the allocation,
// the snapshots -- so a price in any other unit would be a wrong number
// presented as a right one. The providers are asked in the wallet's currency;
// a quote that is not in it (the service may not price every instrument in
// every currency) is not applied, and the holding keeps its manual value. The hint says why
// (reason: CURRENCY_UNSUPPORTED), so the interface can tell the person instead
// of claiming the source was down. purchase_price is compared with
// current_price for the return, so it is expected in the wallet's currency
// too.

const QUOTE_CONCURRENCY = 4;

// At most `limit` calls in flight, results in input order.
const mapLimit = async (items, limit, fn) => {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
};

const quoteKey = (row) => `${String(row.isin).trim().toUpperCase()}|${row.type_code || ""}`;

// One provider call per distinct instrument. lookupQuote never throws; the
// catch is there so that a bug in it costs one quote, not the whole refresh.
const fetchQuotes = async (rows, currency) => {
  const distinct = [...new Map(rows.map((r) => [quoteKey(r), r])).values()];
  const quotes = await mapLimit(distinct, QUOTE_CONCURRENCY, async (r) => {
    try {
      return await quoteProvider.lookupQuote({ isin: String(r.isin).trim(), typeCode: r.type_code, currency });
    } catch (error) {
      console.error(`[quotes] lookup failed for ${r.isin}:`, error.message);
      return null;
    }
  });
  return new Map(distinct.map((r, i) => [quoteKey(r), quotes[i]]));
};

// What to tell the interface about a quote that was not applied.
const withReason = (quote, currency) => {
  const q = quote || {};
  if (q.unsupportedCurrency) return { ...q, reason: "CURRENCY_UNSUPPORTED", currency };
  if (q.price != null && q.quoteCurrency !== currency) return { ...q, reason: "CURRENCY_MISMATCH", currency };
  return q;
};

const usable = (quote, currency) => Boolean(quote && quote.price != null && quote.quoteCurrency === currency);

// Stores the prices, inside the write transaction the caller opened. The
// amount is computed from the quantity *as it is now*, not as it was when the
// holdings were read, and a holding whose ISIN changed in the meantime is left
// alone: the quote was for the old instrument. RLS narrows both statements to
// the wallet in context, like everything else.
const applyQuotes = async (priced) => {
  if (priced.length === 0) return new Set();
  const { rows } = await db.query(
    `update holdings h
        set current_price    = u.price,
            amount           = coalesce(h.quantity * u.price, h.amount),
            price_updated_at = CURRENT_TIMESTAMP,
            updated_at       = CURRENT_TIMESTAMP
       from unnest($1::int[], $2::numeric[], $3::text[]) as u(id, price, isin)
      where h.id = u.id and h.isin = u.isin
      returning h.id, h.account_id`,
    [priced.map((p) => p.id), priced.map((p) => p.price), priced.map((p) => p.isin)],
  );
  const accounts = [...new Set(rows.map((r) => r.account_id))];
  if (accounts.length > 0) {
    await db.query(
      `update accounts
          set actual_amount = (select coalesce(sum(h.amount), 0) from holdings h where h.account_id = accounts.id)
        where id = any($1::int[])`,
      [accounts],
    );
  }
  return new Set(rows.map((r) => r.id));
};

const REFRESHABLE = `
  select h.id, h.account_id, h.isin, t.code as type_code
    from holdings h
    left join holding_types t on (h.type_id = t.id)`;

// The shared middle and end of the three endpoints: fetch, then write what
// can be written. Returns the ids updated and the quote per holding.
const refreshRows = async (rows, currency, tx) => {
  const quotes = await fetchQuotes(rows, currency);
  const priced = [];
  for (const r of rows) {
    const quote = quotes.get(quoteKey(r));
    if (usable(quote, currency)) priced.push({ id: r.id, isin: r.isin, price: quote.price });
  }
  const updated = priced.length > 0 ? await tx(true, () => applyQuotes(priced)) : new Set();
  return { updated, quotes };
};

const walletCurrency = (req) => String((req.user.wallet && req.user.wallet.currency) || "EUR").toUpperCase();

const holdingNotFound = () => new DataError(404, "HOLDING_NOT_FOUND", "Holding not found");

// With no quote service configured the refresh is not an empty success but a
// refusal the interface can name: the buttons are drawn disabled from
// /api/auth/me's `quotes`, and this is what a request sent anyway gets. It is
// thrown from inside withWalletPhased, so the three refusals before it (no
// session, no wallet, read-only) still come first.
const QUOTES_DISABLED_TEXT = "Price updates are not configured on this instance";
const requireQuotes = () => {
  if (!quoteProvider.quotesEnabled()) throw new DataError(409, "QUOTES_DISABLED", QUOTES_DISABLED_TEXT);
};

// Refreshes one holding's price/return/amount through its ISIN (best effort).
// Returns { holdings, hint, updated }: hint carries what the provider said,
// including suggestions the UI may offer but that are not applied (type,
// domicile) and, when nothing was applied because of the currency, why.
exports.refreshHolding = async (req, tx) => {
  requireQuotes();
  const currency = walletCurrency(req);
  const row = await tx(false, async () => {
    const { rows } = await db.query(`${REFRESHABLE} where h.id = $1`, [req.params.hid]);
    return rows[0] || null;
  });
  if (!row) throw holdingNotFound();

  let hint = {};
  let updated = false;
  if (row.isin) {
    const result = await refreshRows([row], currency, tx);
    hint = withReason(result.quotes.get(quoteKey(row)), currency);
    updated = result.updated.has(row.id);
  }
  return tx(false, async () => ({ holdings: await exports.getHoldings(row.account_id), hint, updated }));
};

// Refreshes every holding of one account that has an ISIN and auto_update.
exports.refreshAccount = async (req, tx) => {
  requireQuotes();
  const accountId = req.params.id;
  const currency = walletCurrency(req);
  const rows = await tx(false, async () => {
    const { rows: found } = await db.query(
      `${REFRESHABLE}
        where h.account_id = $1 and h.auto_update = true
          and h.isin is not null and h.isin <> ''`,
      [accountId],
    );
    return found;
  });
  const { updated } = await refreshRows(rows, currency, tx);
  return tx(false, async () => ({
    holdings: await exports.getHoldings(accountId),
    updated: updated.size,
    skipped: rows.length - updated.size,
  }));
};

// Refreshes the holdings (auto_update, with an isin) of every active
// investment account in the wallet. Used by the global button next to the
// portfolio. "Every" is narrowed by RLS: the query does not filter by wallet.
exports.refreshAll = async (req, tx) => {
  requireQuotes();
  const currency = walletCurrency(req);
  const rows = await tx(false, async () => {
    const { rows: found } = await db.query(
      `${REFRESHABLE}
        join accounts a on (h.account_id = a.id)
        where h.auto_update = true and h.isin is not null and h.isin <> ''
          and a.is_account and a.is_investment = true and a.archived = false`,
    );
    return found;
  });
  const { updated } = await refreshRows(rows, currency, tx);
  return { total: rows.length, updated: updated.size, skipped: rows.length - updated.size };
};
