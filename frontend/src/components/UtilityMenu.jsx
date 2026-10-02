import { useRef, useEffect, useContext, useId, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  FaAdjust,
  FaDesktop,
  FaMoon,
  FaSun,
  FaCog,
  FaKeyboard,
  FaSignOutAlt,
  FaGlobe,
  FaWallet,
  FaUsersCog,
  FaUserCircle,
  FaFileExport,
  FaEye,
  FaEyeSlash,
  FaHeart,
  FaInfoCircle,
} from "react-icons/fa";
import GlobalContext from "../context/GlobalContext";
import { useT } from "../i18n";
import LanguagePicker from "./LanguagePicker";
import Modal from "./Modal";
import AboutDialog from "./AboutDialog";
import { useTheme } from "../utils/theme";
import "./UtilityMenu.css";

// The three answers to "light or dark?", in the order people expect them:
// the one that decides by itself first, then the two that do not.
// Where a donation goes. Plain links opening in a new tab: the CSP allows no
// script and no image from elsewhere, and a text link needs neither.
const SUPPORT_LINKS = [
  { label: "Ko-fi", href: "https://ko-fi.com/marc0todar0" },
  { label: "Buy Me a Coffee", href: "https://buymeacoffee.com/marc0todar0" },
];

const THEME_OPTIONS = [
  { value: "system", icon: <FaDesktop /> },
  { value: "light", icon: <FaSun /> },
  { value: "dark", icon: <FaMoon /> },
];

// Everything that is not a destination: the wallet in context, the language,
// the shortcuts, the profile and the way out.
//
// It is the fifth cell of the tab bar, and it renders like the other four. It
// was in the bar before, as three separate items that a long set of labels
// pushed off the right edge, and then as a button floating in the corner --
// which stopped the pushing but put a blue circle on top of whatever was
// underneath it. One cell holding a menu is the version that neither
// overflows nor covers: the bar is sized in equal parts, so a fifth of it
// costs the same in every language.
// `open` is owned by the tab bar, which is where the "5" shortcut lives.
function UtilityMenu({ open, setOpen, onShowShortcuts, onSignOut, onChangeWallet, username, wallet }) {
  const { t } = useT();
  // Bank mode: whether every amount on screen is smeared out. It belongs here
  // rather than in the tab bar itself because it is a setting and not a
  // destination, and it sits beside the language for the same reason -- both
  // change how the same data reads, neither changes the data.
  const { blur } = useContext(GlobalContext);
  // Light or dark: a property of this device, like bank mode, so it is not in
  // the context with the account's data but in a store of its own.
  const theme = useTheme();
  const themeLabelId = useId();
  // The menu lives inside the router, so it can take itself to the management
  // screen instead of handing a callback up and back down again.
  const navigate = useNavigate();
  const ref = useRef(null);
  // The support dialog outlives the panel: opening it closes the menu, and a
  // dialog rendered inside the panel would go with it.
  const [supportOpen, setSupportOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onOutside = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onEscape = (e) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onOutside);
    document.addEventListener("keydown", onEscape);
    return () => {
      document.removeEventListener("mousedown", onOutside);
      document.removeEventListener("keydown", onEscape);
    };
  }, [open, setOpen]);

  const close = () => setOpen(false);

  return (
    <div className="utility-menu" ref={ref}>
      {open && (
        <div className="utility-panel" role="menu">
          {/* Which wallet the numbers on screen belong to. On an instance
              where nothing is shared this is one line that never changes; the
              moment two people are involved it is the first thing worth
              knowing. */}
          {wallet && (
            <>
              <button
                type="button"
                role="menuitem"
                className="utility-item"
                onClick={() => {
                  close();
                  onChangeWallet();
                }}
                title={t("wallet.change")}
              >
                <span className="utility-item-icon">
                  <FaWallet />
                </span>
                <span className="utility-wallet-name">{wallet.name}</span>
                {wallet.role === "r" && (
                  <span className="utility-wallet-badge">{t("wallet.readOnly")}</span>
                )}
              </button>

              {/* canManage is true for the wallet's creator and for the
                  instance administrator, which is exactly who has anything to
                  do on that screen. */}
              {wallet.canManage && (
                <button
                  type="button"
                  role="menuitem"
                  className="utility-item"
                  onClick={() => {
                    close();
                    navigate("/manage");
                  }}
                >
                  <span className="utility-item-icon">
                    <FaUsersCog />
                  </span>
                  {t("admin.title")}
                </button>
              )}

              {/* The wallet's data in and out of files. Every member may take
                  it away, so the entry is always here; the page itself leaves
                  the import out for a read-only member. */}
              <button
                type="button"
                role="menuitem"
                className="utility-item"
                onClick={() => {
                  close();
                  navigate("/data");
                }}
              >
                <span className="utility-item-icon">
                  <FaFileExport />
                </span>
                {t("nav.data")}
              </button>

              <div className="utility-divider" />
            </>
          )}

          <label className="utility-language">
            <span className="utility-item-icon">
              <FaGlobe />
            </span>
            {t("nav.language")}
            <LanguagePicker showName />
          </label>

          {/* Three small buttons rather than a toggle: "follow the system" is
              a real third answer, and a two-way switch would have to pretend
              it is one of the other two. The panel stays open, for the same
              reason it does after a language change -- the menu you are
              looking at is the first thing that shows the result, and the
              icons carry their names as tooltips and for screen readers. */}
          <div className="utility-theme">
            <span className="utility-item-icon">
              <FaAdjust />
            </span>
            <span id={themeLabelId}>{t("theme.label")}</span>
            <div className="utility-theme-choices" role="radiogroup" aria-labelledby={themeLabelId}>
              {THEME_OPTIONS.map(({ value, icon }) => {
                const selected = theme.choice === value;
                return (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={t(`theme.${value}`)}
                    title={t(`theme.${value}`)}
                    className={`utility-theme-choice${selected ? " selected" : ""}`}
                    onClick={() => theme.setChoice(value)}
                  >
                    {icon}
                  </button>
                );
              })}
            </div>
          </div>

          {/* The panel closes on the way out: unlike the language, which you
              change and then want to see applied to the menu you are still
              looking at, hiding the amounts is about the screen behind this
              one. */}
          <button
            type="button"
            role="menuitem"
            className="utility-item"
            onClick={() => {
              blur.setIsBlurred((v) => !v);
              close();
            }}
            aria-pressed={blur.isBlurred}
          >
            <span className="utility-item-icon">
              {blur.isBlurred ? <FaEyeSlash /> : <FaEye />}
            </span>
            {t("blur.toggle")}
            <span className="utility-state">
              {blur.isBlurred ? t("common.on") : t("common.off")}
            </span>
          </button>

          <div className="utility-divider" />

          {/* Useless without a physical keyboard, so it is hidden on phones
              by the stylesheet rather than removed here. */}
          <button
            type="button"
            role="menuitem"
            className="utility-item utility-shortcuts"
            onClick={() => {
              close();
              onShowShortcuts();
            }}
          >
            <span className="utility-item-icon">
              <FaKeyboard />
            </span>
            {t("nav.shortcuts")}
          </button>

          {/* Discreet on purpose: one line among the settings, never a banner
              over the money. */}
          <button
            type="button"
            role="menuitem"
            className="utility-item"
            onClick={() => {
              close();
              setSupportOpen(true);
            }}
          >
            <span className="utility-item-icon">
              <FaHeart />
            </span>
            {t("support.menu")}
          </button>

          <button
            type="button"
            role="menuitem"
            className="utility-item"
            onClick={() => {
              close();
              setAboutOpen(true);
            }}
          >
            <span className="utility-item-icon">
              <FaInfoCircle />
            </span>
            {t("about.menu")}
          </button>

          {/* Sits next to sign out because both are about the person rather
              than the money: the two credentials, and the wallets they own. */}
          <button
            type="button"
            role="menuitem"
            className="utility-item"
            onClick={() => {
              close();
              navigate("/profile");
            }}
          >
            <span className="utility-item-icon">
              <FaUserCircle />
            </span>
            {t("nav.profile")}
          </button>

          <button
            type="button"
            role="menuitem"
            className="utility-item utility-signout"
            onClick={() => {
              close();
              onSignOut();
            }}
            title={t("nav.signOutAs", { username })}
          >
            <span className="utility-item-icon">
              <FaSignOutAlt />
            </span>
            {t("nav.signOut")}
          </button>

          {username && <div className="utility-username">{username}</div>}
        </div>
      )}

      <AboutDialog isOpen={aboutOpen} onClose={() => setAboutOpen(false)} />

      <Modal isOpen={supportOpen} onClose={() => setSupportOpen(false)} label={t("support.title")}>
        <div className="support-dialog">
          <h2 className="support-title">{t("support.title")}</h2>
          <p className="support-text">{t("support.text")}</p>
          <div className="support-links">
            {SUPPORT_LINKS.map(({ label, href }) => (
              <a key={href} className="support-link" href={href} target="_blank" rel="noopener noreferrer">
                {label}
              </a>
            ))}
          </div>
          <button type="button" className="support-close" onClick={() => setSupportOpen(false)}>
            {t("common.close")}
          </button>
        </div>
      </Modal>

      {/* .tab-link is nav.css's, on purpose: the cell has to be the same size,
          the same colour and the same shape as its four neighbours, and .active
          says the panel is open the same way it says which page you are on. */}
      <button
        type="button"
        className={`tab-link utility-tab${open ? " active" : ""}`}
        onClick={() => setOpen((v) => !v)}
        title={t("nav.menu")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <FaCog className="tab-icon" />
        <span className="tab-label">{t("nav.menu")}</span>
      </button>
    </div>
  );
}

export default UtilityMenu;
