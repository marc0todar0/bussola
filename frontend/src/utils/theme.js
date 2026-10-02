// ---------------------------------------------------------------------------
// Light, dark, or whatever the system says
// ---------------------------------------------------------------------------
// The colours themselves are CSS custom properties in index.css, keyed on
// `data-theme` on <html>. This module only decides which of the two sets is in
// force and tells the few places that cannot read a stylesheet -- the chart
// library, which wants literal colours in its options -- when that changes.
//
// The choice lives in localStorage and not on the account, for the same reason
// bank mode does: it is a property of the *device*. The laptop in a dark room
// and the phone in the sun are the same person with two different answers.
//
// index.html runs a copy of `resolve` + `apply` inline, before the bundle has
// even been fetched, so the first paint is already in the right colours. The
// two have to agree on the key and on the attribute; if you change one, change
// the other.
import { useMemo, useSyncExternalStore } from "react";

export const THEME_KEY = "bussola.theme";
export const THEME_CHOICES = ["system", "light", "dark"];

// What the browser chrome is painted in: the brand blue on a light page, as it
// always was, and the dark surface on a dark one -- a bright blue strip over a
// dark screen is the one thing the reader who chose dark was trying to avoid.
const THEME_COLOR = { light: "#1E90FF", dark: "#181c22" };

const DARK_QUERY = "(prefers-color-scheme: dark)";

const readChoice = () => {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    return THEME_CHOICES.includes(stored) ? stored : "system";
  } catch {
    return "system"; // private mode, blocked storage: not a reason to fail
  }
};

const systemIsDark = () =>
  typeof window !== "undefined" && window.matchMedia
    ? window.matchMedia(DARK_QUERY).matches
    : false;

const resolve = (choice) =>
  choice === "system" ? (systemIsDark() ? "dark" : "light") : choice;

// Synchronous on purpose: it runs before the listeners are told, so a chart
// that re-renders in response reads the new tokens and not the old ones.
const apply = (resolved) => {
  const root = document.documentElement;
  root.dataset.theme = resolved;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[resolved]);
};

// A tiny external store rather than a context: the menu that changes the theme
// and the charts that have to follow it are in unrelated parts of the tree,
// and the value already has a home outside React (the attribute on <html>).
// useSyncExternalStore needs a snapshot that stays the same object until
// something actually changes, hence `state` is replaced, never mutated.
let state = null;
const listeners = new Set();

const compute = () => {
  const choice = readChoice();
  return { choice, resolved: resolve(choice) };
};

const publish = (next) => {
  if (state && next.choice === state.choice && next.resolved === state.resolved) return;
  state = next;
  apply(state.resolved);
  listeners.forEach((l) => l());
};

// The OS can switch between light and dark on its own -- at sunset, or from
// the quick settings -- and in System mode that has to reach the page without a
// reload. One listener for the whole application, attached on first use.
let watchingSystem = false;
const watchSystem = () => {
  if (watchingSystem || typeof window === "undefined" || !window.matchMedia) return;
  watchingSystem = true;
  const mq = window.matchMedia(DARK_QUERY);
  const onChange = () => publish(compute());
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else if (mq.addListener) mq.addListener(onChange); // Safari before 14
};

const subscribe = (listener) => {
  watchSystem();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const getSnapshot = () => {
  if (!state) state = compute();
  return state;
};

export const setThemeChoice = (choice) => {
  const next = THEME_CHOICES.includes(choice) ? choice : "system";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* private mode, blocked storage: the choice still applies for this session */
  }
  publish({ choice: next, resolved: resolve(next) });
};

// `choice` is what the reader picked (system / light / dark); `resolved` is
// what is on screen (light / dark). The picker shows the first, everything
// else only ever needs the second.
export const useTheme = () => {
  const { choice, resolved } = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { choice, resolved, setChoice: setThemeChoice };
};

// The tokens as literal colours, for the chart library: ApexCharts writes its
// colours into SVG attributes and does arithmetic on them (shades, gradients),
// so "var(--text)" is not something it can use. Read from the computed style
// rather than duplicated here, so index.css stays the only place a colour is
// defined.
const TOKENS = {
  text: "--text",
  textMuted: "--text-muted",
  border: "--border",
  surface: "--surface",
  positive: "--positive",
  negative: "--negative",
  neutral: "--neutral",
  chartTotal: "--chart-total",
};

const readTokens = () => {
  const style = getComputedStyle(document.documentElement);
  const out = {};
  for (const [name, prop] of Object.entries(TOKENS)) {
    out[name] = style.getPropertyValue(prop).trim();
  }
  return out;
};

// Memoised on the resolved theme: the computed style only changes when that
// does, and a chart's options object is rebuilt on every render anyway.
export const useThemeColors = () => {
  const { resolved } = useTheme();
  // `resolved` is not read inside, but it is the whole point of the memo: the
  // attribute on <html> changed, so the computed values did too.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const colors = useMemo(() => readTokens(), [resolved]);
  return { mode: resolved, ...colors };
};

// react-select draws with its own palette, and takes a replacement through its
// `theme` prop. Unlike the charts it writes the colours into CSS, so the
// tokens can go in as var() and follow a theme change with no re-render at
// all. The names are react-select's: neutral0 is the field, neutral80 the
// text, primary25 the option under the pointer.
export const selectTheme = (theme) => ({
  ...theme,
  colors: {
    ...theme.colors,
    primary: "var(--accent)",
    primary75: "var(--accent)",
    primary50: "var(--accent-soft)",
    primary25: "var(--surface-hover)",
    neutral0: "var(--input-bg)",
    neutral5: "var(--surface-2)",
    neutral10: "var(--chip-bg)",
    neutral20: "var(--input-border)",
    neutral30: "var(--border-strong)",
    neutral40: "var(--text-subtle)",
    neutral50: "var(--text-subtle)",
    neutral60: "var(--text-muted)",
    neutral70: "var(--text-secondary)",
    neutral80: "var(--text)",
    neutral90: "var(--text)",
  },
});
