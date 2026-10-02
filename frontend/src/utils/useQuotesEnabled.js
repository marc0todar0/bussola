import { useContext } from "react";
import GlobalContext from "../context/GlobalContext";

// Does this instance have a quote service to refresh prices from?
//
// /api/auth/me says so (`quotes`): without BUSSOLA_QUOTES_URL (the optional
// quotes container), the three refresh endpoints answer QUOTES_DISABLED.
// Unlike a read-only wallet, this is something the person can change, so the
// refresh buttons stay where they are, disabled, and their tooltip says what
// is missing. Only an explicit `false` disables them: an answer from before
// the flag existed leaves them as they were.
export const useQuotesEnabled = () => {
  const context = useContext(GlobalContext);
  const user = context && context.user && context.user.data;
  return !(user && user.quotes === false);
};

export default useQuotesEnabled;
