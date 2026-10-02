import { useSyncExternalStore } from "react";

// Where the toasts are drawn. An open <dialog> sits in the browser's top
// layer, above any z-index, and the rest of the page is inert beneath it: a
// toast raised from inside a modal (a quote refresh, a failed save) would be
// hidden under it. So the Toaster is portalled into the innermost open modal,
// and back into the page when the last one closes. Modal.jsx registers itself.
const open = [];
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn());

export const addToastHost = (el) => {
  if (!el || open.includes(el)) return;
  open.push(el);
  notify();
};

export const removeToastHost = (el) => {
  const i = open.indexOf(el);
  if (i < 0) return;
  open.splice(i, 1);
  notify();
};

const subscribe = (fn) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};
const current = () => open[open.length - 1] || null;

// The innermost open modal, or null for the page itself.
export const useToastHost = () => useSyncExternalStore(subscribe, current);
