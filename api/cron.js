const cron = require("node-cron");
const db = require("./dbConn");
const portfolio_controller = require("./controllers/portfolio_controller");

// Monthly portfolio snapshot.
// The schedule is configurable through the SNAPSHOT_CRON env var (5-field cron
// format). Default: the 1st of the month at 03:00. Set SNAPSHOT_CRON="off" to
// disable it (for instance when a system crontab calls
// POST /api/portfolio/snapshot instead).

// The snapshot is not a single thing: there is one per wallet. Each runs in
// its own transaction, so one wallet's failure does not leave everyone else
// without a snapshot this month.
//
// A snapshot is a write, and writes need a member who may write: the cron acts
// as one of the wallet's own rw members rather than through a back door in the
// policies. A wallet with none -- everybody read-only, or every writer
// disabled -- is skipped, which is the honest outcome: nobody can write there.
const snapshotEveryone = async () => {
  const { rows } = await db.queryAuth(
    `SELECT w.id, w.name,
            (SELECT m.user_id
               FROM wallet_members m
               JOIN users u ON u.id = m.user_id AND u.active
              WHERE m.wallet_id = w.id AND m.role = 'rw'
              ORDER BY m.user_id
              LIMIT 1) AS actor
       FROM wallets w
      ORDER BY w.id`,
  );
  let succeeded = 0;
  let skipped = 0;

  for (const wallet of rows) {
    if (!wallet.actor) {
      console.warn(`Snapshot skipped for "${wallet.name}": no active member who can write.`);
      skipped += 1;
      continue;
    }
    try {
      const res = await db.withTenant(
        { userId: wallet.actor, walletId: wallet.id, write: true },
        () => portfolio_controller.createSnapshot(),
      );
      console.log(`Snapshot ${res.month}/${res.year} saved for "${wallet.name}".`);
      succeeded += 1;
    } catch (error) {
      console.error(`Snapshot failed for "${wallet.name}":`, error.message);
    }
  }

  return { total: rows.length, succeeded, skipped };
};

const startSnapshotCron = () => {
  const schedule = process.env.SNAPSHOT_CRON || "0 3 1 * *";
  if (schedule === "off") {
    console.log("Snapshot cron disabled (SNAPSHOT_CRON=off).");
    return;
  }
  if (!cron.validate(schedule)) {
    console.error(`Invalid SNAPSHOT_CRON: "${schedule}" -- cron not started.`);
    return;
  }
  // The callback catches its own failures. node-cron 3 swallows a rejected
  // task: it emits "task-failed" to nobody, so a first query that failed --
  // the database restarting at three in the morning -- meant no snapshot this
  // month and not a word about it anywhere. Each wallet's own failure is
  // already reported inside snapshotEveryone; this is for the run as a whole.
  cron.schedule(schedule, async () => {
    try {
      const { total, succeeded, skipped } = await snapshotEveryone();
      const failed = total - succeeded - skipped;
      const line = `Monthly snapshot complete: ${succeeded}/${total} wallets` +
        (skipped ? `, ${skipped} skipped` : "") + (failed ? `, ${failed} FAILED` : "") + ".";
      if (failed) console.error(line);
      else console.log(line);
    } catch (error) {
      console.error("Monthly snapshot run failed before it could reach any wallet:", error);
    }
  });
  console.log(`Snapshot cron active (schedule: "${schedule}").`);
};

module.exports = { startSnapshotCron, snapshotEveryone };
