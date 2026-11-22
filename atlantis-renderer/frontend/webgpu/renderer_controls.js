import {applyRendererEnvironment,rendererEnvironment} from './renderer_environment.js';
import {oceanConfig} from './ocean_numeric.js';

// Every scene uses this inventory. Scene kind never selects another control set.
const n=(key,label,min,max,step=.1)=>({key,label,min,max,step});
const b=(key,label)=>({key,label,type:'checkbox'});
const v=(key,label,size=3)=>({key,label,type:'vector',size});
const s=(key,label,choices)=>({key,label,type:'select',choices});
export const WEATHER_PRESETS=Object.freeze({
 clear:{timeOfDay:14,cloudCoverage:.05,cloudDensity:1,rayleigh:1,mie:1,turbidity:2,directEnabled:true,displaySun:true,aerialEnabled:true},
 overcast:{timeOfDay:14,cloudCoverage:.8,cloudDensity:1,rayleigh:1,mie:1,turbidity:2,directEnabled:true,displaySun:true,aerialEnabled:true},
 sunset:{timeOfDay:17.5,sunDirection:[-1,.12,.3],cloudCoverage:.25,cloudDensity:1,rayleigh:1,mie:1,turbidity:2,directEnabled:true,displaySun:true,aerialEnabled:true},
});
// Log sliders keep large physical ranges usable while retaining numeric entry.
export function sliderValue(spec,position){
 const logarithmic=spec.min>0&&spec.max/spec.min>100;
 const value=logarithmic?spec.min*(spec.max/spec.min)**(position/1000):spec.min+(spec.max-spec.min)*position/1000;
 const step=spec.step??.1,rounded=step===1?Math.round(value):Number(value.toPrecision(6));
 return Math.max(spec.min,Math.min(spec.max,rounded));
}
export function sliderPosition(spec,value){
 if(!Number.isFinite(value))return 0;
 return Math.max(0,Math.min(1000,spec.min>0&&spec.max/spec.min>100?1000*Math.log(value/spec.min)/Math.log(spec.max/spec.min):1000*(value-spec.min)/(spec.max-spec.min)));
}
// Start on input; serialize resource replacement and coalesce only superseded
// values of the same control. A slow ocean edit must not block light/post edits.
export function liveControlQueue(apply,onError=console.error,onState=()=>{}){
 const lanes=new Map();
 const queue={
  get busy(){return [...lanes.values()].some(lane=>lane.running);},
  enqueue(key,value,laneKey='live'){
   let lane=lanes.get(laneKey);if(!lane){lane={pending:new Map(),running:false};lanes.set(laneKey,lane);}
   lane.pending.set(key,value);
   if(lane.running)return;
   lane.running=true;onState();
   (async()=>{
    try{while(lane.pending.size){const [key,next]=lane.pending.entries().next().value;lane.pending.delete(key);try{await apply(next);}catch(error){onError(error);}}}
    finally{lane.running=false;onState();}
   })();
  },
 };
 return queue;
}
export const CONTROL_GROUPS=Object.freeze([
 {id:'lighting',label:'光线与天空',target:'weather',controls:[n('environmentYaw','环境 Yaw 旋转 °',0,360,1),n('timeOfDay','太阳时刻',0,24),b('directEnabled','太阳直射'),b('displaySun','太阳光盘'),b('aerialEnabled','空气透视'),n('iblIntensity','天空 IBL 强度',0,100),v('sunDirection','太阳方向'),v('solarIrradiance','太阳 RGB 辐照度'),n('turbidity','浑浊度',1,20),n('rayleigh','瑞利散射',0,10),n('mie','米氏散射',0,10)]},
 {id:'clouds',label:'云',target:'weather',controls:[n('cloudCoverage','覆盖率',0,1,.01),n('cloudDensity','密度',0,20),n('cloudAltitude','底部高度 m',10,90000,10),n('cloudThickness','厚度 m',1,20000,10),n('cloudSeed','随机种子',-1e7,1e7,1),b('animateClouds','云动画'),n('cloudTime','云时间 s',-1e9,1e9,1)]},
 {id:'exposure',label:'曝光',target:'post',controls:[b('autoExposure','自动曝光'),n('exposureCompensation','曝光补偿 EV',-32,32,.25),n('aperture','光圈',.1,128),n('shutter','快门 s',.000001,3600,.001),n('iso','ISO',1,1e7,1),n('minEV','最低 EV',-64,64),n('maxEV','最高 EV',-64,64),n('adaptationUp','变亮速度',0,100),n('adaptationDown','变暗速度',0,100),n('radianceScale','辐亮度标度',.000001,1e9,1)]},
 {id:'ssao',label:'SSAO 接触遮蔽',target:'post',controls:[b('ssao','启用 SSAO'),n('ssaoRadius','半径 m',.01,1000,.01),n('ssaoIntensity','强度',0,4,.05),n('ssaoBias','偏移 m',0,10,.001)]},
 {id:'fog',label:'Fog 高度雾',target:'post',controls:[b('fog','启用高度雾'),b('fogVolumetric','体积散射'),b('fogShadows','体积阴影'),n('fogSteps','体积采样数',8,128,1),n('fogAnisotropy','前向散射',-.9,.9,.01),n('fogSunIntensity','太阳散射强度',0,20,.05),n('fogAmbientIntensity','环境散射强度',0,20,.05),n('fogDensity','密度 /m',0,10,.0001),v('fogColor','雾颜色（线性 RGB）'),n('fogBaseHeight','基准高度 m',-100000,100000,1),n('fogHeightFalloff','高度衰减 /m',0,10,.001),n('fogStart','开始距离 m',0,1000000,1),n('fogMaxDistance','最远积分距离 m',1,1000000,1),n('fogMaxOpacity','最大不透明度',0,1,.01)]},
 {id:'glow',label:'Glow 与 Bloom',target:'post',controls:[n('glow','Glow',0,3,.02),n('bloom','Bloom',0,10,.02),n('bloomThreshold','Bloom 阈值',0,65504),n('bloomMaxBrightness','Bloom 亮度上限',.001,65504)]},
 {id:'shafts',label:'Light Shaft',target:'post',controls:[n('lightShafts','光束强度',0,2,.02),b('lightShaftOcclusion','深度遮挡'),b('lightShaftBloom','光束 Bloom'),n('lightShaftDensity','密度',.1,1.5,.01),n('lightShaftDecay','衰减',.8,1,.001),n('lightShaftSamples','采样数',8,64,1),n('lightShaftOcclusionDepthRange','遮挡深度 m',1,100000,1),n('lightShaftOcclusionMaskDarkness','遮挡暗度',-2,2,.01),n('lightShaftBloomScale','Bloom 倍率',0,10),n('lightShaftBloomThreshold','Bloom 阈值',0,65504),n('lightShaftBloomAngularRadius','角半径 °',1,90),v('lightShaftBloomTint','RGB 色调'),v('lightShaftOverrideDirection','方向覆盖（0 为太阳）')]},
 {id:'shadows',label:'级联阴影',target:'shadows',controls:[b('enabled','启用级联阴影'),{...s('shadowMapSize','每级分辨率',[128,256,512,1024,2048,4096,8192]),target:'weather'}]},
 {id:'ocean',label:'海洋',target:'ocean',controls:[b('enabled','显示海洋'),b('paused','暂停海浪'),s('oceantype','海况',['deep','glass','tropical','storm']),n('stormylevel','风暴强度',0,1,.01),n('sealevel','海平面 m',-100000,100000),n('choppiness','波浪陡度',0,1,.01),v('winddirection','风向 XZ',2),n('seed','随机种子',0,2147483647,1),s('quality','质量',['low','medium','high']),n('maxDistance','最远距离 m',100,100000,100),b('wetness','岸边湿润'),b('spray','浪花粒子'),b('reflections','反射'),b('caustics','焦散'),n('causticShadowAttenuation','阴影内焦散',0,1,.05),n('causticCascadeMask','焦散级联掩码',1,15,1),n('causticMinimumStep','焦散柔化 m',1/128,2,.01),n('shoreShadowFadeDistance','岸边阴影渐变 m',0,20),n('shallowDepthDisplayMax','浅水显示上限 m',.01,20,.01),n('time','海浪回放时间 s',0,1e9,1)]},
 {id:'antialiasing',label:'抗锯齿',target:'post',controls:[b('fxaa','FXAA'),s('msaaSamples','MSAA',[1,4])]},
 {id:'shader-bevel',label:'Shader 倒角',target:'post',controls:[b('shaderBevel','启用倒角'),n('shaderBevelRadius','半径 m',.0001,1,.0000001),n('shaderBevelStrength','强度',0,1,.001)]},
 {id:'camera-effects',label:'相机与成像',target:'post',controls:[{...n('renderScale','空间超采样倍率',1,2,.25),target:'rendering'},n('focalLength','镜头焦距 mm',1,2000,1),n('sensorWidth','传感器宽度 mm',1,200,1),n('focusDistance','对焦距离 m',.001,1e9),b('depthOfField','景深'),n('vignette','暗角',0,1,.01),n('grain','颗粒',0,1,.01)]},
]);

export function installRendererControls(viewer,container,{onError=console.error,onChange=()=>{},includeGroups=null,labels={}}={}){
 const bindings=[];
 const groups=CONTROL_GROUPS.filter(group=>!includeGroups||includeGroups.includes(group.id));
 const localized=(key,fallback)=>labels[key]??fallback;
 const edits=liveControlQueue(async({patch,target})=>{await applyRendererEnvironment(viewer,patch);if(target==='weather')preset.value='custom';onChange();},onError,()=>sync());
 const presetLabel=document.createElement('label');presetLabel.className='control-row';presetLabel.textContent=localized('weatherPreset','天光预设');
 const preset=document.createElement('select');preset.id='control-weather-preset';preset.setAttribute('aria-label',localized('weatherPreset','天光预设'));
 for(const [key,label] of [['custom','当前 / 自定义'],['clear','晴天'],['overcast','阴天'],['sunset','日落']])preset.add(new Option(localized(key,label),key));
 presetLabel.append(preset);container.append(presetLabel);
 preset.onchange=async()=>{if(preset.value==='custom')return;try{await applyRendererEnvironment(viewer,{weather:WEATHER_PRESETS[preset.value]});onChange();sync();}catch(error){onError(error);}};
 function numericSlider(input,spec,id,commit){
  const range=document.createElement('input');range.type='range';range.min=0;range.max=1000;range.step=1;range.id=id;range.setAttribute('aria-label',spec.label+localized('sliderSuffix',' 滑动调整'));
  range.oninput=()=>{input.value=sliderValue(spec,Number(range.value));commit();};
  return range;
 }
 for(const group of groups){
  const section=document.createElement('details');section.dataset.controlGroup=group.id;section.open=['lighting','exposure'].includes(group.id);
  const heading=document.createElement('summary');heading.textContent=localized(group.id+'Group',group.label);section.append(heading);
  const note=document.createElement('p');note.className='control-note';section.append(note);
  for(const control of group.controls){
   const spec={...control,label:localized(control.key,control.label)};
   const label=document.createElement('label');label.className='control-row';const title=document.createElement('span');title.textContent=spec.label;label.append(title);
   const input=spec.type==='select'?document.createElement('select'):document.createElement('input');input.id=`control-${group.target}-${spec.key}`;input.dataset.option=spec.key;input.setAttribute('aria-label',spec.label);
   if(spec.type==='select')for(const choice of spec.choices)input.add(new Option(String(choice),String(choice)));
   else {input.type=spec.type==='checkbox'?'checkbox':spec.type==='vector'?'text':'number';if(spec.min!==undefined){input.min=spec.min;input.max=spec.max;input.step=spec.step;}if(spec.type==='vector')input.title=`${spec.size} 个数字，以逗号分隔`;}
   const sliders=[],parts=[];
   if(spec.type==='vector'){
    input.type='hidden';const cells=document.createElement('div');cells.className='vector-values';
    const bounds=(spec.key==='lightShaftBloomTint'||spec.key==='fogColor')?[0,20]:spec.key==='solarIrradiance'?[0,20]:[-1,1];
    for(let index=0;index<spec.size;index++){
     const part=document.createElement('input');part.type='number';part.step=.01;part.min=bounds[0];part.max=bounds[1];part.setAttribute('aria-label',spec.label+localized('componentSuffix',' 分量 ')+(index+1));
     const limits=n(spec.key,spec.label+localized('componentSuffix',' 分量 ')+(index+1),...bounds,.01);
     const update=()=>{input.value=parts.map(p=>p.value).join(',');input.dispatchEvent(new Event('change'));};
     const range=numericSlider(part,limits,`slider-${group.target}-${spec.key}-${index}`,update);
     part.onchange=update;parts.push(part);sliders.push({range,limits,part});
     const cell=document.createElement('div');cell.append(part,range);cells.append(cell);
    }
    label.classList.add('vector-row');label.append(input,cells);
   }else if(spec.min!==undefined){
    const pair=document.createElement('div');pair.className='numeric-pair';
    const range=numericSlider(input,spec,`slider-${group.target}-${spec.key}`,()=>input.dispatchEvent(new Event('change')));
    sliders.push({range,limits:spec,part:input});pair.append(input,range);label.append(pair);
   }else label.append(input);
   section.append(label);bindings.push({group,spec,input,note,sliders,parts});
   input.onchange=()=>{
    const target=spec.target??group.target;
    const value=spec.type==='checkbox'?input.checked:spec.type==='vector'?input.value.split(/[ ,]+/).filter(Boolean).map(Number):spec.type==='select'&&typeof spec.choices[0]==='string'?input.value:Number(input.value);
    try{
     if(spec.type==='vector'&&value.length!==spec.size)throw Error(`${spec.label} 需要 ${spec.size} 个数字`);
     if(target==='ocean'){
      if(!viewer.ocean)throw Error('当前场景未加载海洋');
     }
     const patch=target==='ocean'?{ocean:['paused','time'].includes(spec.key)?{[spec.key]:value}:{config:{[spec.key]:value}}}:{[target]:{[spec.key]:value}};
     edits.enqueue(`${target}.${spec.key}`,{patch,target},target==='ocean'?'ocean':'live');
    }catch(error){onError(error);}
   };
  }
  container.append(section);
 }
 function sync(committed=null){
  const hasVegetation=!!viewer.meshRenderer?.vegetationSystems?.size;lod.disabled=!hasVegetation;inspect.disabled=!hasVegetation;lod.value=String(viewer.vegetationLOD??'auto');
  density.disabled=![...(viewer.meshRenderer?.vegetationSystems??[])].some(s=>s.isGrass);density.value=String(viewer.grassDensityRetention??1);
  const state=viewer.renderPipeline&&viewer.lighting?rendererEnvironment(viewer):null;
  const ocean=state?.ocean??{config:oceanConfig({}),paused:false,time:0};
  preset.disabled=!state;
  for(const {group,spec,input,note,sliders,parts} of bindings){
   input.disabled=!state||(group.target==='ocean'&&!viewer.ocean);
   for(const {range,part} of sliders){range.disabled=input.disabled;part.disabled=input.disabled;}
   // Do not overwrite an edited value while its change is being applied.
   if(edits.busy)continue;
   if(document.activeElement===input||parts.includes(document.activeElement)||sliders.some(({range})=>range===document.activeElement))continue;
   const target=spec.target??group.target,value=target==='ocean'?(spec.key in ocean?ocean[spec.key]:ocean.config[spec.key]):state?.[target]?.[spec.key];
   if(spec.type==='checkbox')input.checked=!!value;else input.value=Array.isArray(value)?value.join(', '):value??'';
   for(let index=0;index<sliders.length;index++){const {range,limits,part}=sliders[index];if(parts.length)part.value=value?.[index]??0;range.value=sliderPosition(limits,Number(part.value));}
   note.textContent=group.id==='ocean'?(viewer.ocean?'海洋已加载 · 修改海况会重新计算频谱':'当前场景未加载海洋 · 控件保持显示'):group.id==='shadows'?localized('shadowCoverageNote','{count} 级世界空间阴影，覆盖范围随场景自动适配').replace('{count}',String(viewer.shadows?.count??4)):'';
  }
 }
 const vegetation=document.createElement('details'),vegetationHeading=document.createElement('summary');vegetation.dataset.controlGroup='vegetation';vegetationHeading.textContent='植被';vegetation.append(vegetationHeading);
 const lodLabel=document.createElement('label');lodLabel.className='control-row';lodLabel.textContent='植物 LOD';const lod=document.createElement('select');lod.setAttribute('aria-label','植物 LOD');
 for(const [value,label] of [['auto','自动'],['0','LOD0'],['1','LOD1'],['2','LOD2']])lod.add(new Option(label,value));lodLabel.append(lod);vegetation.append(lodLabel);
 lod.onchange=()=>{try{viewer.setVegetationLOD(lod.value==='auto'?'auto':Number(lod.value));onChange();}catch(error){onError(error);}};
 const densityLabel=document.createElement('label');densityLabel.className='control-row';densityLabel.textContent='草密度（8m 外）';const density=document.createElement('select');density.setAttribute('aria-label','草密度（8m 外）');
 for(const [value,label] of [['1','100%'],['0.5','50%'],['0.25','25%']])density.add(new Option(label,value));densityLabel.append(density);vegetation.append(densityLabel);
 const densityNote=document.createElement('small');densityNote.textContent='2m 内保留全部，2–8m 渐变；默认 100%，较低档位用于覆盖与性能对照。';vegetation.append(densityNote);
 density.onchange=()=>{try{viewer.setGrassDensity(Number(density.value));onChange();}catch(error){onError(error);}};
 const inspect=document.createElement('button');inspect.textContent='读取植被统计';const statistics=document.createElement('pre');statistics.setAttribute('aria-label','植被统计');statistics.style.cssText='white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;max-height:360px;overflow:auto';
 inspect.onclick=async()=>{inspect.disabled=true;try{statistics.textContent=JSON.stringify(await viewer.inspectVegetation(),null,2);}catch(error){onError(error);}finally{inspect.disabled=false;}};
 vegetation.append(inspect,statistics);if(!includeGroups||includeGroups.includes('vegetation'))container.append(vegetation);
 sync();return {sync,snapshot:()=>rendererEnvironment(viewer),groups:groups.map(group=>group.id)};
}
