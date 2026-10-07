# Android with Automate

[← Bank notifications](notifications.md)

[Automate](https://llamalab.com/automate/) (LlamaLab) is free, with no ads. The free version runs at most 30 blocks at once; this flow has 23.

The flow handles the cases that break a simpler automation:

- **Notifications arriving together.** One loop finds them and starts a separate *fiber* for each send. A fiber gets its own copy of the variables ([Fork](https://llamalab.com/automate/doc/block/fork.html)), so one notification cannot overwrite another's text or id. With shared variables, one notification would be sent twice and another never sent.
- **A notification missed while the loop was busy.** On every wake-up the flow goes through **all** the notifications still in the status bar, not only the newest one.
- **Sending the same notification twice.** Each one gets a stable id (the app and a hash of the notification), sent as `X-Bussola-Notification-Id`. Bussola stores it once and answers `200 "duplicate"` to any repeat.
- **No network.** The send is retried 12 times over about two hours (after 1, 2, 3 and 4 minutes, then every 15). If it still fails, or Bussola refuses it (a wrong token, say), you get a notification on the phone.
- **Privacy.** The log shows the id, the app and Bussola's answer. The notification text never goes into the log.

Tested on a Pixel 8a (Android 17, Automate 1.53): three notifications in the same second became three drafts, a restart sent nothing twice, a send with the server down arrived on the first retry, and a revoked token raised the *not sent* notification.

## Install

1. Download [Bussola_inbox.flo](https://github.com/marc0todar0/bussola/raw/main/docs/automate/Bussola_inbox.flo) on the phone. In **Automate**, open the menu (⋮) → **Import** and pick the file.
2. Open the flow → **Flowchart** and change three blocks (tap a block to edit it, then **Save**):
   - **2** `url`: your address + `/api/inbox`, in quotes, e.g. `"https://bussola.example.com/api/inbox"`
   - **3** `token`: your token, in quotes. To make one, see [Create a token](notifications.md#2-create-a-token).
   - **4** `banks`: your bank apps, each with the name Bussola will show, e.g. `{"com.revolut.revolut": "Revolut", "it.hype.app": "HYPE"}`. The package name is in the app's Play Store address, after `id=`.
3. Clear your bank notifications from the status bar. Otherwise the flow sends them all when it starts.
4. Tap **Start** and grant the privileges it asks for. *Access notifications* opens Android's settings: allow Automate there.
5. **Automate → Settings → Run on system startup**: on, so the flow comes back after a reboot.
6. **Android Settings → Apps → Automate → Battery → Unrestricted**, so it is not stopped in the background.

To check it, open the flow → **Log** after the next bank notification. A line `Bussola #… → 201 {"id":…}` is the draft arriving in the inbox.

Automate also lists *access to manage all files* among the privileges. The flow reads and writes no files; the HTTP block asks for it because it *can* save a response to a file. You can deny it.

## How it works

Block numbers are the ones shown on the flowchart (13 and 16 are not used).

### Finding the notifications

| # | Block | Settings | Exits |
|---|---|---|---|
| 1 | **Flow beginning** | | → 2 |
| 2–4 | **Variable set** | `url`, `token`, `banks` (see Install) | → 5 |
| 5 | **Variable set** | `sent` = `{}` | → 6 |
| 6 | **Variable set** | `i` = `0` | → 7 |
| 7 | **Notification posted?** | Proceed *Immediately* · Exclude *Ongoing*, *Foreground service*, *Group summary* · Index `i` · outputs `pkg`, `title`, `message`, `when`, `extras`, `nid` | YES → 8 · NO → 14 |
| 8 | **Variable set** | `id` = `pkg ++ "-" ++ md5(nid ++ "-" ++ when)` | → 9 |
| 9 | **Expression true?** | `contains(banks, pkg, "k") && !contains(sent, id, "k")` | YES → 10 · NO → 12 |
| 10 | **Dictionary put** | `sent[id]` = `1` | → 11 |
| 11 | **Fork** | | OK → 12 · NEW → 15 |
| 12 | **Variable set** | `i` = `i + 1` | → 7 |
| 14 | **Notification posted?** | Proceed *When transition* · same exclusions | YES → 6 · NO → 14 |

Blocks 6–12 go through every notification in the status bar. A bank notification not seen before is marked in `sent` and handed to a new fiber (block 11, NEW). Block 14 then waits for the next notification from any app, and the scan starts again.

### Sending one notification (the NEW fiber)

| # | Block | Settings | Exits |
|---|---|---|---|
| 15 | **Variable set** | `tries` = `0` | → 17 |
| 17 | **Failure catch** | Retry limit `100` | OK → 18 · FAIL → 23 |
| 18 | **HTTP request** | URL `url` · *POST* · content type *Text* · body `title ++ " " ++ message` · headers `{"Authorization": "Bearer " ++ token, "X-Bussola-Source": banks[pkg], "X-Bussola-Notification-Id": id}` · timeout `30` · response saved as text in `answer`, status in `code` | → 19 |
| 19 | **Log append** | `"Bussola #" ++ id ++ " " ++ banks[pkg] ++ " -> " ++ code ++ " " ++ answer` | → 20 |
| 20 | **Expression true?** | `code >= 200 && code < 300` | YES → *(done)* · NO → 21 |
| 21 | **Expression true?** | `code >= 400 && code < 500` | YES → 22 · NO → 23 |
| 22 | **Notification show** | *Bussola: not sent* · `banks[pkg] ++ ": " ++ title ++ " -> " ++ code` · Proceed *When dismissed* | *(end)* |
| 23 | **Variable set** | `tries` = `tries + 1` | → 24 |
| 24 | **Expression true?** | `tries <= 12` | YES → 25 · NO → 22 |
| 25 | **Delay** | `tries < 5 ? tries * 60 : 900` seconds · *Awake device* | → 18 |

- A `2xx` answer (`201` stored, `200` duplicate) ends the fiber.
- A `4xx` answer will not change on a retry, so block 22 tells you right away. Most often it is the token (`401`) or no reading model (`409 AI_DISABLED`); see [response codes](#response-codes).
- No answer, or a `5xx`, is retried. A network failure lands on block 17's FAIL dot and joins the same path.
- If you change the flow, never connect a NEW path back into blocks 1–14: every fiber would start its own copy of the loop.

## Notes

- If a bank's message is cut short, its full text may be in the notification's extras. Try the body `title ++ " " ++ (extras["android.bigText"] || message)` in block 18.
- The `sent` dictionary lives only while the flow runs. After a restart, notifications still in the status bar are sent again, and Bussola answers `200 "duplicate"` to each.
- Bussola also drops a copy that comes with a different id: the same text from the same app within 2 minutes ([Inbox API](inbox-api.md)).

## Response codes

The flow's log shows the code after `->`.

| Code | Meaning | Fix |
|---|---|---|
| `201` | Received | — |
| `200` duplicate | Already received | — |
| no line, then *not sent* | No answer | See [Unreachable](#unreachable) |
| `400 INBOX_EMPTY` | Empty body | Content type must be *Text* |
| `401 TOKEN_INVALID` | Bad or revoked token | Block 3 holds the whole token, in quotes |
| `403 TOKEN_FORBIDDEN` | The owner can no longer write | Create a new token |
| `409 AI_DISABLED` | No reading model | [Set one up](notifications.md#1-set-up-a-reading-model) |
| `429` | Too many invalid tokens | Fix the token and wait 15 min |

## Unreachable

If your domain points to a home address (`192.168.x.x`), the phone can't reach it on mobile data. Fix it with one of:

- a public address with HTTPS
- an always-on VPN (Tailscale, WireGuard, Twingate)
- split DNS

## Tips

- On **Android 15+**, if notifications arrive empty, turn off *Enhanced notifications*.
- Another automation app works too, as long as each send keeps its own variables. The request is in [Inbox API](inbox-api.md): `POST /api/inbox`, `text/plain` body, `X-Bussola-Source` and `X-Bussola-Notification-Id` headers.
