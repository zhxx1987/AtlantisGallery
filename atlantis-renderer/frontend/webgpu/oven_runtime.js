import {sharedArticulationModel} from './articulation_controls.js';
import {pickAtPixel} from './selection.js';
import {BufferGeometry, Float32BufferAttribute, Mesh} from '../../vendor/tidewater/src/engine/index.js';
import {LAYERS, Material} from '../../vendor/tidewater/src/engine/webgpu.js';

const requiredJoints = ['oven_door', 'rack_slide', 'tray_slide', 'fan_rotor', 'cooling_rotor', 'mode_control', 'temp_control'];
const physicalInputs = new Map(Object.entries({
  mode_knob:'mode_next', temp_knob:'temp_next', control_button_0:'timer_next',
  control_button_1:'start', control_button_2:'stop', handle:'door_toggle',
  rack_perimeter:'rack_toggle', tray:'tray_toggle', lamp_cover:'lamp_toggle',
  oven_door:'door_toggle', rack_slide:'rack_toggle', tray_slide:'tray_toggle',
  mode_control:'mode_next', temp_control:'temp_next'
}));
const lamps = {
  lamp_on: {position:[0,0.435,-0.326], color:[1,0.8,0.54], intensity:0.11},
  upper_heater: {position:[0,0.422,-0.19], color:[1,0.27,0.06], intensity:0.022},
  lower_heater: {position:[0,0.098,-0.19], color:[1,0.27,0.06], intensity:0.014},
  ring_heater: {position:[0,0.28,-0.36], color:[1,0.27,0.06], intensity:0.018}
};
const degrees = radians => Math.round(radians * 180 / Math.PI);
const onOff = flag => flag ? 'On' : 'Off';

// Coordinates are metres in the frontal display recess of this oven.
function installDisplay(root) {
  const patterns = ['abcdef','bc','abdeg','abcdg','bcfg','acdfg','acdefg','abc','abcdefg','abcdfg'];
  const strokes = {a:[1,10,5,10],b:[5,6,5,9],c:[5,1,5,4],d:[1,0,5,0],e:[1,1,1,4],f:[1,6,1,9],g:[1,5,5,5]};
  const vertices = new Float32Array(16 * 7 * 6 * 3);
  const attribute = new Float32BufferAttribute(vertices,3);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position',attribute);
  const material = new Material({name:'Oven amber LED',lit:false,color:[1.5,0.32,0.035],side:'double'});
  const mesh = new Mesh(geometry,material);
  mesh.layers.set(LAYERS.OPAQUE);
  mesh.name = 'Live temperature and countdown';
  mesh.frustumCulled = false;
  mesh.userData.aps_no_batch = true;
  root.add(mesh);
  let last = '';
  return {
    set(text) {
      if (text===last) return;
      last = text;
      const pitch = Math.min(0.0107,0.118/text.length), unit = pitch/7.5;
      const left = -pitch*(text.length-1)/2 - 3*unit;
      let cursor = 0;
      function bar(i,x1,y1,x2,y2) {
        const horizontal = y1===y2;
        const halfWidth = 0.48;
        const x0=left+(i*pitch)+(Math.min(x1,x2)-(horizontal?0:halfWidth))*unit;
        const x3=left+(i*pitch)+(Math.max(x1,x2)+(horizontal?0:halfWidth))*unit;
        const y0=0.535+(Math.min(y1,y2)-(horizontal?halfWidth:0))*unit;
        const y3=0.535+(Math.max(y1,y2)+(horizontal?halfWidth:0))*unit;
        const z=0.04035;
        attribute.array.set([x0,y0,z,x3,y0,z,x3,y3,z,x0,y0,z,x3,y3,z,x0,y3,z],cursor);
        cursor+=18;
      }
      for (const [i,ch] of [...text].entries()) {
        const segments = ch==='C'?'adef':patterns[ch] || '';
        for (const key of segments) bar(i,...strokes[key]);
        if(ch===':') {bar(i,2.5,3,3.5,3);bar(i,2.5,7,3.5,7);}
      }
      // Keep one depth-tested draw and one GPU buffer as the clock changes.
      attribute.array.fill(0,cursor);
      attribute.needsUpdate=true;
      geometry.setDrawRange(0,cursor/3);
    },
    dispose() {root.remove(mesh);geometry.dispose();material.dispose();material.uniformBlock?.buffer?.destroy();}
  };
}

export function installOvenRuntime(viewer, controls, mount) {
  const asset = viewer.meshAsset;
  const model = sharedArticulationModel(viewer, asset);
  for (const joint of requiredJoints) if (!model.joints.has(joint)) throw Error('Missing oven joint: ' + joint);
  const initialLights = [...viewer.lighting.localLightData];
  const worker = new Worker(new URL('./oven_worker.js', import.meta.url));
  const display = installDisplay(asset.root);
  const panel = document.createElement('details');
  panel.open = true;
  panel.setAttribute('aria-label','Oven controls');
  panel.style.cssText = 'box-sizing:border-box;width:100%;padding:10px 12px;border:1px solid #86999388;border-radius:8px;background:#112021ee;color:#f3f6f5;font:13px system-ui';
  const summary = document.createElement('summary');
  summary.textContent = 'Oven controls';
  summary.style.cssText = 'font-weight:650;cursor:pointer';
  const form = document.createElement('fieldset');
  form.style.cssText = 'padding:0;margin:8px 0;border:0;display:grid;gap:6px';
  form.disabled = true;
  const telemetry = document.createElement('output');
  telemetry.style.cssText = 'display:block;white-space:pre-line;line-height:1.55;font-variant-numeric:tabular-nums';
  telemetry.textContent = 'Loading the Python oven controller…';
  const notice = document.createElement('div');
  notice.setAttribute('role','status');
  notice.style.color = '#f1caa3';
  panel.append(summary, form, telemetry, notice);
  mount.append(panel);
  let active, state, version, lightKey = '', ready = false, failed = false, disposed = false;
  let clock = performance.now(), carry = 0, ordinal = 0, pointer, downloadURL;
  const queue = [], history = [];
  const previousMetadata = viewer.metadata;
  const hadOwnMetadata = Object.hasOwn(viewer,'metadata');
  const ovenMetadata = function(...args) {
    const base = previousMetadata.apply(this,args);
    return {...base, oven:{runtime:version, state, joints:model.metadata(), lights:lightKey, operation:ordinal}};
  };
  viewer.metadata = ovenMetadata;
  function enqueue(kind, events = [], dt = 0, from = 'panel') {
    if (!ready || disposed || failed) return;
    queue.push({kind,events,dt,from});
    drive();
  }
  function row() {
    const item = document.createElement('div');
    item.style.cssText = 'display:flex;gap:4px;align-items:center;flex-wrap:wrap';
    form.append(item);
    return item;
  }
  function button(parent, label, click) {
    const el = document.createElement('button');
    el.type = 'button'; el.textContent = label;
    el.style.cssText = 'padding:4px 7px;font:inherit';
    el.addEventListener('click',click); parent.append(el); return el;
  }
  function command(parent, label, name, value = null) {
    return button(parent, label, () => enqueue('step', [[name,value]]));
  }
  function field(row, name, el) {
    const label = document.createElement('label');
    label.textContent = name + ' '; label.append(el); row.append(label);
    el.style.cssText = 'width:auto;max-width:90px;padding:3px;font:inherit';
    return el;
  }
  const settings = row();
  const mode = field(settings, 'Mode', document.createElement('select'));
  for (const [id,name] of [['OFF','Off'],['BAKE','Bake'],['FAN','Convection'],['GRILL','Grill'],['LIGHT','Light']]) mode.add(new Option(name, id));
  mode.onchange = () => enqueue('step', [['mode', mode.value]]);
  const temperature = field(settings, 'Temperature °C', document.createElement('input'));
  Object.assign(temperature,{type:'number',min:'50',max:'275',step:'1'});
  temperature.style.width = '48px';
  function applyNumber(el, name) {
    if (el.reportValidity() && Number.isFinite(el.valueAsNumber)) enqueue('step',[[name,el.valueAsNumber]]);
  }
  button(settings,'Set temperature',() => applyNumber(temperature,'temperature_C'));
  const timerRow = row(), timer = field(timerRow,'Timer (s)',document.createElement('input'));
  Object.assign(timer,{type:'number',min:'0',max:'86400',step:'1'});
  timer.style.width = '62px';
  button(timerRow,'Set timer',() => applyNumber(timer,'timer_s'));
  command(timerRow,'Start','start'); command(timerRow,'Stop','stop');
  const doors = row();
  for (const angle of [0,45,90]) command(doors, 'Door ' + angle + '°', 'door',angle * Math.PI / 180);
  command(doors,'Oven light','lamp_toggle');
  const slides = row();
  for (const [name,id] of [['rack','rack'],['tray','tray']]) {
    command(slides,'Extend '+name,id,0.18); command(slides,'Retract '+name,id,0);
  }
  const bench = row();
  button(bench,'Advance 60 s',() => enqueue('step',[],60));
  command(bench,'Acknowledge alarm','ack');
  button(bench,'Save state',() => enqueue('save'));
  const restore = button(bench,'Restore state',() => enqueue('restore'));
  restore.disabled = true;
  const exports = row();
  button(exports,'Record pose',() => enqueue('record'));
  const operationFile = document.createElement('a');
  operationFile.download = 'oven-native-operations.json';
  operationFile.textContent = 'Download operation log';
  operationFile.hidden = true;
  button(exports,'Export operation log',() => {
    if (!state) return;
    const record = {schema:'atlantis-oven-inspection/1',pyodide:version,created:new Date().toISOString(),
      mesh:viewer.metadata?.().mesh, state, joints:model.metadata(), lights:lightKey, history};
    if (downloadURL) URL.revokeObjectURL(downloadURL);
    downloadURL = URL.createObjectURL(new Blob([JSON.stringify(record,null,2)],{type:'application/json'}));
    operationFile.href = downloadURL;
    operationFile.hidden = false;
  });
  exports.append(operationFile);
  function update(data, action) {
    const previous = state;
    state = data.state; version = data.version;
    display.set(state.display.split(' | ')[0]);
    let moved = false;
    for (const name of requiredJoints) {
      const raw = state.joints[name], limits = model.joints.get(name).dof.limits;
      const value = Math.max(limits?.[0] ?? -Infinity,Math.min(limits?.[1] ?? Infinity,raw));
      if (!Number.isFinite(raw) || Math.abs(raw-value)>1e-6) throw Error('Joint exceeds model limits: ' + name);
      if (model.values.get(name) !== value) {model.set(name,value,{immediate:true}); moved = true;}
    }
    if (moved) {
      asset.root.updateMatrixWorld(true);
      viewer.invalidateObjectTransforms?.([asset.root]);
    }
    const enabled = Object.keys(lamps).filter(id => id === 'lamp_on' ? state.lamp_on : state.heater_channels[id]);
    if (enabled.join(',') !== lightKey) {
      lightKey = enabled.join(',');
      viewer.setPointLights([...initialLights,...enabled.map(id => ({type:'point',range:0.65,decay:2,...lamps[id]}))]);
    }
    if (previous?.mode !== state.mode) mode.value = state.mode;
    if (previous?.setpoint_C !== state.setpoint_C) temperature.value = state.setpoint_C;
    if (previous?.timer_duration_s !== state.timer_duration_s) timer.value = state.timer_duration_s;
    restore.disabled = !data.saved;
    const channels = state.heater_channels;
    const lines = [state.display.split(' | ')[0] + '　' + (state.alarm ? 'Alarm' : state.running ? 'Running' : 'Stopped'),
      'Cavity ' + state.temperature_C.toFixed(1) + ' °C　Set temperature ' + state.setpoint_C + ' °C　Remaining ' + Math.ceil(state.timer_remaining_s) + ' s',
      'Upper heater ' + onOff(channels.upper_heater) + '　Lower heater ' + onOff(channels.lower_heater) + '　Ring heater ' + onOff(channels.ring_heater),
      'Convection ' + onOff(state.circulation_fan_on) + '　Cooling fan ' + onOff(state.cooling_fan_on) + '　Oven light ' + onOff(state.lamp_on),
      'Door ' + degrees(state.door_rad) + '°　rack ' + Math.round(state.rack_m*1000) + ' mm　tray ' + Math.round(state.tray_m*1000) + ' mm',
      state.power_W.toFixed(0) + ' W　Heat loss ' + state.loss_W_K.toFixed(1) + ' W/K'];
    const rendered = lines.join('\n');
    if (rendered !== telemetry.textContent) telemetry.textContent = rendered;
    if (action.kind !== 'tick') {
      const message = state.event_errors.map(e => e.error).join(' ');
      notice.textContent = message || ({save:'State saved',restore:data.restored_exactly?'Saved state restored exactly':'Restore failed',record:'Pose recorded',init:'Python ready · Pyodide ' + version}[action.kind] || '');
      history.push({order:++ordinal,action,before:previous,after:state,joints:model.metadata(),lights:enabled,restored_exactly:data.restored_exactly});
      if (history.length > 160) history.shift();
    }
  }
  function fail(error) {
    failed = true; form.disabled = true;
    notice.textContent = 'Oven controller error · ' + String(error.message || error);
  }
  function send(action) {active = action; worker.postMessage(action);}
  function drive() {
    if (!ready || disposed || failed || active) return;
    const now = performance.now();
    carry += (now - clock)/1000; clock = now;
    if (queue.length) send(queue.shift());
    else if (carry >= 0.07) {
      const dt = Math.min(60,carry); carry -= dt; send({kind:'tick',dt});
    }
  }
  worker.onmessage = ({data}) => {
    if (disposed) return;
    if (data.error) {fail(data.error); return;}
    try {
      update(data,active);
      if (!ready) {ready = true; clock = performance.now(); form.disabled = false;}
      active = null; drive();
    } catch (e) {fail(e);}
  };
  worker.onerror = e => fail(e.message);
  const host = viewer.canvas.parentElement;
  function inputAt(e) {
    let mesh = pickAtPixel(viewer,e.clientX,e.clientY)?.mesh;
    while (mesh) {
      const source = asset.sceneData.nodes?.[mesh.userData?.gltf_node];
      const name = [source?.name,mesh.userData?.entity_id,mesh.name].find(n => physicalInputs.has(n));
      if (name) return name;
      mesh = mesh.parent;
    }
    return null;
  }
  function down(e) {
    if (e.target!==viewer.canvas || e.button!==0 || !e.isPrimary) return;
    const name = inputAt(e);
    if (!name) return;
    pointer = {name,id:e.pointerId,x:e.clientX,y:e.clientY};
    host.setPointerCapture(e.pointerId);
    e.preventDefault(); e.stopPropagation();
  }
  function up(e) {
    if (!pointer || e.pointerId!==pointer.id) return;
    const {name,x,y} = pointer;
    pointer = null;
    if (host.hasPointerCapture(e.pointerId)) host.releasePointerCapture(e.pointerId);
    if (e.type==='pointerup' && Math.hypot(e.clientX-x,e.clientY-y)<=5) {
      enqueue('step', [[physicalInputs.get(name),null]],0,'mesh:'+name);
    }
    e.preventDefault(); e.stopPropagation();
  }
  host.addEventListener('pointerdown',down,true);
  host.addEventListener('pointerup',up,true);
  host.addEventListener('pointercancel',up,true);
  const pulse = setInterval(drive,90);
  send({kind:'init',dt:0,dial_calibration:controls?.dial_calibration,
    asset_dial_calibration:asset.sceneData?.extras?.oven_asset?.dial_calibration});
  return {dispose() {
    disposed = true; clearInterval(pulse); worker.terminate();
    display.dispose();
    host.removeEventListener('pointerdown',down,true);
    host.removeEventListener('pointerup',up,true);
    host.removeEventListener('pointercancel',up,true);
    if (downloadURL) URL.revokeObjectURL(downloadURL);
    if (viewer.metadata === ovenMetadata) {
      if (hadOwnMetadata) viewer.metadata = previousMetadata;
      else delete viewer.metadata;
    }
    viewer.setPointLights(initialLights); panel.remove();
  }};
}
