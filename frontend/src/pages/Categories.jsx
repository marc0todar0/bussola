import { useState, useEffect, useContext, useRef } from "react";
import CategoryCard from "../components/CategoryCard";
import Amount from "../components/Amount";
import GlobalContext from "../context/GlobalContext";
import Loading from "../components/Loading";
import Modal from "../components/Modal";
import AccountCategoryForm from "../components/AccountCategoryForm";
import { mainColor } from "../config";
import ArrowButton from "../components/ArrowButton";
import { useKeyboardShortcut } from "../utils/useKeyboardShortcut";
import { useCanWrite } from "../utils/useCanWrite";
import { useT } from "../i18n";
import toast from "react-hot-toast";
import { errorText } from "../utils/errorText";

export default function CategoriesScreen() {
  const { fetchAuth, categories, period, filters } = useContext(GlobalContext);
  const { t, monthName } = useT();
  const canWrite = useCanWrite();
  const [isLoading, setLoading] = useState(true);
  const [showExpenses, setShowExpenses] = useState(true);
  const { data, setData } = categories;
  const {
    month,
    year,
    nextPeriod,
    previousPeriod,
    getDateParams,
    dateFiltersType,
    DateFiltersValues,
  } = period;
  const { filterType } = filters;
  const { from, to } = getDateParams();

  const [selectedCategory, setSelectedCategory] = useState(null);
  const [open, setOpen] = useState(false);
  const [archived, setArchived] = useState([]);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    if (filterType === 1) setShowExpenses(true);
    else if (filterType === 2) setShowExpenses(false);
  }, [filterType]);

  // Only the latest request may write: flipping months quickly, or switching
  // between expenses and income, must not end on an older answer that arrived
  // late. It covers the reload after a save (onSaved) too.
  const latest = useRef(0);

  const getCategories = async () => {
    const mine = ++latest.current;
    // The spinner is for the first load only (isLoading starts true): a later
    // reload keeps the page, and any modal open on it, mounted while the new
    // figures arrive.
    try {
      const kind = showExpenses ? "expenses" : "income";
      // The active and the archived categories are independent: asked for
      // together rather than one after the other.
      const [response, responseArch] = await Promise.all([
        fetchAuth(`/categories/${kind}?from=${from}&to=${to}`),
        fetchAuth(`/categories/${kind}?from=${from}&to=${to}&archived=true`),
      ]);
      const [json, jsonArch] = await Promise.all([
        response.json().catch(() => null),
        responseArch.json().catch(() => null),
      ]);
      if (mine !== latest.current) return;
      // A refusal keeps what is on screen: its body has no list, and setting
      // it would crash every .map below.
      if (!response.ok || !json || !Array.isArray(json.data)) {
        if (response.status !== 401) toast.error(errorText(t, json, t("common.loadFailed")));
        return;
      }
      setData(json);
      if (responseArch.ok && jsonArch && Array.isArray(jsonArch.data)) setArchived(jsonArch.data);
    } catch (error) {
      console.error(error);
      if (mine === latest.current) toast.error(t("error.NETWORK_ERROR"));
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  };

  useEffect(() => {
    getCategories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showExpenses, from, to]);

  const openCategoryDetail = (cat) => {
    setSelectedCategory(cat);
    setOpen(true);
  };

  const openCreate = () => {
    setSelectedCategory(null);
    setOpen(true);
  };

  const closeForm = () => {
    setOpen(false);
    setSelectedCategory(null);
  };

  useKeyboardShortcut((e) => {
    if (open) return;
    if (e.key === "n" || e.key === "N") {
      if (canWrite) openCreate();
    } else if (e.key === "ArrowLeft" && dateFiltersType !== DateFiltersValues.ALL) {
      previousPeriod();
    } else if (e.key === "ArrowRight" && dateFiltersType !== DateFiltersValues.ALL) {
      nextPeriod();
    }
  }, [open, openCreate, canWrite, previousPeriod, nextPeriod, dateFiltersType, DateFiltersValues]);

  if (isLoading) {
    return <Loading />;
  }

  return (
    <div
      style={{ flex: 1, justifyContent: isLoading ? "center" : "flex-start" }}
    >
      <div style={styles.container}>
        <div
          style={{
            justifyContent: "center",
            alignItems: "center",
            cursor: "pointer",
          }}
          onClick={() => setShowExpenses(!showExpenses)}
        >
          <div
            style={{
              fontWeight: "bold",
              fontSize: 40,
            }}
          >
            {showExpenses ? t("common.expenses") : t("common.income")}
          </div>
          <Amount
            size={40}
            amount={showExpenses ? data.totOutMonth : data.totInMonth}
            color={showExpenses ? "var(--negative)" : "var(--positive)"}
          />
          <Amount
            size={20}
            amount={showExpenses ? data.totInMonth : data.totOutMonth}
            color={!showExpenses ? "var(--negative)" : "var(--positive)"}
          />
        </div>
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
        <div
          style={{
            display: "flex",
            flexDirection: "row",
            justifyContent: "center",
            cursor: "pointer",
          }}
        >
          {canWrite && (
          <div onClick={openCreate} style={styles.buttonAdd}>
            <div
              style={{
                textAlign: "center",
                fontSize: 30,
                color: "white",
              }}
            >
              +
            </div>
          </div>
          )}
        </div>
        <div style={{ width: "100%", margin: 20 }}>
          {(data.data || [])
            .sort((a, b) => b.sum - a.sum)
            .map((d) => (
              <CategoryCard
                key={d.id}
                category={d}
                handleTouch={openCategoryDetail}
                isExpenses={showExpenses}
              />
            ))}
        </div>

        {archived.length > 0 && (
          <div style={styles.archiveSection}>
            <div onClick={() => setShowArchived((s) => !s)} style={styles.archiveHeader}>
              {showArchived ? "▾" : "▸"} {t("category.archived", { count: archived.length })}
            </div>
            {showArchived && (
              <div style={{ width: "100%", opacity: 0.6 }}>
                {archived.map((d) => (
                  <CategoryCard
                    key={d.id}
                    category={d}
                    handleTouch={openCategoryDetail}
                    isExpenses={showExpenses}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      <Modal isOpen={open} onClose={closeForm} label={t("modal.categoryDetail")}>
        <AccountCategoryForm
          isCategory={true}
          item={selectedCategory}
          isExpenseDefault={showExpenses}
          closeForm={closeForm}
          onSaved={getCategories}
        />
      </Modal>
    </div>
  );
}

const styles = {
  container: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    // The page's own ground, not a card's: on dark the two differ, and a
    // surface here would paint a lighter band down the middle of the screen.
    backgroundColor: "var(--bg)",
    alignItems: "center",
    justifyContent: "flex-start",
    paddingVertical: 10,
    width: "90%",
    margin: "0 auto",
  },
  periodRow: {
    width: "90%",
    flexDirection: "row",
    display: "flex",
    justifyContent: "space-between",
    marginHorizontal: 30,
    marginVertical: 30,
  },
  periodLabel: {
    fontSize: 30,
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
  archiveSection: {
    width: "100%",
    marginTop: 24,
    borderTop: "1px solid var(--border-soft)",
    paddingTop: 8,
  },
  archiveHeader: {
    fontSize: 13,
    color: "var(--text-subtle)",
    cursor: "pointer",
    userSelect: "none",
    padding: "6px 0",
  },
};
