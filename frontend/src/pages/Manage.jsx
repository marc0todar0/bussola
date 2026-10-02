import { useCallback, useContext, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import { FaArrowLeft, FaTrash, FaUnlock, FaUserPlus } from "react-icons/fa";
import GlobalContext from "../context/GlobalContext";
import { useT } from "../i18n";
import { membersLabel } from "../utils/generic";
import { errorText } from "../utils/errorText";
import {
  walletMembers,
  addWalletMember,
  setMemberRole,
  removeWalletMember,
  listUsers,
  createUser,
  setUserActive,
  unlockUser,
  listAllWallets,
  deleteUser,
  deleteWallet,
  reportWalletLost,
} from "../utils/session";
import "./Manage.css";

// Who else can open this wallet, and -- for the instance's administrator --
// who has an account at all.
//
// Two audiences on one screen because they are two halves of one question. The
// members section is for whoever created the wallet: it is their data being
// shared. The accounts section only appears for the administrator, and it
// deliberately shows accounts and wallet names and nothing else: administering
// the instance is not a key to anybody's numbers.
function Manage() {
  const { t } = useT();
  const navigate = useNavigate();
  const { user, wallet } = useContext(GlobalContext);
  const isAdmin = Boolean(user.data && user.data.isAdmin);
  const current = wallet.data;

  const [members, setMembers] = useState([]);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState("r");
  const [busy, setBusy] = useState(false);

  const [users, setUsers] = useState([]);
  const [allWallets, setAllWallets] = useState([]);
  const [newUser, setNewUser] = useState({ username: "", password: "" });
  // Which row is asking "are you sure": { kind: "user" | "wallet", id }, and
  // the name typed back so far.
  const [confirming, setConfirming] = useState(null);
  const [confirmText, setConfirmText] = useState("");

  const reloadMembers = useCallback(() => {
    if (current) walletMembers(current.id).then(setMembers);
  }, [current]);

  const reloadAdmin = useCallback(() => {
    if (!isAdmin) return;
    listUsers().then(setUsers);
    listAllWallets().then(setAllWallets);
  }, [isAdmin]);

  useEffect(() => {
    reloadMembers();
    reloadAdmin();
  }, [reloadMembers, reloadAdmin]);

  // The server sends a stable code alongside its English text: translate the
  // code when we know it, and fall back to what the server said.
  const report = ({ ok, body }, successKey) => {
    if (ok) {
      toast.success(t(successKey));
      return true;
    }
    toast.error(errorText(t, body, t("admin.failed")));
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
      toast.error(t("admin.failed"));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const invite = (e) => {
    e.preventDefault();
    return guard(async () => {
      if (report(await addWalletMember(current.id, username.trim(), role), "admin.memberAdded")) {
        setUsername("");
        reloadMembers();
      }
    });
  };

  const changeRole = (member, nextRole) =>
    guard(async () => {
      if (report(await setMemberRole(current.id, member.id, nextRole), "admin.roleChanged")) {
        reloadMembers();
      }
    });

  const revoke = (member) =>
    guard(async () => {
      if (report(await removeWalletMember(current.id, member.id), "admin.memberRemoved")) {
        reloadMembers();
      }
    });

  const addUser = (e) => {
    e.preventDefault();
    return guard(async () => {
      const result = await createUser({
        username: newUser.username.trim(),
        password: newUser.password,
        locale: user.data.locale,
      });
      if (report(result, "admin.userCreated")) {
        setNewUser({ username: "", password: "" });
        reloadAdmin();
      }
    });
  };

  const toggleActive = (u) =>
    guard(async () => {
      if (report(await setUserActive(u.username, !u.active), "admin.userUpdated")) reloadAdmin();
    });

  const unlock = (u) =>
    guard(async () => {
      if (report(await unlockUser(u.username), "admin.userUpdated")) reloadAdmin();
    });

  const isConfirming = (kind, id) => Boolean(confirming && confirming.kind === kind && confirming.id === id);
  const askConfirm = (kind, id) => {
    setConfirming({ kind, id });
    setConfirmText("");
  };
  const cancelConfirm = () => {
    setConfirming(null);
    setConfirmText("");
  };

  // The wallets an account created, which deleting it takes along.
  const createdBy = (u) => allWallets.filter((w) => w.created_by === u.id);

  // When what goes is the wallet on screen, the app has to leave it now rather
  // than at the next request that fails.
  const removeUser = (e, u) => {
    e.preventDefault();
    return guard(async () => {
      const takesCurrent = Boolean(current && createdBy(u).some((w) => w.id === current.id));
      if (!report(await deleteUser(u.username, confirmText), "admin.userDeleted")) return;
      cancelConfirm();
      if (takesCurrent) return reportWalletLost();
      reloadAdmin();
      reloadMembers();
    });
  };

  const removeWallet = (e, w) => {
    e.preventDefault();
    return guard(async () => {
      if (!report(await deleteWallet(w.id, confirmText), "admin.walletDeleted")) return;
      cancelConfirm();
      if (current && current.id === w.id) return reportWalletLost();
      reloadAdmin();
    });
  };

  // The row turned into the question: what goes, the name to type back, and
  // the two answers.
  const confirmForm = ({ onSubmit, lines, expected, action, placeholder }) => (
    <form className="manage-confirm" onSubmit={onSubmit}>
      {lines.map((line) => (
        <span key={line} className="manage-confirm-ask">
          {line}
        </span>
      ))}
      <input
        type="text"
        value={confirmText}
        onChange={(e) => setConfirmText(e.target.value)}
        aria-label={placeholder}
        placeholder={placeholder}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck="false"
        required
        autoFocus
      />
      <button type="submit" className="manage-destructive" disabled={busy || confirmText !== expected}>
        <FaTrash /> {action}
      </button>
      <button type="button" onClick={cancelConfirm} disabled={busy}>
        {t("common.cancel")}
      </button>
    </form>
  );

  return (
    <div className="manage">
      <button type="button" className="manage-back" onClick={() => navigate(-1)}>
        <FaArrowLeft /> {t("common.back")}
      </button>

      {current && current.canManage && (
        <section className="manage-section">
          <h2>{t("admin.membersOf", { wallet: current.name })}</h2>
          <p className="manage-hint">{t("admin.membersHint")}</p>

          <ul className="manage-list">
            {members.map((m) => (
              <li key={m.id} className="manage-row">
                <span className="manage-name">
                  {m.username}
                  {m.creator && <span className="manage-tag">{t("admin.creator")}</span>}
                  {!m.active && <span className="manage-tag manage-tag-off">{t("admin.disabled")}</span>}
                </span>

                <select
                  value={m.role}
                  onChange={(e) => changeRole(m, e.target.value)}
                  disabled={busy}
                  aria-label={t("admin.role")}
                >
                  <option value="rw">{t("admin.roleWrite")}</option>
                  <option value="r">{t("admin.roleRead")}</option>
                </select>

                <button
                  type="button"
                  className="manage-icon-button"
                  onClick={() => revoke(m)}
                  disabled={busy}
                  title={t("admin.remove")}
                >
                  <FaTrash />
                </button>
              </li>
            ))}
          </ul>

          <form className="manage-form" onSubmit={invite}>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              placeholder={t("login.username")}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck="false"
              required
            />
            <select value={role} onChange={(e) => setRole(e.target.value)}>
              <option value="r">{t("admin.roleRead")}</option>
              <option value="rw">{t("admin.roleWrite")}</option>
            </select>
            <button type="submit" disabled={busy || !username.trim()}>
              <FaUserPlus /> {t("admin.add")}
            </button>
          </form>
        </section>
      )}

      {isAdmin && (
        <>
          <section className="manage-section">
            <h2>{t("admin.accounts")}</h2>
            <ul className="manage-list">
              {users.map((u) => (
                <li key={u.id} className="manage-row">
                  {isConfirming("user", u.id) ? (
                    confirmForm({
                      onSubmit: (e) => removeUser(e, u),
                      expected: u.username,
                      action: t("admin.deleteUser"),
                      placeholder: t("login.username"),
                      lines: [
                        createdBy(u).length
                          ? t("admin.deleteUserWallets", {
                              wallets: createdBy(u)
                                .map((w) => `“${w.name}” (${membersLabel(t, w.members)})`)
                                .join(", "),
                            })
                          : t("admin.deleteUserNoWallets"),
                        t("admin.deleteUserConfirm", { username: u.username }),
                      ],
                    })
                  ) : (
                    <>
                      <span className="manage-name">
                        {u.username}
                        {u.is_admin && <span className="manage-tag">{t("admin.administrator")}</span>}
                        {!u.active && (
                          <span className="manage-tag manage-tag-off">{t("admin.disabled")}</span>
                        )}
                        {u.active && u.locked && (
                          <span className="manage-tag manage-tag-off">{t("admin.lockedOut")}</span>
                        )}
                      </span>

                      {/* Two different repairs: an account switched off by hand is
                          switched back on, one that the wrong-password lock is
                          holding is unlocked now rather than when it lifts by
                          itself. */}
                      {u.active && u.locked ? (
                        <button type="button" onClick={() => unlock(u)} disabled={busy}>
                          <FaUnlock /> {t("admin.unlock")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => toggleActive(u)}
                          disabled={busy || u.id === user.data.id}
                          title={u.id === user.data.id ? t("admin.notYourself") : undefined}
                        >
                          {u.active ? t("admin.disable") : t("admin.enable")}
                        </button>
                      )}

                      <button
                        type="button"
                        className="manage-icon-button"
                        onClick={() => askConfirm("user", u.id)}
                        disabled={busy || u.id === user.data.id}
                        title={u.id === user.data.id ? t("admin.notYourself") : t("admin.deleteUser")}
                        aria-label={t("admin.deleteUser")}
                      >
                        <FaTrash />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>

            <form className="manage-form" onSubmit={addUser}>
              <input
                type="text"
                value={newUser.username}
                onChange={(e) => setNewUser({ ...newUser, username: e.target.value })}
                placeholder={t("login.username")}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck="false"
                required
              />
              <input
                type="password"
                value={newUser.password}
                onChange={(e) => setNewUser({ ...newUser, password: e.target.value })}
                placeholder={t("login.password")}
                autoComplete="new-password"
                required
              />
              <button type="submit" disabled={busy}>
                <FaUserPlus /> {t("admin.createUser")}
              </button>
            </form>
            <p className="manage-hint">{t("admin.createUserHint")}</p>
          </section>

          <section className="manage-section">
            <h2>{t("admin.wallets")}</h2>
            <p className="manage-hint">{t("admin.walletsHint")}</p>
            <ul className="manage-list">
              {allWallets.map((w) => (
                <li key={w.id} className="manage-row">
                  {isConfirming("wallet", w.id) ? (
                    confirmForm({
                      onSubmit: (e) => removeWallet(e, w),
                      expected: w.name,
                      action: t("admin.deleteWallet"),
                      placeholder: t("profile.confirmPlaceholder"),
                      lines: [t("admin.deleteWalletConfirm", { name: w.name })],
                    })
                  ) : (
                    <>
                      <span className="manage-name">{w.name}</span>
                      <span className="manage-meta">
                        {t("admin.createdBy", { username: w.created_by_username || "-" })} ·{" "}
                        {membersLabel(t, w.members)}
                      </span>
                      <button
                        type="button"
                        className="manage-icon-button"
                        onClick={() => askConfirm("wallet", w.id)}
                        disabled={busy}
                        title={t("admin.deleteWallet")}
                        aria-label={t("admin.deleteWallet")}
                      >
                        <FaTrash />
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </div>
  );
}

export default Manage;
