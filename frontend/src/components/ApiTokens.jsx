import { useCallback, useContext, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { FaCopy, FaKey, FaTrash } from "react-icons/fa";
import GlobalContext from "../context/GlobalContext";
import { useT } from "../i18n";
import { useCanWrite } from "../utils/useCanWrite";
import { createToken, listTokens, revokeToken } from "../utils/session";

// Where the setup is explained, step by step, for iPhone and Android.
const DOCS_URL = "https://github.com/marc0todar0/bussola/blob/main/docs/notifications.md";

// Tokens for apps and automations: what lets a phone post bank notifications
// to the inbox, where they wait to be confirmed. A section of the profile
// page, in its frame and with its classes (Profile.css).
//
// A token belongs to the person and to one wallet -- the one this session is
// looking at when it is made -- and can do nothing but add drafts there. The
// server asks for the password again before making one, and shows the token
// once: it is kept here only until "Done".
export default function ApiTokens() {
  const { t, formatDate } = useT();
  const { wallet } = useContext(GlobalContext);
  const canWrite = useCanWrite();
  const current = wallet && wallet.data;

  const [tokens, setTokens] = useState([]);
  const [label, setLabel] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);
  const [revoking, setRevoking] = useState(null);

  const reload = useCallback(() => {
    listTokens().then(setTokens);
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const failed = (body) => {
    const code = body && body.code;
    const key = code ? `error.${code}` : null;
    const text = key ? t(key) : null;
    toast.error(text && text !== key ? text : (body && body.error) || t("profile.failed"));
  };

  const submitCreate = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { ok, body } = await createToken(label.trim(), password);
      if (!ok) return failed(body);
      setPassword("");
      setLabel("");
      setCreated(body);
      toast.success(t("profile.tokenCreated"));
      reload();
    } finally {
      setBusy(false);
    }
  };

  const submitRevoke = async (e, token) => {
    e.preventDefault();
    setBusy(true);
    try {
      const { ok, body } = await revokeToken(token.id);
      if (!ok) return failed(body);
      toast.success(t("profile.tokenRevoked"));
      setRevoking(null);
      reload();
    } finally {
      setBusy(false);
    }
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(created.token);
      toast.success(t("profile.tokenCopied"));
    } catch {
      // No clipboard (plain http on a LAN address): the field is selectable.
      toast.error(t("profile.tokenCopyFailed"));
    }
  };

  return (
    <section className="profile-section">
      <h2>{t("profile.tokens")}</h2>
      <p className="profile-hint">{t("profile.tokensHint")}</p>

      {tokens.length === 0 ? (
        <p className="profile-hint">{t("profile.noTokens")}</p>
      ) : (
        <ul className="profile-list">
          {tokens.map((tk) => (
            <li key={tk.id} className="profile-row">
              {revoking === tk.id ? (
                <form className="profile-inline" onSubmit={(e) => submitRevoke(e, tk)}>
                  <span className="profile-confirm-ask">{t("profile.revokeTokenConfirm", { name: tk.label })}</span>
                  <button type="submit" className="profile-destructive" disabled={busy}>
                    <FaTrash /> {t("profile.revokeToken")}
                  </button>
                  <button type="button" onClick={() => setRevoking(null)} disabled={busy}>
                    {t("common.cancel")}
                  </button>
                </form>
              ) : (
                <>
                  <span className="profile-name">
                    <FaKey aria-hidden="true" /> {tk.label}
                  </span>
                  <span className="profile-meta">
                    {t("profile.tokenMeta", {
                      wallet: tk.wallet_name,
                      date: formatDate(new Date(tk.created_at)),
                    })}{" "}
                    ·{" "}
                    {tk.last_used_at
                      ? t("profile.passkeyLastUsed", { date: formatDate(new Date(tk.last_used_at)) })
                      : t("profile.passkeyNeverUsed")}
                  </span>
                  <button
                    type="button"
                    className="profile-icon-button"
                    onClick={() => setRevoking(tk.id)}
                    disabled={busy}
                    title={t("profile.revokeToken")}
                    aria-label={t("profile.revokeToken")}
                  >
                    <FaTrash />
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      <hr className="profile-rule" />

      {created ? (
        <div className="profile-form">
          <p className="profile-hint">{t("profile.tokenOnce")}</p>
          <div className="profile-token">
            <input
              type="text"
              readOnly
              value={created.token}
              onFocus={(e) => e.target.select()}
              aria-label={t("profile.tokens")}
            />
            <button type="button" className="profile-button" onClick={copy}>
              <FaCopy /> {t("profile.tokenCopy")}
            </button>
          </div>
          <p className="profile-hint">
            {t("profile.tokenHowTo")}{" "}
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              {t("profile.tokenDocs")}
            </a>
          </p>
          <button type="button" className="profile-button" onClick={() => setCreated(null)}>
            {t("profile.tokenDone")}
          </button>
        </div>
      ) : current && canWrite ? (
        <form className="profile-form" onSubmit={submitCreate}>
          <p className="profile-hint">{t("profile.tokenForWallet", { wallet: current.name })}</p>
          <label className="profile-field">
            <span>{t("profile.tokenLabel")}</span>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              maxLength={64}
              required
            />
          </label>
          <label className="profile-field">
            <span>{t("profile.currentPassword")}</span>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button type="submit" className="profile-button" disabled={busy || !label.trim() || !password}>
            <FaKey /> {t("profile.createToken")}
          </button>
        </form>
      ) : (
        <p className="profile-hint profile-protected">
          {current ? t("profile.tokenReadOnly") : t("profile.tokenNoWallet")}
        </p>
      )}
    </section>
  );
}
