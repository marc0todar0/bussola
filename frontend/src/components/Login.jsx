import { useEffect, useState } from "react";
import { FaFingerprint } from "react-icons/fa";
import { login, signup, instanceStatus, passkeysUsable, signInWithPasskey } from "../utils/session";
import { mainColor } from "../config";
import { useT } from "../i18n";
import { errorText } from "../utils/errorText";
import LanguagePicker from "./LanguagePicker";
import "./Login.css";

// Kept in step with MIN_PASSWORD_LENGTH in api/auth/password.js. Exported
// because the profile page changes passwords too and the rule has to be the
// same one, not a second copy of the number.
export const MIN_PASSWORD_LENGTH = 6;

// The mark, drawn inline rather than loaded from /icon.svg so that the disc
// follows the theme's mainColor the way the title next to it already does.
// Same geometry as frontend/public/icon.svg -- keep the two in step.
function CompassMark() {
  return (
    <svg className="login-mark" viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <circle cx="16" cy="16" r="16" fill={mainColor} />
      <path d="M16 1 19.5 12.5 31 16 19.5 19.5 16 31 12.5 19.5 1 16 12.5 12.5Z" fill="#fff" />
    </svg>
  );
}

// The way in. It offers sign-up only when the instance allows it: on a home
// installation it is normally closed, and a "sign up" link that always answers
// no is worse than no link at all.
function Login({ onSignedIn }) {
  const { t, language } = useT();
  const [mode, setMode] = useState("login");
  const [signupOpen, setSignupOpen] = useState(false);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  // Whether "Sign in with a passkey" can work from this page: the server has
  // passkeys on, and this is the secure origin they belong to. Anything less
  // and the button is not drawn at all -- over plain http on the LAN, which is
  // the standard deployment, the browser would refuse it anyway.
  const [passkeys, setPasskeys] = useState(false);

  // On a phone the passkey is the point -- a thumb on the sensor instead of a
  // password typed on a glass keyboard -- so it goes first and the password
  // form becomes the fallback. With a mouse the order is the familiar one. A
  // coarse pointer is the honest test for "a finger is holding this".
  const [passkeyFirst] = useState(
    () => typeof window !== "undefined" && Boolean(window.matchMedia?.("(pointer: coarse)").matches),
  );

  useEffect(() => {
    instanceStatus().then((s) => {
      setSignupOpen(s.signupOpen);
      setPasskeys(passkeysUsable(s));
    });
  }, []);

  // The server sends a stable code alongside its English text: translate the
  // code when we know it, otherwise show what the server said.
  // `minutes` is for the wrong-password lock, which says how long is left.
  const explain = (body) =>
    errorText(t, body, t("login.failed"), {
      min: MIN_PASSWORD_LENGTH,
      minutes: Math.max(1, Math.ceil((Number(body.retryAfter) || 60) / 60)),
    });

  const passkeySignIn = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await signInWithPasskey();
      if (!result.ok) {
        const body = result.body || {};
        // Cancelling the device prompt is a choice, not an error: the person
        // knows what they did, and a red box about it would only scold them.
        if (body.code === "PASSKEY_CANCELLED") return;
        setError(explain(body));
        return;
      }
      onSignedIn(result.body);
    } catch {
      setError(t("login.unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const result =
        mode === "signup"
          ? await signup(username.trim(), password, language)
          : await login(username.trim(), password);

      if (!result.ok) {
        setError(explain(result.body || {}));
        return;
      }
      onSignedIn(result.body);
    } catch {
      setError(t("login.unreachable"));
    } finally {
      setBusy(false);
    }
  };

  const registering = mode === "signup";

  // Only on the sign-in side: a passkey is added from the profile, once the
  // account exists, never at sign-up.
  const showPasskey = passkeys && !registering;
  const passkeyButton = (
    <button
      type="button"
      className={`login-passkey${passkeyFirst ? " is-primary" : ""}`}
      style={passkeyFirst ? { backgroundColor: mainColor } : undefined}
      onClick={passkeySignIn}
      disabled={busy}
    >
      <FaFingerprint aria-hidden="true" /> {t("login.passkey")}
    </button>
  );

  return (
    <div className="login-background">
      <form className="login-box" onSubmit={submit}>
        <CompassMark />
        <h1 className="login-title" style={{ color: mainColor }}>
          Bussola
        </h1>
        <p className="login-subtitle">
          {registering ? t("login.createAccount") : t("login.signIn")}
        </p>

        {showPasskey && passkeyFirst && (
          <>
            {passkeyButton}
            <div className="login-or">{t("login.orPassword")}</div>
          </>
        )}

        <label className="login-field">
          <span>{t("login.username")}</span>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck="false"
            required
            // Not when the passkey leads: focusing the field would open the
            // phone's keyboard over the very button it is meant to spare.
            autoFocus={!(showPasskey && passkeyFirst)}
          />
        </label>

        <label className="login-field">
          <span>{t("login.password")}</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={registering ? "new-password" : "current-password"}
            required
            minLength={registering ? MIN_PASSWORD_LENGTH : undefined}
          />
        </label>

        {error && <div className="login-error">{error}</div>}

        <button
          type="submit"
          className="login-submit"
          style={{ backgroundColor: mainColor }}
          disabled={busy}
        >
          {busy ? t("login.working") : registering ? t("login.createAccountAction") : t("login.enter")}
        </button>

        {showPasskey && !passkeyFirst && (
          <>
            <div className="login-or">{t("login.or")}</div>
            {passkeyButton}
          </>
        )}

        {signupOpen && (
          <button
            type="button"
            className="login-toggle"
            onClick={() => {
              setMode(registering ? "login" : "signup");
              setError(null);
            }}
          >
            {registering ? t("login.haveAccount") : t("login.noAccount")}
          </button>
        )}

        {/* The language has to be selectable here too: this screen is shown
            before anyone knows who is reading it. A row of buttons was fine
            for two languages and is not for six. */}
        <div className="login-languages">
          <LanguagePicker showName />
        </div>
      </form>
    </div>
  );
}

export default Login;
