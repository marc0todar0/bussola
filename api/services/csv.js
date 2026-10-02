// ---------------------------------------------------------------------------
// CSV, in and out
// ---------------------------------------------------------------------------
// No dependency: RFC 4180 is a page long, and what makes CSV hard is not the
// quoting but everything around it -- which character set the bank used, which
// separator, whether 1.234 is a thousand or one and a bit, whether 03/04 is
// March or April. Those are decisions a library cannot make for us anyway, so
// they are made here, in the open, and reported back to the person importing
// so that they can overrule them.
//
// What this module does NOT do is touch the database: it turns bytes into
// rows of strings and strings into numbers and dates. Deciding what a row
// means is the import controller's job.

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// Excel opens a UTF-8 file as Windows-1252 unless it starts with a byte order
// mark, and then every accented category name comes out as mojibake.
// LibreOffice does not need it and does not mind it.
const BOM = "\uFEFF";

// CRLF because RFC 4180 says so, and because it is what Excel writes itself.
const EOL = "\r\n";

// Formula injection: a cell that starts with = + - @ (or a tab or carriage
// return, which some spreadsheets skip before looking) is evaluated as a
// formula by Excel and LibreOffice. A note typed as "=HYPERLINK(...)" would
// become a live link in whoever opens the export. The standard mitigation is
// a leading apostrophe, which the spreadsheet swallows and displays nothing
// for.
//
// The rule is applied to *text* cells only. Amounts are written as plain
// numbers and never prefixed: "-12.5" in a numeric column is a number to a
// spreadsheet, not a formula, and an apostrophe there would turn every amount
// into text that no longer sums.
//
// Apostrophes already at the front are counted in, which is what makes the
// escape reversible: "'=x" is written as "''=x" and read back as "'=x", while
// "=x" is written as "'=x" and read back as "=x". Without that, an export
// followed by an import would eat the apostrophe of a note that happened to
// start with one.
const FORMULA_START = /^'*[=+\-@\t\r]/;
const ESCAPED_FORMULA = /^'+[=+\-@\t\r]/;

const protectText = (text) => (FORMULA_START.test(text) ? `'${text}` : text);
const unprotectText = (text) => (ESCAPED_FORMULA.test(text) ? text.slice(1) : text);

// Quoted only when it has to be: a separator, a quote, a line break, or
// leading/trailing blanks that a spreadsheet would otherwise trim.
const quote = (text) =>
  /[",;\t\r\n]/.test(text) || /^\s|\s$/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;

const textCell = (value) => (value == null ? "" : quote(protectText(String(value))));

// Numbers in their shortest round-tripping form ("12.5", not "12.50000"),
// with a dot for a decimal mark whatever the reader's language: this is a data
// file, and the interface's 1.234,56 would make it unreadable to a machine.
// Exponent notation is avoided for the tiny values it would otherwise produce
// (a crypto quantity of 0.00000012), because not every spreadsheet reads 1.2e-7.
const numberCell = (value) => {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  if (n !== 0 && Math.abs(n) < 1e-6) return n.toFixed(12).replace(/0+$/, "");
  return String(n);
};

// A balance used to be a running sum of doubles, and came back as
// 1234.5599999999. Stored in exact cents (numeric) now, it no longer does --
// but a balance computed here (the opening balance: balance minus the
// transactions' effect) still goes through a double subtraction.
// Rounded to eight decimals it reads as what it is, and nothing a currency
// can express is lost.
const moneyCell = (value) => {
  if (value == null || value === "") return "";
  const n = Number(value);
  return Number.isFinite(n) ? numberCell(Math.round(n * 1e8) / 1e8) : "";
};

const boolCell = (value) => (value ? "true" : "false");

const line = (cells) => cells.join(",") + EOL;

// ---------------------------------------------------------------------------
// Reading: bytes to text
// ---------------------------------------------------------------------------

// UTF-8 when the bytes are valid UTF-8, Windows-1252 otherwise: that is what
// European banks still hand out, and a Latin-1 "è" is an invalid UTF-8
// sequence, so the strict decoder is a reliable test. The choice is reported
// back and can be forced, because a file can be valid in both and mean
// different things.
const ENCODINGS = ["utf-8", "windows-1252"];

const decode = (buffer, encoding = "auto") => {
  let used = encoding;
  let text;
  if (encoding === "auto" || !ENCODINGS.includes(encoding)) {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      used = "utf-8";
    } catch {
      text = new TextDecoder("windows-1252").decode(buffer);
      used = "windows-1252";
    }
  } else {
    text = new TextDecoder(encoding).decode(buffer);
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  return { text, encoding: used };
};

// ---------------------------------------------------------------------------
// Reading: text to rows
// ---------------------------------------------------------------------------

// A plain state machine: inside quotes a separator or a line break is data,
// and "" is a quote. It accepts CRLF, LF and a lone CR, since all three turn up
// in bank exports. Blank lines are dropped: they are never a transaction.
const parse = (text, separator = ",") => {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  let i = 0;
  const n = text.length;

  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    if (row.length > 1 || row[0] !== "") rows.push(row);
    row = [];
  };

  while (i < n) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
      } else {
        cell += c;
      }
      i += 1;
      continue;
    }
    if (c === '"' && cell === "") inQuotes = true;
    else if (c === separator) endCell();
    else if (c === "\r") {
      endRow();
      if (text[i + 1] === "\n") i += 1;
    } else if (c === "\n") endRow();
    else cell += c;
    i += 1;
  }
  if (cell !== "" || row.length > 0) endRow();
  return rows;
};

// The separator is guessed from the first lines: the candidate that splits
// them into the same number of columns most consistently wins. Quoted text is
// skipped, so a comma inside a description does not vote.
const SEPARATORS = [",", ";", "\t"];

const countOutsideQuotes = (lineText, sep) => {
  let count = 0;
  let quoted = false;
  for (const c of lineText) {
    if (c === '"') quoted = !quoted;
    else if (c === sep && !quoted) count += 1;
  }
  return count;
};

const detectSeparator = (text) => {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== "").slice(0, 30);
  let best = { sep: ",", score: -1, width: 0 };
  for (const sep of SEPARATORS) {
    const counts = lines.map((l) => countOutsideQuotes(l, sep));
    const freq = new Map();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) || 0) + 1);
    let width = 0;
    let score = 0;
    for (const [c, f] of freq) {
      if (f > score || (f === score && c > width)) {
        width = c;
        score = f;
      }
    }
    if (score > best.score || (score === best.score && width > best.width)) best = { sep, score, width };
  }
  return best.sep;
};

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------

// Bussola's own files: a dot, an optional sign, nothing else. Strict on
// purpose -- a file that claims to be ours and is not is better refused row by
// row than half understood.
const parseDotNumber = (raw) => {
  const s = String(raw == null ? "" : raw).trim();
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

// Which mark is the decimal one in a bank's amount column. Votes are cast by
// values that settle it on their own: "12,50" or "1.234,5" say comma, "12.50"
// or "1,234.5" say dot. "1.234" says nothing -- it is a thousand in Germany
// and one and a quarter in England -- and does not vote.
const decimalOf = (value) => {
  const s = String(value).replace(/[^\d.,]/g, "");
  const lastComma = s.lastIndexOf(",");
  const lastDot = s.lastIndexOf(".");
  if (lastComma === -1 && lastDot === -1) return null;
  const last = Math.max(lastComma, lastDot);
  const digitsAfter = s.length - last - 1;
  if (lastComma !== -1 && lastDot !== -1) return lastComma > lastDot ? "," : ".";
  if (digitsAfter === 3) return null;
  return lastComma !== -1 ? "," : ".";
};

const detectDecimal = (values) => {
  let comma = 0;
  let dot = 0;
  for (const v of values) {
    const d = decimalOf(v);
    if (d === ",") comma += 1;
    else if (d === ".") dot += 1;
  }
  return comma > dot ? "," : ".";
};

// A bank's amount: "1.234,56", "-12.50", "12,50 €", "EUR -3.00", "(45.00)",
// "12.50-", "1'234.50". Currency symbols, codes and blanks go; parentheses and
// a trailing minus are the accountant's ways of writing a negative number.
const parseAmount = (raw, decimal = ".") => {
  let s = String(raw == null ? "" : raw).trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[\s\u00a0\u202f']/g, "").replace(/[^\d,.+-]/g, "");
  if (s.endsWith("-")) {
    negative = !negative;
    s = s.slice(0, -1);
  } else if (s.endsWith("+")) s = s.slice(0, -1);
  if (s.startsWith("-")) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.startsWith("+")) s = s.slice(1);

  s = decimal === "," ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
};

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------
// Three orders and any separator: 2026-09-30, 30/09/2026, 09.30.26,
// 20260930. A four-digit first group is a year whatever the setting says,
// because no day or month has four digits. Anything after the date (a time,
// a zone) is ignored: Bussola keeps days.
const DATE_FORMATS = ["YMD", "DMY", "MDY"];

const pad = (n) => String(n).padStart(2, "0");

const validDate = (y, m, d) => {
  if (y < 1900 || y > 2999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
};

const fullYear = (y) => (y.length <= 2 ? 2000 + Number(y) - (Number(y) >= 70 ? 100 : 0) : Number(y));

const dateGroups = (raw) => {
  const s = String(raw == null ? "" : raw).trim();
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})(?!\d)/);
  if (compact) return { groups: [compact[1], compact[2], compact[3]], compact: true };
  const m = s.match(/^(\d{1,4})[/.\-\s](\d{1,2})[/.\-\s](\d{1,4})(?!\d)/);
  return m ? { groups: [m[1], m[2], m[3]], compact: false } : null;
};

const parseDate = (raw, format = "YMD") => {
  const found = dateGroups(raw);
  if (!found) return null;
  const [a, b, c] = found.groups;
  if (found.compact || a.length === 4) return validDate(Number(a), Number(b), Number(c));
  if (format === "MDY") return validDate(fullYear(c), Number(a), Number(b));
  if (format === "DMY") return validDate(fullYear(c), Number(b), Number(a));
  return validDate(fullYear(a), Number(b), Number(c));
};

// The order is guessed from the values: a first group above 12 can only be a
// day, a second group above 12 can only be a day in the American order. When
// nothing settles it -- every date in the file falls on the 1st to the 12th --
// the answer is day/month/year and it is reported as ambiguous, so that the
// wizard puts the question in front of the person who knows.
const detectDateFormat = (values) => {
  let firstBig = 0;
  let secondBig = 0;
  let yearFirst = 0;
  let seen = 0;
  for (const v of values) {
    const found = dateGroups(v);
    if (!found) continue;
    seen += 1;
    const [a, b] = found.groups;
    if (found.compact || a.length === 4) yearFirst += 1;
    else if (Number(a) > 12) firstBig += 1;
    else if (Number(b) > 12) secondBig += 1;
  }
  if (yearFirst > 0 && yearFirst >= seen / 2) return { format: "YMD", ambiguous: false };
  if (firstBig > 0 && secondBig === 0) return { format: "DMY", ambiguous: false };
  if (secondBig > 0 && firstBig === 0) return { format: "MDY", ambiguous: false };
  return { format: "DMY", ambiguous: seen > 0 };
};

const looksLikeDate = (value) => dateGroups(value) !== null;

module.exports = {
  BOM,
  EOL,
  textCell,
  numberCell,
  moneyCell,
  boolCell,
  line,
  protectText,
  unprotectText,
  ENCODINGS,
  decode,
  parse,
  SEPARATORS,
  detectSeparator,
  parseDotNumber,
  detectDecimal,
  parseAmount,
  DATE_FORMATS,
  parseDate,
  detectDateFormat,
  looksLikeDate,
};
