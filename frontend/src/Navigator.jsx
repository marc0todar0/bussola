import { useState, useEffect, useContext, lazy, Suspense } from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  NavLink,
  useNavigate,
  useLocation,
} from "react-router-dom";

import BankAccounts from "./pages/BankAccounts";
import Categories from "./pages/Categories";
import Transactions from "./pages/Transactions";
import KeyboardHelp from "./components/KeyboardHelp";
import UtilityMenu from "./components/UtilityMenu";
import Loading from "./components/Loading";
import ErrorBoundary from "./components/ErrorBoundary";

// The first three tabs are what the app opens on, so they come with it. The
// rest are loaded the first time somebody goes there: the summary and the
// portfolio carry the chart library, which on its own weighed as much as the
// whole of the rest of the application, and the settings pages are visited a
// few times a year.
const Summary = lazy(() => import("./pages/Summary"));
const MonthlySummary = lazy(() => import("./pages/MonthlySummary"));
const Portfolio = lazy(() => import("./pages/Portfolio"));
const SnapshotDetail = lazy(() => import("./pages/SnapshotDetail"));
const Manage = lazy(() => import("./pages/Manage"));
const Profile = lazy(() => import("./pages/Profile"));
const DataTransfer = lazy(() => import("./pages/DataTransfer"));

import "./nav.css";
import { FaUniversity, FaTags, FaExchangeAlt, FaChartPie } from "react-icons/fa";
import { isModalOpen, isKeyTargetBusy } from "./utils/useKeyboardShortcut";
import { useRowNavigation } from "./utils/useRowNavigation";
import GlobalContext from "./context/GlobalContext";
import { useT } from "./i18n";

function TabKeyHandler({ setShowHelp, setMenuOpen }) {
  const navigate = useNavigate();
  const { blur } = useContext(GlobalContext);
  const setIsBlurred = blur.setIsBlurred;
  // ↑ ↓ and Enter on the rows of every page, from one place.
  useRowNavigation();

  useEffect(() => {
    const onKey = (e) => {
      if (isKeyTargetBusy(e.target)) return;
      // Ctrl+H is the browser's history and Cmd+5 is not ours either: only a
      // bare key is a shortcut.
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "?") {
        setShowHelp((v) => !v);
        return;
      }
      if (isModalOpen()) return;
      if (e.key === "1") navigate("/accounts");
      else if (e.key === "2") navigate("/categories");
      else if (e.key === "3") navigate("/transactions");
      else if (e.key === "4") navigate("/summary");
      // The fifth cell is a menu rather than a page, so its key opens it.
      else if (e.key === "5") setMenuOpen((v) => !v);
      // Hide: the key you reach for when somebody sits down next to you, so
      // it works from every page without opening anything first.
      else if (e.key === "h" || e.key === "H") setIsBlurred((v) => !v);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navigate, setShowHelp, setMenuOpen, setIsBlurred]);

  return null;
}

// The boundary around the pages, keyed on the path: a page that throws shows
// its message in the content area, the tab bar stays, and going to another tab
// tries again from scratch.
function RoutedBoundary({ children }) {
  const { pathname } = useLocation();
  return <ErrorBoundary resetKey={pathname}>{children}</ErrorBoundary>;
}

function MyTabs() {
  const { user, wallet } = useContext(GlobalContext);
  const { t } = useT();
  // There used to be four isRefresh* flags here, set by the transactions page
  // after every write. Nothing read three of them -- every page refetches when
  // it mounts anyway -- and the fourth now lives inside the transactions page,
  // which reloads its own first page after a save.
  const [showHelp, setShowHelp] = useState(false);
  // Held here rather than inside the menu so the "5" shortcut can open it.
  const [menuOpen, setMenuOpen] = useState(false);

  // These are elements, not component functions. A function defined inside the
  // render body is a new type on every render, and React unmounts and remounts
  // whatever it renders -- which restarts the page's effects, which set state,
  // which renders again. An element keeps the component's identity, so the
  // page mounts once.
  const summaryElement = <Summary />;

  const transactionsElement = <Transactions />;

  return (
    <Router>
      <TabKeyHandler setShowHelp={setShowHelp} setMenuOpen={setMenuOpen} />
      {showHelp && <KeyboardHelp onClose={() => setShowHelp(false)} />}
      <div className="tabs">
        {/* The label carries its own class because on a phone it is the only
            part of the tab allowed to give way: the cells are equal quarters of
            the screen and a word that does not fit is clipped there, not wrapped
            onto a second row that would take the whole bar with it. */}
        <nav className="tab-bar sticky-nav">
          <NavLink to="/accounts" className="tab-link">
            <FaUniversity className="tab-icon" />{" "}
            <span className="tab-label">{t("nav.accounts")}</span>
          </NavLink>
          <NavLink to="/categories" className="tab-link">
            <FaTags className="tab-icon" />{" "}
            <span className="tab-label">{t("nav.categories")}</span>
          </NavLink>
          <NavLink to="/transactions" className="tab-link">
            <FaExchangeAlt className="tab-icon" />{" "}
            <span className="tab-label">{t("nav.transactions")}</span>
          </NavLink>
          <NavLink to="/summary" className="tab-link">
            <FaChartPie className="tab-icon" />{" "}
            <span className="tab-label">{t("nav.summary")}</span>
          </NavLink>

          {/* The fifth cell. Language, shortcuts, profile and sign out are not
              places to navigate to, which is why they were taken out of the bar
              once already -- but a button floating over the corner of the page
              covers whatever is under it, and on the summary that is the chart.
              The bar is the one strip that is always on screen and never on top
              of anything, so the menu opens from there and the four
              destinations keep their own colour. */}
          <UtilityMenu
            open={menuOpen}
            setOpen={setMenuOpen}
            onShowShortcuts={() => setShowHelp(true)}
            onSignOut={user.signOut}
            onChangeWallet={wallet.change}
            username={user.data.username}
            wallet={wallet.data}
          />
        </nav>


        <div className="tab-content">
          {/* One boundary for every lazy page: the tab bar above stays put
              while a page's code arrives, and only the content area waits. */}
          <RoutedBoundary>
          <Suspense fallback={<Loading />}>
          <Routes>
            <Route path="/accounts" element={<BankAccounts />} />
            <Route path="/categories" element={<Categories />} />
            <Route path="/transactions" element={transactionsElement} />
            {/* A deep link to the form, filled in from the query string
                (?amount=&description=&date=&type=&from=&to=): what an iPhone
                Shortcut's "Open URL" opens. The page reads it and goes back
                to /transactions. */}
            <Route path="/transactions/new" element={transactionsElement} />
            <Route path="/" element={transactionsElement} />
            <Route path="/summary" element={summaryElement} />
            <Route path="/summary/month" element={<MonthlySummary />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/portfolio/snapshot/:year/:month" element={<SnapshotDetail />} />
            <Route path="/manage" element={<Manage />} />
            <Route path="/profile" element={<Profile />} />
            {/* Import and export, reached from the settings menu. */}
            <Route path="/data" element={<DataTransfer />} />
          </Routes>
          </Suspense>
          </RoutedBoundary>
        </div>
      </div>
    </Router>
  );
}

export default MyTabs;
