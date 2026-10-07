const { unzipSync, strFromU8 } = require("fflate");
const db = require("../dbConn");
const csv = require("../services/csv");
const DataError = require("../services/dataError");
const format = require("../services/walletFormat");
const { balanceEffects, ACTUAL_AFTER_MOVE, resetManualActualQuery } = require("./transactions_controller");

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
// Three kinds of file, one road:
//
//   bussola-csv   the transactions.csv the export writes
//   bussola-zip   the whole-wallet archive the export writes
//   bank-csv      anything else that is a CSV, read through the mapping the
//                 person importing chose in the wizard
//
// Each is turned into the same model -- rows of transactions by name, plus,
// for the archive, accounts, categories, holdings and snapshots -- and from
// there the preview and the commit share every step.
//
// The preview is stateless, and so is the commit. Both requests carry the file
// itself (base64, because it rides in a JSON body) and the options; the commit
// adds only the decisions -- which rows, and which category for a row. The
// server parses the file again and re-validates everything, so nothing the
// preview said is trusted, and there is no staging table to clean up after an
// abandoned import. The file is at most MAX_FILE_BYTES, so sending it twice
// costs less than the table would.
//
// Both endpoints are behind withWalletWrite: the preview writes nothing, but
// it is the first half of a write, and a read-only member offered a preview
// they can never confirm would be looking at a trap.
//
// Isolation is not this file's job either. Every name is resolved with
// db.query inside the wallet's transaction, so RLS decides which accounts
// exist: somebody else's "Current account" is not there to be matched, and a
// name that matches nothing here is created *here*. The composite foreign keys
// (from_id, wallet_id) would refuse a cross-wallet reference even if one were
// somehow produced.

const MB = 5;
const MAX_FILE_BYTES = MB * 1024 * 1024;
// Ten thousand rows is a decade of a busy account; twice that is the ceiling.
// Beyond it the preview alone would be a response of several megabytes, and
// splitting the file is a better answer than a slow page.
const MAX_TRANSACTIONS = 20000;
const MAX_OTHER_ROWS = 5000;
// What an archive may inflate to. A 5 MB ZIP can hold gigabytes of zeros; the
// sizes are checked against the archive's own directory before anything is
// decompressed, and fflate decompresses into a buffer of exactly that size.
const MAX_UNZIPPED_BYTES = 40 * 1024 * 1024;
// The columns these land in are varchar(255).
const TEXT_MAX = 255;
const SAMPLE_ROWS = 15;

const TYPES = ["EXPENSE", "INCOME", "TRANSFER"];

// What a created account or category looks like until somebody opens it: the
// same icons the starter data uses (auth/bootstrap.js), so they are known to
// exist in the icon set.
const DEFAULT_LOOK = {
  ACCOUNT: { color: "steelblue", icon: "cc-mastercard", icon_family: "FontAwesome" },
  EXPENSE: { color: "dimgray", icon: "dot-chart", icon_family: "AntDesign" },
  INCOME: { color: "darkorange", icon: "gift", icon_family: "AntDesign" },
};

const tooLarge = () =>
  new DataError(413, "IMPORT_TOO_LARGE", `The file is larger than ${MB} MB`, { max: MB });
const tooManyRows = (max) =>
  new DataError(413, "IMPORT_TOO_MANY_ROWS", `The file has more than ${max} rows`, { max });
const badOptions = (what) => new DataError(400, "IMPORT_BAD_OPTIONS", `Invalid import settings: ${what}`);

// ---------------------------------------------------------------------------
// Reading the request
// ---------------------------------------------------------------------------

const readFile = (body) => {
  if (!body || typeof body.file !== "string" || body.file.length === 0) {
    throw new DataError(400, "IMPORT_EMPTY", "No file was sent");
  }
  // Checked on the encoded length first, so an oversized upload is refused
  // before it is decoded into a second copy.
  if (body.file.length > Math.ceil(MAX_FILE_BYTES / 3) * 4 + 4) throw tooLarge();
  const buffer = Buffer.from(body.file, "base64");
  if (buffer.length === 0) throw new DataError(400, "IMPORT_EMPTY", "The file is empty");
  if (buffer.length > MAX_FILE_BYTES) throw tooLarge();
  return buffer;
};

const column = (value, what) => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 1000) throw badOptions(what);
  return n;
};

const name = (value) => (value == null ? "" : String(value).trim());

// Everything the client may say, checked and reduced to known values. "auto",
// or leaving a setting out, means "work it out"; anything else outside the
// lists is refused rather than silently replaced.
const readOptions = (raw) => {
  const o = raw && typeof raw === "object" ? raw : {};
  const oneOf = (value, allowed, what) => {
    if (value === undefined || value === null || value === "" || value === "auto") return null;
    if (!allowed.includes(value)) throw badOptions(what);
    return value;
  };
  const skipRows = o.skipRows === undefined || o.skipRows === null || o.skipRows === "" ? 0 : Number(o.skipRows);
  if (!Number.isInteger(skipRows) || skipRows < 0 || skipRows > 100) throw badOptions("skipRows");

  let mapping = null;
  if (o.mapping) {
    if (typeof o.mapping !== "object") throw badOptions("mapping");
    const m = o.mapping;
    mapping = {
      date: column(m.date, "date column"),
      amount: column(m.amount, "amount column"),
      debit: column(m.debit, "debit column"),
      credit: column(m.credit, "credit column"),
      note: column(m.note, "note column"),
      account: name(m.account),
      expenseCategory: name(m.expenseCategory),
      incomeCategory: name(m.incomeCategory),
    };
  }

  return {
    encoding: oneOf(o.encoding, csv.ENCODINGS, "encoding") || "auto",
    separator: oneOf(o.separator, csv.SEPARATORS, "separator"),
    decimal: oneOf(o.decimal, [".", ","], "decimal"),
    dateFormat: oneOf(o.dateFormat, csv.DATE_FORMATS, "dateFormat"),
    headerRow: o.headerRow === undefined || o.headerRow === null || o.headerRow === "auto" ? null : Boolean(o.headerRow),
    skipRows,
    mapping,
  };
};

// The commit's decisions: which rows (by their line in the file) and, for
// some of them, a different category.
const readSelection = (raw) => {
  const s = raw && typeof raw === "object" ? raw : {};
  if (!Array.isArray(s.lines)) throw badOptions("selection");
  const lines = new Set();
  for (const l of s.lines) {
    const n = Number(l);
    if (!Number.isInteger(n) || n < 1) throw badOptions("selection");
    lines.add(n);
  }
  const overrides = new Map();
  if (s.overrides && typeof s.overrides === "object") {
    for (const [line, category] of Object.entries(s.overrides)) {
      const n = Number(line);
      const value = name(category);
      if (!Number.isInteger(n) || !value || value.length > TEXT_MAX) throw badOptions("overrides");
      overrides.set(n, value);
    }
  }
  return { lines, overrides };
};

// ---------------------------------------------------------------------------
// Rows of transactions, from any of the three formats
// ---------------------------------------------------------------------------
// A row is { line, date, type, amount, from, to, note, errors }. `line` is the
// record's number in the file as a spreadsheet would count it -- the header is
// 1 -- because that is how the person will go and look for it.

// Checks that do not depend on the format. `errors` holds stable codes; the
// interface translates them.
const finishRow = (row) => {
  const errors = row.errors;
  if (!row.from) errors.push("MISSING_FROM");
  if (!row.to) errors.push("MISSING_TO");
  if (row.from.length > TEXT_MAX || row.to.length > TEXT_MAX) errors.push("NAME_TOO_LONG");
  if (row.note.length > TEXT_MAX) errors.push("NOTE_TOO_LONG");
  if (row.amount != null && row.amount >= 1e12) errors.push("INVALID_AMOUNT");
  if (row.type === "TRANSFER" && row.from && key(row.from) === key(row.to)) errors.push("SAME_ACCOUNT");
  row.errors = [...new Set(errors)];
  return row;
};

const headerIndex = (header, columns) => {
  const cleaned = header.map((h) => String(h).trim().toLowerCase());
  return Object.fromEntries(columns.map((c) => [c, cleaned.indexOf(c)]));
};

const isBussolaHeader = (header) => {
  if (!header) return false;
  const idx = headerIndex(header, format.TRANSACTION_COLUMNS);
  return ["date", "type", "amount", "from", "to"].every((c) => idx[c] >= 0);
};

// A file of ours re-saved by a spreadsheet in a comma-decimal language comes
// back with semicolons and "12,5". That much is forgiven; anything looser is
// what the bank wizard is for.
const bussolaAmount = (raw, separator) => {
  const strict = csv.parseDotNumber(raw);
  if (strict !== null || separator !== ";") return strict;
  return csv.parseDotNumber(String(raw).replace(",", "."));
};

const bussolaTransactions = (rows, separator) => {
  const idx = headerIndex(rows[0], format.TRANSACTION_COLUMNS);
  const data = rows.slice(1);
  if (data.length > MAX_TRANSACTIONS) throw tooManyRows(MAX_TRANSACTIONS);
  return data.map((cells, i) => {
    const get = (c) => (idx[c] >= 0 && cells[idx[c]] != null ? cells[idx[c]] : "");
    const errors = [];
    const date = csv.parseDate(get("date"), "YMD");
    if (!date) errors.push("INVALID_DATE");
    const type = get("type").trim().toUpperCase();
    if (!TYPES.includes(type)) errors.push("INVALID_TYPE");
    const amount = bussolaAmount(get("amount"), separator);
    if (amount === null || amount <= 0) errors.push("INVALID_AMOUNT");
    return finishRow({
      line: i + 2,
      date,
      type: TYPES.includes(type) ? type : null,
      amount: amount !== null && amount > 0 ? amount : null,
      from: csv.unprotectText(get("from")).trim(),
      to: csv.unprotectText(get("to")).trim(),
      note: csv.unprotectText(get("note")).trim(),
      errors,
    });
  });
};

// ---------------------------------------------------------------------------
// A bank's CSV
// ---------------------------------------------------------------------------

// Which column is which, from the header, in the languages the interface
// speaks. A guess and nothing more: the wizard shows it and the person fixes
// it. Debit and credit are looked for before a plain amount, because a header
// like "Importo dare" would otherwise be taken for the one amount column.
const HEADER_HINTS = [
  ["date", /date|data|datum|fecha|日期|buchung/i],
  ["debit", /debit|débit|addebit|uscit|\bdare\b|soll|cargo|withdraw|paid out|money out|支出|借方/i],
  ["credit", /credit|crédit|accredit|entrat|avere|haben|abono|deposit|paid in|money in|收入|贷方/i],
  ["amount", /amount|importo|betrag|montant|importe|umsatz|金额|valore|sum/i],
  ["note", /descri|causale|memo|verwendung|beschreib|libell|concepto|摘要|说明|详情|detail|narrative|payee|reference|text/i],
];

const share = (values, test) => {
  const present = values.filter((v) => v != null && String(v).trim() !== "");
  return present.length === 0 ? 0 : present.filter(test).length / present.length;
};

const guessColumns = (header, data, width) => {
  const guess = { date: null, amount: null, debit: null, credit: null, note: null };
  const used = new Set();
  if (header) {
    for (const [field, pattern] of HEADER_HINTS) {
      const i = header.findIndex((h, j) => !used.has(j) && pattern.test(String(h)));
      if (i >= 0) {
        guess[field] = i;
        used.add(i);
      }
    }
  }
  const sample = data.slice(0, 50);
  const valuesOf = (j) => sample.map((r) => r[j]);
  // No header, or a header in a language not listed: look at the values.
  if (guess.date === null) {
    for (let j = 0; j < width; j++) {
      if (!used.has(j) && share(valuesOf(j), csv.looksLikeDate) >= 0.8) {
        guess.date = j;
        used.add(j);
        break;
      }
    }
  }
  if (guess.amount === null && guess.debit === null && guess.credit === null) {
    for (let j = 0; j < width; j++) {
      if (used.has(j)) continue;
      const values = valuesOf(j);
      const numeric = share(values, (v) => csv.parseAmount(v, ",") !== null && /\d[.,]\d/.test(v));
      if (numeric >= 0.8 && share(values, csv.looksLikeDate) < 0.5) {
        guess.amount = j;
        used.add(j);
        break;
      }
    }
  }
  // Debit without credit (or the reverse) is not a split: one column then.
  if ((guess.debit === null) !== (guess.credit === null)) {
    if (guess.amount === null) guess.amount = guess.debit ?? guess.credit;
    guess.debit = null;
    guess.credit = null;
  }
  if (guess.note === null) {
    let best = -1;
    for (let j = 0; j < width; j++) {
      if (used.has(j)) continue;
      const len = valuesOf(j).reduce((acc, v) => acc + String(v || "").length, 0);
      if (len > best && share(valuesOf(j), (v) => csv.parseAmount(v, ",") === null) >= 0.5) {
        best = len;
        guess.note = j;
      }
    }
  }
  return guess;
};

// Settings the person left on "auto", worked out from the rows themselves.
const resolveBankSettings = (rows, options) => {
  const afterSkip = rows.slice(options.skipRows);
  let headerRow = options.headerRow;
  if (headerRow === null) {
    // A first row with a date in it is already data; anything else is a
    // header. With nothing to go on the answer is yes: nearly every bank
    // export has one.
    headerRow = !(afterSkip[0] || []).some(csv.looksLikeDate);
  }
  const header = headerRow ? (afterSkip[0] || []).map((h) => String(h).trim()) : null;
  const data = headerRow ? afterSkip.slice(1) : afterSkip;
  const width = Math.max(header ? header.length : 0, ...data.slice(0, 100).map((r) => r.length), 0);
  const firstLine = options.skipRows + (headerRow ? 2 : 1);
  return { header, data, width, firstLine, headerRow };
};

const bankTransactions = (data, firstLine, settings, mapping) => {
  if (data.length > MAX_TRANSACTIONS) throw tooManyRows(MAX_TRANSACTIONS);
  const cell = (cells, j) => (j === null || cells[j] == null ? "" : String(cells[j]));
  return data.map((cells, i) => {
    const errors = [];
    const date = csv.parseDate(cell(cells, mapping.date), settings.dateFormat);
    if (!date) errors.push("INVALID_DATE");

    // The sign decides: money going out is an expense, money coming in an
    // income. With two columns, whatever the bank printed in "out" counts as
    // out whether or not it carried a minus sign -- banks disagree about that.
    let signed = null;
    if (mapping.amount !== null) {
      signed = csv.parseAmount(cell(cells, mapping.amount), settings.decimal);
      if (signed === null) errors.push("INVALID_AMOUNT");
    } else {
      const read = (j) => {
        const raw = cell(cells, j).trim();
        if (!raw) return 0;
        const n = csv.parseAmount(raw, settings.decimal);
        return n === null ? NaN : Math.abs(n);
      };
      const out = read(mapping.debit);
      const inn = read(mapping.credit);
      if (Number.isNaN(out) || Number.isNaN(inn)) errors.push("INVALID_AMOUNT");
      else signed = inn - out;
    }
    if (signed === 0) errors.push("ZERO_AMOUNT");

    const type = signed !== null && signed < 0 ? "EXPENSE" : "INCOME";
    // A bank's description can run to several hundred characters of
    // reference numbers. It is shortened rather than refused: the note is
    // there to recognise the payment, and the first 255 characters do that.
    const note = cell(cells, mapping.note).replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
    return finishRow({
      line: firstLine + i,
      date,
      type,
      amount: signed !== null && signed !== 0 ? Math.abs(signed) : null,
      from: mapping.account,
      to: type === "EXPENSE" ? mapping.expenseCategory : mapping.incomeCategory,
      note,
      errors,
    });
  });
};

// ---------------------------------------------------------------------------
// The archive
// ---------------------------------------------------------------------------

const isZip = (buffer) =>
  buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b && buffer[2] === 0x03 && buffer[3] === 0x04;

const invalidZip = () =>
  new DataError(400, "IMPORT_INVALID_ZIP", "This archive is damaged or is not a Bussola wallet export");

const bool = (value) => /^(true|1|yes)$/i.test(String(value || "").trim());
const numberOrNull = (value) => (String(value || "").trim() === "" ? null : csv.parseDotNumber(value));
const text = (value) => csv.unprotectText(String(value == null ? "" : value)).trim();

// Each CSV in the archive, as objects keyed by header. The files are ours, so
// they are UTF-8 and comma-separated by construction.
const csvObjects = (files, fileName, max) => {
  const bytes = files[fileName];
  if (!bytes) return [];
  const rows = csv.parse(csv.decode(Buffer.from(bytes), "utf-8").text, ",");
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  if (rows.length - 1 > max) throw tooManyRows(max);
  return rows.slice(1).map((cells, i) => {
    const o = { line: i + 2 };
    header.forEach((h, j) => {
      o[h] = cells[j] == null ? "" : cells[j];
    });
    return o;
  });
};

const readZip = (buffer) => {
  const wanted = new Set(Object.values(format.FILES));
  let total = 0;
  let files;
  try {
    files = unzipSync(new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.length), {
      // Only the files an archive of ours contains are decompressed at all,
      // and only while the declared sizes stay within bounds.
      filter: (f) => {
        if (!wanted.has(f.name)) return false;
        total += f.originalSize;
        if (f.originalSize > MAX_UNZIPPED_BYTES || total > MAX_UNZIPPED_BYTES) throw tooLarge();
        return true;
      },
    });
  } catch (error) {
    if (error instanceof DataError) throw error;
    throw invalidZip();
  }

  let manifest;
  try {
    manifest = JSON.parse(strFromU8(files[format.FILES.manifest]));
  } catch {
    throw invalidZip();
  }
  if (!manifest || manifest.format !== format.FORMAT) throw invalidZip();
  if (!(Number(manifest.formatVersion) >= 1)) throw invalidZip();
  if (Number(manifest.formatVersion) > format.FORMAT_VERSION) {
    throw new DataError(
      400,
      "IMPORT_UNSUPPORTED_VERSION",
      `This archive was written in format ${manifest.formatVersion}, newer than this version of Bussola reads`,
      { version: manifest.formatVersion },
    );
  }

  const issues = [];
  const issue = (file, line, code) => issues.push({ file, line, code });

  const accounts = [];
  for (const r of csvObjects(files, format.FILES.accounts, MAX_OTHER_ROWS)) {
    const n = text(r.name);
    if (!n) issue(format.FILES.accounts, r.line, "MISSING_NAME");
    else if (n.length > TEXT_MAX) issue(format.FILES.accounts, r.line, "NAME_TOO_LONG");
    else {
      accounts.push({
        name: n,
        // A hand-made file with only `balance` starts the account at zero:
        // using the balance would double every transaction, and zero is the
        // number the person can at least recognise as wrong.
        opening: numberOrNull(r.opening_balance) ?? 0,
        is_investment: bool(r.investment),
        is_current: r.current === undefined || r.current === "" ? true : bool(r.current),
        archived: bool(r.archived),
        color: text(r.color).slice(0, TEXT_MAX) || null,
        icon: text(r.icon).slice(0, TEXT_MAX) || null,
        icon_family: text(r.icon_family).slice(0, TEXT_MAX) || null,
        description: text(r.description).slice(0, TEXT_MAX) || null,
      });
    }
  }

  const categories = [];
  for (const r of csvObjects(files, format.FILES.categories, MAX_OTHER_ROWS)) {
    const n = text(r.name);
    const kind = text(r.kind).toUpperCase();
    if (!n) issue(format.FILES.categories, r.line, "MISSING_NAME");
    else if (n.length > TEXT_MAX) issue(format.FILES.categories, r.line, "NAME_TOO_LONG");
    else if (kind !== "EXPENSE" && kind !== "INCOME") issue(format.FILES.categories, r.line, "INVALID_KIND");
    else {
      categories.push({
        name: n,
        kind,
        archived: bool(r.archived),
        color: text(r.color).slice(0, TEXT_MAX) || null,
        icon: text(r.icon).slice(0, TEXT_MAX) || null,
        icon_family: text(r.icon_family).slice(0, TEXT_MAX) || null,
        description: text(r.description).slice(0, TEXT_MAX) || null,
      });
    }
  }

  let transactions = [];
  const txBytes = files[format.FILES.transactions];
  if (txBytes) {
    const rows = csv.parse(csv.decode(Buffer.from(txBytes), "utf-8").text, ",");
    if (rows.length > 0) {
      if (!isBussolaHeader(rows[0])) throw invalidZip();
      transactions = bussolaTransactions(rows, ",");
    }
  }

  // Column limits of the holdings table: the quote provider reads isin and
  // currency, and a value that does not fit would fail the whole commit.
  const LIMITS = { currency: 3, isin: 12, country: 100 };
  const holdings = [];
  for (const r of csvObjects(files, format.FILES.holdings, MAX_OTHER_ROWS)) {
    const h = {
      line: r.line,
      account: text(r.account),
      name: text(r.name),
      pillar: text(r.pillar).toUpperCase(),
      type_code: text(r.type_code).toUpperCase() || null,
      type_name: text(r.type_name) || null,
      amount: numberOrNull(r.amount) ?? 0,
      quantity: numberOrNull(r.quantity),
      purchase_price: numberOrNull(r.purchase_price),
      purchase_date: String(r.purchase_date || "").trim() ? csv.parseDate(r.purchase_date, "YMD") : null,
      current_price: numberOrNull(r.current_price),
      currency: text(r.currency) || null,
      isin: text(r.isin) || null,
      issuer: text(r.issuer) || null,
      country: text(r.country) || null,
      auto_update: r.auto_update === undefined || r.auto_update === "" ? true : bool(r.auto_update),
      description: text(r.description) || null,
    };
    const tooLong =
      h.name.length > TEXT_MAX ||
      (h.issuer || "").length > TEXT_MAX ||
      (h.description || "").length > TEXT_MAX ||
      (h.type_name || "").length > TEXT_MAX ||
      Object.entries(LIMITS).some(([k, max]) => (h[k] || "").length > max);
    if (!h.name) issue(format.FILES.holdings, r.line, "MISSING_NAME");
    else if (!h.account) issue(format.FILES.holdings, r.line, "UNKNOWN_ACCOUNT");
    else if (tooLong) issue(format.FILES.holdings, r.line, "NAME_TOO_LONG");
    else if (String(r.purchase_date || "").trim() && !h.purchase_date) issue(format.FILES.holdings, r.line, "INVALID_DATE");
    else holdings.push(h);
  }

  let details = {};
  if (files[format.FILES.snapshotDetails]) {
    try {
      details = JSON.parse(strFromU8(files[format.FILES.snapshotDetails])) || {};
    } catch {
      throw invalidZip();
    }
  }
  const snapshots = [];
  for (const r of csvObjects(files, format.FILES.snapshots, MAX_OTHER_ROWS)) {
    const year = Number(r.year);
    const month = Number(r.month);
    if (!Number.isInteger(year) || year < 1900 || year > 2999 || !Number.isInteger(month) || month < 1 || month > 12) {
      issue(format.FILES.snapshots, r.line, "INVALID_PERIOD");
      continue;
    }
    const period = `${year}-${String(month).padStart(2, "0")}`;
    // Every column that is not year, month or total is a pillar, by code.
    const byPillar = {};
    for (const [k, v] of Object.entries(r)) {
      if (!["line", ...format.SNAPSHOT_COLUMNS].includes(k)) byPillar[k.toUpperCase()] = numberOrNull(v) ?? 0;
    }
    snapshots.push({
      line: r.line,
      year,
      month,
      period,
      total: numberOrNull(r.total) ?? 0,
      byPillar,
      detail: details && typeof details === "object" ? details[period] || null : null,
    });
  }

  return { manifest, accounts, categories, transactions, holdings, snapshots, issues };
};

// ---------------------------------------------------------------------------
// From the request to the model
// ---------------------------------------------------------------------------

const parseRequest = (body) => {
  const buffer = readFile(body);
  const options = readOptions(body.options);

  if (isZip(buffer)) return { format: "bussola-zip", stage: "preview", model: readZip(buffer) };

  const { text: content, encoding } = csv.decode(buffer, options.encoding);
  if (!content.trim()) throw new DataError(400, "IMPORT_EMPTY", "The file is empty");
  // A binary file that is not a ZIP decodes as Windows-1252 without complaint
  // and then parses as one enormous column of noise. NUL characters are the
  // tell: no CSV has them.
  if (content.includes("\u0000")) {
    throw new DataError(400, "IMPORT_UNREADABLE", "This file is not a CSV");
  }

  const separator = options.separator || csv.detectSeparator(content);
  const rows = csv.parse(content, separator);
  if (rows.length === 0) throw new DataError(400, "IMPORT_EMPTY", "The file is empty");

  if (isBussolaHeader(rows[0])) {
    return {
      format: "bussola-csv",
      stage: "preview",
      model: { transactions: bussolaTransactions(rows, separator) },
    };
  }

  if (rows.length - options.skipRows > MAX_TRANSACTIONS + 1) throw tooManyRows(MAX_TRANSACTIONS);

  const { header, data, width, firstLine, headerRow } = resolveBankSettings(rows, options);
  const guess = guessColumns(header, data, width);
  const mapping = options.mapping;
  const valuesOf = (j) => (j === null || j === undefined ? [] : data.slice(0, 200).map((r) => r[j]));
  const amountCols = mapping ? [mapping.amount, mapping.debit, mapping.credit] : [guess.amount, guess.debit, guess.credit];
  const dateCol = mapping ? mapping.date : guess.date;
  const dateGuess = csv.detectDateFormat(valuesOf(dateCol));
  const settings = {
    encoding,
    separator,
    headerRow,
    skipRows: options.skipRows,
    decimal: options.decimal || csv.detectDecimal(amountCols.flatMap(valuesOf)),
    dateFormat: options.dateFormat || dateGuess.format,
  };

  if (!mapping) {
    return {
      format: "bank-csv",
      stage: "mapping",
      settings,
      dateAmbiguous: !options.dateFormat && dateGuess.ambiguous,
      columns: Array.from({ length: width }, (_, j) => (header && header[j] ? header[j] : null)),
      sample: data.slice(0, SAMPLE_ROWS),
      rowCount: data.length,
      guess,
    };
  }

  const hasAmount = mapping.amount !== null || mapping.debit !== null || mapping.credit !== null;
  if (mapping.date === null || !hasAmount || !mapping.account) {
    throw new DataError(400, "IMPORT_MAPPING_INCOMPLETE", "Choose the date column, the amount column(s) and the account");
  }
  for (const j of [mapping.date, mapping.amount, mapping.debit, mapping.credit, mapping.note]) {
    if (j !== null && j >= width) throw badOptions("column out of range");
  }
  for (const n of [mapping.account, mapping.expenseCategory, mapping.incomeCategory]) {
    if (n.length > TEXT_MAX) throw badOptions("name too long");
  }

  return {
    format: "bank-csv",
    stage: "preview",
    settings,
    mapping,
    model: { transactions: bankTransactions(data, firstLine, settings, mapping) },
  };
};

// ---------------------------------------------------------------------------
// Against the wallet
// ---------------------------------------------------------------------------
// Names are matched case-insensitively and trimmed: "groceries " in a file is
// the "Groceries" already in the wallet, not a second category. When a wallet
// holds two accounts with the same name, the older one wins -- deterministic,
// and the preview shows which names were matched.

const key = (value) => String(value || "").trim().toLowerCase();

// What a name has to be for each role: `from` is always an account; `to` is
// an account for a transfer and a category of the transaction's own kind
// otherwise. An expense named after an income category is therefore not a
// match, and would create an expense category of that name.
const kindOf = (type, role) => (role === "from" || type === "TRANSFER" ? "ACCOUNT" : type);

const loadWallet = async () => {
  const { rows: accounts } = await db.query(
    `select a.id, a.name, a.is_account, a.archived, at.code as type_code,
            a.is_account
              and abs(coalesce(a.amount, 0)) < 0.005
              and not exists (select 1 from transactions t where t.from_id = a.id)
              and not exists (select 1 from transactions t where t.to_id = a.id)
              and not exists (select 1 from holdings h where h.account_id = a.id) as virgin
       from accounts a
       join account_types at on (at.id = a.type_id)
      order by a.id`,
  );
  const lookup = async (sql) => (await db.query(sql)).rows;
  const transactionTypes = await lookup(`select id, code from transaction_types where code is not null`);
  const accountTypes = await lookup(`select id, code from account_types where code is not null`);
  const pillars = await lookup(`select id, code from pillars where code is not null`);
  const holdingTypes = await lookup(`select id, code, name from holding_types`);

  const byKind = { ACCOUNT: new Map(), EXPENSE: new Map(), INCOME: new Map() };
  const names = { ACCOUNT: [], EXPENSE: [], INCOME: [] };
  for (const a of accounts) {
    const kind = a.is_account ? "ACCOUNT" : a.type_code;
    if (!byKind[kind]) continue;
    if (!byKind[kind].has(key(a.name))) byKind[kind].set(key(a.name), a);
    if (!a.archived) names[kind].push(a.name);
  }

  const idOf = (rows) => Object.fromEntries(rows.map((r) => [r.code, r.id]));
  return {
    byKind,
    names,
    transactionType: idOf(transactionTypes),
    accountType: idOf(accountTypes),
    pillar: idOf(pillars),
    holdingTypeByCode: new Map(holdingTypes.filter((t) => t.code).map((t) => [t.code, t])),
    holdingTypeByName: new Map(holdingTypes.map((t) => [key(t.name), t])),
  };
};

// Which rows are probably already there. "The same" is the same day, amount,
// from, to and note; nothing in a CSV identifies a transaction better than
// that, so it is a warning and a default rather than a refusal. A row that
// matches the wallet, or an earlier row of the same file, starts unselected.
const dupKey = (r) =>
  `${r.date}|${Number(r.amount).toFixed(6)}|${key(r.from)}|${key(r.to)}|${String(r.note || "").trim()}`;

const markDuplicates = async (rows) => {
  const dated = rows.filter((r) => r.errors.length === 0);
  if (dated.length === 0) return;
  let min = dated[0].date;
  let max = dated[0].date;
  for (const r of dated) {
    if (r.date < min) min = r.date;
    if (r.date > max) max = r.date;
  }
  const { rows: existing } = await db.query(
    `select to_char(t.tx_date, 'YYYY-MM-DD') as date, t.amount,
            f.name as from_name, x.name as to_name, coalesce(t.description, '') as note
       from transactions t
       join accounts f on (f.id = t.from_id)
       join accounts x on (x.id = t.to_id)
      where t.tx_date >= $1::date and t.tx_date < $2::date + 1`,
    [min, max],
  );
  const inWallet = new Set(
    existing.map((e) => dupKey({ date: e.date, amount: e.amount, from: e.from_name, to: e.to_name, note: e.note })),
  );
  const seen = new Set();
  for (const r of dated) {
    const k = dupKey(r);
    if (inWallet.has(k)) r.duplicate = "wallet";
    else if (seen.has(k)) r.duplicate = "file";
    seen.add(k);
  }
};

// Works out what an import would do, without doing any of it: which names
// exist, which would be created, which holdings and snapshots are already
// there. Called by the preview to describe it and by the commit to carry it
// out, so the two cannot describe different imports.
const plan = async (parsed, wallet) => {
  const model = parsed.model;
  const archive = parsed.format === "bussola-zip";
  const creations = new Map();

  const creationKey = (kind, n) => `${kind}|${key(n)}`;
  const exists = (kind, n) => wallet.byKind[kind].has(key(n));
  const want = (kind, n, attrs, fromFile) => {
    if (exists(kind, n)) return false;
    const k = creationKey(kind, n);
    if (!creations.has(k)) creations.set(k, { kind, name: n.trim(), attrs: attrs || {}, fromFile });
    else if (fromFile) creations.get(k).fromFile = true;
    return true;
  };

  // An archive account whose name the wallet already has is reused, and its
  // opening balance is normally ignored: the account has a history of its own
  // here, and the file's transactions are added on top of it. The exception is
  // an account that has never been used -- balance zero, no transaction, no
  // holding -- which is what a new wallet's starter account is. Restoring an
  // archive into a fresh wallet matched the file's "Current account" to it and
  // lost the opening, so every balance came out short by exactly that much.
  // Such an account takes the file's opening balance, as a created one would;
  // `openings` lists them (one per wallet account, the first file row wins),
  // the preview shows them and the commit applies them. The commit plans again
  // inside its own transaction, so "never used" is decided anew there, and the
  // UPDATE checks it once more.
  const reused = [];
  const openings = new Map();
  if (archive) {
    for (const a of model.accounts) {
      if (want("ACCOUNT", a.name, a, true)) continue;
      reused.push(a.name);
      const target = wallet.byKind.ACCOUNT.get(key(a.name));
      if (target && target.virgin && Math.abs(Number(a.opening) || 0) >= 0.005 && !openings.has(target.id)) {
        openings.set(target.id, { id: target.id, name: target.name, opening: Number(a.opening) });
      }
    }
    for (const c of model.categories) if (!want(c.kind, c.name, c, true)) reused.push(c.name);
  }

  for (const r of model.transactions) {
    r.duplicate = null;
    if (r.errors.length) continue;
    r.fromNew = want(kindOf(r.type, "from"), r.from, null, false);
    r.toNew = want(kindOf(r.type, "to"), r.to, null, false);
  }
  await markDuplicates(model.transactions);

  const holdingTypes = new Map();
  const holdings = { toAdd: [], skipped: [], issues: [] };
  const snapshots = { toAdd: [], skipped: [] };
  if (archive) {
    const { rows: present } = await db.query(
      `select a.name as account, h.name, coalesce(h.isin, '') as isin
         from holdings h join accounts a on (a.id = h.account_id)`,
    );
    const presentKeys = new Set(present.map((p) => `${key(p.account)}|${key(p.name)}|${key(p.isin)}`));
    for (const h of model.holdings) {
      const accountKnown = exists("ACCOUNT", h.account) || creations.has(creationKey("ACCOUNT", h.account));
      if (!accountKnown) {
        holdings.issues.push({ file: format.FILES.holdings, line: h.line, code: "UNKNOWN_ACCOUNT" });
        continue;
      }
      if (!wallet.pillar[h.pillar]) {
        holdings.issues.push({ file: format.FILES.holdings, line: h.line, code: "UNKNOWN_PILLAR" });
        continue;
      }
      const hk = `${key(h.account)}|${key(h.name)}|${key(h.isin)}`;
      if (presentKeys.has(hk)) {
        holdings.skipped.push(h.name);
        continue;
      }
      presentKeys.add(hk);
      // A seeded type travels by code. An invented one travels by name, and
      // is created in this wallet if the wallet does not have it yet --
      // invented types belong to a wallet, like its accounts
      // and categories, exactly as when one is added from the holding form.
      if (!(h.type_code && wallet.holdingTypeByCode.has(h.type_code)) && h.type_name) {
        if (!wallet.holdingTypeByName.has(key(h.type_name))) holdingTypes.set(key(h.type_name), h.type_name);
      }
      holdings.toAdd.push(h);
    }

    const { rows: periods } = await db.query(`select year, month from portfolio_snapshots`);
    const taken = new Set(periods.map((p) => `${p.year}-${String(p.month).padStart(2, "0")}`));
    for (const s of model.snapshots) {
      if (taken.has(s.period)) snapshots.skipped.push(s.period);
      else {
        taken.add(s.period);
        snapshots.toAdd.push(s);
      }
    }
  }

  return { creations, reused, openings, holdingTypes, holdings, snapshots };
};

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

const existingNames = (wallet) => ({
  accounts: wallet.names.ACCOUNT,
  expenseCategories: wallet.names.EXPENSE,
  incomeCategories: wallet.names.INCOME,
});

exports.preview = async (req) => {
  const parsed = parseRequest(req.body);
  const wallet = await loadWallet();

  if (parsed.stage === "mapping") {
    const { model, ...rest } = parsed; // eslint-disable-line no-unused-vars
    return { ...rest, existing: existingNames(wallet) };
  }

  const p = await plan(parsed, wallet);
  const rows = parsed.model.transactions.map((r) => ({
    line: r.line,
    date: r.date,
    type: r.type,
    amount: r.amount,
    from: r.from,
    to: r.to,
    note: r.note,
    errors: r.errors,
    duplicate: r.duplicate || null,
    fromNew: Boolean(r.fromNew),
    toNew: Boolean(r.toNew),
    selected: r.errors.length === 0 && !r.duplicate,
  }));

  const count = (test) => rows.filter(test).length;
  const manifest = parsed.model.manifest || null;
  const walletCurrency = req.user.wallet.currency;

  return {
    stage: "preview",
    format: parsed.format,
    settings: parsed.settings || null,
    mapping: parsed.mapping || null,
    manifest: manifest && {
      appVersion: manifest.appVersion || null,
      exportedAt: manifest.exportedAt || null,
      wallet: manifest.wallet || null,
    },
    currency: {
      wallet: walletCurrency,
      file: manifest && manifest.wallet ? manifest.wallet.currency || null : null,
    },
    create: [...p.creations.values()].map((c) => ({ kind: c.kind, name: c.name, always: c.fromFile })),
    reused: p.reused,
    // Reused accounts that were never used and take the file's opening
    // balance (see plan()): [{ name, opening }], empty for most imports.
    openingApplied: [...p.openings.values()].map((o) => ({ name: o.name, opening: o.opening })),
    holdingTypes: [...p.holdingTypes.values()],
    holdings: { add: p.holdings.toAdd.length, skipped: p.holdings.skipped },
    snapshots: { add: p.snapshots.toAdd.length, skipped: p.snapshots.skipped },
    issues: [...(parsed.model.issues || []), ...p.holdings.issues],
    totals: {
      rows: rows.length,
      valid: count((r) => r.errors.length === 0),
      errors: count((r) => r.errors.length > 0),
      duplicates: count((r) => r.duplicate),
    },
    rows,
    existing: existingNames(wallet),
  };
};

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------
// One database transaction, the one withWalletWrite opened: if any statement
// fails, nothing of the import remains -- no half the accounts, no
// transactions without their balances. The writes are a handful of statements
// whatever the size of the file: the rows travel as arrays and unnest() turns
// them back into rows inside Postgres, so ten thousand transactions are one
// INSERT and one UPDATE, not twenty thousand round trips.

const applyOverrides = (parsed, overrides, wallet) => {
  if (overrides.size === 0) return;
  const byLine = new Map(parsed.model.transactions.map((r) => [r.line, r]));
  const defaults = parsed.mapping
    ? { EXPENSE: key(parsed.mapping.expenseCategory), INCOME: key(parsed.mapping.incomeCategory) }
    : {};
  for (const [line, category] of overrides) {
    const row = byLine.get(line);
    if (!row || (row.type !== "EXPENSE" && row.type !== "INCOME")) throw badOptions("override on a row that has no category");
    // Only a category that already exists, or the default one this import
    // creates anyway: an override is a choice from a list, not a way to invent
    // names row by row.
    const known = wallet.byKind[row.type].has(key(category)) || defaults[row.type] === key(category);
    if (!known) {
      throw new DataError(400, "IMPORT_UNKNOWN_CATEGORY", `There is no ${row.type.toLowerCase()} category called "${category}"`);
    }
    row.to = category;
  }
};

const insertAccounts = async (list, wallet) => {
  if (list.length === 0) return [];
  const cols = { n: [], c: [], i: [], f: [], amt: [], tid: [], d: [], isacc: [], cur: [], inv: [], arch: [] };
  for (const item of list) {
    const a = item.attrs;
    const look = DEFAULT_LOOK[item.kind];
    const isAccount = item.kind === "ACCOUNT";
    cols.n.push(item.name);
    cols.c.push(a.color || look.color);
    cols.i.push(a.icon || look.icon);
    cols.f.push(a.icon_family || look.icon_family);
    // An account starts on its opening balance (zero when the file does not
    // say); a category has no balance at all, as when it is created by hand.
    cols.amt.push(isAccount ? a.opening ?? 0 : null);
    cols.tid.push(wallet.accountType[isAccount ? "STANDARD_ACCOUNT" : item.kind]);
    cols.d.push(a.description || null);
    cols.isacc.push(isAccount);
    cols.cur.push(a.is_current === undefined ? true : a.is_current);
    cols.inv.push(Boolean(a.is_investment));
    cols.arch.push(Boolean(a.archived));
  }
  // actual_amount starts equal to amount, as createAccount does. The
  // transactions below reset it to NULL on the accounts they touch, and the
  // holdings recompute it on the accounts that have some -- the same two
  // rules the rest of the application follows.
  const { rows } = await db.query(
    `insert into accounts
       (id, name, color, icon, icon_family, amount, type_id, description, is_account,
        actual_amount, is_current, is_investment, archived)
     select nextval('seq_accounts'), u.n, u.c, u.i, u.f, u.amt, u.tid, u.d, u.isacc,
            u.amt, u.cur, u.inv, u.arch
       from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::numeric[], $6::int[],
                   $7::text[], $8::bool[], $9::bool[], $10::bool[], $11::bool[])
            as u(n, c, i, f, amt, tid, d, isacc, cur, inv, arch)
     returning id, name, is_account, type_id`,
    [cols.n, cols.c, cols.i, cols.f, cols.amt, cols.tid, cols.d, cols.isacc, cols.cur, cols.inv, cols.arch],
  );
  return rows;
};

exports.commit = async (req) => {
  const parsed = parseRequest(req.body);
  if (parsed.stage !== "preview") {
    throw new DataError(400, "IMPORT_MAPPING_INCOMPLETE", "Choose the date column, the amount column(s) and the account");
  }
  const selection = readSelection(req.body.selection);
  const wallet = await loadWallet();
  applyOverrides(parsed, selection.overrides, wallet);
  const p = await plan(parsed, wallet);
  const archive = parsed.format === "bussola-zip";

  const chosen = parsed.model.transactions.filter((r) => selection.lines.has(r.line));
  const invalid = chosen.filter((r) => r.errors.length > 0);
  if (invalid.length > 0) {
    const lines = invalid.slice(0, 20).map((r) => r.line);
    throw new DataError(400, "IMPORT_INVALID_ROWS", `Some selected rows are not valid (lines ${lines.join(", ")})`, {
      lines: lines.join(", "),
    });
  }
  if (chosen.length === 0 && !archive) {
    throw new DataError(400, "IMPORT_NOTHING_SELECTED", "No row was selected");
  }

  // Only what the chosen rows need is created -- plus, for an archive,
  // everything its accounts and categories files list, which is the point of
  // importing a whole wallet.
  const needed = new Set();
  for (const r of chosen) {
    needed.add(`${kindOf(r.type, "from")}|${key(r.from)}`);
    needed.add(`${kindOf(r.type, "to")}|${key(r.to)}`);
  }
  const toCreate = [...p.creations.entries()].filter(([k, c]) => c.fromFile || needed.has(k)).map(([, c]) => c);

  // --- holding types (into this wallet: the column defaults to it) ----------
  const holdingTypeIds = new Map();
  for (const typeName of p.holdingTypes.values()) {
    const { rows } = await db.query(
      `insert into holding_types (id, name, color) values (nextval('seq_holding_types'), $1, null) returning id`,
      [typeName],
    );
    holdingTypeIds.set(key(typeName), rows[0].id);
  }

  // --- accounts and categories ----------------------------------------------
  const created = await insertAccounts(toCreate, wallet);
  const kindOfTypeId = Object.fromEntries(Object.entries(wallet.accountType).map(([code, id]) => [id, code]));
  const idByKind = { ACCOUNT: new Map(), EXPENSE: new Map(), INCOME: new Map() };
  for (const [kind, map] of Object.entries(wallet.byKind)) for (const [k, a] of map) idByKind[kind].set(k, a.id);
  for (const a of created) {
    const kind = a.is_account ? "ACCOUNT" : kindOfTypeId[a.type_id];
    idByKind[kind].set(key(a.name), a.id);
  }
  const idFor = (kind, n) => {
    const id = idByKind[kind].get(key(n));
    if (!id) throw new Error(`Import could not resolve ${kind} "${n}"`);
    return id;
  };

  // --- opening balances of reused, never-used accounts (see plan()) ---------
  // Before the transactions, which then move the balance from there, exactly
  // as for an account the import creates. The condition is checked again by
  // the statement itself; an account that was used in the meantime keeps its
  // balance.
  let openingsApplied = 0;
  if (p.openings.size > 0) {
    const list = [...p.openings.values()];
    const res = await db.query(
      `update accounts a
          set amount = u.opening,
              actual_amount = case when a.is_investment then a.actual_amount else u.opening end
         from unnest($1::int[], $2::numeric[]) as u(id, opening)
        where a.id = u.id
          and a.is_account
          and abs(coalesce(a.amount, 0)) < 0.005
          and not exists (select 1 from transactions t where t.from_id = a.id)
          and not exists (select 1 from transactions t where t.to_id = a.id)
          and not exists (select 1 from holdings h where h.account_id = a.id)`,
      [list.map((o) => o.id), list.map((o) => o.opening)],
    );
    openingsApplied = res.rowCount;
  }

  // --- transactions, and what they do to the balances -----------------------
  const tx = { from: [], to: [], amount: [], type: [], note: [], date: [] };
  const deltas = new Map();
  for (const r of chosen) {
    const row = {
      from_id: idFor(kindOf(r.type, "from"), r.from),
      to_id: idFor(kindOf(r.type, "to"), r.to),
      amount: r.amount,
      // By code, never by a hard-coded id. The ids balanceEffects() compares
      // against are the ones the rest of the controllers assume (1, 2, 3):
      // they are the seeded rows of migrations/001_schema.sql.
      type_id: wallet.transactionType[r.type],
    };
    tx.from.push(row.from_id);
    tx.to.push(row.to_id);
    tx.amount.push(row.amount);
    tx.type.push(row.type_id);
    tx.note.push(r.note || "");
    tx.date.push(r.date);
    for (const { accountId, delta } of balanceEffects(row)) {
      deltas.set(accountId, (deltas.get(accountId) || 0) + delta);
    }
  }

  if (chosen.length > 0) {
    await db.query(
      `insert into transactions (id, from_id, to_id, amount, type_id, description, tx_date)
       select nextval('seq_transactions'), u.f, u.t, u.a, u.ty, u.d, u.dt::timestamp
         from unnest($1::int[], $2::int[], $3::numeric[], $4::int[], $5::text[], $6::text[])
              as u(f, t, a, ty, d, dt)`,
      [tx.from, tx.to, tx.amount, tx.type, tx.note, tx.date],
    );

    // The same statement applyTransactionQueries issues -- amount moved by the
    // effect, actual_amount following the same rule (ACTUAL_AFTER_MOVE: reset
    // for an ordinary account, the holdings' value kept for an investment
    // one) -- applied once per account with the sum of the effects instead of
    // once per row.
    await db.query(
      `update accounts a
          set amount = a.amount + u.delta, actual_amount = ${ACTUAL_AFTER_MOVE}
         from unnest($1::int[], $2::numeric[]) as u(id, delta)
        where a.id = u.id`,
      [[...deltas.keys()], [...deltas.values()]],
    );
    // And the same exception: an investment account with one hand-valued
    // holding has it reset to the new balance (resetManualActualQuery). An
    // archive's holdings come after this and set their own value.
    const reset = resetManualActualQuery([...deltas.keys()]);
    await db.query(reset.text, reset.params);
  }

  // --- holdings -------------------------------------------------------------
  const holdingAccounts = new Set();
  for (const h of archive ? p.holdings.toAdd : []) {
    const accountId = idFor("ACCOUNT", h.account);
    const typeId =
      (h.type_code && wallet.holdingTypeByCode.has(h.type_code) && wallet.holdingTypeByCode.get(h.type_code).id) ||
      (h.type_name && (wallet.holdingTypeByName.get(key(h.type_name))?.id || holdingTypeIds.get(key(h.type_name)))) ||
      null;
    await db.query(
      `insert into holdings
         (id, account_id, name, pillar_id, amount, description, type_id, issuer, country, currency, isin,
          quantity, purchase_price, purchase_date, current_price, auto_update)
       values (nextval('seq_holdings'), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
      [
        accountId,
        h.name,
        wallet.pillar[h.pillar],
        h.amount,
        h.description,
        typeId,
        h.issuer,
        h.country,
        h.currency,
        h.isin,
        h.quantity,
        h.purchase_price,
        h.purchase_date,
        h.current_price,
        h.auto_update,
      ],
    );
    holdingAccounts.add(accountId);
  }
  // The actual balance of an account with holdings is their sum: the rule
  // holdings_controller applies after every change to one of them.
  if (holdingAccounts.size > 0) {
    await db.query(
      `update accounts
          set actual_amount = (select coalesce(sum(h.amount), 0) from holdings h where h.account_id = accounts.id)
        where id = any($1::int[])`,
      [[...holdingAccounts]],
    );
  }

  // --- snapshots ------------------------------------------------------------
  // value_pN is the pillar with id N; the file names pillars by code.
  let snapshotsAdded = 0;
  const pillarIdByCode = wallet.pillar;
  for (const s of archive ? p.snapshots.toAdd : []) {
    const values = [0, 0, 0, 0];
    for (const [code, v] of Object.entries(s.byPillar)) {
      const id = pillarIdByCode[code];
      if (id >= 1 && id <= 4) values[id - 1] = v;
    }
    const res = await db.query(
      `insert into portfolio_snapshots (id, year, month, total, value_p1, value_p2, value_p3, value_p4, detail)
       values (nextval('seq_portfolio_snapshots'), $1, $2, $3, $4, $5, $6, $7, $8)
       on conflict (wallet_id, year, month) do nothing`,
      [s.year, s.month, s.total, ...values, s.detail],
    );
    snapshotsAdded += res.rowCount;
  }

  return {
    transactions: chosen.length,
    accounts: toCreate.filter((c) => c.kind === "ACCOUNT").length,
    categories: toCreate.filter((c) => c.kind !== "ACCOUNT").length,
    openingsApplied,
    holdingTypes: p.holdingTypes.size,
    holdings: holdingAccounts.size > 0 ? p.holdings.toAdd.length : 0,
    snapshots: snapshotsAdded,
  };
};

exports.limits = { MB, MAX_FILE_BYTES, MAX_TRANSACTIONS };
