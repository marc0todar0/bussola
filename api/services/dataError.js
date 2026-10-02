// An error a controller raises on purpose: a status, a stable code the
// interface translates, the English text for everybody else, and whatever
// numbers the message needs ({max} megabytes, {version}).
//
// Any data endpoint may throw one -- a missing row (404 ACCOUNT_NOT_FOUND), a
// refused change (409 CATEGORY_IN_USE), a file that is too big (413
// IMPORT_TOO_LARGE). publicError() in auth/middleware.js answers it with its
// own status, code and words, where any other error gets a generic body.
//
// What happens to the transaction depends on who catches it:
//
//   - withWallet / withWalletWrite / withWalletPhased: the error goes up
//     through db.withTenant, which ROLLS BACK. Throwing one after a write is
//     safe there.
//   - routes/data.js (`coded`): caught inside the transaction and answered
//     there, so the transaction COMMITS. The import and export controllers
//     therefore throw a DataError only before their first write.
class DataError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

module.exports = DataError;
