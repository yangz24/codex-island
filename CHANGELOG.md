# Changelog

## v3 — 2026-10-16

First public source release, based on the corrected development build.

- Remaining quota, reset countdowns and account token activity via Codex app-server.
- Persistent 12–24px font sizing, header dragging and position reset.
- Fix input capture: listen on the grabbed actor, not the stage above it.
- Cancel previous grabs and grabs on hidden widgets; limit capture to 10 seconds.
- Inherit GNOME manual proxy settings when the desktop has no proxy environment variables, fixing stale/offline usage.
- Record failed-attempt timestamp and safe error categories without credentials.
- Install without automatic enabling or restarting the desktop.
- Chinese/English documentation and collector regression checks.
- Serialize cache writes, reject malformed responses, recover corrupt caches and reap timed-out process groups.
- Ignore stale process callbacks after disable/re-enable and update the collapsed stale indicator.

The unpublished development v2 could leave input grabbed after a click. Do not use old development copies; the public repository contains only corrected code.
