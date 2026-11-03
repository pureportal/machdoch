import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { SparkRenderer, SplatFileType, SplatMesh } from "@sparkjsdev/spark";

export interface MediaSplatInputCamera {
  yaw: number;
  pitch: number;
}

export interface MediaSplatSceneHandle {
  resetView: () => void;
  setAutoRotate: (enabled: boolean) => void;
  dispose: () => void;
}

const FIELD_OF_VIEW = 35;
const AUTO_ROTATE_SPEED = 1.2;

const inputDirection = (camera: MediaSplatInputCamera | null): THREE.Vector3 => {
  const yaw = camera?.yaw ?? Math.PI / 4;
  const pitch = Math.min(1.2, Math.max(-0.3, camera?.pitch ?? 0.2));
  return new THREE.Vector3(
    Math.sin(yaw) * Math.cos(pitch),
    Math.sin(pitch),
    -Math.cos(yaw) * Math.cos(pitch),
  ).normalize();
};

export const createMediaSplatScene = async ({
  container,
  bytes,
  inputCamera,
  autoRotate,
  onInteraction,
}: {
  container: HTMLElement;
  bytes: ArrayBuffer;
  inputCamera: MediaSplatInputCamera | null;
  autoRotate: boolean;
  onInteraction: () => void;
}): Promise<MediaSplatSceneHandle> => {
  const renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.domElement.className = "h-full w-full touch-none outline-none";
  renderer.domElement.tabIndex = 0;
  container.append(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.01, 100);
  const spark = new SparkRenderer({ renderer });
  scene.add(spark);

  const mesh = new SplatMesh({ fileBytes: bytes, fileType: SplatFileType.PLY });
  mesh.quaternion.set(1, 0, 0, 0);
  scene.add(mesh);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.rotateSpeed = 0.7;
  controls.autoRotate = autoRotate;
  controls.autoRotateSpeed = AUTO_ROTATE_SPEED;
  controls.addEventListener("start", onInteraction);

  let disposed = false;
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

  try {
    await mesh.initialized;
  } catch (error) {
    observer.disconnect();
    controls.dispose();
    mesh.dispose();
    renderer.dispose();
    renderer.domElement.remove();
    throw error;
  }
  mesh.updateMatrixWorld(true);
  const bounds = mesh.getBoundingBox(true).applyMatrix4(mesh.matrixWorld);
  const center = bounds.getCenter(new THREE.Vector3());
  const radius = Math.max(0.05, bounds.getSize(new THREE.Vector3()).length() / 2);
  const distance = (radius * 0.9) / Math.sin(THREE.MathUtils.degToRad(FIELD_OF_VIEW) / 2);
  controls.minDistance = distance * 0.25;
  controls.maxDistance = distance * 4;

  const resetView = (): void => {
    controls.target.copy(center);
    camera.position.copy(center).addScaledVector(inputDirection(inputCamera), distance);
    camera.near = distance / 100;
    camera.far = distance * 10;
    camera.updateProjectionMatrix();
    controls.update();
  };
  resetView();

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
      scene.remove(mesh);
      mesh.dispose();
      spark.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    },
  };
};
