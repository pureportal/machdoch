import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import type { MediaViewerSceneHandle } from "./media-3d-viewer";

const FIELD_OF_VIEW = 30;
const AUTO_ROTATE_SPEED = 1.2;
const VIEW_YAW = THREE.MathUtils.degToRad(32);
const VIEW_PITCH = THREE.MathUtils.degToRad(18);
const CLAY_COLOR = 0xc9ccd6;

const parseGlb = (bytes: ArrayBuffer): Promise<THREE.Group> =>
  new Promise((resolve, reject) => {
    new GLTFLoader().parse(bytes, "", (gltf) => resolve(gltf.scene), reject);
  });

const disposeObject = (root: THREE.Object3D): void => {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.dispose();
    const materials: THREE.Material[] = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of materials) material.dispose();
  });
};

export const createMediaMeshScene = async ({
  container,
  bytes,
  autoRotate,
  onInteraction,
}: {
  container: HTMLElement;
  bytes: ArrayBuffer;
  autoRotate: boolean;
  onInteraction: () => void;
}): Promise<MediaViewerSceneHandle> => {
  const model = await parseGlb(bytes);
  const clay = new THREE.MeshStandardMaterial({
    color: CLAY_COLOR,
    roughness: 0.72,
    metalness: 0,
    side: THREE.DoubleSide,
  });
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const original: THREE.Material[] = Array.isArray(object.material)
      ? object.material
      : [object.material];
    for (const material of original) material.dispose();
    if (!object.geometry.getAttribute("normal")) object.geometry.computeVertexNormals();
    object.material = clay;
  });

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.domElement.className = "h-full w-full touch-none outline-none";
  renderer.domElement.tabIndex = 0;
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xf1f5f9, 0x1e293b, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  const rim = new THREE.DirectionalLight(0x93c5fd, 0.8);
  scene.add(model);

  const bounds = new THREE.Box3().setFromObject(model);
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(0.05, bounds.getSize(new THREE.Vector3()).length() / 2);
  const distance = (radius * 1.05) / Math.sin(THREE.MathUtils.degToRad(FIELD_OF_VIEW) / 2);
  const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, distance / 100, distance * 10);
  key.position.set(radius * 2, radius * 3, radius * 2.5);
  rim.position.set(-radius * 2.5, radius, -radius * 2);
  camera.add(key, rim);
  scene.add(camera);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.7;
  controls.autoRotate = autoRotate;
  controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
  controls.minDistance = distance * 0.25;
  controls.maxDistance = distance * 4;
  controls.addEventListener("start", onInteraction);

  const resize = (): void => {
    const width = Math.max(1, container.clientWidth);
    const height = Math.max(1, container.clientHeight);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  resize();

  const resetView = (): void => {
    controls.target.copy(center);
    camera.position
      .copy(center)
      .add(
        new THREE.Vector3(
          Math.sin(VIEW_YAW) * Math.cos(VIEW_PITCH),
          Math.sin(VIEW_PITCH),
          Math.cos(VIEW_YAW) * Math.cos(VIEW_PITCH),
        ).multiplyScalar(distance),
      );
    controls.update();
  };
  resetView();

  let disposed = false;
  renderer.setAnimationLoop(() => {
    if (disposed) return;
    controls.update();
    renderer.render(scene, camera);
  });

  return {
    resetView,
    setAutoRotate: (enabled) => {
      controls.autoRotate = enabled;
    },
    dispose: () => {
      disposed = true;
      renderer.setAnimationLoop(null);
      observer.disconnect();
      controls.dispose();
      scene.remove(model);
      disposeObject(model);
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
};
