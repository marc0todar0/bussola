# Phone notifications

[← Bank notifications](notifications.md)

Your phone tells you when a draft is waiting. Bussola uses Web Push from the browser itself: no extra app.

## Requirements

- `BUSSOLA_PUBLIC_URL` set to your HTTPS address ([setup](install.md#https-and-passkeys))
- Android: Chrome, Brave, Edge, Firefox or Samsung Internet
- iPhone/iPad: iOS 16.4+, **and Bussola added to the Home Screen**
- The server can reach the push services on the internet

## Setup

1. **Install Bussola on the phone:**
   - Android: browser menu → **Install app**
   - iPhone: Safari → **Share → Add to Home Screen**
2. Open it from the icon, then go to **Profile → Notifications on this device → Turn on**.
3. Tap **Send a test notification**.

<p align="center">
  <img src="screenshots/push-notification.png" width="220" alt="A Bussola notification on Android">
  <img src="screenshots/inbox-drafts.png" width="220" alt="The inbox with Accept, Review and Dismiss">
</p>

## What you get

- By default the message says only "something is waiting". With `BUSSOLA_NOTIFY_DETAILS=on` it also shows the amount and the merchant.
- Everyone who can write to the wallet is notified, on each device where they turned notifications on.
- A burst becomes a single message ("4 items are waiting").
- Signing out stops notifications on that browser. They come back when you sign in again.

## Not arriving?

- **Arrives only when you open the app:** Android battery saving is the cause. Go to **Settings → Apps → Chrome/Brave → Battery → Unrestricted**.
- **Not arriving at all:** check the permission in the phone settings, then look in the API log for `[push] could not send …`.
- Phones without Google services (e.g. GrapheneOS) may not get Web Push in Chromium browsers.

## For administrators

- The signing key (VAPID) is created automatically and stored in the database, so your database backup includes it.
- Only push-service hosts from Google, Mozilla, Apple and Microsoft are accepted. `BUSSOLA_PUSH_ALLOWED_HOSTS` adds others.
- The service worker caches nothing.
