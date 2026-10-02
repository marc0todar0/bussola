const { Zip, ZipDeflate, strToU8 } = require("fflate");
const db = require("../dbConn");
const csv = require("../services/csv");
const DataError = require("../services/dataError");
const format = require("../services/walletFormat");
const { version: APP_VERSION } = require("../package.json");

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
// Two downloads, both reads, both open to a read-only member: somebody who may
// look at every figure on screen may just as well take them away in a file.
//
//   GET /api/data/export/transactions.csv   the transactions, for a spreadsheet
//   GET /api/data/export/wallet.zip         everything, for another wallet
//
// Every query below runs through db.query, inside the READ ONLY transaction
// withWallet opened, so RLS narrows each of them to the wallet in context. None
// of them says "where wallet_id = ..." and none of them has to.

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The optional period, as two calendar days, both included. Checked here and
// not left to Postgres: a malformed date is the caller's mistake and deserves
// a 400 with a code, not a 500 carrying a cast error.
const dateRange = (query) => {
  const from = query.from ? String(query.from) : null;
  const to = query.to ? String(query.to) : null;
  for (const d of [from, to]) {
    if (d !== null && (!ISO_DATE.test(d) || csv.parseDate(d, "YMD") !== d)) {
      throw new DataError(400, "INVALID_DATE_RANGE", "Dates must be valid and written as YYYY-MM-DD");
    }
  }
  if (from && to && from > to) {
    throw new DataError(400, "INVALID_DATE_RANGE", "The start date is after the end date");
  }
  return { from, to };
};

// tx_date is a timestamp, so "up to the 30th" means "before the 31st":
// comparing with the 30th itself would drop anything entered after midnight.
const readTransactions = async ({ from, to }) => {
  const { rows } = await db.query(
    `select to_char(t.tx_date, 'YYYY-MM-DD') as date,
            tt.code       as type,
            t.amount,
            f.name        as from_name,
            x.name        as to_name,
            t.description
       from transactions t
       join transaction_types tt on (tt.id = t.type_id)
       join accounts f on (f.id = t.from_id)
       join accounts x on (x.id = t.to_id)
      where ($1::date is null or t.tx_date >= $1::date)
        and ($2::date is null or t.tx_date < $2::date + 1)
      order by t.tx_date, t.id`,
    [from, to],
  );
  return rows;
};

const transactionLine = (r) =>
  csv.line([
    csv.textCell(r.date),
    csv.textCell(r.type),
    csv.numberCell(r.amount),
    csv.textCell(r.from_name),
    csv.textCell(r.to_name),
    csv.textCell(r.description),
  ]);

// Filenames are ASCII: a wallet called "Casa Rossi — 2026" becomes
// casa-rossi-2026, which every browser and every file system accepts without
// the RFC 5987 dance.
const slug = (name) =>
  String(name || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "wallet";

const today = () => new Date().toISOString().slice(0, 10);

// Lines are handed over in slices rather than one string per row or one string
// for the whole file: a write per row would be ten thousand syscalls, a single
// string would be the whole file in memory twice.
const CHUNK = 64 * 1024;

function* chunks(header, rows, toLine) {
  let buffer = csv.BOM + csv.line(header);
  for (const r of rows) {
    buffer += toLine(r);
    if (buffer.length >= CHUNK) {
      yield buffer;
      buffer = "";
    }
  }
  if (buffer) yield buffer;
}

// A response that is already streaming cannot turn into a JSON error any more.
// Destroying it makes the browser report a failed download, which is the
// honest outcome; ending it normally would leave a truncated file that looks
// complete.
const abortStream = (res, error) => {
  if (res.headersSent) {
    res.destroy(error);
    return true;
  }
  return false;
};

exports.transactionsCsv = async (req, res) => {
  const range = dateRange(req.query);
  const rows = await readTransactions(range);

  const name = `bussola-${slug(req.user.wallet.name)}-transactions-${today()}.csv`;
  res.status(200);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Cache-Control", "no-store");

  try {
    for (const piece of chunks(format.TRANSACTION_COLUMNS, rows, transactionLine)) {
      if (!res.write(piece)) await new Promise((resolve) => res.once("drain", resolve));
    }
    res.end();
  } catch (error) {
    if (!abortStream(res, error)) throw error;
  }
};

// ---------------------------------------------------------------------------
// The whole wallet
// ---------------------------------------------------------------------------

// The opening balance is computed in the same statement that reads the
// balance, so the two cannot disagree even if somebody writes a transaction
// while the export runs. The arithmetic is balanceEffects() in
// transactions_controller read backwards: an expense or a transfer took the
// amount out of `from`, an income put it into `from`, a transfer put it into
// `to`.
const readAccounts = async () => {
  const { rows } = await db.query(
    `select a.name, a.amount, a.is_investment, a.is_current, a.archived,
            a.color, a.icon, a.icon_family, a.description,
            a.amount
              - coalesce((select sum(case when tt.code = 'INCOME' then t.amount else -t.amount end)
                            from transactions t
                            join transaction_types tt on (tt.id = t.type_id)
                           where t.from_id = a.id), 0)
              - coalesce((select sum(t.amount)
                            from transactions t
                            join transaction_types tt on (tt.id = t.type_id)
                           where t.to_id = a.id and tt.code = 'TRANSFER'), 0) as opening_balance
       from accounts a
      where a.is_account
      order by a.id`,
  );
  return rows;
};

const readCategories = async () => {
  const { rows } = await db.query(
    `select a.name, at.code as kind, a.archived, a.color, a.icon, a.icon_family, a.description
       from accounts a
       join account_types at on (at.id = a.type_id)
      where not a.is_account
      order by a.id`,
  );
  return rows;
};

const readHoldings = async () => {
  const { rows } = await db.query(
    `select a.name as account, h.name, p.code as pillar, t.code as type_code, t.name as type_name,
            h.amount, h.quantity, h.purchase_price,
            to_char(h.purchase_date, 'YYYY-MM-DD') as purchase_date,
            h.current_price, h.currency, h.isin, h.issuer, h.country, h.auto_update, h.description
       from holdings h
       join accounts a on (a.id = h.account_id)
       join pillars p on (p.id = h.pillar_id)
       left join holding_types t on (t.id = h.type_id)
      order by a.id, h.id`,
  );
  return rows;
};

const readSnapshots = async () => {
  const { rows } = await db.query(
    `select year, month, total, value_p1, value_p2, value_p3, value_p4, detail
       from portfolio_snapshots
      order by year, month`,
  );
  return rows;
};

// value_p1..value_p4 are columns named after pillar ids 1 to 4, which is the
// schema's business. The file names them by code.
const readPillars = async () => {
  const { rows } = await db.query(`select id, code from pillars where id between 1 and 4 order by id`);
  return rows;
};

const accountLine = (r) =>
  csv.line([
    csv.textCell(r.name),
    csv.moneyCell(r.amount),
    csv.moneyCell(r.opening_balance),
    csv.boolCell(r.is_investment),
    csv.boolCell(r.is_current),
    csv.boolCell(r.archived),
    csv.textCell(r.color),
    csv.textCell(r.icon),
    csv.textCell(r.icon_family),
    csv.textCell(r.description),
  ]);

const categoryLine = (r) =>
  csv.line([
    csv.textCell(r.name),
    csv.textCell(r.kind),
    csv.boolCell(r.archived),
    csv.textCell(r.color),
    csv.textCell(r.icon),
    csv.textCell(r.icon_family),
    csv.textCell(r.description),
  ]);

const holdingLine = (r) =>
  csv.line([
    csv.textCell(r.account),
    csv.textCell(r.name),
    csv.textCell(r.pillar),
    csv.textCell(r.type_code),
    csv.textCell(r.type_code ? null : r.type_name),
    csv.numberCell(r.amount),
    csv.numberCell(r.quantity),
    csv.numberCell(r.purchase_price),
    csv.textCell(r.purchase_date),
    csv.numberCell(r.current_price),
    csv.textCell(r.currency),
    csv.textCell(r.isin),
    csv.textCell(r.issuer),
    csv.textCell(r.country),
    csv.boolCell(r.auto_update),
    csv.textCell(r.description),
  ]);

const snapshotLine = (pillars) => (r) =>
  csv.line([
    csv.numberCell(r.year),
    csv.numberCell(r.month),
    csv.moneyCell(r.total),
    ...pillars.map((p) => csv.moneyCell(r[`value_p${p.id}`])),
  ]);

// fflate rather than archiver or yazl. It has no dependencies at all (archiver
// pulls in a dozen packages, among them a glob implementation), it both writes
// and reads ZIPs -- so the import uses the same library to open what the
// export produced -- and it streams: each file is compressed as its lines are
// pushed in, and every compressed chunk goes straight to the response.
//
// The rows themselves are read table by table before the archive starts. A
// wallet is at most some tens of thousands of rows, and reading first means a
// failing query still answers with a proper JSON error instead of a download
// that breaks halfway.
exports.walletZip = async (req, res) => {
  const wallet = req.user.wallet;
  const accounts = await readAccounts();
  const categories = await readCategories();
  const transactions = await readTransactions({ from: null, to: null });
  const holdings = await readHoldings();
  const snapshots = await readSnapshots();
  const pillars = await readPillars();

  const details = {};
  for (const s of snapshots) {
    if (s.detail) details[`${s.year}-${String(s.month).padStart(2, "0")}`] = s.detail;
  }

  const manifest = {
    format: format.FORMAT,
    formatVersion: format.FORMAT_VERSION,
    appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(),
    wallet: { name: wallet.name, currency: wallet.currency },
    counts: {
      accounts: accounts.length,
      categories: categories.length,
      transactions: transactions.length,
      holdings: holdings.length,
      snapshots: snapshots.length,
    },
  };

  const name = `bussola-${slug(wallet.name)}-${today()}.zip`;
  res.status(200);
  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${name}"`);
  res.setHeader("Cache-Control", "no-store");

  // fflate calls back synchronously and cannot wait for the socket, so the
  // back-pressure is handled on the pushing side: after each push, if the
  // response said it was full, wait for it to drain before pushing more.
  let zipError = null;
  let full = false;
  let finished;
  const done = new Promise((resolve) => {
    finished = resolve;
  });
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      zipError = error;
      finished();
      return;
    }
    if (!res.write(Buffer.from(chunk))) full = true;
    if (final) finished();
  });

  const drain = async () => {
    if (zipError) throw zipError;
    if (full) {
      full = false;
      await new Promise((resolve) => res.once("drain", resolve));
    }
  };

  const addText = async (fileName, pieces) => {
    const entry = new ZipDeflate(fileName, { level: 6 });
    zip.add(entry);
    for (const piece of pieces) {
      entry.push(strToU8(piece));
      await drain();
    }
    entry.push(new Uint8Array(0), true);
    await drain();
  };

  try {
    await addText(format.FILES.manifest, [JSON.stringify(manifest, null, 2)]);
    await addText(format.FILES.accounts, chunks(format.ACCOUNT_COLUMNS, accounts, accountLine));
    await addText(format.FILES.categories, chunks(format.CATEGORY_COLUMNS, categories, categoryLine));
    await addText(
      format.FILES.transactions,
      chunks(format.TRANSACTION_COLUMNS, transactions, transactionLine),
    );
    await addText(format.FILES.holdings, chunks(format.HOLDING_COLUMNS, holdings, holdingLine));
    await addText(
      format.FILES.snapshots,
      chunks([...format.SNAPSHOT_COLUMNS, ...pillars.map((p) => p.code)], snapshots, snapshotLine(pillars)),
    );
    await addText(format.FILES.snapshotDetails, [JSON.stringify(details)]);
    zip.end();
    await done;
    if (zipError) throw zipError;
    res.end();
  } catch (error) {
    if (!abortStream(res, error)) throw error;
  }
};

exports.dateRange = dateRange;
