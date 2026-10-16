#!/usr/bin/env bash
# Runs only a private headless compositor, never the user's desktop shell.
set -euo pipefail
ci_repo="$(cd -- "$(dirname -- "$0")/.." && pwd)"
if [[ ${1:-} != --inside ]]; then
    for ci_cmd in gnome-shell dbus-run-session glib-compile-schemas gdbus python3 timeout; do
        command -v "$ci_cmd" >/dev/null || { echo "Missing: $ci_cmd" >&2; exit 1; }
    done
    ci_tmp="$(mktemp -d)"
    trap 'rm -rf -- "$ci_tmp"' EXIT
    mkdir -p "$ci_tmp/run" "$ci_tmp/data/gnome-shell/extensions/codex-island@yangz24.github.io" "$ci_tmp/config" "$ci_tmp/cache/codex-island"
    chmod 700 "$ci_tmp/run"
    ci_ext="$ci_tmp/data/gnome-shell/extensions/codex-island@yangz24.github.io"
    cp "$ci_repo/"{metadata.json,extension.js,stylesheet.css} "$ci_ext/"
    cp -r "$ci_repo/schemas" "$ci_ext/"
    glib-compile-schemas --strict "$ci_ext/schemas"
    # Avoid starting Codex, authentication, or any account requests during this test.
    printf '%s\n' 'print("test collector")' > "$ci_ext/collector.py"
    printf '%s\n' '{"status":"ok","windows":[{"minutes":300,"remaining":75,"resetsAt":2000000000}],"summary":{},"daily":null,"updatedAt":2000000000}' > "$ci_tmp/cache/codex-island/usage.json"
    python3 - "$ci_ext/extension.js" <<'PY'
import sys
from pathlib import Path
p=Path(sys.argv[1]);s=p.read_text().replace('this._alive = true;', 'this._alive = true; global.context.unsafe_mode=true; global.ciTest=this; Main.overview.hide();')
s=s.replace('    _later(ms, fn) {', '''    setupInput() {this.pointer=Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);}
    pointerMove(x,y) {this.pointer.notify_absolute_motion(GLib.get_monotonic_time(),x,y);}
    pointerButton(down) {this.pointer.notify_button(GLib.get_monotonic_time(),1,down?Clutter.ButtonState.PRESSED:Clutter.ButtonState.RELEASED);}
    _later(ms, fn) {''');p.write_text(s)
PY
    cat > "$ci_tmp/bus.conf" <<'XML'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen><auth>EXTERNAL</auth><apparmor mode="disabled"/><policy context="default"><allow send_destination="*" eavesdrop="true"/><allow eavesdrop="true"/><allow own="*"/></policy></busconfig>
XML
    env XDG_RUNTIME_DIR="$ci_tmp/run" XDG_DATA_HOME="$ci_tmp/data" XDG_CONFIG_HOME="$ci_tmp/config" XDG_CACHE_HOME="$ci_tmp/cache" GSETTINGS_BACKEND=keyfile LIBGL_ALWAYS_SOFTWARE=1 \
        timeout 60 dbus-run-session --config-file="$ci_tmp/bus.conf" -- bash "$0" --inside
    exit
fi
gsettings set org.gnome.shell enabled-extensions "['codex-island@yangz24.github.io']"
gsettings set org.gnome.shell disable-user-extensions false
gnome-shell --headless --wayland --no-x11 --virtual-monitor=1280x800 > "$XDG_CACHE_HOME/shell.log" 2>&1 &
ci_pid=$!
trap 'kill "$ci_pid" 2>/dev/null || true; wait "$ci_pid" 2>/dev/null || true' EXIT
ci_eval() { timeout 4 gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "$1"; }
ci_assert() { local result; result=$(ci_eval "$1"); [[ "$result" == "(true, 'true')" ]] || { echo "FAIL: $1 -> $result" >&2; exit 1; }; }
for ci_i in {1..20}; do
    if ci_eval 'Boolean(global.ciTest)' 2>/dev/null | grep -Fq "(true, 'true')"; then break; fi
    sleep 1
done
ci_assert 'Boolean(global.ciTest)'
ci_eval 'global.ciTest.setupInput();true' >/dev/null
sleep 1
ci_eval 'global.ciTest.pointerMove(global.ciTest._root.x+80,global.ciTest._root.y+20);true' >/dev/null
sleep 1
ci_eval 'global.ciTest.pointerButton(true);true' >/dev/null
sleep 1
ci_assert 'Boolean(global.ciTest._press)'
ci_eval 'global.ciTest.pointerMove(800,150);true' >/dev/null
sleep 1
ci_eval 'global.ciTest.pointerButton(false);true' >/dev/null
sleep 1
ci_assert '!global.ciTest._press && !global.ciTest._grab'
ci_eval 'global.ciTest._beginDrag(500,65);true' >/dev/null
sleep 11
ci_assert '!global.ciTest._press && !global.ciTest._grab'
ci_eval 'global.ciTest._settings.set_int("font-size",24);global.ciTest._expand(true);true' >/dev/null
sleep 1
ci_assert 'global.ciTest._root.height <= global.stage.height'
ci_eval 'global.ciTest.disable();true' >/dev/null
ci_assert '!global.ciTest._root && !global.ciTest._grab && !global.ciTest._proc'
printf '%s\n' 'PASS: real pointer press/move/release, lost-release watchdog, maximum font layout, disable cleanup.'
