// ---------------------------------------------------------------------------
// When a failed reading is tried again
// ---------------------------------------------------------------------------
// A reading that failed for a reason waiting can mend (extract.isTransient: a
// quota, a server error, a timeout, an endpoint down) is tried again later
// instead of being left for the hand at once. The waits grow, so that a model
// that is down for an afternoon is not asked every minute:
//
//   after the 1st failure   1 min
//   after the 2nd           5 min
//   after the 3rd          30 min
//   after the 4th           2 h
//   after the 5th          given up: 'failed', for the hand, as before
//
// A 429 that says how long to wait (Retry-After) is obeyed when it asks for
// longer than the table, up to two hours: a quota for the day is not worth
// keeping a notification from the person for longer than that.
//
// Pure: the controller keeps the count and the moment on the row (attempts,
// next_attempt_at, migration 007), so a restart loses nothing.
const MINUTE = 60 * 1000;
const BACKOFF_MS = [1 * MINUTE, 5 * MINUTE, 30 * MINUTE, 120 * MINUTE];
const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
const RETRY_AFTER_CAP_MS = 120 * MINUTE;

// How long to wait before the next reading, `failures` being the failed
// readings so far, this one included; null when there is to be no next one.
const nextDelayMs = (failures, retryAfterMs = null) => {
  if (!Number.isInteger(failures) || failures < 1 || failures >= MAX_ATTEMPTS) return null;
  const table = BACKOFF_MS[failures - 1];
  const asked = Number.isFinite(retryAfterMs) && retryAfterMs > 0 ? Math.min(retryAfterMs, RETRY_AFTER_CAP_MS) : 0;
  return Math.max(table, asked);
};

module.exports = { BACKOFF_MS, MAX_ATTEMPTS, RETRY_AFTER_CAP_MS, nextDelayMs };
