import { useT } from "../i18n";

// A strip above the tab bar, in the demo build only (App.jsx loads it when
// __DEMO__ is true): nobody should type real figures into a page that forgets
// them on reload, or take the invented ones for somebody's finances.
const style = {
  padding: "6px 12px",
  fontSize: 13,
  lineHeight: 1.4,
  textAlign: "center",
  color: "var(--text)",
  background: "color-mix(in srgb, #f5a623 20%, var(--surface))",
  borderBottom: "1px solid var(--border)",
};

export default function DemoBanner() {
  const { t } = useT();
  return (
    <div role="note" style={style}>
      {t("demo.banner")}
    </div>
  );
}
