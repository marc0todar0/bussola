import { LANGUAGES, useT } from "../i18n";
import "./LanguagePicker.css";

// A real <select>, not a custom menu: with six languages the phone's own
// wheel is easier to use than anything drawn here, it is reachable by
// keyboard for free, and it cannot open off the edge of the screen.
//
// The chosen language shows as a flag, which is what fits in a corner. The
// options carry flag and name together, because a flag alone is a country and
// countries and languages are not the same thing -- the name is what tells
// somebody they are looking at their own language.
function LanguagePicker({ id, className = "", showName = false }) {
  const { language, setLanguage, t } = useT();
  const current = LANGUAGES[language] || LANGUAGES.en;

  return (
    <span className={`language-picker ${className}`.trim()}>
      <span className="language-picker-flag" aria-hidden="true">
        {current.flag}
      </span>
      {showName && <span className="language-picker-name">{current.name}</span>}

      <select
        id={id}
        className="language-picker-select"
        value={language}
        onChange={(e) => setLanguage(e.target.value)}
        aria-label={t("nav.language")}
        title={t("nav.language")}
      >
        {Object.entries(LANGUAGES).map(([code, { name, flag }]) => (
          <option key={code} value={code}>
            {flag} {name}
          </option>
        ))}
      </select>
    </span>
  );
}

export default LanguagePicker;
