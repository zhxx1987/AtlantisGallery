import {Scene,PerspectiveCamera,Vector3,Matrix4,Box3,Color,Mesh,Float32BufferAttribute,BufferGeometry,Uint32BufferAttribute} from '../../vendor/tidewater/src/engine/index.js';
import {SRGBColorSpace} from '../../vendor/tidewater/src/engine/constants.js';
import {GPU,FrameUniforms,G,setFrameCamera,SceneRenderer,LAYERS,Material,Texture,readTexture} from '../../vendor/tidewater/src/engine/webgpu.js';
import {WebGPUSunShadows as SunShadows,terrainCasterBounds} from './shadows.js?release=2k-shadows';
import {PixelNavigation} from './navigation.js';
import {InteractiveFrameLoop} from './interactive_frame_loop.js';
import {OutdoorLighting} from './lighting.js?release=2k-shadows';
import {PhysicalCamera} from './post.js';
import {loadHeightfield} from './heightfield.js';
import {Ocean} from './ocean.js';
import {loadMesh} from './mesh_adapter.js';
import {loadSceneDocument} from './scene_document.js';
import {attachReflectingPool} from './reflecting_pool.js';
import {configureSceneOverlay,sceneOverlayMetadata,setSceneOverlayVisible} from './scene_overlays.js';
import {GeometryMeshRenderer} from './geometry_mesh_renderer.js';
import {validateVegetationLOD} from './vegetation_lod_mode.js';
import {watchDevice,isGPUUnavailable} from './device_health.js';
import {ScreenGrass} from './grass_screen.js';
import {configureGrassPopulation} from './grass_population.js';
import {loadGrassImpostor} from './grass_impostor.js';
import {isNativeGrassPatch} from './grass_patch_geometry.js';
import {DEFAULT_GRASS_RETENTION,validateGrassRetention,grassDensityUniforms} from './grass_density.js';
import {composeWaterBinding} from './water_consumers.js';
import {TerrainOcclusion} from './terrain_occlusion.js';
import {instanceAwareBounds} from './scene_bounds.js';
import {shadowCasterPolicy} from './shadow_policy.js';
import {installShadowUnified,uninstallShadowUnified} from './shadow_caster_unified.js';
import {ReceiverShadowIntegration} from './receiver_shadow_integration.js';
import {ShadowGlobalHiZ} from './shadow_global_hiz.js?solar-repair=3';
import {PointLightShadows} from './point_light_shadows.js?release=2k-shadows';
import {PlanarMirrors} from './planar_mirrors.js?interaction-repair=1';
import {normalizeRenderScale,renderResolution} from './render_resolution.js';
import {createAssetRegistry,registerAsset,assetRecord,assetState,assetStates,setAssetVisible,showOnlyAsset,visibleAssetIds as visibleAssetRegistryIds} from './asset_visibility.js';
import {createPoseRegistry,applyAssetPose,assetPose} from './asset_pose.js';
import {clearTaskTerrains,syncTaskTerrains} from './task_terrain_runtime.js';
import {terrainWaterExclusion} from './lake_exclusion.js';

export class Viewer {
  constructor(container,onSelect=()=>{},options={}){
    this.container=container;this.options=options;this.onSelect=onSelect;this.disposed=false;this.loadId=0;this.oceanLoadId=0;this.cameraRevision=0;this.sceneTransaction=Promise.resolve();this.sceneEpoch=0;this.errors=[];this.frameTimings=[];this.time=0;this.frame=0;this.paused=false;this.loading=0;this.components=new Set();this.retainedAssets=new Set();this.pipelineHandles=[];
    this.vegetationLOD='auto';this.grassDensityRetention=validateGrassRetention(options.grassDensityRetention??DEFAULT_GRASS_RETENTION);this.meshCompanions=new Set();this.inlandOptics=null;
                                                                                
                                                                      
    this.assetRoots=createAssetRegistry();
                                                                          
    this.poseModels=createPoseRegistry();
                                                                           
                                                                              
    this.shadowCacheRevision=0;this.shadowCacheHold=false;this.interventionToggle=null;
    this.renderScale=normalizeRenderScale(options.renderScale??1);
    this.canvas=document.createElement('canvas');this.canvas.tabIndex=0;this.canvas.setAttribute('aria-label','3D viewport. Left-drag to orbit, right-drag to pan, and scroll to zoom.');this.canvas.style.touchAction='none';container.prepend(this.canvas);
    this.presentation=options.presentation===true;this.scene=new Scene();this.camera=new PerspectiveCamera(this.presentation?36:42,1,.01,10000);this.camera.position.set(5,4,6);this.navigation=new PixelNavigation(this);this.controls=this.navigation;this.controls.target.set(0,0,0);this.controls.update();
    this.renderer={domElement:this.canvas,backend:'webgpu',toneMappingExposure:1,capabilities:{},info:{render:{},programs:[]},debug:{},getContext:()=>GPU.context,setSize:(w,h)=>this.resize(w,h),setPixelRatio:r=>{this.pixelRatio=r;this.resize();}};
    this.ready=this.init();this.ready.catch(e=>this.reportError(e));
  }
  reportError(error){
    const message=error?.message||String(error);if(!this.errors.includes(message))this.errors.push(message);this.canvas.dataset.errors=JSON.stringify(this.errors);
    if(isGPUUnavailable(error)){
      this.deviceFailure=error;this.compiled=false;this.frameLoop?.stop();
      if(!this.recoveryPanel){
        const panel=document.createElement('div');panel.setAttribute('role','alert');panel.style.cssText='position:fixed;z-index:10000;left:20px;right:20px;top:120px;padding:16px;background:#291d20;color:#fff;border:1px solid #d99;border-radius:8px';
        const text=document.createElement('p');text.textContent='The WebGPU device is unavailable. Reload the page to restart the 3D viewer.';
        const button=document.createElement('button');button.textContent='Reload Page';button.onclick=()=>location.reload();panel.append(text,button);this.container.append(panel);this.recoveryPanel=panel;
      }
    }
    this.onError?.(message);console.error(error);
  }
  async init(){
    if(this.options.outdoor===false)throw Error('outdoor:false requires the accepted hemisphere/key/fill light transport; native multi-light parity is not implemented');
    await GPU.init({canvas:this.canvas,requiredLimits:{maxSampledTexturesPerShaderStage:48,maxTextureArrayLayers:2048,maxStorageBuffersPerShaderStage:16}});
    // Optional ocean resources have their own limit check in Ocean.init().
    // Ordinary model viewing must not require the ocean's storage-buffer budget.
    this.deviceHealth=watchDevice(GPU.device,()=>GPU.device,error=>{if(!this.disposed)this.reportError(error);});
    if(this.disposed)return this;this.originalAsync=GPU._async;this.pipelineHandleSet=new Set();this.asyncHook=(desc,kind)=>{const h=this.originalAsync.call(GPU,desc,kind);if(!this.disposed&&!this.pipelineHandleSet.has(h)){this.pipelineHandleSet.add(h);this.pipelineHandles.push(h);}return h;};GPU._async=this.asyncHook;
    this.gpuError=e=>{if(!this.disposed)this.reportError(e.error);};GPU.device.addEventListener('uncapturederror',this.gpuError);
    this.renderer.capabilities.maxTextureSize=GPU.limits.maxTextureDimension2D;this.meshRenderer=new GeometryMeshRenderer();this.meshRenderer.syncPipelines=false;
    this.staticOcclusion=new TerrainOcclusion(this);
    this.sceneRenderer=new SceneRenderer(this.meshRenderer,this.scene,this.camera);
    const single=this.options.singleShadow===true;
    this.shadows=new SunShadows({size:this.options.shadowMapSize??2048,splits:single?[100]:[80,400,1600,this.options.shadowDistance??8000],lightMargin:1000,normalBias:single?[.0015]:[.04,.1,.35,1],pcssCascades:1});this.shadows.layerMask=1<<LAYERS.OPAQUE;
                                                                                 
                                                                                 
    this.receiverShadows=new ReceiverShadowIntegration(this,this.options);
                                                                              
                                                                              
                                                                           
                                                               
    this.shadowGlobalHiZ=new ShadowGlobalHiZ(this,this.options);this.shadows.globalHiZ=this.shadowGlobalHiZ;
                                                                                  
                                                                                
                                                                               
                                                       
    this.shadowUnified=null;this.shadowCasterBatchingError=null;
    if(this.options.shadowCasterBatching!==false){
      try{this.shadowUnified=installShadowUnified(this);}
      catch(error){this.shadowCasterBatchingError={stage:'install',message:String(error?.message??error)};console.error('Shadow caster batching install failed; native solar shadows keep the original collect path',error);}
    }
    this.lighting=new OutdoorLighting(this);await this.lighting.init();if(this.disposed){this.lighting.dispose();return this;}this.pointShadows=new PointLightShadows(this,{memoryMB:this.options.pointShadowMemoryMB});this.planarMirrors=new PlanarMirrors(this,{resolutionScale:this.options.mirrorResolutionScale??.5,maxSize:this.options.mirrorMaxSize??1024});this.renderPipeline=new PhysicalCamera(this,this.lighting);await this.renderPipeline.init?.();if(this.disposed){this.renderPipeline.dispose();return this;}await this.navigation.picker.init();if(this.disposed)return this;this.camera.fov=this.presentation?36:42;this.camera.updateProjectionMatrix();this.syncLens();this.createGrid();
    this.basePixelRatio=Math.min(globalThis.devicePixelRatio||1,2);this.pixelRatio=this.basePixelRatio;this.resize();this.resizeFrame=null;this.observer=new ResizeObserver(()=>{if(this.resizeFrame!==null)return;this.resizeFrame=requestAnimationFrame(()=>{this.resizeFrame=null;if(!this.disposed)this.resize();});});this.observer.observe(this.container);await GPU.pipelinesReady();if(this.disposed){this.observer.disconnect();return this;}GPU.submit();this.lastTime=performance.now();this.start();return this;
  }
  setRenderScale(value){this.renderScale=normalizeRenderScale(value);this.resize();return this.renderScale;}
  resize(width,height){
    if(this.disposed||this.deviceFailure||!GPU.device||!this.sceneRenderer)return;const rect=this.container.getBoundingClientRect(),resolution=renderResolution(width??rect.width,height??rect.height,this.pixelRatio??1,this.renderScale,GPU.limits.maxTextureDimension2D);
    const {width:w,height:h,cssWidth,cssHeight}=resolution;this.renderResolution=resolution;
                                                                              
                                                                             
    this.canvas.style.width=cssWidth+'px';this.canvas.style.height=cssHeight+'px';
    if(w===this.canvas.width&&h===this.canvas.height)return;
    this.canvas.width=w;this.canvas.height=h;this.camera.aspect=w/h;this.camera.updateProjectionMatrix();this.cameraRevision++;this.sceneRenderer.setSize(w,h);const fov=this.camera.fov;this.renderPipeline?.setSize(w,h);this.camera.fov=fov;this.camera.updateProjectionMatrix();this.syncLens();this.depthSnapshot=null;this.opaqueSnapshot=null;FrameUniforms.fields.outputResolution.value.set(w,h);this.lighting?.resize?.(w,h);this.receiverShadows?.resize(w,h);
  }
  start(){
    if(this.frameLoop)return this.frameLoop.start();
    this.frameLoop=new InteractiveFrameLoop({queue:GPU.queue,active:()=>!this.disposed&&!this.deviceFailure&&!document.hidden&&(!this.loading||this.loadingPreview),
      flushInput:()=>this.navigation.flushInput(),
      reportError:e=>this.reportError(e),render:now=>{
        const interval=now-this.lastTime,dt=Math.min(.1,Math.max(0,interval/1000));
        this.frameTimings.push(interval);if(this.frameTimings.length>90)this.frameTimings.shift();this.lastTime=now;
        this.beforeRender?.(dt);this.renderFrame(dt);this.afterRender?.();
      }});
    return this.frameLoop.start();
  }
  renderFrame(dt=0){
    this.deviceHealth?.check();
    if(this.disposed||!this.renderPipeline)return;if(this.paused)dt=0;GPU.beginFrame();this.frame++;if(!this.paused)this.time+=dt;G.time.value=this.time;G.dt.value=dt;FrameUniforms.fields.frameIndex.value=0;
    this.receiverShadows?.markFrameStart?.();
    if(this.frameProfile){const pass=GPU.getEncoder().beginComputePass({label:'full frame GPU start',timestampWrites:{querySet:this.frameProfile,beginningOfPassWriteIndex:0,endOfPassWriteIndex:1}});pass.end();}
    this.controls.update();setFrameCamera(this.camera,this.canvas.width,this.canvas.height,{prevViewProj:this.prevViewProj,prevCameraPos:this.prevCameraPos});
    for(const system of this.meshRenderer.vegetationSystems){system.population?.update();system.updateTransforms();}
    const terrains=[...new Set([this.heightfield,...(this.taskHeightfields?.values?.()??[])])].filter(t=>{if(!t)return false;for(let p=t.root;p;p=p.parent)if(p.visible===false)return false;return true;});
    for(const terrain of terrains)terrain.update(this.camera);this.lighting.update(dt,this.time,this.camera);if(this.ocean)this.ocean.update(dt,this.ocean.time+(this.ocean.paused?0:dt),this.camera);for(const c of this.components)c.update?.(dt,this.time,this.camera);
    for(const system of this.meshRenderer.vegetationSystems)system.screenGrass?.prepare();
    const displacement=this.terrainIntervention?.manifest.maximum_displacement_m??0;
    const casters=this.heightfield?terrainCasterBounds(this.heightfield.sceneData,this.heightfield.root,displacement):this.root?instanceAwareBounds(this.root):null;
    let bounds=casters?(Array.isArray(casters.min)?casters:{min:casters.min.toArray(),max:casters.max.toArray()}):null;
    if(bounds&&!this.heightfield&&this.terrainIntervention){const d=displacement;bounds={min:bounds.min.map((v,i)=>i===1?v-d:v),max:bounds.max.map((v,i)=>i===1?v+d:v)};}
    for(const terrain of terrains)if(terrain!==this.heightfield){const b=terrainCasterBounds(terrain.sceneData,terrain.root,0);if(b)bounds=bounds?{min:bounds.min.map((x,i)=>Math.min(x,b.min[i])),max:bounds.max.map((x,i)=>Math.max(x,b.max[i]))}:b;}
    if(this.staticNativeCasterBounds){const b=this.staticNativeCasterBounds;bounds=bounds?{min:bounds.min.map((x,i)=>Math.min(x,b.min[i])),max:bounds.max.map((x,i)=>Math.max(x,b.max[i]))}:b;}
    for(const system of this.meshRenderer.vegetationSystems){const b=system.casterBounds();if(b)bounds=bounds?{min:bounds.min.map((x,i)=>Math.min(x,b.min[i])),max:bounds.max.map((x,i)=>Math.max(x,b.max[i]))}:b;}
    for(const [root,b] of this.meshRenderer.nativeCasterBounds)if(root.visible)bounds=bounds?{min:bounds.min.map((x,i)=>Math.min(x,b.min[i])),max:bounds.max.map((x,i)=>Math.max(x,b.max[i]))}:b;
    const shadowPolicy=shadowCasterPolicy(this);this.lastShadowPolicy=shadowPolicy;
                                                                               
                                                                          
                                                                             
                                                                                
                                                                         
    const multipleTerrains=terrains.length>1;
    if(this._multipleTerrainShadows!==multipleTerrains){this._multipleTerrainShadows=multipleTerrains;this.shadows.invalidateStateCache?.('terrain-count-change');this.shadowGlobalHiZ?.invalidate?.('terrain-count-change');for(const c of this.shadows.cascades)c.dirty=true;}
    if(multipleTerrains&&(this.shadows.pendingRestore||this.shadows.pendingCapture))this.shadows.invalidateStateCache?.('multiple-terrains');
    const receiverFrame=this.receiverShadows?.beginFrame(this,bounds,{multipleTerrains})??null;
    let indices;
    try{
      indices=this.shadows.update(this.camera,G.sunDir.value,bounds,this.shadowRevision??0,shadowPolicy.dynamic,{scene:this.scene,viewer:this});
      this.receiverShadows?.markStage?.('after_update');
      this.receiverShadows?.renderDemand(this,this.shadows,indices,receiverFrame);
      this.shadows.render(this.scene,this.meshRenderer,indices,terrains);
      this.receiverShadows?.markStage?.('after_shadows');
    }catch(error){
      if(receiverFrame?.active&&this.receiverShadows){
        this.receiverShadows.fail(error);
        for(const c of this.shadows.cascades)c.dirty=true;
        indices=this.shadows.update(this.camera,G.sunDir.value,bounds,this.shadowRevision??0,shadowPolicy.dynamic,{scene:this.scene,viewer:this});
        this.shadows.render(this.scene,this.meshRenderer,indices,terrains);
      }else throw error;
    }
    this.planarMirrors?.sync();
    this.pointShadows?.render();
    this.planarMirrors?.render();
    setFrameCamera(this.camera,this.canvas.width,this.canvas.height,{prevViewProj:this.prevViewProj,prevCameraPos:this.prevCameraPos});
    this.ocean?.prepareLighting();this.sceneRenderer.render();
                                                                             
                                                                                
                                                         
    this.opaqueSnapshot={frame:this.frame,width:this.sceneRenderer.width,height:this.sceneRenderer.height,inverse:FrameUniforms.fields.invViewProj.value.clone(),viewProjection:FrameUniforms.fields.viewProj.value.clone(),view:FrameUniforms.fields.view.value.clone()};
    this.renderPipeline.render();
    this.receiverShadows?.markFrameEnd?.();
    this.depthSnapshot={frame:this.frame,revision:this.cameraRevision,inverse:FrameUniforms.fields.invViewProj.value.clone(),eye:this.camera.position.clone(),target:this.controls.target.clone(),forward:this.camera.getWorldDirection(new Vector3())};
    this.prevViewProj=FrameUniforms.fields.viewProjNoJitter.value.clone();this.prevCameraPos=this.camera.position.clone();
    if(this.frameProfile){const pass=GPU.getEncoder().beginComputePass({label:'full frame GPU end',timestampWrites:{querySet:this.frameProfile,beginningOfPassWriteIndex:2,endOfPassWriteIndex:3}});pass.end();}
    GPU.submit();this.renderer.info.render=this.meshRenderer.stats;
  }
  invalidateScene(){this.depthSnapshot=null;this.opaqueSnapshot=null;this.selection=null;this.cameraRevision++;this.shadowRevision=(this.shadowRevision??0)+1;if(!this.shadowCacheHold)this.shadowCacheRevision=(this.shadowCacheRevision??0)+1;this.compiled=false;this.receiverShadows?.invalidate?.('scene');this.shadowGlobalHiZ?.invalidate?.('scene');}
  invalidateObjectTransforms(roots){
    for(const root of roots??[]){
      if(!this.meshRenderer?.nativeCasterBounds?.has(root))continue;
      const box=instanceAwareBounds(root);
      this.meshRenderer.nativeCasterBounds.set(root,{min:box.min.toArray(),max:box.max.toArray()});
    }
    if(this.receiverShadows?.enabled){this.invalidateScene();return;}
    const boxes=this.pointShadows?.invalidateObjects(roots);if(boxes==null){this.invalidateScene();return;}
    if(!boxes.length)return;
    this.depthSnapshot=null;this.opaqueSnapshot=null;this.selection=null;this.cameraRevision++;
    this.shadows?.invalidateObjects(boxes);this.shadowGlobalHiZ?.invalidate?.('object-motion');
    this.objectMotionUpdates=(this.objectMotionUpdates??0)+1;
  }
  invalidateVisibility(){const compiled=this.compiled;this.invalidateScene();this.compiled=compiled;}
  setPointLights(lights=[]){this.lighting.setLocalLights(lights);return this;}
  addPlanarMirror(object,options={}){return this.planarMirrors.mark(object,options);}
  removePlanarMirror(object){this.planarMirrors.unmark(object);}
  invalidatePointLightShadows(){this.shadowRevision=(this.shadowRevision??0)+1;this.pointShadows?.invalidate();}
  savePose(){return {position:this.camera.position.toArray(),target:this.controls.target.toArray(),fov:this.camera.fov,near:this.camera.near,far:this.camera.far,minDistance:this.controls.minDistance,maxDistance:this.controls.maxDistance,dimensions:this.dimensions,grid:this.grid?{position:this.grid.position.toArray(),scale:this.grid.scale.toArray()}:null};}
  queueScene(operation){const epoch=this.sceneEpoch;const result=this.sceneTransaction.catch(()=>{}).then(()=>{if(this.disposed||epoch!==this.sceneEpoch)throw Error('Scene transaction cancelled');return operation();});this.sceneTransaction=result;return result;}
  loadHeightfield(url,options={}){return this.queueScene(()=>{this.terrainIntervention?.dispose();return this.loadHeightfieldCandidate(url,options);});}
  load(url,signal,options={}){return this.queueScene(()=>{this.terrainIntervention?.dispose();return this.loadMeshCandidate(url,signal,options);});}
  setVegetationLOD(mode='auto'){
    validateVegetationLOD(mode);this.vegetationLOD=mode;
    for(const system of this.meshRenderer?.vegetationSystems??[]){system.lodMode=mode;system.options.lod=true;}
    this.invalidateVisibility();return mode;
  }
  setGrassDensity(retention=DEFAULT_GRASS_RETENTION){
    this.grassDensityRetention=validateGrassRetention(retention);
                                                                             
                                                                      
    if(this.shadows?.cascades?.[0])this.shadows.cascades[0].dirty=true;
    this.receiverShadows?.forceAllCascades?.('grass-density');
    return retention;
  }
  loadScene(url,options){const result=(this.sceneDocumentTransaction??Promise.resolve()).catch(()=>{}).then(()=>loadSceneDocument(this,url,options));this.sceneDocumentTransaction=result;return result;}
  loadVegetation(url,signal,options={}){return this.loadCompanion(url,signal,true,options);}
  addAsset(url,signal,options={}){return this.loadCompanion(url,signal,false,options);}
  sceneOverlayMetadata(){return sceneOverlayMetadata(this);}
  setSceneOverlayVisible(id,visible){return setSceneOverlayVisible(this,id,visible);}
  registerSceneAsset(id,api,{kind='glb',url=null,root=null,tagRoot=true}={}){
    if(typeof id!=='string'||!id.trim())return null;
    return registerAsset(this.assetRoots,id,{root,api,kind,url,tagRoot});
  }
  clearSceneAssets(){this.assetRoots.clear();this.poseModels.clear();}
  setAssetVisible(id,visible){const shown=setAssetVisible(this.assetRoots,id,visible);this.invalidateVisibility();return shown;}
  showOnlyAsset(id){const result=showOnlyAsset(this.assetRoots,id);if(result.ok)this.invalidateVisibility();return result;}
                                                                                
                                                                               
                                                                             
  applyAssetPose(id,joints){
    const result=applyAssetPose(this.poseModels,id,joints,key=>assetRecord(this.assetRoots,key));
    const root=assetRecord(this.assetRoots,typeof id==='string'?id.trim():id)?.root??null;
    if(root){root.updateMatrixWorld?.(true);this.invalidateObjectTransforms?.([root]);this.invalidateVisibility();}
    return result;
  }
  assetPose(id){return assetPose(this.poseModels,id,key=>assetRecord(this.assetRoots,key));}
  assetState(id){
    const row=assetState(this.assetRoots,id);
    if(!row)return null;
    const record=assetRecord(this.assetRoots,id),metadata=record?.api?.metadata?.()??{};
    return {...row,url:row.url??metadata.url??null,source_glb:metadata.url??null,sha256:metadata.sha256??null,triangles:metadata.triangles??null,materials:metadata.materials??null,instances:metadata.instances??null};
  }
  assetStates(){return assetStates(this.assetRoots).map(row=>this.assetState(row.id));}
                                                                            
                                                                             
  assetVisibility(){return assetStates(this.assetRoots);}
  visibleAssetIds(){return visibleAssetRegistryIds(this.assetRoots);}
  async inspectVegetation(){
    this.loading++;
    try{
      await GPU.queue.onSubmittedWorkDone();this.renderFrame(0);await GPU.queue.onSubmittedWorkDone();
      return {viewport:[this.canvas.width,this.canvas.height],grass_density_retention:this.grassDensityRetention,systems:await Promise.all([...this.meshRenderer.vegetationSystems].map(async s=>({metadata:s.metadata(),density:grassDensityUniforms(s),population:s.population?await s.population.audit():null,native:(await s.audit()).rows.map(({visible_ids,...r})=>r),far:s.screenGrass?await s.screenGrass.audit():null}))),shadow_budget:this.shadows.vegetationBudget};
    }finally{this.loading--;}
  }
  loadCompanion(url,signal,requireVegetation,options={}){return this.queueScene(async()=>{
    await this.ready;if(this.disposed)throw Error('Viewer has been disposed');this.loading++;
    const errorCount=this.errors.length,pipelineCount=this.pipelineHandles.length,compiled=this.compiled;let candidate;
    try{
      candidate=await loadMesh(this,url,signal,{grassPatch:options.grass===true,plant:requireVegetation,initiallyHidden:options.initiallyHidden===true});
      if(options.groundcoverSourceUrl)candidate.groundcoverSourceUrl=options.groundcoverSourceUrl;
      if(requireVegetation&&!candidate.vegetation)throw Error('Vegetation companion requires authored aps_vegetation_lods');
      const standalonePatch=options.independentModel&&isNativeGrassPatch(candidate.sceneData);
      const runtimeGrass=options.grass||!standalonePatch&&this.heightfield&&candidate.sceneData.extras?.planting?.grass_name;
      if(options.forbidSharedVegetation&&runtimeGrass)throw Error('Shared grass cannot be incrementally replaced');
                                                                            
                                                                           
      if(!runtimeGrass)candidate.vegetation?.setWaterExclusion?.(terrainWaterExclusion(this));
      if(runtimeGrass)await this.configureGrass(candidate,options.impostor,signal);
      if(options.overlay)configureSceneOverlay(this,candidate,options.overlay,LAYERS.TRANSPARENT);
      else if(!standalonePatch)this.heightfield?.groundcover?.attach(candidate);
      if(options.forbidSharedVegetation&&candidate.groundcover){candidate.groundcover.detach(candidate);throw Error('Shared groundcover cannot be incrementally replaced');}
      if(candidate.vegetation)candidate.vegetation.lodMode=this.vegetationLOD;candidate.prepareGPU?.();this.invalidateScene();if(!options.deferCompile)await this.compile();
      if(signal?.aborted||this.disposed)throw Error('Vegetation load cancelled/disposed');
      this.meshCompanions.add(candidate);this.invalidateVisibility();return candidate;
    }catch(error){if(options.overlay&&this.sceneOverlays?.get(options.overlay.id)?.root===candidate?.root)this.sceneOverlays.delete(options.overlay.id);candidate?.dispose();if(!this.disposed){this.errors.splice(errorCount);this.pipelineHandles.splice(pipelineCount);this.invalidateVisibility();this.compiled=compiled;}throw error;}
    finally{this.loading--;}
  });}
  clearMeshCompanions(){this.shadowUnified?.invalidate?.('companions-cleared');this.clearArchitecturalLighting();for(const asset of this.meshCompanions){this.releaseAux(asset.root);asset.dispose();}this.meshCompanions.clear();this.sceneOverlays?.clear();this.invalidateVisibility();}
  attachBoundedWater(asset,options){
    if(asset.apsBoundedWater)throw Error('Asset already owns bounded water');
    const water=attachReflectingPool(this,asset,options);
    this.boundedWaters??=new Set();this.boundedWaters.add(water);asset.apsBoundedWater=water;
    return water;
  }
  releaseBoundedWater(asset){
    const water=asset?.apsBoundedWater;if(!water)return;
    delete asset.apsBoundedWater;this.boundedWaters?.delete(water);water.dispose();
  }
  clearArchitecturalLighting(){this.indoorLPV?.dispose();for(const water of this.boundedWaters??[])water.dispose();this.boundedWaters?.clear();}
  setInterventionState(state){if(!this.terrainIntervention)throw Error('This scene has no terrain intervention');return this.terrainIntervention.setState(state);}
  async configureGrass(asset,impostor=null,signal){
    if(!asset.vegetation||!this.heightfield)throw Error('Grass screen sampling requires vegetation and native terrain');
    if(isNativeGrassPatch(asset.sceneData)&&asset.sceneData.extras.request?.impostor===true&&!impostor)throw Error('Native API grass patch requires its requested impostor reference');
    const system=asset.vegetation;system.isGrass=true;
    if(impostor&&!system.grassImpostor)system.grassImpostor=await loadGrassImpostor(this,asset,impostor,signal);
    await configureGrassPopulation(this,system,this.heightfield);
    if(!system.screenGrass){const sampler=new ScreenGrass(this,system,this.heightfield);system.screenGrass=sampler;await sampler.init();}
    return asset;
  }
  replaceVegetationCompanion(previous,url,options={}){return this.queueScene(async()=>{
    await this.ready;
    if(!this.meshCompanions.has(previous))throw Error('Vegetation replacement requires an attached companion');
    this.deviceHealth?.check();this.loading++;
    const terrain=this.heightfield,ocean=this.ocean,visible=previous.root.visible,cover=previous.groundcover;
    const errorCount=this.errors.length,pipelineCount=this.pipelineHandles.length;let candidate,detached=false;
    try{
      candidate=await loadMesh(this,url,options.signal,{grassPatch:previous.vegetation?.isGrass===true,plant:true});
      if(!candidate.vegetation)throw Error('Vegetation replacement requires authored LODs');
      if(previous.vegetation?.isGrass)await this.configureGrass(candidate,options.impostor);
      candidate.vegetation.lodMode=this.vegetationLOD;candidate.prepareGPU?.();
      previous.root.visible=false;if(cover){cover.detach(previous);detached=true;}terrain?.groundcover?.attach(candidate);
      this.invalidateScene();await this.compile();
      if(this.disposed)throw Error('Vegetation replacement cancelled');
      if(this.heightfield!==terrain||this.ocean!==ocean)throw Error('Vegetation replacement changed terrain or ocean');
      this.meshCompanions.delete(previous);this.meshCompanions.add(candidate);previous.dispose();this.invalidateVisibility();return candidate;
    }catch(error){
      candidate?.dispose();previous.root.visible=visible;
      if(!this.disposed){if(detached)cover.attach(previous);this.errors.splice(errorCount);this.pipelineHandles.splice(pipelineCount);this.invalidateVisibility();}
      throw error;
    }finally{this.loading--;}
  });}
  fitScene({visibleOnly=false}={}){
                                                                               
                                                                            
    const shows=root=>root&&(visibleOnly?root.visible!==false:true);
    const box=new Box3().makeEmpty();
    if(shows(this.root))box.union(instanceAwareBounds(this.root));
    for(const asset of this.meshCompanions)if(shows(asset.root)&&!asset.root.userData?.apsDiagnosticOverlay)box.union(instanceAwareBounds(asset.root));
    for(const asset of this.taskTerrainRecords?.values?.()??[])if(shows(asset.root))box.union(instanceAwareBounds(asset.root));
    if(box.isEmpty())return;
    const center=box.getCenter(new Vector3()),size=box.getSize(new Vector3()),radius=Math.max(size.length()/2,.01);
    const vertical=this.camera.fov*Math.PI/180,horizontal=2*Math.atan(Math.tan(vertical/2)*this.camera.aspect);
    const distance=radius/Math.sin(Math.min(vertical,horizontal)/2)*1.08;
    this.setCamera({position:center.clone().add(new Vector3(1,.42,1.2).normalize().multiplyScalar(distance)).toArray(),target:center.toArray(),fov:this.camera.fov,near:Math.max(.00001,radius/1000),far:distance+radius*100,minDistance:radius*.05,maxDistance:distance*10});
    this.dimensions=size.toArray().map(x=>x.toFixed(2)).join(' × ')+' m';
  }
  setOcean(config,terrain=this.heightfield){return this.queueScene(()=>this.replaceOceanCandidate(config,terrain));}
  clearTaskHeightfields(){clearTaskTerrains(this);}
  syncTaskHeightfields(current,raw){return syncTaskTerrains(this,current,raw);}
  loadHeightfieldAsset(url,options){return loadHeightfield(this,url,options);}
  async loadHeightfieldCandidate(url,{deferOcean=false,preserveCompanions=false,beforeCommit=null,retainPriorOcean=false}={}){
    await this.ready;if(this.disposed)throw Error('Viewer has been disposed');this.loading++;
    const prior={root:this.root,terrain:this.heightfield,mesh:this.meshAsset,ocean:this.ocean,inlandOptics:this.inlandOptics,waterHook:this.sceneRenderer.onBeforeWater,enabled:this.ocean?.enabled,pose:this.savePose(),weather:this.lighting?.weather},id=this.loadId+1,errorCount=this.errors.length,pipelineCount=this.pipelineHandles.length;let api,candidateOcean;
    try{api=await this.loadHeightfieldAsset(url,{deferCommit:true});api.inlandOptics?.install();if(prior.root)prior.root.visible=false;this.retainedAssets.add(prior);
      this.root=api.root;this.heightfield=api;this.inlandOptics=api.inlandOptics??null;this.scene.add(api.root);this.invalidateScene();
      if(retainPriorOcean&&deferOcean)throw Error('Cannot defer ocean during a retained terrain transaction');
      if(retainPriorOcean&&api.oceanConfig==null){prior.ocean?.setEnabled(false);this.ocean=null;if(api.inlandOptics)await this.bindInlandOptics(api);else{const binding=this.waterBinding(null);api.setOcean?.(null);this.bindOceanReceivers(binding);this.lighting.bindOcean?.(binding);this.renderPipeline.bindOcean?.(binding);await this.compile();}}
      else if(deferOcean){if(this.ocean)this.clearOcean();}
      else if(api.oceanConfig!=null){candidateOcean=await this.replaceOceanCandidate(api.oceanConfig,api,{retainPrior:retainPriorOcean});}
      else if(api.inlandOptics)await this.bindInlandOptics(api);
      else{prior.ocean?.setEnabled(false);this.ocean=null;this.lighting.bindOcean?.(null);this.renderPipeline.bindOcean?.(null);await this.compile();if(this.disposed||id!==this.loadId)throw Error('Stale heightfield load');this.ocean=prior.ocean;this.clearOcean();}
      if(this.disposed||id!==this.loadId)throw Error('Stale heightfield load');
      if(beforeCommit)beforeCommit(api,prior);
      if(retainPriorOcean){
                                                                            
                                                                            
        const failures=[];const cleanup=fn=>{try{fn();}catch(error){failures.push(error.message);}};
        if(prior.ocean!==this.ocean)cleanup(()=>prior.ocean?.dispose());
        if(!preserveCompanions)cleanup(()=>this.clearMeshCompanions());
        cleanup(()=>this.releaseAux(prior.root));cleanup(()=>prior.terrain?.dispose());cleanup(()=>prior.mesh?.dispose());
        if(failures.length)this.lastRecoverableError={operation:'heightfield_cleanup',message:failures.join('; ')};
      }else{if(!preserveCompanions)this.clearMeshCompanions();this.releaseAux(prior.root);prior.terrain?.dispose();prior.mesh?.dispose();}
      this.meshAsset=null;return api;
    }catch(e){
      let cleanupError;const cleanup=fn=>{try{fn();}catch(failure){cleanupError??=failure;}};
      if(retainPriorOcean&&candidateOcean&&(this.ocean===candidateOcean||this.disposed||id!==this.loadId))cleanup(()=>candidateOcean.dispose());
      cleanup(()=>api?.dispose());
      if(retainPriorOcean&&(this.disposed||id!==this.loadId)&&this.ocean!==prior.ocean)cleanup(()=>prior.ocean?.dispose());
      if(!this.disposed&&id===this.loadId){this.root=prior.root;this.heightfield=prior.terrain;this.meshAsset=prior.mesh;this.ocean=prior.ocean;this.inlandOptics=prior.inlandOptics??null;this.sceneRenderer.onBeforeWater=prior.waterHook;prior.ocean?.setEnabled(prior.enabled);if(prior.root)prior.root.visible=true;const priorBinding=this.waterBinding(prior.ocean);prior.terrain?.setOcean?.(prior.ocean?.terrainApi===prior.terrain?prior.ocean:null);this.bindOceanReceivers(priorBinding);this.lighting?.bindOcean?.(priorBinding);this.renderPipeline?.bindOcean?.(priorBinding);this.setCamera(prior.pose);if(prior.weather)this.lighting?.setWeather(prior.weather);this.errors.splice(errorCount);this.pipelineHandles.splice(pipelineCount);this.lastRecoverableError={operation:'heightfield_load',message:e.message};this.invalidateScene();}
      if(cleanupError)throw new AggregateError([e,cleanupError],'Heightfield load and cleanup failed');throw e;
    }finally{this.retainedAssets.delete(prior);this.loading--;}
  }
                                                                             
  startTaskHeightfield(url,{current,result}){return this.queueScene(async()=>{
    const box=this.assetRoots.get('starter-box'),sand=this.assetRoots.get('starter-sand-ground');
    const vegetation=[...this.meshCompanions].map(asset=>asset.vegetation).filter(Boolean);
    if(this.sceneDocument!==current||this.heightfield||!box||box.api!==this.meshAsset||box.root!==this.root||
       !sand||!this.meshCompanions.has(sand.api)||this.assetRoots.has('task-terrain')||
       this.terrainIntervention||this.indoorLPV||[...this.meshCompanions].some(asset=>asset.groundcover)||
       vegetation.some(system=>system.isGrass||system.groundcover||system.screenGrass||system.population||system.models?.some(model=>model.gpuPopulation)||typeof system.setWaterExclusion!=='function'))
      throw Error('Starter scene has shared dependencies');
    const rebound=[];let candidateApi,registryTouched=false;
    try{
      const api=await this.loadHeightfieldCandidate(url,{preserveCompanions:true,retainPriorOcean:true,beforeCommit:candidate=>{
        if(this.sceneDocument!==current||this.assetRoots.get('starter-box')!==box||this.assetRoots.get('starter-sand-ground')!==sand||this.assetRoots.has('task-terrain'))throw Error('Scene changed during terrain update');
        for(const system of vegetation){rebound.push([system,system.waterExclusion]);system.setWaterExclusion(terrainWaterExclusion(this,candidate));}
        candidateApi=candidate;
        registryTouched=true;
        this.registerSceneAsset('task-terrain',candidate,{kind:'heightfield',url,root:candidate.root,tagRoot:false});
        if(this.assetRoots.get('task-terrain')?.api!==candidate)throw Error('Terrain registration failed');
        this.assetRoots.delete('starter-box');this.assetRoots.delete('starter-sand-ground');
        this.sceneDocument=result;
      }});
      this.meshCompanions.delete(sand.api);
      try{this.releaseAux(sand.root);sand.api.dispose();}catch(error){this.lastRecoverableError={operation:'starter_cleanup',message:error.message};}
      try{this.invalidateVisibility();this.fitScene();}catch(error){this.lastRecoverableError={operation:'starter_camera',message:error.message};}
      return api;
    }catch(error){
      let rollbackError;
      if(this.sceneDocument===current||this.sceneDocument===result){
        for(const [system,predicate] of rebound.reverse())try{system.setWaterExclusion(predicate);}catch(failure){rollbackError??=failure;}
        if(registryTouched){
          if(candidateApi&&this.assetRoots.get('task-terrain')?.api===candidateApi)this.assetRoots.delete('task-terrain');
          if(!this.assetRoots.has('starter-box'))this.assetRoots.set('starter-box',box);
          if(!this.assetRoots.has('starter-sand-ground'))this.assetRoots.set('starter-sand-ground',sand);
        }
        if(this.sceneDocument===result)this.sceneDocument=current;
      }
      if(rollbackError)throw new AggregateError([error,rollbackError],'Terrain transition and vegetation rollback failed');
      throw error;
    }
  });}
                                                                         
                                                                             
  async finishTaskHeightfield(boxUrl,sandUrl,{current,result}){
    const safe=()=>{
      const terrain=this.heightfield,record=this.assetRoots.get('task-terrain');
      const vegetation=[...this.meshCompanions].map(asset=>asset.vegetation).filter(Boolean);
      return this.sceneDocument===current&&terrain&&record?.api===terrain&&record.root===this.root&&
        !this.terrainIntervention&&!this.indoorLPV&&!terrain.groundcover&&!this.boundedWaters?.size&&
        !this.assetRoots.has('starter-box')&&!this.assetRoots.has('starter-sand-ground')&&
        ![...this.meshCompanions].some(asset=>asset.groundcover)&&
        !vegetation.some(system=>system.isGrass||system.groundcover||system.screenGrass||system.population||system.models?.some(model=>model.gpuPopulation)||typeof system.setWaterExclusion!=='function');
    };
    if(!safe())throw Error('Terrain has shared scene dependencies');
    const sand=await this.addAsset(sandUrl,undefined,{initiallyHidden:true,independentModel:true});
    let committed=false;
    try{return await this.queueScene(async()=>{
      if(!safe()||!this.meshCompanions.has(sand))throw Error('Scene changed during terrain removal');
      const old=this.assetRoots.get('task-terrain'),pose=this.savePose(),rebound=[];let candidate,registryTouched=false;
      try{
        const loaded=await this.loadMeshCandidate(boxUrl,undefined,{preserveCompanions:true,retainPriorOcean:true,preservePose:true,beforeCommit:(box,prior)=>{
          if(this.sceneDocument!==current||prior.terrain!==old.api||prior.root!==old.root||this.root!==box.root||
             this.assetRoots.get('task-terrain')!==old||!this.meshCompanions.has(sand)||
             this.assetRoots.has('starter-box')||this.assetRoots.has('starter-sand-ground'))throw Error('Scene changed during terrain removal');
          for(const asset of this.meshCompanions){const system=asset.vegetation;if(system){rebound.push([system,system.waterExclusion]);system.setWaterExclusion(terrainWaterExclusion(this,null));}}
          candidate=box;
          registryTouched=true;
          this.registerSceneAsset('starter-box',box,{kind:'glb',url:boxUrl});
          this.registerSceneAsset('starter-sand-ground',sand,{kind:'glb',url:sandUrl});
          if(this.assetRoots.get('starter-box')?.api!==box||this.assetRoots.get('starter-sand-ground')?.api!==sand)throw Error('Starter registration failed');
          this.assetRoots.delete('task-terrain');sand.root.visible=true;this.sceneDocument=result;
        }});
        if(!loaded)throw Error('Starter load superseded');
        committed=true;return true;
      }catch(error){
        let rollbackError;
        if(this.sceneDocument===current||this.sceneDocument===result){
          for(const [system,predicate] of rebound.reverse())try{system.setWaterExclusion(predicate);}catch(failure){rollbackError??=failure;}
          if(registryTouched){
            if(candidate&&this.assetRoots.get('starter-box')?.api===candidate)this.assetRoots.delete('starter-box');
            if(this.assetRoots.get('starter-sand-ground')?.api===sand)this.assetRoots.delete('starter-sand-ground');
            if(!this.assetRoots.has('task-terrain'))this.assetRoots.set('task-terrain',old);
          }
          sand.root.visible=false;
          if(this.sceneDocument===result)this.sceneDocument=current;
        }
        if(rollbackError)throw new AggregateError([error,rollbackError],'Terrain removal and vegetation rollback failed');
        throw error;
      }finally{if(!this.disposed&&(this.sceneDocument===current||this.sceneDocument===result))try{this.setCamera(pose);}catch(_){}}
    });}finally{
      if(!committed&&this.meshCompanions.has(sand)){this.meshCompanions.delete(sand);try{this.releaseAux(sand.root);sand.dispose();this.invalidateVisibility();}catch(_){}}
    }
  }
                                                                          
                                                                            
  replaceTaskHeightfield(url,{current,id,result}){return this.queueScene(async()=>{
    const record=this.assetRoots.get(id),terrain=this.heightfield;
    const vegetation=[...this.meshCompanions].map(asset=>asset.vegetation).filter(Boolean);
    if(this.sceneDocument!==current||!terrain||record?.api!==terrain||record.root!==this.root||
       this.terrainIntervention||terrain.groundcover||this.indoorLPV||
       [...this.meshCompanions].some(asset=>asset.groundcover)||
       vegetation.some(system=>system.isGrass||system.groundcover||system.screenGrass||system.population||system.models?.some(model=>model.gpuPopulation)||typeof system.setWaterExclusion!=='function'))
      throw Error('Terrain has shared scene dependencies');
    const pose=this.savePose(),oldRecord=record,rebound=[];let candidateApi;
    try{
      return await this.loadHeightfieldCandidate(url,{preserveCompanions:true,retainPriorOcean:true,beforeCommit:api=>{
        if(this.sceneDocument!==current||this.assetRoots.get(id)!==oldRecord)throw Error('Scene changed during terrain update');
        for(const system of vegetation){rebound.push([system,system.waterExclusion]);system.setWaterExclusion(terrainWaterExclusion(this,api));}
        candidateApi=api;
        this.registerSceneAsset(id,api,{kind:'heightfield',url,root:api.root,tagRoot:false});
        this.sceneDocument=result;
      }});
    }catch(error){
      let rollbackError;
      if(this.sceneDocument===current||this.sceneDocument===result){
        for(const [system,predicate] of rebound.reverse())try{system.setWaterExclusion(predicate);}catch(failure){rollbackError??=failure;}
        if(this.assetRoots.get(id)?.api===candidateApi&&candidateApi)this.assetRoots.set(id,oldRecord);
        if(this.sceneDocument===result)this.sceneDocument=current;
      }
      if(rollbackError)throw new AggregateError([error,rollbackError],'Terrain update and vegetation rollback failed');
      throw error;
    }finally{if(!this.disposed&&(this.sceneDocument===current||this.sceneDocument===result))this.setCamera(pose);}
  });}
  loadMeshAsset(url,signal,options){return loadMesh(this,url,signal,options);}
  async loadMeshCandidate(url,signal,options={}){
    await this.ready;if(this.disposed)throw Error('Viewer has been disposed');this.loading++;
    const id=++this.loadId,prior={root:this.root,mesh:this.meshAsset,terrain:this.heightfield,ocean:this.ocean,inlandOptics:this.inlandOptics,oceanEnabled:this.ocean?.enabled,pose:this.savePose(),weather:this.lighting?.weather},errorCount=this.errors.length,pipelineCount=this.pipelineHandles.length;let candidate;
    try{candidate=await this.loadMeshAsset(url,signal,{plant:options.plant===true,grassPatch:options.grass===true});
      if(options.grass){
        if(!isNativeGrassPatch(candidate.sceneData))throw Error('Standalone grass preview requires a verified native API patch');
        if(candidate.sceneData.extras.request?.impostor===true&&!options.impostor)throw Error('Native grass preview requires its requested impostor reference');
                                                                           
                                                                               
                                                                                 
        const proxy=options.impostor?await loadGrassImpostor(this,candidate,options.impostor,signal):null;
        const dispose=candidate.dispose,metadata=candidate.metadata;
        candidate.grassPrototypePreview={native_patch:true,terrain_screen_sampling:false,impostor:proxy?.metadata()??null};
        candidate.metadata=()=>({...metadata(),grass_prototype_preview:candidate.grassPrototypePreview});
        candidate.dispose=()=>{proxy?.dispose();dispose();};
      }
      if(candidate.vegetation)candidate.vegetation.lodMode=this.vegetationLOD;candidate.prepareGPU?.();if(signal?.aborted||id!==this.loadId||this.disposed){candidate.dispose();return false;}
      const box=instanceAwareBounds(candidate.root);if(box.isEmpty()||![...box.min.toArray(),...box.max.toArray()].every(Number.isFinite))throw Error('Model has no finite nonempty bounds');
      if(prior.root)prior.root.visible=false;this.retainedAssets.add(prior);this.root=candidate.root;this.heightfield=null;this.inlandOptics=null;prior.ocean?.setEnabled(false);this.ocean=null;this.bindOceanReceivers(null);this.lighting?.bindOcean?.(null);this.renderPipeline?.bindOcean?.(null);this.invalidateScene();if(!options.preservePose)this.fit();this.setWireframe(this.wireframe??false);await this.compile();
      if(signal?.aborted||id!==this.loadId||this.disposed)throw Error('Mesh load superseded/disposed');
      if(options.beforeCommit)options.beforeCommit(candidate,prior);
      if(options.retainPriorOcean){
                                                                        
                                                         
        const failures=[],cleanup=fn=>{try{fn();}catch(error){failures.push(error.message);}};
        if(!options.preserveCompanions)cleanup(()=>this.clearMeshCompanions());
        this.oceanLoadId++;cleanup(()=>prior.ocean?.dispose());cleanup(()=>this.releaseAux(prior.root));
        cleanup(()=>prior.mesh?.dispose());cleanup(()=>prior.terrain?.dispose());
        if(failures.length)this.lastRecoverableError={operation:'mesh_cleanup',message:failures.join('; ')};
      }else{this.clearMeshCompanions();this.oceanLoadId++;prior.ocean?.dispose();this.releaseAux(prior.root);prior.mesh?.dispose();prior.terrain?.dispose();}
      this.meshAsset=candidate;
      if(options.retainPriorOcean){try{this.invalidateScene();}catch(error){this.lastRecoverableError={operation:'mesh_invalidate',message:error.message};}}
      else this.invalidateScene();
      this.compiled=true;return true;
    }catch(e){let cleanupError;try{this.releaseAux(candidate?.root);}catch(failure){cleanupError??=failure;}try{candidate?.dispose();}catch(failure){cleanupError??=failure;}if(!this.disposed&&id===this.loadId){this.root=prior.root;this.meshAsset=prior.mesh;this.heightfield=prior.terrain;this.ocean=prior.ocean;this.inlandOptics=prior.inlandOptics??null;prior.ocean?.setEnabled(prior.oceanEnabled);const priorBinding=this.waterBinding(prior.ocean);this.bindOceanReceivers(priorBinding);this.lighting?.bindOcean?.(priorBinding);this.renderPipeline?.bindOcean?.(priorBinding);if(prior.root)prior.root.visible=true;this.setCamera(prior.pose);if(prior.weather)this.lighting?.setWeather(prior.weather);this.errors.splice(errorCount);this.pipelineHandles.splice(pipelineCount);this.lastRecoverableError={operation:'mesh_load',message:e.message};this.invalidateScene();}if(cleanupError)throw new AggregateError([e,cleanupError],'Mesh load and cleanup failed');throw e;}finally{this.retainedAssets.delete(prior);this.loading--;}
  }
  syncLens(){if(this.renderPipeline)this.renderPipeline.setOptions({focalLength:this.renderPipeline.options.sensorWidth/(2*Math.tan(this.camera.fov*Math.PI/360)*this.camera.aspect)});}
  cameraShadowRange(){                                                        }
  createGrid(){const points=[],colors=[];for(let i=-10;i<=10;i++){points.push(-10,0,i,10,0,i,i,0,-10,i,0,10);const c=i===0?new Color().setRGB(86/255,101/255,82/255,SRGBColorSpace):new Color().setRGB(51/255,61/255,71/255,SRGBColorSpace);for(let j=0;j<4;j++)colors.push(c.r,c.g,c.b);}const g=new BufferGeometry();g.setAttribute('position',new Float32BufferAttribute(points,3));g.setAttribute('color',new Float32BufferAttribute(colors,3));const m=new Material({name:'Accepted ground grid',lit:false,color:[1,1,1],vertexColors:true,topology:'line-list'});this.grid=new Mesh(g,m);this.grid.visible=!this.presentation;this.scene.add(this.grid);}
  setCamera(view){const pose=view.world_camera??view;this.camera.position.fromArray(pose.position??pose.eye);this.controls.target.fromArray(pose.target);this.camera.fov=pose.fov_degrees??pose.fov??42;this.camera.near=pose.near??.1;this.camera.far=pose.far??60000;this.camera.updateProjectionMatrix();if(pose.minDistance!==undefined)this.controls.minDistance=pose.minDistance;if(pose.maxDistance!==undefined)this.controls.maxDistance=pose.maxDistance;if(Object.hasOwn(pose,'dimensions'))this.dimensions=pose.dimensions;if(pose.grid&&this.grid){this.grid.position.fromArray(pose.grid.position);this.grid.scale.fromArray(pose.grid.scale);}if(this.renderPipeline)this.renderPipeline.setOptions({focalLength:this.renderPipeline.options.sensorWidth/(2*Math.tan(this.camera.fov*Math.PI/360)*this.camera.aspect)});this.controls.changed();this.cameraShadowRange();this.depthSnapshot=null;}
  setTerrainCamera(view,sceneData=this.heightfield?.sceneData){if(view.world_camera){this.setCamera(view);this.controls.minDistance=.1;this.controls.maxDistance=this.camera.far;return;}const [x,z]=sceneData.origin_xz_m??[0,0],eye=[...(view.eye??view.position)],target=[...view.target];eye[0]+=x;eye[2]+=z;target[0]+=x;target[2]+=z;this.setCamera({...view,eye,target,near:view.near??.1,far:view.far??Math.max(...sceneData.extent_xz_m)*12});this.controls.minDistance=.1;this.controls.maxDistance=this.camera.far;}
  fit(){if(!this.root)return;const box=instanceAwareBounds(this.root),center=box.getCenter(new Vector3()),size=box.getSize(new Vector3()),radius=Math.max(size.length()/2,.01),v=this.camera.fov*Math.PI/180,h=2*Math.atan(Math.tan(v/2)*this.camera.aspect),distance=radius/Math.sin(Math.min(v,h)/2)*(this.presentation?1:1.15);this.camera.position.copy(center).add(new Vector3(1,this.presentation?.42:.7,1.2).normalize().multiplyScalar(distance));this.controls.target.copy(center);this.camera.near=Math.max(.00001,radius/1000);this.camera.far=distance+radius*100;this.camera.updateProjectionMatrix();this.dimensions=size.toArray().map(x=>x.toFixed(2)).join(' × ')+' m';this.controls.minDistance=radius*.05;this.controls.maxDistance=distance*10;if(this.grid){this.grid.position.set(center.x,box.min.y-radius*.001,center.z);this.grid.scale.setScalar(Math.max(size.x,size.z,.1)/10);}this.lighting?.setWeather({groundHeight:box.min.y,probePosition:[center.x,box.min.y+2,center.z]});this.syncLens();this.controls.changed();this.cameraShadowRange();this.depthSnapshot=null;}
  setWireframe(enabled){this.wireframe=!!enabled;this.root?.traverse(mesh=>{if(!mesh.isMesh)return;if(enabled&&!mesh.userData.apsWire){const original=mesh.geometry;if(!['triangle-list',undefined].includes(mesh.material.topology))return;const index=original.index?.array??Array.from({length:original.attributes.position.count},(_,i)=>i),edges=[];for(let i=0;i+2<index.length;i+=3)edges.push(index[i],index[i+1],index[i+1],index[i+2],index[i+2],index[i]);const geometry=new BufferGeometry();for(const[k,a]of Object.entries(original.attributes))geometry.setAttribute(k,a);geometry.setIndex(new Uint32BufferAttribute(edges,1));geometry.instanceCount=original.instanceCount;geometry.boundingBox=original.boundingBox;geometry.boundingSphere=original.boundingSphere;const material=mesh.material.clone();delete material.__pk;delete material.__pkFrame;material.topology='line-list';material.needsUpdate=true;mesh.userData.apsWire={original,originalMaterial:mesh.material,geometry,material};}const w=mesh.userData.apsWire;if(w){mesh.geometry=enabled?w.geometry:w.original;mesh.material=enabled?w.material:w.originalMaterial;}});}
  setMaterialOverride(options){this.releaseAux(this.root);this.root?.traverse(mesh=>{if(!mesh.isMesh)return;const material=new Material(options);mesh.userData.apsOverride={original:mesh.material,material};mesh.material=material;});}
  clear(){this.planarMirrors?.clear();this.pointShadows?.clear();this.lighting?.setLocalLights([]);this.sceneEpoch++;this.loadId++;this.terrainIntervention?.dispose();this.invalidateScene();this.shadowUnified?.invalidate?.('viewer-clear');this.receiverShadows?.invalidate?.('clear');this.clearSceneAssets();this.clearMeshCompanions();this.clearTaskHeightfields();this.inlandOptics=null;this.clearOcean();this.heightfield?.dispose();this.releaseAux(this.meshAsset?.root);this.meshAsset?.dispose();for(const prior of this.retainedAssets){this.releaseAux(prior.root);prior.terrain?.dispose();prior.mesh?.dispose();}this.retainedAssets.clear();this.heightfield=null;this.meshAsset=null;this.root=null;}
  async captureCanvas(){
    this.loading++;let texture;
    try{
      const width=this.canvas.width,height=this.canvas.height;
      texture=new Texture({width,height,format:'rgba8unorm',usage:['render','sample','copySrc'],label:'APS submitted PNG snapshot'});
      const destination={texture,format:'rgba8unorm',transfer:'srgb',clear:[0,0,0,0]};
      await this.renderPipeline.prepareDestination(destination);
      this.renderFrame(0);this.renderPipeline._writeOutput(destination);
      const pixels=await readTexture(texture);const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
      const context=canvas.getContext('2d');if(!context)throw Error('PNG encoding context unavailable');
      context.putImageData(new ImageData(new Uint8ClampedArray(pixels.data),width,height),0,0);return canvas;
    }finally{texture?.destroy();this.loading--;}
  }
  async captureDataURL(){return (await this.captureCanvas()).toDataURL('image/png');}
  async replaceOceanCandidate(config,terrain=this.heightfield,{pausePreviewOnPublish=false,retainPrior=false}={}){
    await this.ready;if(this.disposed)throw Error('Viewer has been disposed');const id=++this.oceanLoadId;if(config==null){this.clearOcean();return null;}
    const prior=this.ocean,candidate=new Ocean(this,config,terrain,{shoreReview:this.options.oceanShoreReview,foamLOD:this.options.oceanFoamLOD}),oldHook=this.sceneRenderer.onBeforeWater,errorCount=this.errors.length,pipelineCount=this.pipelineHandles.length;this.loading++;
    try{await candidate.init();if(pausePreviewOnPublish)this.loadingPreview=false;await GPU.pipelinesReady();if(this.disposed||id!==this.oceanLoadId){candidate.dispose();return null;}
      candidate.time=prior?.time??0;candidate.paused=prior?.paused??false;this.ocean=candidate;const binding=this.waterBinding(candidate);terrain?.setOcean?.(candidate);this.bindOceanReceivers(binding);this.lighting.bindOcean?.(binding);this.renderPipeline.bindOcean?.(binding);const visible=prior?.enabled,enabled=candidate.enabled;prior?.setEnabled(false);candidate.setEnabled(true);
      try{await this.compile();}finally{candidate.setEnabled(enabled);prior?.setEnabled(visible??false);}
      if(this.disposed||id!==this.oceanLoadId)throw Error('Ocean replacement superseded/disposed');if(retainPrior)prior?.setEnabled(false);else prior?.dispose();return candidate;
    }catch(e){candidate.dispose();this.inlandOptics?.releaseOceanComposition?.();if(!this.disposed&&id===this.oceanLoadId){this.ocean=prior;this.sceneRenderer.onBeforeWater=oldHook;terrain?.setOcean?.(prior?.terrainApi===terrain?prior:null);const priorBinding=this.waterBinding(prior);this.bindOceanReceivers(priorBinding);this.lighting.bindOcean?.(priorBinding);this.renderPipeline.bindOcean?.(priorBinding);this.errors.splice(errorCount);this.pipelineHandles.splice(pipelineCount);this.lastRecoverableError={operation:'ocean_profile',message:e.message};this.invalidateScene();}throw e;}finally{this.loading--;}
  }
  waterBinding(ocean=this.ocean){return composeWaterBinding(ocean??null,this.inlandOptics??null);}
  async bindInlandOptics(api){
    const optics=api?.inlandOptics??null;
    if(!optics)return null;
    this.inlandOptics=optics;
    const binding=this.waterBinding(this.ocean);
    api.setOcean?.(this.ocean);
    this.bindOceanReceivers(binding);
    this.lighting?.bindOcean?.(binding);
    this.renderPipeline?.bindOcean?.(binding);
    if(!this.disposed)await this.compile();
    return optics;
  }
  bindOceanReceivers(ocean){const module=ocean?.receiverSurfaceModule??null;this.scene.traverse(object=>{if(!object.isMesh||object.material?.isWaterMaterial)return;for(const material of (Array.isArray(object.material)?object.material:[object.material]))material?.setOceanReceiver?.(module);});}
  clearOcean(){this.oceanLoadId++;this.inlandOptics?.releaseOceanComposition?.();this.ocean?.dispose();this.ocean=null;const binding=this.waterBinding(null);this.bindOceanReceivers(binding);this.heightfield?.setOcean?.(null);this.lighting?.bindOcean?.(binding);if(!this.disposed)this.renderPipeline?.bindOcean?.(binding);}
  async setPostProcessing(options={}){await this.ready;this.renderPipeline.setOptions(options);return this.renderPipeline;}
  async precomputeCloudLighting(onProgress){
    await this.ready;this.loading++;
    try{return await this.lighting.cloudField.precomputeDaily(this.lighting.weather,this.camera.position,onProgress);}
    finally{this.loading--;}
  }
  async loadCloudLightingPrecomputation(blob){
    await this.ready;this.loading++;
    try{return await this.lighting.cloudField.loadDaily(blob);}finally{this.loading--;}
  }
  exportCloudLightingPrecomputation(){
    const bank=this.lighting?.cloudField.dailyBank;if(!bank)throw Error('No precomputed cloud lighting');return bank.toBlob();
  }
  addComponent(component){this.components.add(component);return component;}
  removeComponent(component){this.components.delete(component);component.dispose?.();}
  releaseAux(root){root?.traverse(mesh=>{const w=mesh.userData.apsWire;if(w){mesh.geometry=w.original;mesh.material=w.originalMaterial;w.geometry.dispose();w.material.dispose();w.material.uniformBlock.buffer?.destroy();delete mesh.userData.apsWire;}const m=mesh.userData.apsOverride;if(m){mesh.material=m.original;m.material.dispose();m.material.uniformBlock.buffer?.destroy();delete mesh.userData.apsOverride;}});}
  async capture(filename='scene.png'){this.loading++;try{const canvas=await this.captureCanvas();const state=this.metadata();const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw Error('WebGPU canvas screenshot unavailable');const a=document.createElement('a'),url=URL.createObjectURL(blob);a.href=url;a.download=filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);const metadataURL=URL.createObjectURL(new Blob([JSON.stringify(state,null,2)],{type:'application/json'}));const evidence=document.createElement('a');evidence.href=metadataURL;evidence.download=filename.replace(/\.png$/i,'')+'.json';evidence.click();setTimeout(()=>URL.revokeObjectURL(metadataURL),1000);}finally{this.loading--;}}
  async compile(){
    this.meshRenderer?.pipelinePreparationErrors?.clear();
    this.staticOcclusion?.ensureTerrain();
    this.meshRenderer?.prepareStaticDraw?.(this.scene,[this.camera]);
                                                                           
                                                                          
                                                                
    try{await this.receiverShadows?.ensureReady(this);}catch(error){this.receiverShadows?.fail(error);}
                                                                              
                                                                            
                                                                       
    try{this.shadowGlobalHiZ?.ensureReady(this);}catch(error){this.shadowGlobalHiZ?.invalidate?.('compile');if(this.shadowGlobalHiZ)this.shadowGlobalHiZ.lastError={stage:'compile',message:String(error?.message??error)};}
    this.loading++;
    const wait=(operation,stage)=>{const cache=GPU.pipelineCacheMetadata();this.options.onLoadProgress?.(stage+' · '+cache.pipelines+' distinct pipelines · '+cache.hits+' cache hits');return this.deviceHealth?this.deviceHealth.wait(operation,stage):operation();};
    const priorDefer=GPU.deferUnreadyPipelines;GPU.deferUnreadyPipelines=true;
    try{
      for(let phase=0;phase<2;phase++){
        this.meshRenderer.precompiling=phase===0;let stable=false;
        for(let i=0;i<8;i++){
          const count=this.pipelineHandles.length;
          if(this.disposed)throw Error('Viewer has been disposed');
          await wait(()=>GPU.pipelinesReady(),'Compiling GPU pipelines');
          const pendingFailure=this.pipelineHandles.find(h=>h.failed);
          if(pendingFailure)throw Error(`WebGPU pipeline "${pendingFailure.label}" failed: ${pendingFailure.error?.message||'compilation failed'}`);
          this.renderFrame(0);
          if(this.meshRenderer?.pipelinePreparationErrors?.size)throw Error('Imported pipeline preparation failed: '+[...this.meshRenderer.pipelinePreparationErrors.values()].slice(0,8).map(e=>e.material+' / '+e.pass+': '+e.message).join('; '));
          await wait(()=>GPU.pipelinesReady(),'Preparing render pipelines');
          await wait(()=>GPU.queue.onSubmittedWorkDone(),'Waiting for submitted GPU work');
          if(this.disposed)throw Error('Viewer has been disposed');
          const failed=this.pipelineHandles.filter(h=>h.failed);
          if(failed.length)throw Error('WebGPU pipeline compilation failed: '+failed.map(h=>h.label).join(', '));
          if(this.errors.length)throw Error(this.errors.join('\n'));
          if(this.pipelineHandles.length===count){stable=true;break;}
        }
        if(!stable)throw Error('WebGPU pipeline graph failed to stabilize');
      }
      this.compiled=true;
    }finally{GPU.deferUnreadyPipelines=priorDefer;this.meshRenderer.precompiling=false;this.loading--;}
    await this.receiverShadows?.afterCompile(this);
  }
  setStaticVisibilityCulling(enabled){const value=this.meshRenderer?.setStaticDrawEnabled?.(enabled)??enabled;this.invalidateVisibility?.();return value;}
  setStaticVisibilityDiagnostics(enabled){if(enabled)throw Error('Building BSP diagnostics were removed from the production viewer; use the isolated historical fixtures');return false;}
  shadowCasterMetadata(){return this.shadowUnified?.metadata?.()??null;}
  metadata(){return {backend:'webgpu',wgsl:true,pipelines:{total:this.pipelineHandles.length,pending:[...GPU._pending].length,waiting:this.pipelineHandles.filter(h=>!h.pipeline&&!h.failed).map(h=>h.label),mesh_cached:this.meshRenderer?.pipelines.size,sync_compiles:GPU.syncCompiles?.slice(-10)},ocean_profile:this.oceanProfileState??null,last_recoverable_error:this.lastRecoverableError??null,requested_water_debug:this.requestedWaterDebug??null,checks:{pipeline_compilation:this.compiled===true?'passed':'not_completed',gpu_image_review:'not_performed_by_viewer',simple_light_route:this.options.outdoor===false?'unsupported':'not_requested'},mesh:this.meshAsset?.metadata(),vegetation_lod:this.vegetationLOD,mesh_companions:[...this.meshCompanions].map(a=>a.metadata()),view:this.currentView??null,camera:{position:this.camera.position.toArray(),target:this.controls.target.toArray(),fov:this.camera.fov,near:this.camera.near,far:this.camera.far},viewport:[this.canvas.width,this.canvas.height],terrain:this.heightfield?.metadata(),lighting:this.lighting?.metadata(),ocean:this.ocean?.metadata(),inland_water_optics:this.inlandOptics?.metadata(),indoor_lpv:this.indoorLPV?.metadata(),static_mesh_bsp:this.meshRenderer?.staticBSP?.metadata()??{enabled:false,prepared:false,landscape_in_bsp:false,instances_in_bsp:false},static_occlusion:this.staticOcclusion?.metadata(),static_visibility_frame:this.meshRenderer?.visibilityFrame,static_draw_gpu:this.meshRenderer?.staticDraw?.metadata(),static_material_batch:this.meshRenderer?.materialBatch?.metadata(),draw_resource_preparation:this.meshRenderer?.lastResourcePreparation,bounded_water:[...(this.boundedWaters??[])].map(w=>w.metadata()),physical_camera:this.renderPipeline?.metadata(),navigation:this.navigation.metadata(),geometry_rendering:this.meshRenderer?.passSummary,shadow_shader_policy:this.meshRenderer?.depthPolicy,planar_mirrors:this.planarMirrors?.metadata(),point_light_shadows:this.pointShadows?.metadata(),shadow_maps:{count:this.shadows?.count,size:this.shadows?.size},shadow_cache_policy:this.lastShadowPolicy??null,receiver_driven_shadows:this.receiverShadows?.metadata?.()??null,shadow_global_hiz:this.shadowGlobalHiZ?.metadata?.()??null,shadow_state_cache:this.shadows?.lastStateCache??null,shadow_state_cache_texture:this.shadows?.stateCacheMetadata?.()??null,shadow_caster_batching:this.shadowUnified?.summary?.()??null,shadow_caster_batching_error:this.shadowCasterBatchingError??null,intervention_toggle:this.interventionToggle??null,shader_errors:this.errors,pipeline_failures:this.pipelineHandles.filter(h=>h.failed).map(h=>h.label),frame:this.frame,frame_intervals_ms:this.frameTimings.slice(-30),limits:Object.fromEntries(['maxSampledTexturesPerShaderStage','maxSamplersPerShaderStage','maxStorageBuffersPerShaderStage','maxStorageTexturesPerShaderStage'].map(k=>[k,GPU.limits?.[k]]))};}
  dispose(){
    this.frameWorkDiagnostics?.dispose();
    if(this.disposed)return;this.terrainIntervention?.dispose();this.disposed=true;this.deviceHealth?.dispose();this.recoveryPanel?.remove();this.sceneEpoch++;this.loadId++;this.oceanLoadId++;this.frameLoop?.stop();this.observer?.disconnect();if(this.resizeFrame!==null&&this.resizeFrame!==undefined){cancelAnimationFrame(this.resizeFrame);this.resizeFrame=null;}this.navigation.dispose();this.clearSceneAssets();this.clearMeshCompanions();this.clearTaskHeightfields();this.inlandOptics=null;this.clearOcean();this.heightfield?.dispose();this.releaseAux(this.meshAsset?.root);this.meshAsset?.dispose();for(const prior of this.retainedAssets){this.releaseAux(prior.root);prior.terrain?.dispose();prior.mesh?.dispose();}this.retainedAssets.clear();this.planarMirrors?.dispose();this.pointShadows?.dispose();this.staticOcclusion?.dispose();for(const c of this.components)c.dispose?.();this.components.clear();this.renderPipeline?.dispose();this.lighting?.dispose();
    if(this.grid){this.grid.geometry.dispose();this.grid.material.dispose();this.grid.material.uniformBlock.buffer?.destroy();}
                                                                                
                                                                                 
                                               
    try{this.receiverShadows?.detachRenderer?.();}catch(error){this.receiverShadowDisposeError={stage:'detach',message:String(error?.message??error)};}
                                                                                
                                                      
    try{uninstallShadowUnified(this);}catch(error){this.shadowCasterBatchingError={stage:'dispose',message:String(error?.message??error)};}
    this.shadowUnified=null;
    try{this.shadowGlobalHiZ?.dispose?.();}catch(error){this.shadowGlobalHiZDisposeError={stage:'dispose',message:String(error?.message??error)};}
    this.shadowGlobalHiZ=null;if(this.shadows)this.shadows.globalHiZ=null;
    if(GPU.device){if(!this.deviceFailure)GPU.submit();try{this.receiverShadows?.dispose();}catch(error){this.receiverShadowDisposeError={stage:'dispose',message:String(error?.message??error)};}this.receiverShadows=null;for(const name of ['sceneRT','opaqueCopy','opaqueDepthHalf','hullMaskRT']){const rt=this.sceneRenderer?.[name];for(const t of rt?.textures??[])t.destroy();rt?.depthTexture?.destroy();}this.sceneRenderer?.hullMaskMaterial?.dispose();this.sceneRenderer?.hullMaskMaterial?.uniformBlock.buffer?.destroy();this.meshRenderer?.dispose();this.meshRenderer?.drawBuffer?.destroy();this.meshRenderer?.pipelines.clear();this.shadows?.dispose();if(this.gpuError)GPU.device.removeEventListener('uncapturederror',this.gpuError);}
    else{try{this.receiverShadows?.dispose();}catch{}this.receiverShadows=null;}
    if(GPU._async===this.asyncHook)GPU._async=this.originalAsync;this.depthSnapshot=null;this.canvas.remove();
  }
}



