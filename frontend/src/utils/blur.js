// ---------------------------------------------------------------------------
// Bank mode: hiding every amount on screen
// ---------------------------------------------------------------------------
// For reading the application on a train or in a café without the row behind
// reading it too. The state itself lives in App and is persisted per device --
// it is a property of the machine, not of the account, because the same person
// blurs on the laptop they carry around and does not blur on the one at home.
//
// The hook and the styles live here rather than beside <Amount> for the same
// reason the formatting lives in amountFormat: most of the callers are not
// components. The chart libraries build their labels in plain callbacks, and a
// module that exports no components is also a module that does not cost the
// component file its fast refresh.
import { createContext, useContext } from "react";
import GlobalContext from "../context/GlobalContext";

// A region of the screen where bank mode does not apply. The transaction form
// is the case it exists for: you are typing that amount yourself, and a keypad
// whose display is a smudge makes the form unusable rather than discreet --
// the number is on screen because you just put it there.
export const BlurExemptContext = createContext(false);

// Reads the context defensively: the hook is exported, and a caller mounted
// outside the provider should get "not hidden" rather than a crash.
export const useAmountBlur = () => {
  const ctx = useContext(GlobalContext);
  const exempt = useContext(BlurExemptContext);
  return !exempt && Boolean(ctx && ctx.blur && ctx.blur.isBlurred);
};

// A CSS filter and not a placeholder string, so the box keeps exactly the
// width it had: toggling bank mode must not move anything on the page, or the
// toggle becomes a thing you avoid pressing.
//
// The radius is in em and not in px because the amounts on these screens range
// from 12px in a transaction row to 30px in the calculator, and a blur that
// makes 30px illegible leaves 12px perfectly readable. Tied to the font size,
// one value covers all of them. 0.35em is past the point where the strokes of
// two adjacent digits merge -- you can see that there is a number and roughly
// how long it is, and that is all.
//
// user-select off as well: a smear you can drag a cursor through and read out
// of the clipboard is not hidden, it is decorated.
export const HIDDEN_STYLE = {
  filter: "blur(0.35em)",
  userSelect: "none",
  WebkitUserSelect: "none",
  pointerEvents: "none",
  display: "inline-block",
};

// The screen reader is told there is an amount and that it is hidden, never
// the amount itself: a feature whose whole purpose is that the number is not
// disclosed cannot go on announcing it out loud.
export const SR_ONLY = {
  position: "absolute",
  width: "1px",
  height: "1px",
  padding: 0,
  margin: "-1px",
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

// What a chart tooltip or axis shows instead of the figure. A string, because
// those libraries build their labels from strings and there is no element to
// hang a filter on.
export const AMOUNT_MASK = "•••";
