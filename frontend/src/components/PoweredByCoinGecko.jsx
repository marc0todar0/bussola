import { useContext } from "react";
import GlobalContext from "../context/GlobalContext";
import { useQuotesEnabled } from "../utils/useQuotesEnabled";

// The credits the price providers ask for, drawn only when the instance has a
// quote service at all. Brand phrases, so not translated.
//   - CoinGecko's API terms (4.3, every plan): "Powered by CoinGecko".
//   - Eulerpool's free plan: "Data by Eulerpool" in any public-facing
//     product, so it is drawn only when Eulerpool is one of the providers the
//     quote service reports on (`quoteSources` in /api/auth/me).
// Twelve Data, EODHD and OpenFIGI ask for nothing (docs/configuration.md).
export default function PoweredByCoinGecko({ style }) {
  const enabled = useQuotesEnabled();
  const context = useContext(GlobalContext);
  const user = context && context.user && context.user.data;
  const sources = (user && user.quoteSources) || [];
  if (!enabled) return null;
  return (
    <div style={{ ...styles.line, ...style }}>
      <a
        href="https://www.coingecko.com"
        target="_blank"
        rel="noopener noreferrer"
        style={styles.link}
      >
        Powered by CoinGecko
      </a>
      {sources.includes("eulerpool") && (
        <>
          {" · "}
          <a
            href="https://eulerpool.com"
            target="_blank"
            rel="noopener noreferrer"
            style={styles.link}
          >
            Data by Eulerpool
          </a>
        </>
      )}
    </div>
  );
}

const styles = {
  line: {
    fontSize: 11,
    color: "var(--text-subtle)",
    textAlign: "center",
  },
  link: {
    color: "inherit",
    textDecoration: "underline",
  },
};
