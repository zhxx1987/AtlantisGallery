import { GPU } from '../gpu/GPU.js';
import { RenderTarget } from '../gpu/Texture.js';
import { Material } from './Material.js';
import { FullscreenPass } from './FullscreenPass.js';
import { OpaqueAntialiasing } from './OpaqueAntialiasing.js';
import { ShaderBevel } from './ShaderBevel.js';
import { Mesh } from '../scene/Mesh.js';
import { Scene } from '../scene/Scene.js';
import { Frustum, Matrix4, Sphere, Vector3 } from '../math/index.js';

const _local = new Vector3();
const _sphere = new Sphere();
const _frustum = new Frustum();
const _vp = new Matrix4();
const _inv = new Matrix4();

export const LAYERS = {
	OPAQUE: 0,
	WATER: 1,
	TRANSPARENT: 2,
	REFLECT_ONLY: 3,
};

export const SCENE_FORMATS = [ 'rgba16float', 'rgba16float', 'rgba8unorm' ];
export const DEPTH_FORMAT = 'depth32float';

                                                                                 
                                                                                                     
                                                
                                                                                                       
                                                      
                                                               
                                                                                                 
                                                                                    
                                                                                                     
                                                                                            
export class SceneRenderer {

	constructor( meshRenderer, scene, camera ) {

		this.meshRenderer = meshRenderer;
		this.scene = scene;
		this.camera = camera;
		this.scale = 1;
		this.width = 1;
		this.height = 1;
		this.sceneRT = new RenderTarget( 1, 1, { colors: [ { format: 'rgba16float', name: 'color' }, { format: 'rgba16float', name: 'velocity' }, { format: 'rgba8unorm', name: 'waterMask' } ], depth: DEPTH_FORMAT, label: 'scene' } );
		this.velocityTexture = this.sceneRT.textures[ 1 ];
		this.waterMaskTexture = this.sceneRT.textures[ 2 ];
		this.opaqueCopy = new RenderTarget( 1, 1, { colors: [ 'rgba16float' ], depth: DEPTH_FORMAT, label: 'opaqueCopy' } );
		                                                                                           
		                                                                                            
		this.opaqueDepthHalf = new RenderTarget( 1, 1, { colors: [ 'r16float' ], label: 'opaqueDepthHalf' } );
		this._depthHalfPass = null;
		this.hullMaskRT = new RenderTarget( 1, 1, { colors: [ 'r16float' ], depth: DEPTH_FORMAT, label: 'hullMask' } );
		this.hullMaskScene = new Scene();
		this.hullMaskMaterial = new Material( { name: 'hullMask', lit: false, side: 'double', surface: 's.albedo = vec3f( length( in.P - frame.cameraPos ), 0.0, 0.0 ); s.emissive = vec3f( 0.0 );' } );
		this.hullMasks = [];
		this.hullMaskActive = { value: 0 };
		                                                                                           
		                                             
		this.background = null;
		this.clearColor = [ 0, 0, 0, 1 ];
		this.onBeforeWater = null;
		this.onAfterOpaque = null;
		this.msaaSamples = 1;

	}

	setSize( w, h ) {

		this.width = w;
		this.height = h;
		this.sceneRT.setSize( w, h );
		this.opaqueCopy.setSize( w, h );
		this.opaqueDepthHalf.setSize( w, h );
		this.hullMaskRT.setSize( w, h );

	}

	                                                 
	addHullMask( geometry, object ) {

		geometry.computeBoundingBox();
		geometry.computeBoundingSphere();
		const mesh = new Mesh( geometry, this.hullMaskMaterial );
		mesh.matrixAutoUpdate = false;
		mesh.frustumCulled = false;
		this.hullMaskScene.add( mesh );
		this.hullMasks.push( { mesh, object, box: geometry.boundingBox.clone().expandByScalar( 0.05 ), sphere: geometry.boundingSphere } );
		return mesh;

	}

	_renderHullMasks( camera ) {

		let active = 0;
		_frustum.setFromProjectionMatrix( _vp.multiplyMatrices( camera.projectionMatrix, camera.matrixWorldInverse ) );
		for ( const h of this.hullMasks ) {

			h.object.updateWorldMatrix( true, false );
			h.mesh.matrix.copy( h.object.matrixWorld );
			h.mesh.matrixWorld.copy( h.object.matrixWorld );
			_local.setFromMatrixPosition( camera.matrixWorld ).applyMatrix4( _inv.copy( h.object.matrixWorld ).invert() );
			const on = ! h.box.containsPoint( _local ) && _frustum.intersectsSphere( _sphere.copy( h.sphere ).applyMatrix4( h.object.matrixWorld ) );
			h.mesh.visible = on;
			if ( on ) active ++;

		}

		this.hullMaskActive.value = active > 0 ? 1 : 0;
		if ( ! active ) return;
		const rt = this.hullMaskRT;
		this.meshRenderer.render( this.hullMaskScene, {
			label: 'hull mask', kind: 'color', camera, colorViews: [ rt.texture.view() ], colorFormats: rt.formats,
			clearColors: [ [ 0, 0, 0, 0 ] ], depthView: rt.depthTexture.view(), depthFormat: DEPTH_FORMAT, clearDepth: 0, cull: false,
		} );

	}

	disposeSurfaceEffects() {

		this.opaqueAA?.dispose();
		this.shaderBevel?.dispose();
		this.opaqueAA = null;
		this.shaderBevel = null;

	}

	render() {

		const { scene, camera, meshRenderer: mr } = this;
		const rt = this.sceneRT;
		const views = rt.textures.map( ( t ) => t.view() );
		const common = { camera, colorViews: views, colorFormats: rt.formats, depthView: rt.depthTexture.view(), depthTexture: rt.depthTexture, depthFormat: DEPTH_FORMAT, kind: 'main' };

		// 1. Opaque geometry can be multisampled. Resolve over the single-sample background.
		const msaa = this.msaaSamples === 4 && ! this.diagnostic;
		const background = this.background ? ( rp ) => this.background.draw( rp ) : null;
		let opaque = {
			...common, label: 'opaque', layerMask: 1 << LAYERS.OPAQUE,
			clearColors: [ this.clearColor, [ 0, 0, 0, 0 ], [ 0, 0, 0, 0 ] ], clearDepth: 0,
			after: msaa ? null : background,
		};
		if ( this.bevelOptions && ! this.diagnostic ) {
			this.shaderBevel ??= new ShaderBevel( DEPTH_FORMAT );
			opaque.bevelModule = this.shaderBevel.prepare( mr, scene, opaque, rt.width, rt.height, this.bevelOptions );
		}
		if ( msaa ) {
			this.opaqueAA ??= new OpaqueAntialiasing( rt.formats, DEPTH_FORMAT );
			opaque = this.opaqueAA.opaquePass( opaque, rt );
		}
		mr.render( scene, opaque );
		if ( msaa ) this.opaqueAA.resolveScene( rt, background, opaque.clearColors );

		if ( this.onAfterOpaque ) this.onAfterOpaque();

		                           
		const enc = GPU.getEncoder();
		const size = { width: rt.width, height: rt.height };
		enc.copyTextureToTexture( { texture: rt.texture.getGPU() }, { texture: this.opaqueCopy.texture.getGPU() }, size );
		enc.copyTextureToTexture( { texture: rt.depthTexture.getGPU() }, { texture: this.opaqueCopy.depthTexture.getGPU() }, size );
		if ( ! this._depthHalfPass ) this._depthHalfPass = new FullscreenPass( {
			label: 'opaque depth half', colorFormats: [ 'r16float' ],
			bindings: { srcDepth: { texture: () => this.opaqueCopy.depthTexture } },
			code: 'fn fragment( in: FSIn ) -> vec4f { return vec4f( textureLoad( srcDepth, vec2i( in.pos.xy ), 0 ), 0.0, 0.0, 1.0 ); }',
		} );
		this._depthHalfPass.render( { colorViews: [ this.opaqueDepthHalf.texture ], clear: [ 0, 0, 0, 0 ] } );

		                    
		if ( this.hullMasks.length > 0 ) this._renderHullMasks( camera );
		if ( this.onBeforeWater ) this.onBeforeWater();

		                          
		mr.render( scene, { ...common, label: 'water + transparent', late: true, layerMask: ( 1 << LAYERS.WATER ) | ( 1 << LAYERS.TRANSPARENT ) } );

	}

}
