import { useContext } from "react";
import GlobalContext from "../context/GlobalContext";
import { useT } from "../i18n";
import Modal from "./Modal";
import PoweredByCoinGecko from "./PoweredByCoinGecko";

// The credits page: every data source and service Bussola uses, not only the
// two whose terms ask for a credit (those stay next to the prices too).
// Names and links are brand data, so they are not translated; what each is
// used for is. Only text links: the CSP loads nothing from elsewhere.
const REPO = "https://github.com/marc0todar0/bussola";

const SOURCES = [
  { id: "coingecko", name: "CoinGecko", href: "https://www.coingecko.com", use: "about.use.coingecko" },
  { id: "eulerpool", name: "Eulerpool", href: "https://eulerpool.com", use: "about.use.stocks" },
  { id: "twelvedata", name: "Twelve Data", href: "https://twelvedata.com", use: "about.use.stocks" },
  { id: "eodhd", name: "EODHD", href: "https://eodhd.com", use: "about.use.stocks" },
  { id: "openfigi", name: "OpenFIGI", href: "https://www.openfigi.com", use: "about.use.openfigi" },
];

const Link = ({ href, children }) => (
  <a className="about-link" href={href} target="_blank" rel="noopener noreferrer">
    {children}
  </a>
);

export default function AboutDialog({ isOpen, onClose }) {
  const { t } = useT();
  const context = useContext(GlobalContext);
  const user = (context && context.user && context.user.data) || {};
  const quotesOn = user.quotes !== false;
  const active = new Set(quotesOn ? ["coingecko", ...(user.quoteSources || [])] : []);

  return (
    <Modal isOpen={isOpen} onClose={onClose} label={t("about.title")}>
      <div className="about-dialog">
        <h2 className="support-title">{t("about.title")}</h2>

        <h3 className="about-heading">{t("about.project")}</h3>
        <p className="about-text">
          {t("about.projectText")} <Link href={REPO}>{t("about.source")}</Link> ·{" "}
          <Link href={`${REPO}/blob/main/docs/using.md`}>{t("about.docs")}</Link>
        </p>
        <p className="about-text">{t("about.license")}</p>
        <p className="about-text">{t("about.libraries")}</p>

        <h3 className="about-heading">{t("about.prices")}</h3>
        <p className="about-text">{t(quotesOn ? "about.pricesOn" : "about.pricesOff")}</p>
        <ul className="about-list">
          {SOURCES.map((s) => (
            <li key={s.id}>
              <Link href={s.href}>{s.name}</Link> — {t(s.use)}
              {quotesOn && (
                <span className={`about-badge${active.has(s.id) ? " on" : ""}`}>
                  {t(active.has(s.id) ? "about.active" : "about.inactive")}
                </span>
              )}
            </li>
          ))}
        </ul>
        {quotesOn && <PoweredByCoinGecko style={{ textAlign: "left", fontSize: 13, marginBottom: 8 }} />}

        <h3 className="about-heading">{t("about.notifications")}</h3>
        <p className="about-text">
          {user.ai ? t(user.aiCloud ? "about.aiCloud" : "about.aiLocal") : t("about.aiOff")}
        </p>

        <div style={{ textAlign: "center" }}>
          <button type="button" className="support-close" onClick={onClose}>
            {t("common.close")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
