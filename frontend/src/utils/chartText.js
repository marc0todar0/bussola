// ---------------------------------------------------------------------------
// Text that goes into a chart
// ---------------------------------------------------------------------------
// ApexCharts writes some of what it is given with innerHTML: the legend, and
// the tooltip's series name and value (apexcharts 4.7, modules/legend/Legend.js
// and modules/tooltip/Labels.js). Those names are not ours -- they are
// categories, accounts, holdings, issuers and countries somebody typed, in a
// wallet other people read. A category called <img src=x onerror=...> would run
// its script in the browser of every member who opens the summary, with their
// session. So every string that reaches one of those places is escaped here,
// on its way into the chart.
//
// Escaped at the boundary rather than when the name is saved: the data stays
// what the person typed, React already renders it safely everywhere else, and
// only this one consumer needs HTML. The SVG parts of a chart (titles, axis
// labels, the name in the middle of a donut) are set as text by Apex itself,
// so the names go in raw and only these formatters escape -- escaping the
// labels array instead would print "&amp;" in the middle of the donut.
//
// Plain JavaScript with no imports, so the security test (api/test/
// security.js) can load it under Node and check it without a browser.

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

export const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ENTITIES[c]);

// Wraps a formatter so whatever it returns is escaped; without one, escapes
// the value it is handed.
const escaping = (formatter) => (value, ...rest) =>
  escapeHtml(typeof formatter === "function" ? formatter(value, ...rest) : value);

// Apex's own default for the series name in a tooltip: "Name: " before the
// value. Replacing the formatter replaces the default, so it is spelled out.
const defaultTitle = (name) => (name ? `${name}: ` : "");

// Returns the options with every HTML-bound formatter escaping: the legend,
// the tooltip's series name (tooltip.y.title), its value (tooltip.y), and the
// tooltip title when a formatter supplies it (tooltip.x). A formatter the
// caller already set keeps working, and its result is escaped as well.
// Every chart in the application is built through this.
export const safeChartOptions = (options = {}) => {
  const legend = options.legend || {};
  const tooltip = options.tooltip || {};
  const y = tooltip.y || {};
  const x = tooltip.x || {};

  return {
    ...options,
    legend: { ...legend, formatter: escaping(legend.formatter) },
    tooltip: {
      ...tooltip,
      // tooltip.x only when there is a formatter to wrap: adding one where
      // there was none would override `format` (the date pattern on the
      // portfolio chart). Without a formatter the title is Apex's own date or
      // category text, never a name.
      ...(typeof x.formatter === "function" ? { x: { ...x, formatter: escaping(x.formatter) } } : {}),
      y: {
        ...y,
        // The value: an amount from Intl in every chart here, but it lands in
        // innerHTML all the same. Only wrapped when there is a formatter --
        // Apex's own default does the number formatting when there is not.
        ...(typeof y.formatter === "function" ? { formatter: escaping(y.formatter) } : {}),
        title: {
          ...(y.title || {}),
          formatter: escaping((y.title && y.title.formatter) || defaultTitle),
        },
      },
    },
  };
};
