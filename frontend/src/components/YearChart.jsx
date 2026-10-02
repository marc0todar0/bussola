import Chart from "react-apexcharts";
import { toMoneyFormat } from "../utils/generic";
import { compactAmount } from "../utils/amountFormat";
import { AMOUNT_MASK, useAmountBlur } from "../utils/blur";
import { useThemeColors } from "../utils/theme";
import { safeChartOptions } from "../utils/chartText";
import { useT } from "../i18n";

// Income against expenses, month by month. It has to be readable on a phone
// first: the year view is what somebody opens on the way home, and the widest
// thing on that screen used to be the y axis rather than the chart.
export default function YearChart({ data }) {
  const { t, monthName, formatAmount } = useT();
  // A tooltip only appears when somebody hovers, but hovering is cheap and a
  // figure that survives bank mode makes the feature a lie. It is masked too.
  const hidden = useAmountBlur();
  // Apex wants literal colours, not var(): these are the tokens resolved for
  // the theme on screen, and reading them re-renders the chart when it changes.
  const c = useThemeColors();

  // The month abbreviations come from Intl, so they follow the interface
  // language without a list of names living in this file.
  const categories = Array.from({ length: 12 }, (_, i) => monthName(i + 1, "short"));

  // Its two series are named by the catalogues, not by anybody's data, but
  // every chart goes through safeChartOptions so the next one cannot forget.
  const options = safeChartOptions({
    chart: {
      type: "line",
      zoom: { enabled: false },
      toolbar: { show: false },
      // Apex reserves room above the plot for a toolbar that is not there.
      parentHeightOffset: 0,
      // The card behind shows through; foreColor is every axis label's colour.
      background: "transparent",
      foreColor: c.textMuted,
    },
    // Apex's own dark mode, for the tooltip and the parts it draws itself.
    theme: { mode: c.mode },
    // The same green and red as the totals above the chart, so the line and
    // the figure it explains are visibly the same thing in either theme.
    colors: [c.positive, c.negative],
    dataLabels: { enabled: false },
    stroke: { curve: "smooth", width: 3 },
    title: {
      text: t("summary.chartTitle"),
      align: "left",
      // Not the theme's secondary grey: this is a heading, and at 15px that
      // grey reads as a caption that has been disabled.
      style: { fontSize: "15px", fontWeight: 600, color: c.text },
    },
    grid: {
      // Grid lines are furniture: they were drawn in the interface blue, which
      // is the colour that means "you can touch this", and banded rows added a
      // second pattern to read on top of the two the chart already has.
      borderColor: c.border,
      strokeDashArray: 4,
      padding: { left: 4, right: 8, bottom: 0 },
    },
    // A dot on every month is noise on a line that already has twelve of them;
    // the one under the finger is the only one worth drawing.
    markers: { size: 0, hover: { size: 5 } },
    xaxis: {
      categories,
      // Twelve three-letter months fit across a phone once the y axis stops
      // spending a quarter of the width on decimals, so they can lie flat
      // instead of standing at 45 degrees. The narrowest screens drop every
      // other one rather than tilting the lot.
      labels: {
        rotate: 0,
        rotateAlways: false,
        hideOverlappingLabels: true,
        style: { fontSize: "11px" },
      },
      axisTicks: { show: false },
      tooltip: { enabled: false },
    },
    yaxis: {
      // "20K", not "20,000.00": the exact figure is in the tooltip and in the
      // totals above the chart, and neither needed repeating four times down
      // the side. Apex would otherwise print English grouping in every
      // language, so the formatter is not optional either.
      // Masked in bank mode as well. The shape of the line still says the
      // month was better than the last one -- that much is inherent in drawing
      // a chart at all -- but the scale down the side is a figure, and a
      // figure is what this hides.
      labels: {
        formatter: (v) => (hidden ? AMOUNT_MASK : compactAmount(v)),
        style: { fontSize: "11px" },
      },
      tickAmount: 4,
    },
    tooltip: {
      theme: c.mode,
      y: { formatter: (v) => (hidden ? AMOUNT_MASK : formatAmount(v)) },
    },
    legend: {
      position: "top",
      horizontalAlign: "right",
      // It used to float over the title, which on a phone meant the two words
      // of the legend sat on top of the last two words of the heading.
      floating: false,
      offsetY: 0,
      markers: { width: 10, height: 10, radius: 10 },
      fontSize: "13px",
      labels: { colors: c.text },
    },
    // Both axis titles are gone for good, at every width: one said "Month"
    // over twelve month names and the other said "Amount" beside a column of
    // money. On a phone the rest gives way too -- the legend drops under the
    // plot, where it cannot land on the heading whatever the language does to
    // the length of either.
    responsive: [
      {
        breakpoint: 768,
        options: {
          chart: { height: 260 },
          stroke: { width: 2.5 },
          title: { style: { fontSize: "14px" } },
          legend: { position: "bottom", horizontalAlign: "center", fontSize: "12px" },
          xaxis: { labels: { style: { fontSize: "10px" } } },
        },
      },
    ],
  });

  const series = [
    { name: t("common.income"), data: data.income.map((k) => toMoneyFormat(k.total)) },
    { name: t("common.expenses"), data: data.expenses.map((k) => toMoneyFormat(k.total)) },
  ];

  return (
    <div style={{ width: "100%" }}>
      {/* The height has to be a prop: react-apexcharts defaults it to "auto"
          and that default wins over options.chart.height. */}
      <Chart options={options} series={series} type="line" height={320} />
    </div>
  );
}
