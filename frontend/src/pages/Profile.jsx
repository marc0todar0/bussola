import { useCallback, useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { FaArrowLeft, FaFingerprint, FaKey, FaPen, FaTrash, FaUser } from "react-icons/fa";
import GlobalContext from "../context/GlobalContext";
import { useT } from "../i18n";
import { membersLabel } from "../utils/generic";
import { errorText } from "../utils/errorText";
// The same codes the API's allow-list holds (api/auth/wallets.js, which is the
// source of truth). This copy only fills the select; a code the server does
// not accept is refused whatever this list offers.
import { isoCurrencies } from "../config";
import { MIN_PASSWORD_LENGTH } from "../components/Login";
import {
  addPasskey,
  changePassword,
  changeUsername,
  deleteAccount,
  deletePasskey,
  deleteWallet,
  instanceStatus,
  listPasskeys,
  passkeysUsable,
  renamePasskey,
  suggestedPasskeyName,
  myWallets,
  renameWallet,
  setWalletCurrency,
  reportWalletLost,
} from "../utils/session";
import ApiTokens from "../components/ApiTokens";
import PushNotifications from "../components/PushNotifications";
import BankNames from "../components/BankNames";
import "./Profile.css";

// The account itself: the two credentials, the wallets this person owns, and
// the one operation that destroys data.
//
// Everything else in the app is about the money; this page is about the person
// holding it. It is deliberately the sibling of Manage: same frame, same way of
// turning a server error code into a sentence, same toasts. Manage answers "who
// else can see my data", this one answers "who am I and what do I own".
function Profile() {
  const { t, formatDate } = useT();
  const navigate = useNavigate();
  const { user, wallet } = useContext(GlobalContext);
  const me = user.data;
  const isAdmin = Boolean(me && me.isAdmin);
  const current = wallet.data;

  const [wallets, setWallets] = useState([]);
  const [busy, setBusy] = useState(false);

  // The username field starts on the name in use: this is an edit, not a blank
  // form, and seeing the current value is half the answer to "what is it now".
  const [username, setUsername] = useState((me && me.username) || "");
  const [usernamePassword, setUsernamePassword] = useState("");
  const [passwords, setPasswords] = useState({ current: "", next: "", confirm: "" });

  // Which wallet is being renamed, and the name being typed. One at a time:
  // two half-finished renames on screen is a way to save the wrong one.
  const [renaming, setRenaming] = useState(null);
  const [renameDraft, setRenameDraft] = useState("");

  // Same for the deletion, plus the typed confirmation the server demands.
  const [deleting, setDeleting] = useState(null);
  const [confirmName, setConfirmName] = useState("");

  // Deleting the account itself: closed until asked for, then the username
  // typed back and the password, both of which the server checks again.
  const [leaving, setLeaving] = useState(false);
  const [leaveName, setLeaveName] = useState("");
  const [leavePassword, setLeavePassword] = useState("");

  const reloadWallets = useCallback(() => {
    myWallets().then(setWallets);
  }, []);

  useEffect(() => {
    reloadWallets();
  }, [reloadWallets]);

  // Passkeys: the list is always fetched, because a passkey added while the
  // instance had them switched on is still worth being able to see and remove
  // after it switches them off. Adding one needs the server to have them on
  // *and* this page to be at the secure origin they belong to.
  const [passkeyStatus, setPasskeyStatus] = useState(null);
  const [passkeys, setPasskeys] = useState([]);
  const [passkeyPassword, setPasskeyPassword] = useState("");
  // A suggestion from the browser and system ("Safari · iPhone"): it is what
  // tells two entries apart a month later. The field is the person's to change.
  const [passkeyName, setPasskeyName] = useState(suggestedPasskeyName);
  // One row edited at a time, as with the wallets.
  const [renamingPasskey, setRenamingPasskey] = useState(null);
  const [passkeyDraft, setPasskeyDraft] = useState("");
  const [removingPasskey, setRemovingPasskey] = useState(null);

  const reloadPasskeys = useCallback(() => {
    listPasskeys().then(setPasskeys);
  }, []);

  useEffect(() => {
    reloadPasskeys();
    instanceStatus().then(setPasskeyStatus);
  }, [reloadPasskeys]);

  // The server sends a stable code alongside its English text: translate the
  // code when we know it, and fall back to what the server said. {min} is
  // passed for the one message that carries a number.
  const report = ({ ok, body }, successKey) => {
    if (ok) {
      toast.success(t(successKey));
      return true;
    }
    toast.error(errorText(t, body, t("profile.failed"), { min: MIN_PASSWORD_LENGTH }));
    return false;
  };

  // session.js turns a request that got no answer into a NETWORK_ERROR
  // refusal, which report() words; the catch is for anything else that throws,
  // so a click never ends in an unhandled rejection and a silent button.
  const guard = async (fn) => {
    setBusy(true);
    try {
      return await fn();
    } catch (error) {
      console.error(error);
      toast.error(t("profile.failed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  // Managing a wallet is not a third role: it is being its creator, or being
  // the administrator of the instance. The endpoints check it again for
  // themselves; this only decides what gets drawn.
  const canManage = (w) => Boolean(w.mine) || isAdmin;

  const submitUsername = (e) => {
    e.preventDefault();
    return guard(async () => {
      const result = await changeUsername(username.trim(), usernamePassword);
      if (!report(result, "profile.usernameChanged")) return;
      setUsernamePassword("");
      // The name is on screen elsewhere -- the menu greets you by it -- and it
      // lives in App's `user`. Ask App to read /me again rather than reloading
      // the window: the session cookie never moved, and a reload would restart
      // every page's effects to change one word.
      await user.refresh();
    });
  };

  const submitPassword = (e) => {
    e.preventDefault();
    // Two client-side rules before bothering the server: the confirmation has
    // no meaning to it -- it only ever sees one new password -- and the length
    // is the same rule the sign-up form applies.
    if (passwords.next !== passwords.confirm) {
      toast.error(t("profile.passwordMismatch"));
      return;
    }
    if (passwords.next.length < MIN_PASSWORD_LENGTH) {
      toast.error(t("error.PASSWORD_TOO_SHORT", { min: MIN_PASSWORD_LENGTH }));
      return;
    }
    return guard(async () => {
      const result = await changePassword(passwords.current, passwords.next);
      if (report(result, "profile.passwordChanged")) {
        setPasswords({ current: "", next: "", confirm: "" });
      }
    });
  };

  // The password first, then the device's own prompt. The server will not
  // hand out a registration challenge without the password, so a session left
  // open on somebody else's machine cannot be turned into a permanent way in.
  const submitAddPasskey = (e) => {
    e.preventDefault();
    return guard(async () => {
      const result = await addPasskey(passkeyPassword, passkeyName.trim());
      // Cancelling the fingerprint prompt is a choice, not a failure.
      if (!result.ok && result.body && result.body.code === "PASSKEY_CANCELLED") return;
      if (!report(result, "profile.passkeyAdded")) return;
      setPasskeyPassword("");
      reloadPasskeys();
    });
  };

  const submitRenamePasskey = (e, p) => {
    e.preventDefault();
    return guard(async () => {
      if (report(await renamePasskey(p.id, passkeyDraft.trim()), "profile.passkeyRenamed")) {
        setRenamingPasskey(null);
        reloadPasskeys();
      }
    });
  };

  const submitDeletePasskey = (e, p) => {
    e.preventDefault();
    return guard(async () => {
      if (report(await deletePasskey(p.id), "profile.passkeyDeleted")) {
        setRemovingPasskey(null);
        reloadPasskeys();
      }
    });
  };

  const canAddPasskey = passkeysUsable(passkeyStatus);
  const showPasskeys = Boolean(passkeyStatus && passkeyStatus.passkeys) || passkeys.length > 0;

  const startRename = (w) => {
    setRenaming(w.id);
    setRenameDraft(w.name);
    setDeleting(null);
  };

  const submitRename = (e, w) => {
    e.preventDefault();
    return guard(async () => {
      if (report(await renameWallet(w.id, renameDraft.trim()), "profile.walletRenamed")) {
        setRenaming(null);
        reloadWallets();
        // The name of the wallet in context is drawn from App's `user` too, so
        // it is stale until /me is read again. Only the wallet actually open
        // needs that; renaming any other one is just the list.
        if (current && current.id === w.id) await user.refresh();
      }
    });
  };

  // Changing the currency is one select and one request: there is nothing to
  // confirm, because nothing is converted and nothing is lost. Picking the
  // wrong one costs a second select to put back.
  const submitCurrency = (w, currency) => {
    if (!currency || currency === w.currency) return;
    return guard(async () => {
      if (report(await setWalletCurrency(w.id, currency), "profile.walletCurrencyChanged")) {
        reloadWallets();
        // Every amount on screen is formatted from the wallet in context, and
        // that copy lives on App's `user`. Without this the picker shows the
        // new currency while the rest of the application still prints the old
        // symbol.
        if (current && current.id === w.id) await user.refresh();
      }
    });
  };

  const submitDelete = (e, w) => {
    e.preventDefault();
    return guard(async () => {
      if (!report(await deleteWallet(w.id, confirmName), "profile.walletDeleted")) return;
      setDeleting(null);
      setConfirmName("");
      if (current && current.id === w.id) {
        // The wallet this session was looking at no longer exists. The session
        // itself is perfectly valid, so the answer is the picker, not the
        // login screen.
        reportWalletLost();
        return;
      }
      reloadWallets();
    });
  };

  const cancelLeaving = () => {
    setLeaving(false);
    setLeaveName("");
    setLeavePassword("");
  };

  const submitDeleteAccount = (e) => {
    e.preventDefault();
    return guard(async () => {
      if (!report(await deleteAccount(leavePassword, leaveName.trim()), "profile.accountDeleted")) return;
      // There is nobody left to be signed in as. signOut asks the server to
      // end a session that has already gone with the account -- harmless --
      // and puts the login screen back with nothing of the old data on it.
      await user.signOut();
    });
  };

  const deletable = wallets.filter((w) => canManage(w) && w.first_wallet === false);
  const protectedOwn = wallets.filter((w) => canManage(w) && w.first_wallet === true);
  // What deleting the account takes along: the wallets it created. Not
  // canManage -- an administrator manages wallets that are not theirs, and
  // those stay.
  const created = wallets.filter((w) => w.mine);
  const leaveNameMatches =
    Boolean(me) && leaveName.trim().toLowerCase() === me.username.toLowerCase();

  return (
    <div className="profile">
      <button type="button" className="profile-back" onClick={() => navigate(-1)}>
        <FaArrowLeft /> {t("common.back")}
      </button>

      <section className="profile-section">
        <h2>{t("profile.account")}</h2>

        <form className="profile-form" onSubmit={submitUsername}>
          <p className="profile-hint">{t("profile.usernameHint")}</p>
          <label className="profile-field">
            <span>{t("profile.newUsername")}</span>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              autoComplete="username"
              required
            />
          </label>
          <label className="profile-field">
            <span>{t("profile.currentPassword")}</span>
            <input
              type="password"
              value={usernamePassword}
              onChange={(e) => setUsernamePassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          <button
            type="submit"
            className="profile-button"
            disabled={busy || !username.trim() || !usernamePassword || username.trim() === (me && me.username)}
          >
            <FaUser /> {t("profile.saveUsername")}
          </button>
        </form>

        <hr className="profile-rule" />

        <form className="profile-form" onSubmit={submitPassword}>
          {/* Worth saying out loud: the other devices are signed out and this
              one is not. Nobody expects a password change to be selective. */}
          <p className="profile-hint">{t("profile.passwordHint")}</p>
          <label className="profile-field">
            <span>{t("profile.currentPassword")}</span>
            <input
              type="password"
              value={passwords.current}
              onChange={(e) => setPasswords({ ...passwords, current: e.target.value })}
              autoComplete="current-password"
              required
            />
          </label>
          <label className="profile-field">
            <span>{t("profile.newPassword")}</span>
            <input
              type="password"
              value={passwords.next}
              onChange={(e) => setPasswords({ ...passwords, next: e.target.value })}
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
            />
          </label>
          <label className="profile-field">
            <span>{t("profile.confirmPassword")}</span>
            <input
              type="password"
              value={passwords.confirm}
              onChange={(e) => setPasswords({ ...passwords, confirm: e.target.value })}
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
            />
          </label>
          <button
            type="submit"
            className="profile-button"
            disabled={busy || !passwords.current || !passwords.next || !passwords.confirm}
          >
            <FaKey /> {t("profile.savePassword")}
          </button>
        </form>
      </section>

      {/* Passkeys sit with the credentials because they are one: another way
          of proving who you are, next to the password they never replace. */}
      {showPasskeys && (
        <section className="profile-section">
          <h2>{t("profile.passkeys")}</h2>
          <p className="profile-hint">{t("profile.passkeysHint")}</p>

          {passkeys.length === 0 ? (
            <p className="profile-hint">{t("profile.noPasskeys")}</p>
          ) : (
            <ul className="profile-list">
              {passkeys.map((p) => (
                <li key={p.id} className="profile-row">
                  {renamingPasskey === p.id ? (
                    <form className="profile-inline" onSubmit={(e) => submitRenamePasskey(e, p)}>
                      <input
                        type="text"
                        value={passkeyDraft}
                        onChange={(e) => setPasskeyDraft(e.target.value)}
                        maxLength={64}
                        aria-label={t("profile.passkeyName")}
                        required
                        autoFocus
                      />
                      <button type="submit" disabled={busy || !passkeyDraft.trim()}>
                        {t("common.save")}
                      </button>
                      <button type="button" onClick={() => setRenamingPasskey(null)} disabled={busy}>
                        {t("common.cancel")}
                      </button>
                    </form>
                  ) : removingPasskey === p.id ? (
                    <form className="profile-inline" onSubmit={(e) => submitDeletePasskey(e, p)}>
                      <span className="profile-confirm-ask">
                        {t("profile.deletePasskeyConfirm", { name: p.name })}
                      </span>
                      <button type="submit" className="profile-destructive" disabled={busy}>
                        <FaTrash /> {t("profile.deletePasskeyAction")}
                      </button>
                      <button type="button" onClick={() => setRemovingPasskey(null)} disabled={busy}>
                        {t("common.cancel")}
                      </button>
                    </form>
                  ) : (
                    <>
                      <span className="profile-name">
                        <FaFingerprint aria-hidden="true" /> {p.name}
                      </span>
                      <span className="profile-meta">
                        {t("profile.passkeyCreated", { date: formatDate(new Date(p.createdAt)) })} ·{" "}
                        {p.lastUsedAt
                          ? t("profile.passkeyLastUsed", { date: formatDate(new Date(p.lastUsedAt)) })
                          : t("profile.passkeyNeverUsed")}
                      </span>
                      <button
                        type="button"
                        className="profile-icon-button"
                        onClick={() => {
                          setRenamingPasskey(p.id);
                          setPasskeyDraft(p.name);
                          setRemovingPasskey(null);
                        }}
                        disabled={busy}
                        title={t("profile.renamePasskey")}
                        aria-label={t("profile.renamePasskey")}
                      >
                        <FaPen />
                      </button>
                      <button
                        type="button"
                        className="profile-icon-button"
                        onClick={() => {
                          setRemovingPasskey(p.id);
                          setRenamingPasskey(null);
                        }}
                        disabled={busy}
                        title={t("profile.deletePasskey")}
                        aria-label={t("profile.deletePasskey")}
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

          {canAddPasskey ? (
            <form className="profile-form" onSubmit={submitAddPasskey}>
              <label className="profile-field">
                <span>{t("profile.passkeyName")}</span>
                <input
                  type="text"
                  value={passkeyName}
                  onChange={(e) => setPasskeyName(e.target.value)}
                  maxLength={64}
                />
              </label>
              <label className="profile-field">
                <span>{t("profile.currentPassword")}</span>
                <input
                  type="password"
                  value={passkeyPassword}
                  onChange={(e) => setPasskeyPassword(e.target.value)}
                  autoComplete="current-password"
                  required
                />
              </label>
              <button type="submit" className="profile-button" disabled={busy || !passkeyPassword}>
                <FaFingerprint /> {t("profile.addPasskey")}
              </button>
            </form>
          ) : (
            // Say why there is no button, rather than leaving a riddle: either
            // the instance has them off, or this page is not where they work.
            <p className="profile-hint profile-protected">
              {passkeyStatus && passkeyStatus.passkeys
                ? t("profile.passkeysElsewhere", { origin: passkeyStatus.passkeyOrigin })
                : t("profile.passkeysOff")}
            </p>
          )}
        </section>
      )}

      {/* Notifications on the phone: drawn only when the server has Web Push on. */}
      <PushNotifications />

      {/* Tokens are credentials too, of a narrower kind: for an app or an
          automation that posts bank notifications to the inbox. */}
      <ApiTokens />

      {/* What the notification reader is told the person is called. */}
      <BankNames />

      <section className="profile-section">
        <h2>{t("profile.wallets")}</h2>
        <p className="profile-hint">{t("profile.walletsHint")}</p>

        <ul className="profile-list">
          {wallets.map((w) => (
            <li key={w.id} className="profile-row">
              {renaming === w.id ? (
                <form className="profile-inline" onSubmit={(e) => submitRename(e, w)}>
                  <input
                    type="text"
                    value={renameDraft}
                    onChange={(e) => setRenameDraft(e.target.value)}
                    maxLength={120}
                    aria-label={t("common.name")}
                    required
                    autoFocus
                  />
                  <button type="submit" disabled={busy || !renameDraft.trim()}>
                    {t("common.save")}
                  </button>
                  <button type="button" onClick={() => setRenaming(null)} disabled={busy}>
                    {t("common.cancel")}
                  </button>
                </form>
              ) : (
                <>
                  <span className="profile-name">
                    {w.name}
                    {current && current.id === w.id && (
                      <span className="profile-tag">{t("profile.openNow")}</span>
                    )}
                    {!w.mine && <span className="profile-tag">{t("profile.sharedWithYou")}</span>}
                  </span>
                  <span className="profile-meta">
                    {w.role === "rw" ? t("admin.roleWrite") : t("admin.roleRead")} ·{" "}
                    {membersLabel(t, w.members)}
                  </span>
                  {/* The unit, next to the members count because it is the
                      same kind of fact: something true of the wallet rather
                      than of the person reading it. Only its manager may
                      change it -- every member reads these numbers, so the
                      unit is not each member's to pick. A member who may not
                      change it still sees which one it is. */}
                  {canManage(w) ? (
                    <select
                      className="profile-currency"
                      value={w.currency || "EUR"}
                      onChange={(e) => submitCurrency(w, e.target.value)}
                      disabled={busy}
                      aria-label={t("profile.walletCurrency")}
                      title={t("profile.walletCurrency")}
                    >
                      {isoCurrencies.map((code) => (
                        <option key={code} value={code}>
                          {code}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <span className="profile-meta">{w.currency || "EUR"}</span>
                  )}
                  {canManage(w) && (
                    <button
                      type="button"
                      className="profile-icon-button"
                      onClick={() => startRename(w)}
                      disabled={busy}
                      title={t("profile.rename")}
                    >
                      <FaPen />
                    </button>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      </section>

      {/* Kept apart on purpose, and last: this is the only place in the
          application where data disappears for good. */}
      <section className="profile-section profile-danger">
        <h2>{t("profile.dangerZone")}</h2>
        <p className="profile-hint">{t("profile.deleteHint")}</p>

        <ul className="profile-list">
          {deletable.map((w) => (
            <li key={w.id} className="profile-row">
              {deleting === w.id ? (
                <form className="profile-inline" onSubmit={(e) => submitDelete(e, w)}>
                  {/* The wallet may not be only yours. Owning it is enough for
                      the server to let the deletion through, and the people it
                      was shared with are neither asked nor told -- so at least
                      say here that they exist. The count on the row includes
                      you; the sentence is about the others. */}
                  {w.members > 1 && (
                    <span className="profile-confirm-ask">
                      {w.members === 2
                        ? t("profile.deleteSharedOne")
                        : t("profile.deleteShared", { n: w.members - 1 })}
                    </span>
                  )}
                  <span className="profile-confirm-ask">
                    {t("profile.deleteConfirmHint", { name: w.name })}
                  </span>
                  <input
                    type="text"
                    value={confirmName}
                    onChange={(e) => setConfirmName(e.target.value)}
                    placeholder={t("profile.confirmPlaceholder")}
                    aria-label={t("profile.confirmPlaceholder")}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck="false"
                    required
                    autoFocus
                  />
                  <button
                    type="submit"
                    className="profile-destructive"
                    disabled={busy || confirmName !== w.name}
                  >
                    <FaTrash /> {t("profile.deleteAction")}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setDeleting(null);
                      setConfirmName("");
                    }}
                    disabled={busy}
                  >
                    {t("common.cancel")}
                  </button>
                </form>
              ) : (
                <>
                  <span className="profile-name">{w.name}</span>
                  <button
                    type="button"
                    className="profile-destructive"
                    onClick={() => {
                      setDeleting(w.id);
                      setConfirmName("");
                      setRenaming(null);
                    }}
                    disabled={busy}
                  >
                    <FaTrash /> {t("profile.deleteWallet")}
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>

        {/* A greyed-out button with no explanation is a riddle. The first
            wallet is not deletable at all, so say so in words instead. */}
        {protectedOwn.map((w) => (
          <p key={w.id} className="profile-hint profile-protected">
            {t("profile.firstWalletHint", { name: w.name })}
          </p>
        ))}
      </section>

      {/* The account itself, last of all. It takes every wallet it created,
          the first one too -- which is the only way that one ever goes. Not
          drawn for an administrator, whom the server refuses: the account
          the instance was installed with lives as long as the instance. */}
      {!isAdmin && (
      <section className="profile-section profile-danger">
        <h2>{t("profile.deleteAccountTitle")}</h2>
        <p className="profile-hint">{t("profile.deleteAccountHint")}</p>
        <p className="profile-hint">
          {created.length
            ? t("profile.deleteAccountWallets", {
                wallets: created.map((w) => `“${w.name}” (${membersLabel(t, w.members)})`).join(", "),
              })
            : t("profile.deleteAccountNoWallets")}
        </p>

        {leaving ? (
          <form className="profile-form" onSubmit={submitDeleteAccount}>
            <p className="profile-hint">
              {t("profile.deleteAccountConfirm", { username: me && me.username })}
            </p>
            <label className="profile-field">
              <span>{t("login.username")}</span>
              <input
                type="text"
                value={leaveName}
                onChange={(e) => setLeaveName(e.target.value)}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                autoComplete="off"
                required
                autoFocus
              />
            </label>
            <label className="profile-field">
              <span>{t("profile.currentPassword")}</span>
              <input
                type="password"
                value={leavePassword}
                onChange={(e) => setLeavePassword(e.target.value)}
                autoComplete="current-password"
                required
              />
            </label>
            <div className="profile-inline">
              <button
                type="submit"
                className="profile-destructive"
                disabled={busy || !leavePassword || !leaveNameMatches}
              >
                <FaTrash /> {t("profile.deleteAccountAction")}
              </button>
              <button type="button" onClick={cancelLeaving} disabled={busy}>
                {t("common.cancel")}
              </button>
            </div>
          </form>
        ) : (
          <button
            type="button"
            className="profile-button profile-destructive"
            onClick={() => setLeaving(true)}
            disabled={busy}
          >
            <FaTrash /> {t("profile.deleteAccount")}
          </button>
        )}
      </section>
      )}
    </div>
  );
}

export default Profile;
