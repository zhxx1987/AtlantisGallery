import {vehicleMode} from './vehicle-mode.js';
export async function installVehicle(host,descriptor,modelURL){
 const viewer=host.native,root=host.root;
 const base=new URL(descriptor.base||'.',modelURL).href;
 const read=async name=>{const r=await fetch(new URL(name,base));if(!r.ok)throw Error(name+' HTTP '+r.status);return r.json();};
 const assets=[];let loading=null;
 const loadAssets=()=>loading??=(async()=>{
  for(const [role,file] of Object.entries(descriptor.assets||{})){
   const url=new URL(file,base).href,response=await fetch(url);
   if(!response.ok)throw Error('Vehicle asset HTTP '+response.status);
   const asset=await host.addVehicleAsset(url,await response.arrayBuffer());
   asset.root.visible=false;assets.push({role,root:asset.root});
  }
  viewer.invalidateVisibility();return Object.fromEntries(assets.map(a=>[a.role,a.root]));
 })();
 const section=document.createElement('section');section.setAttribute('aria-label','Vehicle Controls');
 const button=document.createElement('button');button.className='interaction-button';button.textContent='Loading vehicle controls…';button.disabled=true;
 const reset=document.createElement('button');reset.className='interaction-button';reset.textContent='Reset Vehicle';
 const output=document.createElement('output');output.style.display='block';
 const help=document.createElement('p');section.append(button,reset,output,help);host.panel.prepend(section);
 let plugin,disposed=false;
 const mode=vehicleMode(viewer,on=>{
  if(!on)plugin?.input?.release();
  button.textContent=on?'Esc · Inspect Model':'Start '+(descriptor.profile==='ember-29'?'Riding':'Driving');
  button.setAttribute('aria-pressed',String(on));
  for(const asset of assets)asset.root.visible=on&&asset.role!=='flash';
  host.setVehicleFloor(!on);viewer.invalidateVisibility();
  plugin?.setMode(on);
 });
 button.onclick=()=>mode.set(!mode.active);reset.onclick=()=>plugin?.reset();
 const module=await import(descriptor.module?new URL(descriptor.module,base).href:'./vehicles/'+descriptor.profile+'.js');
 plugin=await module.install({viewer,root,read,base,output,help,mode,loadAssets});
 // Loading remains in the same host and does not request cursor capture without a user gesture.
 await loadAssets();button.disabled=false;button.textContent='Start '+(descriptor.profile==='ember-29'?'Riding':'Driving');
 return {get enabled(){return mode.active;},update:dt=>plugin.update?.(dt),getFocus:()=>plugin.focus?.(),exit:()=>mode.set(false),
  dispose(){if(disposed)return;disposed=true;mode.dispose();plugin.dispose();for(const a of assets){a.root.visible=false;}section.remove();}};
}
export function inputs(mode,canvas,handlers){
 const abort=new AbortController(),keys=new Set(),physical=new Set(),blocked=new Set();
 const on=(target,type,fn,options={})=>target.addEventListener(type,fn,{...options,signal:abort.signal});
 on(window,'keydown',e=>{if(/INPUT|TEXTAREA|SELECT/.test(e.target.tagName))return;physical.add(e.code);if(!mode.active)return;if(e.code==='Tab'){e.preventDefault();return;}if(handlers.codes.includes(e.code)){e.preventDefault();e.stopImmediatePropagation();if(!blocked.has(e.code)&&!e.repeat){keys.add(e.code);handlers.key?.(e.code);}handlers.send();}},{capture:true});
 on(window,'keyup',e=>{physical.delete(e.code);blocked.delete(e.code);if(keys.delete(e.code))handlers.send();});
 on(window,'mousemove',e=>{if(mode.active)handlers.mouse?.(e);});
 on(canvas,'pointerdown',e=>{if(mode.active){e.preventDefault();handlers.down?.(e);}},{capture:true});
 on(window,'pointerup',e=>handlers.up?.(e));
 on(canvas,'wheel',e=>{if(mode.active){e.preventDefault();e.stopImmediatePropagation();handlers.wheel?.(e);}},{capture:true,passive:false});
 return {keys,release(){keys.clear();for(const key of physical)blocked.add(key);handlers.release?.();handlers.send();},dispose(){abort.abort();keys.clear();}};
}
