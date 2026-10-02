import { useNavigate } from "react-router-dom";
import { FaChevronLeft } from "react-icons/fa";
import PortfolioPanel from "../components/PortfolioPanel";
import { mainColor } from "../config";
import { useT } from "../i18n";

export default function Portfolio() {
  const navigate = useNavigate();
  const { t } = useT();

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button
          type="button"
          onClick={() => navigate("/accounts")}
          style={styles.backBtn}
        >
          <FaChevronLeft size={16} />
          <span>{t("nav.accounts")}</span>
        </button>
        <div style={styles.title}>{t("portfolio.title")}</div>
      </div>
      <PortfolioPanel />
    </div>
  );
}

const styles = {
  container: {
    display: "flex",
    flexDirection: "column",
    backgroundColor: "var(--bg)",
    alignItems: "center",
    width: "90%",
    margin: "0 auto",
  },
  // Three columns, the outer two equal: the title stays centred however wide
  // the back button's label is in this language. A fixed-width button with a
  // matching spacer did the same until a label ("Accounts") outgrew it.
  header: {
    display: "grid",
    gridTemplateColumns: "1fr auto 1fr",
    alignItems: "center",
    columnGap: 8,
    width: "100%",
    marginTop: 10,
  },
  title: {
    fontSize: 24,
    fontWeight: "bold",
    textAlign: "center",
  },
  backBtn: {
    display: "flex",
    flexDirection: "row",
    alignItems: "center",
    justifySelf: "start",
    gap: 6,
    border: `1px solid ${mainColor}`,
    background: "var(--surface)",
    color: mainColor,
    fontSize: 16,
    fontWeight: "bold",
    cursor: "pointer",
    borderRadius: 20,
    padding: "8px 14px",
    whiteSpace: "nowrap",
  },
};
