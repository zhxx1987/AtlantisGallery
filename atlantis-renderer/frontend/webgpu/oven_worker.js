/* A dedicated worker owns the bundled Python interpreter and the oven state. */
const root = new URL('../oven_runtime/', self.location.href);
let dispatch;
let version;
async function initialize() {
  const vendor = new URL('vendor/', root);
  importScripts(new URL('pyodide.js', vendor).href);
  const py = await loadPyodide({indexURL: vendor.href});
  version = py.version;
  const response = await fetch(new URL('oven_motion.py', root));
  if (!response.ok) throw Error('oven_motion.py ' + response.status);
  py.FS.writeFile('/home/pyodide/oven_motion.py', await response.text());
  py.runPython([
    'import json, sys',
    'sys.path.insert(0, "/home/pyodide")',
    'from oven_motion import create_runtime',
    'oven = None',
    'checkpoint = None',
    'def handle(raw):',
    '    global oven, checkpoint',
    '    msg = json.loads(raw)',
    '    kind = msg["kind"]',
    '    matched = None',
    '    if kind == "init":',
    '        oven = create_runtime({key: msg[key] for key in ("dial_calibration", "asset_dial_calibration") if key in msg})',
    '        checkpoint = None',
    '    elif kind == "save":',
    '        checkpoint = oven.serialize()',
    '    elif kind == "restore":',
    '        if checkpoint is None: raise ValueError("Missing checkpoint")',
    '        oven = create_runtime({"saved": checkpoint})',
    '        matched = oven.serialize() == checkpoint',
    '    state = oven.step(msg.get("events", []), msg.get("dt", 0))',
    '    return json.dumps({"state": state, "saved": checkpoint is not None, "restored_exactly": matched}, allow_nan=False)'
  ].join('\n'));
  dispatch = py.globals.get('handle');
}
self.onmessage = async ({data}) => {
  try {
    if (!dispatch) await initialize();
    const result = JSON.parse(dispatch(JSON.stringify(data)));
    self.postMessage({...result, version});
  } catch (error) {
    self.postMessage({error: String(error.message || error)});
  }
};
