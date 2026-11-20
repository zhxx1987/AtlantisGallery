import {PythonLogic} from './python-logic.js';
import {vehicleMode} from './vehicle-mode.js';

export async function installPythonVehicle(viewer,descriptor,modelURL,container,onMode=()=>{}){
  const module=new URL(descriptor.module,modelURL).href;
  const response=await fetch(new URL(descriptor.config,modelURL));
  if(!response.ok)throw Error('Vehicle configuration HTTP '+response.status);
  const config=await response.json();
  const p=document.createElement('section');p.setAttribute('aria-label','Vehicle Controls');container.replaceChildren(p);
  const help=document.createElement('p');help.textContent='WASD: drive · Space: brake / hold · Mouse: orbit / turret aim · RMB: gun elevation · Wheel: zoom · R: reset · F1: vehicle / ESC: viewport';p.append(help);
  const mode=document.createElement('button');mode.textContent='F1 · Enter Vehicle Mode';p.append(mode);
  const hatchButtons=[];
  const labels={hull_hatch_L:'Driver Hatch',hull_hatch_R:'Radio Operator Hatch',commander_hatch:'Commander Hatch',loader_hatch:'Loader Hatch',turret_rear_hatch:'Turret Rear Hatch',engine_service_cover:'Engine Service Cover'};
  const styleButton=button=>Object.assign(button.style,{padding:'8px 10px',margin:'4px 4px 4px 0',border:'1px solid #78908366',borderRadius:'5px',background:'#e4eade',color:'#173c30',cursor:'pointer',font:'inherit'});
  styleButton(mode);
  const reset=document.createElement('button');reset.textContent='Reset';styleButton(reset);p.append(reset);
  const output=document.createElement('output');output.style.display='block';output.textContent='Starting Python…';p.append(output);
  const abort=new AbortController(),keys=new Set(),physical=new Set(),blocked=new Set(),nodes=new Map();
  const required=['hull','turret_yaw','gun_elevation',...config.wheels.map(x=>x.name),...Object.values(config.links).flat().map(x=>x.name)];
  const controlled=new Set([...required,...Object.keys(config.hinges)]);
  viewer.meshAsset.root.traverse(node=>{if(node.isMesh||!Number.isInteger(node.userData?.gltf_node)||!controlled.has(node.name))return;if(nodes.has(node.name))throw Error('Duplicate vehicle node '+node.name);nodes.set(node.name,node);});
  for(const name of required)if(!nodes.has(name))throw Error('Vehicle node missing: '+name);
  let enabled=false,rmb=false,yaw=0,pitch=22*Math.PI/180,distance=12,elevation=0,last=null,disposed=false;
  const listen=(target,name,fn,options={})=>target.addEventListener(name,fn,{...options,signal:abort.signal});
  const input=()=>({enabled,brake:keys.has('Space'),throttle:Number(keys.has('KeyW'))-Number(keys.has('KeyS')),steer:Number(keys.has('KeyA'))-Number(keys.has('KeyD')),aim_yaw:yaw,elevation});
  const send=()=>logic.event('input',input());
  const sharedMode=vehicleMode(viewer,value=>{
    enabled=value;keys.clear();rmb=false;onMode(value);
    for(const key of physical)blocked.add(key);
    mode.textContent=value?'ESC · Return to Viewport':'F1 · Enter Vehicle Mode';send();
  });
  const setMode=value=>sharedMode.set(value);
  const camera=()=>{
    if(!enabled||!last)return;
    const s=last.state,target=[s.x,config.ground_lift+(s.z??0)+1.3,-s.y],h=distance*Math.cos(pitch);
    viewer.setCamera({position:[target[0]-h*Math.cos(yaw),target[1]+distance*Math.sin(pitch),target[2]+h*Math.sin(yaw)],target});
  };
  const logic=new PythonLogic({module,config},snapshot=>{
    if(disposed)return;
    let transformsChanged=false;
    for(const [name,array]of Object.entries(snapshot.matrices??{})){
      const node=nodes.get(name);if(!node)throw Error('Motion node missing: '+name);
      node.matrixAutoUpdate=false;
      if(array.some((value,index)=>value!==node.matrix.elements[index])){node.matrix.fromArray(array);node.matrixWorldNeedsUpdate=true;transformsChanged=true;}
    }
    last=snapshot;
    // A worker heartbeat is not scene motion: preserve picking depth while the model is stationary.
    if(transformsChanged){viewer.invalidateObjectTransforms?.([nodes.get('hull')]);viewer.depthSnapshot=null;for(const cascade of viewer.shadows?.cascades??[])cascade.dirty=true;}
    const s=snapshot.state;
    output.textContent=`Python · ${((s.speed??(s.left_speed+s.right_speed)/2)*3.6).toFixed(1)} km/h · Ground contact ${s.grounded??18}/18 · ${s.braking?'Braking / hold':'Driving / coasting'}`;
    viewer.canvas.dataset.pythonState=JSON.stringify(snapshot.state);
    viewer.canvas.dataset.pythonReady='true';camera();
    viewer.canvas.dataset.motionProof=JSON.stringify({
      schema:'atlantis-vehicle-web-proof/1',runtime:'Pyodide 0.27.7',mode:enabled?'vehicle':'viewport',
      keys:[...keys],pointerLocked:document.pointerLockElement===viewer.canvas,
      state:snapshot.state,input:input(),camera:{position:viewer.camera.position.toArray(),target:viewer.controls.target.toArray()},
      nodes:nodes.size,links:Object.values(config.links).flat().length,wheels:config.wheels.length,
      poses:Object.fromEntries([...controlled].map(name=>[name,Array.from(nodes.get(name).matrix.elements)]))
    });
  },error=>{output.textContent=String(error);viewer.canvas.dataset.pythonError=String(error);setMode(false);});
  mode.onclick=()=>setMode(!enabled);reset.onclick=()=>{keys.clear();yaw=0;elevation=0;for(const hatch of hatchButtons)hatch.reset();logic.event('reset');send();};
  for(const [name,hinge]of Object.entries(config.hinges)){
    if(name.startsWith('suspension_'))continue;
    const button=document.createElement('button');button.textContent=labels[name]??name;styleButton(button);button.setAttribute('aria-pressed','false');let open=false;
    hatchButtons.push({reset:()=>{open=false;button.setAttribute('aria-pressed','false');}});
    button.onclick=()=>{open=!open;button.setAttribute('aria-pressed',String(open));logic.event('joint',{name,angle:open?hinge.limits[1]:0});};p.append(button);
  }
  listen(window,'keydown',e=>{
    if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;
    physical.add(e.code);
    if(e.code==='F1'){e.preventDefault();if(!e.repeat&&!enabled)setMode(true);return;}
    if(e.code==='Escape'){if(enabled)e.preventDefault();setMode(false);return;}
    if(!enabled)return;
    if(['KeyW','KeyA','KeyS','KeyD','Space'].includes(e.code)){e.preventDefault();if(!blocked.has(e.code))keys.add(e.code);send();}
    if(e.code==='KeyR'&&!e.repeat){e.preventDefault();reset.click();}
  },{capture:true});
  listen(window,'keyup',e=>{physical.delete(e.code);blocked.delete(e.code);if(keys.delete(e.code))send();});
  listen(window,'blur',()=>{physical.clear();blocked.clear();setMode(false);});
  listen(document,'visibilitychange',()=>{if(document.hidden)setMode(false);});
  listen(viewer.canvas,'pointerdown',e=>{
    if(!enabled)return;
    e.preventDefault();rmb=e.button===2;
    if(document.pointerLockElement!==viewer.canvas){try{Promise.resolve(viewer.canvas.requestPointerLock?.()).catch(()=>{});}catch{}}
  });
  listen(window,'pointerup',e=>{if(e.button===2)rmb=false;});
  listen(document,'pointerlockchange',()=>{if(!document.pointerLockElement){keys.clear();rmb=false;send();}});
  listen(window,'mousemove',e=>{
    if(!enabled)return;
    const sensitivity=.12*Math.PI/180;yaw-=e.movementX*sensitivity;
    pitch=Math.max(5*Math.PI/180,Math.min(75*Math.PI/180,pitch+e.movementY*sensitivity));
    if(rmb)elevation=Math.max(config.gun_min,Math.min(config.gun_max,elevation-e.movementY*sensitivity));
    send();camera();
  });
  listen(viewer.canvas,'wheel',e=>{if(enabled){e.preventDefault();distance=Math.max(4,Math.min(24,distance+e.deltaY*.01));camera();}},{passive:false,capture:true});
  const component={update:()=>logic.update()};viewer.addComponent(component);
  setMode(false);
  return {get enabled(){return enabled;},getFocus:()=>last?[last.state.x,config.ground_lift+(last.state.z??0)+1.3,-last.state.y]:null,exit:()=>setMode(false),dispose(){disposed=true;setMode(false);sharedMode.dispose();abort.abort();logic.dispose();viewer.removeComponent(component);p.remove();delete viewer.canvas.dataset.pythonReady;delete viewer.canvas.dataset.pythonState;}};
}
