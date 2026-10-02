// The words for a refusal from the API.
//
// The server sends a stable `code` alongside its English text. Translate the
// code when the catalogues know it; otherwise show what the server said; and
// failing that, the caller's own fallback. t() answers a missing key with the
// key itself rather than with nothing, so `t(...) || body.error` would never
// reach the second choice -- hence the comparison with the key.
//
// `vars` are interpolated into the translation (e.g. { min } for the password
// length, { minutes } for the lock).
export const errorText = (t, body, fallback, vars) => {
  const code = body && body.code;
  if (code) {
    const key = `error.${code}`;
    const text = t(key, vars);
    if (text && text !== key) return text;
  }
  return (body && typeof body.error === "string" && body.error) || fallback;
};

export default errorText;
