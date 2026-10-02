const crypto = require("node:crypto");
const { promisify } = require("node:util");

const scrypt = promisify(crypto.scrypt);

// scrypt rather than argon2: it ships inside Node, so the image needs no build
// toolchain and there is no native binary to source per architecture -- Bussola
// also runs on a Raspberry Pi. It is a memory-hard KDF that OWASP accepts.
//
// The parameters are stored inside the hash, so changing them does not
// invalidate existing passwords: those stay verifiable with their own.
const N = 1 << 16; // 64 MB at r=8
const R = 8;
const P = 1;
const KEY_LENGTH = 32;
const MAXMEM = 192 * 1024 * 1024;

const derive = (password, salt, n, r, p) =>
  scrypt(password.normalize("NFKC"), salt, KEY_LENGTH, { N: n, r, p, maxmem: MAXMEM });

// Format: scrypt$N$r$p$salt$hash -- readable, versioned, migratable.
const hashPassword = async (password) => {
  const salt = crypto.randomBytes(16);
  const hash = await derive(password, salt, N, R, P);
  return ["scrypt", N, R, P, salt.toString("base64"), hash.toString("base64")].join("$");
};

// A hash of nothing in particular, made once, for the account that is not
// there. Signing in as a username that does not exist must cost the same
// 64 MB scrypt as signing in as one that does: answering in a millisecond
// instead of a few hundred would tell anybody with a stopwatch who has an
// account here. Made on first use rather than at require time, so a script
// that only lists accounts does not pay for it.
let dummyHash = null;
const dummy = () => {
  if (!dummyHash) dummyHash = hashPassword(crypto.randomBytes(32).toString("base64url"));
  return dummyHash;
};

// Always derives a key, whatever `stored` is. A missing hash (no such
// username) and a malformed one are checked against the dummy above and then
// refused, so every "no" takes as long as a real one.
const verifyPassword = async (password, stored) => {
  const usable =
    typeof stored === "string" && stored.split("$").length === 6 && stored.startsWith("scrypt$");
  if (!usable) {
    await verifyPassword(String(password || ""), await dummy());
    return false;
  }

  const [, n, r, p, saltB64, hashB64] = stored.split("$");
  const salt = Buffer.from(saltB64, "base64");
  const expected = Buffer.from(hashB64, "base64");

  let computed;
  try {
    computed = await derive(password, salt, Number(n), Number(r), Number(p));
  } catch {
    return false;
  }
  if (computed.length !== expected.length) return false;
  return crypto.timingSafeEqual(computed, expected);
};

// Made-up complexity rules help nobody: all this checks is that the password
// is not trivially short. Real strength is the chooser's responsibility.
const MIN_PASSWORD_LENGTH = 6;
const passwordAcceptable = (password) =>
  typeof password === "string" && password.length >= MIN_PASSWORD_LENGTH;

module.exports = { hashPassword, verifyPassword, passwordAcceptable, MIN_PASSWORD_LENGTH };
