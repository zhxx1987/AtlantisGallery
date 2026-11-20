const PYODIDE_URL = 'https://cdn.jsdelivr.net/pyodide/v0.27.7/full/';
let python;
let step;

async function start(profile, descriptor) {
  if (descriptor?.module) {
    const response=await fetch(descriptor.module,{credentials:'omit'});
    if(!response.ok)throw Error('Python module HTTP '+response.status);
    const source=await response.text();
    importScripts(PYODIDE_URL+'pyodide.js');
    python=await loadPyodide({indexURL:PYODIDE_URL});
    for(const [name,url] of Object.entries(descriptor.dependencies??{})){
      if(!/^[a-zA-Z_][a-zA-Z_0-9]*\.py$/.test(name))throw Error('Invalid Python dependency name');
      const r=await fetch(url,{credentials:'omit'});if(!r.ok)throw Error('Python dependency HTTP '+r.status);
      python.FS.writeFile('/'+name,await r.text());
    }
    python.FS.writeFile('/asset_motion.py',source);
    python.globals.set('asset_config_json',JSON.stringify(descriptor.config??{}));
    python.runPython(`import json,sys
sys.path.insert(0,'/')
from asset_motion import create_runtime
asset_runtime=create_runtime(json.loads(asset_config_json))
def asset_step(events,elapsed):
    return json.dumps(asset_runtime.step(json.loads(events),elapsed/1000.0))
`);
    step=python.globals.get('asset_step');
    return;
  }
  if (profile !== 'microwave') throw Error('This Python interaction module is unavailable');
  const response = await fetch(new URL('./logic/microwave_logic.py', self.location.href));
  if (!response.ok) throw Error('Could not load the microwave interaction module');
  const source = await response.text();
  importScripts(PYODIDE_URL + 'pyodide.js');
  python = await loadPyodide({ indexURL: PYODIDE_URL });
  python.FS.writeFile('/microwave_logic.py', source);
  python.runPython(`
import json
import sys
sys.path.insert(0, '/')
from microwave_logic import Microwave, SEGMENT_FONT

machine = Microwave()

def gallery_step(events, elapsed):
    machine.tick(elapsed)
    for name, value in json.loads(events):
        if name == 'door':
            machine.setDoorOpen(not machine.doorOpen if value is None else bool(value))
        else:
            machine.dispatch(name)
    snapshot = machine.snapshot()
    display = machine.display()
    digits = (list(display.get('digits') or []) + [' '] * 4)[:4]
    digits = ''.join(str(digit) if digit is not None else ' ' for digit in digits)
    snapshot['colon'] = bool(display.get('colon'))
    snapshot['clock'] = bool(display.get('clock'))
    snapshot['display'] = digits[:2] + ':' + digits[2:] if snapshot['colon'] else digits
    snapshot['heating'] = (
        snapshot['mode'] == 'cooking'
        and not snapshot['doorOpen']
        and snapshot['remainingMs'] > 0
        and snapshot['cookPowerPct'] > 0
    )
    snapshot['cavityLight'] = snapshot['heating'] or snapshot['doorOpen']
    for index, digit in enumerate(digits, start=1):
        for segment in 'abcdefg':
            snapshot[f'segment_{index}{segment}'] = segment in SEGMENT_FONT.get(digit, '')
    return json.dumps(snapshot)
`);
  step = python.globals.get('gallery_step');
}

self.onmessage = async ({ data }) => {
  try {
    if (data.init) await start(data.profile,data.descriptor);
    const snapshot = JSON.parse(step(JSON.stringify(data.events ?? []), data.elapsed ?? 0));
    self.postMessage({ snapshot });
  } catch (error) {
    console.error(error);
    self.postMessage({ error: String(error.message??error) });
  }
};
