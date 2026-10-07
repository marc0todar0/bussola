import { useContext, useState, useEffect, useRef, useCallback, lazy, Suspense } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import GlobalContext from "../context/GlobalContext";
import Loading from "../components/Loading";
import toast from "react-hot-toast";
import { mainColor, secondaryColor } from "../config";
import Amount from "../components/Amount";
import TransactionDayRows from "../components/TransactionDayRows";
import TransactionFlatRows from "../components/TransactionFlatRows";
import Modal from "../components/Modal";
import { BlurExemptContext } from "../utils/blur";
import Select from "react-select";
import { selectTheme } from "../utils/theme";
import ArrowButton from "../components/ArrowButton";
import { useKeyboardShortcut } from "../utils/useKeyboardShortcut";
import { useCanWrite } from "../utils/useCanWrite";
import { useTransactionPages } from "../utils/useTransactionPages";
import {
  acceptBodyFromInboxItem,
  canAcceptInboxItem,
  draftFromInboxItem,
  draftFromQuery,
} from "../utils/transactionDraft";
import InboxPanel from "../components/InboxPanel";
import { FiSearch, FiArrowDown, FiArrowUp, FiX } from "react-icons/fi";
import { useT } from "../i18n";

// The form brings the keypad and the date picker with it, and nobody needs
// either until they open a transaction: it is loaded on the first opening.
const TransactionForm = lazy(() => import("../components/TransactionForm"));

// The list is paged by the API (utils/useTransactionPages.js): filters,
// search, sorting and the totals are all worked out there, over the whole
// period, and this page shows what has been loaded so far and asks for more as
// the end of it scrolls into view.
export default function Transactions() {
  const { period, filters, fetchAuth, wallet } = useContext(GlobalContext);
  const walletCurrency = wallet && wallet.data ? wallet.data.currency : null;
  const { t, monthName } = useT();
  const canWrite = useCanWrite();
  const {
    month,
    year,
    nextPeriod,
    previousPeriod,
    getDateParams,
    dateFiltersType,
    setDateFiltersType,
    DateFiltersValues,
  } = period;
  // "All" asks for no bounds at all rather than for 2000-2099: the API reads
  // an absent bound as "unbounded", and a transaction dated 1999 is still one.
  const range = dateFiltersType === DateFiltersValues.ALL ? {} : getDateParams();
  const {
    filterType, setFilterType,
    filterFromId, setFilterFromId,
    filterToId, setFilterToId,
    searchText, setSearchText,
    sortBy, setSortBy,
    sortDir, setSortDir,
  } = filters;
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  const searchInputRef = useRef(null);
  const [transaction, setTransaction] = useState(null);
  const [open, setOpen] = useState(false);
  // A new transaction's starting values (an inbox item or a deep link), and
  // where saving it goes: /inbox/:id/accept for an inbox item.
  const [draft, setDraft] = useState(null);
  const [savePath, setSavePath] = useState(null);
  // Drafts sent by a phone (docs/notifications.md), waiting to be confirmed.
  const [inbox, setInbox] = useState([]);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxBusy, setInboxBusy] = useState(null);
  const location = useLocation();
  const navigate = useNavigate();
  const sentinelRef = useRef(null);

  const list = useTransactionPages(fetchAuth, {
    from: range.from,
    to: range.to,
    type: filterType,
    fromId: filterFromId,
    toId: filterToId,
    q: searchText,
    sort: sortBy,
    dir: sortDir,
  });
  const { loadMore, reload, nextCursor } = list;

  // Only somebody who can write is shown the inbox: confirming or dismissing
  // is all there is to do with it.
  const loadInbox = useCallback(async () => {
    if (!canWrite) {
      setInbox([]);
      return;
    }
    try {
      const response = await fetchAuth("/inbox", { cache: "no-store" });
      if (!response.ok) return;
      const items = await response.json();
      setInbox(Array.isArray(items) ? items : []);
    } catch (error) {
      console.error(error);
    }
  }, [fetchAuth, canWrite]);

  useEffect(() => {
    loadInbox();
  }, [loadInbox]);

  // While the model is still reading a notification, ask again every few
  // seconds, so that "Reading..." turns into the proposal without a reload.
  // Only while the page is visible: a background tab has nobody to show it to.
  const reading = inbox.some((i) => i.extraction === "pending");
  useEffect(() => {
    if (!reading) return undefined;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") loadInbox();
    }, 4000);
    return () => clearInterval(timer);
  }, [reading, loadInbox]);

  // The text for an error code the API sent, or the fallback when the
  // catalogue has nothing more specific to say.
  const errorText = (code, fallback) => {
    if (!code) return fallback;
    const key = `error.${code}`;
    const text = t(key);
    return text === key ? fallback : text;
  };

  useEffect(() => {
    if (transaction) setOpen(true);
  }, [transaction]);

  // A new period starts with no filters. The list follows by itself: the
  // period and the filters are what the hook asks the API for.
  useEffect(() => {
    setFilterType(null);
    setFilterFromId(null);
    setFilterToId(null);
    setSearchText("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month, year, dateFiltersType]);

  // Filters preloaded when arriving from the summary (a click on a category).
  // This runs after the reset above, which on the same mount would clear them.
  useEffect(() => {
    const incoming = location.state?.filters;
    if (!incoming) return;
    setFilterType(incoming.type ?? null);
    setFilterFromId(incoming.fromId ?? null);
    setFilterToId(incoming.toId ?? null);
    // Consume the state: changing month or period type must not reapply it.
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  // /transactions/new?amount=&description=&date=&type=&from=&to= opens the
  // form filled in (utils/transactionDraft.js checks every value; the form
  // drops ids it does not offer). The address goes back to /transactions with
  // the draft in the history state -- which survives the page being mounted
  // again for the other route -- and the state is then consumed, so neither a
  // reload nor going back opens the form a second time.
  useEffect(() => {
    if (location.pathname === "/transactions/new") {
      navigate("/transactions", { replace: true, state: { draft: draftFromQuery(location.search) } });
      return;
    }
    const incoming = location.state?.draft;
    if (!incoming) return;
    navigate(location.pathname, { replace: true, state: null });
    if (!canWrite) return;
    setTransaction(null);
    setSavePath(null);
    setDraft(incoming);
    setOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.key]);

  useEffect(() => {
    if (isSearchOpen) searchInputRef.current?.focus();
  }, [isSearchOpen]);

  // Infinite scroll: when the marker after the last row comes within 600px of
  // the screen, the next page is asked for. The observer is rebuilt for every
  // page, and a fresh observer reports at once if the marker is already in
  // view -- which is what keeps a short page from stopping the scroll.
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el || !nextCursor || typeof IntersectionObserver === "undefined") return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) loadMore();
      },
      { rootMargin: "600px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [nextCursor, loadMore]);

  // After a save or a delete only the first page comes back: the change is
  // near the top of the list, and the totals above it come with page one.
  // A movement on an investment account whose only holding is valued by hand
  // resets that holding to the balance; the answer names such accounts.
  const announceActualReset = useCallback(
    (body) => {
      const reset = body && Array.isArray(body.actualReset) ? body.actualReset : [];
      if (reset.length) toast.success(t("transaction.actualReset", { names: reset.map((a) => a.name).join(", ") }));
    },
    [t],
  );

  const afterWrite = useCallback((body) => {
    // Saved from an inbox item: the item is resolved now.
    if (savePath) toast.success(t("inbox.accepted"));
    announceActualReset(body);
    setOpen(false);
    setTransaction(null);
    setDraft(null);
    setSavePath(null);
    reload();
    loadInbox();
  }, [reload, loadInbox, savePath, t, announceActualReset]);

  const reviewInboxItem = (item) => {
    setInboxOpen(false);
    setTransaction(null);
    setDraft(draftFromInboxItem(item));
    setSavePath(`/inbox/${item.id}/accept`);
    setOpen(true);
  };

  // Records the draft as it stands, without the form: the body is what the
  // form would send for an unedited draft. The item is busy meanwhile, so a
  // second click does nothing; whatever the outcome, the inbox is asked again.
  const acceptInboxItem = async (item) => {
    if (inboxBusy != null || !canAcceptInboxItem(item, walletCurrency)) return;
    setInboxBusy(item.id);
    let recorded = false;
    try {
      const response = await fetchAuth(`/inbox/${item.id}/accept`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify(acceptBodyFromInboxItem(item)),
      });
      if (response.ok) {
        recorded = true;
        toast.success(t("inbox.accepted"));
        announceActualReset(await response.json().catch(() => null));
      } else {
        const body = await response.json().catch(() => null);
        // Somebody else resolved it first: nothing to report, the list
        // simply stops showing it.
        if (!(response.status === 409 && body && body.code === "INBOX_RESOLVED")) {
          toast.error(errorText(body && body.code, t("inbox.acceptFailed")));
        }
      }
    } catch (error) {
      console.error(error);
      toast.error(t("common.networkError"));
    } finally {
      setInboxBusy(null);
      loadInbox();
      if (recorded) reload();
    }
  };

  const dismissInboxItem = async (item) => {
    setInboxBusy(item.id);
    try {
      const response = await fetchAuth(`/inbox/${item.id}/dismiss`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (response.ok) {
        toast.success(t("inbox.dismissed"));
      } else {
        const body = await response.json().catch(() => null);
        toast.error(errorText(body && body.code, t("inbox.dismissFailed")));
      }
    } catch (error) {
      toast.error(String(error));
    } finally {
      setInboxBusy(null);
      loadInbox();
    }
  };

  // Stable: this is the onPress prop of the memoized rows, and an identity
  // that changes on every render would make the memo pointless.
  const handleUpdate = useCallback((tx) => setTransaction(tx), []);

  // Answering Cancel leaves the form open with whatever was typed in it.
  const handleDelete = async (tx) => {
    if (!confirm(t("transaction.confirmDelete"))) return;
    try {
      const response = await fetchAuth(`/transactions/${tx.id}`, {
        method: "DELETE",
        body: JSON.stringify({}),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        toast.error(errorText(body && body.code, t("transaction.deleteFailed")));
        // Gone already (a second click, or another member): the list
        // should stop showing it either way.
        if (response.status === 404) afterWrite();
      } else {
        toast.success(t("transaction.deleted"));
        afterWrite(await response.json().catch(() => null));
      }
    } catch (error) {
      toast.error(String(error));
    }
  };

  const closeForm = () => {
    setOpen(false);
    setTransaction(null);
    // Closing an inbox item's form leaves it pending; the list is asked again
    // in case somebody else resolved it meanwhile.
    if (savePath) loadInbox();
    setDraft(null);
    setSavePath(null);
  };

  useKeyboardShortcut((e) => {
    if (open) return;
    if (e.key === "/") {
      e.preventDefault(); // otherwise the slash lands in the input just opened
      setIsSearchOpen(true);
      searchInputRef.current?.focus();
    } else if (e.key === "n" || e.key === "N") {
      if (!canWrite) return;
      setTransaction(null);
      setDraft(null);
      setSavePath(null);
      setOpen(true);
    } else if (e.key === "ArrowLeft" && dateFiltersType !== DateFiltersValues.ALL) {
      previousPeriod();
    } else if (e.key === "ArrowRight" && dateFiltersType !== DateFiltersValues.ALL) {
      nextPeriod();
    }
  }, [open, previousPeriod, nextPeriod, dateFiltersType, DateFiltersValues]);

  // Only the very first page of the visit takes the whole screen. After that
  // the filters stay where they are -- the search field above all, which must
  // not lose the focus between two keystrokes -- and the list is dimmed while
  // the next answer is on its way.
  if (!list.loaded && list.loading) {
    return <Loading />;
  }

  const fromOptions = list.facets.from || [];
  const toOptions = list.facets.to || [];
  const hasFilters = Boolean(filterType || filterFromId || filterToId || searchText.trim());
  const stale = list.loading || list.searchPending;

  return (
    <div
      style={{ flex: 1, justifyContent: "flex-start", width: "100%", maxWidth: "100vw", overflowX: "hidden" }}
    >
      <div style={styles.container}>
        <div style={styles.periodRow}>
          {dateFiltersType !== DateFiltersValues.ALL && (
            <ArrowButton direction="left" onClick={() => previousPeriod()} />
          )}
          <div style={styles.periodLabel}>
            {dateFiltersType === DateFiltersValues.YEARMONTH && `${monthName(month)} ${year}`}
            {dateFiltersType === DateFiltersValues.YEAR && `${year}`}
            {dateFiltersType === DateFiltersValues.ALL && t("period.all")}
          </div>
          {dateFiltersType !== DateFiltersValues.ALL && (
            <ArrowButton direction="right" onClick={() => nextPeriod()} />
          )}
        </div>

        {/* Search and sorting */}
        <div style={styles.filterRow}>
          <div
            onClick={() => setIsSearchOpen((v) => !v)}
            title={t("transaction.search")}
            style={{
              ...styles.pill,
              ...styles.iconPill,
              backgroundColor: isSearchOpen || searchText ? mainColor : "var(--chip-bg)",
              color: isSearchOpen || searchText ? "white" : "var(--text)",
            }}
          >
            <FiSearch size={16} />
          </div>
          {[
            { key: "date", label: t("common.date") },
            { key: "amount", label: t("common.amount") },
          ].map(({ key, label }) => {
            const isActive = sortBy === key;
            return (
              <div
                key={key}
                onClick={() => {
                  // Clicking the criterion that is already active flips it.
                  if (isActive) setSortDir(sortDir === "desc" ? "asc" : "desc");
                  else setSortBy(key);
                }}
                style={{
                  ...styles.pill,
                  ...styles.sortPill,
                  backgroundColor: isActive ? mainColor : "var(--chip-bg)",
                  color: isActive ? "white" : "var(--text)",
                }}
              >
                {label}
                {isActive &&
                  (sortDir === "desc" ? <FiArrowDown size={14} /> : <FiArrowUp size={14} />)}
              </div>
            );
          })}
        </div>

        {isSearchOpen && (
          <div style={styles.searchRow}>
            <input
              ref={searchInputRef}
              type="text"
              value={searchText}
              placeholder={t("transaction.searchPlaceholder")}
              onChange={(e) => setSearchText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Escape") return;
                // The first Escape clears, the second closes the bar.
                if (searchText) setSearchText("");
                else setIsSearchOpen(false);
              }}
              style={styles.searchInput}
            />
            <div
              onClick={() => {
                setSearchText("");
                setIsSearchOpen(false);
              }}
              style={styles.searchClear}
            >
              <FiX size={18} />
            </div>
          </div>
        )}

        {/* Date presets */}
        <div style={styles.filterRow}>
          {[
            { key: DateFiltersValues.YEARMONTH, label: t("common.month") },
            { key: DateFiltersValues.YEAR, label: t("summary.year") },
            { key: DateFiltersValues.ALL, label: t("period.all") },
          ].map(({ key, label }) => (
            <div
              key={key}
              onClick={() => setDateFiltersType(key)}
              style={{
                ...styles.pill,
                backgroundColor: dateFiltersType === key ? mainColor : "var(--chip-bg)",
                color: dateFiltersType === key ? "white" : "var(--text)",
              }}
            >
              {label}
            </div>
          ))}
        </div>

        {/* Type filters */}
        <div style={styles.filterRow}>
          {[
            { type: 1, label: t("common.expenses"), color: "var(--negative-fill)" },
            { type: 2, label: t("common.income"), color: "var(--positive-fill)" },
            { type: 3, label: t("common.transfers"), color: secondaryColor },
          ].map(({ type, label, color }) => (
            <div
              key={type}
              onClick={() => setFilterType(filterType === type ? null : type)}
              style={{
                ...styles.pill,
                backgroundColor: filterType === type ? color : "var(--chip-bg)",
                color: filterType === type ? "white" : "var(--text)",
              }}
            >
              {label}
            </div>
          ))}
        </div>

        {/* From / to filters: every account and category that occurs in the
            period, whatever the other filters say, as before. */}
        <div style={styles.selectRow}>
          <div style={styles.selectWrapper}>
            <Select
              options={fromOptions}
              value={fromOptions.find(o => o.value === filterFromId) || null}
              onChange={(opt) => setFilterFromId(opt ? opt.value : null)}
              isClearable
              placeholder={t("picker.from")}
              styles={selectStyles}
              theme={selectTheme}
            />
          </div>
          <div style={styles.selectWrapper}>
            <Select
              options={toOptions}
              value={toOptions.find(o => o.value === filterToId) || null}
              onChange={(opt) => setFilterToId(opt ? opt.value : null)}
              isClearable
              placeholder={t("picker.to")}
              styles={selectStyles}
              theme={selectTheme}
            />
          </div>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "row",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          {canWrite && (
          <div
            onClick={() => {
              setTransaction(null);
              setDraft(null);
              setSavePath(null);
              setOpen(true);
            }}
            style={styles.buttonAdd}
          >
            <div
              style={{
                textAlign: "center",
                textAlignVertical: "center",
                fontSize: 30,
                color: "white",
              }}
            >
              +
            </div>
          </div>
          )}
        </div>
        {/* Drafts from the phone, when there are any: discreet, one tap away. */}
        {canWrite && inbox.length > 0 && (
          <div style={styles.inboxRow}>
            <button type="button" style={styles.inboxBadge} onClick={() => setInboxOpen(true)}>
              {inbox.length === 1 ? t("inbox.pendingOne") : t("inbox.pending", { n: inbox.length })}
            </button>
          </div>
        )}
        {/* The totals are the API's, over everything the filters select --
            not only the rows loaded so far. */}
        <div style={styles.sumsContainer}>
          <Amount size={30} amount={list.totIn} color={"var(--positive)"} isAbs={false} />
          <Amount size={30} amount={list.totOut * -1} color={"var(--negative)"} isAbs={false} />
        </div>
        <div style={{ borderWidth: 1, width: "100%", marginVertical: 0 }}></div>
        {list.items.length ? (
          <div
            aria-busy={stale}
            style={{ flex: 1, width: "100%", marginBottom: 8, opacity: stale ? 0.55 : 1, transition: "opacity 0.15s" }}
          >
            {list.flat ? (
              <TransactionFlatRows items={list.items} onPress={handleUpdate} />
            ) : (
              list.items.map((item) => (
                <TransactionDayRows
                  key={item.id}
                  items={item.data}
                  date={item.id}
                  onPress={handleUpdate}
                />
              ))
            )}
            {/* The marker the observer watches, and the same thing as a
                button for whoever gets here with the keyboard -- or with a
                browser that has no IntersectionObserver. */}
            <div ref={sentinelRef} style={{ height: 1 }} />
            {nextCursor && (
              <div style={styles.moreRow}>
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={list.loadingMore}
                  style={styles.moreButton}
                >
                  {list.loadingMore ? "…" : t("transaction.loadMore")}
                </button>
              </div>
            )}
          </div>
        ) : (
          <div
            style={{ flex: 1, justifyContent: "center", alignItems: "center" }}
          >
            <div style={{ fontSize: 20, color: secondaryColor, opacity: stale ? 0.55 : 1 }}>
              {hasFilters ? t("transaction.noneFound") : t("transaction.noneYet")}
            </div>
          </div>
        )}
      </div>
      <Modal isOpen={open} onClose={closeForm} label={t("modal.transactionDetail")}>
        {/* Bank mode stops at the form: the amount there is the one being
            typed, and the balances in the pickers are what it is typed from. */}
        <BlurExemptContext.Provider value={true}>
          <Suspense fallback={<Loading />}>
            <TransactionForm
              closeForm={closeForm}
              transaction={transaction}
              draft={draft}
              savePath={savePath}
              onSaved={afterWrite}
              onDelete={canWrite ? handleDelete : null}
            />
          </Suspense>
        </BlurExemptContext.Provider>
      </Modal>
      <Modal isOpen={inboxOpen} onClose={() => setInboxOpen(false)} label={t("modal.inbox")}>
        <InboxPanel
          items={inbox}
          busyId={inboxBusy}
          onReview={reviewInboxItem}
          onAccept={acceptInboxItem}
          onDismiss={dismissInboxItem}
          walletCurrency={walletCurrency}
        />
      </Modal>
    </div>
  );
}

const styles = {
  container: {
    flex: 1,
    backgroundColor: "var(--bg)",
    alignItems: "center",
    justifyContent: "flex-start",
    width: "85%",
    margin: "0 auto",
  },
  periodRow: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    margin: 10,
  },
  periodLabel: {
    fontSize: 30,
  },
  sumsContainer: {
    flexDirection: "row",
    justifyContent: "space-between",
    display: "flex",
    alignItems: "center",
    margin: 10,
  },
  buttonAdd: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: mainColor,
    display: "flex",
    justifyContent: "center",
    alignItems: "center",
  },
  filterRow: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    alignItems: "center",
    gap: 8,
    marginBottom: 8,
    width: "100%",
    padding: "0 10px",
  },
  pill: {
    padding: "6px 14px",
    borderRadius: 20,
    cursor: "pointer",
    fontSize: 14,
    fontWeight: "bold",
    userSelect: "none",
    whiteSpace: "nowrap",
  },
  selectRow: {
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 8,
    width: "100%",
    padding: "0 10px",
  },
  selectWrapper: {
    flex: 1,
    minWidth: 140,
  },
  iconPill: {
    display: "flex",
    alignItems: "center",
    padding: "6px 12px",
  },
  sortPill: {
    display: "flex",
    alignItems: "center",
    gap: 4,
  },
  searchRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    width: "100%",
    marginBottom: 8,
    padding: "0 10px",
    boxSizing: "border-box",
  },
  searchInput: {
    flex: 1,
    padding: "8px 12px",
    fontSize: 14,
    border: "1px solid var(--border-strong)",
    borderRadius: 6,
    boxSizing: "border-box",
  },
  searchClear: {
    display: "flex",
    alignItems: "center",
    cursor: "pointer",
    color: secondaryColor,
  },
  inboxRow: {
    display: "flex",
    justifyContent: "center",
    marginTop: 10,
  },
  inboxBadge: {
    padding: "5px 14px",
    borderRadius: 16,
    border: `1px solid ${mainColor}`,
    backgroundColor: "var(--surface)",
    color: mainColor,
    fontSize: 13,
    fontWeight: "bold",
    cursor: "pointer",
  },
  moreRow: {
    display: "flex",
    justifyContent: "center",
    padding: "16px 0",
  },
  moreButton: {
    padding: "8px 18px",
    borderRadius: 20,
    border: `1px solid ${mainColor}`,
    backgroundColor: "var(--surface)",
    color: mainColor,
    fontWeight: "bold",
    cursor: "pointer",
  },
};

const selectStyles = {
  container: (base) => ({ ...base, fontSize: 14 }),
  control: (base) => ({ ...base, minHeight: 36 }),
};
