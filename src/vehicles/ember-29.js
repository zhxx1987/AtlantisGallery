import {PythonLogic} from '../python-logic.js';
import {inputs} from '../vehicle-host.js';
export async function install({viewer,root,read,base,output,help,mode,loadAssets}){
 const config=await read('bike.json');config.settings=await read('settings.json');
 const assets=await loadAssets(),terrain=assets.course,nodes=new Map();
 root.traverse(n=>{if(n.name in config.parents)nodes.set(n.name,n);});
 for(const name of Object.keys(config.parents))if(!nodes.has(name))throw Error('Missing bicycle node '+name);
 let state=null,brake=false,orbit=.56,elevation=.32,gx=NaN,gz=NaN;
 function camera(){if(!mode.active||!state)return;
  const a=state.heading+orbit,t=[state.x+.42*Math.cos(state.heading),state.y+.60,state.z+.42*Math.sin(state.heading)],d=3.35,h=d*Math.cos(elevation);
  viewer.setCamera({position:[t[0]-h*Math.cos(a),t[1]+d*Math.sin(elevation),t[2]-h*Math.sin(a)],target:t,fov:36,near:.035,far:160});
 }
 const send=()=>logic.event('input',{enabled:mode.active,pedal:input.keys.has('KeyW'),brake,turn:Number(input.keys.has('KeyD'))-Number(input.keys.has('KeyA'))});
 const logic=new PythonLogic({module:new URL('motion.py',base).href,config},snapshot=>{
  state=snapshot.state;viewer.canvas.dataset.pythonState=JSON.stringify(state);viewer.canvas.dataset.pythonReady='true';
  output.textContent='Gear '+state.gear+' · '+state.teeth+'T · '+(state.speed*3.6).toFixed(1)+' km/h · '+Math.round(state.rpm)+' rpm · Fork '+Math.round(state.stroke*1000)+' mm';
  if(!mode.active)return;
  for(const [name,array]of Object.entries(snapshot.matrices)){const n=nodes.get(name);n.matrixAutoUpdate=false;n.matrix.fromArray(array);n.matrixWorldNeedsUpdate=true;}
  root.updateMatrixWorld(true);
  const x=Math.round(state.x/24)*24,z=Math.round(state.z/12)*12;
  if(x!==gx||z!==gz){terrain.position.set(x,0,z);terrain.updateMatrixWorld(true);viewer.invalidateObjectTransforms([terrain]);gx=x;gz=z;}
  camera();
 },error=>{output.textContent=String(error);viewer.canvas.dataset.pythonError=String(error);mode.set(false);});
 const input=inputs(mode,viewer.canvas,{codes:['KeyW','KeyA','KeyD','Space','KeyR'],send,
  key:code=>{if(code==='Space')logic.event('jump',true);if(code==='KeyR')logic.event('reset');},
  mouse:e=>{orbit+=e.movementX*.003;elevation=Math.max(.09,Math.min(1.1,elevation+e.movementY*.003));camera();},
  wheel:e=>logic.event('shift',e.deltaY<0?1:-1),down:e=>{if(e.button===0){brake=true;send();}},up:e=>{if(e.button===0&&brake){brake=false;send();}}});
 help.textContent='W pedal · A/D steer · Space hop · Mouse look · Scroll shift · Hold left click brake · R reset · Esc inspect';
 return {input,setMode(){brake=false;send();camera();},reset(){input.release();brake=false;logic.event('reset');send();},
  focus:()=>state?[state.x+.4,state.y+.6,state.z]:null,update:()=>logic.update(),dispose(){input.dispose();input.release();logic.dispose();}};
}
