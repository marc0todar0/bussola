import { Fragment, useEffect } from "react";
import { mainColor } from "../config";
import { useT } from "../i18n";

// Only the keys live here; every label is a translation key, so this table
// reads the same way in any language.
const SHORTCUTS = [
  {
    group: "help.group.tabs",
    items: [
      { key: "1", desc: "help.tab.accounts" },
      { key: "2", desc: "help.tab.categories" },
      { key: "3", desc: "help.tab.transactions" },
      { key: "4", desc: "help.tab.summary" },
      { key: "5", desc: "help.tab.settings" },
    ],
  },
  {
    group: "help.group.transactions",
    items: [
      { key: "N", desc: "help.tx.new" },
      { key: "/", desc: "help.tx.search" },
      { key: "← →", desc: "help.period.month" },
    ],
  },
  {
    group: "help.group.categories",
    items: [
      { key: "N", desc: "help.cat.new" },
      { key: "← →", desc: "help.period.month" },
    ],
  },
  {
    group: "help.group.accounts",
    items: [{ key: "N", desc: "help.account.new" }],
  },
  {
    group: "help.group.summary",
    items: [
      { key: "← →", desc: "help.period.year" },
      { key: "← →", desc: "help.period.monthDetail" },
    ],
  },
  {
    group: "help.group.calculator",
    items: [
      { key: "0–9 + - * / .", desc: "help.calc.digit" },
      { key: "Enter", desc: "help.calc.confirm" },
      { key: "Backspace", desc: "help.calc.backspace" },
      { key: "Delete", desc: "help.calc.clear" },
      { key: "Esc", desc: "help.calc.close" },
    ],
  },
  {
    group: "help.group.form",
    items: [
      { key: "S E T", desc: "help.form.types" },
      { key: "D", desc: "help.form.from" },
      { key: "A", desc: "help.form.to" },
      { key: "X", desc: "help.form.swap" },
      { key: "B", desc: "help.form.useBalance" },
      { key: "N", desc: "help.form.note" },
      { key: "G", desc: "help.form.calendar" },
      { key: "← →", desc: "help.form.day" },
      { key: "O", desc: "help.form.today" },
    ],
  },
  {
    group: "help.group.global",
    items: [
      { key: "?", desc: "help.global.toggle" },
      { key: "H", desc: "help.global.blur" },
      { key: "↑ ↓", desc: "help.global.rows" },
      { key: "Enter", desc: "help.global.open" },
    ],
  },
];

export default function KeyboardHelp({ onClose }) {
  const { t } = useT();

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "var(--backdrop)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: "var(--surface)",
          borderRadius: 14,
          padding: "28px 32px",
          maxWidth: 520,
          width: "90vw",
          maxHeight: "80vh",
          overflowY: "auto",
          boxShadow: "var(--shadow-modal)",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 20,
          }}
        >
          <div style={{ fontSize: 20, fontWeight: "bold", color: mainColor }}>
            {t("help.title")}
          </div>
          <div
            onClick={onClose}
            style={{ cursor: "pointer", fontSize: 22, color: "var(--text-subtle)", lineHeight: 1 }}
          >
            ×
          </div>
        </div>

        {SHORTCUTS.map((section) => (
          <div key={section.group} style={{ marginBottom: 18 }}>
            <div
              style={{
                fontSize: 11,
                fontWeight: "bold",
                textTransform: "uppercase",
                color: "var(--text-subtle)",
                letterSpacing: 1,
                marginBottom: 8,
              }}
            >
              {t(section.group)}
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <tbody>
                {section.items.map(({ key, desc }) => (
                  <tr key={key} style={{ borderBottom: "1px solid var(--border-soft)" }}>
                    <td style={{ padding: "6px 0", width: 130 }}>
                      {key.split(" ").map((k, i) => (
                        <Fragment key={i}>
                          {i > 0 && <span style={{ color: "var(--text-subtle)", margin: "0 3px" }}> </span>}
                          <kbd
                            style={{
                              display: "inline-block",
                              padding: "2px 7px",
                              borderRadius: 5,
                              border: "1px solid var(--border)",
                              backgroundColor: "var(--kbd-bg)",
                              fontSize: 13,
                              fontFamily: "monospace",
                              boxShadow: "0 1px 0 var(--kbd-border)",
                            }}
                          >
                            {k}
                          </kbd>
                        </Fragment>
                      ))}
                    </td>
                    <td style={{ padding: "6px 0 6px 12px", fontSize: 14, color: "var(--text-secondary)" }}>
                      {t(desc)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}
