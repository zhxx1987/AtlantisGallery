import {Material,ShaderModule} from '../../vendor/tidewater/src/engine/webgpu.js';
import {principledModule,principledSurfaceModule,principledLightingModule} from './principled_wgsl.js';
import {compileMaterialProgram,PRINCIPLED_SCALARS,wgslNumber as num} from './mesh_material_code.js';
import {MATERIAL_ID_ATTRIBUTE,MATERIAL_SLOT_ATTRIBUTE} from './mesh_model_merge.js';
import {rockSurfaceConfig,createRockSurfaceWGSL} from './rock_surface_recipe.js';
import {artificialLygiaModule,usesArtificialLygia} from './artificial_lygia.js';

const defaults={specular:.5,specularTint:0,anisotropy:0,subsurface:0,sheen:0,sheenTint:.5,clearcoat:0,clearcoatGloss:1};
function scalar(value,name,lo=0,hi=1) { if(!Number.isFinite(value)||value<lo||value>hi)throw Error(`Invalid mesh material ${name}`); return value; }
function vector(value,n,name) { if(!Array.isArray(value)||value.length!==n||!value.every(Number.isFinite))throw Error(`Invalid mesh material ${name}`);return value; }
const v3=a=>`vec3f(${a.map(num).join(',')})`;
const uvFor=i=>i===0?'in.uv':`in.vs.apsUv${i}`;

                                                                                
                                                                         
export function meshTextureSample(binding,uv,level=null) {
  const layer=binding?.layer;
  if(layer!==undefined&&layer!==null&&(!Number.isInteger(layer)||layer<0))throw Error(`Invalid texture array layer ${layer}`);
  const suffix=layer===undefined||layer===null?'':`,${binding.layerExpression??`${layer}u`}`;
  return level===null?`textureSample(${binding.name},${binding.samplerName},${uv}${suffix})`:`textureSampleLevel(${binding.name},${binding.samplerName},${uv}${suffix},${level})`;
}

export function textureCoordinate(info) {
  const transform=info.extensions?.KHR_texture_transform??{},index=transform.texCoord??info.texCoord??0;
  if(!Number.isInteger(index)||index<0||index>3)throw Error(`Unsupported texture coordinate ${index}`);
  return index;
}
export function textureTransform(info) {
  const t=info.extensions?.KHR_texture_transform??{},off=vector(t.offset??[0,0],2,'texture offset'),scale=vector(t.scale??[1,1],2,'texture scale');
  const angle=scalar(t.rotation??0,'texture rotation',-Infinity,Infinity),c=Math.cos(angle),s=Math.sin(angle);
  return {offset:off,matrix:[c*scale[0],s*scale[0],-s*scale[1],c*scale[1]],texCoord:textureCoordinate(info)};
}
const FRAME_WGSL=          `
struct APSMeshFrame { N: vec3f, T: vec3f, B: vec3f, };
struct APSContext {
  position: vec3f, worldPosition: vec3f, viewPosition: vec3f, normal: vec3f, tangent: vec3f, bitangent: vec3f,
  uv: vec2f, uvFootprint: vec2f, footprint_m: f32, opacity: f32, source: APSPrincipled,
};
var<private> apsMeshMaterial: APSPrincipled;
var<private> apsMeshTangent: vec3f;
#if APS_IMPOSTOR_LOCAL
fn apsImpostorLightFrame(L:vec3f)->APSMeshFrame {
  var f:APSMeshFrame;f.N=apsSafeNormal(L,vec3f(0,1,0));
  f.T=apsTangent(f.N,vec3f(1,0,0));f.B=cross(f.N,f.T);return f;
}
fn apsShadeImpostorDetail(m:APSPrincipled,s:Surface,P:vec3f,pixel:vec2f)->vec3f {
  let f=apsImpostorLightFrame(frame.sunDir);
  // This is the explicit proxy policy: each incident light sees a head-on
  // reference sample. Only map detail can tilt it, never card, terrain or view.
  // A virtual head-on V also prevents the ordinary thin-sheet back-face/NV
  // logic from turning the complete proxy dark when viewed against the light.
  let direct=apsDisneyDirect(m,f.N,f.N,f.T)*apsSunRadianceWithShadowNormal(P,m.normal,f.N,pixel);
  let env=apsDisneyEnvironment(m,f.N,f.T)+hookBounce(P,m.normal)*m.baseColor*(1-m.metallic)*m.occlusion;
  let detail=vec3f(dot(m.normal,f.T),dot(m.normal,f.B),dot(m.normal,f.N));
  let coat=vec3f(dot(m.clearcoatNormal,f.T),dot(m.clearcoatNormal,f.B),dot(m.clearcoatNormal,f.N));
  var local=vec3f(0);
  var localMask=apsMeshLocalLightMask(P);
  while(localMask!=0u){let i=firstTrailingBit(localMask);localMask=localMask & (localMask-1u);
    let light=apsMeshLocalLight(i,P,f.N,pixel);if(all(light.radiance==vec3f(0))){continue;}let lf=apsImpostorLightFrame(light.direction);
    var lm=m;lm.geometricNormal=lf.N;
    lm.normal=lf.T*detail.x+lf.B*detail.y+lf.N*detail.z;
    lm.clearcoatNormal=lf.T*coat.x+lf.B*coat.y+lf.N*coat.z;
    local+=apsDisneyDirect(lm,lf.N,lf.N,lf.T)*light.radiance;
  }
  return direct+env*hookAmbientModulation(P,m.normal)+local+m.emission;
}
#endif
fn apsMeshFrame(in: FragInput, uv: vec2f, authored: bool) -> APSMeshFrame {
#if APS_IMPOSTOR_LOCAL
  return apsImpostorLightFrame(frame.sunDir);
#else
  // This adapter disables the engine DOUBLE_SIDED flip. Start from the raw
  // interpolant, then reverse ALL mapped axes together (including derivatives).
  var f: APSMeshFrame; f.N=apsSafeNormal(in.vs.normal,in.N);
  let dx=dpdx(in.P); let dy=dpdy(in.P); let ux=dpdx(uv); let uy=dpdy(uv);
#if !APS_HAS_NORMAL
  f.N=apsSafeNormal(cross(dy,dx),in.N);
  f.N=select(-f.N,f.N,dot(f.N,in.V)>=0);
#if APS_MIRRORED
  f.N=select(-f.N,f.N,!in.front);
#else
  f.N=select(-f.N,f.N,in.front);
#endif
#endif
  let det=ux.x*uy.y-ux.y*uy.x;
  let inv=select(-1.0,1.0,det>=0)/max(abs(det),1e-12);
  f.T=apsTangent(f.N,(dx*uy.y-dy*ux.y)*inv);
  let candidateB=(dy*ux.x-dx*uy.x)*inv;
  var hand=select(-1.0,1.0,dot(cross(f.N,f.T),candidateB)>=0);
#if APS_HAS_TANGENT
  if(authored) {
    f.T=apsTangent(f.N,in.vs.apsWorldTangent.xyz);hand=in.vs.apsWorldTangent.w;
  }
#endif
  f.B=cross(f.N,f.T)*hand;
#if APS_DOUBLE_SIDED
#if APS_MIRRORED
  let face=select(-1.0,1.0,!in.front);
#else
  let face=select(-1.0,1.0,in.front);
#endif
  f.N*=face;f.T*=face;f.B*=face;
#endif
  return f;
#endif
}
fn apsMapNormal(c: vec3f, scale: f32, f: APSMeshFrame) -> vec3f {
  let n=(2*c-vec3f(1))*vec3f(scale,scale,1);
  return apsSafeNormal(f.T*n.x+f.B*n.y+f.N*n.z,f.N);
}
fn apsVisibleLeaf(input: APSPrincipled, V: vec3f) -> APSPrincipled {
  var m=input;
#if APS_IMPOSTOR_LOCAL
  return apsGuardPrincipled(m,frame.sunDir,frame.sunDir);
#else
#if APS_DOUBLE_SIDED
  // Authored foliage uses bent/smoothed card normals, which can cross the
  // viewing hemisphere even after winding is handled correctly. Both sides
  // use the same thin-sheet optical closure; orient that closure to its viewer.
  // This side selection is only for thin sheets; all materials subsequently
  // apply the same signed-cosine guard without changing authored normal data.
  if(m.diffuseTransmission>0) {
    // Orient the interpolant and its detail together. Independently flipping
    // the mapped normal would hide a hemisphere mismatch from the guard.
    let face=select(-1.0,1.0,dot(m.geometricNormal,V)>=0);
    m.geometricNormal*=face;m.normal*=face;m.clearcoatNormal*=face;
  }
#endif
  return apsGuardPrincipled(m,frame.sunDir,V);
#endif
}
`;

function nativeLayersCode(native,atlasBinding,alphaExpression,parameter) {
  if(native?.schema!=='aps-native-closures/1'||native.atlas_texture!=='normalTexture'||!Array.isArray(native.layers)||native.layers.length<1||native.layers.length>8||!Array.isArray(native.atlas_size)||native.atlas_size.length!==2||!native.atlas_size.every(n=>Number.isInteger(n)&&n>0&&n<=16384)||!atlasBinding)throw Error('Unsupported native material atlas schema/binding');
  if(atlasBinding.texture.width!==native.atlas_size[0]||atlasBinding.texture.height!==native.atlas_size[1])throw Error('Native material atlas dimensions differ from decoded image');
  const kinds={principled:0,translucent:1,diffuse:2,glossy:3,emission:4,transparent:5};
  const lines=[];let count=0;
  const size=parameter('nativeSize','vec2f',native.atlas_size);
  let tile=0;
  const sample=(map,component='r')=>{
    if(!map||!Array.isArray(map.rect)||map.rect.length!==4||!map.rect.every(Number.isFinite)||map.rect[0]<-1e-6||map.rect[1]<-1e-6||map.rect[2]<=0||map.rect[3]<=0||map.rect[0]+map.rect[2]>1+1e-6||map.rect[1]+map.rect[3]>1+1e-6||!['linear','srgb'].includes(map.encoding)||!Number.isFinite(map.scale)||map.scale<=0||!Number.isFinite(map.bias??0))throw Error('Invalid native material atlas tile');
    if(map.rect[2]*native.atlas_size[0]<1||map.rect[3]*native.atlas_size[1]<1)throw Error('Native material atlas tile below one pixel');
    const key='nativeTile'+tile++,rect=parameter(key,'vec4f',map.rect);
    return `apsNativeAtlasSample(in.uv,${rect},${map.encoding==='srgb'},${parameter(key+'Scale','f32',map.scale)},${parameter(key+'Bias','f32',map.bias??0)}).${component}`;
  };
  for(const layer of native.layers) {
    if(!(layer.kind in kinds))throw Error(`Unsupported native closure ${layer.kind}`);
    const params=layer.params??{},maps=layer.maps??{};
    for(const name of ['diffuseTransmission','transmissionThickness','transmissionColor']) {
      if(Object.hasOwn(params,name)||Object.hasOwn(maps,name))throw Error('Native closure thin foliage needs an explicit layer adapter');
    }
    const allowed=new Set([...PRINCIPLED_SCALARS,'anisotropyRotation','weight','alpha','ior','transmission','roughness','metallic','basecolor','normal','clearcoatNormal','subsurfaceColor','emission']);
    for(const key of [...Object.keys(params),...Object.keys(maps)])if(!allowed.has(key))throw Error(`Unsupported native material input ${key}`);
    if(maps.transmission||(params.transmission??0)!==0)throw Error('Native refractive transmission is unsupported');
    if(maps.ior)throw Error('Native mapped IOR requires a dielectric closure adapter; Disney 2012 uses explicit specular');
    for(const key of ['basecolor','normal','clearcoatNormal','subsurfaceColor','emission'])if(params[key]!==undefined)throw Error(`Native ${key} requires its atlas tile`);
    if(layer.kind==='transparent')continue;                                                      
    const i=count++,field=(name,fallback)=>maps[name]?sample(maps[name]):parameter(`native${i}_${name}`,'f32',scalar(params[name]??fallback,name,0,name==='weight'||name==='ior'?Infinity:1));
    lines.push(`var n${i}=apsPrincipledDefaults(f.N);`);
    if(!maps.basecolor||!maps.normal)throw Error('Native closure requires basecolor/normal tiles');
    lines.push(`n${i}.baseColor=${sample(maps.basecolor,'rgb')};`,`n${i}.normal=apsMapNormal(${sample(maps.normal,'rgb')},1.0,nativeFrame);`,`n${i}.clearcoatNormal=n${i}.normal;n${i}.subsurfaceColor=n${i}.baseColor;`);
    for(const [name,def] of Object.entries({...defaults,roughness:.5,metallic:0,occlusion:1}))lines.push(`n${i}.${name}=${field(name,def)};`);
    if(maps.subsurfaceColor)lines.push(`n${i}.subsurfaceColor=${sample(maps.subsurfaceColor,'rgb')};`);
    lines.push(`n${i}.subsurfaceColorWeight=${field('subsurfaceColorWeight',maps.subsurfaceColor?1:0)};`);
    if(maps.clearcoatNormal)lines.push(`n${i}.clearcoatNormal=apsMapNormal(${sample(maps.clearcoatNormal,'rgb')},1.0,nativeFrame);`);
    if(maps.emission)lines.push(`n${i}.emission=${sample(maps.emission,'rgb')};`);
    const rotation=field('anisotropyRotation',0);
    lines.push(`apsMeshLayers[${i}]=apsSanitize(n${i},f.N);apsMeshLayers[${i}].baseColor=max(n${i}.baseColor,vec3f(0));apsMeshLayers[${i}].subsurfaceColor=max(n${i}.subsurfaceColor,vec3f(0));`,`apsMeshWeights[${i}]=${field('weight',1)}*${field('alpha',1)}/max(${alphaExpression},1e-8);`,`apsMeshKinds[${i}]=${kinds[layer.kind]}u;`,`apsMeshRotations[${i}]=${rotation};`);
  }
  return {surface:lines.join('\n'),module:          `
var<private> apsMeshLayers: array<APSPrincipled,8>;
var<private> apsMeshWeights: array<f32,8>;
var<private> apsMeshKinds: array<u32,8>;
var<private> apsMeshRotations: array<f32,8>;
fn apsNativeAtlasSample(uv: vec2f, rect: vec4f, srgb: bool, scale: f32, bias: f32) -> vec4f {
  let lo=rect.xy+0.5/${size};let hi=rect.xy+rect.zw-0.5/${size};
  let at=clamp(rect.xy+uv*rect.zw,lo,hi);
  var value=${meshTextureSample(atlasBinding,'at','0.0')};
  if(srgb) { value=vec4f(apsSrgbToLinear(value.rgb),value.a); }
  return vec4f(value.rgb*scale+vec3f(bias),value.a);
}
fn apsNativeDirect(i: u32, L: vec3f, V: vec3f, tangent: vec3f) -> vec3f {
  let m=apsGuardPrincipled(apsMeshLayers[i],L,V);let kind=apsMeshKinds[i];
  if(dot(m.normal,V)<=0) { return vec3f(0); }
  let X=apsTangent(m.normal,tangent);let Y=cross(m.normal,X);let angle=apsMeshRotations[i]*TWO_PI;
  let T=X*cos(angle)+Y*sin(angle);
  if(kind==0u) { return apsDisneyDirect(m,L,V,T); }
  if(kind==1u) { return m.baseColor*max(-dot(m.normal,L),0)/PI; }
  if(kind==2u) { return apsDiffuseDirect(m,L,V); }
  if(kind==3u) { return apsGlossyDirect(m,L,V); }
  return vec3f(0);
}
fn apsShadeNative(s: Surface, P: vec3f, V: vec3f, pixel: vec2f, tangent: vec3f) -> vec3f {
  var result=vec3f(0);
  let sun=apsSunRadiance(P,s.normal,pixel);
  for(var i=0u;i<${count}u;i++) {
    let m=apsGuardPrincipled(apsMeshLayers[i],frame.sunDir,V);let kind=apsMeshKinds[i];let nl=dot(m.normal,frame.sunDir);
    if(dot(m.normal,V)<=0) { continue; }
    let X=apsTangent(m.normal,tangent);let Y=cross(m.normal,X);let angle=apsMeshRotations[i]*TWO_PI;
    let T=X*cos(angle)+Y*sin(angle); var direct=vec3f(0);var env=vec3f(0);
    if(kind==0u) {
      direct=apsDisneyDirect(m,frame.sunDir,V,T);env=apsDisneyEnvironment(m,V,T);
      env+=hookBounce(P,m.normal)*m.baseColor*(1-m.metallic)*m.occlusion;
    } else if(kind==1u) {
      direct=m.baseColor*max(-nl,0)/PI;env=hookEnvDiffuse(-m.normal)*m.baseColor*m.occlusion;
    } else if(kind==2u) {
      direct=apsDiffuseDirect(m,frame.sunDir,V);
      let dfg=apsPrincipledDFG(max(dot(m.normal,V),0),m.roughness);
      env=(hookEnvDiffuse(m.normal)*dfg.w+hookBounce(P,m.normal))*m.baseColor*m.occlusion;
    } else if(kind==3u) {
      direct=apsGlossyDirect(m,frame.sunDir,V);
      let dfg=apsPrincipledDFG(max(dot(m.normal,V),0),m.roughness);
      env=hookEnvSpecular(reflect(-V,m.normal),m.roughness)*clamp(m.baseColor,vec3f(0),vec3f(1))*clamp(dfg.x+dfg.y,0,1)*m.occlusion;
    }
    direct=apsNativeDirect(i,frame.sunDir,V,tangent);
    var local=vec3f(0);
    var localMask=apsMeshLocalLightMask(P);
    while(localMask!=0u){let j=firstTrailingBit(localMask);localMask=localMask & (localMask-1u);
      let light=apsMeshLocalLight(j,P,m.normal,pixel);
      if(all(light.radiance==vec3f(0))){continue;}
      local+=apsNativeDirect(i,light.direction,V,tangent)*light.radiance;
    }
    // Emission is per-layer, already HDR decoded. Never add the fallback emission twice.
    result+=apsMeshWeights[i]*(direct*sun+local+env*hookAmbientModulation(P,m.normal)+m.emission);
  }
  return result;
}
`};
}

                                                                                 
                                                                               
export function createMeshMaterial(definition={}, {textureBindings={},code='return ctx.source;',materialId=null,hasNormal=true,hasTangent=false,uvSets=[0],topology='triangle-list',mirrored=false,lighting=principledLightingModule,materialLibrary='',materialTextures={},normalFrame='surface',rockLayers=null}={}) {
  if(!['surface','impostor-local'].includes(normalFrame))throw Error('Invalid mesh normal frame');
  const impostorLocal=normalFrame==='impostor-local';
  const extra=definition.extras??{},pbr=definition.pbrMetallicRoughness??{},ext=definition.extensions??{};
  const artificialLygia=usesArtificialLygia(definition);
  const base=vector(pbr.baseColorFactor??[1,1,1,1],4,'baseColorFactor').map(v=>scalar(v,'baseColorFactor'));
  const emission=vector(definition.emissiveFactor??[0,0,0],3,'emissiveFactor').map(v=>scalar(v,'emissiveFactor'));
  const strength=scalar(ext.KHR_materials_emissive_strength?.emissiveStrength??1,'emissiveStrength',0,Infinity);
  const metallic=scalar(pbr.metallicFactor??1,'metallicFactor'),roughness=scalar(pbr.roughnessFactor??1,'roughnessFactor');
  const alphaMode=definition.alphaMode??'OPAQUE';if(!['OPAQUE','MASK','BLEND'].includes(alphaMode))throw Error('Unsupported alphaMode');
  const alphaCutoff=scalar(definition.alphaCutoff??.5,'alphaCutoff');
  const unlit=!!ext.KHR_materials_unlit,native=extra.native_material;
  const rockSurface=extra.procedural_rock_surface===undefined?null:rockSurfaceConfig(extra.procedural_rock_surface);
  if(artificialLygia&&(rockSurface||native||unlit||impostorLocal))throw Error('Artificial LYGIA surfaces require ordinary lit mesh PBR with explicit composition');
  if(extra.rock_pbr_layers&&!rockLayers)throw Error('Rock PBR layers were not loaded');
  if(rockLayers&&rockSurface?.schema!=='aps-rock-lygia/1')throw Error('Rock PBR layers require the global LYGIA rock graph');
  if(rockSurface&&(unlit||native||impostorLocal))throw Error('Procedural rock surface requires ordinary lit mesh PBR');
  if(native&&(textureBindings.leafTransmission||textureBindings.leafMask||['diffuseTransmission','transmissionThickness','transmissionColor'].some(k=>Object.hasOwn(extra.principled??{},k))))throw Error('Native closure thin foliage needs an explicit layer adapter');
  if(native&&code.trim()!=='return ctx.source;')throw Error('Native closure atlas and authored GLSL require explicit composition');
  if(unlit&&(native||code.trim()!=='return ctx.source;'))throw Error('Authored mat_code requires a PBR material');
  if(impostorLocal&&(native||unlit||alphaMode!=='MASK'||!definition.doubleSided))throw Error('Local impostor frame requires double-sided masked PBR');
  const bindings={},samples={},sampleFunctions=[],parameters={};
  const parameter=(name,type,value)=>{parameters['aps_'+name]=[type,value];return 'mat.aps_'+name;};
  const parameterBinding=(slot,b)=>b.layer===undefined||b.layer===null?b:{...b,layerExpression:parameter('layer_'+slot,'u32',b.layer)};
  for(const [slot,b] of Object.entries(textureBindings)) {
    const tf=textureTransform(b.info);if(!uvSets.includes(tf.texCoord))throw Error(`Texture ${slot} requires missing TEXCOORD_${tf.texCoord}`);
    const array=b.layer!==undefined&&b.layer!==null;
    if(array&&b.texture?.dimension!=='2d-array')throw Error(`Texture ${slot} layer requires a 2D array texture`);
    if(!array&&b.texture?.dimension==='2d-array')throw Error(`Texture ${slot} array texture requires an explicit layer`);
    bindings[b.name]={texture:b.texture};bindings[b.samplerName]={sampler:b.sampler};
    const u=`apsMeshUv_${slot}`;
    const matrix=parameter('uvMatrix_'+slot,'vec4f',tf.matrix),offset=parameter('uvOffset_'+slot,'vec2f',tf.offset);
    sampleFunctions.push(`fn ${u}(in: FragInput) -> vec2f { return mat2x2f(${matrix}.xy,${matrix}.zw)*${uvFor(tf.texCoord)}+${offset}; }`);
    samples[slot]=meshTextureSample(parameterBinding(slot,b),`${u}(in)`);
  }
  const attributes={},varyings={apsLocalPosition:'vec3f'},vertex=['o.apsLocalPosition=v.position;'];
  for(const index of uvSets)if(index>0){attributes['uv'+index]='vec2f';varyings['apsUv'+index]='vec2f';vertex.push(`o.apsUv${index}=v.uv${index};`);}
  if(hasTangent){attributes.tangent='vec4f';varyings.apsWorldTangent='vec4f';vertex.push('let det=dot(cross(v.model[0].xyz,v.model[1].xyz),v.model[2].xyz);','o.apsWorldTangent=vec4f((v.model*vec4f(v.tangent.xyz,0)).xyz,v.tangent.w*select(-1.0,1.0,det>=0));');}
  vertex.push('v.useWorld=true;v.worldPos=(v.model*vec4f(v.position,1)).xyz;','v.worldNormal=cofactor3(v.model)*v.normal*select(-1.0,1.0,dot(cross(v.model[0].xyz,v.model[1].xyz),v.model[2].xyz)>=0);','v.prevWorldPos=(v.prevModel*vec4f(v.position,1)).xyz;');
  const normalBinding=textureBindings.normal;
  const normalUV=normalBinding?`apsMeshUv_normal(in)`:'in.uv';
  const authored=hasTangent&&(!normalBinding||textureCoordinate(normalBinding.info)===0)&&!(normalBinding?.info.extensions?.KHR_texture_transform);
  const surface=[...(!unlit?['apsPrepareLighting(in.P);']:[]),'var base=vec4f(mat.color*in.color.rgb,mat.opacity*in.color.a);'];
  if(samples.base)surface.push(`base*= ${samples.base};`);
  if(samples.opacity)surface.push(`base.a*= ${samples.opacity}.r;`);
  surface.push(`let f=apsMeshFrame(in,${normalUV},${authored});`,`var m=apsPrincipledDefaults(f.N);`,'m.baseColor=base.rgb;m.metallic=mat.metalness;m.roughness=mat.roughness;m.emission=mat.emissive;');
  if(samples.mr)surface.push(`let mr=${samples.mr};m.roughness*=mr.g;m.metallic*=mr.b;`);
  if(samples.ao)surface.push(`m.occlusion=mix(1.0,${samples.ao}.r,${parameter('aoStrength','f32',scalar(definition.occlusionTexture?.strength??1,'AO strength'))});`);
  if(samples.emissive)surface.push(`m.emission*=${samples.emissive}.rgb;`);
  if(samples.normal)surface.push(`m.normal=apsMapNormal(${samples.normal}.rgb,${parameter('normalScale','f32',scalar(definition.normalTexture?.scale??1,'normal scale',-Infinity,Infinity))},f);`);
  surface.push('m.subsurfaceColor=m.baseColor;');
  const structured=extra.principled??{};
  for(const [name,value] of Object.entries(structured).sort(([a],[b])=>a.localeCompare(b))) {
    if(PRINCIPLED_SCALARS.includes(name))surface.push(`m.${name}=${parameter(name,'f32',scalar(value,name,0,name==='transmissionThickness'?4:1))};`);
    else if(['baseColor','emission','subsurfaceColor','transmissionColor'].includes(name))surface.push(`m.${name}=${parameter(name,'vec3f',vector(value,3,name).map(v=>scalar(v,name,0,name==='transmissionColor'?1:Infinity)))};`);
    else throw Error(`Unsupported structured Principled input ${name}`);
  }
  for(const [name,value] of Object.entries(defaults))if(structured[name]===undefined)surface.push(`m.${name}=${num(value)};`);
  if(samples.leafMask)surface.push(`m.diffuseTransmission*= ${samples.leafMask}.r;`);
  if(samples.leafTransmission)surface.push(`m.transmissionColor*= ${samples.leafTransmission}.rgb;`);
  surface.push('m.clearcoatNormal=m.normal;');
  const cc=ext.KHR_materials_clearcoat;
  if(cc){surface.push(`m.clearcoat=${parameter('coatFactor','f32',scalar(cc.clearcoatFactor??0,'clearcoatFactor'))};`,`let ccR=${parameter('coatRoughness','f32',scalar(cc.clearcoatRoughnessFactor??0,'clearcoatRoughnessFactor'))}${samples.coatR?`*${samples.coatR}.g`:''};`,`m.clearcoatGloss=clamp((0.1-ccR*ccR)/0.099,0.0,1.0);`);if(samples.coat)surface.push(`m.clearcoat*=${samples.coat}.r;`);if(samples.coatNormal)surface.push(`m.clearcoatNormal=apsMapNormal(${samples.coatNormal}.rgb,${parameter('coatNormalScale','f32',scalar(cc.clearcoatNormalTexture?.scale??1,'clearcoat normal scale',-Infinity,Infinity))},apsMeshFrame(in,apsMeshUv_coatNormal(in),false));`);}
  surface.push(`let alpha=${alphaMode==='OPAQUE'?'1.0':'base.a'};`,`var ctx: APSContext;ctx.position=in.vs.apsLocalPosition;ctx.worldPosition=in.P;ctx.uv=in.uv;ctx.uvFootprint=fwidth(in.uv);ctx.footprint_m=max(length(dpdx(in.P)),length(dpdy(in.P)));ctx.opacity=alpha;`,`let viewBasis=mat3x3f(frame.view[0].xyz,frame.view[1].xyz,frame.view[2].xyz);`,`ctx.viewPosition=viewBasis*in.P;ctx.normal=viewBasis*m.normal;let contextFrame=apsMeshFrame(in,in.uv,${hasTangent});let contextT=apsTangent(m.normal,contextFrame.T);let contextHand=select(-1.0,1.0,dot(cross(contextFrame.N,contextFrame.T),contextFrame.B)>=0);ctx.tangent=viewBasis*contextT;ctx.bitangent=viewBasis*(cross(m.normal,contextT)*contextHand);ctx.source=m;ctx.source.normal=viewBasis*m.normal;ctx.source.clearcoatNormal=viewBasis*m.clearcoatNormal;ctx.source.geometricNormal=viewBasis*m.geometricNormal;`,`m=apsEvaluateMaterial(ctx);${samples.coatNormal?'':'m.clearcoatNormal=m.normal;'}m.normal=transpose(viewBasis)*m.normal;m.clearcoatNormal=transpose(viewBasis)*m.clearcoatNormal;`,`apsMeshMaterial=apsVisibleLeaf(apsSanitize(m,f.N),in.V);apsMeshTangent=contextT;`,`*s=apsSurfaceFromPrincipled(apsMeshMaterial,alpha);`);
  if(rockSurface)surface.splice(surface.length-2,0,`
let rockSurface=apsRockSurfaceSample(in.P);
${rockLayers?`let rockPBR=apsRockPBR(in.P,f.N,dpdx(in.P),dpdy(in.P),rockSurface.masks,rockSurface.rockTint);
m.baseColor=mix(m.baseColor,rockPBR.color*(1.-.65*rockSurface.fracture),APS_ROCK_STRENGTH);
m.roughness=mix(m.roughness,clamp(rockPBR.roughness+.10*rockSurface.fracture,.04,1.),APS_ROCK_STRENGTH);
m.occlusion=mix(m.occlusion,rockPBR.ao,APS_ROCK_STRENGTH);
m.normal=apsRockSurfaceNormal(normalize(mix(m.normal,rockPBR.normal,APS_ROCK_STRENGTH)),f.N,in.P,rockSurface.height,APS_ROCK_STRENGTH);
m.clearcoatNormal=m.normal;`:`
m.baseColor=mix(m.baseColor,rockSurface.color,APS_ROCK_STRENGTH);
m.roughness=mix(m.roughness,rockSurface.roughness,APS_ROCK_STRENGTH);
m.normal=apsRockSurfaceNormal(m.normal,f.N,in.P,rockSurface.height,APS_ROCK_STRENGTH);
m.clearcoatNormal=apsRockSurfaceNormal(m.clearcoatNormal,f.N,in.P,rockSurface.height,APS_ROCK_STRENGTH);`}
${rockSurface.schema==='aps-rock-lygia/1'&&rockSurface.debug!=='pbr'?`m.emission=${rockSurface.debug==='normal'?'m.normal*.5+.5':rockLayers&&rockSurface.debug==='albedo'?'m.baseColor':rockLayers&&rockSurface.debug==='roughness'?'vec3f(m.roughness)':rockLayers&&rockSurface.debug==='masks'?'rockPBR.weights':'rockSurface.color'};m.baseColor=vec3f(0.);m.specular=0.;m.clearcoat=0.;`:''}`);
  let nativeCode=null;if(native){nativeCode=nativeLayersCode(native,parameterBinding('normal',textureBindings.normal),'alpha',parameter);surface.push(`let nativeFrame=apsMeshFrame(in,in.uv,${hasTangent});`,nativeCode.surface);}
  const aliases={map:'base',metalnessMap:'mr',roughnessMap:'mr',normalMap:'normal',aoMap:'ao',emissiveMap:'emissive',clearcoatMap:'coat',clearcoatRoughnessMap:'coatR',clearcoatNormalMap:'coatNormal'};
  const textures={};for(const [name,b] of Object.entries(materialTextures))textures[name]=parameterBinding(name,b);for(const [name,slot] of Object.entries(aliases))if(textureBindings[slot])textures[name]=parameterBinding(slot,textureBindings[slot]);
  for(const b of Object.values(materialTextures)){bindings[b.name]={texture:b.texture};bindings[b.samplerName]={sampler:b.sampler};}
  const program=compileMaterialProgram(code,{materialLibrary,textures,lygia:artificialLygia,floatUniformPrefix:'apsRecipeFloat'});const body=program.body;
  const module=new ShaderModule({name:'aps-mesh-material',deps:[principledModule,principledSurfaceModule,...(!unlit?[lighting]:[]),...(artificialLygia?[artificialLygiaModule]:[])],code:FRAME_WGSL+'\n'+sampleFunctions.join('\n')+'\n'+program.library+`\nfn apsEvaluateMaterial(ctx: APSContext) -> APSPrincipled {\n${body}\n}\n`+(nativeCode?.module??'')});
  if(rockSurface)module.code+='\n'+createRockSurfaceWGSL(rockSurface);
  if(rockLayers)module.deps.push(rockLayers.module);
  // Gallery SSR uses the spare, otherwise unused velocity attachment for opaque surface data.
  const output=unlit?'r.color=vec4f(s.albedo,s.alpha);':`
#if APS_SHADER_BEVEL
apsMeshMaterial.normal=s.normal;
apsMeshMaterial.clearcoatNormal=s.clearcoatNormal;
#endif
r.color=vec4f(${impostorLocal?'apsShadeImpostorDetail(apsMeshMaterial,s,in.P,in.pixel)':native?'apsShadeNative(s,in.P,in.V,in.pixel,apsMeshTangent)':'apsShadePrincipled(apsMeshMaterial,s,in.P,in.V,in.pixel,apsMeshTangent)'},s.alpha);
    let galleryViewNormal=normalize((frame.view*vec4f(apsMeshMaterial.normal,0.0)).xyz);
    r.velocity=vec4f(galleryViewNormal*(1.0+apsMeshMaterial.roughness),.04+.96*apsMeshMaterial.metallic);`;
  const material=new Material({name:definition.name??'glTF material',modules:[module],attributes,varyings,vertex:vertex.join('\n'),surface:surface.join('\n'),output,bindings,uniforms:{...parameters,...program.floatUniforms},lit:false,color:base.slice(0,3),opacity:base[3],roughness,metalness:metallic,emissive:emission.map(v=>v*strength),vertexColors:true,side:definition.doubleSided?'double':mirrored?'back':'front',transparent:alphaMode==='BLEND',alphaTest:alphaMode==='MASK'?alphaCutoff:0,depthWrite:alphaMode!=='BLEND',topology,receiveShadows:true,defines:{APS_HAS_NORMAL:hasNormal?1:0,APS_HAS_TANGENT:hasTangent?1:0,APS_DOUBLE_SIDED:definition.doubleSided?1:0,APS_MIRRORED:mirrored?1:0,APS_IMPOSTOR_LOCAL:impostorLocal?1:0,APS_MESH_PBR:unlit||impostorLocal?0:1},userData:{...extra,material_id:materialId,sourceMaterial:definition,normalFrame,materialAdapter:'aps-native-webgpu/1',dfg:lighting===principledLightingModule?'preintegrated-64x64-512-samples':'provided-module'}});
  const drySurface=material.surface,baseDeps=[...module.deps];
  material.setOceanReceiver=function(receiver){
    receiver=receiver??null;if((material.oceanReceiver??null)===receiver)return;material.oceanReceiver=receiver;
    module.deps=[...baseDeps,...(receiver?[receiver]:[])];
    material.surface=receiver?drySurface.replace('apsMeshMaterial=apsVisibleLeaf(apsSanitize(m,f.N),in.V);',`apsMeshMaterial=apsVisibleLeaf(apsSanitize(m,f.N),in.V);
let wetReceiver=oceanApplyReceiverMaterial(in.P,ctx.footprint_m,apsMeshMaterial.baseColor,apsMeshMaterial.roughness,apsMeshMaterial.clearcoat,apsMeshMaterial.clearcoatGloss);
apsMeshMaterial.baseColor=wetReceiver.baseColor;apsMeshMaterial.roughness=wetReceiver.roughness;
apsMeshMaterial.clearcoat=wetReceiver.clearcoat;apsMeshMaterial.clearcoatGloss=wetReceiver.clearcoatGloss;`):drySurface;
    material.needsUpdate=true;
  };
                                                                                  
  if(alphaMode==='MASK') {
                                                                                
                                                                               
    const mask=`mat.opacity*in.color.a${samples.base?'*('+samples.base+').a':''}${samples.opacity?'*('+samples.opacity+').r':''}`;
    material.shadow=native?'let s=surfaceOf(in);return s.alpha>=mat.alphaTest;':`return (${mask})>=mat.alphaTest;`;
    if(!native){
      const coverageBindings={};for(const slot of ['base','opacity']){const b=textureBindings[slot];if(b){coverageBindings[b.name]=bindings[b.name];coverageBindings[b.samplerName]=bindings[b.samplerName];}}
      const coverageUVs=[...new Set(['base','opacity'].filter(k=>textureBindings[k]).map(k=>textureTransform(textureBindings[k].info).texCoord))];
      const coverageVaryings={},coverageAttributes={};const coverageVertex=[];
      for(const i of coverageUVs)if(i>0){coverageAttributes['uv'+i]='vec2f';coverageVaryings['apsUv'+i]='vec2f';coverageVertex.push(`o.apsUv${i}=v.uv${i};`);}
      material.userData.apsCoverageDepth={uniforms:parameters,bindings:coverageBindings,attributes:coverageAttributes,varyings:coverageVaryings,vertex:coverageVertex.join('\n'),module:new ShaderModule({name:'aps-native-alpha-coverage',code:sampleFunctions.filter(fn=>/^fn apsMeshUv_(base|opacity)\(/.test(fn)).join('\n')})};
    }
  }
  material.allDefines=function(){return {...Material.prototype.allDefines.call(this),DOUBLE_SIDED:0,BACK_SIDE:0,ALPHA_TEST:alphaMode==='MASK'?1:0};};
  return material;
}

                                                                              
                                                                              
                                                                                  
                                                                               
                                                                                   
                                                                                  
                                                                 
const GLSL_TYPES=new Set(['float','int','uint','bool','vec2','vec3','vec4','ivec2','ivec3','ivec4','uvec2','uvec3','uvec4','mat2','mat3','mat4','void','PrincipledMaterial','MaterialContext']);
const MODEL_SANITIZE='apsMeshMaterial=apsVisibleLeaf(apsSanitize(m,f.N),in.V);';
const MODEL_RECEIVER=`
let wetReceiver=oceanApplyReceiverMaterial(in.P,ctx.footprint_m,apsMeshMaterial.baseColor,apsMeshMaterial.roughness,apsMeshMaterial.clearcoat,apsMeshMaterial.clearcoatGloss);
apsMeshMaterial.baseColor=wetReceiver.baseColor;apsMeshMaterial.roughness=wetReceiver.roughness;
apsMeshMaterial.clearcoat=wetReceiver.clearcoat;apsMeshMaterial.clearcoatGloss=wetReceiver.clearcoatGloss;`;
function scrubComments(source) { return source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,m=>' '.repeat(m.length)); }
                                                                                 
                                                                             
export function librarySymbols(source='') {
  const names=new Set();
  if(!source.trim())return names;
  const tokens=scrubComments(source).match(/[A-Za-z_]\w*|[{}();,]|[^\s]/g)??[];
  let braces=0,parens=0,inDeclaration=false;
  for(let i=0;i<tokens.length;i++) {
    const token=tokens[i];
    if(token==='{'){braces++;inDeclaration=false;continue;}
    if(token==='}'){braces--;inDeclaration=false;continue;}
    if(token==='('){parens++;continue;}
    if(token===')'){parens--;continue;}
    if(braces!==0||parens!==0)continue;
    if(inDeclaration&&token===','){const name=tokens[i+1];if(name&&/^[A-Za-z_]\w*$/.test(name)){names.add(name);i++;}continue;}
    if(inDeclaration&&token===';'){inDeclaration=false;continue;}
    if(GLSL_TYPES.has(token)){const name=tokens[i+1];if(name&&/^[A-Za-z_]\w*$/.test(name)){names.add(name);inDeclaration=true;i++;}}
  }
  return names;
}
                                                                                  
export function suffixAuthoredSymbols(source,names,suffix) {
  if(!names.size)return source;
  for(const name of names)if(new RegExp(`\\b${name}${suffix}\\b`).test(source))throw Error(`Authored symbol collision ${name}${suffix}`);
  const pattern=/\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_]\w*/g;
  return source.replace(pattern,token=>names.has(token)?token+suffix:token);
}
function assertNoLocalShadowing(source,names) {
  const text=scrubComments(source);
  for(const name of names)for(const match of text.matchAll(/([A-Za-z_]\w*)\s+([A-Za-z_]\w*)\s*[=;,)]/g))
    if(GLSL_TYPES.has(match[1])&&match[2]===name)throw Error(`Authored local ${name} shadows a shared library symbol`);
  return source;
}
                                                                               
function dispatchParameterLines(entry) {
  const definition=entry.definition??{},extra=definition.extras??{},pbr=definition.pbrMetallicRoughness??{},ext=definition.extensions??{};
  const base=vector(pbr.baseColorFactor??[1,1,1,1],4,'baseColorFactor').map(v=>scalar(v,'baseColorFactor'));
  const emission=vector(definition.emissiveFactor??[0,0,0],3,'emissiveFactor').map(v=>scalar(v,'emissiveFactor'));
  const strength=scalar(ext.KHR_materials_emissive_strength?.emissiveStrength??1,'emissiveStrength',0,Infinity);
  const metallic=scalar(pbr.metallicFactor??1,'metallicFactor'),roughness=scalar(pbr.roughnessFactor??1,'roughnessFactor');
  const lines=[`var base=vec4f(${v3(base.slice(0,3))}*in.color.rgb,${num(base[3])}*in.color.a);`,
    `m.baseColor=base.rgb;m.metallic=${num(metallic)};m.roughness=${num(roughness)};m.emission=${v3(emission.map(v=>v*strength))};`,
    'm.subsurfaceColor=m.baseColor;'];
  const structured=extra.principled??{};
  for(const [name,value] of Object.entries(structured)) {
    if(PRINCIPLED_SCALARS.includes(name))lines.push(`m.${name}=${num(scalar(value,name,0,name==='transmissionThickness'?4:1))};`);
    else if(['baseColor','emission','subsurfaceColor','transmissionColor'].includes(name))lines.push(`m.${name}=${v3(vector(value,3,name).map(v=>scalar(v,name,0,name==='transmissionColor'?1:Infinity)))};`);
    else throw Error(`Unsupported structured Principled input ${name}`);
  }
  for(const [name,value] of Object.entries(defaults))if(structured[name]===undefined)lines.push(`m.${name}=${num(value)};`);
  lines.push('m.clearcoatNormal=m.normal;');
  const cc=ext.KHR_materials_clearcoat;
  if(cc) {
    const coatR=scalar(cc.clearcoatRoughnessFactor??0,'clearcoatRoughnessFactor');
    lines.push(`m.clearcoat=${num(scalar(cc.clearcoatFactor??0,'clearcoatFactor'))};`,`let ccR=${num(coatR)};`,`m.clearcoatGloss=clamp((0.1-ccR*ccR)/0.099,0.0,1.0);`);
  }
  return lines;
}
function dispatchCaseBody(entry) {
  return [...dispatchParameterLines(entry),
    `var ctx: APSContext;ctx.position=in.vs.apsLocalPosition;ctx.worldPosition=in.P;ctx.uv=in.uv;ctx.uvFootprint=fwidth(in.uv);ctx.footprint_m=max(length(dpdx(in.P)),length(dpdy(in.P)));ctx.opacity=alpha;`,
    'ctx.viewPosition=viewBasis*in.P;ctx.normal=viewBasis*m.normal;ctx.tangent=contextTangent;ctx.bitangent=contextBitangent;ctx.source=m;ctx.source.normal=viewBasis*m.normal;ctx.source.clearcoatNormal=viewBasis*m.clearcoatNormal;ctx.source.geometricNormal=viewBasis*m.geometricNormal;',
    `m=apsEvaluateMaterial_m${entry.materialId}(ctx);`,
    'm.clearcoatNormal=m.normal;m.normal=transpose(viewBasis)*m.normal;m.clearcoatNormal=transpose(viewBasis)*m.clearcoatNormal;',
    MODEL_SANITIZE,'break;'];
}
export function createMeshModelMaterial(entries,{hasNormal=true,hasTangent=false,uvSets=[0],topology='triangle-list',mirrored=false,doubleSided=false,lighting=principledLightingModule,materialLibrary='',materialTextures={},paletteBuffer=null,instanceIdBuffer=null}={}) {
  if(!Array.isArray(entries)||!entries.length)throw Error('Merged model dispatch needs at least one material entry');
  const seen=new Set();
  for(const entry of entries) {
    const definition=entry.definition??{},ext=definition.extensions??{};
    if(!Number.isInteger(entry.materialId)||entry.materialId<0||entry.materialId>4294967295)throw Error('Invalid merged dispatch material id');
    if(seen.has(entry.materialId))throw Error(`Duplicate merged dispatch material id ${entry.materialId}`);
    seen.add(entry.materialId);
    if(entry.textured)throw Error('Textured material cannot join the merged model dispatch domain');
    if(entry.native||definition.extras?.native_material)throw Error('Native closure material cannot join the merged model dispatch domain');
    if(entry.unlit||ext.KHR_materials_unlit)throw Error('Unlit material cannot join the merged model dispatch domain');
    if((entry.alphaMode??definition.alphaMode??'OPAQUE')!=='OPAQUE')throw Error('Only OPAQUE materials join the merged model dispatch domain');
    if(!!(entry.doubleSided??definition.doubleSided)!==!!doubleSided)throw Error('Merged dispatch raster state must share double-sidedness');
    if(!!entry.mirrored!==!!mirrored)throw Error('Merged dispatch raster state must share mirroring');
  }
  const names=librarySymbols(materialLibrary),libraries=[],evaluators=[],cases=[],recipeUniforms={};
  entries.forEach((entry,index)=>{
    const suffix=`_${index}`;
    const library=names.size?suffixAuthoredSymbols(materialLibrary,names,suffix):'';
    const code=entry.code??'return ctx.source;';
    if(names.size)assertNoLocalShadowing(code,names);
    const source=names.size?suffixAuthoredSymbols(code,names,suffix):code;
    const lygia=usesArtificialLygia(entry.definition);
    const program=compileMaterialProgram(source,{materialLibrary:library,textures:materialTextures,lygia,floatUniformPrefix:lygia?`apsRecipe${index}Float`:null});
    Object.assign(recipeUniforms,program.floatUniforms);
    if(program.library)libraries.push(program.library);
    evaluators.push(`fn apsEvaluateMaterial_m${entry.materialId}(ctx: APSContext) -> APSPrincipled {\n${program.body}\n}`);
    cases.push(`case ${entry.materialId}u: {\n${dispatchCaseBody(entry).join('\n')}\n}`);
  });
  const surface=['apsPrepareLighting(in.P);',
    `let f=apsMeshFrame(in,in.uv,${hasTangent});`,
    'var m=apsPrincipledDefaults(f.N);','let alpha=1.0;',
    `let contextFrame=apsMeshFrame(in,in.uv,${hasTangent});`,
    'let contextT=apsTangent(f.N,contextFrame.T);',
    'let contextHand=select(-1.0,1.0,dot(cross(contextFrame.N,contextFrame.T),contextFrame.B)>=0);',
    'let viewBasis=mat3x3f(frame.view[0].xyz,frame.view[1].xyz,frame.view[2].xyz);',
    'let contextTangent=viewBasis*contextT;',
    'let contextBitangent=viewBasis*(cross(f.N,contextT)*contextHand);',
    `let apsMaterialId=in.vs.${MATERIAL_ID_ATTRIBUTE};`,
    'switch(apsMaterialId) {',...cases,`default: {\n${dispatchCaseBody(entries[0]).join('\n')}\n}`,'}',
    'apsMeshTangent=contextT;','*s=apsSurfaceFromPrincipled(apsMeshMaterial,alpha);'];
  const attributes={[paletteBuffer?MATERIAL_SLOT_ATTRIBUTE:MATERIAL_ID_ATTRIBUTE]:'u32'},varyings={apsLocalPosition:'vec3f',[MATERIAL_ID_ATTRIBUTE]:'u32'};
  const remap=paletteBuffer&&instanceIdBuffer?'if(draw.params.w>=0.0){v.instance=apsStaticInstanceIds[u32(draw.params.w)+v.instance];}':'';
  const vertex=['o.apsLocalPosition=v.position;',remap,paletteBuffer?
    `o.${MATERIAL_ID_ATTRIBUTE}=apsModelMaterialPalette[u32(draw.params.y)+v.instance*u32(draw.params.z)+v.${MATERIAL_SLOT_ATTRIBUTE}];`:
    `o.${MATERIAL_ID_ATTRIBUTE}=v.${MATERIAL_ID_ATTRIBUTE};`];
  for(const index of uvSets)if(index>0){attributes['uv'+index]='vec2f';varyings['apsUv'+index]='vec2f';vertex.push(`o.apsUv${index}=v.uv${index};`);}
  if(hasTangent){attributes.tangent='vec4f';varyings.apsWorldTangent='vec4f';vertex.push('let det=dot(cross(v.model[0].xyz,v.model[1].xyz),v.model[2].xyz);','o.apsWorldTangent=vec4f((v.model*vec4f(v.tangent.xyz,0)).xyz,v.tangent.w*select(-1.0,1.0,det>=0));');}
  vertex.push('v.useWorld=true;v.worldPos=(v.model*vec4f(v.position,1)).xyz;','v.worldNormal=cofactor3(v.model)*v.normal*select(-1.0,1.0,dot(cross(v.model[0].xyz,v.model[1].xyz),v.model[2].xyz)>=0);','v.prevWorldPos=(v.prevModel*vec4f(v.position,1)).xyz;');
  const first=entries[0].definition??{},firstPbr=first.pbrMetallicRoughness??{};
  const firstBase=vector(firstPbr.baseColorFactor??[1,1,1,1],4,'baseColorFactor').map(v=>scalar(v,'baseColorFactor'));
  const firstEmission=vector(first.emissiveFactor??[0,0,0],3,'emissiveFactor').map(v=>scalar(v,'emissiveFactor'));
  const firstStrength=scalar(first.extensions?.KHR_materials_emissive_strength?.emissiveStrength??1,'emissiveStrength',0,Infinity);
  const module=new ShaderModule({name:'aps-model-material',deps:[principledModule,principledSurfaceModule,lighting,...(entries.some(e=>usesArtificialLygia(e.definition))?[artificialLygiaModule]:[])],code:FRAME_WGSL+'\n'+libraries.join('\n')+'\n'+evaluators.join('\n')+'\n'});
  const bindings={};
  if(paletteBuffer)bindings.apsModelMaterialPalette={storage:paletteBuffer,access:'read',visibility:'vertex'};
  if(instanceIdBuffer)bindings.apsStaticInstanceIds={storage:instanceIdBuffer,access:'read',visibility:'vertex'};
  for(const binding of Object.values(materialTextures)){bindings[binding.name]={texture:binding.texture};bindings[binding.samplerName]={sampler:binding.sampler};}
  const output=`
#if APS_SHADER_BEVEL
apsMeshMaterial.normal=s.normal;
apsMeshMaterial.clearcoatNormal=s.clearcoatNormal;
#endif
r.color=vec4f(apsShadePrincipled(apsMeshMaterial,s,in.P,in.V,in.pixel,apsMeshTangent),s.alpha);`;
  const material=new Material({name:entries.length===1?`Merged ${first.name??entries[0].materialId}`:`Merged model (${entries.length} materials)`,
    modules:[module],attributes,varyings,vertex:vertex.join('\n'),surface:surface.join('\n'),output,bindings,uniforms:recipeUniforms,lit:false,
    color:firstBase.slice(0,3),opacity:firstBase[3],roughness:scalar(firstPbr.roughnessFactor??1,'roughnessFactor'),metalness:scalar(firstPbr.metallicFactor??1,'metallicFactor'),
    emissive:firstEmission.map(v=>v*firstStrength),vertexColors:true,side:doubleSided?'double':mirrored?'back':'front',
    transparent:false,alphaTest:0,depthWrite:true,topology,receiveShadows:true,
    defines:{APS_HAS_NORMAL:hasNormal?1:0,APS_HAS_TANGENT:hasTangent?1:0,APS_DOUBLE_SIDED:doubleSided?1:0,APS_MIRRORED:mirrored?1:0,APS_MESH_PBR:1},
    userData:{material_id:null,material_ids:entries.map(entry=>entry.materialId),sourceMaterials:entries.map(entry=>entry.definition),
      materialAdapter:'aps-native-webgpu/1',aps_material_dispatch:true,texture_bindings:0,
      dfg:lighting===principledLightingModule?'preintegrated-64x64-512-samples':'provided-module'}});
  const drySurface=material.surface,baseDeps=[...module.deps];
  material.setOceanReceiver=function(receiver){
    receiver=receiver??null;if((material.oceanReceiver??null)===receiver)return;material.oceanReceiver=receiver;
    module.deps=[...baseDeps,...(receiver?[receiver]:[])];
    material.surface=receiver?drySurface.replaceAll(MODEL_SANITIZE,MODEL_SANITIZE+MODEL_RECEIVER):drySurface;
    material.needsUpdate=true;
  };
  material.allDefines=function(){return {...Material.prototype.allDefines.call(this),DOUBLE_SIDED:0,BACK_SIDE:0,ALPHA_TEST:0};};
  return material;
}

                                                                            
                                                                            
                                                                               
                                                                                
                                                                                
                                                                                  
export function attachStaticInstanceRemap(material, instanceIdBuffer) {
  if (!material || !instanceIdBuffer) throw Error('Static instance remap requires a material and a shared ID buffer');
  const existing = material.bindings?.apsStaticInstanceIds?.storage;
  const marked = !!material.userData?.aps_static_instance_remap;
  if (existing || marked) {
    if (existing !== instanceIdBuffer) throw Error('Static instance remap is already bound to a different ID buffer');
    return material;
  }
  if (typeof material.vertex !== 'string') throw Error('Static instance remap requires a compiled vertex program');
  const anchor = 'o.apsLocalPosition=v.position;';
  const at = material.vertex.indexOf(anchor);
  if (at < 0) throw Error('Static instance remap expects the mesh vertex anchor');
  const remap = 'if(draw.params.w>=0.0){v.instance=apsStaticInstanceIds[u32(draw.params.w)+v.instance];}';
  material.vertex = material.vertex.slice(0, at + anchor.length) + '\n' + remap + material.vertex.slice(at + anchor.length);
  material.bindings ??= {};
  material.bindings.apsStaticInstanceIds = { storage: instanceIdBuffer, access: 'read', visibility: 'vertex' };
  material.userData ??= {};
  material.userData.aps_static_instance_remap = true;
  material.needsUpdate = true;
  return material;
}

                                                                              
                                                                                 
export function createSavedWaterMaterial(row,{lighting=principledLightingModule}={}) {
  const srgb=vector(row.color,3,'saved water color');
  const color=srgb.map(c=>c<=.04045?c/12.92:((c+.055)/1.055)**2.4);
  return createMeshMaterial({name:row.file??'Saved water',pbrMetallicRoughness:{baseColorFactor:[...color,.82],metallicFactor:0,roughnessFactor:.12},doubleSided:true,alphaMode:'BLEND'},{lighting});
}
