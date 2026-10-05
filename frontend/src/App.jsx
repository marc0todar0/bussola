import { useState, useEffect, useCallback, lazy, Suspense } from "react";
import "./App.css";
import fetchAuth from "./utils/fetchAuth";
import GlobalContext from "./context/GlobalContext";
import Navigator from "./Navigator";
import { createPortal } from "react-dom";
import { Toaster, ToastBar, toast } from "react-hot-toast";
import Login from "./components/Login";
import Loading from "./components/Loading";
import WalletPicker from "./components/WalletPicker";
import ErrorBoundary, { ProblemPanel } from "./components/ErrorBoundary";
import { I18nProvider, useT } from "./i18n";
import { currentUser, instanceStatus, logout, onSessionExpired, onWalletLost, saveLocale } from "./utils/session";
import { rebindForOwner, registerIfSubscribed } from "./utils/push";
import { formatDate } from "./utils/generic";
import { useToastHost } from "./utils/toastHost";

const BLUR_KEY = "bussola.blur";

// Boot found nobody to ask: the network is down, or nginx answered for an API
// that is not there. Not the login screen -- nobody was signed out.
const Unreachable = ({ onRetry }) => {
  const { t } = useT();
  return (
    <ProblemPanel
      fullScreen
      title={t("app.unreachable")}
      hint={t("app.unreachableHint")}
      action={t("app.retry")}
      onAction={onRetry}
    />
  );
};

// The toasts, drawn in the page or, while a modal is open, inside it: the
// modal is in the browser's top layer and would cover them.
const Toasts = () => {
  const host = useToastHost();
  const toaster = (
    <Toaster
      position="top-center"
      containerStyle={{ zIndex: 999999 }}
      // The library paints its toasts white on its own; the tokens make
      // them the colour of a card in either theme.
      toastOptions={{
        style: {
          zIndex: 999999,
          background: "var(--surface)",
          color: "var(--text)",
          border: "1px solid var(--border)",
          boxShadow: "var(--shadow-lg)",
        },
      }}
    >
      {(t) => (
        <div onClick={() => toast.dismiss(t.id)} style={{ cursor: "pointer" }}>
          <ToastBar toast={t} />
        </div>
      )}
    </Toaster>
  );
  return host ? createPortal(toaster, host) : toaster;
};

// Only the demo build has it; in the real one __DEMO__ is false and the
// component is not even in the bundle.
const DemoBanner = __DEMO__ ? lazy(() => import("./demo/DemoBanner.jsx")) : null;

// Read once, at first render, so the very first paint is already right: a
// screen that shows the numbers and then hides them a frame later has already
// shown them.
const readBlur = () => {
  try {
    return localStorage.getItem(BLUR_KEY) === "1";
  } catch {
    return false; // private mode, blocked storage: not a reason to fail
  }
};

function App() {
  const [accountsData, setAccountsData] = useState([]);
  const [categoriesData, setCategoriesData] = useState([]);
  // No transaction list here any more: it is paged, and lives with the page
  // that shows it (utils/useTransactionPages.js).
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);

  const DateFiltersValues = {
    YEARMONTH: "YEARMONTH",
    YEAR: "YEAR",
    ALL: "ALL",
  };

  const [dateFiltersType, setDateFiltersType] = useState(DateFiltersValues.YEARMONTH);

  const [filterType, setFilterType] = useState(null);
  const [filterFromId, setFilterFromId] = useState(null);
  const [filterToId, setFilterToId] = useState(null);
  const [searchText, setSearchText] = useState("");
  // A view preference, not a filter on the data: it survives a period change.
  const [sortBy, setSortBy] = useState("date"); // "date" | "amount"
  const [sortDir, setSortDir] = useState("desc"); // "desc" | "asc"

  // "Bank mode": every amount on screen is smeared out, for reading the app on
  // a train or in a café without the row behind reading it too.
  //
  // It lives in localStorage and not on the user row on purpose: it is a
  // property of the *device*, not of the person. You blur on the laptop you
  // carry around and you do not blur on the machine at home, and the same
  // account is signed in on both.
  //
  // It defaults to OFF. The old declaration here said useState(true), but
  // nothing ever read the value, so nobody has ever seen the app open blurred
  // and no habit depends on it. Opening a finance application to a screen full
  // of unreadable smudges looks broken rather than discreet, and the person
  // who wants it turns it on once and the choice sticks from then on -- while
  // the person who does not would have to turn it off on every new device.
  // The safer-looking default is the one that gets in more people's way.
  const [isBlurred, setIsBlurred] = useState(readBlur);

  useEffect(() => {
    try {
      localStorage.setItem(BLUR_KEY, isBlurred ? "1" : "0");
    } catch {
      /* private mode, blocked storage: the choice still applies for this session */
    }
  }, [isBlurred]);

  // Who is signed in. null = nobody, undefined = we do not know yet.
  const [user, setUser] = useState(undefined);
  // The first /me got no answer at all: show that, with a retry, rather than
  // a spinner that never ends.
  const [unreachable, setUnreachable] = useState(false);

  const boot = useCallback(() => {
    setUnreachable(false);
    setUser(undefined);
    currentUser()
      .then((u) => setUser(u))
      .catch(() => setUnreachable(true));
  }, []);

  // Signed in, but asking to work on a different wallet. Distinct from having
  // no wallet at all: there is something to come back from.
  const [switching, setSwitching] = useState(false);

  useEffect(() => {
    boot();
    // A session can fall while the app is open: when it does we go back to the
    // login screen instead of filling the page with network errors.
    const stopExpiry = onSessionExpired(() => setUser(null));
    // The wallet can go away on its own -- deleted, or the membership
    // withdrawn while the app was open. The session is still valid, so this is
    // the picker, not the login screen.
    const stopWalletLost = onWalletLost(() =>
      setUser((u) => (u && u.wallet ? { ...u, wallet: null } : u)),
    );
    return () => {
      stopExpiry();
      stopWalletLost();
    };
  }, [boot]);

  // Web Push: the service worker is registered only on a device that already
  // has a subscription (and only when the server has push on), so that a tap
  // on a notification works after a reload. Nothing else registers it.
  // After a sign-in, the same person's subscription is bound to the new
  // session again (utils/push.js, rebindForOwner).
  const userId = user ? user.id : null;
  useEffect(() => {
    if (userId == null) return;
    instanceStatus().then(async (status) => {
      await rebindForOwner(status, userId);
      await registerIfSubscribed(status);
    });
  }, [userId]);

  // The account can change under the app's feet: a new username, a renamed
  // wallet. Only App holds `user`, so a page that changes one of those has no
  // way to write it -- it asks for /me to be read again instead, which is the
  // same path taken at boot and costs one request rather than a full reload.
  // A refresh that cannot reach the server keeps what is on screen: the
  // change it follows was already confirmed, and a blip is not a sign-out.
  const refreshUser = useCallback(
    () =>
      currentUser()
        .then((u) => setUser(u))
        .catch(() => {}),
    [],
  );

  const clearData = () => {
    setAccountsData([]);
    setCategoriesData([]);
  };

  const signOut = async () => {
    await logout();
    setUser(null);
    setSwitching(false);
    clearData();
  };

  // Everything on screen belongs to the wallet being left, so it goes with it:
  // the pages refetch on mount and would otherwise show the previous wallet's
  // numbers for an instant.
  const onWalletChosen = (wallet) => {
    clearData();
    setSwitching(false);
    setUser((u) => (u ? { ...u, wallet } : u));
  };

  // Keep the account's stored language in step with the one just picked, so
  // the choice follows the person to another browser.
  const onLanguageChange = useCallback(
    (code) => {
      if (user) saveLocale(code);
    },
    [user],
  );

  const previousPeriod = () => {
    if (dateFiltersType === DateFiltersValues.YEARMONTH) {
      if (month === 1) {
        setMonth(12);
        setYear(year - 1);
        return;
      }
      setMonth(month - 1);
    } else if (dateFiltersType === DateFiltersValues.YEAR) {
      setYear(year - 1);
    }
  };

  const nextPeriod = () => {
    if (dateFiltersType === DateFiltersValues.YEARMONTH) {
      if (month === 12) {
        setMonth(1);
        setYear(year + 1);
        return;
      }
      setMonth(month + 1);
    } else if (dateFiltersType === DateFiltersValues.YEAR) {
      setYear(year + 1);
    }
  };

  const getDateParams = () => {
    let from, to;
    if (dateFiltersType === DateFiltersValues.YEARMONTH) {
      from = new Date(year, month - 1, 1);
      to = new Date(year, month, 0);
    } else if (dateFiltersType === DateFiltersValues.YEAR) {
      from = new Date(year, 0, 1);
      to = new Date(year, 11, 31);
    } else {
      from = new Date(2000, 0, 1);
      to = new Date(2099, 11, 31);
    }
    return { from: formatDate(from), to: formatDate(to) };
  };

  const configGestureHandler = {
    velocityThreshold: 0.3,
    directionalOffsetThreshold: 80,
  };

  const globalState = {
    accounts: {
      data: accountsData,
      setData: setAccountsData,
    },
    categories: {
      data: categoriesData,
      setData: setCategoriesData,
    },
    period: {
      month,
      year,
      setMonth,
      setYear,
      nextPeriod,
      previousPeriod,
      getDateParams,
      dateFiltersType,
      setDateFiltersType,
      DateFiltersValues,
    },
    config: {
      configGestureHandler,
    },
    filters: {
      filterType,
      setFilterType,
      filterFromId,
      setFilterFromId,
      filterToId,
      setFilterToId,
      searchText,
      setSearchText,
      sortBy,
      setSortBy,
      sortDir,
      setSortDir,
    },
    blur: {
      isBlurred,
      setIsBlurred,
    },
    fetchAuth,
    user: {
      data: user,
      signOut,
      refresh: refreshUser,
    },
    // The wallet everything on screen belongs to, and whether this account may
    // change any of it. Every button that writes asks canWrite: the API
    // refuses a read-only member anyway, but offering a button that can only
    // fail is not an interface.
    wallet: {
      data: user && user.wallet,
      canWrite: Boolean(user && user.wallet && user.wallet.role === "rw"),
      change: () => setSwitching(true),
    },
  };

  // The provider wraps the login screen too: that screen has to speak the
  // reader's language before anyone knows who the reader is.
  return (
    <I18nProvider
      locale={user && user.locale}
      // The currency comes from the wallet, not from the account: everyone
      // looking at these rows has to read them in the same unit. Switching
      // wallet re-renders every amount, the same way switching language does.
      currency={user && user.wallet && user.wallet.currency}
      onChange={onLanguageChange}
    >
      <ErrorBoundary fullScreen>
      {unreachable ? (
        <Unreachable onRetry={boot} />
      ) : user === undefined ? (
        <Loading />
      ) : !user ? (
        <Login onSignedIn={setUser} />
      ) : !user.wallet || switching ? (
        // Signed in with nothing open: either the account reaches more than
        // one wallet and has not said which, or the one it was on is gone.
        <WalletPicker
          current={user.wallet}
          onChosen={onWalletChosen}
          onCancel={switching ? () => setSwitching(false) : null}
          onSignOut={signOut}
        />
      ) : (
        <GlobalContext.Provider value={globalState}>
          <Toasts />
          {DemoBanner && (
            <Suspense fallback={null}>
              <DemoBanner />
            </Suspense>
          )}
          <Navigator />
        </GlobalContext.Provider>
      )}
      </ErrorBoundary>
    </I18nProvider>
  );
}

export default App;
