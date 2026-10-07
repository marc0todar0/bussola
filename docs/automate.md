# Android with Automate

[← Bank notifications](notifications.md)

[Automate](https://llamalab.com/automate/) (LlamaLab) is free, with no ads. The free version is limited to 30 blocks in running flows, and this flow uses 21.

The flow is built to survive the cases that break a simpler automation:

- **Notifications arriving together.** One loop finds them and starts a separate *fiber* for each send. A fiber gets its own copy of the variables ([Fork](https://llamalab.com/automate/doc/block/fork.html)), so one notification cannot overwrite another's text or id. This was the MacroDroid bug: one notification sent twice, another never sent.
- **A notification missed while the loop was busy.** On every wake-up the flow goes through **all** the notifications still in the status bar, not only the newest one. Anything a bank left there is picked up at the next wake-up.
- **Sending the same notification twice.** Each one has a stable id, `package-id-time`, sent as `X-Bussola-Notification-Id`. Bussola stores it once and answers `200 "duplicate"` to any repeat, after a reboot too.
- **No network.** The send is retried 12 times over about two hours (1, 2, 3, 4 minutes, then every 15). If it still fails, or Bussola refuses it (a wrong token, say), you get a notification on the phone.
- **Privacy.** The log shows the id, the app and Bussola's answer. The notification text never goes into the log.

## Before you start

- A token (`bpt_…`): see [Create a token](notifications.md#2-create-a-token).
- The package names of your bank apps. Open the app's page on the Play Store; the name is in the address after `id=`, e.g. `com.revolut.revolut`.
- Clear your bank notifications from the status bar before starting the flow for the first time. Otherwise the flow sends them all when it starts.

## The flow

Create a new flow and add these blocks. The number is the block, and the arrows say where each exit dot goes. An **fx** value is an expression: tap the field's **fx** toggle before typing it.

### Finding the notifications (blocks 1–10)

| # | Block | Settings | Exits |
|---|---|---|---|
| 1 | **Flow beginning** | | → 2 |
| 2 | **Variable set** | Variable `banks`, Value **fx** `{"com.revolut.revolut": "Revolut", "it.hype.app": "HYPE"}`: your apps' package names, each with the name Bussola shows | → 3 |
| 3 | **Variable set** | Variable `sent`, Value **fx** `{}` | → 4 |
| 4 | **Variable set** | Variable `i`, Value **fx** `0` | → 5 |
| 5 | **Notification posted?** | Proceed *Immediately* · Exclude flags *Group summary* · Index **fx** `i` · outputs: Package `pkg`, Title `title`, Message `message`, Notification id `nid`, When timestamp `when` | YES → 6 · NO → 10 |
| 6 | **Expression true?** | **fx** `contains(banks, pkg, "k") && !contains(sent, pkg ++ "-" ++ nid ++ "-" ++ when, "k")` | YES → 7 · NO → 9 |
| 7 | **Dictionary put** | Dictionary `sent`, Key **fx** `pkg ++ "-" ++ nid ++ "-" ++ when`, Value **fx** `1` | → 8 |
| 8 | **Fork** | | OK → 9 · NEW → 11 |
| 9 | **Variable set** | Variable `i`, Value **fx** `i + 1` | → 5 |
| 10 | **Notification posted?** | Proceed *When transition* · Exclude flags *Group summary* | YES → 4 · NO → 10 |

Blocks 4–9 go through every notification in the status bar. A bank notification not seen before is marked in `sent` and handed to a new fiber (block 8, NEW). Then block 10 waits for the next notification from any app, and the scan starts again.

### Sending one notification (blocks 11–21, the NEW fiber)

| # | Block | Settings | Exits |
|---|---|---|---|
| 11 | **Variable set** | Variable `id`, Value **fx** `pkg ++ "-" ++ nid ++ "-" ++ when` | → 12 |
| 12 | **Variable set** | Variable `tries`, Value **fx** `0` | → 13 |
| 13 | **Failure catch** | Retry limit `100` | OK → 14 · FAIL → 18 |
| 14 | **HTTP request** | Request URL `https://your-bussola/api/inbox` · Method *POST* · Request content type `text/plain; charset=utf-8` · Request content body **fx** `title ++ " " ++ message` · Request headers **fx** `{"Authorization": "Bearer bpt_…", "X-Bussola-Source": banks[pkg], "X-Bussola-Notification-Id": id}` · Timeout `30` · Save response *as text* in `answer` · Response status code `code` | → 15 |
| 15 | **Log append** | Message **fx** `"Bussola #" ++ id ++ " " ++ banks[pkg] ++ " → " ++ code ++ " " ++ answer` | → 16 |
| 16 | **Expression true?** | **fx** `code >= 200 && code < 300` | YES → *(nothing: done)* · NO → 17 |
| 17 | **Expression true?** | **fx** `code >= 400 && code < 500` | YES → 21 · NO → 18 |
| 18 | **Variable set** | Variable `tries`, Value **fx** `tries + 1` | → 19 |
| 19 | **Expression true?** | **fx** `tries <= 12` | YES → 20 · NO → 21 |
| 20 | **Delay** | Duration **fx** `tries < 5 ? tries * 60 : 900` · Wake up *on* | → 14 |
| 21 | **Notification show** | Title `Bussola: not sent` · Message **fx** `banks[pkg] ++ ": " ++ title ++ " → " ++ code` · Proceed *When dismissed* | *(nothing)* |

- A `2xx` answer (`201` stored, `200` duplicate) ends the fiber.
- A `4xx` answer will not change on a retry: block 21 tells you right away. Most often it is the token (`401`) or no reading model (`409 AI_DISABLED`); see [response codes](macrodroid.md#response-codes).
- No answer, or a `5xx`, is retried. A network failure lands on block 13's FAIL dot and joins the same path.
- Never connect a NEW path back into blocks 1–10: every fiber would start its own copy of the loop.

## Start it

1. Save the flow and start it. Grant the privileges it asks for (*notification access*, *internet*).
2. **Automate → Settings → Run on system startup**: on, so the flow comes back after a reboot.
3. **Android Settings → Apps → Automate → Battery → Unrestricted**, so it is not stopped in the background.

To test it, send yourself a small payment, or check the flow's log (flow details → **Log**) after the next notification. A line `→ 201 {"id":…}` is the draft arriving in the inbox.

## Notes

- If a bank's message is cut short, its full text may be in the notification's extras. Try the body **fx** `title ++ " " ++ (extras["android.bigText"] || message)`, with *Extras* `extras` added to block 5's outputs.
- The `sent` dictionary is kept only while the flow runs. After a restart, notifications still in the status bar are sent again, and Bussola answers `200 "duplicate"` to each.
- Bussola also drops a copy that comes with a different id: the same text from the same app within 2 minutes ([Inbox API](inbox-api.md)).
