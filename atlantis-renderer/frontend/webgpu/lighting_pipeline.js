import {GPU} from '../../vendor/tidewater/src/engine/gpu/GPU.js';
import {ShaderModule,composeShader,createShaderModule} from '../../vendor/tidewater/src/engine/gpu/Shader.js';
import {buildMeshShader} from '../../vendor/tidewater/src/engine/render/MeshShader.js';
import {blendState} from '../../vendor/tidewater/src/engine/render/Material.js';
import {surfaceModule} from '../../vendor/tidewater/src/engine/render/wgsl/lighting.js';

                                                                                 
                                                                                            
export function dfgModuleAdapter(dfgModule) {
  let cache=new WeakMap();
  function adapt(module) {
    if(cache.has(module))return cache.get(module);
    const deps=module.deps.map(adapt);
    let result=module;
    if(module===surfaceModule) {
      const pattern=/fn DFGApprox\( dotNV: f32, roughness: f32 \) -> vec2f \{[^}]*\}/;
      if(!pattern.test(module.code))throw new Error('Pinned native DFG interface changed');
      const code=module.code.replace(pattern,'fn DFGApprox(dotNV:f32,roughness:f32)->vec2f {return apsDFG(dotNV,roughness);}');
      result=new ShaderModule({name:'apsPreintegratedSurface',deps:[...deps,dfgModule],bindings:module.bindings,code});
    } else if(deps.some((m,i)=>m!==module.deps[i]))result=new ShaderModule({name:module.name+'-apsDFG',deps,bindings:module.bindings,code:module.code});
    cache.set(module,result);return result;
  }
                                                                             
                                                                               
  return modules=>{cache=new WeakMap();return modules.map(adapt);};
}

                                                                                   
                                                                                     
                                                                                 
export function installDFGLookup(renderer,dfgModule) {
  if(typeof renderer._createPipeline!=='function')throw new Error('DFG adapter requires the pinned MeshRenderer._createPipeline interface');
  const prior=renderer._createPipeline,priorAdapter=renderer.adaptMaterialModules,adapt=dfgModuleAdapter(dfgModule);
  function create(material,vl,pass,key) {
    const src=buildMeshShader(material,vl.layout,pass);
    src.modules=adapt(src.modules);
    this.validateMaterialResources?.(material,vl,pass,src);
    const c=composeShader({modules:src.modules,bindings:src.bindings,code:src.code,defines:src.defines,stage:'render',label:material.name});
    const module=createShaderModule(c.code,material.name);this._ensureDrawBuffer();
    const layout=GPU.device.createPipelineLayout({bindGroupLayouts:[c.group0.layout,c.bindings.layout,this.drawLayout]});
    const blend=blendState(material.blending);let targets=[];
    if(pass.kind==='main')targets=[
      {format:pass.colorFormats[0],blend:material.transparent||pass.late?blend:undefined,writeMask:material.colorWrite?GPUColorWrite.ALL:0},
      {format:pass.colorFormats[1],blend:pass.late?blendState('premultiplied'):undefined,writeMask:material.colorWrite?GPUColorWrite.ALL:0},
      {format:pass.colorFormats[2],blend:blendState('normal'),writeMask:material.colorWrite?GPUColorWrite.ALL:0},
    ];
    else if(pass.kind==='color')targets=pass.colorFormats.map(format=>({format,blend,writeMask:material.colorWrite?GPUColorWrite.ALL:0}));
                                                                                
                                                                                 
                                                                             
                                                                        
    else if(pass.apsReceiverXYZ)targets=pass.colorFormats.map(format=>({format,writeMask:GPUColorWrite.ALL}));
    const side=material.side;
    const desc={label:material.name+' '+pass.kind,layout,
      vertex:{module,entryPoint:'vs',buffers:vl.buffers.map(b=>b.layout)},
      primitive:{topology:material.topology,cullMode:pass.cullOverride||(side==='double'?'none':side==='back'?'front':'back'),frontFace:pass.flipWinding?'cw':'ccw'}};
    if(pass.sampleCount>1)desc.multisample={count:pass.sampleCount};
    if(src.hasFragment)desc.fragment={module,entryPoint:'fs',targets};
    if(pass.depthFormat)desc.depthStencil={format:pass.depthFormat,depthWriteEnabled:pass.depthWriteOverride??material.depthWrite,
      depthCompare:pass.depthCompareOverride??(material.depthTest?(material.depthCompare||pass.depthCompare):'always'),
      depthBias:pass.kind==='depth'?(pass.depthBias||0):material.depthBias,
      depthBiasSlopeScale:pass.kind==='depth'?(pass.depthBiasSlopeScale||0):material.depthBiasSlopeScale};
    const pipeline={handle:GPU.renderPipeline(desc),bindings:c.bindings,label:desc.label};
    this.pipelines.set(key,pipeline);this.stats.pipelines=this.pipelines.size;return pipeline;
  }
  renderer.adaptMaterialModules=adapt;renderer._createPipeline=create;renderer.pipelines.clear();
  return ()=>{if(renderer._createPipeline===create){renderer._createPipeline=prior;renderer.adaptMaterialModules=priorAdapter;renderer.pipelines.clear();}};
}
