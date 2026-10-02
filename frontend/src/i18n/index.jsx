// ---------------------------------------------------------------------------
// Interface language
// ---------------------------------------------------------------------------
// The whole codebase is English; only what the reader sees is translated. A
// catalogue is a flat map of dotted keys to strings, so a missing key is a
// visible, greppable string rather than a crash.
//
// Where the language comes from, in order:
//   1. the choice stored on the account (users.locale), which follows the
//      person to any browser they sign in from;
//   2. what they last picked in this browser, for the login screen, which is
//      rendered before anyone knows who they are;
//   3. the browser's own language;
//   4. English.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  currencyFormat,
  currencySymbol,
  plainAmount,
  setAmountCurrency,
  setAmountLocale,
} from "../utils/amountFormat";
import en from "./en.json";

// Each language is named in itself: somebody looking for their own language
// scans for the word they would use, not for its English name.
//
// The flag is decoration and nothing more. A flag is a country, not a
// language -- Spanish is not Spain to most of the people who speak it, and the
// same goes for English, French, German and Chinese -- so the name is what
// carries the meaning here and the flag only helps the eye find the row.
export const LANGUAGES = {
  en: { name: "English", flag: "🇬🇧" },
  it: { name: "Italiano", flag: "🇮🇹" },
  fr: { name: "Français", flag: "🇫🇷" },
  de: { name: "Deutsch", flag: "🇩🇪" },
  es: { name: "Español", flag: "🇪🇸" },
  zh: { name: "中文", flag: "🇨🇳" },
};

const FALLBACK = "en";
const STORAGE_KEY = "bussola.language";

// Only the language on screen is downloaded. English is in the bundle because
// it is the fallback for a key a translation lacks; each other catalogue is its
// own chunk, fetched the first time somebody picks it and kept from then on.
const CATALOGUES = { en };
const LOADERS = {
  it: () => import("./it.json"),
  fr: () => import("./fr.json"),
  de: () => import("./de.json"),
  es: () => import("./es.json"),
  zh: () => import("./zh.json"),
};

const supported = (code) => {
  const short = String(code || "").slice(0, 2).toLowerCase();
  return LANGUAGES[short] ? short : null;
};

// Resolves once `code`'s catalogue is in memory. It never rejects: a chunk
// that fails to arrive (a deploy replaced it, the network dropped) leaves the
// interface in English, which is what t() falls back to anyway.
export const loadCatalogue = async (code) => {
  const lang = supported(code) || FALLBACK;
  if (!CATALOGUES[lang]) {
    try {
      CATALOGUES[lang] = (await LOADERS[lang]()).default;
    } catch (error) {
      console.warn(`[i18n] could not load the ${lang} catalogue:`, error);
    }
  }
  return lang;
};

const readStored = () => {
  try {
    return supported(localStorage.getItem(STORAGE_KEY));
  } catch {
    return null; // private mode, blocked storage: not a reason to fail
  }
};

const writeStored = (code) => {
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* the choice still applies for this session */
  }
};

// Exported for main.jsx, which loads this language's catalogue before the
// first render so that the first frame is already translated.
export const detect = () => readStored() || supported(navigator.language) || FALLBACK;

// {count} and friends: enough interpolation for an interface, no dependency.
const interpolate = (text, vars) =>
  vars ? text.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m)) : text;

const I18nContext = createContext(null);

// `currency` is the wallet's, not the reader's, and it arrives here rather
// than through a context of its own because it travels with the amounts: the
// same formatter needs both halves, and one provider keeping them in step is
// one fewer way for them to drift. Before a wallet is open -- the login screen,
// the picker -- there is no currency and the euro stands in; nothing on those
// screens shows an amount.
const DEFAULT_CURRENCY = "EUR";

export const I18nProvider = ({ children, locale, currency, onChange }) => {
  const [language, setLanguage] = useState(detect);
  const money = (currency || DEFAULT_CURRENCY).toUpperCase();

  // A language is switched to only once its catalogue has arrived, so t()
  // stays synchronous and no frame shows raw keys. The last one asked for
  // wins: picking German and then French quickly must not end in German
  // because its chunk happened to arrive second.
  const wanted = useRef(language);
  const switchTo = useCallback((next) => {
    wanted.current = next;
    loadCatalogue(next).then(() => {
      if (wanted.current !== next) return;
      setLanguage(next);
      writeStored(next);
    });
  }, []);

  // The account's stored language wins as soon as we know who is signed in.
  useEffect(() => {
    const fromAccount = supported(locale);
    if (fromAccount && fromAccount !== wanted.current) switchTo(fromAccount);
  }, [locale, switchTo]);

  // Bound during render, deliberately: an effect runs after the children have
  // rendered, so on a language change they would format the amounts with the
  // previous locale and nothing would re-render to correct them. The
  // assignment is idempotent, which is what makes it safe here. The currency
  // is bound in the same breath and for the same reason -- switching wallet
  // changes it, and the chart callbacks have no other way to hear about it.
  setAmountLocale(language);
  setAmountCurrency(money);

  useEffect(() => {
    document.documentElement.lang = language;
  }, [language]);

  const change = useCallback(
    (code) => {
      const next = supported(code) || FALLBACK;
      switchTo(next);
      if (onChange) onChange(next); // persist it on the account, best effort
    },
    [onChange, switchTo],
  );

  const value = useMemo(() => {
    const catalogue = CATALOGUES[language] || CATALOGUES[FALLBACK];

    const t = (key, vars) => {
      const text = catalogue[key] ?? CATALOGUES[FALLBACK][key];
      if (text === undefined) {
        console.warn(`[i18n] missing key: ${key}`);
        return key;
      }
      return interpolate(text, vars);
    };

    // A lookup row (a pillar, a holding type, a transaction type) carries a
    // stable code for the seeded taxonomy and nothing but a name for the rows
    // a user invented. Translate the first, show the second as typed, and name
    // an empty value in the reader's language.
    const tLookup = (row) => {
      if (!row) return t("common.unspecified");
      if (row.code) return t(`lookup.${row.code}`);
      return row.name ?? t("common.unspecified");
    };

    return { language, setLanguage: change, currency: money, t, tLookup, ...formatters(language, money) };
  }, [language, money, change]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
};

// Dates, months and weekday names come from Intl rather than from the
// catalogue: the browser already knows them in every language, and a list of
// month names copied into a translation file is a list that goes stale.
const formatters = (language, currency) => {
  const monthName = (month, style = "long") => {
    const n = Number(month);
    if (!Number.isFinite(n) || n < 1 || n > 12) return "";
    return new Intl.DateTimeFormat(language, { month: style }).format(new Date(2000, n - 1, 1));
  };

  const weekdayName = (date, style = "long") =>
    new Intl.DateTimeFormat(language, { weekday: style }).format(date);

  const formatDate = (date, options = { dateStyle: "medium" }) =>
    new Intl.DateTimeFormat(language, options).format(date);

  // Amounts are grouped and pointed the way the language does it: 1,234.56 in
  // English is 1.234,56 in German or Italian. The formatting itself lives in
  // utils/amountFormat and is only bound to the language and the currency
  // here, so that components and the chart callbacks cannot drift apart.
  //
  // The symbol comes with it, and where it goes is Intl's business: $1,234.56
  // in English, 1.234,56 € in Italian. It used to be a "€" glued to the end of
  // the number regardless of either.
  const formatAmount = (value) => currencyFormat(value, language, currency);

  // The same digits with no symbol, for the places where the unit is already
  // established and saying it again only costs room.
  const formatPlainAmount = (value) => plainAmount(value, language);

  // The symbol on its own, for a label that names the unit rather than
  // printing an amount in it. It is a string for interpolation, so the
  // catalogues can put it where their language wants it instead of having
  // "(€)" written into the translation -- which is what they used to do.
  const moneySymbol = () => currencySymbol(language, currency);

  // A return sits next to an amount on the same row, so it follows the same
  // decimal mark: +3,45% beside 1.234,56 €, never +3.45% beside it. The sign
  // is explicit because a return without one reads as a loss half the time.
  const formatPercent = (value, { digits = 2, sign = "exceptZero" } = {}) => {
    const n = Number(value);
    if (!Number.isFinite(n)) return "";
    return new Intl.NumberFormat(language, {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
      signDisplay: sign,
    }).format(n);
  };

  return {
    monthName,
    weekdayName,
    formatDate,
    formatAmount,
    formatPlainAmount,
    moneySymbol,
    formatPercent,
  };
};

export const useT = () => {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useT was called outside I18nProvider");
  return ctx;
};

export default I18nContext;
