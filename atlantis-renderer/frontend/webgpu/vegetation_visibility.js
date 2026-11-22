                                                                         
                                                                               
  
                                         
                                                                            
                                                                               
                                                  

import {GPU} from '../../vendor/tidewater/src/engine/webgpu.js';

const earlyPass=pass=>!!(pass.apsPlanarReflection||pass.apsPointShadow||pass.late||pass.apsVegetationSeed||pass.apsGrassTerrainSample||
  pass.apsStaticLightSeed||pass.apsVegetationLightDraw||pass.apsReceiverXYZ);
const visibleChain=object=>{for(let node=object;node;node=node.parent)if(node.visible===false)return false;return true;};
export const activeVegetationSystems=(systems,{precompiling=false}={})=>[...systems].filter(s=>{
  if(!s||s.disposed||!s.models?.length)return false;
  if(precompiling)return true;
  const draws=s.models.flatMap(m=>m.draws??[]);
                                                                               
                                                                               
  return !draws.length||draws.some(visibleChain);
});
const activeSystems=systems=>activeVegetationSystems(systems,{precompiling:[...systems].some(s=>s.renderer?.precompiling)});

export function prepareVegetationView(systems,scene,pass,seed){
  if(earlyPass(pass)||!pass.depthView)return;
  const active=activeSystems(systems);
  if(!active.length)return;
  const occluding=active.filter(s=>s.options.occlusion);
  const owner=occluding[0]??active[0],view=owner.view(pass,occluding.length>0);
  const raster=!!pass.vegetationRasterOcclusion&&pass.kind!=='depth'&&occluding.length>0&&view.reversed;
  view.rasterOcclusion=raster;view.sharedSystems=active.length;
  const selectTogether=(members,phase,occlusion)=>{
    if(!members.length)return;
    const compute=owner.beginSelection(view,phase);
    for(const system of members)system.select(view,pass,phase,occlusion,compute);
    compute.end();
    for(const system of members)system.finishSelection?.(view,phase);
  };
  const selectGrass=()=>{for(const system of active)system.screenGrass?.select(view,pass);};
  for(const system of active){
    system.views.set(view.key,view);
    if(raster&&!system.groundcover&&!system.isGrass)system.prepareRaster(view);
  }
  selectTogether(active,0,false);
                                                                                
  if(pass.kind==='depth')return;
  if(!occluding.length||!view.reversed){selectGrass();return;}
  const depthPass={...pass,kind:'depth',sampleCount:1,colorViews:[],colorFormats:[],depthView:view.depth.createView(),after:null,betweenLists:null,depthBias:0,depthBiasSlopeScale:0,apsVegetationSeed:true};
  const permitted=o=>!pass.filter||pass.filter(o);
  const shared=pass.apsSharedSolidDepth?.getGPU?.()??pass.apsSharedSolidDepth;
  const casters=active.filter(s=>!s.groundcover&&!s.isGrass);
  const reuseCoverage=pass.kind==='main'&&pass.apsStaticStage==='remaining'&&!raster&&
    owner.renderer.reuseVegetationDepth!==false&&casters.length>0&&
    casters.every(s=>s.models.every(m=>m.draws.every(o=>o.material?.userData?.apsCoverageDepth&&
      o.material.depthTest&&o.material.depthWrite&&!o.material.transparent&&!o.material.depthBias&&!o.material.depthBiasSlopeScale&&
      (!o.material.depthCompare||o.material.depthCompare===(pass.depthCompare??'greater-equal')))))&&
    shared&&shared.width===view.width&&shared.height===view.height&&shared.format==='depth32float'&&
    (shared.usage&GPUTextureUsage.COPY_SRC)&&(shared.usage&GPUTextureUsage.COPY_DST);
  if(shared&&shared.width===view.width&&shared.height===view.height&&shared.format==='depth32float'&&(shared.usage&GPUTextureUsage.COPY_SRC)){
    GPU.getEncoder().copyTextureToTexture({texture:shared},{texture:view.depth},[view.width,view.height]);
    view.solidDepthCopies=(view.solidDepthCopies??0)+1;
  }else{
    seed({...depthPass,label:view.key+' solid occluder depth',clearDepth:0,
      filter:o=>!o.userData?.apsVegetationManaged&&permitted(o),timestampWrites:owner.timestamps(view.key+' shared solid depth seed')});
    view.solidSeedPasses=(view.solidSeedPasses??0)+1;
  }
  if(owner.renderer.precompiling)return {invariantPosition:!!reuseCoverage,depthReused:false};
  owner.buildPyramid(view);
  selectTogether(occluding,1,true);
  if(raster)owner.snapshotSolidDepth(view);
                                                                               
                                                                               
                                                                              
                                                                               
  if(!casters.length){selectGrass();return;}
  const draws=new Set(casters.flatMap(s=>s.models.flatMap(m=>m.draws)));
  seed({...depthPass,label:view.key+' vegetation coverage depth',clearDepth:null,
    invariantPosition:!!reuseCoverage,
    filter:o=>draws.has(o)&&permitted(o),apsRasterView:raster?view:null,
    timestampWrites:owner.timestamps(view.key+' shared coverage depth seed')});
  view.seedPasses++;
  owner.buildPyramid(view);
  selectTogether(occluding.filter(s=>!raster||!s.groundcover&&!s.isGrass),2,raster?2:true);
  if(raster)selectTogether(occluding.filter(s=>s.groundcover||s.isGrass),2,true);
  selectGrass();
  if(reuseCoverage){
                                                                             
                                                                               
                                                                             
                                                                            
                                                                       
    GPU.getEncoder().copyTextureToTexture({texture:view.depth},{texture:shared},[view.width,view.height]);
    view.mainDepthReuseCopies=(view.mainDepthReuseCopies??0)+1;
    return {invariantPosition:true,depthReused:true};
  }
}

                                                                           
                                        
                                                                             
                                                                        
                                                                             
                              
                                                                                
                                                                              
                                                                                
export function prepareReceiverXYZView(systems,scene,pass){
  if(!pass?.apsReceiverXYZ)return null;
  if(!pass.camera)throw Error('prepareReceiverXYZView requires the main camera');
  const fields=(pass.frameBlock??null)?.fields;
  const resolution=fields?.resolution?.value;
  const w=Math.max(1,(resolution?.x??pass.width??0)|0);
  const h=Math.max(1,(resolution?.y??pass.height??0)|0);
  if(!(w>1&&h>1))throw Error('prepareReceiverXYZView requires a valid main FrameUniforms resolution');
  const active=activeSystems(systems);
  if(!active.length)return null;
  const owner=active[0];
  const key=`receiver-xyz:${pass.label??pass.kind??'main'}`;
  const view={
    key,
    width:w,
    height:h,
    pw:w,
    ph:h,
    levels:Math.floor(Math.log2(Math.max(w,h)))+1,
    reversed:fields?.reversedDepth?.value!==0,
    pyramid:null,
    depth:null,
    kind:'receiver-xyz',
    frame:pass.frame??0,
    cameraPolicy:'main camera (screenGrass association preserved)',
    dimensionPolicy:'main FrameUniforms resolution',
    camera:pass.camera,
  };
  for(const system of active)system.views.set(view.key,view);
                                                                               
                                                                             
  const selectionPass={...pass,kind:pass.receiverXYZSelectionKind??'main',apsReceiverXYZ:true};
  const compute=owner.beginSelection(view,0);
  try{
    for(const system of active)system.select(view,selectionPass,0,false,compute);
  }finally{
    compute.end();
  }
  for(const system of active)system.finishSelection?.(view,0);
                                                                             
                                                                             
  for(const system of active)system.screenGrass?.select(view,selectionPass);
  return view;
}

export function disposeVegetationViews(renderer){
  for(const view of renderer.vegetationViews?.values()??[]){
    view.depth?.destroy();view.pyramid?.destroy();view.solidRasterDepth?.destroy();
  }
  renderer.vegetationViews?.clear();
}
