# Security policy

Bussola holds people's money records, so a security report is the most useful issue you can send. Back to the [README](README.md).

## Reporting a vulnerability

**Do not open a public issue.** Report it privately through GitHub: the repository's **Security** tab → **Report a vulnerability**. Only the maintainer sees it.

Please include what you found, the version (or commit) and how to reproduce it. A request sequence, a script or a short video is enough; a fix is welcome but not needed.

What to expect:

- an acknowledgement within a week;
- a first assessment, and whether it is accepted, within two weeks;
- a fix in a new release, credited to you in the [changelog](CHANGELOG.md) and the advisory unless you prefer otherwise.

Bussola is maintained by one person in their spare time, so these are intentions, not contractual deadlines. Please give a fix the chance to ship before disclosing.

## Supported versions

Only the latest release gets security fixes. Upgrading is pulling the new images: migrations run by themselves at start (see [Upgrade](docs/operations.md#upgrade)).

## In scope

Anything in this repository, in particular:

- one wallet reading or changing another wallet's data, or a read-only member writing;
- getting past sign-in, a session, a passkey, the lockout or a rate limit;
- an API token (`bpt_…`) doing more than posting to the inbox;
- script injection through names, descriptions, imported files or notifications;
- the API or the `quotes` container being made to call an address of the attacker's choosing;
- secrets (VAPID private key, AI or quote provider keys, password hashes) leaking into answers or logs.

## Out of scope

- An installation exposed without HTTPS, or with the defaults changed against the advice in [Security notes](docs/security.md).
- The public demo: it runs entirely in your browser on invented data, with no server behind it.
- The third-party price and model providers themselves.
- Reports from automated scanners with no demonstrated impact, and missing headers that do not lead to an attack.

How the protections work is described in [docs/security.md](docs/security.md).
