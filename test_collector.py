import fcntl, json, os, subprocess, sys, tempfile, unittest, importlib.util, time
from unittest.mock import patch
from types import SimpleNamespace
from pathlib import Path

COLLECTOR=Path(__file__).with_name('collector.py')
FAKE='''#!/usr/bin/python3
import json,os,sys,time
mode=os.environ.get('FAKE_MODE','ok')
for line in sys.stdin:
 m=json.loads(line)
 if 'id' not in m: continue
 if mode=='fail': sys.exit(1)
 if mode=='hang':
  open(os.environ['FAKE_PID'],'w').write(str(os.getpid()))
  time.sleep(60)
 if mode=='invalid':
  print(json.dumps({'id':m['id'],'result':None}),flush=True);continue
 method=m['method']
 if method=='initialize': result={}
 elif method=='account/rateLimits/read':
  result={'rateLimits':{'primary':{'usedPercent':25,'windowDurationMins':300,'resetsAt':2000000000},'secondary':{'usedPercent':120,'windowDurationMins':10080,'resetsAt':2000000001}}}
  if mode=='null': result={'rateLimits':None}
 else:
  if mode=='usage_error':
   print(json.dumps({'id':m['id'],'error':{'message':'unavailable'}}),flush=True);continue
  result={'summary':{'lifetimeTokens':123456},'dailyUsageBuckets':None}
 print(json.dumps({'id':m['id'],'result':result}),flush=True)
'''
class CollectorTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name)
  p=self.root/'codex';p.write_text(FAKE);p.chmod(0o755)
  self.env={**os.environ,'PATH':str(self.root),'XDG_CACHE_HOME':str(self.root/'cache')}
  self.cache=self.root/'cache/codex-island/usage.json'
 def tearDown(self):self.tmp.cleanup()
 def run_mode(self,mode):
  subprocess.run([sys.executable,str(COLLECTOR)],env={**self.env,'FAKE_MODE':mode},check=True,capture_output=True,timeout=5)
  return json.loads(self.cache.read_text())
 def test_windows_and_clamping(self):
  d=self.run_mode('ok');self.assertEqual([w['remaining'] for w in d['windows']],[75,0]);self.assertEqual(d['summary']['lifetimeTokens'],123456)
  self.assertEqual(self.cache.stat().st_mode&0o777,0o600)
 def test_missing_data_is_not_zero(self):
  d=self.run_mode('null');self.assertEqual(d['windows'],[]);self.assertEqual(d['status'],'unavailable');self.assertIsNone(d['daily'])
 def test_token_endpoint_failure_preserves_quota(self):
  d=self.run_mode('usage_error');self.assertEqual(d['status'],'ok');self.assertEqual(d['summary'],{});self.assertEqual(d['windows'][0]['remaining'],75)
 def test_offline_retains_timestamp_and_metrics(self):
  first=self.run_mode('ok');d=self.run_mode('fail');self.assertEqual(d['updatedAt'],first['updatedAt']);self.assertEqual(d['windows'],first['windows']);self.assertEqual(d['status'],'offline')

 def test_invalid_response_is_offline_not_success(self):
  d=self.run_mode('invalid');self.assertEqual(d['status'],'offline');self.assertEqual(d['error'],'invalid_response')
 def test_corrupt_cache_recovers_after_failure(self):
  self.cache.parent.mkdir(parents=True);self.cache.write_text('[]')
  d=self.run_mode('fail');self.assertEqual(d['status'],'offline');self.assertEqual(d['windows'],[])
 def test_overlapping_poll_skips_without_overwriting(self):
  self.cache.parent.mkdir(parents=True)
  self.cache.write_text('{"sentinel":true}')
  with open(self.cache.with_suffix('.lock'),'w') as lock:
   fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
   r=subprocess.run([sys.executable,str(COLLECTOR)],env=self.env,capture_output=True,text=True,timeout=3,check=True)
  self.assertEqual(json.loads(r.stdout)['status'],'busy');self.assertEqual(json.loads(self.cache.read_text()),{'sentinel':True})
 def test_timeout_reaps_server(self):
  spec=importlib.util.spec_from_file_location('timeout_collector',COLLECTOR)
  m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
  pidfile=self.root/'server.pid'
  with patch.dict(os.environ,{**self.env,'FAKE_MODE':'hang','FAKE_PID':str(pidfile)},clear=True),patch.object(m,'RPC_TIMEOUT',0.2):
   with self.assertRaisesRegex(RuntimeError,'timeout'):m.collect()
  pid=int(pidfile.read_text())
  with self.assertRaises(ProcessLookupError):os.kill(pid,0)

 def test_sigterm_reaps_active_server(self):
  pidfile=self.root/'active.pid'
  p=subprocess.Popen([sys.executable,str(COLLECTOR)],env={**self.env,'FAKE_MODE':'hang','FAKE_PID':str(pidfile)},stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  try:
   end=time.monotonic()+3
   while not pidfile.exists() and time.monotonic()<end:time.sleep(0.02)
   self.assertTrue(pidfile.exists())
   pid=int(pidfile.read_text());p.terminate();p.wait(timeout=4)
   with self.assertRaises(ProcessLookupError):os.kill(pid,0)
  finally:
   if p.poll() is None:p.kill();p.wait()



class ProxyEnvironmentTests(unittest.TestCase):
 def module(self):
  spec=importlib.util.spec_from_file_location('collector_test',COLLECTOR)
  m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
 def fake_gi(self,mode='manual'):
  fields={'org.gnome.system.proxy':{'mode':mode,'use-same-proxy':False,'ignore-hosts':['localhost']},'org.gnome.system.proxy.http':{'host':'127.0.0.1','port':7897,'use-authentication':False},'org.gnome.system.proxy.https':{'host':'127.0.0.1','port':7897}}
  class Settings:
   @staticmethod
   def new(name):
    values=fields[name]
    return SimpleNamespace(get_string=lambda k:values[k],get_int=lambda k:values[k],get_boolean=lambda k:values[k],get_strv=lambda k:values[k])
  return {'gi':SimpleNamespace(),'gi.repository':SimpleNamespace(Gio=SimpleNamespace(Settings=Settings))}
 def test_gnome_manual_proxy_used_without_shell_variables(self):
  m=self.module()
  with patch.dict(os.environ,{},clear=True),patch.dict(sys.modules,self.fake_gi()):
   env=m.app_server_environment()
  self.assertEqual(env['HTTPS_PROXY'],'http://127.0.0.1:7897');self.assertEqual(env['NO_PROXY'],'localhost')
 def test_explicit_environment_takes_precedence(self):
  m=self.module()
  with patch.dict(os.environ,{'HTTPS_PROXY':'http://custom:123'},clear=True),patch.dict(sys.modules,self.fake_gi()):
   env=m.app_server_environment()
  self.assertEqual(env['HTTPS_PROXY'],'http://custom:123');self.assertNotIn('HTTP_PROXY',env)
 def test_disabled_proxy_is_not_added(self):
  m=self.module()
  with patch.dict(os.environ,{},clear=True),patch.dict(sys.modules,self.fake_gi('none')):
   env=m.app_server_environment()
  self.assertNotIn('HTTPS_PROXY',env)

if __name__=='__main__':unittest.main()
