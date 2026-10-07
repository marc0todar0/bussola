# Inbox API

[← Bank notifications](notifications.md)

The token endpoints take `Authorization: Bearer bpt_…`. No other endpoint accepts a token.

## `POST /api/inbox`

Text, which needs a reading model:

```json
{ "source": "iPhone", "text": "Payment of €12.40 at Esselunga" }
```

or a `text/plain` body with `?source=App`. Up to 2,000 characters.

A ready-made draft, which needs no model:

```json
{
  "source": "my-app",
  "draft": { "amount": 12.40, "date": "2026-09-29", "description": "Esselunga",
             "type": "EXPENSE", "from_id": 3, "to_id": 12 }
}
```

- Every `draft` field is optional.
- `type` is `EXPENSE`, `INCOME` or `TRANSFER`.
- An id that isn't in the token's wallet is dropped.

**Answer:** `201` at once. The model reads in the background.

```json
{ "id": 42, "status": "pending", "received": { "kind": "text", "chars": 37 },
  "reading": "queued", "source": "iPhone", "message": "Received 37 characters…" }
```

**Idempotency:** pass `notification_id` (1–100 characters) in the body, the query or the `X-Bussola-Notification-Id` header. A repeat in the same wallet stores nothing and returns `200` with the original item and `"duplicate": true`.

**Copies by text:** a text-only notification with exactly the same text, from the same `source`, as one received in the last 2 minutes is also answered `200` `"duplicate": true` (the message says "same text"), whatever its `notification_id`. Bank texts carry the balance, so two real movements do not read the same; two copies of one do, when an automation running several times at once mixes up its variables. Drafts are never matched by text.

## `GET /api/inbox/context`

Returns the wallet currency, the accounts and categories (ids and names), and up to 200 recent `merchant → category` pairs. No balances or amounts.

## Errors

Every error body is `{ "code", "error" }`.

| Status | Code |
|---|---|
| 400 | `INBOX_EMPTY`, `INBOX_TEXT_TOO_LONG`, `INVALID_NOTIFICATION_ID`, `INVALID_REQUEST` |
| 401 | `TOKEN_INVALID` (missing, unknown or revoked) |
| 403 | `TOKEN_FORBIDDEN` (the owner can no longer write) |
| 409 | `AI_DISABLED` (text only, no model; nothing kept) |
| 429 | `TOO_MANY_ATTEMPTS` |

## Session endpoints (used by the interface)

- `GET /api/inbox`: pending items, with `extraction`, `attempts` and `next_attempt_at`
- `POST /api/inbox/:id/accept`, `POST /api/inbox/:id/dismiss`
- `POST|DELETE /api/auth/push/subscribe`, `POST /api/auth/push/status`, `POST /api/auth/push/test` (5 per 10 min, at most 10 devices per account)

## Security

- Tokens are stored hashed, and creating one asks for your password.
- A notification's text is deleted once the draft is accepted or dismissed.
- Invalid tokens are throttled per address.
