import * as THREE from 'three';
import { USDLoader } from './three-usd/USDLoader.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { Viewer } from '../atlantis-renderer/frontend/webgpu/viewer.js';
import { MotionRuntime } from './motion.js';
import { installGalleryEffects } from './view-effects.js';
import { prepareModelNormals } from './split-normals.js';
import { prepareNativeGalleryNormals } from './native-normals.js';
import { installPythonVehicle } from './vehicle.js';
import { installVehicle } from './vehicle-host.js';
import { instanceAwareBounds } from '../atlantis-renderer/frontend/webgpu/scene_bounds.js';

export class GalleryViewer {
  constructor(stage, panel) {
    this.stage = stage;
    this.panel = panel;
    this.originals = [];
    this.pairs = [];
    this.pickCamera = new THREE.PerspectiveCamera();
    this.raycaster = new THREE.Raycaster();
  }

  async init() {
    this.native = new Viewer(this.stage, undefined, {
      presentation: true,
      shadowMapSize: 4096,
      readGalleryMesh: async (url, signal) => {
        if (signal?.aborted || (url !== this.importUrl && !this.assetBuffers?.has(url))) throw Error('Model import was canceled');
        const asset = this.assetBuffers?.get(url);
        return {
          buffer: asset ?? this.importBuffer,
          metadata: { adapter: 'gallery-three-usd', rebuildNormals: Boolean(asset || this.rawImport), creaseDegrees: this.rawImport?.normalCreaseDegrees },
        };
      },
      prepareGalleryMesh: (parsed, metadata) => {
        if (metadata.rebuildNormals) prepareNativeGalleryNormals(parsed.meshes, metadata.creaseDegrees);
      },
    });
    await this.native.ready;
    this.effects = await installGalleryEffects(this.native);
    this.native.beforeRender = dt => {
      this.vehicle?.update?.(dt);
      this.mixer?.update(dt);
      if (!this.vehicle?.enabled) this.motion?.update(dt);
      this.syncPose();
    };

    const canvas = this.native.canvas;
    let start;
    canvas.addEventListener('pointerdown', event => {
      start = event.button === 0 ? [event.pointerId, event.clientX, event.clientY] : null;
    });
    canvas.addEventListener('pointercancel', () => { start = null; });
    canvas.addEventListener('pointerup', event => {
      const point = start;
      start = null;
      if (point?.[0] !== event.pointerId || Math.hypot(event.clientX - point[1], event.clientY - point[2]) > 4) return;
      this.pick(event.clientX, event.clientY);
    });
  }

  async load(url, spec = {}, name = url) {
    if (spec.logic?.profile === 'tiger-ii') return this.loadVehicle(url, spec);
    this.vehicleScale = null;
    const extension = name.split(/[?#]/)[0].split('.').pop().toLowerCase();
    let root, animations = [];
    if (['usd', 'usda', 'usdc', 'usdz'].includes(extension)) {
      root = await new USDLoader().loadAsync(url);
      animations = root.animations;
    } else if (['glb', 'gltf'].includes(extension)) {
      const result = await new GLTFLoader().loadAsync(url);
      root = result.scene;
      animations = result.animations;
    } else {
      throw Error('Choose a USD, USDA, USDC, USDZ, GLB, or glTF file');
    }

    let motion;
    try {
      prepareModelNormals(root, spec.normalCreaseDegrees);
      const bounds = new THREE.Box3().setFromObject(root);
      const size = bounds.getSize(new THREE.Vector3());
      const span = Math.max(size.x, size.y, size.z, .001);
      if (bounds.isEmpty() || !bounds.min.toArray().concat(bounds.max.toArray()).every(Number.isFinite)) {
        throw Error('The model has no visible geometry');
      }
      const panel = document.createElement('div');
      motion = new MotionRuntime(root, panel, spec);
      const nodes = [];
      root.traverse(node => {
        node.userData = { galleryNode: nodes.length, ...(spec.vehicle ? {aps_no_instancing:true,aps_no_batch:true} : {}) };
        nodes.push(node);
        for (const material of (Array.isArray(node.material) ? node.material : [node.material])) {
          if (!material) continue;
          material.userData = {};
          if (material.emissive) {
            // glTF stores HDR emission as an RGB factor in [0, 1] times a separate strength.
            const { r, g, b } = material.emissive;
            const strength = Math.max(r, g, b);
            if (strength > 1) {
              material.emissive.multiplyScalar(1 / strength);
              material.emissiveIntensity *= strength;
            }
          }
        }
        if (node.geometry) node.geometry.userData = {};
      });

      // Export an in-memory staging mesh while preserving the USD hierarchy via node IDs.
      // The original USD is still the download and source of truth.
      const scene = new THREE.Scene();
      scene.add(root);
      const floor = new THREE.Mesh(
        new THREE.PlaneGeometry(span * 8, span * 8),
        new THREE.MeshStandardMaterial({ color: 0xa4aba3, roughness: .47 }),
      );
      floor.rotation.x = -Math.PI / 2;
      const center = bounds.getCenter(new THREE.Vector3());
      floor.position.set(center.x, bounds.min.y - span * .001, center.z);
      floor.userData = { galleryFloor: true };
      scene.add(floor);
      try {
        this.importBuffer = await new GLTFExporter().parseAsync(scene, { binary: true, onlyVisible: false });
      } finally {
        scene.remove(floor, root);
        floor.geometry.dispose();
        floor.material.dispose();
      }
      this.importUrl = new URL('./gallery-mesh.glb', import.meta.url).href;
      const committed = await this.native.loadMeshCandidate(this.importUrl, undefined, { preservePose: true });
      if (!committed) throw Error('Model import was canceled');
      this.vehicle?.dispose();this.vehicle=null;
      this.motion?.dispose();
      if (this.root) this.disposeModel(this.root);
      this.root = root;
      this.motion = motion;
      this.mixer = new THREE.AnimationMixer(root);
      // Clips remain available to motion extensions. Gallery starts at the authored rest pose.
      this.animations = animations;
      this.bounds = bounds;
      this.span = span;
      this.pairs = [];
      this.native.root.traverse(node => {
        if (node.isMesh || !Number.isInteger(node.userData.galleryNode)) return;
        this.pairs.push({ source: nodes[node.userData.galleryNode], target: node });
      });
      const materials = new Set();
      for (const { mesh } of this.native.meshAsset.native.readback) {
        const material = mesh.material;
        if (mesh.userData.galleryFloor || mesh.geometry.attributes.color || material.userData.sourceMaterial.pbrMetallicRoughness?.baseColorTexture) continue;
        materials.add(material);
      }
      this.originals = [...materials].map(material => [material, material.color.clone()]);
      this.panel.replaceChildren(panel);
      if (!panel.children.length) panel.remove();
      this.effects.setScale(span);
      this.frame();
      this.syncPose();
      if(spec.vehicle)this.vehicle=await installVehicle(this,spec.vehicle,new URL(url,location.href).href);
      return { meshes: this.originals.length, errors: motion.errors };
    } catch (error) {
      motion?.dispose();
      if (root !== this.root) this.disposeModel(root);
      throw error;
    } finally {
      this.importBuffer = null;
      this.importUrl = null;
    }
  }

  async loadVehicle(url, spec) {
    const response = await fetch(url);
    if (!response.ok) throw Error('Vehicle model HTTP ' + response.status);
    this.importUrl = new URL(url, location.href).href;
    this.importBuffer = await response.arrayBuffer();
    this.rawImport = spec;
    try {
      this.vehicle?.dispose();this.vehicle=null;
      this.motion?.dispose();this.motion=null;
      this.mixer=null;this.pairs=[];
      if(this.root){this.disposeModel(this.root);this.root=null;}
      if (!await this.native.loadMeshCandidate(this.importUrl, undefined, {preservePose:true})) throw Error('Vehicle import was canceled');
      const box=instanceAwareBounds(this.native.meshAsset.root);
      this.bounds=new THREE.Box3(new THREE.Vector3(...box.min.toArray()),new THREE.Vector3(...box.max.toArray()));
      const size=this.bounds.getSize(new THREE.Vector3());
      this.span=Math.max(size.x,size.y,size.z);
      this.originals=[];
      this.vehicleScale=1.35;
      let courseRoot;
      if(spec.logic.course){
        this.importUrl=new URL(spec.logic.course,new URL(url,location.href)).href;
        const course=await fetch(this.importUrl);
        if(!course.ok)throw Error('Vehicle course HTTP '+course.status);
        this.importBuffer=await course.arrayBuffer();
        courseRoot=(await this.native.addAsset(this.importUrl)).root;
        courseRoot.visible=false;this.native.invalidateVisibility();
      }
      this.effects.setScale(this.span);this.frame();
      this.vehicle=await installPythonVehicle(this.native,spec.logic,new URL(url,location.href).href,this.panel,on=>{if(courseRoot){courseRoot.visible=on;this.native.invalidateVisibility();}});
      return {meshes:0,errors:[]};
    } finally {
      this.importUrl=null;this.importBuffer=null;this.rawImport=null;
    }
  }

  async addVehicleAsset(url,buffer){
    this.assetBuffers??=new Map();this.assetBuffers.set(url,buffer);
    try{return await this.native.addAsset(url);}finally{this.assetBuffers.delete(url);}
  }

  setVehicleFloor(visible){
    this.native.meshAsset.root.traverse(n=>{if(n.userData?.galleryFloor)n.visible=visible;});
  }

  syncPose() {
    let changed = false;
    for (const { source, target } of this.pairs) {
      if (source.matrixAutoUpdate) source.updateMatrix();
      const matrix = source.matrix.elements;
      if (target.visible !== source.visible || target.matrix.elements.some((v, i) => Math.abs(v - matrix[i]) > 1e-9)) {
        target.matrix.fromArray(matrix);
        target.matrixWorldNeedsUpdate = true;
        target.visible = source.visible;
        changed = true;
      }
    }
    if (changed) {
      this.native.invalidateObjectTransforms([this.native.meshAsset.root]);
      for (const cascade of this.native.shadows.cascades) cascade.dirty = true;
      this.native.depthSnapshot = null;
    }
  }

  pick(x, y) {
    if (this.vehicle?.enabled || !this.motion?.targets.size) return;
    const rect = this.native.canvas.getBoundingClientRect();
    const source = this.native.camera, camera = this.pickCamera;
    camera.position.fromArray(source.position.toArray());
    camera.quaternion.fromArray(source.quaternion.toArray());
    camera.fov = source.fov;
    camera.aspect = source.aspect;
    camera.updateProjectionMatrix();
    camera.updateMatrixWorld();
    this.root.updateMatrixWorld(true);
    const uv = new THREE.Vector2((x - rect.left) * 2 / rect.width - 1, 1 - (y - rect.top) * 2 / rect.height);
    this.raycaster.setFromCamera(uv, camera);
    for (const { object } of this.raycaster.intersectObject(this.root)) {
      let invoke, visible = true;
      for (let node = object; node; node = node.parent) {
        visible &&= node.visible;
        invoke ??= this.motion.targets.get(node);
      }
      if (!visible) continue;
      invoke?.();
      break;
    }
  }

  frame() {
    this.vehicle?.exit();
    if (!this.bounds) return;
    const center = this.bounds.getCenter(new THREE.Vector3());
    const distance = this.span * (this.vehicleScale ?? 2.8) * Math.max(1, .8 / this.native.camera.aspect);
    const position = new THREE.Vector3(1, .6, 1.2).normalize().multiplyScalar(distance).add(center);
    this.native.setCamera({
      position: position.toArray(), target: center.toArray(), fov: 36,
      near: this.span / 1000, far: distance + this.span * 150,
      minDistance: this.span * .12, maxDistance: this.span * 15,
    });
  }

  recolor() {
    const hue = Math.random();
    for (const [material] of this.originals) {
      material.color.setHSL(hue + (Math.random() - .5) * .12, .45 + Math.random() * .25, .35 + Math.random() * .28);
    }
  }

  restore() {
    for (const [material, color] of this.originals) material.color.copy(color);
  }

  disposeModel(root) {
    const resources = new Set();
    root.traverse(node => {
      if (node.geometry) resources.add(node.geometry);
      for (const material of (Array.isArray(node.material) ? node.material : [node.material])) {
        if (!material) continue;
        resources.add(material);
        for (const value of Object.values(material)) if (value?.isTexture) resources.add(value);
      }
    });
    for (const resource of resources) resource.dispose();
  }
}
