"""Run the real Api 4 host only inside Docker; CI, no WeChat or real credentials."""
from pathlib import Path
import tempfile
import audit
from native import prepare_runtime, probe_native

with tempfile.TemporaryDirectory(prefix='whale-native-selftest-') as directory:
    runtime = prepare_runtime(Path(directory) / 'runtime', audit.fetch)
    entry = {'Id': 'native-selftest', 'Api': 4, 'Kind': 'tool', 'Hooks': ['tool.run'], 'ExecutionTimeoutMs': 3000}
    source = b"""const whale=require('whale'); exports.run=async()=>{
      const result=await whale.search('synthetic test'); if(!result.items[0].url) throw Error('search');
      if((await whale.api('/api/status')).status!==200) throw Error('api');
      let blocked=0;
      try{require('node:fs').writeFileSync('/host/javascriptPlugins.js','blocked')}catch{blocked++}
      try{await fetch('http://192.0.2.1',{signal:AbortSignal.timeout(500)})}catch{blocked++}
      if(blocked!==2)throw Error('isolation');return {state:{ran:true}};
    };"""
    assert probe_native(entry, source, runtime)['passed'] is True
    try:
        probe_native({**entry, 'ExecutionTimeoutMs': 100}, b'exports.run=()=>{while(true){}};', runtime)
    except ValueError:
        pass
    else:
        raise AssertionError('loop was not terminated')
print('Api 4 real host/container, read-only mount, no-network and timeout checks passed.')
