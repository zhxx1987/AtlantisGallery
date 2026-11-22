import {GPU} from '../../vendor/tidewater/src/engine/gpu/GPU.js';
import {ShaderModule, UniformBlock} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {Texture, StorageBuffer} from '../../vendor/tidewater/src/engine/gpu/Texture.js';
import {ComputeKernel} from '../../vendor/tidewater/src/engine/gpu/Compute.js';
import {FullscreenPass} from '../../vendor/tidewater/src/engine/render/FullscreenPass.js';
import {G} from '../../vendor/tidewater/src/engine/render/Frame.js';
import {commonModule} from '../../vendor/tidewater/src/engine/render/wgsl/common.js';
import {exposureFromEV} from '../src/physical_camera_math.js';
import {normalizePostOptions,projectLightShaftSun,cameraEV100} from './post_options.js';
import {SHAFT_MASK_WGSL,SHAFT_OCCLUSION_WGSL,SHAFT_OCCLUSION_APPLY_WGSL,SHAFT_BLOOM_EXTRACT_WGSL,shaftBloomBlurWGSL} from './light_shafts_ue.js';
import {volumeShadowModule} from './volume_transport.js';
import {createUnderwaterTransport} from './post_underwater.js';
import {destroyUniform,releaseAfterSubmit} from './lighting_native.js';
import {BOUNDED_RADIANCE_WGSL,AERIAL_WGSL, EXPOSURE_WGSL, HIGHLIGHT_WGSL, DOWNSAMPLE_WGSL, blurWGSL,
  DOF_WGSL, COMPOSE_WGSL} from './post_shaders.js';

import {FXAA_WGSL} from './fxaa.js';
import {ScreenSpaceAO} from './ssao.js';
import {VolumetricFog} from './volumetric_fog.js';

export class PhysicalCamera {
  constructor(viewer, lighting) {
    if(!lighting?.initialized)throw new Error('Await OutdoorLighting.init() before PhysicalCamera');
    this.viewer=viewer;this.lighting=lighting;this.disposed=false;this.frames=0;
    this.options=normalizePostOptions(viewer.options?.postProcessing||{});
    this.width=1;this.height=1;this.diagnosticMode=false;this.evRevision=0;this.evResetRevision=0;this.postTime=0;
    this.borrowedOptics={camera:viewer.camera,fov:viewer.camera.fov};this.outputPasses=new Map();this.fxaaPasses=new Map();
    this.fxaaInput=new Texture({label:'APS FXAA display input',format:'rgba8unorm',usage:['sample','render']});
    const rt=(name)=>new Texture({label:'APS physical camera '+name,width:1,height:1,format:'rgba16float',usage:['sample','render']});
    this.aerial=rt('aerial');this.airScatter=rt('existing atmosphere in-scattering');this.shaftScene=rt('occluded atmosphere HDR');this.dof=rt('DOF');
    this.shaftMask=rt('shaft depth visibility');this.shaftOcclusion=rt('shaft blurred visibility');
    this.shaftBloomExtract=rt('sun scene highlights');this.shaftBloomLevels=Array.from({length:3},(_,i)=>rt('sun radial bloom '+i));
    this.bloomLevels=Array.from({length:5},(_,i)=>({down:rt('bloom down '+i),ping:rt('bloom horizontal '+i),blur:rt('bloom vertical '+i)}));
    this.exposureState=new StorageBuffer({label:'APS GPU camera EV / exposure / meter',count:2,type:'vec4f',data:new Float32Array([this.options.autoExposure?Math.max(this.options.minEV,Math.min(this.options.maxEV,cameraEV100(this.options)-this.options.exposureCompensation)):cameraEV100(this.options)-this.options.exposureCompensation,1,0,0,0,this.options.exposureCompensation,Number(this.options.autoExposure),0])});
    this.params=new UniformBlock('APSPhysicalCameraParams',{
      fogVolumetric:['f32',1],fogShadows:['f32',1],fogSteps:['u32',48],fogAnisotropy:['f32',.5],fogSunIntensity:['f32',1],fogAmbientIntensity:['f32',1],
      fog:['f32',1],fogDensity:['f32',.0005],fogColor:['vec3f',[.45,.55,.65]],fogBaseHeight:['f32',0],fogHeightFalloff:['f32',.02],fogStart:['f32',0],fogMaxDistance:['f32',10000],fogMaxOpacity:['f32',.95],
      rawDiagnostic:['f32',0],evRevision:['f32',0],evResetRevision:['f32',0],time:['f32',0],manualEV:['f32',0],autoExposure:['f32',1],radianceScale:['f32',1000],compensation:['f32',0],
      minEV:['f32',0],maxEV:['f32',18],adaptationUp:['f32',2],adaptationDown:['f32',1],
      bloom:['f32',.12],glow:['f32',.12],bloomThreshold:['f32',1],bloomMaxBrightness:['f32',64],shafts:['f32',.12],
      shaftDensity:['f32',.85],
      shaftSamples:['u32',32],shaftDecay:['f32',.96],sunFade:['f32',0],sunUV:['vec2f',[.5,.5]],
      occlusionDepthRange:['f32',1000],occlusionMaskDarkness:['f32',.05],
      shaftBloomEnabled:['f32',0],shaftBloomScale:['f32',1],shaftBloomThreshold:['f32',1],shaftBloomTint:['vec3f',[1,1,1]],shaftDirection:['vec3f',[0,1,0]],bloomConeCos:['f32',.98],
      aerial:['f32',1],dof:['f32',0],
      focalLength:['f32',35],sensorWidth:['f32',36],aperture:['f32',5.6],focusDistance:['f32',30],
      vignette:['f32',.12],grain:['f32',0],
    });
    this.postModule=new ShaderModule({name:'apsPhysicalCamera',deps:[commonModule],uniforms:this.params,uniformName:'post',code:BOUNDED_RADIANCE_WGSL});
    this.exposureModule=new ShaderModule({name:'apsCameraExposure',deps:[this.postModule],bindings:{exposureState:{storage:this.exposureState,access:'read'}}});
    const scene=viewer.sceneRenderer;
    this.ssao=new ScreenSpaceAO(scene);this.previousOpaqueHook=scene.onAfterOpaque;
    this.opaqueHook=()=>{this.previousOpaqueHook?.();this.ssao.render(this.options,this.diagnosticMode);};scene.onAfterOpaque=this.opaqueHook;
    this.fogVolume=new VolumetricFog(scene,this.postModule,lighting);
    const primary={texture:()=>scene.sceneRT.depthTexture};
    this.aerialPass=new FullscreenPass({label:'APS depth-aware camera cloud and atmosphere composite',colorFormats:['rgba16float','rgba16float'],modules:[this.fogVolume.compositeModule,this.postModule,lighting.atmosphere.transmittanceModule,lighting.atmosphere.multiScatModule,lighting.cloudField.view.compositeModule,volumeShadowModule],
      bindings:{postScene:{texture:()=>scene.sceneRT.texture},postDepth:primary},code:AERIAL_WGSL});
    this.meter=new ComputeKernel({label:'APS HDR logarithmic exposure',modules:[this.postModule],workgroupSize:[128,1,1],bindings:{meterSource:{texture:()=>this.hdrSource},exposureState:{storage:this.exposureState,access:'read_write'}},code:EXPOSURE_WGSL});
    this.highlight=new FullscreenPass({label:'APS unexposed HDR highlights',modules:[this.exposureModule],bindings:{bloomSource:{texture:()=>this.options.depthOfField?this.dof:this.hdrSource}},code:HIGHLIGHT_WGSL});
    this.bloomPasses=this.bloomLevels.map((level,i)=>({
      down:i===0?this.highlight:new FullscreenPass({label:'APS bloom down '+i,modules:[this.postModule],bindings:{bloomSource:{texture:this.bloomLevels[i-1].blur}},code:DOWNSAMPLE_WGSL}),
      horizontal:new FullscreenPass({label:'APS bloom horizontal '+i,modules:[this.postModule],bindings:{bloomSource:{texture:level.down}},code:blurWGSL(true)}),
      vertical:new FullscreenPass({label:'APS bloom vertical '+i,modules:[this.postModule],bindings:{bloomSource:{texture:level.ping}},code:blurWGSL(false)}),
    }));
    this.dofPass=new FullscreenPass({label:'APS metric thin-lens bokeh',modules:[this.postModule],bindings:{postDepth:primary,dofSource:{texture:()=>this.hdrSource}},code:DOF_WGSL});
    this.shaftMaskPass=new FullscreenPass({label:'APS shaft closest-depth visibility',modules:[this.postModule],bindings:{postDepth:primary},code:SHAFT_MASK_WGSL});
    this.shaftOcclusionPass=new FullscreenPass({label:'APS shaft radial occlusion visibility',modules:[this.postModule],bindings:{shaftMask:{texture:this.shaftMask}},code:SHAFT_OCCLUSION_WGSL});
    this.shaftApplyPass=new FullscreenPass({label:'APS shaft occlusion of existing atmosphere',modules:[this.postModule],bindings:{aerialSource:{texture:this.aerial},atmosphereScatter:{texture:this.airScatter},shaftOcclusion:{texture:this.shaftOcclusion}},code:SHAFT_OCCLUSION_APPLY_WGSL});
    this.shaftExtractPass=new FullscreenPass({label:'APS sun neighbourhood HDR extraction',modules:[this.exposureModule],bindings:{shaftBloomScene:{texture:()=>this.options.depthOfField?this.dof:this.hdrSource}},code:SHAFT_BLOOM_EXTRACT_WGSL});
    this.shaftBloomPasses=this.shaftBloomLevels.map((target,i)=>new FullscreenPass({label:'APS sun radial bloom '+i,modules:[this.postModule],bindings:{shaftBloomInput:{texture:i?this.shaftBloomLevels[i-1]:this.shaftBloomExtract}},code:shaftBloomBlurWGSL(i)}));
    this.composePass=this._outputPass(GPU.format,'srgb');
    this._prepareFXAA(GPU.format);
    this._applyOptions();this.setSize(viewer.canvas.width||1,viewer.canvas.height||1);
  }
  async init(){await GPU.pipelinesReady();return this;}
  bindOcean(ocean){
    if(this.ocean===ocean&&this.aerialPass)return;
    this.underwater?.dispose();this.ocean=ocean;
    this.underwater=ocean?.cameraModule?createUnderwaterTransport(ocean,this.lighting.cloudField.module):null;
    const scene=this.viewer.sceneRenderer,modules=[this.fogVolume.compositeModule,this.postModule,this.lighting.atmosphere.transmittanceModule,this.lighting.atmosphere.multiScatModule,this.lighting.cloudField.view.compositeModule,volumeShadowModule];
    let code=AERIAL_WGSL;
    if(this.underwater){modules.push(this.underwater.module);code=code.replace('let fogOpacity=apsHeightFogOpacity(in.uv,textureLoad(postDepth,vec2i(in.pos.xy),0));','let fogOpacity=select(apsHeightFogOpacity(in.uv,textureLoad(postDepth,vec2i(in.pos.xy),0)),0.,apsCameraUnderwater());').replace('return apsAirTransport(base,frame.cameraPos,D,distance,sky);','let waterMask=textureLoad(postWaterMask,px,0);if(waterMask.g>.99){if(apsCameraUnderwater()){return apsUnderwaterTransport(base,frame.cameraPos,D,distance);}return apsAirTransport(base,frame.cameraPos,D,distance,sky);}return apsMixedTransport(base,frame.cameraPos,D,distance,sky);').replace('if (post.aerial < .5 && apsView.enabled < .5)', 'if (uw.enabled < .5 && post.aerial < .5 && apsView.enabled < .5)').replace('let color=fragment(in);','let color=fragment(in);if(apsCameraUnderwater()){apsAtmosphereInScattering=vec3f(0);}')}
    this.aerialPass=new FullscreenPass({label:'APS depth-aware camera cloud and atmosphere composite (water)',colorFormats:['rgba16float','rgba16float'],modules,bindings:{postScene:{texture:()=>scene.sceneRT.texture},postDepth:{texture:()=>scene.sceneRT.depthTexture},postWaterMask:{texture:()=>scene.waterMaskTexture}},code});
  }
  setOptions(options={}) {
    if(this.disposed)throw new Error('PhysicalCamera is disposed');
    const next=normalizePostOptions(options,this.options);
    this.evRevision++;if(next.autoExposure!==this.options.autoExposure)this.evResetRevision=this.evRevision;
    this.options=next;this._applyOptions();return this;
  }
  _applyOptions() {
    const o=this.options,u=this.params.fields;
    for(const k of ['fogVolumetric','fogShadows'])u[k].value=Number(o[k]);
    for(const k of ['fogSteps','fogAnisotropy','fogSunIntensity','fogAmbientIntensity'])u[k].value=o[k];
    u.fog.value=Number(o.fog);for(const k of ['fogDensity','fogColor','fogBaseHeight','fogHeightFalloff','fogStart','fogMaxDistance','fogMaxOpacity'])u[k].value=o[k];
    for(const k of ['radianceScale','minEV','maxEV','adaptationUp','adaptationDown','bloom','glow','bloomThreshold','bloomMaxBrightness','focalLength','sensorWidth','aperture','focusDistance','vignette','grain'])u[k].value=o[k];
    for(const [a,b] of Object.entries({autoExposure:'autoExposure',compensation:'exposureCompensation',dof:'depthOfField',shafts:'lightShafts',shaftDensity:'lightShaftDensity',shaftSamples:'lightShaftSamples',shaftDecay:'lightShaftDecay'}))u[a].value=Number(o[b]);
    for(const [a,b] of Object.entries({occlusionDepthRange:'lightShaftOcclusionDepthRange',occlusionMaskDarkness:'lightShaftOcclusionMaskDarkness',shaftBloomScale:'lightShaftBloomScale',shaftBloomThreshold:'lightShaftBloomThreshold',shaftBloomTint:'lightShaftBloomTint'}))u[a].value=o[b];
    u.bloomConeCos.value=Math.cos(o.lightShaftBloomAngularRadius*Math.PI/180);
    u.manualEV.value=cameraEV100(o)-o.exposureCompensation;u.evRevision.value=this.evRevision;u.evResetRevision.value=this.evResetRevision;
    const scene=this.viewer.sceneRenderer;
    scene.msaaSamples=o.msaaSamples;
    scene.bevelOptions=o.shaderBevel&&o.shaderBevelStrength>0
      ?{radius:o.shaderBevelRadius,strength:o.shaderBevelStrength}:null;
    this._updateLens();
  }
  _updateLens() {
    const camera=this.viewer.camera;
    const fov=2*Math.atan(this.options.sensorWidth/(2*this.options.focalLength*camera.aspect))*180/Math.PI;
    if(camera.fov!==fov){camera.fov=fov;camera.updateProjectionMatrix();this.viewer.cameraRevision=(this.viewer.cameraRevision||0)+1;}
  }
  setSize(w,h) {
    if(!Number.isInteger(w)||!Number.isInteger(h)||w<1||h<1)throw new RangeError('PhysicalCamera dimensions must be positive integers');
    this.width=w;this.height=h;for(const t of [this.aerial,this.airScatter,this.shaftScene,this.dof])t.resize(w,h);
    for(const t of [this.shaftMask,this.shaftOcclusion,this.shaftBloomExtract,...this.shaftBloomLevels])t.resize(Math.max(1,Math.ceil(w/2)),Math.max(1,Math.ceil(h/2)));
    for(let i=0;i<5;i++)for(const texture of Object.values(this.bloomLevels[i]))texture.resize(Math.max(1,Math.ceil(w/2**(i+1))),Math.max(1,Math.ceil(h/2**(i+1))));
    this._updateLens();return this;
  }
  setDiagnosticMode(enabled){
    if(typeof enabled!=='boolean')throw new TypeError('Diagnostic mode must be boolean');
    this.diagnosticMode=enabled;this.viewer.sceneRenderer.diagnostic=enabled;
    this.params.fields.rawDiagnostic.value=Number(enabled);return this;
  }
  _outputPass(format,transfer){
    const key=format+':'+transfer;
    if(!this.outputPasses.has(key)){
      const conversion=transfer==='srgb'&&!format.endsWith('-srgb')?'apsSRGB(c)':'c';
      this.outputPasses.set(key,new FullscreenPass({label:'APS output '+key,modules:[this.exposureModule],colorFormats:[format],bindings:{
        composeSource:{texture:()=>this.diagnosticMode?this.viewer.sceneRenderer.sceneRT.texture:(this.options.depthOfField?this.dof:this.hdrSource)},
        shaftBloom:{texture:this.shaftBloomLevels[2]},
        ...Object.fromEntries(this.bloomLevels.map((b,i)=>['bloom'+i,{texture:b.blur}])),
      },code:COMPOSE_WGSL+`\nfn apsOutput(c:vec3f)->vec3f{return ${conversion};}`}));
    }
    return this.outputPasses.get(key);
  }
                                                                                
                                                                                 
  _prepareFXAA(format){
    if(!this.options.fxaa||!['rgba8unorm','bgra8unorm'].includes(format))return null;
    if(!this.fxaaPasses.has(format)){
      this.fxaaPasses.set(format,new FullscreenPass({label:'APS FXAA',colorFormats:[format],
        bindings:{fxaaInput:{texture:this.fxaaInput},
          fxaaDepth:{texture:()=>this.viewer.sceneRenderer.sceneRT.depthTexture},
          fxaaMotion:{texture:()=>this.viewer.sceneRenderer.velocityTexture}},code:FXAA_WGSL}));
    }
    this._outputPass(this.fxaaInput.format,'srgb');
    return this.fxaaPasses.get(format);
  }
  async prepareDestination(destination){
    const d=destination||{};this._outputPass(d.format??d.texture?.format??GPU.format,d.transfer??(destination?'linear':'srgb'));
    if(!d.viewport&&!d.scissor&&(d.transfer??(destination?'linear':'srgb'))==='srgb'){
      this._prepareFXAA(d.format??d.texture?.format??GPU.format);
    }
    await GPU.pipelinesReady();return this;
  }
  _writeOutput(destination){
    const d=destination||{};const format=d.format??d.texture?.format??GPU.format;
    const transfer=d.transfer??(destination?'linear':'srgb');
    if(!['linear','srgb'].includes(transfer))throw new TypeError('Output transfer must be linear or srgb');
    if(transfer==='linear'&&format.endsWith('-srgb'))throw new TypeError('Linear output needs a non-sRGB attachment');
    let pass=this._outputPass(format,transfer);
    let view=d.view;
    if(!view&&d.texture)view=d.texture.isTexture?d.texture.view({dimension:'2d',baseMipLevel:d.mip??0,mipLevelCount:1,baseArrayLayer:d.face??0,arrayLayerCount:1}):d.texture.createView({dimension:'2d',baseMipLevel:d.mip??0,mipLevelCount:1,baseArrayLayer:d.face??0,arrayLayerCount:1});
    if(!view){if(destination)throw new TypeError('Destination needs a texture or view');if(!GPU.context)throw new Error('Missing WebGPU canvas context');view=GPU.context.getCurrentTexture().createView();}
    if(d.viewport&&(!(d.viewport.length===6)||!d.viewport.every(Number.isFinite)||d.viewport[0]<0||d.viewport[1]<0||d.viewport[2]<=0||d.viewport[3]<=0||d.viewport[4]<0||d.viewport[5]>1||d.viewport[4]>d.viewport[5]))throw new RangeError('Invalid native viewport [x,y,width,height,minDepth,maxDepth]');
    if(d.scissor&&(!(d.scissor.length===4)||!d.scissor.every(x=>Number.isInteger(x)&&x>=0)))throw new RangeError('Invalid native scissor [x,y,width,height]');
    const fxaa=transfer==='srgb'&&!this.diagnosticMode&&!d.viewport&&!d.scissor
      ?this._prepareFXAA(format):null;
    if(fxaa){
      this.fxaaInput.resize(d.width??d.texture?.width??this.width,d.height??d.texture?.height??this.height);
      this._outputPass(this.fxaaInput.format,'srgb').render({colorViews:[this.fxaaInput],clear:[0,0,0,0]});
      pass=fxaa;
    }
    const rp=GPU.getEncoder().beginRenderPass({label:'APS destination',colorAttachments:[{view,loadOp:d.clear?'clear':'load',storeOp:'store',clearValue:d.clear??[0,0,0,0]}]});
    try{if(d.viewport)rp.setViewport(...d.viewport);if(d.scissor)rp.setScissorRect(...d.scissor);pass.draw(rp);}finally{rp.end();}
  }
  render(destination=null) {
    if(this.disposed)return;
    const {sceneRenderer:scene,camera}=this.viewer;
    if(camera.reversedDepth===false)throw new Error('PhysicalCamera requires native reversed-Z primary depth (clear 0; greater-equal)');
    if(scene.width!==this.width||scene.height!==this.height)this.setSize(scene.width,scene.height);
    const u=this.params.fields,w=this.lighting.weather;
    if(this.underwater)this.underwater.params.fields.enabled.value=this.ocean?.enabled?1:0;
    u.aerial.value=Number(w.aerialEnabled);
    this.shaftsActive=this.options.lightShafts>0 && w.directEnabled && this.lighting.environmentMode!=='external' && w.sunDirection[1]>.005;
    u.shafts.value=this.shaftsActive?this.options.lightShafts:0;
    const sun=projectLightShaftSun(this.lighting.worldSunDirection??w.sunDirection,camera.matrixWorldInverse?.elements,camera.projectionMatrix?.elements,this.options.lightShaftOverrideDirection);
    u.sunUV.value=sun.uv??[.5,.5];u.shaftDirection.value=sun.direction;u.sunFade.value=this.shaftsActive?sun.fade:0;
    this.occlusionActive=this.shaftsActive&&sun.fade>0&&w.aerialEnabled&&this.options.lightShaftOcclusion;
    this.shaftBloomActive=this.shaftsActive&&sun.fade>0&&this.options.lightShaftBloom&&this.options.lightShaftBloomScale>0;
    u.shaftBloomEnabled.value=Number(this.shaftBloomActive);
    G.exposure.value=1;
                                                                                     
    if(this.diagnosticMode){this.fogVolume.active=false;this._writeOutput(destination);this.frames++;return;}
                                                                                 
    this.lighting.renderView(camera,scene.sceneRT.depthTexture);
    this.postTime=(this.postTime+Math.max(0,G.dt.value)%4096)%4096;u.time.value=this.postTime;
    this.fogVolume.render(this.options);
    this.aerialPass.render({colorViews:[this.aerial,this.airScatter]});
    if(this.occlusionActive){this.shaftMaskPass.render({colorViews:[this.shaftMask]});this.shaftOcclusionPass.render({colorViews:[this.shaftOcclusion]});this.shaftApplyPass.render({colorViews:[this.shaftScene]});}
    this.meter.dispatch(1);
    if(this.options.depthOfField)this.dofPass.render({colorViews:[this.dof]});
    if(this.options.bloom>0 || this.options.glow>0)for(let i=0;i<5;i++) {
      const p=this.bloomPasses[i],b=this.bloomLevels[i];
      p.down.render({colorViews:[b.down]});p.horizontal.render({colorViews:[b.ping]});p.vertical.render({colorViews:[b.blur]});
    }
    if(this.shaftBloomActive){this.shaftExtractPass.render({colorViews:[this.shaftBloomExtract]});this.shaftBloomPasses.forEach((pass,i)=>pass.render({colorViews:[this.shaftBloomLevels[i]]}));}
    this._writeOutput(destination);
    this.frames++;
  }
  get depthTexture(){return this.viewer.sceneRenderer.sceneRT.depthTexture;}
  get hdrSource(){return this.occlusionActive?this.shaftScene:this.aerial;}
  metadata(){return {diagnostic:this.diagnosticMode,backend:'webgpu',options:this.options,frames:this.frames,size:[this.width,this.height],
    antialiasing:{fxaa:this.options.fxaa&&!this.diagnosticMode,msaa:this.options.msaaSamples,
      msaaCoverage:'opaque',fxaaCoverage:'scene objects and edges'},
    shaderBevel:{enabled:this.options.shaderBevel&&!this.diagnosticMode,radius_m:this.options.shaderBevelRadius,strength:this.options.shaderBevelStrength},
    ssao:this.ssao.metadata(),fog:{enabled:this.options.fog,method:'analytic height extinction + shadowed solar single scattering',composition:'after atmosphere, before exposure; underwater bypass',color:'linear unexposed HDR ambient source',volumetric_shadows:this.options.fogVolumetric&&this.options.fogShadows,volume:this.fogVolume.metadata()},
    exposure:{method:'GPU 64x64 center-weighted four-subsample finite logarithmic meter + temporal EV adaptation',auto:this.options.autoExposure,manualEV:cameraEV100(this.options),
      manualExposure:exposureFromEV(cameraEV100(this.options)-this.options.exposureCompensation,this.options.radianceScale),gpu_state:'EV/exposure held on GPU; no synchronous frame readback'},
    aerial:{camera_cloud_transport:this.lighting.cloudField.view.metadata(),external_HDR_air_fallback_steps:8,cloud_solar_source:'R1 16-sample continuous self-shadow',depth:'native current primary depth, read only'},
    bloom:{scales:5,format:'rgba16float',threshold:'exposed units, stored unexposed',highlight_peak:'soft bounded in exposed units before downsampling',max_brightness:this.options.bloomMaxBrightness,reconstruction:'positive cubic B-spline; no coarse bilinear grid'},glow:{enabled:this.options.glow>0,weights:[.02,.08,.18,.30,.42]},
    shafts:{active:!!this.shaftsActive,reference:'https://dev.epicgames.com/documentation/en-us/unreal-engine/light-shafts?application_version=4.27',method:'UE documented screen-space occlusion and radial bloom',samples:this.options.lightShaftSamples,resolution:[this.shaftMask.width,this.shaftMask.height],extra_volume_integration:false,occlusion:{active:!!this.occlusionActive,source:'closest depth 2x2, normalized radial visibility cubed',fade:this.params.fields.sunFade.value,affects:'existing atmosphere in-scattering MRT only',depth_range_m:this.options.lightShaftOcclusionDepthRange,mask_darkness:this.options.lightShaftOcclusionMaskDarkness},bloom:{active:!!this.shaftBloomActive,source:'exposed-threshold HDR scene including translucency and fog near sunlight direction',radial_passes:3,scale:this.options.lightShaftBloomScale,threshold:this.options.lightShaftBloomThreshold,tint:this.options.lightShaftBloomTint},sun_may_be_offscreen:true,fade_at_degrees:90},
    output:'opaque -> SSAO -> water/transparent -> current-depth camera cloud/air transport -> depth-aware air/water and scattering MRT -> shaft occlusion -> meter/DOF -> five-scale glow and three-pass directional bloom -> one exposure/ACES/output transfer; diagnostics bypass all effects',
    navigation_depth:'SceneRenderer.sceneRT.depthTexture retained without writes',
    limitations:['UE screen-space shafts cannot account for offscreen occluders','occlusion strength is limited by existing fog and atmosphere','shutter controls exposure; motion blur is not implemented','DOF is a 32-tap thin-lens approximation','water boundary uses native FFT displacement with a bounded first-crossing search; multiple wave crossings can be missed']};}
  dispose() {
    if(this.disposed)return;this.disposed=true;
    if(this.viewer.sceneRenderer.onAfterOpaque===this.opaqueHook)this.viewer.sceneRenderer.onAfterOpaque=this.previousOpaqueHook;this.ssao.dispose();this.fogVolume.dispose();
    const {camera,fov}=this.borrowedOptics;camera.fov=fov;camera.updateProjectionMatrix();this.viewer.cameraRevision=(this.viewer.cameraRevision||0)+1;
    releaseAfterSubmit(()=>{
      this.viewer.sceneRenderer.disposeSurfaceEffects();
      for(const t of [this.fxaaInput,this.aerial,this.airScatter,this.shaftScene,this.dof,this.shaftMask,this.shaftOcclusion,this.shaftBloomExtract,...this.shaftBloomLevels,...this.bloomLevels.flatMap(b=>Object.values(b))])t.destroy();
    this.exposureState.destroy();destroyUniform(this.params);
    this.underwater?.dispose();
    });
  }
}
