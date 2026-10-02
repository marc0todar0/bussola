import { useEffect } from "react";
import { useLocation } from "react-router-dom";
import { isKeyTargetBusy, isModalOpen } from "./useKeyboardShortcut";

// ↑ ↓ walk the rows of whatever page is on screen, Enter opens the one
// highlighted -- exactly what a click on it would do. A row takes part by
// carrying `data-nav-row`; the highlight is the `data-nav-active` attribute,
// drawn by index.css. Both live on the DOM rather than in React state: the
// transaction rows are memoized, and moving a highlight must not re-render a
// list of hundreds of them.
const ROW = "[data-nav-row]";
const ACTIVE = "data-nav-active";

// The rows actually drawn: a collapsed section's are not in the DOM, a hidden
// one's have no box.
const visibleRows = () =>
  [...document.querySelectorAll(ROW)].filter((el) => el.getClientRects().length > 0);

// With nothing highlighted yet, start from what is on screen rather than from
// the top of a list that may have been scrolled a long way.
const firstOnScreen = (rows, down) => {
  const top = document.querySelector(".sticky-nav")?.getBoundingClientRect().bottom ?? 0;
  if (down) {
    const i = rows.findIndex((el) => el.getBoundingClientRect().top >= top);
    return i === -1 ? rows.length - 1 : i;
  }
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].getBoundingClientRect().bottom <= window.innerHeight) return i;
  }
  return 0;
};

export function useRowNavigation() {
  const { pathname } = useLocation();

  useEffect(() => {
    let current = null;

    const clear = () => {
      current?.removeAttribute(ACTIVE);
      current = null;
    };

    const select = (el) => {
      if (current !== el) {
        clear();
        current = el;
        el.setAttribute(ACTIVE, "");
      }
      // Whatever still holds the focus -- the tab link just clicked, a pill,
      // "Load more" -- would take the Enter meant for the row: a focused link
      // answers it by following itself. Walking the rows takes the focus away.
      const focused = document.activeElement;
      if (focused && focused !== document.body && !isKeyTargetBusy(focused)) focused.blur();
      // index.css gives the rows a scroll margin, so "nearest" does not leave
      // one under the sticky tab bar.
      el.scrollIntoView({ block: "nearest" });
    };

    const onKey = (e) => {
      if (isKeyTargetBusy(e.target) || isModalOpen()) return;
      if (e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;

      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        const rows = visibleRows();
        if (!rows.length) return; // a page with no rows scrolls as usual
        e.preventDefault();
        const down = e.key === "ArrowDown";
        // A row replaced by a reload (another month, a new filter) is no
        // longer in the document: start again from the screen.
        const at = current && current.isConnected ? rows.indexOf(current) : -1;
        const next =
          at === -1
            ? firstOnScreen(rows, down)
            : Math.min(rows.length - 1, Math.max(0, at + (down ? 1 : -1)));
        select(rows[next]);
      } else if (e.key === "Enter") {
        if (!current || !current.isConnected) return;
        // Focus moved back onto a button or link after the last arrow (Tab):
        // that one answers Enter itself.
        if (e.target.closest?.("button, a, select")) return;
        e.preventDefault();
        current.click();
      } else if (e.key === "Escape") {
        clear();
      }
    };

    // Whoever picks up the mouse is no longer walking the list.
    const onPointer = () => clear();

    window.addEventListener("keydown", onKey);
    window.addEventListener("pointerdown", onPointer);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pointerdown", onPointer);
      clear();
    };
  }, [pathname]);
}
