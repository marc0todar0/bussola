#!/usr/bin/env node
//
// Re-enable an account from the command line.
//
//   docker exec bussola-api node scripts/unlock.js            # list the accounts
//   docker exec bussola-api node scripts/unlock.js <username> # switch one back on
//
// This exists for the case the admin endpoint cannot cover: the only
// administrator locks themselves out. There is nobody left who can call
// POST /api/auth/users/:username/unlock, and without this the instance would
// be shut for good. Whoever has a shell on the server is the administrator of
// last resort, which on a self-hosted box is the honest answer anyway.
//
// It connects as PGUSER through the admin pool, so it does not need a session
// and is not subject to the account being disabled.

const db = require("../dbConn");

const listAccounts = async () => {
  const { rows } = await db.adminPool.query(
    `SELECT id, username, is_admin, active, lockouts, locked_until,
            (locked_until IS NOT NULL AND locked_until > now()) AS locked
       FROM users ORDER BY id`,
  );

  if (rows.length === 0) {
    console.log("No accounts yet.");
    return;
  }

  // Two different states: switched off by an
  // administrator, or held for a while by the wrong-password lock (which
  // lifts by itself at the time shown).
  for (const u of rows) {
    const state = !u.active
      ? "disabled by an administrator"
      : u.locked
        ? `LOCKED after wrong passwords until ${u.locked_until.toISOString()} (lock #${u.lockouts})`
        : "active";
    console.log(`  ${String(u.id).padStart(3)}  ${u.username.padEnd(24)} ${u.is_admin ? "admin " : "      "} ${state}`);
  }
};

const unlock = async (username) => {
  const { rows } = await db.adminPool.query(
    `UPDATE users
        SET active = true, failed_logins = 0, lockouts = 0, locked_until = NULL
      WHERE lower(username) = lower($1)
  RETURNING username, is_admin`,
    [username],
  );

  if (rows.length === 0) {
    console.error(`No account named "${username}". Run without arguments to list them.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Account "${rows[0].username}" is active again.`);
};

const main = async () => {
  const username = process.argv[2];
  try {
    if (username) await unlock(username);
    else await listAccounts();
  } catch (error) {
    console.error("Failed:", error.message);
    process.exitCode = 1;
  } finally {
    await db.closeAll();
  }
};

main();
