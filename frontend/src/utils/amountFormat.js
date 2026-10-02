// ---------------------------------------------------------------------------
// Formatting an amount, in the reader's language and the wallet's currency
// ---------------------------------------------------------------------------
// 1,234.56 in English is 1.234,56 in German and Italian and 1 234,56 in
// French. Intl knows all of that; the grouping used to be a hand-written
// regular expression that produced the English form for everybody.
//
// The currency is the second half of the same problem, and it was worse: a
// literal "€" was concatenated after the digits in eight different files. That
// is wrong for anyone whose money is not in euro, and wrong for the placement
// even when it is not -- $1,234.56 puts the symbol in front in English while
// 1.234,56 € puts it behind in Italian, and 1 234,56 $CA is what Canadian
// French does with dollars. Nobody should be deciding that by hand. Intl's
// currency style knows the whole matrix; it is asked, and its answer is used.
//
// Two module variables rather than the React context, for the same reason:
// most callers are not components. The chart libraries format their own axis
// and tooltip labels through plain callbacks, with no way to reach a hook.
// I18nProvider keeps both in step with what is on screen, and until it has
// mounted the browser's own language and the euro are better guesses than
// nothing.
let locale = typeof navigator !== "undefined" ? navigator.language : "en";
let currency = "EUR";

export const setAmountLocale = (code) => {
  if (code) locale = code;
};

// The wallet's currency, not the reader's: two members of one wallet look at
// the same rows, so they have to see the same unit. Only the words around the
// numbers follow the person.
export const setAmountCurrency = (code) => {
  if (code) currency = String(code).toUpperCase();
};

// How many decimals the currency has: two for the euro and the dollar, none
// for the yen or the won, three for the Kuwaiti dinar. Intl knows (ISO 4217's
// minor unit); forcing two on everybody printed "1.234,00 JPY" for money that
// has no cents. The digits without a symbol follow the wallet's currency too,
// since they sit on the same screen as the amounts with one.
const digitsCache = new Map();

const fractionDigits = (cur) => {
  if (!cur) return 2;
  let d = digitsCache.get(cur);
  if (d === undefined) {
    try {
      d = new Intl.NumberFormat("en", { style: "currency", currency: cur }).resolvedOptions()
        .maximumFractionDigits;
    } catch {
      d = 2;
    }
    digitsCache.set(cur, d);
  }
  return d;
};

// `formatters` is a cache: building an Intl.NumberFormat is the expensive part,
// and a table of a few hundred rows formats a few hundred amounts. The key is
// the triple, because the same language with a different currency is a
// different formatter, and so are the bare digits of a different currency.
const formatters = new Map();

const formatterFor = (code, cur, digitsOf = cur) => {
  const key = `${code}|${cur || ""}|${digitsOf || ""}`;
  let f = formatters.get(key);
  if (!f) {
    const digits = fractionDigits(digitsOf);
    const options = { minimumFractionDigits: digits, maximumFractionDigits: digits };
    try {
      f = cur
        ? new Intl.NumberFormat(code, { ...options, style: "currency", currency: cur })
        : new Intl.NumberFormat(code, options);
    } catch {
      // An unknown currency code makes Intl throw, and an amount that fails to
      // render is worse than one that renders without its symbol. It can only
      // happen if a row in the database names a code the browser does not
      // know, which the API's allow-list is there to prevent.
      f = new Intl.NumberFormat(code, options);
    }
    formatters.set(key, f);
  }
  return f;
};

// The same number with as few characters as the language will allow: "20K" in
// English, "20 mil" in Spanish, "2万" in Chinese, "20.000" in German, which
// does not abbreviate below a million. It is for axis labels, where the full
// 20,000.00 costs a quarter of the width of a phone and says nothing the tick
// above it did not. Never for an amount somebody has to read exactly, and
// never with a symbol: the axis has one unit and repeating it four times down
// the side of a chart is noise.
const compactFormatters = new Map();

export const compactAmount = (value, code = locale) => {
  let f = compactFormatters.get(code);
  if (!f) {
    f = new Intl.NumberFormat(code, { notation: "compact", maximumFractionDigits: 1 });
    compactFormatters.set(code, f);
  }
  const n = Number(value);
  return f.format(Number.isFinite(n) ? n : 0);
};

// Anything below half the smallest unit is zero -- half a cent, half a yen:
// it keeps "-0.00" (or "-0") off the screen, which is what a rounded-away
// remainder would otherwise look like.
const normalise = (value, cur) => {
  const n = Number(value);
  return !Number.isFinite(n) || Math.abs(n) < 0.5 * 10 ** -fractionDigits(cur) ? 0 : n;
};

// An amount with its currency, placed where the language puts it.
export const currencyFormat = (value, code = locale, cur = currency) =>
  formatterFor(code, cur).format(normalise(value, cur));

// The same digits with no symbol at all, for the places where the unit is
// already established and repeating it would only take room: an operand in the
// middle of the calculator's expression, an axis tick.
export const plainAmount = (value, code = locale) =>
  formatterFor(code, null, currency).format(normalise(value, currency));

// Just the symbol, for the few labels that name the unit instead of printing
// an amount in it -- a chart's axis title, "Value (€)". Asked of Intl rather
// than kept in a table of our own: the symbol a language uses for a currency
// is not a constant, and en-CA writes $ where fr-CA writes $CA for the very
// same money.
//
// It falls back to the code itself, which is never wrong, only terser than a
// symbol would have been.
export const currencySymbol = (code = locale, cur = currency) => {
  try {
    const part = formatterFor(code, cur)
      .formatToParts(0)
      .find((p) => p.type === "currency");
    return part ? part.value : cur;
  } catch {
    return cur;
  }
};

export default currencyFormat;
