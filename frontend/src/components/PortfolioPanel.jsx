import { useContext, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import Chart from "react-apexcharts";
import GlobalContext from "../context/GlobalContext";
import CategoryPieChart from "./CategoryPieChart";
import { Blurrable, currencyFormat } from "./Amount";
import { AMOUNT_MASK, useAmountBlur } from "../utils/blur";
import { mainColor, secondaryColor } from "../config";
import { DIVERSIF_CHARTS, DIVERSIF_GROUPS, toDonut } from "../utils/portfolioConfig";
import { useThemeColors } from "../utils/theme";
import { safeChartOptions } from "../utils/chartText";
import { useT } from "../i18n";

// The total's line used to be a constant near-black; it is --chart-total now,
// which is near-white on a dark page, where near-black would vanish.

const RANGES = [
  { labelKey: "portfolio.range.1y", years: 1 },
  { labelKey: "portfolio.range.3y", years: 3 },
  { labelKey: "portfolio.range.5y", years: 5 },
  { labelKey: "portfolio.range.all", years: null },
];

export default function PortfolioPanel({ refreshKey }) {
  const { fetchAuth } = useContext(GlobalContext);
  const { t, tLookup, monthName, formatPercent, moneySymbol } = useT();
  // The percentage changes down the list stay legible: a share is not an
  // amount, and hiding it would cost the whole point of the column while
  // hiding nothing anybody could not already see in the shape of the chart.
  const hidden = useAmountBlur();
  // The line chart's colours as literals, re-read whenever the theme changes.
  const themeColors = useThemeColors();
  const navigate = useNavigate();

  const [alloc, setAlloc] = useState({ total: 0, data: [] });
  const [history, setHistory] = useState([]);
  const [diversif, setDiversif] = useState({}); // key -> { total, data }
  const [rangeYears, setRangeYears] = useState(3); // default: the last 3 years

  const load = async () => {
    try {
      const [aRes, hRes, ...dRes] = await Promise.all([
        fetchAuth(`/portfolio/allocation`),
        fetchAuth(`/portfolio/history`),
        ...DIVERSIF_CHARTS.map((c) =>
          fetchAuth(c.url)
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null),
        ),
      ]);
      if (aRes.ok) setAlloc(await aRes.json());
      if (hRes.ok) setHistory(await hRes.json());
      const map = {};
      DIVERSIF_CHARTS.forEach((c, i) => {
        map[c.key] = dRes[i];
      });
      setDiversif(map);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // Current allocation donut
  const donutData = (alloc.data || [])
    .filter((d) => Number(d.value) > 0)
    .map((d) => ({ name: tLookup(d), color: d.color, total: d.value }));

  // Pillar metadata (id -> name/colour) taken from the allocation donut.
  const pillars = alloc.data || [];

  // --- History: one row per period (year-month) ---
  const { periods, byPeriod } = useMemo(() => {
    const list = [];
    const map = {};
    history.forEach((r) => {
      const k = `${r.year}-${String(r.month).padStart(2, "0")}`;
      if (!map[k]) list.push(k);
      map[k] = r;
    });
    list.sort();
    return { periods: list, byPeriod: map };
  }, [history]);

  // Range filter (the last N years from today)
  const filteredPeriods = useMemo(() => {
    if (!rangeYears) return periods;
    const cutoff = new Date();
    cutoff.setFullYear(cutoff.getFullYear() - rangeYears);
    return periods.filter((k) => {
      const [y, m] = k.split("-").map(Number);
      return new Date(y, m - 1, 1) >= cutoff;
    });
  }, [periods, rangeYears]);

  const periodTimestamp = (k) => {
    const [y, m] = k.split("-").map(Number);
    return new Date(y, m - 1, 1).getTime();
  };
  const totalByPeriod = (k) => Number(byPeriod[k]?.total) || 0;
  const pillarValue = (k, id) => Number(byPeriod[k]?.[`value_p${id}`]) || 0;

  // Series: the total (highlighted) plus one per pillar
  const pillarSeries = pillars.map((p) => ({
    name: tLookup(p),
    data: filteredPeriods.map((k) => ({
      x: periodTimestamp(k),
      y: Number(pillarValue(k, p.id).toFixed(2)),
    })),
  }));
  const totalSeries = {
    name: t("common.total"),
    data: filteredPeriods.map((k) => ({
      x: periodTimestamp(k),
      y: Number(totalByPeriod(k).toFixed(2)),
    })),
  };
  const series = [totalSeries, ...pillarSeries];
  // "#888" is the fallback for a pillar with no colour of its own: a mid grey
  // that reads on both themes, and a literal because Apex cannot take a var().
  const colors = [themeColors.chartTotal, ...pillars.map((p) => p.color || "#888")];
  const widths = [4, ...pillarSeries.map(() => 2)];

  // One series per pillar, and a pillar can be named by whoever created it:
  // the legend and tooltip escape the names (utils/chartText.js).
  const lineOptions = safeChartOptions({
    chart: {
      type: "line",
      toolbar: { show: false },
      zoom: { enabled: false },
      background: "transparent",
      foreColor: themeColors.textMuted,
    },
    theme: { mode: themeColors.mode },
    grid: { borderColor: themeColors.border },
    colors,
    dataLabels: { enabled: false },
    stroke: { curve: "smooth", width: widths },
    markers: { size: 0, hover: { size: 4 } },
    title: { text: t("portfolio.trend"), align: "left", style: { color: themeColors.text } },
    xaxis: {
      type: "datetime",
      labels: { datetimeUTC: false, format: "MMM yy" },
      tickAmount: 8,
    },
    yaxis: {
      // The axis title names the unit instead of printing an amount in it, so
      // it takes the symbol as a variable. The catalogues used to spell "(€)"
      // into the translation itself, which made the euro part of six
      // languages rather than part of the data.
      title: { text: t("portfolio.valueIn", { currency: moneySymbol() }) },
      labels: { formatter: (v) => (hidden ? AMOUNT_MASK : currencyFormat(v)) },
    },
    tooltip: {
      theme: themeColors.mode,
      x: { format: "MMM yyyy" },
      y: { formatter: (v) => (hidden ? AMOUNT_MASK : currencyFormat(v)) },
    },
    legend: { position: "bottom", labels: { colors: themeColors.text } },
  });

  // Snapshot list (newest first) with the % change against the previous period
  const list = filteredPeriods
    .map((k, i) => {
      const tot = totalByPeriod(k);
      const prevK = filteredPeriods[i - 1];
      const prevTot = prevK != null ? totalByPeriod(prevK) : null;
      const perc = prevTot && prevTot !== 0 ? ((tot - prevTot) / prevTot) * 100 : null;
      const [y, m] = k.split("-").map(Number);
      return { k, year: y, month: m, label: `${monthName(m)} ${y}`, tot, perc };
    })
    .reverse();

  const hasHistory = series.length > 0 && filteredPeriods.length > 0;

  return (
    <div style={styles.wrapper}>
      <div style={styles.sectionTitle}>{t("portfolio.assetAllocation")}</div>
      <CategoryPieChart data={donutData} title={t("portfolio.pillars")} total={alloc.total} />

      <div style={styles.rangeRow}>
        {RANGES.map((r) => (
          <div
            key={r.labelKey}
            onClick={() => setRangeYears(r.years)}
            style={{
              ...styles.rangePill,
              backgroundColor: rangeYears === r.years ? mainColor : "var(--chip-bg)",
              color: rangeYears === r.years ? "white" : "var(--text)",
            }}
          >
            {t(r.labelKey)}
          </div>
        ))}
      </div>

      {hasHistory ? (
        <div style={{ width: "95%", margin: "10px auto" }}>
          <Chart options={lineOptions} series={series} type="line" height={340} />
        </div>
      ) : (
        <div style={{ color: secondaryColor, fontSize: 14, marginTop: 8 }}>
          {t("portfolio.noSnapshots")}
        </div>
      )}

      <div style={styles.sectionTitle}>{t("portfolio.diversification")}</div>
      {DIVERSIF_GROUPS.map((groupKey) => {
        const charts = DIVERSIF_CHARTS.filter(
          (c) => c.groupKey === groupKey && (diversif[c.key]?.data || []).length > 0,
        );
        if (charts.length === 0) return null;
        return (
          <div key={groupKey} style={styles.diversifGroup}>
            <div style={styles.diversifGroupTitle}>{t(groupKey)}</div>
            <div style={styles.diversifRow}>
              {charts.map((c) => (
                <div key={c.key} style={styles.diversifCell}>
                  <CategoryPieChart
                    data={toDonut(diversif[c.key], tLookup)}
                    title={t(c.titleKey)}
                    total={diversif[c.key]?.total}
                  />
                </div>
              ))}
            </div>
          </div>
        );
      })}

      {/* The snapshot list at the bottom: clicking a row opens its frozen detail */}
      {hasHistory && (
        <>
          <div style={styles.sectionTitle}>{t("portfolio.snapshots")}</div>
          <div style={styles.list}>
            {list.map((row) => (
              <div
                key={row.k}
                data-nav-row
                style={styles.listRow}
                onClick={() => navigate(`/portfolio/snapshot/${row.year}/${row.month}`)}
                title={t("portfolio.openSnapshot")}
              >
                <div style={styles.listLabel}>{row.label}</div>
                <div style={styles.listVal}>
                  {/* The snapshot totals are the headline figures of this
                      screen and are readable without hovering anything, which
                      is precisely what bank mode is for. */}
                  <Blurrable>{currencyFormat(row.tot)}</Blurrable>
                </div>
                <div
                  style={{
                    ...styles.listPerc,
                    color:
                      row.perc == null || Math.abs(row.perc) < 0.005
                        ? secondaryColor
                        : row.perc > 0
                          ? "var(--positive)"
                          : "var(--negative)",
                  }}
                >
                  {row.perc == null
                    ? "—"
                    : `${formatPercent(Math.abs(row.perc) < 0.005 ? 0 : row.perc)}%`}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

const styles = {
  wrapper: {
    width: "100%",
    marginTop: 24,
    borderTop: `2px solid ${mainColor}`,
    paddingTop: 12,
  },
  sectionTitle: {
    fontSize: 18,
    fontWeight: "bold",
    textAlign: "center",
    marginBottom: 6,
    marginTop: 18,
  },
  rangeRow: {
    display: "flex",
    flexDirection: "row",
    justifyContent: "center",
    gap: 8,
    marginTop: 8,
  },
  rangePill: {
    padding: "6px 16px",
    borderRadius: 20,
    fontWeight: "bold",
    cursor: "pointer",
    userSelect: "none",
    fontSize: 14,
  },
  diversifGroup: { marginTop: 12 },
  diversifGroupTitle: {
    fontSize: 15,
    fontWeight: "bold",
    color: "var(--text-secondary)",
    margin: "8px 0 4px",
    borderLeft: `4px solid ${mainColor}`,
    paddingLeft: 8,
  },
  diversifRow: {
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
  },
  diversifCell: {
    flex: "1 1 320px",
    maxWidth: 460,
    minWidth: 280,
  },
  list: {
    width: "100%",
    display: "flex",
    flexDirection: "column",
    gap: 4,
    marginBottom: 32,
  },
  listRow: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    padding: "8px 10px",
    border: "1px solid var(--border-soft)",
    borderRadius: 8,
    cursor: "pointer",
  },
  listLabel: { flex: 1, fontSize: 15, fontWeight: "bold", color: "var(--text)" },
  listVal: { fontSize: 15, fontWeight: "bold", minWidth: 120, textAlign: "right" },
  listPerc: { fontSize: 14, fontWeight: "bold", minWidth: 90, textAlign: "right" },
};
