import {NON_CASCADED_SHADOW_SIZE} from './shadow_resolution.js';
import {PerspectiveCamera,Vector3,Matrix4} from '../../vendor/tidewater/src/engine/index.js';
import {GPU} from '../../vendor/tidewater/src/engine/gpu/GPU.js';
import {Texture} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {createViewUniforms,setFrameCamera} from '../../vendor/tidewater/src/engine/render/Frame.js';
import {setShadowMap} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {meshWorldBounds} from './scene_bounds.js';
import {POINT_FACES,sphereIntersectsBox,boxIntersectsClip} from './point_light_math.js';

export const POINT_SHADOW_REVISION='object-local-point-shadows-r3';
const visible=o=>{for(let p=o;p;p=p.parent)if(!p.visible)return false;return true;};
const isSource=o=>!o.userData?.apsShadowOnly&&!o.userData?.apsVegetationSource&&!o.userData?.apsVegetationManaged&&!o.userData?.apsGrassGenerated;
const moves=o=>{for(let p=o;p;p=p.parent)if(p.userData?.aps_interaction)return true;return false;};
const sourceIds=new WeakMap();let sourceSerial=0;
const sourceId=o=>{if(!o)return null;if(!sourceIds.has(o))sourceIds.set(o,++sourceSerial);return sourceIds.get(o);};
function terrainSources(viewer){
 return [...new Set([viewer.heightfield,...(viewer.taskHeightfields?.values?.()??[])])].filter(Boolean);
}
function terrainSignature(viewer,terrain){
 terrain.root?.updateWorldMatrix?.(true,false);
 return [sourceId(terrain),terrain.heightTexture?.id,terrain.heightTexture?.version,
  terrain.pointShadowRevision?.(),terrain===viewer.heightfield?viewer.terrainIntervention?.revision:null,
  terrain.root?visible(terrain.root):true,terrain.root?.matrixWorld?.elements];
}
function terrainShadowState(viewer){
 return JSON.stringify(terrainSources(viewer).map(terrain=>terrainSignature(viewer,terrain)));
}
function itemKey(item){
 const o=item.object,g=item.geometry,m=item.material;
 return JSON.stringify([o.id,...o.matrixWorld.elements,o.count,o.instanceMatrix?.version,g.id,g.index?.uuid,g.index?.version,...Object.values(g.attributes).flatMap(a=>[a.uuid,a.version]),m.id,m.version,m.visible,m.alphaTest,m.opacity,item.start,item.count]);
}
export function pointCameras(position,near,far,size=NON_CASCADED_SHADOW_SIZE){
                                                                    
 const fov=2*Math.atan(size/(size-4))*180/Math.PI;
 return POINT_FACES.map(([direction,up])=>{const c=new PerspectiveCamera(fov,1,near,far);c.reversedDepth=false;c.position.fromArray(position);c.up.fromArray(up);c.lookAt(new Vector3().fromArray(position.map((v,k)=>v+direction[k])));c.updateProjectionMatrix();c.updateMatrixWorld();return c;});
}

                                                                                
                                                                                 
export class PointLightShadows {
 constructor(viewer,{memoryMB}={}){
  const size = NON_CASCADED_SHADOW_SIZE;
  this.automaticBudget = memoryMB == null;
  if (this.automaticBudget) memoryMB = 256;
  if(!Number.isInteger(size)||size<16||size>GPU.limits.maxTextureDimension2D)throw RangeError('Invalid point-shadow map size');
  if(!(memoryMB>0&&Number.isFinite(memoryMB)))throw RangeError('Invalid point-shadow memory budget');
  this.viewer=viewer;this.size=size;this.memoryMB=memoryMB;this.entries=[];this.capacity=0;this.sourceRevision=-1;this.stats={source_builds:0,list_builds:0,map_builds:0,face_passes:0,empty_faces:0,cache_hits:0,object_updates:0,static_face_passes:0,dynamic_face_passes:0,static_copies:0};
 }
 ensureAtlas(count){
  if(this.texture&&count<=this.capacity)return;
  const capacity = count, layers = capacity * 6, bytes = layers * this.size * this.size * 4;
  // Keep the original 64 MiB of visibility headroom for larger scenes.
  if (this.automaticBudget) this.memoryMB = Math.max(256, bytes / 1024**2 + 64);
  if(layers>GPU.limits.maxTextureArrayLayers||bytes>this.memoryMB*1024**2)throw RangeError(`Point shadow atlas needs ${bytes} bytes / ${layers} layers; increase pointShadowMemoryMB or reduce the number of shadow-casting lights`);
  const old=this.texture,neutral=this.neutral,base=this.staticTexture;this.staticTexture=null;
  this.texture=new Texture({label:'cached point shadow array',width:this.size,height:this.size,depth:layers,dimension:'2d-array',format:'depth32float',usage:['sample','render','copySrc','copyDst']});
  this.neutral=new Texture({label:'point shadow caster neutral depth',width:1,height:1,depth:1,dimension:'2d-array',format:'depth32float',usage:['sample','render']});
  const pass=GPU.getEncoder().beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:this.neutral.view({dimension:'2d',baseArrayLayer:0,arrayLayerCount:1}),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});pass.end();
  this.capacity=capacity;this.bytes=bytes;this.viewer.lighting.setLocalShadowAtlas({texture:this.texture,neutral:this.neutral,matrices:[],info:[]});
  for(const e of this.entries)if(e){e.dirty=true;for(const face of e.faces){face.dirty=true;face.staticDirty=true;}}
  GPU.onSubmit(null,()=>{old?.destroy();neutral?.destroy();base?.destroy();});
 }
 ensureStaticCache(){
  const visibility=this.entries.reduce((n,e)=>n+(e?.visibilityBytes??0),0),allowed=this.bytes*2+visibility<=this.memoryMB*1024**2;
  if(!allowed){if(this.staticTexture){const old=this.staticTexture;this.staticTexture=null;GPU.onSubmit(null,()=>old.destroy());}return;}
  if(this.staticTexture)return;
  this.staticTexture=new Texture({label:'point shadow static depth cache',width:this.size,height:this.size,depth:this.capacity*6,dimension:'2d-array',format:'depth32float',usage:['render','copySrc']});
  for(const e of this.entries)if(e){e.dirty=true;for(const face of e.faces){face.staticDirty=true;face.dirty=true;}}
 }
 invalidate(){this.sourceRevision=-1;this.forceRevision=(this.forceRevision??0)+1;for(const e of this.entries)if(e)e.sourceRevision=-1;}
 sources(revision){
  if(this.sourceRevision===revision)return;
  const {scene,meshRenderer:r}=this.viewer;scene.updateMatrixWorld(true);
  const lists=r.collect(scene,{kind:'depth',cull:false,apsPointShadow:true,filter:o=>isSource(o)&&visible(o)});
  this.records=[...lists.opaque,...lists.transparent].map(item=>({item,box:meshWorldBounds(item.object),key:itemKey(item),dynamic:moves(item.object),enabled:true}));
  this.byObject=new Map();for(const row of this.records){const o=row.item.object;if(!this.byObject.has(o))this.byObject.set(o,[]);this.byObject.get(o).push(row);}
  this.sourceRevision=revision;this.stats.source_builds++;
 }
 invalidateObjects(roots){
  if(this.sourceRevision!==(this.viewer.shadowRevision??0)||!this.byObject)return null;
  const touched=new Set();for(const root of roots){root.updateWorldMatrix(true,true);root.traverse(o=>{if(o.isMesh&&isSource(o)){if(!this.byObject.has(o))touched.add(null);else for(const row of this.byObject.get(o))touched.add(row);}});}
  if(touched.has(null))return null;const changes=[],boxes=[];
  for(const row of touched){const key=itemKey(row.item),enabled=visible(row.item.object)&&row.item.object.castShadow;if(key===row.key&&enabled===row.enabled)continue;
   const old=row.enabled?row.box:null,wasStatic=!row.dynamic;row.box=meshWorldBounds(row.item.object);row.key=key;row.enabled=enabled;row.dynamic=true;
   if(old)boxes.push(old);if(enabled&&row.box)boxes.push(row.box);changes.push({row,old,next:enabled?row.box:null,wasStatic});
  }
  if(!changes.length)return [];
  for(const e of this.entries){if(!e)continue;
   const relevant=changes.filter(c=>[c.old,c.next].some(b=>b&&sphereIntersectsBox(e.position,e.far,b)));if(!relevant.length)continue;
   const changed=new Set(relevant.map(c=>c.row));
   for(const face of e.faces){const affected=relevant.filter(c=>[c.old,c.next].some(b=>b&&boxIntersectsClip(b,face.matrix)));if(!affected.length)continue;
    face.records=face.records.filter(row=>!changed.has(row));for(const {row,next}of relevant)if(next&&sphereIntersectsBox(e.position,e.far,next)&&boxIntersectsClip(next,face.matrix))face.records.push(row);
    face.items=this.items(face.records);face.dirty=true;if(affected.some(c=>c.wasStatic))face.staticDirty=true;e.dirty=true;
   }
  }
  this.stats.object_updates++;return boxes;
 }
 items(records){return {opaque:records.filter(r=>r.enabled&&!r.item.material.transparent).map(r=>({...r.item})),transparent:records.filter(r=>r.enabled&&r.item.material.transparent).map(r=>({...r.item}))};}
 prepare(light,index,revision,terrainState=terrainShadowState(this.viewer)){
  const position=Array.from(light.position?.toArray?.()??light.position??[]),range=light.distance??light.range??0;
  if(position.length!==3||!position.every(Number.isFinite))throw TypeError('Point shadow requires a finite position');
  const candidates=this.records.filter(r=>r.enabled&&(range<=0||sphereIntersectsBox(position,range,r.box)));
                                                                                 
  let far=range||1;
  if(!range)for(const r of this.records){if(!r.box)continue;const lo=r.box.min.toArray(),hi=r.box.max.toArray();far=Math.max(far,Math.hypot(...lo.map((v,k)=>Math.max(Math.abs(v-position[k]),Math.abs(hi[k]-position[k]))))*1.01);}
  const terrains=terrainSources(this.viewer).filter(terrain=>!terrain.root||visible(terrain.root));
  const vegetation=[...this.viewer.meshRenderer.vegetationSystems].filter(s=>!s.disposed&&!s.population&&!s.models.some(m=>m.gpuPopulation)).map(system=>({system,models:system.models.filter(m=>m.source.castShadow&&m.draws.some(visible)&&sphereIntersectsBox(position,range||Infinity,m.worldBounds))})).filter(row=>row.models.length);
  if(!range){for(const b of [...terrains.map(terrain=>terrain.pointShadowBounds()),...vegetation.flatMap(row=>row.models.map(m=>m.worldBounds))])if(b){const lo=b.min.toArray?.()??b.min,hi=b.max.toArray?.()??b.max;far=Math.max(far,Math.hypot(...lo.map((v,k)=>Math.max(Math.abs(v-position[k]),Math.abs(hi[k]-position[k]))))*1.01);}}
  const near=light.shadow?.near??Math.min(.05,far/1000),bias=light.shadow?.bias??.00002,normalBias=light.shadow?.normalBias??.015;
  if(!(near>0&&near<far&&Number.isFinite(far)&&Number.isFinite(bias)&&bias>=0&&Number.isFinite(normalBias)&&normalBias>=0))throw RangeError('Invalid point-shadow near/far/bias');
  const terrainRelevant=terrains.filter(terrain=>sphereIntersectsBox(position,range||Infinity,terrain.pointShadowBounds()));
  const terrainKey=terrainRelevant.map(terrain=>terrainSignature(this.viewer,terrain));
  const key=JSON.stringify([position,near,far,bias,normalBias,this.forceRevision??0,candidates.map(r=>r.key),terrainKey,vegetation.map(row=>[row.system.intervention?.version,row.models.map(m=>[sourceId(m),m.n,m.instanceVersion,m.world,m.materials.map(mat=>[mat.id,mat.version,mat.alphaTest,mat.opacity])])])]);
  let e=this.entries[index];
  if(e?.key===key){e.sourceRevision=revision;e.terrainState=terrainState;return e;}
  const visibilityBytes=6*vegetation.reduce((bytes,row)=>bytes+row.models.reduce((b,m)=>b+16*m.n+1024+4*m.blockCount,0),0);
  if(this.bytes+visibilityBytes+this.entries.reduce((n,entry,i)=>n+(i===index?0:entry?.visibilityBytes??0),0)>this.memoryMB*1024**2)throw RangeError('Point shadow maps + native visibility lists exceed pointShadowMemoryMB');
  this.releaseEntry(e);const cameras=pointCameras(position,near,far,this.size);
  e={key,index,position,far,near,bias,normalBias,visibilityBytes,dirty:true,vegetation,builds:(e?.builds??0),faces:cameras.map((camera,f)=>{
   const matrix=new Matrix4().multiplyMatrices(camera.projectionMatrix,camera.matrixWorldInverse),records=candidates.filter(r=>boxIntersectsClip(r.box,matrix));
   return {camera,matrix,block:createViewUniforms(`point shadow ${index} face ${f}`),records,items:this.items(records),dirty:true,staticDirty:true,terrains:terrainRelevant.map(terrain=>terrain.createPointShadowCaster(matrix)).filter(Boolean)};
  })};
  e.visibilityBytes+=e.faces.reduce((n,f)=>n+f.terrains.reduce((bytes,terrain)=>bytes+(terrain.geometry.attributes.apsPatch.array.byteLength??0),0),0);
  if(this.bytes+e.visibilityBytes+this.entries.reduce((n,entry,i)=>n+(i===index?0:entry?.visibilityBytes??0),0)>this.memoryMB*1024**2){this.releaseEntry(e);this.entries[index]=null;throw RangeError('Point shadow maps + terrain/vegetation visibility exceed pointShadowMemoryMB');}
  e.sourceRevision=revision;e.terrainState=terrainState;this.entries[index]=e;this.stats.list_builds++;return e;
 }
 render(){
  const v=this.viewer,r=v.meshRenderer,local=v.lighting.localLights,lights=local.lights??[];
  if(!lights.length){this.clear();return;}
                                                                                 
                                                           
  const active=lights.map((l,i)=>({l,i})).filter(({l})=>l.type!=='spot'&&!l.isSpotLight&&l.castShadow!==false);
  if(!active.length){this.clear();return;}
  this.ensureAtlas(active.length);
  const revision=v.shadowRevision??0,terrainState=terrainShadowState(v);this.sources(revision);
  const enabled=new Set(active.map(({i})=>i));for(let i=0;i<this.entries.length;i++)if(this.entries[i]&&!enabled.has(i)){this.releaseEntry(this.entries[i]);this.entries[i]=null;}
  const entries=active.map(({l,i})=>{const lightKey=JSON.stringify([l.position,l.distance??l.range??0,l.shadow?.near,l.shadow?.bias,l.shadow?.normalBias]);let e=this.entries[i];if(!e||e.lightKey!==lightKey||e.sourceRevision!==revision||e.terrainState!==terrainState){e=this.prepare(l,i,revision,terrainState);e.lightKey=lightKey;}else if(!e.dirty)this.stats.cache_hits++;return e;}),shadow=local.shadow;
  this.ensureStaticCache();
  const info=shadow.params.fields.info.value;for(let i=0;i<32;i++)info[i]=[-1,0,0,0];
  const sync=r.syncPipelines;r.syncPipelines=true;shadow.writing=true;setShadowMap(v.shadows.neutral);
  try{for(const [slot, e] of entries.entries()){
   if (e.atlasSlot !== slot) {
    e.atlasSlot = slot;
    e.dirty = true;
    for (const face of e.faces) { face.dirty = true; face.staticDirty = true; }
   }
   const firstLayer = slot * 6;
   shadow.params.fields.softness.value[e.index]=[lights[e.index].shadow?.sourceRadius??.06,e.near,e.far,0];
   for(let f=0;f<6;f++)shadow.params.fields.matrices.value[firstLayer+f]=e.faces[f].matrix;
   if(e.dirty){for(let f=0;f<6;f++){
    const face=e.faces[f];if(!face.dirty)continue;
    const layer=firstLayer+f,pass={label:`point-shadow-${e.index}-${f}`,kind:'depth',camera:face.camera,frameBlock:face.block,apsPointShadow:true,pointShadowNeutral:this.neutral,cull:false,depthView:(this.staticTexture??this.texture).view({dimension:'2d',baseArrayLayer:layer,arrayLayerCount:1}),depthFormat:'depth32float',clearDepth:1,depthCompare:'less-equal',depthBias:2,depthBiasSlopeScale:1};
    setFrameCamera(face.camera,this.size,this.size,{block:face.block});
    if(!this.staticTexture||face.staticDirty){
    const items=this.staticTexture?this.items(face.records.filter(row=>!row.dynamic)):{opaque:[...face.items.opaque],transparent:[...face.items.transparent]};
    for(const terrain of face.terrains)items.opaque.push({object:terrain,geometry:terrain.geometry,material:terrain.material,start:0,count:Infinity});
    for(const {system,models} of e.vegetation){
     const view=system.view(pass,false);system.select(view,{...pass,pointShadowModels:new Set(models)},0,false);const draws=new Set(models.flatMap(m=>m.draws));
     const list=r.collect(v.scene,{...pass,filter:o=>draws.has(o)&&visible(o)});items.opaque.push(...list.opaque);items.transparent.push(...list.transparent);
    }
    r.render(v.scene,{...pass,items});this.stats.face_passes++;this.stats.static_face_passes++;if(!items.opaque.length&&!items.transparent.length)this.stats.empty_faces++;
    }
    if(this.staticTexture){
     GPU.getEncoder().copyTextureToTexture({texture:this.staticTexture.getGPU(),origin:{x:0,y:0,z:layer},aspect:'depth-only'},{texture:this.texture.getGPU(),origin:{x:0,y:0,z:layer},aspect:'depth-only'},[this.size,this.size,1]);this.stats.static_copies++;
     const items=this.items(face.records.filter(row=>row.dynamic));if(items.opaque.length||items.transparent.length){r.render(v.scene,{...pass,depthView:this.texture.view({dimension:'2d',baseArrayLayer:layer,arrayLayerCount:1}),clearDepth:null,items});this.stats.face_passes++;this.stats.dynamic_face_passes++;}
    }
    if(!r.precompiling){face.dirty=false;face.staticDirty=false;}
   }
                                                                                
   if(!r.precompiling){e.dirty=false;e.builds++;this.stats.map_builds++;}
   }
   if(!e.dirty)info[e.index]=[firstLayer,1,e.bias,e.normalBias];
  }}finally{shadow.writing=false;r.syncPipelines=sync;setShadowMap(v.shadows.texture);}
 }
 releaseEntry(e){if(!e)return;for(const f of e.faces){const release=()=>{f.block.buffer?.destroy();for(const terrain of f.terrains)terrain.geometry.dispose();};if(GPU.encoder)GPU.onSubmit(null,release);else release();}const r=this.viewer.meshRenderer;for(let f=0;f<6;f++){const key=`point-shadow-${e.index}-${f}`;for(const s of r.vegetationSystems){s.releaseView?.(key);}r.vegetationViews?.delete(key);}}
 clear(){if(!this.entries.length&&!this.texture)return;for(const e of this.entries)this.releaseEntry(e);this.entries=[];this.records=[];this.byObject=null;this.sourceRevision=-1;const local=this.viewer.lighting?.localLights;if(local?.shadow){for(let i=0;i<32;i++)local.shadow.params.fields.info.value[i]=[-1,0,0,0];local.shadow.texture=this.neutral;}const old=this.texture,base=this.staticTexture;this.texture=null;this.staticTexture=null;this.capacity=0;this.bytes=0;const release=()=>{old?.destroy();base?.destroy();};if(GPU.encoder)GPU.onSubmit(null,release);else release();}
 metadata(){return {revision:POINT_SHADOW_REVISION,filter:'cube-seam-aware PCSS: 12 blocker + 24 comparison taps',size:this.size,capacity:this.capacity,memory_bytes:(this.bytes??0)+(this.staticTexture?this.bytes:0),static_depth_cache:!!this.staticTexture,stats:{...this.stats},cluster_builds:this.viewer.lighting?.localLights?.gridBuilds??0,excluded_camera_population_systems:[...this.viewer.meshRenderer.vegetationSystems].filter(s=>s.population||s.models.some(m=>m.gpuPopulation)).length,lights:this.entries.filter(Boolean).map(e=>({index:e.index,source_radius_m:this.viewer.lighting.localLights.lights[e.index].shadow?.sourceRadius??.06,dirty:e.dirty,builds:e.builds,face_items:e.faces.map(f=>f.items.opaque.length+f.items.transparent.length),terrain_faces:e.faces.filter(f=>f.terrains.length).length})),policy:'object-local updates; static depth + moving caster overlay within budget; dirty cube faces only; no camera keys'};}
 dispose(){this.clear();this.texture?.destroy();this.neutral?.destroy();this.texture=null;this.neutral=null;}
}
