import { useEffect } from "react";

const isModalOpen = () =>
  !!document.querySelector("dialog.modal[open]");

// True when the key is "already taken" by a text field or by a widget that
// handles the keyboard itself (react-datepicker's calendar navigates with the
// arrows and confirms with Enter, and its cells are divs: without this check
// the same keys would also reach the global shortcuts).
export const isKeyTargetBusy = (target) =>
  target.tagName === "INPUT" ||
  target.tagName === "TEXTAREA" ||
  target.isContentEditable ||
  !!target.closest?.(".react-datepicker");

export function useKeyboardShortcut(handler, deps) {
  useEffect(() => {
    const onKey = (e) => {
      if (isKeyTargetBusy(e.target)) return;
      handler(e);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, deps);
}

export { isModalOpen };
