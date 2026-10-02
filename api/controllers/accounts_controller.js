const db = require("../dbConn");
const Account = require("../models/Account");
const DataError = require("../services/dataError");
const { dayRange, monthOf, monthRange, rangeSql, yearOf } = require("../services/period");

exports.getAccounts = async (req) => {
  // With ?archived=true this returns ONLY archived accounts, otherwise only
  // the active ones.
  const archived = req?.query?.archived === "true";

  const { rows } = await db.query(
    `select
      accounts.*,
      account_types.name as type_name,
      (select count(*) from holdings h
        where h.account_id = accounts.id
          and h.auto_update = true
          and h.isin is not null and h.isin <> '')::int as n_asset_refresh
    from accounts
    join account_types on (accounts.type_id = account_types.id)
    where accounts.is_account
      and accounts.archived = $1
    ORDER BY amount DESC`,
    [archived],
  );

  const { rows: tot } = await db.query(
    `select
      sum(accounts.amount) as total,
      sum(coalesce(accounts.actual_amount, accounts.amount)) as total_actual,
      count(*) as n_accounts,
      count(*) filter (where accounts.is_current) as n_current,
      count(*) filter (where accounts.is_investment) as n_investment
    from accounts
    join account_types on (accounts.type_id = account_types.id)
    where accounts.is_account
      and accounts.archived = $1`,
    [archived],
  );

  return {
    totalAmount: tot[0].total,
    totalActualAmount: tot[0].total_actual,
    accountCount: Number(tot[0].n_accounts),
    currentCount: Number(tot[0].n_current),
    investmentCount: Number(tot[0].n_investment),
    data: rows,
  };
};

exports.getCategories = async (req, kind) => {
  // ?from=&to= (YYYYMMDD, both days included) when the page names a period,
  // otherwise ?year=&month=, otherwise this month. Either way the range is
  // half-open on tx_date (services/period.js): `between $from and $to` on a
  // timestamp stopped at midnight at the start of the last day.
  const asked = dayRange(req.query);
  const range =
    asked.from && asked.to ? asked : monthRange(yearOf(req.query.year), monthOf(req.query.month));

  // Match the lookup row by its stable code, not by its name: the name is
  // display text and changes with the language, the code never does.
  const typeCode = kind === "income" ? "INCOME" : kind === "expenses" ? "EXPENSE" : "UNKNOWN";
  const txTypeId = kind === "income" ? 2 : kind === "expenses" ? 1 : -1;

  // With ?archived=true this returns ONLY archived categories.
  const archived = req?.query?.archived === "true";

  // The period's totals per category are made first, from the transactions
  // alone, and joined to the categories afterwards. The other way round -- a
  // left join from every category, with the date range in the join condition --
  // cost a pass over the transactions per category; over "All" it read the
  // wallet's whole history dozens of times.
  const params = [txTypeId, typeCode, archived];
  const period = rangeSql("t.tx_date", range, params);
  const { rows } = await db.query(
    `with s as (
       select t.to_id, sum(t.amount) as total
         from transactions t
        where t.type_id = $1 and ${period.join(" and ")}
        group by t.to_id
     )
     select
       accounts.id,
       accounts.name,
       accounts.color,
       accounts.icon,
       accounts.icon_family,
       accounts.description,
       accounts.archived,
       s.total as sum
     from accounts
     join account_types on (accounts.type_id = account_types.id)
     left join s on (s.to_id = accounts.id)
     where not accounts.is_account
       and account_types.code = $2
       and accounts.archived = $3`,
    params,
  );

  // Income into income categories and expenses into expense categories,
  // archived ones included, as before: the header counts the period's money,
  // not only the part the list below it shows. Aggregated per category first
  // and joined after, for the same reason as the list above.
  const totalParams = [];
  const totalPeriod = rangeSql("t.tx_date", range, totalParams);
  const { rows: totals } = await db.query(
    `with s as (
       select t.to_id, t.type_id, sum(t.amount) as total
         from transactions t
        where t.type_id in (1, 2) and ${totalPeriod.join(" and ")}
        group by t.to_id, t.type_id
     )
     select
       sum(s.total) filter (where s.type_id = 2 and at.code = 'INCOME')  as totinmonth,
       sum(s.total) filter (where s.type_id = 1 and at.code = 'EXPENSE') as totoutmonth
     from s
     join accounts a on (a.id = s.to_id and not a.is_account)
     join account_types at on (at.id = a.type_id)`,
    totalParams,
  );

  return {
    totInMonth: totals[0].totinmonth,
    totOutMonth: totals[0].totoutmonth,
    data: rows,
  };
};

// Two accounts called the same in one wallet cannot be told apart by anyone
// reading a picker, and cannot survive an export: the archive goes by name,
// and the import would fold them into one. A unique index makes a name unique
// per wallet and per kind (bank account, expense category, income category),
// case and surrounding spaces aside. The index includes wallet_id, so a name
// taken in somebody else's wallet is free here and nothing is revealed.
const NAME_INDEX = "uq_accounts_wallet_type_name";

const nameTaken = (error) =>
  error && error.code === "23505" && error.constraint === NAME_INDEX
    ? new DataError(409, "NAME_TAKEN", "This wallet already has an account or category with that name")
    : null;

const rethrowNameTaken = (error) => {
  throw nameTaken(error) || error;
};

// A conflict on the primary key means the sequence has fallen behind the
// table, which happens after a restore that did not carry the sequence with
// it. The message says how to put it right instead of just failing.
const sequenceHint = (fallback) => (error) => {
  const wrapped = new Error();
  if (error.code === "23505") {
    wrapped.message =
      "Id conflict (sequence out of sync?). Run: " +
      "SELECT setval('seq_accounts', (SELECT MAX(id) FROM accounts));";
    wrapped.statusCode = 409;
  } else {
    wrapped.message = error.message || fallback;
    wrapped.statusCode = 500;
  }
  return wrapped;
};

exports.createAccount = async (req) => {
  const { name, color, icon, iconFamily, amount, description, actual_amount, is_current, is_investment } =
    req.body;

  try {
    const isInvestment = is_investment === true;
    const isCurrent = is_current !== false; // default true
    // Only investment accounts have an actual balance distinct from the
    // nominal one; for everything else the two coincide.
    const actualBalance = isInvestment ? actual_amount || amount : amount;

    const account = new Account(
      undefined,
      name,
      color,
      icon,
      iconFamily,
      amount,
      3,
      description,
      true,
      actualBalance,
      isCurrent,
      isInvestment,
    );

    await db.query(
      `insert into accounts
         (id, name, color, icon, amount, type_id, description, is_account, icon_family,
          actual_amount, is_current, is_investment)
       values
         (nextval('seq_accounts'), $1, $2, $3, $4, 3, $5, true, $6, $7, $8, $9)`,
      [
        account.name,
        account.color,
        account.icon,
        account.amount,
        account.description,
        account.icon_family,
        account.actual_amount,
        account.is_current,
        account.is_investment,
      ],
    );

    return account;
  } catch (error) {
    console.error("createAccount error:", error);
    throw nameTaken(error) || sequenceHint("Could not create the account")(error);
  }
};

// Accounts and categories share one table, told apart by is_account. Every
// statement that takes an id from the URL names the kind as well: the accounts
// endpoints must not delete, archive or edit a category, nor the categories
// endpoints an account (an updateCategory on a bank account used to turn it
// into a category). A row of the other kind answers like a missing one.
const notFound = (label) => new DataError(404, "ACCOUNT_NOT_FOUND", `No such ${label}`);

// A row that still has transactions is refused by the foreign key (23503,
// answered 400), exactly as before; nothing is written in that case.
const deleteOfKind = async (id, isAccount, label) => {
  const { rows } = await db.query(`delete from accounts where id = $1 and is_account = $2 returning id`, [
    id,
    isAccount,
  ]);
  if (rows.length === 0) throw notFound(label);
  return `Deleted ${label} with id:` + id;
};

exports.deleteAccount = (id) => deleteOfKind(id, true, "account");

// ---------------------------------------------------------------------------
// Editing an account does not overwrite its balance behind anyone's back
// ---------------------------------------------------------------------------
// The form used to send the balance it had loaded on every save, and this
// wrote it back unconditionally. Open "Current account" to fix a typo, let
// somebody record a 50 expense meanwhile (another member, or you in another
// tab), save -- and the balance went back to what it was before the expense,
// with the expense still in the list. Wallet sharing made that an everyday
// sequence rather than a corner case.
//
// The balance is now written only when the person editing asked for it, and
// only against the balance they were looking at:
//
//   body.amount + body.previous_amount   "it was previous_amount on my screen,
//                                        make it amount". Applied only if the
//                                        stored balance still is
//                                        previous_amount; otherwise 409
//                                        BALANCE_CHANGED with the balance as
//                                        it is now, and nothing is written.
//   no previous_amount                   the balance is not touched, whatever
//                                        `amount` says. Name, colour, icon,
//                                        description and the two flags are
//                                        saved as asked.
//
// Why a refusal and not a delta ("add what they added"): a balance typed into
// this field is nearly always read off a bank statement, an absolute figure.
// Applying it as a difference on top of a transaction the person never saw
// would produce a number nobody typed; refusing shows them the new balance and
// lets them decide. The frontend sends the pair only when the field was
// actually changed, so the everyday rename never meets the check at all.
//
// The comparison allows half a cent. The balance is stored in exact cents
// (numeric), but what the form sends back is a number that went through the
// browser's arithmetic, and a balance saved back when it was a float carried a
// tail of binary error.
const numberOrUndefined = (value, name) => {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new DataError(400, "INVALID_REQUEST", `${name} must be a number`);
  return n;
};

exports.updateAccount = async (req) => {
  const id = req.params.id;
  const body = req.body || {};
  const isInvestment = body.is_investment === true;
  const isCurrent = body.is_current !== false; // default true

  const previous = numberOrUndefined(body.previous_amount, "previous_amount");
  const requested = previous === undefined ? undefined : numberOrUndefined(body.amount, "amount");
  const setsBalance = previous !== undefined && requested !== undefined;

  // One statement decides and writes: the balance check and the update cannot
  // be separated by a transaction landing in between.
  //
  // actual_amount follows the kind of account: for an investment account the
  // value of its holdings (holdings_controller keeps it), for any other NULL,
  // which every reader takes as "the same as the balance".
  const { rows } = await db.query(
    `update accounts
        set name = $2,
            color = $3,
            icon = $4,
            icon_family = $5,
            description = $6,
            is_current = $7,
            is_investment = $8,
            amount = case when $9::boolean then $10::numeric else amount end,
            actual_amount = case when $8::boolean
                                 then (select coalesce(sum(h.amount), 0) from holdings h where h.account_id = accounts.id)
                            end
      where id = $1
        and is_account
        and (not $9::boolean or abs(coalesce(amount, 0) - $11::numeric) < 0.005)
      returning id, amount`,
    [
      id,
      body.name,
      body.color,
      body.icon,
      body.iconFamily,
      body.description,
      isCurrent,
      isInvestment,
      setsBalance,
      setsBalance ? requested : null,
      setsBalance ? previous : null,
    ],
  ).catch(rethrowNameTaken);

  if (rows.length === 0) {
    const { rows: current } = await db.query(`select amount from accounts where id = $1 and is_account`, [id]);
    if (current.length === 0) {
      throw new DataError(404, "ACCOUNT_NOT_FOUND", "No such account");
    }
    throw new DataError(
      409,
      "BALANCE_CHANGED",
      "The balance changed while the account was being edited: check it and save again",
      { balance: current[0].amount },
    );
  }

  return new Account(
    rows[0].id,
    body.name,
    body.color,
    body.icon,
    body.iconFamily,
    rows[0].amount,
    3,
    body.description,
    true,
    null,
    isCurrent,
    isInvestment,
  );
};

const setArchived = async (id, archived, isAccount, label) => {
  const { rows } = await db.query(
    `update accounts set archived = $2 where id = $1 and is_account = $3 returning id`,
    [id, archived, isAccount],
  );
  if (rows.length === 0) throw notFound(label);

  return { id: Number(id), archived };
};

exports.setAccountArchived = (id, archived) => setArchived(id, archived, true, "account");
exports.setCategoryArchived = (id, archived) => setArchived(id, archived, false, "category");

exports.createCategory = async (req) => {
  const { name, color, icon, iconFamily, description, isExpense } = req.body;

  try {
    const category = new Account(
      undefined,
      name,
      color,
      icon,
      iconFamily,
      null,
      isExpense ? 1 : 2,
      description,
      false,
    );

    await db.query(
      `insert into accounts
         (id, name, color, icon, amount, type_id, description, is_account, icon_family)
       values
         (nextval('seq_accounts'), $1, $2, $3, $4, $7, $5, false, $6)`,
      [
        category.name,
        category.color,
        category.icon,
        category.amount,
        category.description,
        category.icon_family,
        category.type_id,
      ],
    );

    return category;
  } catch (error) {
    console.error("createCategory error:", error);
    throw nameTaken(error) || sequenceHint("Could not create the category")(error);
  }
};

exports.deleteCategory = (id) => deleteOfKind(id, false, "category");

// A category's kind (expense or income) is fixed once money has been booked to
// it. Its transactions keep their own type, so an expense category turned into
// an income one would leave its expenses counted nowhere: the summaries add a
// category's expenses only while it is an expense category. Changing the kind
// of an unused category, and renaming or recolouring any, is still allowed.
//
// The row is locked first: a transaction inserted meanwhile takes a key-share
// lock on it through its foreign key, so the check and the write cannot be
// separated by one.
exports.updateCategory = async (req) => {
  const id = req.params.id;
  const body = req.body || {};

  const { rows } = await db.query(
    `select id, type_id from accounts where id = $1 and not is_account for update`,
    [id],
  );
  if (rows.length === 0) throw notFound("category");

  const category = new Account(
    id,
    body.name,
    body.color,
    body.icon,
    body.iconFamily,
    null,
    body.isExpense ? 1 : 2,
    body.description,
    false,
  );

  if (Number(rows[0].type_id) !== category.type_id) {
    const { rows: used } = await db.query(
      `select 1 from transactions where from_id = $1 or to_id = $1 limit 1`,
      [rows[0].id],
    );
    if (used.length > 0) {
      throw new DataError(
        409,
        "CATEGORY_IN_USE",
        "This category has transactions: it cannot change between expense and income",
      );
    }
  }

  await db.query(
    `update accounts
     set name = $2,
         color = $3,
         icon = $4,
         icon_family = $5,
         type_id = $6,
         description = $7
     where id = $1 and not is_account`,
    [
      rows[0].id,
      category.name,
      category.color,
      category.icon,
      category.icon_family,
      category.type_id,
      category.description,
    ],
  ).catch(rethrowNameTaken);

  return category;
};
