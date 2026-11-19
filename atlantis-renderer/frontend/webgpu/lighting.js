import {NON_CASCADED_SHADOW_SIZE} from './shadow_resolution.js';
import {GPU} from '../../vendor/tidewater/src/engine/gpu/GPU.js';
import {Vector3} from '../../vendor/tidewater/src/engine/math/index.js';
import {G} from '../../vendor/tidewater/src/engine/render/Frame.js';
import {SceneLighting, ShadowUniforms} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';
import {WebGPUSunShadows as SunShadows,terrainCasterBounds} from './shadows.js';
import {CloudOpticalDepthField} from './cloud_field.js';
import {DEFAULT_WEATHER, normalizeWeather, practicalSplits, skyWeatherKey, solarAtProbe} from './lighting_math.js';
import {CachedAtmosphere, CachedEnvironment, OutdoorSky, combinedDirectModule, captureHooks, destroyUniform, releaseAfterSubmit} from './lighting_native.js';
import {HDRSky,environmentOptions,linearHDRTexture,decodeRGBE,adaptHDRInput} from './hdr_environment.js';
import {LocalLights} from './local_lights.js';
import {PreintegratedDFG} from './ibl_dfg.js';
import {installDFGLookup} from './lighting_pipeline.js?mirror-repair=5';
import {EnvironmentFrame} from './environment_frame.js';

export class OutdoorLighting {
  constructor(viewer) {
    this.viewer=viewer;this.scene=viewer.scene;this.camera=viewer.camera;this.disposed=false;this.initialized=false;
    this.environmentFrame=new EnvironmentFrame();this.weather=normalizeWeather(viewer.options?.weather||{},DEFAULT_WEATHER);
                                                                            
    const overrides={};for(const k of Object.keys(DEFAULT_WEATHER))if(k in (viewer.options||{}))overrides[k]=viewer.options[k];
    if (viewer.shadows?.count === 1) overrides.shadowMapSize = NON_CASCADED_SHADOW_SIZE;
    this.weather=normalizeWeather(overrides,this.weather);this.previousHooks=captureHooks();this.installedHooks={};this.revision=0;
    this.directEnabled=this.weather.directEnabled;this.environmentMode='procedural';this.environmentRequest=0;this.localLightData=viewer.options?.localLights||[];
  }
  async init() {
    if(this.disposed)throw new Error('OutdoorLighting is disposed');
    if(this.initialized)return this;
    if(!GPU.device)throw new Error('Initialize the shared GPU before OutdoorLighting');
    this.previousBackground=this.viewer.sceneRenderer.background;
                                                                               
                                                                                
    this.shadows=this.viewer.shadows;
    if(!this.shadows) {
      this.shadows=new SunShadows({size:this.weather.shadowMapSize,splits:practicalSplits(this.camera.near,Math.min(this.camera.far,this.weather.shadowDistance)),normalBias:[.025,.05,.15,.3]});
      this.shadows.layerMask=1;this.ownsShadows=true;
    }
    this.atmosphere=new CachedAtmosphere(this.viewer.meshRenderer);
    this.cloudField=new CloudOpticalDepthField({atmosphere:this.atmosphere,environmentFrame:this.environmentFrame});
    this.sky=new OutdoorSky(this.atmosphere);this.sky.clouds={module:this.cloudField.skyModule};
    this.viewer.sceneRenderer.background=this.sky.background;
    this.environment=new CachedEnvironment(this.viewer.meshRenderer,this.scene,this.sky,128);
    this.dfg=new PreintegratedDFG();this.restoreDFG=installDFGLookup(this.viewer.meshRenderer,this.dfg.module);
    const liveHooks=this.environmentFrame.wrapIBL(captureHooks());
    for(const [name,hook] of Object.entries(liveHooks)){this.installedHooks[name]=hook;SceneLighting.set(name,hook);}
    this.localLights=new LocalLights();this.setLocalLights(this.localLightData);
    this.proceduralEnvironment=this.environment;this.proceduralHooks={envSpecular:SceneLighting.hooks.envSpecular,envDiffuse:SceneLighting.hooks.envDiffuse};
    this.atmosphere.onIrradiance=atmo=>{
      if(this.disposed)return;
      G.skyIrradiance.value.setRGB(...atmo.skyIrradiance);
      G.horizonColor.value.setRGB(...atmo.horizon);
                                                                                                               
                                                                                                
      this.irradianceRevision=(this.irradianceRevision||0)+1;
    };
    this.initialized=true;this._applyWeather(true);this.bindOcean(null);
    await GPU.pipelinesReady();
    if(this.disposed)return this;
    this.dfg.bake();this._updateCaches(0,this.camera);return this;
  }
  initialize(){return this.init();}
  setWeather(options={}) {
    if(this.disposed)throw new Error('OutdoorLighting is disposed');
    if (this.shadows?.count === 1) options = {...options, shadowMapSize: NON_CASCADED_SHADOW_SIZE};
    const next=normalizeWeather(options,this.weather);
    if(JSON.stringify(next)===JSON.stringify(this.weather))return this;
    const previous=this.weather;
    if(Object.keys(DEFAULT_WEATHER).filter(k=>k!=='environmentYaw').every(k=>JSON.stringify(next[k])===JSON.stringify(previous[k]))){
      this.weather=next;this.revision++;if(this.initialized)this._applyEnvironmentFrame();return this;
    }
    if(this.environmentMode==='external')this.restoreProcedural();
    this.weather=normalizeWeather(options,this.weather);this.environmentRequest++;this.revision++;
    if(this.initialized)this._applyWeather(previous.rayleigh!==next.rayleigh || previous.mie!==next.mie || previous.turbidity!==next.turbidity || previous.groundHeight!==next.groundHeight);
    return this;
  }
  _applyWeather(staticDirty=false) {
    const w=this.weather,a=this.atmosphere;
    a.sunDir.value.fromArray(w.sunDirection);this._applyEnvironmentFrame();
    a.rayleighScale.value=w.rayleigh;a.mieScale.value=w.mie*w.turbidity/2;
    a.sunIlluminance.value.setRGB(...w.solarIrradiance);a.groundAlbedo.value.setRGB(.18,.20,.16);
    this.sky.sunDiskIntensity.value=this.environmentMode==='procedural'&&w.directEnabled&&w.displaySun?1:0;
    this.sky.starIntensity.value=0;G.night.value=0;
    this.directEnabled=w.directEnabled;G.envIntensity.value=w.iblIntensity;G.exposure.value=1;
    this.diskIrradiance=solarAtProbe(w);this.sky.solar.fields.irradiance.value=this.diskIrradiance;
    G.sunColor.value.setRGB(...this.diskIrradiance.map(v=>v*(this.environmentMode==='procedural'&&w.directEnabled?1:0)));
    if(staticDirty)a.invalidate();
    if(this.shadows.size!==w.shadowMapSize) {
      this.shadows.size=w.shadowMapSize;this.shadows.texture.resize(w.shadowMapSize,w.shadowMapSize,this.shadows.count);
      ShadowUniforms.fields.mapSize.value=w.shadowMapSize;
    }
    this._configureShadows();
  }
  _applyEnvironmentFrame(){
    const w=this.weather;this.environmentFrame.update(w.environmentYaw,w.probePosition);
    this.worldSunDirection=this.environmentFrame.directionToWorld(w.sunDirection);G.sunDir.value.fromArray(this.worldSunDirection);
  }
  setEnvironmentYaw(degrees){return this.setWeather({environmentYaw:degrees});}
  _configureShadows() {
    const w=this.weather, s=this.shadows;
    if(s.count!==(this.viewer.options.singleShadow?1:4))throw new Error('Unexpected native sun shadow layout');
    const key=JSON.stringify([w.directEnabled,w.shadowMapSize]);
    if(key===this.shadowKey)return;
    s.enabled=w.directEnabled;
    for(const c of s.cascades)c.dirty=true;this.shadowKey=key;
  }
  _updateCaches(dt,camera) {
    if(this.environmentMode==='external')return;
                                                                 
    const p=this.weather.probePosition,probe={x:p[0],y:p[1],z:p[2]};
    const key=this.atmosphere.updateWeather(dt,probe.y,this.weather);
    this.cloudField.update(this.weather,probe);
    const sourceKey=key+':irr='+String(this.irradianceRevision||0);
    this.cloudField.updatePanorama(this.weather,probe,sourceKey);
    this.environment.updateKey(sourceKey+':cloud='+this.cloudField.panoramaKey);
  }
  update(dt=0,time=0,camera=this.viewer.camera) {
    if(this.disposed || !this.initialized)return;
    if(!Number.isFinite(dt) || dt<0 || !Number.isFinite(time))throw new RangeError('Invalid lighting time');
    this.camera=camera;this.localLights.syncScene(this.scene,this.localLightData);
    if(this.environmentMode==='procedural'&&this.weather.animateClouds) {
                                                                                         
      const cloudTime=Math.floor(time*4)/4;
      if(cloudTime!==this.weather.cloudTime)this.setWeather({cloudTime});
    }
    this._configureShadows();this._updateCaches(dt,camera);
                                                                              
    if(this.ownsShadows)this.shadows.render(this.scene,this.viewer.meshRenderer,this.shadows.update(camera,G.sunDir.value,this.viewer.heightfield?terrainCasterBounds(this.viewer.heightfield.sceneData,this.viewer.heightfield.root,this.viewer.terrainIntervention?.manifest.maximum_displacement_m??0):null),this.viewer.heightfield);
    const terrain=this.viewer.heightfield?.terrainModule||null;
    if(terrain!==this.boundTerrain)this.bindOcean(this.ocean);
                                                                                           
    const direct=SceneLighting.hooks.directModulation;
    if(direct && direct!==this.installedHooks.directModulation && direct!==this.previousHooks.directModulation)this.bindOcean(this.ocean);
  }
  solarAtProbe(){return new Vector3(...solarAtProbe(this.weather));}
  renderView(camera=this.viewer.camera,depth=this.viewer.sceneRenderer?.sceneRT.depthTexture){
    if(this.environmentMode!=='procedural'){this.cloudField.view.disable();return;}
    this.cloudField.view.update(this.weather,camera,depth.width,depth.height,depth);
  }
  updateSolar(){if(this.initialized)this._applyWeather();return this;}
  setDirectEnabled(enabled){return this.setWeather({directEnabled:enabled});}
  setLocalLights(lights=[]){if(this.localLights){this.localLights.syncScene(this.scene,lights);this.installedHooks.localLights=this.localLights.module;if(SceneLighting.hooks.localLights!==this.localLights.module)SceneLighting.set('localLights',this.localLights.module);}this.localLightData=lights;return this;}
  setLocalShadowAtlas(atlas){const previous=this.localLights.setShadowAtlas(atlas);releaseAfterSubmit(()=>destroyUniform(previous));this.installedHooks.localLights=this.localLights.module;SceneLighting.set('localLights',this.localLights.module);return this;}
  setEnvironment(texture,options={}) {
                                                                                                
    const input=adaptHDRInput(texture);texture=input.texture;
    let settings;try{settings=environmentOptions(texture,options);}catch(error){if(input.owned)texture.destroy();throw error;}
    const request=++this.environmentRequest;
    const run=Promise.resolve(this.hdrTail).catch(()=>{}).then(()=>this._importEnvironment(texture,settings,request)).then(result=>{
      if(input.owned&&this.external?.source===texture)this.external.ownsSource=true;return result;
    },error=>{if(input.owned)releaseAfterSubmit(()=>texture.destroy());throw error;});
    this.hdrTail=run;return run;
  }
  async _importEnvironment(texture,settings,request) {
    if(this.disposed||!this.initialized)throw new Error('Initialize lighting before importing HDR');
    if(request!==this.environmentRequest)throw new Error('HDR import superseded');
    const saved=captureHooks();let candidate,sky;const scoped=!!GPU.device.pushErrorScope;let scopeOpen=scoped;
    if(scoped)GPU.device.pushErrorScope('validation');
    let failure=null;
    try {
      sky=new HDRSky(this.atmosphere,texture,settings,this.environmentFrame);
      candidate=new CachedEnvironment(this.viewer.meshRenderer,null,sky,256);
      const background=sky.background;
      const hooks=this.environmentFrame.wrapIBL(captureHooks());
      for(const name of Object.keys(hooks))SceneLighting.set(name,saved[name]||null);
      await GPU.pipelinesReady();
      const kernels=[...candidate.faceKernels,...candidate.filterKernels.flat(),...candidate.shKernels,candidate._mips.kernelA,candidate._mips.kernelB,sky._background];
      if(kernels.filter(Boolean).some(k=>k.handle.failed))throw new Error('HDR candidate shader compilation failed');
      if(this.disposed||request!==this.environmentRequest)throw new Error('HDR import superseded');
      candidate.updateKey('external');GPU.submit();await GPU.queue.onSubmittedWorkDone?.();
      if(scoped){const error=await GPU.device.popErrorScope();scopeOpen=false;if(error)throw new Error(error.message);}
      if(this.disposed||request!==this.environmentRequest)throw new Error('HDR import superseded');
      if(this.environmentMode==='procedural')this.proceduralState=this.weather;
      this._releaseExternal();this.external={sky,environment:candidate,source:texture,options:settings};
      this.environment=candidate;this.environmentMode='external';this.viewer.sceneRenderer.background=background;
      for(const [name,hook] of Object.entries(hooks)){this.installedHooks[name]=hook;SceneLighting.set(name,hook);}
      this.weather=normalizeWeather({directEnabled:false,aerialEnabled:false,iblIntensity:settings.intensity},this.weather);
      this.cloudField.params.fields.ready.value=0;this._applyWeather();this.revision++;return this;
    } catch(error){failure=error;} 
    for(const name of ['envSpecular','envDiffuse']){if(SceneLighting.hooks[name]!==this.installedHooks[name])SceneLighting.set(name,this.installedHooks[name]||saved[name]||null);}
    if(scopeOpen)await GPU.device.popErrorScope();
    releaseAfterSubmit(()=>{candidate?.dispose();destroyUniform(sky?.params);destroyUniform(sky?.orientation);});
    throw failure;
  }
  async loadHdr(url,options={}) {
    const response=await fetch(url);if(!response.ok)throw new Error(`Cannot load HDR (${response.status})`);
    const texture=linearHDRTexture(decodeRGBE(await response.arrayBuffer()));
    try{await this.setEnvironment(texture,options);if(this.external?.source===texture)this.external.ownsSource=true;else releaseAfterSubmit(()=>texture.destroy());return this;}catch(error){releaseAfterSubmit(()=>texture.destroy());throw error;}
  }
  _releaseExternal(){const old=this.external;if(!old)return;this.external=null;releaseAfterSubmit(()=>{old.environment.dispose();destroyUniform(old.sky.params);destroyUniform(old.sky.orientation);if(old.ownsSource)old.source.destroy();});}
  restoreProcedural(){
    if(this.environmentMode!=='external')return this;
    this.environmentRequest++;this.environmentMode='procedural';this.weather=normalizeWeather({environmentYaw:this.weather.environmentYaw},this.proceduralState||this.weather);
    this.environment=this.proceduralEnvironment;this.viewer.sceneRenderer.background=this.sky.background;
    for(const [name,hook] of Object.entries(this.proceduralHooks)){this.installedHooks[name]=hook;SceneLighting.set(name,hook);}
    this._releaseExternal();this.cloudField.invalidate();this._applyWeather(true);this.revision++;return this;
  }
  bake(){this.restoreProcedural();this.cloudField.invalidate();this._updateCaches(0,this.camera);return this;}
  bindOcean(ocean) {
    if(!this.initialized){this.ocean=ocean;return;}
    const old=this.installedHooks.directModulation,current=SceneLighting.hooks.directModulation;
    if(this.ocean===ocean&&this.boundTerrain===(this.viewer.heightfield?.terrainModule||null)&&current===old)return;
    const base=ocean?.directModulationModule || ocean?.lighting?.directModulationModule ||
      (ocean && current && current!==old ? current : ocean && ocean===this.ocean ? this.oceanBase : null);
                                                                                    
    let hook;
    if(!base && ocean?.lightingModule) {
      const mod=ocean.lightingModule;
      if(!/\bfn\s+oceanDirectModulation\s*\(/.test(mod.code))throw new Error('Ocean lightingModule must define oceanDirectModulation(P,N) -> vec3f');
      hook=combinedDirectModule(this.cloudField.module,{...mod,code:mod.code.replace(/\boceanDirectModulation\b/g,'hookDirectModulation')},this.viewer.heightfield?.terrainModule);
    } else hook=combinedDirectModule(this.cloudField.module,base,this.viewer.heightfield?.terrainModule);
    this.oceanBase=base;this.ocean=ocean;this.boundTerrain=this.viewer.heightfield?.terrainModule||null;
    this.installedHooks.directModulation=hook;SceneLighting.set('directModulation',hook);
    const ambient=ocean?.ambientModulationModule??this.previousHooks.ambientModulation??null;
    this.installedHooks.ambientModulation=ambient;SceneLighting.set('ambientModulation',ambient);
  }
  metadata() {return {direct_enabled:this.directEnabled,display_disk:!!this.sky?.sunDiskIntensity.value,aerial_enabled:this.weather.aerialEnabled,ibl_intensity:this.weather.iblIntensity,ibl_flip_x:this.external?.options.flipX??1,solar_top_irradiance:this.weather.solarIrradiance,mode:this.environmentMode,probe:this.weather.probePosition,irradiance:this.diskIrradiance,hdr:this.external?.options,local_lights:{count:this.localLights?.params.fields.count.value,shadow_atlas:!!this.localLights?.shadow},backend:'webgpu',native:true,weather:this.weather,revision:this.revision,
    environment_yaw_degrees:this.weather.environmentYaw,world_sun_direction:this.worldSunDirection,environment_cache_anchor:'explicit weather.probePosition; independent of view and yaw',
    clouds:this.cloudField?.metadata(),sky:{source:this.environmentMode==='external'?'linear imported HDR':'accepted depth-ordered joint WGSL air/cloud/ground bake + cached native atmosphere LUTs',lut_updates:this.atmosphere?.skyUpdates||0,static_lut_updates:this.atmosphere?.staticUpdates||0,clouds_frozen:!this.weather.animateClouds},
    ibl:{method:'native GGX filtered importance sampling (96 samples), six HDR roughness mips, SH9 diffuse',bakes:this.environment?.bakes||0,dfg:'128x128 GGX/Smith correlated Schlick A/B LUT, 256 compute samples, native multiscattering energy compensation',dfg_bakes:this.dfg?.bakes||0,format:'linear rgba16float',disk_in_ibl:false},
    csm:{...this.shadows?.metadata(),primary_depth:'reversed Z: near 1 / far 0',shadow_depth:'standard Z: near 0 / far 1; less-equal',legacy_shadow_distance_ignored:true},
    direct_composition:{clouds:this.environmentMode==='procedural',terrain:!!this.boundTerrain,ocean:!!this.ocean},aerial_steps:8,exposure:'PhysicalCamera only; frame exposure 1'};}
  dispose() {
    if(this.disposed)return;this.disposed=true;
    if(this.viewer.sceneRenderer?.background===this.sky?._background || this.viewer.sceneRenderer?.background===this.external?.sky?._background)this.viewer.sceneRenderer.background=this.previousBackground;
    for(const [name,module] of Object.entries(this.installedHooks))if(SceneLighting.hooks[name]===module)SceneLighting.set(name,this.previousHooks[name]||null);
    this._releaseExternal();this.environmentRequest++;this.restoreDFG?.();
    if(this.ownsShadows)ShadowUniforms.fields.enabled.value=0;
    releaseAfterSubmit(()=>{
      this.dfg?.dispose();this.cloudField?.dispose();this.proceduralEnvironment?.dispose();this.atmosphere?.dispose();this.environmentFrame?.dispose();this.localLights?.dispose();destroyUniform(this.sky?.params);destroyUniform(this.sky?.solar);
      if(this.ownsShadows){this.shadows.texture.destroy();for(const c of this.shadows.cascades)destroyUniform(c.block);}
    });
  }
}
