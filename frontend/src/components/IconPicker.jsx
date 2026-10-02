import { useEffect, useRef, useState } from "react";
import { Icon } from "@iconify/react";
import { mainColor } from "../config";
import { useT } from "../i18n";

const ICONIFY_SEARCH = "https://api.iconify.design/search";

export default function IconPicker({ icon, family, onSelect }) {
  const { t } = useT();
  const [query, setQuery] = useState("wallet");
  const [results, setResults] = useState([]);
  const [loading, setLoading] = useState(false);
  const debounceRef = useRef(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query || query.length < 2) {
      setResults([]);
      return;
    }
    debounceRef.current = setTimeout(async () => {
      setLoading(true);
      try {
        const res = await fetch(
          `${ICONIFY_SEARCH}?query=${encodeURIComponent(query)}&limit=64`
        );
        const json = await res.json();
        setResults(Array.isArray(json.icons) ? json.icons : []);
      } catch (e) {
        console.error("Iconify search failed", e);
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => debounceRef.current && clearTimeout(debounceRef.current);
  }, [query]);

  const currentFull = icon && family ? `${family}:${icon}` : null;

  const handlePick = (iconStr) => {
    const [prefix, ...rest] = iconStr.split(":");
    const name = rest.join(":");
    onSelect({ icon: name, iconFamily: prefix });
  };

  return (
    <div style={styles.container}>
      <input
        type="text"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder={t("iconPicker.search")}
        style={styles.input}
      />
      <div style={styles.grid}>
        {loading && <div style={styles.status}>{t("common.searching")}</div>}
        {!loading && results.length === 0 && (
          <div style={styles.status}>{t("iconPicker.noResults")}</div>
        )}
        {results.map((iconStr) => {
          const isSelected = iconStr === currentFull;
          return (
            <div
              key={iconStr}
              onClick={() => handlePick(iconStr)}
              title={iconStr}
              style={{
                ...styles.cell,
                borderColor: isSelected ? mainColor : "var(--border)",
                backgroundColor: isSelected ? `${mainColor}22` : "var(--surface)",
              }}
            >
              <Icon icon={iconStr} width={28} height={28} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    width: "100%",
    gap: 8,
  },
  input: {
    width: "100%",
    padding: "8px 12px",
    fontSize: 14,
    border: "1px solid var(--border-strong)",
    borderRadius: 6,
    boxSizing: "border-box",
  },
  grid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(44px, 1fr))",
    gap: 6,
    maxHeight: 180,
    overflowY: "auto",
    border: "1px solid var(--border-soft)",
    borderRadius: 6,
    padding: 6,
    backgroundColor: "var(--surface-2)",
  },
  cell: {
    width: 40,
    height: 40,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    border: "2px solid var(--border)",
    borderRadius: 6,
    cursor: "pointer",
  },
  status: {
    gridColumn: "1 / -1",
    textAlign: "center",
    color: "var(--text-subtle)",
    fontSize: 13,
    padding: 12,
  },
};
