import { useContext, useState } from "react";
import toast from "react-hot-toast";
import { FaSave } from "react-icons/fa";
import GlobalContext from "../context/GlobalContext";
import { useT } from "../i18n";
import { saveBankNames } from "../utils/session";

// "Your name as your banks write it": a section of the profile page, next to
// the tokens. The model that reads bank notifications is told these names, so
// that "Sent €500 to Marco Todaro (Fineco)" reads as a transfer between two of
// one's own accounts. A personal setting: every member of a wallet has their
// own. Comma-separated here, a list on the server (at most five, 80
// characters each -- api/auth/bankNames.js).
export default function BankNames() {
  const { t } = useT();
  const { user } = useContext(GlobalContext);
  const saved = ((user.data && user.data.bankNames) || []).join(", ");
  const [value, setValue] = useState(saved);
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { ok, body } = await saveBankNames(value);
      if (!ok) {
        const code = body && body.code;
        const text = code ? t(`error.${code}`) : null;
        toast.error(text && text !== `error.${code}` ? text : (body && body.error) || t("profile.failed"));
        return;
      }
      setValue((body.bankNames || []).join(", "));
      toast.success(t("profile.bankNamesSaved"));
      await user.refresh();
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="profile-section">
      <h2>{t("profile.bankNames")}</h2>
      <form className="profile-form" onSubmit={submit}>
        <p className="profile-hint">{t("profile.bankNamesHint")}</p>
        <label className="profile-field">
          <span>{t("profile.bankNamesLabel")}</span>
          <input
            type="text"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={t("profile.bankNamesPlaceholder")}
            autoComplete="name"
            maxLength={5 * 82}
          />
        </label>
        <button type="submit" className="profile-button" disabled={busy || value.trim() === saved}>
          <FaSave /> {t("profile.bankNamesSave")}
        </button>
      </form>
    </section>
  );
}
