#!/usr/bin/env bash
set -eu
ci_source_dir="$(cd -- "$(dirname -- "$0")" && pwd)"
ci_uuid='codex-island@yangz24.github.io'
ci_install_dir="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$ci_uuid"
for ci_cmd in gnome-shell python3 glib-compile-schemas; do
    command -v "$ci_cmd" >/dev/null || { printf 'Missing dependency: %s\n' "$ci_cmd" >&2; exit 1; }
done
case "$(gnome-shell --version)" in
    'GNOME Shell 46'|'GNOME Shell 46.'*) ;;
    *) printf '%s\n' 'Only GNOME Shell 46 is currently supported.' >&2; exit 1 ;;
esac
mkdir -p "$ci_install_dir/schemas"
for ci_file in metadata.json extension.js stylesheet.css collector.py; do
    install -m 644 "$ci_source_dir/$ci_file" "$ci_install_dir/$ci_file"
done
install -m 644 "$ci_source_dir/schemas/"*.xml "$ci_install_dir/schemas/"
glib-compile-schemas --strict "$ci_install_dir/schemas"
printf '%s\n' "Installed to $ci_install_dir" 'Save your work, log out and log back in. Then run:' "gnome-extensions enable $ci_uuid" 'The installer does not automatically enable the extension.'
