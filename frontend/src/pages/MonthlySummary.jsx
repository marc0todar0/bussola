import { useContext, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import GlobalContext from "../context/GlobalContext";
import Loading from "../components/Loading";
import Amount from "../components/Amount";
import CategoryPieChart from "../components/CategoryPieChart";
import IconItem from "../components/IconItem";
import { mainColor, secondaryColor } from "../config";
import ArrowButton from "../components/ArrowButton";
import { FaChevronLeft } from "react-icons/fa";
import { useT } from "../i18n";
import { useKeyboardShortcut } from "../utils/useKeyboardShortcut";

export default function MonthlySummary() {
  const { fetchAuth, period } = useContext(GlobalContext);
  const { month, year, setMonth, setYear } = period;
  const { t, monthName } = useT();
  const [isLoading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [showExpenses, setShowExpenses] = useState(true);
  const navigate = useNavigate();

  // Only the latest request may write: see Summary.jsx.
  const latest = useRef(0);

  const fetchData = async () => {
    const mine = ++latest.current;
    setLoading(true);
    try {
      const response = await fetchAuth(
        `/summary/month?year=${year}&month=${month}`
      );
      const json = await response.json();
      if (mine !== latest.current) return;
      setData(json.sums || null);
    } catch (e) {
      console.error(e);
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  const prev = () => {
    if (month === 1) {
      setMonth(12);
      setYear(year - 1);
    } else setMonth(month - 1);
  };
  const next = () => {
    if (month === 12) {
      setMonth(1);
      setYear(year + 1);
    } else setMonth(month + 1);
  };

  // ← → move a month, like the arrow buttons. Above the loading return: a
  // hook must run on every render.
  useKeyboardShortcut(
    (e) => {
      if (e.key === "ArrowLeft") prev();
      else if (e.key === "ArrowRight") next();
    },
    [month, year],
  );

  // Clicking a category in the legend opens the transactions filtered by
  // month/year, type (expense/income) and category.
  const openTransactions = (c) => {
    // Month and year are already the ones in context: only the monthly filter
    // has to be forced.
    period.setDateFiltersType(period.DateFiltersValues.YEARMONTH);
    navigate("/transactions", {
      state: { filters: { type: Number(c.type_id), toId: Number(c.to_id) } },
    });
  };

  if (isLoading || !data) return <Loading />;

  const expenses = data.expenses || { data: [], total: 0 };
  const income = data.income || { data: [], total: 0 };
  const current = showExpenses ? expenses : income;
  const diff = (income.total || 0) - (expenses.total || 0);

  const sortedList = [...(current.data || [])].sort(
    (a, b) => Number(b.category_total) - Number(a.category_total),
  );

  const donutData = (current.data || []).map((c) => ({
    name: c.name,
    color: c.color,
    total: c.category_total,
  }));

  return (
    <div style={styles.container}>
      <div style={styles.headerRow}>
        <div onClick={() => navigate("/summary")} style={styles.backBtn}>
          <FaChevronLeft size={16} />
          <span>{t("summary.year")}</span>
        </div>
        <div style={styles.title}>
          {monthName(month)} {year}
        </div>
      </div>

      <div style={styles.monthNav}>
        <ArrowButton direction="left" onClick={prev} />
        <div style={styles.totals}>
          <Amount size={26} amount={diff} />
          <div style={styles.totalsRow}>
            <Amount size={18} amount={income.total} color="var(--positive)" />
            <Amount size={18} amount={-(expenses.total || 0)} color="var(--negative)" />
          </div>
        </div>
        <ArrowButton direction="right" onClick={next} />
      </div>

      <div style={styles.toggleRow}>
        <div
          onClick={() => setShowExpenses(true)}
          style={{
            ...styles.togglePill,
            backgroundColor: showExpenses ? "var(--negative-fill)" : "var(--chip-bg)",
            color: showExpenses ? "white" : "var(--text)",
          }}
        >
          {t("common.expenses")}
        </div>
        <div
          onClick={() => setShowExpenses(false)}
          style={{
            ...styles.togglePill,
            backgroundColor: !showExpenses ? "var(--positive-fill)" : "var(--chip-bg)",
            color: !showExpenses ? "white" : "var(--text)",
          }}
        >
          {t("common.income")}
        </div>
      </div>

      <CategoryPieChart
        key={showExpenses ? "expenses" : "income"}
        data={donutData}
        title={showExpenses ? t("common.expenses") : t("common.income")}
        total={current.total}
      />

      {sortedList.length > 0 && (
        <div style={styles.legend}>
          {sortedList.map((c) => (
            <div
              key={`${c.type_id}-${c.to_id}`}
              data-nav-row
              onClick={() => openTransactions(c)}
              title={t("summary.seeTransactionsMonth", {
                name: c.name,
                period: `${monthName(month)} ${year}`,
              })}
              style={styles.legendRow}
            >
              <IconItem
                icon={c.icon}
                family={c.icon_family}
                color={c.color}
                width={36}
                height={32}
                size={20}
              />
              <div style={styles.legendName}>{c.name}</div>
              <Amount
                size={16}
                amount={showExpenses ? -Number(c.category_total) : Number(c.category_total)}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    width: "95%",
    maxWidth: 900,
    margin: "0 auto",
    paddingBottom: 30,
  },
  // As in Portfolio.jsx: equal outer columns keep the title centred whatever
  // the back button's label measures.
  headerRow: {
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    columnGap: 8,
    width: "100%",
    margin: "10px 0",
  },
  backBtn: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifySelf: "start",
    gap: 6,
    fontSize: 16,
    color: mainColor,
    cursor: "pointer",
    fontWeight: "bold",
    border: `1px solid ${mainColor}`,
    padding: "8px 14px",
    borderRadius: 20,
    whiteSpace: "nowrap",
  },
  title: {
    fontSize: 26,
    fontWeight: "bold",
    textAlign: "center",
  },
  monthNav: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    margin: "10px 0 20px 0",
  },
  totals: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: 4,
  },
  totalsRow: {
    display: "flex",
    flexDirection: "row",
    gap: 14,
  },
  toggleRow: {
    display: "flex",
    flexDirection: "row",
    gap: 8,
    margin: "5px 0",
  },
  togglePill: {
    padding: "6px 18px",
    borderRadius: 20,
    fontWeight: "bold",
    cursor: "pointer",
    userSelect: "none",
  },
  legend: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 6,
    marginTop: 10,
  },
  legendRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    padding: 8,
    border: "1px solid var(--border-soft)",
    borderRadius: 8,
    cursor: "pointer",
  },
  legendName: {
    flex: 1,
    fontSize: 16,
    color: secondaryColor,
  },
};
