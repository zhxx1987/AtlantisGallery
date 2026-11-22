import {concatenateVegetation} from './vegetation_geometry.js';
import {createVegetationMaterial,partitionVegetationFacesets,vegetationBindingBudget} from './vegetation_material.js';
import {Group,Mesh,InstancedMesh,Matrix4,Vector3,Quaternion,Box3} from '../../vendor/tidewater/src/engine/index.js';
import {GPU,Texture,generateMipmaps,decodeImage,LAYERS} from '../../vendor/tidewater/src/engine/webgpu.js';
import {parseMeshGLB,primitiveGeometry,instanceMatrices,inspectGLB} from './mesh_gltf.js';
import {ensurePlantLODs} from './plant_lod_loader.js';
import {prepareNativeImport} from './mesh_import.js';
import {initialPrimitivePose} from './mesh_pose.js';
import {inheritedBuildingData} from './building_layers.js';
import {batchStaticOccurrences,validateMeshBounds,markNativeStaticGeometry,nativeStaticDepthSafe} from './mesh_batch.js';
import {instanceAwareBounds} from './scene_bounds.js';
import {VegetationSystem} from './vegetation_system.js';
import {isNativeGrassPatch,packNativeGrassLODLevels,nativeImpostorNormalFrame} from './grass_patch_geometry.js';
import {materialCodeTable} from './mesh_material_code.js';
import {createMeshMaterial} from './mesh_material.js';
import {createPrincipledLightingModule,principledLightingModule,principledDFGModule} from './principled_wgsl.js';
import {loadRockLayerPBR} from './rock_layer_pbr.js';
import {MeshTextureArray,planTextureArrays,textureArrayLayerLimit,textureMipCount,TEXTURE_ARRAY_SCHEMA} from './mesh_texture_array.js';
import {primitiveMirror} from './planar_mirror_contract.js';

                                                                           
                                                                             
                                                                               
const meshLightingModules=new WeakMap();
function meshLighting(viewer){
  if(!viewer.principledDFGModule&&!viewer.principledLocalLightModule)return principledLightingModule;
  const dfg=viewer.principledDFGModule??principledDFGModule,local=viewer.principledLocalLightModule??null,cached=meshLightingModules.get(viewer);
  if(cached?.dfg===dfg&&cached.local===local)return cached.module;
  const module=createPrincipledLightingModule({dfgModule:dfg,localLightModule:local});meshLightingModules.set(viewer,{dfg,local,module});return module;
}

export {parseMeshGLB} from './mesh_gltf.js';
export {createMeshMaterial,createSavedWaterMaterial} from './mesh_material.js';

class MeshTexture extends Texture {
  getGPU() {
    const fresh=!this.gpu;const result=super.getGPU();
                                                                               
                                                                             
    if(fresh&&this.mipLevelCount>1)generateMipmaps(this);
    return result;
  }
}
function abortError(message='Mesh loading aborted') { const e=new Error(message);e.name='AbortError';return e; }
function check(viewer,signal,id) { if(signal?.aborted)throw signal.reason??abortError();if(viewer.disposed||viewer.loadId!==id)throw abortError('Mesh load superseded/disposed'); }
const sha256=async array=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',array)),v=>v.toString(16).padStart(2,'0')).join('');
export function samplerDescriptor(definition={}) {
  const wrap={10497:'repeat',33071:'clamp-to-edge',33648:'mirror-repeat'};
  const min=definition.minFilter??9987,mag=definition.magFilter??9729;
  if(![9728,9729,9984,9985,9986,9987].includes(min)||![9728,9729].includes(mag)||!wrap[definition.wrapS??10497]||!wrap[definition.wrapT??10497])throw Error('Unsupported glTF sampler');
  return {addressModeU:wrap[definition.wrapS??10497],addressModeV:wrap[definition.wrapT??10497],magFilter:mag===9728?'nearest':'linear',minFilter:[9728,9984,9986].includes(min)?'nearest':'linear',mipmapFilter:[9984,9985].includes(min)?'nearest':'linear',lodMinClamp:0,lodMaxClamp:min===9728||min===9729?0:32,maxAnisotropy:mag!==9728&&[9729,9987].includes(min)?8:1};
}
const slots=m=>({base:m.pbrMetallicRoughness?.baseColorTexture,mr:m.pbrMetallicRoughness?.metallicRoughnessTexture,normal:m.normalTexture,ao:m.occlusionTexture,emissive:m.emissiveTexture,opacity:m.extras?.apsOpacityTexture,leafMask:m.extras?.apsFoliageMaskTexture,leafTransmission:m.extras?.apsTransmissionTexture,coat:m.extensions?.KHR_materials_clearcoat?.clearcoatTexture,coatR:m.extensions?.KHR_materials_clearcoat?.clearcoatRoughnessTexture,coatNormal:m.extensions?.KHR_materials_clearcoat?.clearcoatNormalTexture});
let textureBankSerial=0;
export async function textureBank(parsed,url,signal,resources,{textureArray=true,decode=decodeImage,materials=null}={}) {
  const bank='b'+String(textureBankSerial++).padStart(2,'0');
  const images=new Map(),samplers=new Map();
  const getImage=async index=>{
    if(!images.has(index))images.set(index,(async()=>{
      const image=parsed.images[index];if(!image)throw Error(`Missing glTF image ${index}`);
      let bytes=image.bytes,mime=image.mimeType;
      if(!bytes&&image.uri) {
        const imageURL=new URL(image.uri,url);
        if(!['data:','blob:'].includes(imageURL.protocol)&&(!['http:','https:'].includes(imageURL.protocol)||imageURL.origin!==new URL(url).origin))throw Error('glTF texture must share its model origin');
        const response=await fetch(imageURL,{signal,credentials:'omit'});if(!response.ok)throw Error(`Cannot fetch glTF image ${index} (${response.status})`);
        bytes=new Uint8Array(await response.arrayBuffer());mime??=response.headers.get('content-type')?.split(';')[0];
      }
      if(!bytes||!['image/png','image/jpeg','image/webp'].includes(mime))throw Error(`Unsupported glTF image encoding ${mime??'(missing)'}`);
      const result=await decode(bytes,mime);
      if(!Number.isInteger(result.width)||!Number.isInteger(result.height)||result.width<1||result.height<1||result.data?.length!==result.width*result.height*4)throw Error('Invalid decoded glTF image');
      if(GPU.limits?.maxTextureDimension2D&&Math.max(result.width,result.height)>GPU.limits.maxTextureDimension2D)throw Error('glTF image exceeds native device texture limit');
      return {...result,sha256:await sha256(bytes)};
    })());
    return images.get(index);
  };
  const getSampler=definition=>{
    const descriptor=samplerDescriptor(definition),key=JSON.stringify(descriptor);
    if(!samplers.has(key)) {
      if(!GPU.device)throw Error('WebGPU device must be initialized before loading mapped GLB');
      samplers.set(key,{name:'apsMeshSampler'+samplers.size,sampler:GPU.device.createSampler(descriptor)});
    }
    return samplers.get(key);
  };
  const collectUses=()=>{
    const uses=new Map();
    for(const material of materials??parsed.materials??parsed.json.materials??[])for(const [slot,info] of Object.entries(slots(material))) {
      if(!info)continue;
      if(!Number.isInteger(info.index)||info.index<0)throw Error('Invalid glTF texture index');
      const def=parsed.textures[info.index];if(!def||!Number.isInteger(def.source))throw Error(`Missing glTF texture source ${info.index}`);
      if(def.sampler!==undefined&&!parsed.json.samplers?.[def.sampler])throw Error('Missing glTF sampler');
      const srgb=slot==='base'||slot==='emissive',key=def.source+':'+srgb;
      if(!uses.has(key))uses.set(key,{key,imageIndex:def.source,colorSpace:srgb?'srgb':'linear',format:srgb?'rgba8unorm-srgb':'rgba8unorm',mips:true});
    }
    return [...uses.values()];
  };
  let state=null,preparePromise=null;
  const prepare=()=>preparePromise??=(async()=>{
    const uses=collectUses(),decoded=new Map();
    for(const use of uses)decoded.set(use.key,await getImage(use.imageIndex));
    const entries=[];
    for(const use of uses) {
      const image=decoded.get(use.key);
      entries.push({...use,width:image.width,height:image.height,mipCount:textureMipCount(image.width,image.height,true),encodedSHA256:image.sha256,nativeSHA256:await sha256(image.data)});
    }
    const maxLayers=textureArray?textureArrayLayerLimit(GPU.limits):1;
    const plan=planTextureArrays(entries,{maxLayers,minLayers:2,bank});
    const arrayTextures=new Map(),textures=new Map();
    for(const array of plan.arrays) {
      const texture=new MeshTextureArray({width:array.width,height:array.height,format:array.format,mips:true,label:`glTF array ${array.arrayName}`,layers:array.layers.map(layer=>({layer:layer.layer,data:decoded.get(layer.key).data}))});
      texture.userData={schema:TEXTURE_ARRAY_SCHEMA,kind:'gltf-texture-2d-array',arrayName:array.arrayName,width:array.width,height:array.height,format:array.format,colorSpace:array.colorSpace,mipCount:array.mipCount,layers:array.layers.map(layer=>({layer:layer.layer,imageIndex:layer.imageIndex,encodedSHA256:layer.encodedSHA256,nativeSHA256:layer.nativeSHA256}))};
      arrayTextures.set(array.arrayName,texture);resources.textures.add(texture);
    }
    for(const entry of plan.twoDimensional) {
      const image=decoded.get(entry.key);
      const texture=new MeshTexture({width:image.width,height:image.height,data:image.data,format:entry.format,mips:true,label:`glTF image ${entry.imageIndex} ${entry.colorSpace}`});
      texture.userData={schema:TEXTURE_ARRAY_SCHEMA,kind:'gltf-texture-2d',imageIndex:entry.imageIndex,encodedSHA256:entry.encodedSHA256,nativeSHA256:entry.nativeSHA256,colorSpace:entry.colorSpace};
      textures.set(entry.key,texture);resources.textures.add(texture);
    }
    const byKey=new Map();
    for(const [key,binding] of plan.bindings) {
      const texture=binding.array?arrayTextures.get(binding.arrayName):textures.get(key);
      if(!texture)throw Error(`Missing planned texture for ${key}`);
      byKey.set(key,{...binding,texture,name:binding.array?binding.arrayName:`apsMeshTexture${texture.id}`,layer:binding.array?binding.arrayLayer:undefined,arrayName:binding.arrayName??null});
    }
    state={plan,byKey,arrayTextures,textures};
    return state;
  })();
  return {
    prepare,
    async forMaterial(material) {
      const prepared=await prepare(),out={};
      for(const [slot,info] of Object.entries(slots(material))) {
        if(!info)continue;
        if(!Number.isInteger(info.index)||info.index<0)throw Error('Invalid glTF texture index');
        const def=parsed.textures[info.index];if(!def||!Number.isInteger(def.source))throw Error(`Missing glTF texture source ${info.index}`);
        if(def.sampler!==undefined&&!parsed.json.samplers?.[def.sampler])throw Error('Missing glTF sampler');
        const srgb=slot==='base'||slot==='emissive',key=def.source+':'+srgb,binding=prepared.byKey.get(key);
        if(!binding)throw Error(`Missing texture array bank entry ${key}`);
        const smp=getSampler(parsed.json.samplers?.[def.sampler]);
        out[slot]={name:binding.name,samplerName:smp.name,sampler:smp.sampler,texture:binding.texture,info,layer:binding.arrayLayer??undefined,array:!!binding.array,arrayName:binding.arrayName,imageIndex:binding.imageIndex,encodedSHA256:binding.encodedSHA256,nativeSHA256:binding.nativeSHA256};
      }
      return out;
    },
    metadata() {
      const plan=state?.plan;
      return {schema:TEXTURE_ARRAY_SCHEMA,enabled:!!textureArray,bank,maxTextureArrayLayers:plan?.maxLayers??textureArrayLayerLimit(GPU.limits),
        arrays:(plan?.arrays??[]).map(array=>({name:array.arrayName,width:array.width,height:array.height,format:array.format,colorSpace:array.colorSpace,mipCount:array.mipCount,layers:array.layers.map(layer=>({layer:layer.layer,imageIndex:layer.imageIndex,encodedSHA256:layer.encodedSHA256,nativeSHA256:layer.nativeSHA256}))})),
        two_dimensional:(plan?.twoDimensional??[]).map(entry=>({imageIndex:entry.imageIndex,colorSpace:entry.colorSpace,encodedSHA256:entry.encodedSHA256,nativeSHA256:entry.nativeSHA256,reason:entry.reason})),
        counts:plan?.counts??{arrays:0,array_layers:0,textures_2d:0,bindings:0,images:0}};
    }
  };
}
function nodeMatrix(node) {
  if(node.matrix)return new Matrix4().fromArray(node.matrix);
  const q=new Quaternion().fromArray(node.rotation??[0,0,0,1]),length=q.lengthSq();
  if(!Number.isFinite(length)||length<=1e-12)q.identity();else if(Math.abs(length-1)>1e-3)q.normalize();
  return new Matrix4().compose(new Vector3().fromArray(node.translation??[0,0,0]),q,new Vector3().fromArray(node.scale??[1,1,1]));
}
function graph(parsed) {
  const nodes=parsed.json.nodes??[],groups=nodes.map((n,index)=>{
    const group=new Group();group.name=n.name??`node_${index}`;group.userData={...(n.extras??{}),gltf_node:index,gltf_extensions:n.extensions??{}};
    group.matrixAutoUpdate=false;group.matrix.copy(nodeMatrix(n));group.matrixWorldNeedsUpdate=true;return group;
  });
  const parent=new Map(),visiting=new Set(),visited=new Set();
  const visit=i=>{
    if(!Number.isInteger(i)||!groups[i])throw Error('Invalid scene node index');
    if(visiting.has(i))throw Error('Cyclic glTF node hierarchy');if(visited.has(i))return;
    visiting.add(i);
    for(const child of nodes[i].children??[]) {
      if(parent.has(child))throw Error('glTF node has multiple parents');parent.set(child,i);visit(child);groups[i].add(groups[child]);
    }
    visiting.delete(i);visited.add(i);
  };
                                                                                   
  for(let i=0;i<nodes.length;i++)if(!visited.has(i))visit(i);
  const scene=parsed.json.scenes?.[parsed.json.scene??0];
  if(parsed.json.scenes&&!scene)throw Error('Missing selected glTF scene');
  const root=new Group();root.name=scene?.name??'Native glTF scene';root.userData={...(parsed.json.extras??{}),...(scene?.extras??{})};
  const roots=scene?.nodes??nodes.map((_,i)=>i).filter(i=>!parent.has(i));
  const used=new Set();
  const include=i=>{if(used.has(i))throw Error('Repeated glTF scene node');used.add(i);for(const c of nodes[i].children??[])include(c);};
  for(const i of roots){if(!groups[i]||parent.has(i))throw Error('Invalid glTF root');include(i);root.add(groups[i]);}
  for(let i=0;i<groups.length;i++)if(!parent.has(i))groups[i].updateMatrixWorld(true);
  root.updateMatrixWorld(true);return {root,groups,used};
}
function entity(group) { for(let n=group;n;n=n.parent)if(n.userData.entity_id!==undefined)return n.userData.entity_id;return null; }
function disposeResources(resources) {
  for(const m of resources.meshes)m.dispose();for(const g of resources.geometries)g.dispose();for(const m of resources.materials){m.dispose();m.uniformBlock?.buffer?.destroy();}for(const t of resources.textures)t.destroy();for(const b of resources.buffers??[])b.destroy();
}

                                                                              
                                                                                  
export async function loadMesh(viewer,url,signal,{grassPatch=false,textureArray=true,plant=false,initiallyHidden=false}={}) {
  const id=viewer.loadId;await viewer.ready;check(viewer,signal,id);
  const absolute=new URL(url,globalThis.location?.href??import.meta.url).href;
                                                                             
                                                                           
                                                                             
                                                               
  const imported=viewer.options?.readGalleryMesh
    ? await viewer.options.readGalleryMesh(absolute,signal)
    : await prepareNativeImport(absolute,signal);
  check(viewer,signal,id);
  let buffer=imported.buffer;
  const sourceBuffer=buffer,sourceGLB=inspectGLB(sourceBuffer),sourceBin=sourceGLB.chunks.find(c=>c.type===0x004e4942)?.bytes;
  const plantLOD=await ensurePlantLODs(sourceBuffer,{required:plant||grassPatch,signal,onProgress:stage=>viewer.options?.onLoadProgress?.(stage)});
  check(viewer,signal,id);buffer=plantLOD.buffer;
  const parsed=parseMeshGLB(buffer),table=materialCodeTable(parsed.json);
  viewer.options?.prepareGalleryMesh?.(parsed,imported.metadata);
  const normalFrame=nativeImpostorNormalFrame(parsed.json);
  const nativePatch=isNativeGrassPatch(parsed.json);
  const resources={meshes:new Set(),geometries:new Set(),materials:new Set(),textures:new Set(),buffers:new Set()};let root,vegetation;
  try {
    const sceneGraph=graph(parsed);root=sceneGraph.root;
    const articulatedNodes=new Set((parsed.json.extras?.APS_articulation?.joints??[]).flatMap(j=>(j.dofs??[]).map(d=>d.node)));
                                                                               
                                                                                
    const usedMaterials=new Set();
    for(const nodeIndex of sceneGraph.used) {
      const source=parsed.json.nodes[nodeIndex];if(source.mesh===undefined)continue;
      for(const primitive of parsed.meshes[source.mesh]??[])if(Number.isInteger(primitive.material)&&primitive.material>=0)usedMaterials.add(primitive.material);
    }
    const bank=await textureBank(parsed,absolute,signal,resources,{textureArray,materials:[...usedMaterials].map(index=>parsed.materials[index]).filter(Boolean)});await bank.prepare();
    const bindingCache=new Map(),geometryCache=new Map(),materialCache=new Map(),rockLayerCache=new Map();
    const lighting=meshLighting(viewer);
    const readback=[],stats={nodes:sceneGraph.used.size,draws:0,instance_draws:0,instances:0,triangles:0};
    const reserved=new Set([...table.keys(),...parsed.materials.map(m=>m.extras?.material_id).filter(i=>i!==undefined)]),ids=new Map();let nextId=0;
    const materialId=index=>{if(!ids.has(index)){const explicit=parsed.materials[index]?.extras?.material_id;if(explicit!==undefined)ids.set(index,explicit);else {while(reserved.has(nextId))nextId++;reserved.add(nextId);ids.set(index,nextId++);}}return ids.get(index);};
    for(const nodeIndex of sceneGraph.used) {
      const source=parsed.json.nodes[nodeIndex],owner=sceneGraph.groups[nodeIndex];if(source.mesh===undefined)continue;
      const primitives=parsed.meshes[source.mesh];if(!primitives)throw Error('Missing glTF mesh');
      const attrs=parsed.instances.get(nodeIndex),matrices=attrs?instanceMatrices(attrs):null;
      const worldDet=owner.matrixWorld.determinant();if(!Number.isFinite(worldDet)||Math.abs(worldDet)<1e-12)throw Error('Singular node transform cannot preserve normals');
      const batches=new Map();
      if(matrices) {
        const matrix=new Matrix4();for(let i=0;i<matrices.length/16;i++) {
          matrix.fromArray(matrices,i*16);const det=matrix.determinant();
          if(!Number.isFinite(det)||Math.abs(det)<1e-12)throw Error('Singular instance transform');
          const mirrored=det*worldDet<0;if(!batches.has(mirrored))batches.set(mirrored,[]);batches.get(mirrored).push(i);
        }
      } else batches.set(worldDet<0,null);
      for(let pi=0;pi<primitives.length;pi++) {
        check(viewer,signal,id);const primitive=primitives[pi],deformed=source.skin!==undefined||primitive.targets.length>0,primitiveDef=parsed.json.meshes[source.mesh].primitives[pi];
        const geometryKey=JSON.stringify([Object.entries(primitiveDef.attributes).sort(([a],[b])=>a.localeCompare(b)),primitiveDef.indices??null,primitiveDef.mode??4]);
        const gkey=deformed?`${source.mesh}:${pi}:pose:${nodeIndex}`:geometryKey;
        if(!geometryCache.has(gkey)){const g=primitiveGeometry(initialPrimitivePose(parsed,primitive,nodeIndex,sceneGraph.groups));geometryCache.set(gkey,g);resources.geometries.add(g.geometry);}
        const built=geometryCache.get(gkey),geometry=built.geometry;
        const materialIndex=primitive.material??-1;if(materialIndex!==-1&&!parsed.materials[materialIndex])throw Error('Missing glTF material');
        const definition=parsed.materials[materialIndex]??{},mid=materialId(materialIndex);
        const code=definition.extras?.mat_code??table.get(mid)??'return ctx.source;';
        if(!bindingCache.has(materialIndex))bindingCache.set(materialIndex,await bank.forMaterial(definition));
        const rockDescriptor=definition.extras?.rock_pbr_layers;let rockLayers=null;
        if(rockDescriptor){
          const key=JSON.stringify(rockDescriptor);if(!rockLayerCache.has(key)){
            const layer=await loadRockLayerPBR(rockDescriptor,absolute,{Texture,digest:sha256,fetcher:u=>fetch(u,{signal})});
            resources.textures.add(layer.texture);rockLayerCache.set(key,layer);check(viewer,signal,id);
          }rockLayers=rockLayerCache.get(key);
        }
        for(const [mirrored,indices] of batches) {
          const mkey=[materialIndex,built.topology,!!geometry.attributes.normal,!!geometry.attributes.tangent,Object.keys(geometry.attributes).filter(k=>/^uv/.test(k)).join(','),mirrored].join('|');
          if(!materialCache.has(mkey)) {
            const material=createMeshMaterial(definition,{textureBindings:bindingCache.get(materialIndex),code,materialId:mid,hasNormal:!!geometry.attributes.normal,hasTangent:!!geometry.attributes.tangent,uvSets:[0,1,2,3].filter(i=>geometry.attributes[i?'uv'+i:'uv']),topology:built.topology,mirrored,lighting,normalFrame,materialLibrary:viewer.materialLibrary??viewer.principledSources?.materialLibrary??'',rockLayers});
            materialCache.set(mkey,material);resources.materials.add(material);
          }
                                                                            
                                                                           
          const vegetationPrototype=!!parsed.json.meshes[source.mesh].extras?.aps_vegetation_lods;
          const material=materialCache.get(mkey),mesh=indices||vegetationPrototype?new InstancedMesh(geometry,material,indices?.length??1):new Mesh(geometry,material);
          resources.meshes.add(mesh);mesh.name=source.name??parsed.json.meshes[source.mesh].name??`mesh_${source.mesh}_${pi}`;
          const instanceEntityIds=indices&&attrs?._ENTITY_ID?.itemSize===1?indices.map(i=>attrs._ENTITY_ID.array[i]):null;
          mesh.userData={...(parsed.json.meshes[source.mesh].extras??{}),...(parsed.json.meshes[source.mesh].primitives[pi].extras??{}),...owner.userData,entity_id:entity(owner),instance_entity_ids:instanceEntityIds,gltf_mesh:source.mesh,gltf_primitive:pi,sourceInstanceIndices:indices,instanceAttributes:attrs??null,aps_deformed:deformed,aps_animated:parsed.animations.length>0};
          Object.assign(mesh.userData,inheritedBuildingData(owner));
          if(mesh.userData.aps_building_role==='roof')mesh.userData.aps_no_instancing=true;
          let articulated=false;for(let p=owner;p;p=p.parent)if(articulatedNodes.has(p.userData?.gltf_node)){articulated=true;break;}
          if(mesh.userData.aps_interaction||articulated){mesh.userData.aps_no_instancing=true;mesh.userData.aps_no_batch=true;for(let p=owner;p;p=p.parent)p.userData.aps_keep_in_hierarchy=true;}
          const mirror=primitiveMirror(owner.userData,parsed.json.meshes[source.mesh],primitiveDef);
          if(mirror!==undefined)mesh.userData.aps_planar_mirror=mirror;
          if(mirror!==undefined&&mirror!==false){
            if(deformed)throw Error('Planar mirror requires rigid geometry');
            mesh.userData.aps_no_instancing=true;mesh.userData.aps_no_batch=true;
          }
          mesh.castShadow=true;mesh.receiveShadow=true;mesh.layers.set(material.transparent?LAYERS.TRANSPARENT:LAYERS.OPAQUE);
          if(indices){for(let i=0;i<indices.length;i++)mesh.instanceMatrix.array.set(matrices.subarray(indices[i]*16,indices[i]*16+16),i*16);mesh.instanceMatrix.needsUpdate=true;mesh.computeBoundingBox();mesh.computeBoundingSphere();stats.instance_draws++;}
          else if(vegetationPrototype){mesh.setMatrixAt(0,new Matrix4());mesh.computeBoundingBox();mesh.computeBoundingSphere();stats.instance_draws++;}
          owner.add(mesh);stats.draws++;stats.instances+=mesh.count;stats.triangles+=built.triangles*mesh.count;
                                                                                 
                                                          
          const merge={materialId:mid,definition,code,textured:Object.keys(bindingCache.get(materialIndex)).length>0||!!rockLayers,
            native:!!definition.extras?.native_material,unlit:!!definition.extensions?.KHR_materials_unlit,
            alphaMode:definition.alphaMode??'OPAQUE',doubleSided:!!definition.doubleSided,mirrored:!!mirrored};
          readback.push({mesh,nodeIndex,deformed:deformed||!!mesh.userData.aps_vegetation_lods,meshIndex:source.mesh,primitiveIndex:pi,materialIndex,entity_id:mesh.userData.entity_id,attributes:primitive.attributes,indices:primitive.indices,instanceAttributes:attrs??null,instanceMatrices:matrices,sourceInstanceIndices:indices,trianglesPerOccurrence:built.triangles,triangles:built.triangles*mesh.count,merge});
        }
      }
    }
                                                                                 
                                                                                  
                                                             
    root.updateMatrixWorld(true);
    for(const row of readback)row.staticWorldMatrix=Array.from(row.mesh.matrixWorld.elements);
    const batching=viewer.options?.readGalleryMesh?{skipped:'gallery interaction hierarchy'}:nativePatch?{skipped:'native grass patch prototype'}:batchStaticOccurrences(root,readback,resources,parsed.animations.length>0,{lighting,materialLibrary:viewer.materialLibrary??viewer.principledSources?.materialLibrary??''});
    if(batching.triangles&&batching.triangles.source!==stats.triangles)throw Error(`Static instancing source triangles ${batching.triangles.source} differ from built ${stats.triangles}`);
    const provenance=batching.detach?.provenance??null,detachedGroups=batching.detach?.detached??0;
    validateMeshBounds(root);
    const vegetationRows=readback.filter(r=>r.mesh.userData.aps_vegetation_lods);
    if(nativePatch){
      if(parsed.animations.length)throw Error('Native API grass patch must be static');
      root.updateMatrixWorld(true);
      const levels=packNativeGrassLODLevels(readback,parsed,{expectedTriangles:parsed.json.extras.grass_patch.rendered_triangles});
      for(const p of levels)resources.geometries.add(p.geometry);
      const packed=levels[0];
      const material=createVegetationMaterial(packed.materials);resources.materials.add(material);
      const source=new InstancedMesh(packed.geometry,material,1);source.name='Native API grass patch';
      source.setMatrixAt(0,new Matrix4());source.instanceMatrix.needsUpdate=true;
      source.castShadow=true;source.receiveShadow=true;source.layers.set(LAYERS.OPAQUE);
      for(const row of readback)row.mesh.removeFromParent();root.add(source);resources.meshes.add(source);
      vegetation=await new VegetationSystem(viewer.meshRenderer).init();
      vegetation.register(source,levels.map(p=>p.geometry));
      vegetation.compile=()=>viewer.compile();vegetation.onTransformChange=()=>viewer.invalidateVisibility();viewer.meshRenderer.vegetationSystems.add(vegetation);
    }else if(vegetationRows.length){
      if(parsed.animations.length)throw Error('Static vegetation LOD assets cannot carry animation clips');
      vegetation=await new VegetationSystem(viewer.meshRenderer,parsed.json.extras?.vegetation_runtime??{}).init();
      const prototypes=new Map();
      for(const row of vegetationRows){const key=row.nodeIndex+':'+row.merge.mirrored;if(!prototypes.has(key))prototypes.set(key,[]);prototypes.get(key).push(row);}
      for(const rows of prototypes.values()){
        const row=rows[0],original=row.mesh,indices=original.userData.aps_vegetation_lods;
        if(indices.length!==3||indices[0]!==row.meshIndex)throw Error('Invalid vegetation mesh LOD references');
        for(const part of rows){
          if(part.mesh.count!==original.count||part.mesh.parent!==original.parent||part.mesh.instanceMatrix.array.some((v,i)=>v!==original.instanceMatrix.array[i]))throw Error('Vegetation facesets must share exact native instance transforms');
          if(JSON.stringify(part.mesh.userData.aps_vegetation_lods)!==JSON.stringify(indices))throw Error('Vegetation facesets must share LOD identity');
        }
        const nativeParts=indices.map(index=>{
          if(parsed.meshes[index]?.length!==rows.length)throw Error('LOD faceset count differs from prototype');
          const parts=rows.map(part=>{const primitive=parsed.meshes[index]?.[part.primitiveIndex];if(!primitive||primitive.material!==part.materialIndex||primitive.targets.length)throw Error('LOD must preserve faceset material identity');const built=primitiveGeometry(primitive);resources.geometries.add(built.geometry);return built.geometry;});
          return parts;
        });
        const fullBounds=new Box3().makeEmpty();for(const g of nativeParts.flat()){g.computeBoundingBox();fullBounds.union(g.boundingBox);}
        const prototypeRows=rows,prototypeParent=original.parent;
        let partitionIndex=0;
                                                                           
                                                                           
        const bindingBudget=vegetationBindingBudget(prototypeRows,GPU.limits,[viewer.heightfield?.terrainModule,viewer.heightfield?.groundcover?.module].filter(Boolean),viewer.meshRenderer.adaptMaterialModules);
        for(const rows of partitionVegetationFacesets(prototypeRows,bindingBudget)){
        const lods=nativeParts.map(parts=>{const selected=rows.map(r=>parts[prototypeRows.indexOf(r)]);const merged=concatenateVegetation(selected,{facesets:true}).geometry;resources.geometries.add(merged);return merged;});
        const material=createVegetationMaterial(rows.map(r=>r.mesh.material));resources.materials.add(material);
        material.name=original.name+' ['+new URL(absolute).pathname.split('/').pop()+'] part '+partitionIndex;
        material.userData.aps_binding_budget=bindingBudget;material.userData.aps_binding_origin=absolute;
        const source=new InstancedMesh(lods[0],material,original.count);source.name=original.name+' prototype part '+partitionIndex++;source.userData={...original.userData,aps_facesets:rows.map(r=>r.materialIndex),aps_binding_budget:bindingBudget};
        source.instanceMatrix.array.set(original.instanceMatrix.array);source.instanceMatrix.needsUpdate=true;
        source.castShadow=original.castShadow;source.receiveShadow=original.receiveShadow;source.layers.set(LAYERS.OPAQUE);
        prototypeParent.add(source);resources.meshes.add(source);
        vegetation.register(source,lods,{localBounds:fullBounds,margin:original.userData.aps_vegetation_margin_m??0,thresholds:original.userData.aps_vegetation_lod_pixels??[200,55]});
        for(const part of rows){part.mesh.removeFromParent();part.vegetationPrototype=source;}
        }
      }
      vegetation.compile=()=>viewer.compile();vegetation.onTransformChange=()=>viewer.invalidateVisibility();viewer.meshRenderer.vegetationSystems.add(vegetation);
    }
    const active=[];root.traverse(m=>{if(m.isMesh)active.push(m);});stats.draws=active.length;stats.instance_draws=active.filter(m=>m.isInstancedMesh).length;
    let nativeStaticMeshes=0;for(const mesh of active)if(markNativeStaticGeometry(mesh))nativeStaticMeshes++;
    stats.primitive_occurrences=stats.instances;stats.logical_instances=batching.merged?.logical_instances??0;
    stats.source_primitive_rows=readback.length;stats.merged_draw_groups=batching.merged?.draw_groups??0;stats.merged_triangles=batching.merged?.triangles??0;
    stats.native_static_depth_meshes=nativeStaticMeshes;
    const inventory=batching.triangles?{source_primitive_rows:readback.length,source_primitive_occurrences:stats.instances,source_triangles:batching.triangles.source,
      logical_instances:batching.merged.logical_instances,merged_prototypes:batching.model_merge.merged_prototypes,merged_draw_groups:batching.merged.draw_groups,
      merged_materials:batching.merged.materials,merged_primitive_occurrences:batching.merged.primitive_occurrences,merged_triangles:batching.triangles.merged,
      fallback_primitive_occurrences:batching.model_merge.fallback_primitive_occurrences,fallback_triangles:batching.triangles.fallback_triangles,
      legacy_batched_occurrences:batching.legacy.occurrences,legacy_batched_triangles:batching.legacy.triangles,
      retained_fallback_triangles:batching.triangles.retained_fallback,detached_empty_groups:batching.detach.detached,active_draws:stats.draws,
      fallback_reasons:batching.model_merge.fallback_reasons,triangles_reconciled:batching.triangles.reconciled,
      part_reconciled:batching.merged.primitive_occurrences+batching.model_merge.fallback_primitive_occurrences===stats.instances}:null;
    if(inventory&&!inventory.part_reconciled)throw Error('Static instancing lost native primitive occurrences');
    viewer.meshRenderer?.prepareImportedRoot?.(root,{cameras:viewer.camera?[viewer.camera]:[]});
    const hashes={source:await sha256(sourceBuffer),bin:sourceBin?await sha256(sourceBin):null,runtime:plantLOD.report.derived_sha256??await sha256(buffer)};check(viewer,signal,id);
    let disposed=false;
    const api={root,vegetation,prepareGPU(){if(disposed)throw Error('Disposed mesh asset');for(const texture of resources.textures)texture.getGPU();for(const buffer of resources.buffers)buffer.getGPU();},sceneData:parsed.json,native:{buffer:sourceBuffer,json:sourceGLB.json,bin:sourceBin,sha256:hashes.source,binSHA256:hashes.bin,normal_import:imported.metadata,runtime:{buffer,json:parsed.json,bin:parsed.nativeBin,sha256:hashes.runtime},readback,provenance,materialPalette:root.userData.aps_material_palette,detached_groups:detachedGroups},update(){},metadata(){return {adapter:'aps-native-webgpu/1',vegetation:vegetation?.metadata()??null,plant_lod:plantLOD.report,runtime_sha256:hashes.runtime,normal_import:imported.metadata,url:absolute,sha256:hashes.source,bin_sha256:hashes.bin,...stats,geometry_definitions:geometryCache.size,materials:resources.materials.size,textures:resources.textures.size,texture_arrays:bank.metadata(),texture_layers:(bank.metadata().counts.array_layers??0)+(bank.metadata().counts.textures_2d??0),material_ids:[...new Set(ids.values())],entities:readback.map(r=>({node:r.nodeIndex,primitive:r.primitiveIndex,entity_id:r.entity_id,instance_entity_ids:r.mesh.userData.instance_entity_ids,instances:r.mesh.count,source_instance_indices:r.sourceInstanceIndices,batched:!!r.batchMesh,batch_instance_indices:r.batchInstances??null,merged:!!r.mergedMesh,merged_instance_indices:r.mergedInstances??null,material_id:r.merge?.materialId??null,triangles:r.triangles??0})),inventory,dfg:viewer.principledDFGModule?'provided-module':'preintegrated-64x64-512-samples',static_batching:batching,draw_resources:root.userData.apsDrawResources,animation_clips:parsed.animations.length,animation_playback:false,image_verification:false};},dispose(){if(disposed)return;viewer.meshRenderer?.forgetImportedRoot?.(root);api.groundcover?.detach(api);disposed=true;viewer.meshRenderer?.nativeCasterBounds?.delete(root);if(vegetation){viewer.meshRenderer.vegetationSystems.delete(vegetation);vegetation.dispose();}root.removeFromParent();disposeResources(resources);}};
    api.sourceUrl=absolute;root.userData.webgpuMesh=api.metadata();if(initiallyHidden)root.visible=false;viewer.scene.add(root);
    const casterBox=instanceAwareBounds(root);viewer.meshRenderer?.nativeCasterBounds?.set(root,{min:casterBox.min.toArray(),max:casterBox.max.toArray()});
    return api;
  } catch(error) {if(root)viewer.meshRenderer?.forgetImportedRoot?.(root);if(vegetation){viewer.meshRenderer.vegetationSystems.delete(vegetation);vegetation.dispose();}root?.removeFromParent();disposeResources(resources);throw error;}
}




