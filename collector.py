#!/usr/bin/env python3
"""Read-only Codex app-server client. Never reads credentials or conversation text."""
import fcntl, json, math, os, selectors, shutil, signal, subprocess, tempfile, time
from pathlib import Path
from urllib.parse import quote

def stop_collector(*_):
    raise SystemExit(0)

signal.signal(signal.SIGTERM, stop_collector)

RPC_TIMEOUT = 25

CACHE = Path(os.environ.get('XDG_CACHE_HOME', str(Path.home()/'.cache'))) / 'codex-island' / 'usage.json'

def app_server_environment():
    """Honor process proxy variables; otherwise inherit GNOME's manual proxy."""
    env = dict(os.environ)
    if any(env.get(k) for k in ('HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','http_proxy','https_proxy','all_proxy')):
        return env
    try:
        from gi.repository import Gio
        settings = Gio.Settings.new('org.gnome.system.proxy')
        if settings.get_string('mode') != 'manual':
            return env
        http = Gio.Settings.new('org.gnome.system.proxy.http')
        if http.get_boolean('use-authentication'):
            return env  # Do not extract proxy credentials.
        for protocol in ('http','https'):
            proxy = http if settings.get_boolean('use-same-proxy') else Gio.Settings.new(f'org.gnome.system.proxy.{protocol}')
            host, port = proxy.get_string('host'), proxy.get_int('port')
            if host and port:
                host = f'[{host}]' if ':' in host else quote(host, safe='.-')
                env[f'{protocol.upper()}_PROXY'] = f'http://{host}:{port}'
        ignored = settings.get_strv('ignore-hosts')
        if ignored and not env.get('NO_PROXY') and not env.get('no_proxy'):
            env['NO_PROXY'] = ','.join(ignored)
    except Exception:
        pass  # Non-GNOME environments may have no PyGObject or proxy schemas.
    return env

def collect():
    exe = shutil.which('codex')
    if not exe:
        raise RuntimeError('codex_missing')
    p = subprocess.Popen([exe, 'app-server', '--stdio'], stdin=subprocess.PIPE,
                         stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, env=app_server_environment(), start_new_session=True)
    sel = selectors.DefaultSelector()
    sel.register(p.stdout, selectors.EVENT_READ)
    buf = b''
    def send(msg):
        p.stdin.write((json.dumps(msg)+'\n').encode()); p.stdin.flush()
    def receive(wanted, timeout=None):
        timeout = RPC_TIMEOUT if timeout is None else timeout
        nonlocal buf
        end = time.monotonic()+timeout
        while time.monotonic() < end:
            while b'\n' in buf:
                line, buf = buf.split(b'\n', 1)
                try: msg = json.loads(line)
                except ValueError: continue
                if not isinstance(msg,dict): continue
                if msg.get('id') == wanted:
                    if 'error' in msg: raise RuntimeError('rpc_error')
                    result = msg.get('result')
                    if not isinstance(result,dict): raise RuntimeError('invalid_response')
                    return result
            if sel.select(max(0, end-time.monotonic())):
                chunk = os.read(p.stdout.fileno(), 65536)
                if not chunk: raise RuntimeError('server_closed')
                buf += chunk
        raise RuntimeError('timeout')
    try:
        send({'id':1,'method':'initialize','params':{'clientInfo':{'name':'codex_island','version':'1.0.0'},'capabilities':{'experimentalApi':True}}})
        receive(1)
        send({'method':'initialized'})
        send({'id':2,'method':'account/rateLimits/read'})
        limits = receive(2)
        send({'id':3,'method':'account/usage/read'})
        try: usage = receive(3)
        except RuntimeError: usage = {}
        buckets = limits.get('rateLimitsByLimitId') or {}
        base = buckets.get('codex') or limits.get('rateLimits') or {}
        windows = []
        for key in ('primary','secondary'):
            w = base.get(key)
            if not isinstance(w,dict): continue
            used = w.get('usedPercent')
            windows.append({'minutes':w.get('windowDurationMins'),'remaining':max(0,min(100,100-used)) if type(used) in (int,float) and math.isfinite(used) else None,'resetsAt':w.get('resetsAt')})
        return {'updatedAt':int(time.time()),'windows':windows,'summary':usage.get('summary') if isinstance(usage.get('summary'),dict) else {},
                'daily':usage.get('dailyUsageBuckets') if isinstance(usage.get('dailyUsageBuckets'),list) else None,'status':'ok' if windows else 'unavailable'}
    finally:
        sel.close()
        try: os.killpg(p.pid, signal.SIGTERM)
        except ProcessLookupError: pass
        try: p.wait(timeout=3)
        except subprocess.TimeoutExpired:
            try: os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            p.wait()
        p.stdin.close(); p.stdout.close()

def main():
    CACHE.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    # Serialize manual invocations and widget polls; do not overwrite a newer result.
    fd=os.open(CACHE.with_suffix('.lock'),os.O_CREAT|os.O_RDWR,0o600)
    with os.fdopen(fd,'w') as lock:
        try: fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:
            print(json.dumps({'status':'busy'}));return
        try: data = collect()
        except Exception as exc:
            error = str(exc) if str(exc) in {'codex_missing','rpc_error','timeout','server_closed','invalid_response'} else 'collection_failed'
            try:
                data=json.loads(CACHE.read_text())
                if not isinstance(data,dict): raise ValueError('invalid cache')
            except (OSError,ValueError): data={'windows':[],'summary':{},'daily':None}
            data['status']='offline';data['error']=error
        data['attemptedAt']=int(time.time())
        tmp=None
        try:
            with tempfile.NamedTemporaryFile(mode='w',dir=CACHE.parent,prefix='usage-',suffix='.tmp',delete=False) as out:
                tmp=Path(out.name)
                json.dump(data,out,ensure_ascii=False,allow_nan=False)
            tmp.replace(CACHE)
        finally:
            if tmp is not None: tmp.unlink(missing_ok=True)
        summary=data.get('summary') if isinstance(data.get('summary'),dict) else {}
        print(json.dumps({'status':data.get('status'),'updatedAt':data.get('updatedAt'),'error':data.get('error'),
                          'windows':data.get('windows'),'lifetimeTokens':summary.get('lifetimeTokens')},ensure_ascii=False))
if __name__=='__main__': main()
