import {GPU,FrameUniforms,StorageBuffer} from '../../vendor/tidewater/src/engine/webgpu.js';
import {BufferGeometry,BufferAttribute,Box3,Vector3} from '../../vendor/tidewater/src/engine/index.js';
import {buildStaticBSP,staticBSPAdmission} from './static_bsp_plan.js';
import {buildChunkedIndex,frustumPlanes,multiplyMat4,matrixSnapshot,sameMatrixSnapshot} from './static_draw_gpu_plan.js';
import {STATIC_OCCLUSION_WGSL} from './static_occlusion_wgsl.js';
import {VEGETATION_HIZ_COPY,VEGETATION_HIZ_REDUCE} from './vegetation_compute.js';

const REVISION='static-bsp-draw-r3-shared-opaque-sources',pow2=n=>2**Math.ceil(Math.log2(Math.max(1,n)));
const storage=(label,type,count,data=null,usage=[])=>new StorageBuffer({label,type,count:Math.max(1,count),data,usage});
const HEADER=          `
struct View {vp:mat4x4f,planes:array<vec4f,6>,screen:vec4f};
struct Cell {lo:vec4f,hi:vec4f,info:vec4u};
@group(0) @binding(0) var<uniform> view:View;
fn visible(lo:vec3f,hi:vec3f)->bool{
 let c=(lo+hi)*0.5;let e=(hi-lo)*0.5;
 for(var p=0u;p<6u;p++){if(dot(view.planes[p].xyz,c)+view.planes[p].w+dot(abs(view.planes[p].xyz),e)<-0.0001){return false;}}
 return true;
}
`;
const BSP=HEADER+STATIC_OCCLUSION_WGSL+          `
@group(0) @binding(1) var<storage,read> nodes:array<Cell>;
@group(0) @binding(2) var<storage,read> refs:array<u32>;
@group(0) @binding(3) var<storage,read_write> flags:array<atomic<u32>>;
@group(0) @binding(4) var<storage,read> selectedSpans:array<u32>;
@group(0) @binding(5) var selfDepth:texture_2d<f32>;
@group(0) @binding(6) var<storage,read> sourceSpans:array<Cell>;
@compute @workgroup_size(1) fn main(){
 var n=0u;
 loop{
  if(n>=arrayLength(&nodes)){break;}
  let node=nodes[n];
  if(!visible(node.lo.xyz,node.hi.xyz)||apsStaticOccluded(node.lo.xyz,node.hi.xyz,selfDepth,view.vp,view.screen.xy)){n=node.info.x;continue;}
  if(node.info.w==3u){for(var r=0u;r<node.info.z;r++){let id=refs[node.info.y+r];let s=sourceSpans[id];if(selectedSpans[id]!=0u&&visible(s.lo.xyz,s.hi.xyz)&&!apsStaticOccluded(s.lo.xyz,s.hi.xyz,selfDepth,view.vp,view.screen.xy)){atomicOr(&flags[id],1u);}}}
  n++;
 }
}
`;
const TERRAIN=HEADER+STATIC_OCCLUSION_WGSL+          `
@group(0) @binding(1) var<storage,read> spans:array<Cell>;
@group(0) @binding(2) var<storage,read_write> flags:array<u32>;
@group(0) @binding(3) var terrain:texture_2d<f32>;
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) gid:vec3u){
 let i=gid.x;if(i>=arrayLength(&spans)||flags[i]==0u){return;}
 if(apsStaticOccluded(spans[i].lo.xyz,spans[i].hi.xyz,terrain,view.vp,view.screen.xy)){flags[i]=0u;}
}
`;
const COMPACT=          `
struct Cell {lo:vec4f,hi:vec4f,info:vec4u};
@group(0) @binding(0) var<storage,read> spans:array<Cell>;
@group(0) @binding(1) var<storage,read> flags:array<u32>;
@group(0) @binding(2) var<storage,read> source:array<u32>;
@group(0) @binding(3) var<storage,read_write> dest:array<u32>;
@group(0) @binding(4) var<storage,read_write> commands:array<atomic<u32>>;
var<workgroup> base:u32;var<workgroup> count:u32;
@compute @workgroup_size(64) fn main(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
 let i=group.x;if(i>=arrayLength(&spans)){return;}let s=spans[i];
 if(lane==0u){count=select(0u,s.info.y,flags[i]!=0u);base=0u;if(count>0u){base=atomicAdd(&commands[0],count);}}
 workgroupBarrier();for(var j=lane;j<count;j+=64u){dest[base+j]=source[s.info.x+j];}
}
`;

function pack(cells){
 const bytes=new ArrayBuffer(Math.max(1,cells.length)*48),f=new Float32Array(bytes),u=new Uint32Array(bytes);
 cells.forEach((s,i)=>{f.set(s.min,i*12);f.set(s.max,i*12+4);u.set(s.info??[s.escape,s.start,s.count,s.axis],i*12+8);});return u;
}
const worldBox=o=>{if(!o.geometry.boundingBox)o.geometry.computeBoundingBox();return o.geometry.boundingBox.clone().applyMatrix4(o.matrixWorld);};
const span=(box,start,count)=>({min:box.min.toArray(),max:box.max.toArray(),info:[start,count,0,0]});

export class StaticBSPGPU {
 constructor(renderer){this.renderer=renderer;this.entries=new Map();this.views=new Map();this.retired=[];this.last=null;this.builds=0;this.init();}
 init(){
  const device=GPU.device;
  const kernel=(label,code)=>device.createComputePipeline({label,layout:'auto',compute:{module:device.createShaderModule({label,code}),entryPoint:'main'}});
  this.kernels={bsp:kernel('static mesh GPU spatial BSP traversal',BSP),terrain:kernel('BSP survivors terrain occlusion',TERRAIN),compact:kernel('static BSP complete index compaction',COMPACT),copy:kernel('landscape depth to min Hi-Z',VEGETATION_HIZ_COPY),reduce:kernel('static min Hi-Z reduction',VEGETATION_HIZ_REDUCE)};
 }
 retire(fn){this.retired.push(fn);}
 flush(){if(!this.retired.length)return;const jobs=this.retired.splice(0);GPU.submit();GPU.queue.onSubmittedWorkDone().then(()=>jobs.forEach(f=>f()),()=>jobs.forEach(f=>f()));}
 destroyEntry(e){
  this.entries.delete(e.object);this.retire(()=>{for(const k of ['nodes','references','spans','indices'])e[k]?.destroy();for(const d of e.views.values()){for(const k of ['flags','active','commands','indices'])d[k].destroy();d.geometry.dispose();}});
 }
 prepare(root,cameras=[]){
  const batches=[...this.renderer.materialBatch.families.values()].flatMap(f=>f.batches),current=new Set(batches.map(b=>b.object));
  for(const e of this.entries.values())if(e.batch&&!current.has(e.object))this.destroyEntry(e);
  const add=(object,batch=null)=>{
   if(staticBSPAdmission(object))return;
   let e=this.entries.get(object);if(e&&this.matches(e))return;
   if(e)this.destroyEntry(e);
   const geometry=object.geometry;let spans=[],indices,sourceRows;
   if(batch){
    spans=batch.members.map(r=>span(worldBox(r.object),r.start,r.count));indices=new Uint32Array(geometry.index.array);sourceRows=batch.members.map(r=>r.object);
   }else{
    const old=this.renderer.staticDraw?.entries.get(object),built=old?.kind==='chunks'?{chunks:old.localChunks,index:old.chunkGeometry.index.array}:buildChunkedIndex({index:geometry.index.array,positions:geometry.attributes.position.array,positionItemSize:geometry.attributes.position.itemSize});
    indices=new Uint32Array(built.index);sourceRows=[object];
    spans=built.chunks.map(c=>span(new Box3(new Vector3(...c.min),new Vector3(...c.max)).applyMatrix4(object.matrixWorld),c.firstIndex,c.indexCount));
   }
   const tree=buildStaticBSP(spans);
   e={object,geometry,batch,sourceRows,poses:sourceRows.map(o=>matrixSnapshot(o.matrixWorld)),versions:sourceRows.map(o=>[o.geometry,o.geometry.index?.version,o.geometry.attributes.position?.version]),spanRows:spans,tree,views:new Map(),nodes:storage('static BSP spatial cells','vec4u',tree.nodes.length*3,pack(tree.nodes)),references:storage('static BSP duplicated leaf references','u32',tree.references.length,tree.references),spans:storage('static BSP source spans','vec4u',spans.length*3,pack(spans)),indices:storage('static BSP exact source indices','u32',indices.length,indices)};
   for(const k of ['nodes','references','spans','indices'])e[k].getGPU();this.entries.set(object,e);this.builds++;
  };
  root.traverse(o=>{if(!this.renderer.materialBatch.records.get(o)?.batch)add(o);});
  for(const batch of batches)add(batch.object,batch);
                                                                             
  for(const e of [...this.entries.values()])if(!e.batch&&this.renderer.materialBatch.records.get(e.object)?.batch)this.destroyEntry(e);
  for(const camera of cameras){const view=this.view(camera);if(view)for(const e of this.entries.values())this.data(e,view);}
  this.flush();
 }
 matches(e){return e.geometry===e.object.geometry&&e.sourceRows.every((o,i)=>sameMatrixSnapshot(e.poses[i],o.matrixWorld)&&o.geometry===e.versions[i][0]&&o.geometry.index?.version===e.versions[i][1]&&o.geometry.attributes.position?.version===e.versions[i][2]);}
 view(camera){
  let v=this.views.get(camera);if(v)return v;if(this.views.size>=4)return null;
  v={camera,uniform:GPU.device.createBuffer({label:'static BSP view matrices',size:176,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})};this.views.set(camera,v);return v;
 }
 data(e,view){
  let d=e.views.get(view);if(d)return d;
  const n=e.spanRows.length,commands=storage('static BSP indirect','u32',5,new Uint32Array([0,1,0,0,0]),['indirect']),indices=storage('static BSP visible indices','u32',e.geometry.index.count,null,['index']);
  const geometry=new BufferGeometry();for(const [name,a] of Object.entries(e.geometry.attributes))geometry.setAttribute(name,a);geometry.setIndex(e.geometry.index);
  geometry.userData={apsStaticVertexOwner:e.geometry,apsStaticCompactedIndex:indices,aps_static_bsp_proxy:true};geometry.indirect={buffer:commands,offset:0};
  d={geometry,commands,indices,flags:storage('static BSP visibility','u32',n),active:storage('static BSP source selection','u32',n),selection:new Uint32Array(n),uploadedSelection:new Uint32Array(n).fill(0xffffffff),groups:new Map(),bspGroups:new Map()};
  const bind=(pipeline,resources)=>GPU.device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource:resource?.getGPU?{buffer:resource.getGPU()}:resource}))});
  d.bindBSP=texture=>{let g=d.bspGroups.get(texture);if(!g){g=bind(this.kernels.bsp,[{buffer:view.uniform},e.nodes,e.references,d.flags,d.active,texture.createView(),e.spans]);d.bspGroups.set(texture,g);}return g;};
  d.compact=bind(this.kernels.compact,[e.spans,d.flags,e.indices,d.indices,d.commands]);
  d.bindTerrain=texture=>{let group=d.groups.get(texture);if(!group){group=bind(this.kernels.terrain,[{buffer:view.uniform},e.spans,d.flags,texture.createView()]);d.groups.set(texture,group);}return group;};
  e.views.set(view,d);return d;
 }
 pyramid(view,key,width,height,depthView){
  let p=view[key];const pw=pow2(width),ph=pow2(height),levels=Math.floor(Math.log2(Math.max(pw,ph)))+1;
  if(!p||p.pw!==pw||p.ph!==ph){
   if(p){const old=p.texture;this.retire(()=>old.destroy());for(const e of this.entries.values()){e.views.get(view)?.groups.clear();e.views.get(view)?.bspGroups.clear();}}
   const texture=GPU.device.createTexture({label:key+' static visibility min depth',size:[pw,ph],format:'r32float',mipLevelCount:levels,usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});
   p={texture,pw,ph,levels,reduce:[]};view[key]=p;
   for(let i=1;i<levels;i++)p.reduce.push(GPU.device.createBindGroup({layout:this.kernels.reduce.getBindGroupLayout(0),entries:[{binding:0,resource:texture.createView({baseMipLevel:i-1,mipLevelCount:1})},{binding:1,resource:texture.createView({baseMipLevel:i,mipLevelCount:1})}]}));
  }
  if(p.depthView!==depthView){p.copy=GPU.device.createBindGroup({layout:this.kernels.copy.getBindGroupLayout(0),entries:[{binding:0,resource:depthView},{binding:1,resource:p.texture.createView({baseMipLevel:0,mipLevelCount:1})}]});p.depthView=depthView;}
  const copy=p.copy;
                                                                              
  let cp=GPU.getEncoder().beginComputePass({label:key+' depth pyramid base'});cp.setPipeline(this.kernels.copy);cp.setBindGroup(0,copy);cp.dispatchWorkgroups(Math.ceil(pw/8),Math.ceil(ph/8));cp.end();
  for(let i=1;i<levels;i++){cp=GPU.getEncoder().beginComputePass({label:key+' depth pyramid mip '+i});cp.setPipeline(this.kernels.reduce);cp.setBindGroup(0,p.reduce[i-1]);cp.dispatchWorkgroups(Math.ceil(Math.max(1,pw>>i)/8),Math.ceil(Math.max(1,ph>>i)/8));cp.end();}
  return p.texture;
 }
 renderStages(scene,pass,draw){
  const view=this.view(pass.camera);if(!view)return draw({...pass,apsStaticStage:'fallback'});
  const screen=FrameUniforms.fields.resolution.value,width=Math.max(1,Math.round(screen.x)),height=Math.max(1,Math.round(screen.y));
  const vp=multiplyMat4(pass.camera.projectionMatrix.elements,pass.camera.matrixWorldInverse.elements),values=new Float32Array(44);values.set(vp);values.set(frustumPlanes(vp),16);values.set([width,height,pass.camera.near??.1,0],40);GPU.queue.writeBuffer(view.uniform,0,values);
  const permitted=o=>!pass.filter||pass.filter(o),terrain=o=>!!o.userData?.apsTerrainOccluder;
  const vegetation=o=>!!(o.userData?.apsVegetationManaged||o.userData?.apsVegetationSource||o.userData?.apsGrassGenerated);
  const mesh=o=>o.isMesh&&!o.isInstancedMesh&&!terrain(o)&&!vegetation(o);
  const instances=o=>o.isMesh&&o.isInstancedMesh&&!terrain(o)&&!vegetation(o);
                                                                            
                                                                              
                                                                               
                                                                    
  const sources=pass.items??this.renderer.collect(scene,{...pass,apsStaticSourceOnly:true,filter:permitted});
  const common={...pass,items:undefined,clearColors:null,clearDepth:null,after:null,apsStaticView:view,apsStaticSourceLists:sources};
  const summaryStart=this.renderer.passSummary?.frame===GPU.frame?this.renderer.passSummary.passes.length:0;
  draw({...pass,items:undefined,apsStaticSourceLists:sources,after:null,apsStaticStage:'landscape',filter:o=>permitted(o)&&terrain(o)});
  const visibilityDepth=()=>pass.resolveVisibilityDepth?.().view()??pass.depthView;
  const terrainDepth=this.pyramid(view,'terrain',width,height,visibilityDepth());
  if(!view.selfDepth||view.selfWidth!==width||view.selfHeight!==height){
   if(view.selfDepth){const old=view.selfDepth;this.retire(()=>old.destroy());}
   view.selfDepth=GPU.device.createTexture({label:'ordinary static mesh BSP depth only',size:[width,height],format:'depth32float',usage:GPUTextureUsage.RENDER_ATTACHMENT|GPUTextureUsage.TEXTURE_BINDING});view.selfDepthView=view.selfDepth.createView();view.selfWidth=width;view.selfHeight=height;
  }
                                                                               
                                                                              
  draw({...common,label:pass.label+' static BSP source depth',kind:'depth',sampleCount:1,apsVegetationSeed:true,colorViews:[],colorFormats:[],depthView:view.selfDepthView,clearDepth:0,apsStaticStage:'self-seed',filter:o=>permitted(o)&&mesh(o)});
  const selfDepth=this.pyramid(view,'self',width,height,view.selfDepthView);
  draw({...common,label:pass.label+' static BSP + terrain',apsStaticStage:'mesh',apsStaticTerrain:terrainDepth,apsStaticSelf:selfDepth,filter:o=>permitted(o)&&mesh(o)});
  const materialBatch=this.renderer.materialBatch.metadata();
  const solidDepth=this.pyramid(view,'solid',width,height,visibilityDepth());
  draw({...common,label:pass.label+' static instances',apsStaticStage:'instances',apsStaticOcclusion:{terrain:terrainDepth,solid:solidDepth,width,height},filter:o=>permitted(o)&&instances(o)});
  const instanceVisibility=this.renderer.visibilityFrame;
  draw({...common,apsSharedSolidDepth:pass.resolveVisibilityDepth?.()??pass.depthTexture??null,label:pass.label+' remaining',after:pass.after,apsStaticStage:'remaining',apsStaticOriginalFilter:pass.filter,filter:o=>permitted(o)&&!terrain(o)&&!mesh(o)&&!instances(o)});
  this.renderer.visibilityFrame=instanceVisibility;
  const totals={indexed_calls:0,instanced_indexed_calls:0,nonindexed_calls:0,instances:0,max_instance_count:0,indirect_calls:0};
  for(const p of this.renderer.passSummary?.passes.slice(summaryStart)??[])for(const k of Object.keys(totals))totals[k]=k==='max_instance_count'?Math.max(totals[k],p.gpu_api[k]):totals[k]+p.gpu_api[k];
  this.renderer.actualDraws=totals;
  this.last={revision:REVISION,frame:GPU.frame,order:['landscape','static_mesh_gpu_bsp','surviving_mesh_terrain_occlusion','static_instance_frustum','static_instance_terrain_occlusion','static_instance_hiz'],source_scene_collections:1,landscape_in_bsp:false,instances_in_bsp:false,material_batch:materialBatch,gpu_api:totals};this.flush();
 }
 apply(lists,pass){
  const view=pass.apsStaticView;if(!view)return;
  const plans=new Map(),output=[],fallback={};
  for(const item of lists.opaque){
   const e=this.entries.get(item.object);let plan=plans.get(e);
   if(!plan&&(!e||!this.matches(e))){const reason=e?'changed_source_not_prepared':staticBSPAdmission(item.object)??'bsp_not_prepared';fallback[reason]=(fallback[reason]??0)+1;output.push(item);continue;}
   if(!plan){const data=e.views.get(view);if(!data){fallback.view_not_prepared=(fallback.view_not_prepared??0)+1;output.push(item);continue;}plan={e,data,item};data.selection.fill(0);plans.set(e,plan);output.push({...item,geometry:data.geometry,start:0,count:Infinity});}
   const end=item.count===Infinity?e.geometry.index.count:item.start+item.count;
   let lo=0,hi=e.spanRows.length;while(lo<hi){const mid=(lo+hi)>>>1;if(e.spanRows[mid].info[0]<item.start)lo=mid+1;else hi=mid;}
   for(let i=lo;i<e.spanRows.length;i++){const s=e.spanRows[i];if(s.info[0]+s.info[1]>end)break;plan.data.selection[i]=1;}
  }
  const encoder=GPU.getEncoder();let uploads=0;
  for(const {data:d} of plans.values()){
   if(d.selection.some((x,i)=>x!==d.uploadedSelection[i])){d.active.write(d.selection);d.uploadedSelection.set(d.selection);uploads++;}
   encoder.clearBuffer(d.flags.getGPU());encoder.clearBuffer(d.commands.getGPU(),0,4);
  }
  if(plans.size){
   let cp=encoder.beginComputePass({label:'static mesh GPU BSP traversal'});cp.setPipeline(this.kernels.bsp);for(const {data:d} of plans.values()){cp.setBindGroup(0,d.bindBSP(pass.apsStaticSelf));cp.dispatchWorkgroups(1);}cp.end();
   cp=encoder.beginComputePass({label:'BSP survivors terrain occlusion'});cp.setPipeline(this.kernels.terrain);for(const {e,data:d} of plans.values()){cp.setBindGroup(0,d.bindTerrain(pass.apsStaticTerrain));cp.dispatchWorkgroups(Math.ceil(e.spanRows.length/64));}cp.end();
   cp=encoder.beginComputePass({label:'BSP survivors exact indices'});cp.setPipeline(this.kernels.compact);for(const {e,data:d} of plans.values()){cp.setBindGroup(0,d.compact);cp.dispatchWorkgroups(e.spanRows.length);}cp.end();
  }
  lists.opaque=output;this.lastSelection={frame:GPU.frame,draws:plans.size,compute_passes:plans.size?3:0,selection_mask_uploads:uploads,fallback_reasons:fallback};
 }
 forgetRoot(root){const members=new Set();root.traverse(o=>members.add(o));for(const e of [...this.entries.values()])if(members.has(e.object)||e.sourceRows.some(o=>members.has(o)))this.destroyEntry(e);this.flush();}
 metadata(){return {revision:REVISION,enabled:this.renderer.staticDrawEnabled,entries:this.entries.size,spatial_splits:[...this.entries.values()].reduce((n,e)=>n+e.tree.splits,0),builds:this.builds,views:this.views.size,last_frame:this.last,last_selection:this.lastSelection,ordinary_mesh_only:true,landscape_in_bsp:false,instances_in_bsp:false,bsp_visibility:'GPU spatial-plane BSP traversal with frustum and same-frame mesh-only depth proof; terrain depth rejection follows',instance_visibility:'frustum -> current terrain depth -> current solid Hi-Z'};}
 dispose(){for(const e of [...this.entries.values()])this.destroyEntry(e);for(const v of this.views.values())this.retire(()=>{v.uniform.destroy();v.terrain?.texture.destroy();v.solid?.texture.destroy();v.self?.texture.destroy();v.selfDepth?.destroy();});this.views.clear();this.flush();}
}
