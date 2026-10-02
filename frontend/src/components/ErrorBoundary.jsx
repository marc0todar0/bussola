import { Component } from "react";
import { mainColor } from "../config";
import { useT } from "../i18n";
import "./Login.css";

// What the app shows instead of a blank page when a component throws while
// rendering. Without a boundary React unmounts the whole tree, and a finance
// app that goes white with no word of explanation looks like it lost the data.
//
// One case is not a bug at all: after an upgrade the old hashed bundles are
// gone from the server, and a page whose code is loaded lazily (Summary,
// Portfolio, the settings pages) fails to import in a browser still running
// the previous index.html. A reload fetches the new one, so the boundary does
// it once by itself -- guarded in sessionStorage so that a chunk which is
// genuinely missing cannot reload the page in a loop -- and offers the button
// otherwise.

const CHUNK_ERROR =
  /Failed to fetch dynamically imported module|error loading dynamically imported module|Importing a module script failed|Unable to preload CSS|Loading (CSS )?chunk .* failed/i;

const isChunkLoadError = (error) =>
  Boolean(error) &&
  (error.name === "ChunkLoadError" || CHUNK_ERROR.test(String(error.message || error)));

const RELOAD_KEY = "bussola.chunkReloadAt";
const RELOAD_WINDOW_MS = 60 * 1000;

// True when a reload was started. At most one per minute: a second chunk
// failure right after reloading means the file really is not there, and the
// person gets the button instead of a page that keeps flashing.
const reloadOnce = () => {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY)) || 0;
    if (Date.now() - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false; // no storage, no guard: do not risk a loop
  }
  window.location.reload();
  return true;
};

const reload = () => window.location.reload();

// A message, a line of explanation and one button. `fullScreen` draws it the
// way the login screen is drawn, for when there is no app around it; without,
// it sits in the content area under the tab bar.
export function ProblemPanel({ title, hint, action, onAction, fullScreen }) {
  const box = (
    <div className="login-box" role="alert" style={fullScreen ? undefined : styles.inlineBox}>
      <h1 className="login-title" style={{ color: mainColor, fontSize: "1.25rem" }}>
        {title}
      </h1>
      <p className="login-subtitle">{hint}</p>
      <button
        type="button"
        className="login-submit"
        style={{ backgroundColor: mainColor }}
        onClick={onAction}
      >
        {action}
      </button>
    </div>
  );
  return fullScreen ? <div className="login-background">{box}</div> : <div style={styles.inline}>{box}</div>;
}

function ErrorFallback({ error, fullScreen }) {
  const { t } = useT();
  const chunk = isChunkLoadError(error);
  return (
    <ProblemPanel
      fullScreen={fullScreen}
      title={chunk ? t("app.updated") : t("app.crashed")}
      hint={chunk ? t("app.updatedHint") : t("app.crashedHint")}
      action={t("app.reload")}
      onAction={reload}
    />
  );
}

// `resetKey`: when it changes (the route, for the boundary around the pages)
// the error is forgotten and the children are tried again, so a page that
// crashed does not take the other tabs down with it.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, reloading: false };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error(error, info && info.componentStack);
    if (isChunkLoadError(error) && reloadOnce()) this.setState({ reloading: true });
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null, reloading: false });
    }
  }

  render() {
    const { error, reloading } = this.state;
    if (reloading) return null;
    if (error) return <ErrorFallback error={error} fullScreen={this.props.fullScreen} />;
    return this.props.children;
  }
}

const styles = {
  inline: {
    display: "flex",
    justifyContent: "center",
    padding: "3rem 1rem",
  },
  inlineBox: {
    boxShadow: "none",
  },
};
