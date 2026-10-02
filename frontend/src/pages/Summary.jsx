import { useState, useEffect, useContext, useRef } from "react";
import { useNavigate } from "react-router-dom";
import GlobalContext from "../context/GlobalContext";
import { mainColor, secondaryColor } from "../config";
import Loading from "../components/Loading";
import Amount from "../components/Amount";
import ArrowButton from "../components/ArrowButton";
import YearChart from "../components/YearChart";
import CategoryPieChart from "../components/CategoryPieChart";
import IconItem from "../components/IconItem";
import { useKeyboardShortcut } from "../utils/useKeyboardShortcut";
import { useT } from "../i18n";

export default function Summary() {
  const { fetchAuth, period } = useContext(GlobalContext);
  const { t } = useT();
  const navigate = useNavigate();

  const [isLoading, setLoading] = useState(true);
  const [year, setYear] = useState(new Date().getFullYear());
  const [showExpenses, setShowExpenses] = useState(true);

  const from = year + "0101";
  const to = year + "1231";

  const [data, setData] = useState({ income: [], expenses: [], difference: [], totals: 0 });
  const [categoryData, setCategoryData] = useState(null);

  // Every load takes a number, and only the latest one may write: flipping
  // through the years quickly must end on the last year asked for, not on
  // whichever answer happened to arrive last.
  const latest = useRef(0);

  const fetchAll = async () => {
    const mine = ++latest.current;
    try {
      setLoading(true);
      const [summaryRes, yearRes] = await Promise.all([
        fetchAuth(`/summary?from=${from}&to=${to}`),
        fetchAuth(`/summary/year?year=${year}`),
      ]);
      const summary = summaryRes.ok ? await summaryRes.json() : null;
      const categories = yearRes.ok ? await yearRes.json() : null;
      if (mine !== latest.current) return;
      if (summary) setData(summary);
      if (categories) setCategoryData(categories);
    } catch (error) {
      console.error(error);
    } finally {
      if (mine === latest.current) setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  const switchYear = (newYear) => setYear(newYear);

  // Clicking a category in the legend opens the transactions filtered by year,
  // type (expense/income) and category.
  const openTransactions = (c) => {
    period.setYear(year);
    period.setDateFiltersType(period.DateFiltersValues.YEAR);
    navigate("/transactions", {
      state: { filters: { type: Number(c.type_id), toId: Number(c.to_id) } },
    });
  };

  useKeyboardShortcut(
    (e) => {
      if (e.key === "ArrowLeft") switchYear(year - 1);
      else if (e.key === "ArrowRight") switchYear(year + 1);
    },
    [year],
  );

  if (isLoading) return <Loading />;

  const expenses = categoryData?.expenses || { data: [], total: 0 };
  const income = categoryData?.income || { data: [], total: 0 };
  const current = showExpenses ? expenses : income;

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
      <div style={styles.container}>
        <div style={styles.periodRow}>
          <ArrowButton direction="left" onClick={() => switchYear(year - 1)} />
          <div style={styles.periodLabel}>{year}</div>
          <ArrowButton direction="right" onClick={() => switchYear(year + 1)} />
        </div>

        {/* The year is already between the arrows, and it was written again
            underneath as "Year: 2026" -- thirty bold pixels of a phone spent
            repeating the line above. What the three numbers were missing
            instead was any word saying which was which: a green figure beside
            a red one is a guess until it is labelled. */}
        <div style={styles.totals}>
          <div style={styles.totalsCaption}>{t("summary.net")}</div>
          <Amount size={32} amount={data.totals.difference} />

          <div style={styles.totalsRow}>
            <div style={styles.totalsCell}>
              <div style={styles.totalsCaption}>{t("common.income")}</div>
              <Amount size={20} amount={data.totals.income} color="var(--positive)" />
            </div>
            <div style={styles.totalsCell}>
              <div style={styles.totalsCaption}>{t("common.expenses")}</div>
              <Amount size={20} amount={data.totals.expenses} color="var(--negative)" />
            </div>
          </div>
        </div>

        {/* Below the money rather than above it: it is where you go next, not
            what you came to read. */}
        <div
          onClick={() => {
            period.setYear(year);
            navigate("/summary/month");
          }}
          style={styles.detailBtn}
        >
          {t("summary.monthlyDetail")}
        </div>
        <div style={{ marginTop: 30, width: "100%" }}>
          <YearChart data={data} />
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
                title={t("summary.seeTransactions", { year, name: c.name })}
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
    </div>
  );
}

const styles = {
  container: {
    flex: 1,
    display: "flex",
    flexDirection: "column",
    backgroundColor: "var(--bg)",
    alignItems: "center",
    justifyContent: "flex-start",
    width: "95%",
    margin: "0 auto",
    paddingBottom: 30,
  },
  periodRow: {
    // 95% wide *and* 30px of side margin overflowed a narrow screen, which is
    // what pushed the arrows towards the edges of a phone.
    width: "100%",
    flexDirection: "row",
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    margin: "14px 0 6px",
  },
  periodLabel: { fontSize: 30 },
  totals: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    width: "100%",
  },
  totalsRow: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "space-around",
    width: "100%",
    marginTop: 10,
    gap: 12,
  },
  totalsCell: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
  },
  // Small, grey and set above the figure: a caption has to be legible without
  // ever competing with the number it names.
  totalsCaption: {
    fontSize: 12,
    color: secondaryColor,
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  detailBtn: {
    fontSize: 18,
    color: mainColor,
    border: `1px solid ${mainColor}`,
    padding: "6px 16px",
    borderRadius: 10,
    cursor: "pointer",
    fontWeight: "bold",
    margin: "18px 0 4px",
  },
  toggleRow: {
    display: "flex",
    flexDirection: "row",
    gap: 8,
    margin: "20px 0 5px 0",
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
  legendName: { flex: 1, fontSize: 16, color: secondaryColor },
};
