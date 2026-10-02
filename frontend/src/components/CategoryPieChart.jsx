import Chart from "react-apexcharts";
import { currencyFormat } from "./Amount";
import { AMOUNT_MASK, useAmountBlur } from "../utils/blur";
import { secondaryColor } from "../config";
import { useThemeColors } from "../utils/theme";
import { safeChartOptions } from "../utils/chartText";
import { useT } from "../i18n";

export default function CategoryPieChart({ data, title, total }) {
  const { t, formatPercent } = useT();
  // The percentages stay: a share of the whole is not an amount, and it is the
  // shape of the chart anyway. The figures in the tooltip, in the slice value
  // and in the middle of the donut are amounts, and the last of the three is
  // on screen without anybody hovering.
  const hidden = useAmountBlur();
  // Called before the early return: a hook cannot be skipped on some renders.
  const c = useThemeColors();

  if (!data || data.length === 0) {
    return (
      <div style={styles.empty}>
        <div style={{ fontSize: 18, color: secondaryColor }}>
          {t("chart.noData", { title: title?.toLowerCase() })}
        </div>
      </div>
    );
  }

  const labels = data.map((d) => d.name ?? t("common.unspecified"));
  const colors = data.map((d) => d.color || "#888");
  const series = data.map((d) => Number(d.total) || 0);

  // The slices keep the reader's own colours in both themes -- they are data --
  // and so does the white of the percentages printed on them. What follows the
  // theme is everything around the slices: the gaps between them (drawn in the
  // card's colour, so on a dark card they are not white seams), the title, the
  // legend and the figures in the hole.
  //
  // The labels are names people typed, and Apex puts the legend and the
  // tooltip on the page as HTML: safeChartOptions escapes them there.
  const options = safeChartOptions({
    chart: { type: "donut", background: "transparent", foreColor: c.textMuted },
    theme: { mode: c.mode },
    labels,
    colors,
    stroke: { colors: [c.surface] },
    legend: { position: "bottom", labels: { colors: c.text } },
    title: { text: title, align: "center", style: { fontSize: "18px", color: c.text } },
    dataLabels: {
      enabled: true,
      // A share of the whole: one decimal, and no plus sign in front of it.
      formatter: (val) => `${formatPercent(val, { digits: 1, sign: "auto" })}%`,
    },
    tooltip: {
      theme: c.mode,
      y: { formatter: (val) => (hidden ? AMOUNT_MASK : currencyFormat(val)) },
    },
    plotOptions: {
      pie: {
        donut: {
          labels: {
            show: true,
            name: { color: c.textMuted },
            value: {
              color: c.text,
              formatter: (val) => (hidden ? AMOUNT_MASK : currencyFormat(val)),
            },
            total: {
              show: true,
              color: c.textMuted,
              label: t("common.total"),
              formatter: () => (hidden ? AMOUNT_MASK : currencyFormat(total || 0)),
            },
          },
        },
      },
    },
    responsive: [{ breakpoint: 600, options: { legend: { position: "bottom" } } }],
  });

  return (
    <div style={styles.wrapper}>
      <Chart options={options} series={series} type="donut" height={380} />
    </div>
  );
}

const styles = {
  wrapper: { width: "95%", margin: "10px auto" },
  empty: { display: "flex", justifyContent: "center", alignItems: "center", padding: 40 },
};
