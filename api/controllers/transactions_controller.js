const db = require("../dbConn");
const Transaction = require("../models/Transaction");
const Query = require("../models/Query");
const DataError = require("../services/dataError");
const { dayRange, parseDay, rangeSql } = require("../services/period");
const wallets = require("../auth/wallets");

// ---------------------------------------------------------------------------
// The list: one page at a time
// ---------------------------------------------------------------------------
// GET /api/transactions used to return the whole period in one response, and
// the page filtered, searched, sorted and totalled it in the browser. For a
// month that is nothing; for "All" on a ten-year wallet it was twenty
// megabytes of JSON and fifty thousand rows rendered at once. The work now
// happens here and the answer comes in pages.
//
// Query parameters, all optional:
//
//   from, to     YYYYMMDD, both days included. Absent means unbounded, which is
//                what "All" sends.
//   type         a transaction type id
//   fromId,toId  an account or category id
//   q            free text; every word must match (see searchTokens)
//   sort, dir    date | amount, desc | asc
//   limit        how many rows a page aims at (20 to 500, 100 by default)
//   cursor       the nextCursor of the previous page, as it came
//
// The answer keeps the shape it always had -- { data, totIn, totOut } -- with
// data holding day groups, [{ id: 'YYYYMMDD', data: [rows] }], plus:
//
//   flat         true when sort=amount: data is then a plain list of rows,
//                because days mean nothing in a list ordered by size
//   nextCursor   what to send for the next page, null at the end
//   count        how many rows match, all pages together
//   facets       { from, to }: the accounts and categories that occur in the
//                period, for the two dropdowns -- the period only, filters
//                ignored, as the page always did
//
// totIn, totOut, count and facets describe the whole list, not the page, so
// they come with the first page only; a request with a cursor gets rows and
// nextCursor.
//
// Isolation is not this function's business any more than it is anyone
// else's: every statement runs through db.query inside the wallet's
// transaction. A cursor is only ever a day or an (amount, id) pair used as a
// bound in a WHERE that RLS has already narrowed, so a forged one can move
// the window over this wallet's rows and nothing else.

const LIMIT_DEFAULT = 100;
const LIMIT_MIN = 20;
const LIMIT_MAX = 500;

const invalid = (message) => new DataError(400, "INVALID_REQUEST", message);

const oneOf = (value, allowed, fallback, name) => {
  if (value === undefined || value === null || value === "") return fallback;
  if (!allowed.includes(value)) throw invalid(`${name} must be one of ${allowed.join(", ")}`);
  return value;
};

const optionalId = (value, name) => {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0 || n > 2147483647) throw invalid(`${name} must be a positive integer`);
  return n;
};

const pageSize = (value) => {
  if (value === undefined || value === null || value === "") return LIMIT_DEFAULT;
  const n = Number(value);
  if (!Number.isInteger(n)) throw invalid("limit must be an integer");
  return Math.min(LIMIT_MAX, Math.max(LIMIT_MIN, n));
};

// The same normalisation the browser applied before the search moved here
// (frontend/src/utils/generic.js, normalizeText): lower case, accents
// stripped. The column side of the comparison gets unaccent(lower(...)), so
// "caffe" still finds "Caffè".
const normalizeText = (s) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

// Words, not a phrase: "coop 12" finds the Coop receipt of 12.40. Bounded so a
// pasted paragraph is a search and not a statement with a thousand LIKEs.
const searchTokens = (q) =>
  normalizeText(String(q ?? "").slice(0, 200))
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 8)
    .map((t) => t.slice(0, 64));

// A token is matched literally: % and _ are LIKE's wildcards and \ its escape.
const likeLiteral = (token) => `%${token.replace(/[\\%_]/g, "\\$&")}%`;

// A cursor is opaque to the client and plain to us: base64url of a small JSON
// object. Everything in it is checked before it gets near a statement.
const badCursor = () => new DataError(400, "INVALID_CURSOR", "This page marker is not valid; load the list again");

const encodeCursor = (c) => Buffer.from(JSON.stringify(c)).toString("base64url");

const decodeCursor = (raw, sort) => {
  if (raw === undefined || raw === null || raw === "") return null;
  let c;
  try {
    if (typeof raw !== "string" || raw.length > 256) throw badCursor();
    c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    throw badCursor();
  }
  if (!c || typeof c !== "object") throw badCursor();

  if (sort === "date") {
    if (c.k !== "d" || typeof c.v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(c.v)) throw badCursor();
    try {
      parseDay(c.v.replace(/-/g, ""));
    } catch {
      throw badCursor();
    }
    return { k: "d", v: c.v };
  }

  if (c.k !== "a" || typeof c.a !== "number" || !Number.isFinite(c.a)) throw badCursor();
  if (!Number.isInteger(c.id) || c.id < 0 || c.id > 2147483647) throw badCursor();
  return { k: "a", a: c.a, id: c.id };
};

const and = (predicates) => (predicates.length ? predicates.join(" and ") : "true");

// The columns every page returns, the same shape the list has always had.
// Aliases are spelled in lower case on purpose: Postgres folds every unquoted
// identifier, so a camelCase alias would come back lower cased anyway and the
// two spellings would drift apart.
const COLUMNS = `
  t.id,
  tt.id                  as type_id,
  tt.code                as type_code,
  tt.name                as type_name,
  t.amount,
  to_char(t.tx_date, 'YYYYMMDD') as tx_date,
  t.description,
  t.updated_at,
  t.created_by,
  t.updated_by,
  fa.id          as from_id,
  fa.name        as from_name,
  fa.color       as from_color,
  fa.icon        as from_icon,
  fa.icon_family as from_icon_family,
  ta.id          as to_id,
  ta.name        as to_name,
  ta.color       as to_color,
  ta.icon        as to_icon,
  ta.icon_family as to_icon_family`;

// Composite foreign keys keep both ends of a transaction in its own wallet;
// saying so in the join lets the planner use (id, wallet_id) as well.
const ROW_JOINS = `
  join transaction_types tt on (tt.id = t.type_id)
  join accounts fa on (fa.id = t.from_id and fa.wallet_id = t.wallet_id)
  join accounts ta on (ta.id = t.to_id and ta.wallet_id = t.wallet_id)`;

// What the search looks through, the same things the browser's search did:
// the note, both names, the type, and the amount in the two ways somebody
// types it -- 78.20 and 78,20 (and 78, which both contain).
const HAYSTACK = `
  cross join lateral (
    select unaccent(lower(concat_ws(' ',
             t.description, fa.name, ta.name, tt.name,
             to_char(t.amount, 'FM999999999990.00'),
             replace(to_char(t.amount, 'FM999999999990.00'), '.', ',')))) as hay
  ) h`;

// A list of predicates and their parameters, built from the query string.
// `period` is the date range alone: the dropdown options ignore the filters.
const listFilter = (query) => {
  const params = [];
  const where = rangeSql("t.tx_date", dayRange(query), params);
  const period = { where: [...where], params: [...params] };

  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace("?", `$${params.length}`));
  };
  const type = optionalId(query.type, "type");
  if (type) add("t.type_id = ?", type);
  const fromId = optionalId(query.fromId, "fromId");
  if (fromId) add("t.from_id = ?", fromId);
  const toId = optionalId(query.toId, "toId");
  if (toId) add("t.to_id = ?", toId);

  // One LIKE ALL rather than one LIKE per word: the planner flattens the
  // lateral haystack into the join, and each separate LIKE recomputed it --
  // unaccent included -- once per word per row.
  const tokens = searchTokens(query.q);
  if (tokens.length) add("h.hay like all (?::text[])", tokens.map(likeLiteral));

  const searching = tokens.length > 0;
  return {
    where,
    params,
    period,
    // The haystack needs the names, so a search brings the joins with it
    // into the statements that would otherwise only count or find a bound.
    countJoins: searching ? ROW_JOINS + HAYSTACK : "",
    rowJoins: ROW_JOINS + (searching ? HAYSTACK : ""),
  };
};

// Date order, pages cut at day boundaries. A page is "about `limit` rows,
// rounded up to the end of the day": the day of the limit-th row is found
// first (an index-only walk of at most `limit` entries, however deep the page
// is), then every row from that day to the cursor is read. Because a day is
// never split between two pages, the day's net shown above its rows is always
// the whole day's, and the order inside a day -- last touched first, as the
// list has always shown it -- stays put across pages.
//
// The cursor is the last day already shown: "strictly before it" going
// backwards in time, "strictly after it" going forwards.
const datePage = async (f, dir, limit, cursor) => {
  const desc = dir === "desc";
  const order = desc ? "desc" : "asc";
  const where = [...f.where];
  const params = [...f.params];
  const bind = (value) => {
    params.push(value);
    return `$${params.length}`;
  };
  // Days are compared as timestamps, not dates: see rangeSql in
  // services/period.js for why that decides whether the index is used.
  const before = (p) => `t.tx_date < ${p}::timestamp`;
  const after = (p) => `t.tx_date >= ${p}::timestamp + interval '1 day'`;
  if (cursor) {
    where.push(desc ? before(bind(cursor.v)) : after(bind(cursor.v)));
  }

  const { rows: edge } = await db.query(
    `select to_char(t.tx_date, 'YYYY-MM-DD') as day
       from transactions t ${f.countJoins}
      where ${and(where)}
      order by t.tx_date ${order}, t.id ${order}
     offset ${bind(limit - 1)} limit 1`,
    params,
  );
  params.pop(); // the offset belongs to that statement only
  const day = edge.length ? edge[0].day : null;

  const rowWhere = [...where];
  const rowParams = [...params];
  if (day) {
    rowParams.push(day);
    const p = `$${rowParams.length}`;
    rowWhere.push(desc ? `t.tx_date >= ${p}::timestamp` : `t.tx_date < ${p}::timestamp + interval '1 day'`);
  }
  const { rows } = await db.query(
    `select ${COLUMNS}
       from transactions t ${f.rowJoins}
      where ${and(rowWhere)}
      order by date_trunc('day', t.tx_date) ${order}, t.updated_at desc nulls last, t.id desc`,
    rowParams,
  );

  // Fewer than `limit` rows left means there was no limit-th row, and this is
  // the last page. Otherwise one more probe says whether anything lies beyond
  // the boundary day.
  let nextCursor = null;
  if (day) {
    const probe = [...params, day];
    const { rows: more } = await db.query(
      `select 1 from transactions t ${f.countJoins}
        where ${and(where)}
          and ${desc ? before(`$${probe.length}`) : after(`$${probe.length}`)}
        limit 1`,
      probe,
    );
    if (more.length) nextCursor = encodeCursor({ k: "d", v: day });
  }

  return { flat: false, data: groupByDay(rows), nextCursor };
};

// Amount order: one flat list by size, whatever the sign, with the id to
// break ties so the cursor is exact. A missing amount sorts as zero rather
// than as NULL, which a row comparison could never step past.
const AMOUNT_KEY = "coalesce(abs(t.amount), 0)";

const amountPage = async (f, dir, limit, cursor) => {
  const order = dir === "desc" ? "desc" : "asc";
  const where = [...f.where];
  const params = [...f.params];
  if (cursor) {
    params.push(cursor.a, cursor.id);
    where.push(
      `(${AMOUNT_KEY}, t.id) ${order === "desc" ? "<" : ">"} ($${params.length - 1}::numeric, $${params.length}::int)`,
    );
  }
  params.push(limit + 1); // the extra row only says whether there is more
  const { rows } = await db.query(
    `select ${COLUMNS}
       from transactions t ${f.rowJoins}
      where ${and(where)}
      order by ${AMOUNT_KEY} ${order}, t.id ${order}
      limit $${params.length}`,
    params,
  );

  const more = rows.length > limit;
  const data = more ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  // An amount has two decimals and fits a double exactly, so it survives the
  // trip through JSON and back to numeric, and the next page starts precisely
  // after this row.
  const nextCursor = more ? encodeCursor({ k: "a", a: Math.abs(Number(last.amount) || 0), id: last.id }) : null;
  return { flat: true, data, nextCursor };
};

// The figures above the list, for everything the filters select. Type ids:
// 1 = expense, 2 = income (see balanceEffects below).
const listTotals = async (f) => {
  const { rows } = await db.query(
    `select coalesce(sum(t.amount) filter (where t.type_id = 2), 0) as tot_in,
            coalesce(sum(t.amount) filter (where t.type_id = 1), 0) as tot_out,
            count(*)::int as n
       from transactions t ${f.countJoins}
      where ${and(f.where)}`,
    f.params,
  );
  return { totIn: rows[0].tot_in, totOut: rows[0].tot_out, count: rows[0].n };
};

const listFacets = async ({ where, params }) => {
  const period = and(where);
  const { rows } = await db.query(
    `select 'from' as side, a.id as value, a.name as label
       from accounts a
      where a.id in (select t.from_id from transactions t where ${period})
     union all
     select 'to', a.id, a.name
       from accounts a
      where a.id in (select t.to_id from transactions t where ${period})
     order by 1, 3, 2`,
    params,
  );
  const side = (s) => rows.filter((r) => r.side === s).map(({ value, label }) => ({ value, label }));
  return { from: side("from"), to: side("to") };
};

// Turns rows already in day order into [{ id: 'yyyymmdd', data: [...] }],
// keeping that order. It used to be an object keyed by day, which relied on
// Object.keys returning integer-like keys in ascending order and left the
// client to reverse them.
const groupByDay = (rows) => {
  const groups = [];
  let current = null;
  for (const row of rows) {
    if (!current || current.id !== row.tx_date) {
      current = { id: row.tx_date, data: [] };
      groups.push(current);
    }
    current.data.push(row);
  }
  return groups;
};

// Who entered and who last edited each row, by username. users has no RLS
// and is read only from api/auth/, so the names are one lookup there for the
// page's distinct ids rather than a join here. The ids come from rows RLS
// already let through: they name people who wrote into this wallet.
const addAuthorNames = async (rows) => {
  const ids = [...new Set(rows.flatMap((r) => [r.created_by, r.updated_by]).filter((id) => id != null))];
  const names = await wallets.usernames(ids);
  for (const row of rows) {
    row.created_by_name = names.get(row.created_by) ?? null;
    row.updated_by_name = names.get(row.updated_by) ?? null;
  }
};

exports.getTransactions = async (req) => {
  const query = req.query || {};
  const sort = oneOf(query.sort, ["date", "amount"], "date", "sort");
  const dir = oneOf(query.dir, ["desc", "asc"], "desc", "dir");
  const limit = pageSize(query.limit);
  const cursor = decodeCursor(query.cursor, sort);
  const filter = listFilter(query);

  const page =
    sort === "amount" ? await amountPage(filter, dir, limit, cursor) : await datePage(filter, dir, limit, cursor);
  await addAuthorNames(page.flat ? page.data : page.data.flatMap((day) => day.data));
  if (cursor) return page;

  return { ...page, ...(await listTotals(filter)), facets: await listFacets(filter.period) };
};

exports.getNewTransactionData = async () => {
  // The three lists differ only by which rows they select, so one query text
  // serves all of them.
  const pickAccounts = (isAccount, typeId, order) =>
    db.query(
      `select id, name, color, icon, amount, type_id, description, is_account, icon_family
         from accounts
        where is_account = $1
          and type_id = $2
          and archived = false
        order by ${order}`,
      [isAccount, typeId],
    );

  const { rows: accounts } = await pickAccounts(true, 3, "amount desc");
  const { rows: expenseCategories } = await pickAccounts(false, 1, "id");
  const { rows: incomeCategories } = await pickAccounts(false, 2, "id");

  // The last transaction of each type (expense/income/transfer), so the form
  // can default to the accounts used last time for that kind of movement.
  // One index probe per type, walking (wallet_id, type_id, tx_date) backwards:
  // DISTINCT ON over the whole wallet sorted every transaction ever recorded
  // each time the form opened.
  const { rows: lastUsedRows } = await db.query(
    `select tt.id as type_id, l.from_id, l.to_id
       from transaction_types tt
       cross join lateral (
         select t.from_id, t.to_id
           from transactions t
          where t.type_id = tt.id
          order by t.tx_date desc, t.updated_at desc nulls last, t.id desc
          limit 1
       ) l`,
    [],
  );

  const lastUsed = {};
  for (const r of lastUsedRows) {
    lastUsed[r.type_id] = { from_id: r.from_id, to_id: r.to_id };
  }

  return { accounts, expenseCategories, incomeCategories, lastUsed };
};

// A new transaction and its effect on the balances, from a request body.
// Returns the model (what POST /api/transactions has always answered) and the
// id the row was given. The one road in for a new row: the endpoint below and
// accepting an inbox draft (inbox_controller.js) both take it.
const insertNew = async (body) => {
  const { from_id, to_id, amount, type_id, description, tx_date } = body || {};

  try {
    const transaction = new Transaction(
      undefined,
      from_id,
      to_id,
      amount,
      type_id,
      description,
      tx_date,
    );
    const results = await db.queryTransaction(applyTransactionQueries(transaction));
    return { transaction, id: results[0].rows[0].id };
  } catch (error) {
    const wrapped = new Error(error.message || "Could not create the transaction");
    // A missing or foreign end (23503), a missing column (23502), a value
    // that is not one (class 22): the request's fault, not the server's.
    const code = String(error.code || "");
    wrapped.statusCode = code === "23503" || code === "23502" || code.startsWith("22") ? 400 : 500;
    throw wrapped;
  }
};

exports.createTransaction = async (req) => (await insertNew(req.body)).transaction;

// The same, answering the new row's id: for the inbox, which records which
// transaction a draft became.
exports.insertTransaction = async (body) => (await insertNew(body)).id;

// ---------------------------------------------------------------------------
// Undoing a transaction: only what was actually deleted
// ---------------------------------------------------------------------------
// The row used to be read with a plain SELECT, then deleted, then its effect
// reverted -- three statements, and nothing tied the third to the second
// having found anything. Two deletes of the same row (a double click, or two
// members of a shared wallet) both read it; the second DELETE waited for the
// first, then deleted nothing, and reverted the balances all the same. The
// account ended up credited twice, with no error anywhere.
//
// Now the DELETE says what it removed (RETURNING) and the balances move by
// that row and only that row. A second, concurrent DELETE finds the row gone
// once the first commits, returns nothing, and moves nothing.
const deleteReturning = async (id) => {
  const { rows } = await db.query(
    `delete from transactions where id = $1 returning id, from_id, to_id, amount, type_id, created_by`,
    [id],
  );
  return rows[0] || null;
};

// Why a DELETE found nothing. Under READ COMMITTED this statement sees what
// has been committed since the DELETE started, so a row that is back is one a
// concurrent edit re-created: somebody else changed it in the meantime.
const vanished = async (id) => {
  const { rows } = await db.query(`select 1 from transactions where id = $1`, [id]);
  return rows.length
    ? new DataError(409, "TRANSACTION_CHANGED", "The transaction was changed by somebody else meanwhile")
    : new DataError(404, "TRANSACTION_NOT_FOUND", "The transaction no longer exists");
};

exports.updateTransaction = async (req) => {
  const id = req.params.id;

  // An update is the old movement undone and the new one applied, in the
  // request's one transaction: the balances can never be left holding only
  // one of them. The old movement is the row the DELETE actually removed, not
  // one read beforehand -- see deleteReturning.
  const old = await deleteReturning(id);
  if (!old) throw await vanished(id);

  const { from_id, to_id, amount, type_id, description, tx_date } = req.body;
  const edited = new Transaction(id, from_id, to_id, amount, type_id, description, tx_date);
  // The row comes back with its author: the column default would make
  // whoever edits it the author instead.
  edited.created_by = old.created_by;
  await db.queryTransaction([...reverseBalanceQueries(old), ...applyTransactionQueries(edited)]);
  return "Updated transaction with id:" + id;
};

exports.deleteTransaction = async (id) => {
  const removed = await deleteReturning(id);
  if (!removed) throw await vanished(id);

  await db.queryTransaction(reverseBalanceQueries(removed));
  return "Deleted transaction with id:" + id;
};

function formatDate(date) {
  const d = new Date(date);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}${month}${day}`;
}

// Type ids: 1 = expense, 2 = income, 3 = transfer.
const EXPENSE = 1;
const INCOME = 2;

// What one transaction does to the balances, as a list of { accountId, delta }.
// This is the rule, and the only copy of it: the three endpoints below turn it
// into UPDATE statements one transaction at a time, and the import
// (controllers/import_controller.js) sums it over thousands of rows and applies
// the totals in one statement. Two copies of "income lands on the source
// account" would be two copies waiting to disagree.
//
//   expense   the source account loses the amount; the category is not a
//             balance and is left alone
//   income    the source account -- the bank account, since from_id is always
//             an account -- gains it
//   transfer  the source loses it and the destination gains it
const balanceEffects = (transaction) => {
  // A missing amount stays null, as it always did (`amount + null` is null):
  // Number() would turn it into NaN, which Postgres would store as a balance.
  const amount = transaction.amount == null ? null : Number(transaction.amount);
  const effects = [];
  // Transfer or expense: take it out of the source account.
  if (transaction.type_id != INCOME) {
    effects.push({ accountId: transaction.from_id, delta: amount == null ? null : -amount });
  }
  // Income lands on the source account; a transfer lands on the destination.
  if (transaction.type_id != EXPENSE) {
    const accountId = transaction.type_id == INCOME ? transaction.from_id : transaction.to_id;
    effects.push({ accountId, delta: amount });
  }
  return effects;
};

exports.balanceEffects = balanceEffects;

// What a movement does to actual_amount, in SQL, for the UPDATE that moves the
// balance. For an ordinary account the actual balance *is* the balance, and
// NULL says so (every reader takes coalesce(actual_amount, amount)). For an
// investment account it is the market value of its holdings, which money
// moving in or out of the account does not change -- only a holding does, and
// holdings_controller recomputes it then. Setting it to NULL there, as this
// used to, made a broker account show the cash paid in instead of what the
// holdings are worth until somebody next touched a holding.
//
// Shared with the import, which moves balances in bulk with the same rule.
const ACTUAL_AFTER_MOVE = "case when is_investment then actual_amount end";
exports.ACTUAL_AFTER_MOVE = ACTUAL_AFTER_MOVE;

const moveBalance = (delta, accountId) =>
  new Query(`update accounts set amount = amount + $1, actual_amount = ${ACTUAL_AFTER_MOVE} where id = $2`, [
    delta,
    accountId,
  ]);

// Writing the row and moving the balances are one operation, always issued
// together as a list of queries the caller runs in a single transaction.
const applyTransactionQueries = (transaction) => {
  const queries = [];
  const today = new Date();
  const txDate = transaction.tx_date ? transaction.tx_date : formatDate(today);

  if (!transaction.id) {
    queries.push(
      new Query(
        `insert into transactions (id, from_id, to_id, amount, type_id, description, tx_date)
         VALUES (nextval('seq_transactions'), $1, $2, $3, $4, $5, $6)
         returning id`,
        [transaction.from_id, transaction.to_id, transaction.amount, transaction.type_id, transaction.description, txDate],
      ),
    );
  } else {
    // An edit: the same id again, the author kept (NULL stays NULL -- a
    // deleted user), and the user in the tenant context as the last editor.
    queries.push(
      new Query(
        `insert into transactions (id, from_id, to_id, amount, type_id, description, tx_date, created_by, updated_by)
         VALUES ($6, $1, $2, $3, $4, $5, $7, $8, nullif(current_setting('app.user_id', true), '')::int)`,
        [
          transaction.from_id,
          transaction.to_id,
          transaction.amount,
          transaction.type_id,
          transaction.description,
          transaction.id,
          txDate,
          transaction.created_by ?? null,
        ],
      ),
    );
  }

  for (const { accountId, delta } of balanceEffects(transaction)) {
    queries.push(moveBalance(delta, accountId));
  }

  return queries;
};

// The exact mirror of applyTransactionQueries' balance half: same effects,
// opposite signs, for a row that has already been deleted.
const reverseBalanceQueries = (row) =>
  balanceEffects(row).map(({ accountId, delta }) => moveBalance(delta == null ? null : -delta, accountId));
