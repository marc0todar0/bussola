import { useEffect, useState } from "react";
import { myWallets, selectWallet, createWallet } from "../utils/session";
import { mainColor } from "../config";
import { useT } from "../i18n";
import { membersLabel } from "../utils/generic";
import { errorText } from "../utils/errorText";
import "./Login.css";
import "./WalletPicker.css";

// Which wallet am I working on.
//
// It stands between the login screen and the app, and it is shown when the
// answer is not obvious: more than one wallet and none chosen, the chosen one
// taken away, or the person asking to move to another. With exactly one wallet
// the server picks it at sign-in and this screen never appears -- a choice of
// one is not a choice.
//
// With none -- every new account, since sign-up creates no wallet -- there is
// nothing to choose, so the name field is open from the start and there is no
// "cancel" to go back to a list that is empty.
function WalletPicker({ current, onChosen, onCancel, onSignOut }) {
  const { t } = useT();
  const [wallets, setWallets] = useState(null);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    myWallets().then(setWallets);
  }, []);

  const empty = wallets !== null && wallets.length === 0;
  const showForm = creating || empty;

  const fail = (body) => setError(errorText(t, body, t("wallet.failed")));

  const choose = async (wallet) => {
    setError(null);
    setBusy(true);
    try {
      const { ok, body } = await selectWallet(wallet.id);
      if (!ok) return fail(body);
      onChosen(body);
    } finally {
      setBusy(false);
    }
  };

  const submitNew = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const { ok, body } = await createWallet(name.trim());
      if (!ok) return fail(body);
      onChosen(body);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-background">
      <div className="login-box">
        <h1 className="login-title" style={{ color: mainColor }}>
          Bussola
        </h1>
        <p className="login-subtitle">{empty ? t("wallet.none") : t("wallet.choose")}</p>

        {wallets === null ? (
          <p className="wallet-empty">{t("wallet.loading")}</p>
        ) : empty ? null : (
          <div className="wallet-list">
            {wallets.map((w) => (
              <button
                key={w.id}
                type="button"
                className={`wallet-item${current && current.id === w.id ? " wallet-item-current" : ""}`}
                onClick={() => choose(w)}
                disabled={busy}
              >
                <span className="wallet-item-name">{w.name}</span>
                <span className="wallet-item-meta">
                  {w.role === "r" && <span className="wallet-badge">{t("wallet.readOnly")}</span>}
                  {w.members > 1 && (
                    <span className="wallet-members">{membersLabel(t, w.members)}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        )}

        {error && <div className="login-error">{error}</div>}

        {showForm ? (
          <form onSubmit={submitNew} className="wallet-create">
            <label className="login-field">
              <span>{t("wallet.name")}</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={120}
                required
                autoFocus
              />
            </label>
            <button
              type="submit"
              className="login-submit"
              style={{ backgroundColor: mainColor }}
              disabled={busy || !name.trim()}
            >
              {busy ? t("login.working") : t("wallet.create")}
            </button>
            {!empty && (
              <button type="button" className="login-toggle" onClick={() => setCreating(false)}>
                {t("common.cancel")}
              </button>
            )}
          </form>
        ) : (
          <button type="button" className="login-toggle" onClick={() => setCreating(true)}>
            {t("wallet.createNew")}
          </button>
        )}

        {/* A way out in both directions: back to where they were, or out
            altogether. Without them an account whose only wallet was taken
            away would be stuck on this screen. */}
        {onCancel && (
          <button type="button" className="login-toggle" onClick={onCancel}>
            {t("common.back")}
          </button>
        )}
        <button type="button" className="login-toggle" onClick={onSignOut}>
          {t("nav.signOut")}
        </button>
      </div>
    </div>
  );
}

export default WalletPicker;
