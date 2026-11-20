import {Vector3,Quaternion} from 'three';
import {PythonLogic} from '../python-logic.js';
import {inputs} from '../vehicle-host.js';
export async function install({viewer:v,root,read,base,output,help,mode,loadAssets}){
 const [rig,terrain,assets]=await Promise.all([read('rig.json'),read('terrain.json'),loadAssets()]);
 const glow=assets.flash;
 function live(node){if(!node)throw Error('Missing T-10 model node');if(!node.matrixAutoUpdate)node.matrix.decompose(node.position,node.quaternion,node.scale);node.matrixAutoUpdate=true;return node;}
 live(root);live(glow);
 const named=name=>live(root.getObjectByName(name));
  const turret=named('Turret'),mantlet=named('Mantlet'),barrel=named('Barrel');
  const chassis=named('Chassis');
  const chassisBase=chassis.quaternion.clone();
  const bodyPitch=new Quaternion(),bodyRoll=new Quaternion();
  const covers=['PortHatch','StarboardHatch','DriverCover'].map(named);
  const driverBase=covers[2].position.clone();
  const wheels=['L','R'].map(side=>['drive_'+side,'idler_'+side,...Array.from({length:7},(_,i)=>'Road_'+side+'_'+i),...Array.from({length:3},(_,i)=>'Return_'+side+'_'+i)].map(named));
  const wheelBases=wheels.map(side=>side.map(n=>n.position.clone()));
  const swings=['L','R'].map(side=>Array.from({length:7},(_,i)=>named('Swing_'+side+'_'+i)));
  const swingBases=swings.map(side=>side.map(n=>({position:n.position.clone(),rotation:n.quaternion.clone()})));
  const tracks=['L','R'].map(side=>Array.from({length:rig.count},(_,i)=>named('Track_'+side+'_'+String(i).padStart(3,'0'))));
  const length=rig.distance.at(-1);
  const pitch=length/rig.count;
  const axle=new Vector3(0,1,0);
  const pinA=new Vector3(),pinB=new Vector3();
  function samplePin(dist,out,offsets){
    dist=((dist%length)+length)%length;
    let lo=0,hi=rig.distance.length-1;
    while(hi-lo>1){const m=(hi+lo)>>1;if(rig.distance[m]<=dist)lo=m;else hi=m;}
    const a=rig.contour[lo],b=rig.contour[lo+1],f=(dist-rig.distance[lo])/(rig.distance[lo+1]-rig.distance[lo]);
    out.set(a[0]+f*(b[0]-a[0]),0,a[1]+f*(b[1]-a[1]));
    if(offsets && out.z<.42){
      let j=0;while(j<rig.road.length-2 && rig.road[j+1]<out.x)j++;
      const blend=Math.max(0,Math.min(1,(out.x-rig.road[j])/(rig.road[j+1]-rig.road[j])));
      const delta=offsets[j]+blend*(offsets[j+1]-offsets[j]);
      const weight=Math.max(0,Math.min(1,(.42-out.z)/.36));
      out.z+=delta*weight;
      out.x+=(.21-Math.sqrt(Math.max(0,.21**2+.36**2-(-.36+delta)**2)))*weight;
    }
  }
  function animateTrack(links,travel,offsets){
    samplePin(-travel-pitch/2,pinA,offsets);
    for(let i=0;i<links.length;i++){
      samplePin((i+.5)*pitch-travel,pinB,offsets);
      const link=links[i];
      link.position.x=(pinA.x+pinB.x)/2;
      link.position.z=(pinA.z+pinB.z)/2;
      // Replace the complete bind rotation. Equivalent Euler decompositions of
      // the imported half-turn can also have nonzero X and Z components.
      link.quaternion.setFromAxisAngle(axle,-Math.atan2(pinB.z-pinA.z,pinB.x-pinA.x));
      link.scale.x=Math.hypot(pinB.z-pinA.z,pinB.x-pinA.x)/pitch;
      pinA.copy(pinB);
    }
  }

 const localTip=new Vector3(),q=new Quaternion(),swingPivot=new Vector3(),rotatedPivot=new Vector3();
 const audio=new Audio(new URL('effect.wav',base));let heard=0,last=null,disposed=false;
 const send=()=>logic.event('input',{enabled:mode.active,throttle:Number(input.keys.has('KeyW'))-Number(input.keys.has('KeyS')),steer:Number(input.keys.has('KeyA'))-Number(input.keys.has('KeyD')),brake:input.keys.has('Space')});
 const logic=new PythonLogic({module:new URL('./t10_motion.py',import.meta.url).href,dependencies:{'drive_core.py':new URL('drive_core.py',base).href},config:{gauge:rig.gauge,terrain}},snapshot=>{
  last=snapshot.state;v.canvas.dataset.pythonState=JSON.stringify(last);v.canvas.dataset.pythonReady='true';
  output.textContent=(last.speed*3.6).toFixed(1)+' km/h · Ground contact '+last.grounded+'/14'+(last.braking?' · Braking':'');
  if(!mode.active)return;
  const s=snapshot.array;
    const [x,y,yaw,left,right,l,r,t,p,recoil,flash,shots,eye,aim,hatch,z,bodyTilt,roll,suspension,grounded,speed,braking]=s;
    root.position.set(x,z,-y);root.rotation.y=yaw;
    chassis.quaternion.copy(chassisBase).multiply(bodyPitch.setFromAxisAngle(axle,-bodyTilt)).multiply(bodyRoll.setFromAxisAngle(new Vector3(1,0,0),roll));
    turret.rotation.z=t;mantlet.rotation.y=-p;barrel.position.x=-recoil;
    for(const cover of covers)cover.rotation.y=-hatch;
    covers[2].position.copy(driverBase);covers[2].position.x+=.27*(Math.cos(hatch)-1);covers[2].position.z+=.27*Math.sin(hatch);
    for(let side=0;side<2;side++){
      const travel=side?r:l;
      wheels[side].forEach((n,i)=>{n.rotation.y=travel/(i===0?.356:i===1?.369:i<9?.405:.153);});
      const offsets=suspension.slice(side*7,side*7+7);
      offsets.forEach((delta,i)=>{
        const wheel=wheels[side][i+2],base=wheelBases[side][i+2];
        // Authored origin is at the wheel hub. Rotate about the actual upper
        // torsion-bar pivot and move the hub on the same circular arc.
        const upper=.36,back=.21,radius=Math.hypot(upper,back),lowerZ=-upper+delta;
        const lowerX=-Math.sqrt(Math.max(0,radius*radius-lowerZ*lowerZ));
        const angle=Math.atan2(-upper,-back)-Math.atan2(lowerZ,lowerX);
        wheel.position.copy(base);wheel.position.x+=lowerX+back;wheel.position.z+=delta;
        const swing=swings[side][i],bind=swingBases[side][i];
        q.setFromAxisAngle(axle,angle);
        swing.quaternion.copy(bind.rotation).multiply(q);
        swingPivot.set(back,side? .15:-.15,upper);
        rotatedPivot.copy(swingPivot).applyQuaternion(q);
        swing.position.copy(bind.position).add(swingPivot).sub(rotatedPivot);
      });
      animateTrack(tracks[side],travel,offsets);
    }
    root.updateMatrixWorld(true);
    const wasVisible=glow.visible;
    glow.visible=flash>0;glow.position.copy(barrel.localToWorld(localTip.set(4.48,0,0)));
    glow.quaternion.copy(barrel.getWorldQuaternion(q));glow.scale.setScalar(.5+flash);
    glow.updateMatrixWorld(true);
    if(wasVisible!==glow.visible)v.invalidateVisibility();
    v.invalidateObjectTransforms([glow]);
    if(shots>heard){heard=shots;audio.currentTime=0;audio.play().catch(()=>{});}

  v.setCamera({position:[eye[0],eye[2],-eye[1]],target:[aim[0],aim[2],-aim[1]],fov:36,near:.035,far:1600});
 },error=>{output.textContent=String(error);v.canvas.dataset.pythonError=String(error);mode.set(false);});
 const input=inputs(mode,v.canvas,{codes:['KeyW','KeyS','KeyA','KeyD','Space','KeyH','KeyR'],send,
  key:code=>{if(code==='KeyH')logic.event('hatch');if(code==='KeyR')logic.event('reset');},
  mouse:e=>logic.event('mouse',[e.movementX,e.movementY]),down:e=>{if(e.button===0)logic.event('fire');}});
 help.textContent='W/S drive · A/D steer · Space brake / hold · Mouse look and aim · Left click fire effect · H hatches · R reset · Esc inspect';
 return {input,setMode:()=>send(),reset:()=>{input.release();logic.event('reset');send();},
  focus:()=>last?[last.x,last.z+1.5,-last.y]:null,
  update:()=>logic.update(),dispose(){input.dispose();disposed=true;input.release();logic.dispose();audio.pause();}};
}
