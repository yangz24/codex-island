# Codex Island

A Dynamic Island inspired Codex usage widget for **GNOME Shell 46 / Linux**.

**[完整中文说明](README.md)** · [MIT License](LICENSE)

![Illustrative preview with synthetic data](docs/preview.svg)

A compact pill shows your remaining Codex quota. Hover to expand for reset countdowns and account token activity. Drag the header to move it; use **A− / A＋** to adjust text from 12–24px. Position and font size persist across logins.

## Supported environment

- GNOME Shell **46**, tested on Ubuntu with Wayland. Not a Windows/macOS app.
- Python 3 and `glib-compile-schemas` (Ubuntu: `libglib2.0-bin`). No pip/npm dependencies.
- Installed Codex CLI, signed in with your own ChatGPT account. CLI 0.161.0 was tested. Other versions and plans may expose different data.
- `codex` must be available in the GNOME Shell process PATH. A terminal-only nvm/asdf PATH is not necessarily inherited by the desktop.

## Install

```bash
git clone https://github.com/yangz24/codex-island.git
cd codex-island
bash install.sh
```

Save your work, **log out and log back in**, then enable:

```bash
gnome-extensions enable codex-island@yangz24.github.io
```

The installer does not automatically enable the extension or restart your desktop. Updating the JavaScript also requires logging out/in on Wayland.

This public package uses a separate UUID from the original development build. If you have the old `codex-island@gino.local` build, disable it to avoid duplicate widgets.

## Controls

| Action | Result |
| --- | --- |
| Hover / leave | Expand / collapse |
| Click header | Pin / unpin |
| Drag header | Move and save position |
| Escape while dragging | Cancel drag |
| A− / A＋ | Adjust font size |
| Bottom reset-position button | Restore top center |
| Right-click header / refresh button | Fetch usage |

Reads account data every 120 seconds; countdowns update every 30 seconds. Fullscreen hiding uses GNOME's chrome tracking. Missing values display `—`, never a guessed zero. Offline snapshots remain visible with a warning; snapshots older than six minutes are marked stale. Header input grabs are limited to ten seconds as a recovery safeguard.

## Data and privacy

The Python collector calls the official `codex app-server --stdio` methods `account/rateLimits/read` and `account/usage/read`. It reuses **your own local Codex login**; Codex manages authentication and its own runtime files. The collector does not directly read credentials, parse conversations, or issue model requests.

Statistics are cached in `$XDG_CACHE_HOME/codex-island/usage.json` (default `~/.cache/...`) with mode 0600. Font and position use GSettings. This repository contains no account usage, credentials, or conversation logs. The preview uses synthetic data.

**Quota remaining is a percentage, not a remaining token budget.** Account token statistics use the server's accounting rules, and are not an invoice. Daily buckets can lag; the widget matches today's local date against the server's date strings, whose timezone is not specified. Missing today's bucket displays `—` with the latest available dated bucket shown separately.

## Troubleshooting / disable

```bash
gnome-extensions info codex-island@yangz24.github.io
gnome-extensions disable codex-island@yangz24.github.io
python3 ~/.local/share/gnome-shell/extensions/codex-island@yangz24.github.io/collector.py
```

The collector command prints only a small statistical summary. If statistics are unavailable, confirm `codex` is installed, signed in, and discoverable from the desktop PATH. API-key-only account token activity is not supported by this interface.

## Validation and limitations

Collector regression tests cover normal quotas, out-of-range percentages, absent data, partial endpoint failures, stale-data retention and cache permissions. Isolated GNOME 46 tests covered rendering, font sizes, persisted settings and full virtual-pointer press/move/release handling, including a lost-release timeout. The original user confirmed the fixed version works after restarting; this is not a guarantee for all hardware or desktop configurations. Only GNOME 46 is declared supported.

An unpublished development v2 had a serious input-grab bug that could lock desktop interaction. v3 handles captured events on the grab actor itself and adds bounded input capture. Only the fixed v3 code is included here. See [CHANGELOG](CHANGELOG.md).

```bash
python3 -m unittest discover -p 'test_*.py' -v
node --input-type=module --check < extension.js
glib-compile-schemas --strict --dry-run schemas
```

## Credits

Independently implemented; no third-party source copied. Inspired by [Agent Usage Widget](https://github.com/chunnylab/agent-usage-widget) and [Dynamic Island for Linux](https://github.com/kimxuanhong/dynamic-island-linux). Data interface: [official Codex App Server documentation](https://learn.chatgpt.com/docs/app-server).

Not affiliated with or endorsed by OpenAI or Apple.

## Desktop proxy support

The collector honors existing HTTP(S)/ALL_PROXY environment variables. If none are set, it reads GNOME manual HTTP/HTTPS proxy settings (via optional PyGObject, typically `python3-gi` on Ubuntu) and passes them only to its child app-server. It does not change system proxy settings or read proxy passwords. PAC/automatic proxy scripts and authenticated GNOME proxies are not resolved automatically. Failed attempts preserve the previous successful snapshot and include a non-sensitive error category and attemptedAt timestamp in the local cache.

## Review hardening

Cache writes use an exclusive lock and unique 0600 temporary files. Invalid RPC results and corrupt cache documents are handled as failures. Each RPC has a 25-second deadline, and app-server process groups are terminated and reaped on normal completion, timeout or termination. The widget sends SIGTERM on disable; late callbacks from previous polls cannot reset newer poll state. Closed widgets still update their stale indicator every 30 seconds. See the Chinese README for the full configuration, upgrade, uninstall and troubleshooting guide.
