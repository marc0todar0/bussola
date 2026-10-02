import { useContext } from "react";
import GlobalContext from "../context/GlobalContext";

// May this account change what it is looking at?
//
// A wallet can be shared read-only, and then every button that writes has to
// go. The API refuses a read-only member anyway -- that is where the rule
// actually lives -- but a button whose only possible outcome is an error
// message is not an interface, it is a trap.
//
// Outside a wallet (the login screen, the picker) there is nothing to write
// to, so the answer is no.
export const useCanWrite = () => {
  const context = useContext(GlobalContext);
  return Boolean(context && context.wallet && context.wallet.canWrite);
};

export default useCanWrite;
