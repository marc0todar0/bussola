import { useCallback, useContext, useEffect, useState } from "react";
import toast from "react-hot-toast";
import { FaBell, FaBellSlash, FaPaperPlane } from "react-icons/fa";
import { useT } from "../i18n";
import { instanceStatus, pushStatus, pushTest } from "../utils/session";
import { currentSubscription, disablePush, enablePush, pushCapability, rememberPushOwner } from "../utils/push";
import GlobalContext from "../context/GlobalContext";

// Where installing Bussola on a phone is explained, step by step.
const DOCS_URL = "https://github.com/marc0todar0/bussola/blob/main/docs/notifications.md#getting-a-notification-on-your-phone";

// "Notifications on this device": a section of the profile page, in its frame
// and with its classes (Profile.css). It is about this browser, not the
// account: each phone or computer turns it on for itself.
//
// States: the server has it off (nothing is drawn), the browser cannot do it
// (not https, not supported, an iPhone that has not got Bussola on its Home
// Screen), the person refused it in the browser's settings, off, on.
export default function PushNotifications() {
  const { t } = useT();
  const { user } = useContext(GlobalContext);
  const userId = user && user.data ? user.data.id : null;
  const [status, setStatus] = useState(null);
  const [subscribed, setSubscribed] = useState(false);
  const [capability, setCapability] = useState(pushCapability);
  const [busy, setBusy] = useState(false);

  // The browser's own subscription is not enough: the server binds it to the
  // session that saved it, so one left over from an earlier sign-in (or
  // another account on this browser) receives nothing and counts as off.
  // Turning it on again re-posts it and binds it to this session.
  const refresh = useCallback(async () => {
    setCapability(pushCapability());
    const subscription = await currentSubscription();
    if (!subscription) return setSubscribed(false);
    try {
      const result = await pushStatus(subscription.endpoint);
      setSubscribed(result.ok ? Boolean(result.body && result.body.subscribed) : true);
    } catch {
      setSubscribed(true); // server unreachable: show what the browser holds
    }
  }, []);

  useEffect(() => {
    let live = true;
    instanceStatus().then((s) => live && setStatus(s));
    refresh();
    return () => {
      live = false;
    };
  }, [refresh]);

  const failed = (result) => {
    const code = result && result.body && result.body.code;
    const text = code ? t(`error.${code}`) : null;
    toast.error(text && text !== `error.${code}` ? text : (result && result.body && result.body.error) || t("profile.failed"));
  };

  // Hidden entirely when the server says push is off.
  if (!status || !status.push) return null;

  const run = async (fn, successKey) => {
    setBusy(true);
    try {
      const result = await fn();
      if (result.ok) toast.success(t(successKey));
      else failed(result);
    } finally {
      await refresh();
      setBusy(false);
    }
  };

  const hint =
    capability === "insecure" ? t("profile.pushInsecure")
    : capability === "ios-install" ? t("profile.pushIos")
    : capability === "unsupported" ? t("profile.pushUnsupported")
    : capability === "blocked" ? t("profile.pushBlocked")
    : subscribed ? t("profile.pushOn")
    : t("profile.pushOff");

  const usable = capability === "ready";

  return (
    <section className="profile-section">
      <h2>{t("profile.push")}</h2>
      <p className="profile-hint">{t("profile.pushHint")}</p>

      <p className="profile-hint" role="status">
        {hint}
        {(capability === "ios-install" || capability === "insecure") && (
          <>
            {" "}
            <a href={DOCS_URL} target="_blank" rel="noreferrer">
              {t("profile.pushDocs")}
            </a>
          </>
        )}
      </p>

      {usable && (
        <div className="profile-actions">
          {subscribed ? (
            <>
              <button
                type="button"
                className="profile-button"
                disabled={busy}
                onClick={() => run(() => pushTest(), "profile.pushTestSent")}
              >
                <FaPaperPlane aria-hidden="true" /> {t("profile.pushTest")}
              </button>
              <button
                type="button"
                className="profile-button"
                disabled={busy}
                onClick={() => run(disablePush, "profile.pushDisabled")}
              >
                <FaBellSlash aria-hidden="true" /> {t("profile.pushDisable")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="profile-button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const result = await enablePush(status.pushPublicKey);
                  if (result.ok) rememberPushOwner(userId);
                  return result;
                }, "profile.pushEnabled")
              }
            >
              <FaBell aria-hidden="true" /> {t("profile.pushEnable")}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
