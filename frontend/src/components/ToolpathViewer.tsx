import { Eye, EyeOff, Layers, Maximize2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { fetchToolpath, type ToolpathMeta } from "../api";
import { LayerSlider } from "./LayerSlider";

const GROUP_COLORS = ["#ff8a3d", "#f5c542", "#d94f70", "#3bb2f6", "#3ddc84", "#8c8ca3", "#b48cff"];
const FUTURE_COLOR = "#4a4a5c";

interface GroupObjects {
  positions: THREE.BufferAttribute;
  done: THREE.LineSegments;
  todo: THREE.LineSegments;
  top: THREE.LineSegments;
  box: { minX: number; maxX: number; minZ: number; maxZ: number } | null;
}

/**
 * Interactive 3D view of a model's extrusion paths: Orca-style layer
 * slider, per-feature toggles, smart fit-to-content zoom. With `liveLayer`
 * (1-based, as the printer reports it) the slider is locked and follows the
 * print: layers up to the current one in color (current layer highlighted),
 * the rest ghosted - the view itself can still be rotated and zoomed.
 */
export function ToolpathViewer({
  modelId,
  live: liveProp = false,
  liveLayer,
}: {
  modelId: string;
  /** Follow-the-print mode: read-only, driven by liveLayer (1-based, 0 = still preparing). */
  live?: boolean;
  liveLayer?: number;
}) {
  const mountRef = useRef<HTMLDivElement>(null);
  const objectsRef = useRef<GroupObjects[]>([]);
  const fitRef = useRef<(keepDirection: boolean, all?: boolean) => void>(() => {});
  const renderRef = useRef<() => void>(() => {});
  const [meta, setMeta] = useState<ToolpathMeta | null>(null);
  const [loading, setLoading] = useState(true);
  const [range, setRange] = useState<[number, number]>([0, 0]);
  const [enabled, setEnabled] = useState<boolean[]>([]);
  // The feature list covers part of the model: collapsed by default in the compact live view.
  const [legendOpen, setLegendOpen] = useState(() => !liveProp);

  const layerCount = meta?.layerZ.length ?? 0;
  const live = liveProp;
  // -1 while the printer is still preparing: nothing printed yet, everything ghosted
  const liveIdx = live ? Math.min((liveLayer ?? 0) - 1, Math.max(layerCount - 1, 0)) : -1;
  const low = live ? 0 : range[0];
  const high = live ? liveIdx : range[1];

  // The fit closure reads the latest UI state through these refs.
  const enabledRef = useRef<boolean[]>([]);
  enabledRef.current = enabled;
  const rangeRefHolder = useRef<[number, number]>([0, 0]);
  rangeRefHolder.current = [low, high];
  const liveRef = useRef(false);
  liveRef.current = live;

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;
    let disposed = false;
    let frame = 0;
    setLoading(true);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 5000);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    mount.appendChild(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.screenSpacePanning = true;

    // Coalesce redraws: slider drags and orbit events can fire many times per frame.
    const requestRender = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        renderer.render(scene, camera);
      });
    };
    renderRef.current = requestRender;
    controls.addEventListener("change", requestRender);

    // Keep re-framing on layout changes until the user takes over the camera.
    let userMoved = false;
    controls.addEventListener("start", () => (userMoved = true));
    const resize = () => {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (!userMoved && objectsRef.current.length) fitRef.current(false, true);
      requestRender();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(mount);

    fetchToolpath(modelId)
      .then(({ meta, data }) => {
        if (disposed) return;
        const { bounds, layerZ, scale, originX, originY } = meta;
        const cx = (bounds.minX + bounds.maxX) / 2;
        const cy = (bounds.minY + bounds.maxY) / 2;
        const layers = layerZ.length;
        const objs: GroupObjects[] = [];

        meta.groups.forEach((g, gi) => {
          const segCount = g.layerOffsets[g.layerOffsets.length - 1];
          const positions = new Float32Array(segCount * 6);
          const colors = new Uint8Array(segCount * 6);
          const base = new THREE.Color(GROUP_COLORS[gi]);
          let minX = Infinity;
          let maxX = -Infinity;
          let minZ = Infinity;
          let maxZ = -Infinity;

          for (let l = 0; l < layers; l++) {
            const yUp = layerZ[l];
            // lower layers a bit darker: gives depth when zoomed out instead of one flat color
            const shade = 0.5 + 0.5 * (l / Math.max(layers - 1, 1));
            const r = Math.round(base.r * 255 * shade);
            const gr = Math.round(base.g * 255 * shade);
            const b = Math.round(base.b * 255 * shade);
            for (let s = g.layerOffsets[l]; s < g.layerOffsets[l + 1]; s++) {
              const src = (g.start + s) * 4;
              const dst = s * 6;
              const x1 = data[src] / scale + originX - cx;
              const z1 = -(data[src + 1] / scale + originY - cy);
              const x2 = data[src + 2] / scale + originX - cx;
              const z2 = -(data[src + 3] / scale + originY - cy);
              positions[dst] = x1;
              positions[dst + 1] = yUp;
              positions[dst + 2] = z1;
              positions[dst + 3] = x2;
              positions[dst + 4] = yUp;
              positions[dst + 5] = z2;
              colors[dst] = colors[dst + 3] = r;
              colors[dst + 1] = colors[dst + 4] = gr;
              colors[dst + 2] = colors[dst + 5] = b;
              if (x1 < minX) minX = x1;
              if (x2 < minX) minX = x2;
              if (x1 > maxX) maxX = x1;
              if (x2 > maxX) maxX = x2;
              if (z1 < minZ) minZ = z1;
              if (z2 < minZ) minZ = z2;
              if (z1 > maxZ) maxZ = z1;
              if (z2 > maxZ) maxZ = z2;
            }
          }

          const posAttr = new THREE.BufferAttribute(positions, 3);
          const make = (material: THREE.Material, withColors: boolean) => {
            const geo = new THREE.BufferGeometry();
            geo.setAttribute("position", posAttr);
            if (withColors) geo.setAttribute("color", new THREE.BufferAttribute(colors, 3, true));
            const obj = new THREE.LineSegments(geo, material);
            obj.frustumCulled = false;
            return obj;
          };
          const done = make(new THREE.LineBasicMaterial({ vertexColors: true }), true);
          const todo = make(new THREE.LineBasicMaterial({ color: FUTURE_COLOR, transparent: true, opacity: 0.3 }), false);
          const top = make(new THREE.LineBasicMaterial({ color: "#ffffff" }), false);
          scene.add(todo, done, top);
          objs.push({
            positions: posAttr,
            done,
            todo,
            top,
            box: segCount > 0 ? { minX, maxX, minZ, maxZ } : null,
          });
        });
        objectsRef.current = objs;

        const groupEnabled = () => enabledRef.current;
        const rangeRef2 = () => rangeRefHolder.current;

        // Smart fit: frame exactly what is visible right now (enabled features x shown layers).
        const visibleBox = (all = false) => {
          const box = new THREE.Box3();
          // live view frames the whole part so the framing doesn't creep as layers are added
          const [lo, hi] = all || liveRef.current ? [0, layers - 1] : rangeRef2();
          const yMin = lo <= 0 ? 0 : layerZ[lo];
          const yMax = layerZ[Math.min(hi, layers - 1)];
          objs.forEach((o, gi) => {
            if (!o.box || !(all || (groupEnabled()[gi] ?? true))) return;
            box.expandByPoint(new THREE.Vector3(o.box.minX, Math.min(yMin, yMax), o.box.minZ));
            box.expandByPoint(new THREE.Vector3(o.box.maxX, yMax, o.box.maxZ));
          });
          if (box.isEmpty()) {
            box.expandByPoint(new THREE.Vector3(-(bounds.maxX - bounds.minX) / 2, 0, -(bounds.maxY - bounds.minY) / 2));
            box.expandByPoint(new THREE.Vector3((bounds.maxX - bounds.minX) / 2, bounds.maxZ, (bounds.maxY - bounds.minY) / 2));
          }
          return box;
        };
        // Sample vertices of what is visible right now (enabled features x shown layers).
        const collectSamples = (all: boolean): THREE.Vector3[] => {
          const [lo, hi] = all || liveRef.current ? [0, layers - 1] : rangeRef2();
          const out: THREE.Vector3[] = [];
          objs.forEach((o, gi) => {
            if (!o.box || !(all || (groupEnabled()[gi] ?? true))) return;
            const g = meta.groups[gi];
            const v0 = g.layerOffsets[Math.max(lo, 0)] * 2;
            const v1 = g.layerOffsets[Math.min(hi, layers - 1) + 1] * 2;
            const arr = o.positions.array as Float32Array;
            const step = Math.max(1, Math.floor((v1 - v0) / 3000));
            for (let v = v0; v < v1; v += step) out.push(new THREE.Vector3(arr[v * 3], arr[v * 3 + 1], arr[v * 3 + 2]));
          });
          return out;
        };

        // Fit to the real geometry, not its bounding box: project sampled
        // points onto the camera frustum for the view direction, center the
        // screen-space extent, and back off just far enough.
        const fit = (keepDirection: boolean, all = false) => {
          const box = visibleBox(all);
          let samples = collectSamples(all);
          if (samples.length === 0) {
            samples = [];
            for (const x of [box.min.x, box.max.x])
              for (const y of [box.min.y, box.max.y])
                for (const z of [box.min.z, box.max.z]) samples.push(new THREE.Vector3(x, y, z));
          }
          const center = box.getCenter(new THREE.Vector3());
          const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
          const dir = keepDirection
            ? camera.position.clone().sub(controls.target).normalize()
            : new THREE.Vector3(0.75, 0.6, 0.95).normalize();
          const forward = dir.clone().negate();
          const right = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();
          const up = new THREE.Vector3().crossVectors(right, forward).normalize();
          const tanV = Math.tan((camera.fov * Math.PI) / 360) * 0.96;
          const tanH = tanV * camera.aspect;

          // center the screen-space extent (shift the target along right/up)
          let minR = Infinity, maxR = -Infinity, minU = Infinity, maxU = -Infinity;
          for (const p of samples) {
            const r = p.clone().sub(center).dot(right);
            const u = p.clone().sub(center).dot(up);
            if (r < minR) minR = r;
            if (r > maxR) maxR = r;
            if (u < minU) minU = u;
            if (u > maxU) maxU = u;
          }
          center.addScaledVector(right, (minR + maxR) / 2).addScaledVector(up, (minU + maxU) / 2);

          let dist = 1;
          for (const p of samples) {
            const q = p.clone().sub(center);
            const along = q.dot(dir); // toward the camera
            dist = Math.max(dist, Math.abs(q.dot(right)) / tanH + along, Math.abs(q.dot(up)) / tanV + along);
          }
          camera.position.copy(center).addScaledVector(dir, dist);
          controls.target.copy(center);
          controls.minDistance = radius * 0.2;
          controls.maxDistance = radius * 14;
          camera.near = Math.max(dist / 300, 0.05);
          camera.far = dist + radius * 8;
          camera.updateProjectionMatrix();
          controls.update();
          requestRender();
        };
        fitRef.current = fit;

        setMeta(meta);
        setRange([0, layers - 1]);
        setEnabled(meta.groups.map(() => true));
        setLoading(false);
        resize();
        fit(false, true);
      })
      .catch(() => setLoading(false));

    const onDblClick = () => fitRef.current(true);
    renderer.domElement.addEventListener("dblclick", onDblClick);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      renderer.domElement.removeEventListener("dblclick", onDblClick);
      ro.disconnect();
      controls.dispose();
      objectsRef.current.forEach((o) => {
        [o.done, o.todo, o.top].forEach((line) => {
          line.geometry.dispose();
          (line.material as THREE.Material).dispose();
        });
      });
      objectsRef.current = [];
      renderer.dispose();
      if (renderer.domElement.parentNode === mount) mount.removeChild(renderer.domElement);
    };
  }, [modelId]);

  // Apply layer range / visibility to draw ranges only - never rebuilds geometry.
  useEffect(() => {
    if (!meta) return;
    meta.groups.forEach((g, gi) => {
      const o = objectsRef.current[gi];
      if (!o) return;
      const visible = enabled[gi] ?? true;
      const nothing = live && high < 0;
      const lo = Math.max(0, Math.min(low, layerCount - 1));
      const hi = Math.max(lo, Math.min(high, layerCount - 1));

      const start = g.layerOffsets[lo];
      const end = nothing ? start : g.layerOffsets[hi + 1];
      o.done.geometry.setDrawRange(start * 2, (end - start) * 2);
      o.done.visible = visible && !nothing;

      const topStart = nothing ? start : g.layerOffsets[hi];
      o.top.geometry.setDrawRange(topStart * 2, (end - topStart) * 2);
      o.top.visible = visible && !nothing;

      const futureStart = end;
      const futureEnd = g.layerOffsets[layerCount];
      o.todo.geometry.setDrawRange(futureStart * 2, (futureEnd - futureStart) * 2);
      o.todo.visible = visible && live;
    });
    renderRef.current();
  }, [meta, low, high, enabled, layerCount, live]);

  const toggleGroup = useCallback((gi: number) => {
    setEnabled((prev) => prev.map((v, i) => (i === gi ? !v : v)));
  }, []);

  const soloGroup = useCallback((gi: number) => {
    setEnabled((prev) => prev.map((_, i) => i === gi));
  }, []);

  const allOn = enabled.every(Boolean);

  return (
    <div className="flex h-full w-full">
      <div ref={mountRef} className="relative min-w-0 flex-1 overflow-hidden rounded-xl" style={{ background: "var(--bg)" }}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-sm" style={{ color: "var(--text-muted)" }}>
            Разбор траекторий…
          </div>
        )}

        {meta && (
          <>
            <div className="absolute left-2 top-2 flex flex-col items-start gap-1">
              <button
                onClick={() => setLegendOpen((v) => !v)}
                className="flex h-8 w-8 items-center justify-center rounded-lg backdrop-blur"
                style={{
                  background: legendOpen ? "var(--accent)" : "rgba(21,21,27,0.75)",
                  border: "1px solid var(--border)",
                  color: "#fff",
                }}
              >
                <Layers size={14} />
              </button>
              {legendOpen && (
                <div
                  className="flex flex-col gap-0.5 rounded-lg p-1 backdrop-blur"
                  style={{ background: "rgba(21,21,27,0.75)", border: "1px solid var(--border)" }}
                >
                  {meta.groups.map((g, gi) => {
                    if (g.layerOffsets[g.layerOffsets.length - 1] === 0) return null;
                    const on = enabled[gi];
                    return (
                      <button
                        key={g.title}
                        onClick={() => toggleGroup(gi)}
                        onDoubleClick={() => soloGroup(gi)}
                        className="flex items-center gap-2 rounded-md px-2 py-1 text-left text-xs"
                        style={{ opacity: on ? 1 : 0.4 }}
                      >
                        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: GROUP_COLORS[gi] }} />
                        <span className="flex-1 whitespace-nowrap">{g.title}</span>
                        {on ? <Eye size={12} /> : <EyeOff size={12} />}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="absolute right-2 top-2 flex gap-1">
              {!allOn && (
                <button
                  onClick={() => setEnabled(meta.groups.map(() => true))}
                  className="flex h-8 w-8 items-center justify-center rounded-lg backdrop-blur"
                  style={{ background: "rgba(21,21,27,0.75)", border: "1px solid var(--border)" }}
                >
                  <Eye size={14} />
                </button>
              )}
              <button
                onClick={() => fitRef.current(true)}
                className="flex h-8 w-8 items-center justify-center rounded-lg backdrop-blur"
                style={{ background: "rgba(21,21,27,0.75)", border: "1px solid var(--border)" }}
              >
                <Maximize2 size={14} />
              </button>
            </div>
          </>
        )}
        {meta && live && (
          <div
            className="pointer-events-none absolute bottom-2 left-2 rounded-lg px-2.5 py-1 text-xs tabular-nums backdrop-blur"
            style={{ background: "rgba(21,21,27,0.75)", border: "1px solid var(--border)" }}
          >
            {high < 0
              ? "Подготовка"
              : `Слой ${high + 1} / ${layerCount} · ${meta.layerZ[high].toFixed(2)} мм`}
          </div>
        )}
      </div>

      {!live && !(meta && layerCount > 1) && <div className="w-32 shrink-0" />}
      {!live && meta && layerCount > 1 && (
        <LayerSlider
          count={layerCount}
          low={low}
          high={high}
          locked={live}
          heightOf={(l) => meta.layerZ[l]}
          onChange={(lo, hi) => setRange([lo, hi])}
        />
      )}
    </div>
  );
}
