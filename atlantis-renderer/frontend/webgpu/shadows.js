import {NON_CASCADED_SHADOW_SIZE} from './shadow_resolution.js';
import {SunShadows} from '../../vendor/tidewater/src/engine/render/Shadows.js';
import {Vector4} from '../../vendor/tidewater/src/engine/math/index.js';
import {fitShadowClipmaps,clipmapShadowCode} from './shadow_clipmap.js';
import {Texture} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {GPU} from '../../vendor/tidewater/src/engine/gpu/GPU.js';
import {setShadowMap,ShadowUniforms,shadowModule} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {setFrameCamera} from '../../vendor/tidewater/src/engine/render/Frame.js';
import {vegetationShadowBudget} from './vegetation_shadow_budget.js';
import {ShadowStateCache,shadowCacheQualityKey,shadowStateSignature,casterSourceDigest} from './shadow_state_cache.js';
import {boxIntersectsClip} from './point_light_math.js';
export {terrainCasterBounds} from './terrain_coordinates.js';

shadowModule.code=clipmapShadowCode(shadowModule.code);

                                                                             
                                                                              
                                                                               
                                                                   
export class WebGPUSunShadows extends SunShadows {
  constructor(options={}){
    const guard=options.cacheGuardFraction??.25;
    if(!Number.isFinite(guard)||guard<0||guard>.5)throw RangeError('Shadow cache guard must be in [0, .5]');
    super(options.splits?.length === 1 ? {...options, size: NON_CASCADED_SHADOW_SIZE} : options);
    this.vegetationBudget=vegetationShadowBudget(options.vegetationBudget);this.cacheGuardFraction=guard;this.neutral=new Texture({label:'caster neutral receiver depth',width:1,height:1,depth:4,dimension:'2d-array',format:'depth32float',usage:['sample','render']});
                                                                             
                                                                        
    this.texture.usageList.push('copySrc','copyDst');
                                                                               
                                                                     
    this.stateCache=null;this.pendingRestore=null;this.pendingCapture=null;this.lastStateCache=null;this.disposed=false;
                                                                            
                                                                       
    this.receiverIntegration=null;this.receiverActive=false;this.receiverPixelMode=false;this.receiverPixelKey=null;this._lastReceiverPixelKey=null;
    this._receiverTerrainCompacted=false;
                                                                                 
                                                                         
                                                                            
                             
    this.globalHiZ=null;this.lastGlobalHiZ=null;
    for(let i=0;i<4;i++){const p=GPU.getEncoder().beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:this.neutral.view({dimension:'2d',baseArrayLayer:i,arrayLayerCount:1}),depthLoadOp:'clear',depthStoreOp:'store',depthClearValue:1}});p.end();}
  }
  ensureStateCache(){
    if(this.disposed)throw Error('Shadow cache has been disposed');
    if(this.stateCache&&this.stateCache.size!==this.size){this.stateCache.dispose();this.stateCache=null;}
    if(!this.stateCache)this.stateCache=new ShadowStateCache({size:this.size,layers:this.count,states:['before','after'],
      textureFactory:({size,layers})=>new Texture({label:'bounded before/after solar depth cache',width:size,height:size,depth:layers,dimension:'2d-array',format:'depth32float',usage:['copySrc','copyDst']})});
    return this.stateCache;
  }
                                                                               
  requestState(state){
    if(!['before','after'].includes(state))throw Error('Shadow cache state must be before or after');
    if(this.disposed)return false;
    this.ensureStateCache();this.pendingRestore=state;this.pendingCapture=null;return true;
  }
  invalidateStateCache(reason='external'){
    this.pendingRestore=null;this.pendingCapture=null;
    const changed=this.stateCache?.invalidate(null,reason)??false;
    if(changed||reason==='disposed')this.lastStateCache={result:'invalidated',reason,frame:this.frame};
    return changed;
  }
  stateCacheMetadata(){return this.stateCache?.metadata()??null;}
  invalidateObjects(boxes){
    this.invalidateStateCache('object-motion');
    for(const cascade of this.cascades)if(!cascade.viewProj||boxes.some(box=>boxIntersectsClip(box,cascade.viewProj)))cascade.dirty=true;
  }
  _cacheSignature(state,{scene,viewer,bounds,domainKey,fits,sunDir}){
    if(!scene)return null;
    const digest=casterSourceDigest(scene,{layerMask:this.layerMask});
    const intervention=viewer?.terrainIntervention??null;
    const interventionKey=intervention?JSON.stringify([intervention.manifestSha256??intervention.metadata?.().manifest_sha256??null,intervention.native?.sha256??null]):null;
    const qualityKey=shadowCacheQualityKey({size:this.size,count:this.count,splits:this.splits,lightMargin:this.lightMargin,
      normalBias:this.normalBias,vegetationBudget:this.vegetationBudget,cacheGuardFraction:this.cacheGuardFraction,
      grassDensityRetention:viewer?.grassDensityRetention??null,vegetationLOD:viewer?.vegetationLOD??null,
      shadowDistance:viewer?.options?.shadowDistance??null,shadowMapSize:viewer?.options?.shadowMapSize??null,enabled:this.enabled,
      groundcover:viewer?.heightfield?.groundcover?.metadata?.()??null});
    const externalRevision=viewer?.shadowCacheRevision??0;
    const signature=shadowStateSignature({state,qualityKey,domainKey,fits,light:sunDir.toArray(),mainEye:this.mainEye,
      externalRevision,casterKey:digest.key,interventionKey});
    return {signature,digest,qualityKey,interventionKey,externalRevision};
  }
  _copyLayer(source,sourceLayer,target,targetLayer){
    GPU.getEncoder().copyTextureToTexture(
      {texture:source.getGPU(),origin:{x:0,y:0,z:sourceLayer},aspect:'depth-only'},
      {texture:target.getGPU(),origin:{x:0,y:0,z:targetLayer},aspect:'depth-only'},
      {width:this.size,height:this.size,depthOrArrayLayers:1});
  }
  _captureAfterRender(state,signature,indices){
    const cache=this.stateCache;
    if(!cache||!signature||indices.length!==this.count)return false;
    cache.ensureTexture();
    const U=ShadowUniforms.fields;
    const payload={cascades:this.cascades.map((c,i)=>({clipKey:c.clipKey,projectionKey:c.projectionKey,radius:c.radius,
      lightCenter:[...c.lightCenter],near:c.camera.near,far:c.camera.far,viewProj:c.viewProj.clone(),
      matrix:U.matrices.value[i].clone(),cascade:U.cascades.value[i].clone(),blend:U.blend.value[i].clone()}))};
                                                                               
                                                                        
    for(let i=0;i<this.count;i++){this._copyLayer(this.texture,i,cache.texture,cache.layerFor(state,i));cache.stats.copies++;}
    cache.record(state,{signature,payload});
    this.lastStateCache={result:'captured',state,frame:this.frame,copies:this.count};
    return true;
  }
  update(camera,sunDir,casters=null,revision=0,dynamic=false,context=null){
    this.frame++;const U=ShadowUniforms.fields;U.enabled.value=Number(this.enabled&&sunDir.y>-.05);
    if(!this.enabled)return [];
    camera.updateMatrixWorld();
    this.mainEye=camera.position.toArray();
    const bounds=casters??{min:[-10,-1,-10],max:[10,10,10]};
    const fits=fitShadowClipmaps(bounds,camera.position.toArray(),sunDir.toArray(),this.size,this.count),out=[],reused=[];
    const domainKey=JSON.stringify([bounds.min,bounds.max]),guard=this.cacheGuardFraction??.25;
    const budgetKey=JSON.stringify(this.vegetationBudget);
                                                                              
                                                                            
                                                                               
                                                                
    const receiverActive=this.receiverActive===true&&!!this.receiverIntegration;
    const receiverPixel=receiverActive&&this.receiverPixelMode===true;
    if(receiverActive)this._receiverTerrainCompacted=true;
    const pixelChanged=receiverPixel&&this.receiverPixelKey!==this._lastReceiverPixelKey;
    if(receiverActive&&pixelChanged){for(const c of this.cascades)c.dirty=true;}
    const state=receiverActive?null:this.pendingRestore;
                                                                            
                                                                              
                                                
    const desiredState=state??this.pendingCapture?.state??null;
    let signature=null,cacheInfo=null;
    if(desiredState&&context&&!dynamic&&!receiverActive){
      cacheInfo=this._cacheSignature(desiredState,{...context,bounds,domainKey,fits,sunDir});
      if(cacheInfo?.digest.dynamic){
        dynamic=true;this.pendingCapture=null;
        this.lastStateCache={result:'fallback',state:desiredState,frame:this.frame,reason:'dynamic-caster',caster_digest:cacheInfo.digest.key};
      }else if(cacheInfo){
        signature=cacheInfo.signature;
        if(state){
          const cache=this.ensureStateCache();
          const entry=cache.lookup(state,signature);
          if(entry){
            const payload=entry.payload;
            for(let i=0;i<this.count;i++){
              const c=this.cascades[i],saved=payload.cascades[i];
              c.clipKey=saved.clipKey;c.projectionKey=saved.projectionKey;c.radius=saved.radius;c.lightCenter=[...saved.lightCenter];c.dirty=false;
              c.camera.near=saved.near;c.camera.far=saved.far;c.viewProj.copy(saved.viewProj);
              U.matrices.value[i]=saved.matrix.clone();U.cascades.value[i]=saved.cascade.clone();U.blend.value[i]=saved.blend.clone();
              this._copyLayer(cache.texture,cache.layerFor(state,i),this.texture,i);cache.stats.copies++;
            }
            this.budgetKey=budgetKey;this.sceneRevision=revision;this.casterDomainKey=domainKey;this.casterBounds=bounds;
            this.lastUpdated=[];this.lastReused=[...Array(this.count).keys()];
            this.pendingRestore=null;this.pendingCapture=null;cache.stats.restore_frames++;
            this.lastStateCache={result:'hit',state,frame:this.frame,copies:this.count,external_revision:cacheInfo.externalRevision,caster_digest:cacheInfo.digest.key};
            return [];
          }
          this.lastStateCache={result:'miss',state,frame:this.frame,reason:cache.lastReason,external_revision:cacheInfo.externalRevision,caster_digest:cacheInfo.digest.key};
        }
                                                                              
                                                                       
        this.pendingCapture={state:desiredState,signature};
      }
    }
    const stable=this.sceneRevision===revision&&this.casterDomainKey===domainKey&&this.budgetKey===budgetKey&&!dynamic&&!pixelChanged;
    for(let i=0;i<this.count;i++){
      const c=this.cascades[i],f=fits[i];
                                                                             
                                                                               
                                                                         
      const inGuard=!receiverPixel&&i<this.count-1&&c.projectionKey===f.projectionKey&&c.lightCenter&&
        Math.max(Math.abs(f.lightEye[0]-c.lightCenter[0]),Math.abs(f.lightEye[1]-c.lightCenter[1]))<=c.radius*guard;
      const grassMoved=c.grassEye&&this.vegetationBudget&&i<this.vegetationBudget.grassLevels&&Math.hypot(...this.mainEye.map((v,k)=>v-c.grassEye[k]))>this.vegetationBudget.grassRefresh;
      if(!c.dirty&&!grassMoved&&stable&&(c.clipKey===f.key||inGuard)){reused.push(i);continue;}
      Object.assign(c.camera,{near:f.near,far:f.far});c.camera.matrixWorld.copy(f.world);c.camera.matrixWorldInverse.copy(f.view);c.camera.projectionMatrix.copy(f.projection);
      c.radius=f.radius;c.viewProj.copy(f.viewProj);c.clipKey=f.key;c.projectionKey=f.projectionKey;c.lightCenter=f.lightCenter;c.dirty=false;
      U.matrices.value[i]=f.viewProj.clone();U.cascades.value[i]=new Vector4(f.radius*2,f.texel,Math.max(.002,f.texel*.1),f.far-f.near);
      U.blend.value[i]=new Vector4(0,f.radius*2,0,f.radius*.3);out.push(i);
    }
    this.budgetKey=budgetKey;this.sceneRevision=revision;this.casterDomainKey=domainKey;this.casterBounds=bounds;this.lastUpdated=out;this.lastReused=reused;
    this.lastReceiverPixelChanged=pixelChanged;this._lastReceiverPixelKey=this.receiverPixelKey;
    this.lastReceiverPolicy={active:receiverActive,mode:this.receiverPixelMode?'pixel':'other',pixel_changed:pixelChanged,state_cache:receiverActive?'disabled-for-receiver-mode':'legacy'};
    if(this.pendingCapture&&out.length!==this.count){
      this.lastStateCache={...this.lastStateCache,result:'fallback',state:this.pendingCapture.state,reason:'partial-redraw'};
      this.pendingCapture=null;
    }
    this.pendingRestore=null;
    return out;
  }
  metadata(){return {vegetation_budget:this.vegetationBudget,method:'world-space shadow clipmaps + receiver-plane PCSS/PCF',count:this.count,size:this.size,global_level:this.count-1,full_map_bounds:this.casterBounds,radii_m:this.cascades.map(c=>c.radius),texels_m:this.cascades.map(c=>2*c.radius/this.size),last_updated_levels:this.lastUpdated,last_reused_levels:this.lastReused,cache_guard_fraction:this.cacheGuardFraction??.25,cache_policy:'reuse original projection and depth inside guard; light/caster/domain/dirty changes invalidate; receiver pixel mode forbids guard reuse and the before/after state cache',receiver_policy:this.lastReceiverPolicy??null,rotation_independent:true,distance_fade:false,virtual_pages:false,caster_geometry:'independent native DEM triangles',receiver_normal:'continuous DEM normal for offset; exact native triangle plane for depth gradient',receiver_bias:'per sample receiver plane; max(standard depth bias, 5mm + 0.1 texel ray offset), 0.1 texel normal offset',raster_slope_bias:0,filter_seed:'world position',first_use_depth_draw:'pipeline ready before caching',state_cache:this.lastStateCache,state_cache_texture:this.stateCacheMetadata()};}
  render(scene,meshRenderer,indices,terrain=null){
    const terrains=[...new Set((Array.isArray(terrain)?terrain:[terrain]).filter(Boolean))];
    const multi=terrains.length>1,primary=terrains[0]??null;
    if(!multi&&this.receiverIntegration?.activeFrame===true)return this.receiverIntegration.renderShadows(scene,meshRenderer,indices,primary,this);
    if(!multi&&this.globalHiZ?.requested&&!this.receiverActive){
      let fallback=indices;
      try{
        const result=this.globalHiZ.render(scene,meshRenderer,indices,primary,this);
        if(result?.rendered){this.lastGlobalHiZ=result;return;}
        if(Array.isArray(result?.fallbackIndices))fallback=[...new Set(result.fallbackIndices)].sort((a,b)=>a-b);
      }catch(error){
                                                                             
                                                                              
                                                                           
        this.globalHiZ.invalidate?.('render-escape');
        const touched=(this.globalHiZ.lastBatch?.levels??[]).map(entry=>entry.level);
        fallback=[...new Set([...(Array.isArray(indices)?indices:[]),...touched])].sort((a,b)=>a-b);
        this.globalHiZ.lastError={stage:'render-escape',message:String(error?.message??error),frame:this.frame};
      }
      indices=fallback;
    }
    setShadowMap(this.neutral);const sync=meshRenderer.syncPipelines;meshRenderer.syncPipelines=true;
    try{for(const i of indices){
      const c=this.cascades[i];
                                                                               
                                                                               
                                                                              
                                                                       
      const terrainCascade=this._receiverTerrainCompacted?{...c,clipKey:null}:c;
      const restores=[],groundcoverShadows=new Map();let groundcoverShadow=null;
      try{
        for(const source of terrains){
          const restore=source.beginShadowCascade?.(i,terrainCascade);if(restore)restores.push(restore);
          const cover=source.groundcover,captured=cover?.captureShadow(i,this.vegetationBudget);
          if(captured){groundcoverShadows.set(cover,captured);groundcoverShadow??=captured;}
        }
        setFrameCamera(c.camera,this.size,this.size,{block:c.block});
        meshRenderer.render(scene,{label:'native solar clipmap '+i,kind:'depth',camera:c.camera,frameBlock:c.block,
          depthView:this.texture.view({dimension:'2d',baseArrayLayer:i,arrayLayerCount:1}),depthFormat:'depth32float',
          clearDepth:1,depthCompare:'less-equal',layerMask:this.layerMask,depthBias:2,depthBiasSlopeScale:0,groundcoverShadow,groundcoverShadows,vegetationShadowBudget:this.vegetationBudget,vegetationShadowEye:this.mainEye,vegetationShadowLevel:i,apsShadowUnified:true});
        const hasGrass=groundcoverShadow||[...meshRenderer.vegetationSystems].some(s=>s.isGrass);
        c.grassEye=hasGrass&&this.mainEye?this.mainEye.slice():null;
      }catch(error){c.dirty=true;throw error;}finally{if(meshRenderer.precompiling)c.dirty=true;const errors=[];for(const restore of restores.reverse())try{restore();}catch(error){errors.push(error);}if(errors.length){c.dirty=true;throw new AggregateError(errors,'Terrain shadow restoration failed');}}
    }
    if(terrains.length&&indices.length)this._receiverTerrainCompacted=false;
                                                                             
                                                                             
                                   
    if(this.pendingCapture&&!meshRenderer.precompiling&&this.stateCache){
      const {state,signature}=this.pendingCapture;
      if(this._captureAfterRender(state,signature,indices))this.pendingCapture=null;
    }
    }finally{meshRenderer.syncPipelines=sync;setShadowMap(this.texture);}
  }
  dispose(){this.disposed=true;this.pendingRestore=null;this.pendingCapture=null;this.receiverIntegration=null;this.globalHiZ=null;this.lastGlobalHiZ=null;this.stateCache?.dispose();this.stateCache=null;this.neutral.destroy();this.texture.destroy();for(const c of this.cascades)c.block.buffer?.destroy();}
}

