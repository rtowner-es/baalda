import { useEffect, useRef, useState } from "react";
import { buildGraph, type Graph } from "../lib/graph/buildGraph";
import { useStore } from "../store";
import "./graph.css";

// ---------------------------------------------------------------------------
// Obsidian-style force-directed graph. No layout/physics dependency — this is
// a small hand-rolled simulation (O(n^2) repulsion is fine up to a few hundred
// nodes) rendered on a single <canvas>. React only owns load/empty/error state
// and the header; the simulation + camera live in refs and drive the canvas
// directly via requestAnimationFrame so dragging/zooming never triggers a
// React re-render.
// ---------------------------------------------------------------------------

interface SimNode {
  id: string;
  title: string;
  path: string;
  linkCount: number;
  radius: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Set while pinned (dragged) — physics stops moving the node on that axis. */
  fx: number | null;
  fy: number | null;
}

interface SimEdge {
  source: SimNode;
  target: SimNode;
}

type Drag =
  | { type: "pan"; lastX: number; lastY: number; moved: boolean }
  | { type: "node"; node: SimNode; startX: number; startY: number; moved: boolean };

interface Camera {
  x: number;
  y: number;
  k: number;
}

interface Colors {
  nodeFill: string;
  nodeActive: string;
  edge: string;
  edgeHighlight: string;
  label: string;
  labelActive: string;
}

const DEFAULT_FONT_FAMILY = "sans-serif";

const ALPHA_DECAY = 0.0228;
const ALPHA_MIN = 0.001;
const VELOCITY_RETAIN = 0.6; // fraction of velocity kept per tick (damping)
const CHARGE_STRENGTH = -1400;
const LINK_STRENGTH = 0.06;
const LINK_DISTANCE = 70;
const GRAVITY_STRENGTH = 0.03;
const MIN_RADIUS = 5;
const RADIUS_FACTOR = 2.4;
const MAX_RADIUS = 22;
const MIN_SCALE = 0.08;
const MAX_SCALE = 6;
const CLICK_DRAG_THRESHOLD = 4; // px of movement before a pointerdown counts as a drag
const LABEL_FADE_START = 0.55; // camera.k at which labels start to appear
const LABEL_FADE_END = 1.1; // camera.k at which labels are fully opaque

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function nodeRadius(linkCount: number): number {
  return clamp(MIN_RADIUS + Math.sqrt(linkCount) * RADIUS_FACTOR, MIN_RADIUS, MAX_RADIUS);
}

/** Read the resolved (var()-free) colors the simulation needs to paint with. */
function readColors(el: Element): Colors {
  const cs = getComputedStyle(el);
  const get = (name: string) => cs.getPropertyValue(name).trim();
  return {
    nodeFill: get("--text-tertiary") || "#9a9aa5",
    nodeActive: get("--accent") || "#7f73ff",
    edge: get("--border-strong") || "rgba(20,20,40,0.15)",
    edgeHighlight: get("--accent") || "#7f73ff",
    label: get("--text-secondary") || "#6b6b76",
    labelActive: get("--text-primary") || "#1a1a1e",
  };
}

function buildSimNodes(graph: Graph, previous: Map<string, SimNode>): SimNode[] {
  const n = Math.max(graph.nodes.length, 1);
  const spreadRadius = 60 + Math.sqrt(n) * 40;
  return graph.nodes.map((node, i) => {
    const prev = previous.get(node.id);
    if (prev) {
      prev.linkCount = node.linkCount;
      prev.title = node.title;
      prev.path = node.path;
      prev.radius = nodeRadius(node.linkCount);
      return prev;
    }
    // Golden-angle spiral placement for new nodes — avoids clumping everything
    // at the origin (which would blow up the repulsion force on the first tick).
    const angle = i * 2.399963;
    const r = spreadRadius * Math.sqrt((i + 1) / n);
    return {
      id: node.id,
      title: node.title,
      path: node.path,
      linkCount: node.linkCount,
      radius: nodeRadius(node.linkCount),
      x: Math.cos(angle) * r,
      y: Math.sin(angle) * r,
      vx: 0,
      vy: 0,
      fx: null,
      fy: null,
    };
  });
}

export function GraphView({ onClose }: { onClose: () => void }) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [graph, setGraph] = useState<Graph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshSpin, setRefreshSpin] = useState(false);

  const openNotePath = useStore((s) => s.openNote?.path ?? null);
  const openNotePathRef = useRef(openNotePath);
  openNotePathRef.current = openNotePath;

  // Mutable simulation/camera/interaction state — deliberately NOT React state,
  // so pan/zoom/drag/hover never pay for a reconciliation pass.
  const sim = useRef({
    nodes: [] as SimNode[],
    edges: [] as SimEdge[],
    nodesById: new Map<string, SimNode>(),
    alpha: 0,
    camera: { x: 0, y: 0, k: 1 } as Camera,
    hoveredId: null as string | null,
    drag: null as Drag | null,
    rafId: null as number | null,
    needsDraw: true,
    colors: {
      nodeFill: "#9a9aa5",
      nodeActive: "#7f73ff",
      edge: "rgba(20,20,40,0.15)",
      edgeHighlight: "#7f73ff",
      label: "#6b6b76",
      labelActive: "#1a1a1e",
    } as Colors,
    fontFamily: DEFAULT_FONT_FAMILY,
  }).current;

  const requestDrawRef = useRef<() => void>(() => {});

  // ---- Load data ----
  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const g = await buildGraph();
      setGraph(g);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Merge freshly-built graph data into the running simulation, preserving
  // positions of nodes that survive a refresh and reheating so new/changed
  // nodes settle in.
  useEffect(() => {
    if (!graph) return;
    const nodes = buildSimNodes(graph, sim.nodesById);
    const nodesById = new Map(nodes.map((n) => [n.id, n]));
    const edges: SimEdge[] = [];
    for (const e of graph.edges) {
      const source = nodesById.get(e.source);
      const target = nodesById.get(e.target);
      if (source && target) edges.push({ source, target });
    }
    sim.nodes = nodes;
    sim.edges = edges;
    sim.nodesById = nodesById;
    sim.alpha = 1;
    requestDrawRef.current();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph]);

  // ---- Canvas setup: runs once, everything else flows through refs ----
  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    if (!wrap || !canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;
    let dpr = window.devicePixelRatio || 1;

    sim.colors = readColors(wrap);
    const bodyFont = getComputedStyle(wrap).getPropertyValue("--font-body").trim();
    sim.fontFamily = bodyFont || DEFAULT_FONT_FAMILY;

    function resize() {
      const rect = wrap!.getBoundingClientRect();
      width = rect.width;
      height = rect.height;
      dpr = window.devicePixelRatio || 1;
      canvas!.width = Math.max(1, Math.floor(width * dpr));
      canvas!.height = Math.max(1, Math.floor(height * dpr));
      requestDraw();
    }

    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    // Refresh cached colors when the light/dark toggle flips data-theme.
    const themeObserver = new MutationObserver(() => {
      sim.colors = readColors(wrap!);
      requestDraw();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });

    function screenToWorld(sx: number, sy: number) {
      return {
        x: (sx - width / 2 - sim.camera.x) / sim.camera.k,
        y: (sy - height / 2 - sim.camera.y) / sim.camera.k,
      };
    }

    function nodeAt(sx: number, sy: number): SimNode | null {
      const { x: wx, y: wy } = screenToWorld(sx, sy);
      let best: SimNode | null = null;
      let bestDist = Infinity;
      for (const node of sim.nodes) {
        const dx = node.x - wx;
        const dy = node.y - wy;
        const d = Math.sqrt(dx * dx + dy * dy);
        const hitRadius = node.radius + 4 / sim.camera.k;
        if (d <= hitRadius && d < bestDist) {
          best = node;
          bestDist = d;
        }
      }
      return best;
    }

    // ---- Physics ----
    function tick(): boolean {
      if (sim.alpha <= ALPHA_MIN) return false;
      sim.alpha += (0 - sim.alpha) * ALPHA_DECAY;
      const nodes = sim.nodes;

      // Repulsion between every pair (O(n^2) — fine up to a few hundred nodes).
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        for (let j = i + 1; j < nodes.length; j++) {
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let distSq = dx * dx + dy * dy;
          if (distSq < 0.01) {
            dx = (Math.random() - 0.5) * 0.1;
            dy = (Math.random() - 0.5) * 0.1;
            distSq = dx * dx + dy * dy;
          }
          const dist = Math.sqrt(distSq);
          const force = (CHARGE_STRENGTH * sim.alpha) / distSq;
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }

      // Spring attraction along edges.
      for (const edge of sim.edges) {
        const dx = edge.target.x - edge.source.x;
        const dy = edge.target.y - edge.source.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const diff = ((dist - LINK_DISTANCE) / dist) * LINK_STRENGTH * sim.alpha;
        const fx = dx * diff;
        const fy = dy * diff;
        edge.source.vx += fx;
        edge.source.vy += fy;
        edge.target.vx -= fx;
        edge.target.vy -= fy;
      }

      // Centering gravity.
      for (const node of nodes) {
        node.vx += -node.x * GRAVITY_STRENGTH * sim.alpha;
        node.vy += -node.y * GRAVITY_STRENGTH * sim.alpha;
      }

      // Integrate + damping; pinned (dragged) nodes snap to their fixed point.
      for (const node of nodes) {
        if (node.fx != null && node.fy != null) {
          node.x = node.fx;
          node.y = node.fy;
          node.vx = 0;
          node.vy = 0;
          continue;
        }
        node.vx *= VELOCITY_RETAIN;
        node.vy *= VELOCITY_RETAIN;
        node.x += node.vx;
        node.y += node.vy;
      }

      return sim.alpha > ALPHA_MIN;
    }

    function reheat(amount = 0.5) {
      sim.alpha = Math.max(sim.alpha, amount);
      requestDraw();
    }

    // ---- Drawing ----
    function draw() {
      ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx!.clearRect(0, 0, width, height);
      ctx!.save();
      ctx!.translate(width / 2 + sim.camera.x, height / 2 + sim.camera.y);
      ctx!.scale(sim.camera.k, sim.camera.k);

      const colors = sim.colors;
      const hovered = sim.hoveredId ? sim.nodesById.get(sim.hoveredId) ?? null : null;
      const neighbors = new Set<string>();
      if (hovered) {
        neighbors.add(hovered.id);
        for (const e of sim.edges) {
          if (e.source.id === hovered.id) neighbors.add(e.target.id);
          if (e.target.id === hovered.id) neighbors.add(e.source.id);
        }
      }

      const labelAlpha = clamp(
        (sim.camera.k - LABEL_FADE_START) / (LABEL_FADE_END - LABEL_FADE_START),
        0,
        1,
      );

      // Edges.
      for (const edge of sim.edges) {
        const isNeighborEdge =
          !hovered || edge.source.id === hovered.id || edge.target.id === hovered.id;
        ctx!.beginPath();
        ctx!.moveTo(edge.source.x, edge.source.y);
        ctx!.lineTo(edge.target.x, edge.target.y);
        ctx!.strokeStyle = isNeighborEdge ? colors.edgeHighlight : colors.edge;
        ctx!.globalAlpha = hovered ? (isNeighborEdge ? 0.85 : 0.08) : 0.45;
        ctx!.lineWidth = (isNeighborEdge && hovered ? 1.4 : 1) / sim.camera.k;
        ctx!.stroke();
      }
      ctx!.globalAlpha = 1;

      // Nodes + labels.
      for (const node of sim.nodes) {
        const isOpen = node.path === openNotePathRef.current;
        const isHovered = hovered?.id === node.id;
        const isDimmed = hovered != null && !neighbors.has(node.id);
        const r = isHovered ? node.radius * 1.35 : node.radius;

        ctx!.globalAlpha = isDimmed ? 0.25 : 1;
        ctx!.beginPath();
        ctx!.arc(node.x, node.y, r, 0, Math.PI * 2);
        ctx!.fillStyle = isOpen ? colors.nodeActive : colors.nodeFill;
        ctx!.fill();

        const showLabel = labelAlpha > 0.01 || isHovered;
        if (showLabel) {
          const alpha = isHovered ? 1 : labelAlpha * (isDimmed ? 0.25 : 1);
          if (alpha > 0.01) {
            ctx!.globalAlpha = alpha;
            ctx!.fillStyle = isOpen ? colors.labelActive : colors.label;
            ctx!.font = `${11 / sim.camera.k}px ${sim.fontFamily}`;
            ctx!.textAlign = "center";
            ctx!.textBaseline = "top";
            ctx!.fillText(node.title, node.x, node.y + r + 3 / sim.camera.k);
          }
        }
      }
      ctx!.globalAlpha = 1;

      ctx!.restore();
    }

    function loop() {
      sim.rafId = null;
      const stillSimulating = tick();
      if (stillSimulating) sim.needsDraw = true;
      if (sim.needsDraw) {
        draw();
        sim.needsDraw = false;
      }
      if (stillSimulating) {
        sim.rafId = requestAnimationFrame(loop);
      }
    }

    function requestDraw() {
      sim.needsDraw = true;
      if (sim.rafId == null) sim.rafId = requestAnimationFrame(loop);
    }
    requestDrawRef.current = requestDraw;

    // ---- Interaction ----
    function clientToLocal(e: PointerEvent) {
      const rect = canvas!.getBoundingClientRect();
      return { x: e.clientX - rect.left, y: e.clientY - rect.top };
    }

    function handleWheel(e: WheelEvent) {
      e.preventDefault();
      const rect = canvas!.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const before = screenToWorld(sx, sy);
      const zoomFactor = Math.exp(-e.deltaY * 0.0015);
      const newK = clamp(sim.camera.k * zoomFactor, MIN_SCALE, MAX_SCALE);
      sim.camera.k = newK;
      sim.camera.x = sx - width / 2 - before.x * newK;
      sim.camera.y = sy - height / 2 - before.y * newK;
      requestDraw();
    }

    function handlePointerDown(e: PointerEvent) {
      const { x: sx, y: sy } = clientToLocal(e);
      const hit = nodeAt(sx, sy);
      canvas!.setPointerCapture(e.pointerId);
      if (hit) {
        hit.fx = hit.x;
        hit.fy = hit.y;
        sim.drag = { type: "node", node: hit, startX: e.clientX, startY: e.clientY, moved: false };
        canvas!.classList.add("is-dragging");
      } else {
        sim.drag = { type: "pan", lastX: e.clientX, lastY: e.clientY, moved: false };
        canvas!.classList.add("is-dragging");
      }
    }

    function handlePointerMove(e: PointerEvent) {
      const { x: sx, y: sy } = clientToLocal(e);
      const drag = sim.drag;
      if (drag) {
        if (drag.type === "pan") {
          const dx = e.clientX - drag.lastX;
          const dy = e.clientY - drag.lastY;
          if (dx !== 0 || dy !== 0) {
            drag.moved = drag.moved || Math.hypot(dx, dy) > CLICK_DRAG_THRESHOLD;
            sim.camera.x += dx;
            sim.camera.y += dy;
            drag.lastX = e.clientX;
            drag.lastY = e.clientY;
            requestDraw();
          }
        } else {
          const { x: wx, y: wy } = screenToWorld(sx, sy);
          drag.node.fx = wx;
          drag.node.fy = wy;
          if (!drag.moved) {
            const dist = Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY);
            if (dist > CLICK_DRAG_THRESHOLD) drag.moved = true;
          }
          reheat(0.4);
        }
        return;
      }
      const hit = nodeAt(sx, sy);
      const hitId = hit?.id ?? null;
      if (hitId !== sim.hoveredId) {
        sim.hoveredId = hitId;
        canvas!.classList.toggle("is-hovering-node", hitId != null);
        requestDraw();
      }
    }

    function endDrag(e: PointerEvent) {
      const drag = sim.drag;
      canvas!.classList.remove("is-dragging");
      if (drag?.type === "node" && !drag.moved) {
        // A click, not a drag: unpin and open the note.
        drag.node.fx = null;
        drag.node.fy = null;
        const path = drag.node.path;
        sim.drag = null;
        useStore.getState().openNoteByPath(path).then(onClose);
        return;
      }
      sim.drag = null;
      try {
        canvas!.releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
    }

    canvas.addEventListener("wheel", handleWheel, { passive: false });
    canvas.addEventListener("pointerdown", handlePointerDown);
    canvas.addEventListener("pointermove", handlePointerMove);
    canvas.addEventListener("pointerup", endDrag);
    canvas.addEventListener("pointercancel", endDrag);

    requestDraw();

    return () => {
      ro.disconnect();
      themeObserver.disconnect();
      if (sim.rafId != null) cancelAnimationFrame(sim.rafId);
      canvas.removeEventListener("wheel", handleWheel);
      canvas.removeEventListener("pointerdown", handlePointerDown);
      canvas.removeEventListener("pointermove", handlePointerMove);
      canvas.removeEventListener("pointerup", endDrag);
      canvas.removeEventListener("pointercancel", endDrag);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Escape closes the graph view.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const handleRefresh = () => {
    setRefreshSpin(true);
    void load().finally(() => setTimeout(() => setRefreshSpin(false), 700));
  };

  const nodeCount = graph?.nodes.length ?? 0;
  const edgeCount = graph?.edges.length ?? 0;
  const showEmpty = !loading && !error && graph != null && edgeCount === 0;

  return (
    <div className="graph-view" ref={wrapRef}>
      <div className="graph-header">
        <span className="graph-title">Graph</span>
        <span className="graph-counts">
          {nodeCount} {nodeCount === 1 ? "note" : "notes"} · {edgeCount}{" "}
          {edgeCount === 1 ? "link" : "links"}
        </span>
        <span className="graph-header-spacer" />
        <button
          className={`graph-icon-btn${refreshSpin ? " is-spinning" : ""}`}
          title="Refresh graph"
          aria-label="Refresh graph"
          onClick={handleRefresh}
        >
          ↻
        </button>
        <button
          className="graph-icon-btn"
          title="Close graph"
          aria-label="Close graph"
          onClick={onClose}
        >
          ✕
        </button>
      </div>

      <div className="graph-canvas-wrap">
        <canvas className="graph-canvas" ref={canvasRef} />
        {loading && (
          <div className="graph-state">
            <div className="graph-state-card">Loading graph…</div>
          </div>
        )}
        {error && !loading && (
          <div className="graph-state">
            <div className="graph-state-card">
              <strong>Couldn't load the graph</strong>
              {error}
            </div>
          </div>
        )}
        {showEmpty && (
          <div className="graph-state">
            <div className="graph-state-card">
              <strong>No links yet</strong>
              Connect notes with <code>[[wikilinks]]</code> to see them here.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
