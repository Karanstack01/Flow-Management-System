import '@xyflow/react/dist/style.css';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  addEdge,
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  useStore,
  ViewportPortal,
  type Connection,
  type Edge,
  type NodeChange,
} from '@xyflow/react';
import clsx from 'clsx';
import { ArrowLeft, Check, ChevronLeft, CircleAlert, CircleCheck, History, LayoutGrid, Maximize2, Pencil, Redo2, Rocket, Save, SlidersHorizontal, TriangleAlert, Undo2, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type DragEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router';
import { toast } from 'sonner';
import { compileCanvas, conditionCases, ELSE_HANDLE, isStageNode, layoutCanvas, reconcileCanvas, type Canvas, type CanvasNodeType, type ConditionNodeData, type FieldDef, type StageDef, type WorkflowDef, type WorkflowSettings } from '@fms/core';
import { Badge, Button, ErrorNote, Select, Spinner } from '../../../components/ui';
import { ApiError, api } from '../../../lib/api';
import { useFlowsInvalidation } from '../../../lib/queries';
import type { EditorData, FlowVersion } from '../../../lib/types';
import { Inspector } from './Inspector';
import { StepPreview } from './Preview';
import { VersionHistory } from './VersionHistory';
import { canStartSave, PANEL_CLOSED, panelReducer, SAVE_IDLE, saveReducer, type PanelState } from './machines';
import { EditorContext, nodeTypes, PALETTE, TONES, type FlowNode } from './nodes';

const MAIN = new Set<CanvasNodeType>(['stage', 'condition', 'timer', 'document']);
/** Main-path node (old placeholder Document nodes without a stage are side notes). */
const isMain = (n: FlowNode | undefined) => !!n && MAIN.has(n.type as CanvasNodeType) && (n.type !== 'document' || isStageNode(n));
const STAGE_COLORS = ['#2563eb', '#7c3aed', '#ea580c', '#0891b2', '#16a34a', '#db2777', '#ca8a04', '#0f766e'];
const PANEL_MIN = 340;
const PANEL_DEFAULT = 400;
const PANEL_WIDE = 760;
const PANEL_KEY = 'fms-inspector-width';
const panelMax = () => Math.max(PANEL_MIN, Math.min(1100, Math.round(window.innerWidth * 0.75)));
const clampPanel = (w: number) => Math.round(Math.min(panelMax(), Math.max(PANEL_MIN, w)));
const FIT = { padding: 0.2, maxZoom: 1, duration: 450 } as const;
/** Below this zoom node text is too small to read. */
const MIN_READABLE_ZOOM = 0.6;

/** The nearest spot to `start` (searching down, then sideways) where a new node does not cover an existing one. */
function freeSpot(nodes: FlowNode[], start: { x: number; y: number }, w = 240, h = 110) {
  const hits = (x: number, y: number) =>
    nodes.some((n) => {
      const nw = n.measured?.width ?? 240;
      const nh = n.measured?.height ?? 100;
      return x < n.position.x + nw + 16 && x + w + 16 > n.position.x && y < n.position.y + nh + 16 && y + h + 16 > n.position.y;
    });
  for (let ring = 0; ring < 12; ring++) {
    for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1], [1, 1], [-1, 1]] as const) {
      const x = start.x + dx * ring * (w + 24);
      const y = start.y + dy * ring * (h + 24);
      if (!hits(x, y)) return { x, y };
    }
  }
  return start;
}

const toNodes = (c: Canvas): FlowNode[] => c.nodes.map((n) => ({ id: n.id, type: n.type, position: { x: n.x, y: n.y }, data: n.data }));
/**
 * Edges out of a Depends-on node always name their output. Older canvases used `yes` / `no` (or
 * nothing): they become the first path and Otherwise.
 */
const toEdges = (c: Canvas): Edge[] => {
  const conds = new Map(c.nodes.filter((n) => n.type === 'condition').map((n) => [n.id, conditionCases(n.data as ConditionNodeData)]));
  return c.edges.map((e) => {
    const cc = conds.get(e.source);
    if (!cc) return { id: e.id, source: e.source, target: e.target, sourceHandle: null };
    const handle = !e.sourceHandle ? cc.cases[0]!.id : e.sourceHandle === 'no' && !cc.cases.some((k) => k.id === 'no') ? ELSE_HANDLE : e.sourceHandle;
    return { id: e.id, source: e.source, target: e.target, sourceHandle: handle };
  });
};
/** Older Yes/No nodes are saved in the switch form (one path + Otherwise), so the canvas has one shape. */
const upgradeNodes = (c: Canvas): Canvas => ({
  ...c,
  nodes: c.nodes.map((n) => (n.type === 'condition' && !(n.data as ConditionNodeData).cases?.length ? { ...n, data: { label: (n.data as ConditionNodeData).label, ...conditionCases(n.data as ConditionNodeData) } } : n)),
});
const toCanvas = (nodes: FlowNode[], edges: Edge[]): Canvas => ({
  nodes: nodes.map((n) => ({ id: n.id, type: n.type as CanvasNodeType, x: Math.round(n.position.x), y: Math.round(n.position.y), data: n.data })),
  edges: edges.map((e) => ({ id: e.id, source: e.source, target: e.target, sourceHandle: e.sourceHandle || null })),
});
const uid = (prefix: string) => `${prefix}-${Math.random().toString(36).slice(2, 8)}`;

/** Screen pixels within which a dragged step snaps into line with another step. */
const SNAP_PX = 8;
interface Guides {
  x?: number;
  y?: number;
}

/**
 * Alignment while dragging one step: its left edge, centre or right edge (top, middle, bottom) snaps
 * to the same line of a nearby step, and a guide line shows which.
 */
function alignTo(me: FlowNode, pos: { x: number; y: number }, others: FlowNode[], zoom: number): { pos: { x: number; y: number }; guides: Guides } {
  const w = me.measured?.width ?? 240;
  const h = me.measured?.height ?? 100;
  const tol = SNAP_PX / Math.max(zoom, 0.1);
  let bestX: { d: number; x: number; line: number } | null = null;
  let bestY: { d: number; y: number; line: number } | null = null;
  for (const o of others) {
    const ow = o.measured?.width ?? 240;
    const oh = o.measured?.height ?? 100;
    // [my position that aligns, the guide line]
    const xs: [number, number][] = [
      [o.position.x, o.position.x],
      [o.position.x + ow / 2 - w / 2, o.position.x + ow / 2],
      [o.position.x + ow - w, o.position.x + ow],
    ];
    const ys: [number, number][] = [
      [o.position.y, o.position.y],
      [o.position.y + oh / 2 - h / 2, o.position.y + oh / 2],
      [o.position.y + oh - h, o.position.y + oh],
    ];
    for (const [x, line] of xs) {
      const d = Math.abs(pos.x - x);
      if (d <= tol && (!bestX || d < bestX.d)) bestX = { d, x, line };
    }
    for (const [y, line] of ys) {
      const d = Math.abs(pos.y - y);
      if (d <= tol && (!bestY || d < bestY.d)) bestY = { d, y, line };
    }
  }
  return { pos: { x: bestX?.x ?? pos.x, y: bestY?.y ?? pos.y }, guides: { x: bestX?.line, y: bestY?.line } };
}

/** Dashed guide lines in flow coordinates (inside <ReactFlow>, so they pan and zoom with it). */
function AlignmentGuides({ guides }: { guides: Guides }) {
  const zoom = useStore((s) => s.transform[2]);
  if (guides.x === undefined && guides.y === undefined) return null;
  const t = 1 / zoom;
  const line = 'pointer-events-none absolute left-0 top-0 border-info';
  return (
    <ViewportPortal>
      {guides.x !== undefined && <div className={line} style={{ transform: `translate(${guides.x}px, -50000px)`, height: 100000, borderLeftWidth: t, borderLeftStyle: 'dashed' }} />}
      {guides.y !== undefined && <div className={line} style={{ transform: `translate(-50000px, ${guides.y}px)`, width: 100000, borderTopWidth: t, borderTopStyle: 'dashed' }} />}
    </ViewportPortal>
  );
}

export default function FlowEditorPage() {
  const { wf = '' } = useParams();
  const { data, error } = useQuery({ queryKey: ['editor', wf], queryFn: () => api<EditorData>(`/flows/${wf}/editor`), staleTime: Infinity, gcTime: 0 });
  if (error)
    return (
      <div className="p-8">
        <ErrorNote error={error} />
        <Link to="/flows" className="mt-3 inline-block text-primary underline">
          Back to flows
        </Link>
      </div>
    );
  if (!data) return <Spinner label="Opening flow editor…" />;
  return (
    <ReactFlowProvider>
      <Editor key={`${data.flow.key}:${data.flow.version}`} initial={data} />
    </ReactFlowProvider>
  );
}

interface Snapshot {
  nodes: FlowNode[];
  edges: Edge[];
  def: WorkflowDef;
  settings: WorkflowSettings;
  /** The version restored from history, while that restore is not saved yet. */
  restoredFrom: number | null;
}

function Editor({ initial }: { initial: EditorData }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const invalidateFlows = useFlowsInvalidation();
  const rf = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(toNodes(upgradeNodes(initial.canvas)));
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(toEdges(initial.canvas));
  const [def, setDef] = useState<WorkflowDef>(initial.definition);
  const [settings, setSettings] = useState<WorkflowSettings>(initial.settings);
  const [calendarId, setCalendarId] = useState(initial.flow.calendarId);
  const [panel, dispatchPanel] = useReducer(panelReducer, PANEL_CLOSED);
  const [save, dispatchSave] = useReducer(saveReducer, SAVE_IDLE);
  const [paletteOpen, setPaletteOpen] = useState(true);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoredFrom, setRestoredFrom] = useState<number | null>(null);
  const [guides, setGuides] = useState<Guides>({});
  // Settings panel width: drag its left edge, or toggle wide; remembered per browser.
  const [panelWidth, setPanelWidth] = useState(() => {
    try {
      return clampPanel(Number(localStorage.getItem(PANEL_KEY)) || PANEL_DEFAULT);
    } catch {
      return PANEL_DEFAULT;
    }
  });
  const [resizing, setResizing] = useState(false);
  useEffect(() => {
    try {
      localStorage.setItem(PANEL_KEY, String(panelWidth));
    } catch {
      /* private mode */
    }
  }, [panelWidth]);
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    setResizing(true);
    const move = (ev: PointerEvent) => setPanelWidth(clampPanel(window.innerWidth - ev.clientX));
    const up = () => {
      setResizing(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const panelWide = panelWidth >= 600;
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [isDraft, setIsDraft] = useState(initial.flow.isDraft);
  const [savedAt, setSavedAt] = useState(() => JSON.stringify([initial.canvas, initial.definition, initial.settings, initial.flow.calendarId]));
  const savedStageKeys = useMemo(() => new Set(initial.definition.stages.map((s) => s.key)), [initial]);
  const savedFieldKeys = useMemo(() => new Set(initial.definition.fields.map((f) => f.key)), [initial]);

  // The panel keeps showing its last content while it slides shut.
  const lastOpen = useRef<PanelState>(panel);
  if (panel.kind !== 'closed') lastOpen.current = panel;
  const shown = panel.kind !== 'closed' ? panel : lastOpen.current;
  const selectedId = panel.kind === 'node' ? panel.id : null;

  // ---------- undo / redo (structural changes + coalesced edits)
  const past = useRef<Snapshot[]>([]);
  const future = useRef<Snapshot[]>([]);
  const lastPush = useRef(0);
  const [, force] = useState(0);
  const snapshot = useCallback((): Snapshot => ({ nodes, edges, def, settings, restoredFrom }), [nodes, edges, def, settings, restoredFrom]);
  const remember = useCallback(
    (coalesce = false) => {
      dispatchSave({ type: 'EDITED' });
      const now = Date.now();
      if (coalesce && now - lastPush.current < 800) return;
      lastPush.current = now;
      past.current = [...past.current.slice(-79), snapshot()];
      future.current = [];
      force((x) => x + 1);
    },
    [snapshot],
  );
  const restore = (s: Snapshot) => {
    setNodes(s.nodes);
    setEdges(s.edges);
    setDef(s.def);
    setSettings(s.settings);
    setRestoredFrom(s.restoredFrom);
    dispatchPanel({ type: 'REMOVED', ids: nodes.filter((n) => !s.nodes.some((m) => m.id === n.id)).map((n) => n.id) });
  };
  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(snapshot());
    restore(prev);
    force((x) => x + 1);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(snapshot());
    restore(next);
    force((x) => x + 1);
  };

  // ---------- live validation
  const canvas = useMemo(() => toCanvas(nodes, edges), [nodes, edges]);
  const compiled = useMemo(() => compileCanvas(canvas, def, settings), [canvas, def, settings]);
  const issues = useMemo(() => {
    const m = new Map<string, 'error' | 'warning'>();
    for (const w of compiled.warnings) if (w.nodeId) m.set(w.nodeId, 'warning');
    for (const e of compiled.errors) if (e.nodeId) m.set(e.nodeId, 'error');
    return m;
  }, [compiled]);
  const dirty = JSON.stringify([canvas, def, settings, calendarId]) !== savedAt;
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  // Opening view, once React Flow has measured every node: fit the whole flow, but if that
  // makes text unreadably small, start at a readable zoom on the beginning of the flow instead.
  const measured = useNodesInitialized();
  const framed = useRef(false);
  useEffect(() => {
    if (!measured || framed.current) return;
    framed.current = true;
    void rf.fitView({ ...FIT, duration: 0 }).then(() => {
      if (rf.getZoom() >= MIN_READABLE_ZOOM || !nodes.length) return;
      const minX = Math.min(...nodes.map((n) => n.position.x));
      const minY = Math.min(...nodes.map((n) => n.position.y));
      const maxY = Math.max(...nodes.map((n) => n.position.y + (n.measured?.height ?? 80)));
      const zoom = 0.8;
      const pane = document.querySelector('.react-flow')?.getBoundingClientRect();
      const top = pane ? Math.max(40, (pane.height - (maxY - minY) * zoom) / 2) : 120;
      void rf.setViewport({ x: -minX * zoom + (paletteOpen ? 320 : 80), y: -minY * zoom + top, zoom }, { duration: 500 });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- run once after measurement
  }, [measured]);

  // "Saved" tick fades after a moment.
  useEffect(() => {
    if (save.kind !== 'saved') return;
    const t = window.setTimeout(() => dispatchSave({ type: 'SETTLE' }), 2500);
    return () => window.clearTimeout(t);
  }, [save]);

  // ---------- selection helpers
  const select = useCallback(
    (id: string, opts: { center?: boolean } = {}) => {
      setNodes((ns) => ns.map((n) => (n.selected === (n.id === id) ? n : { ...n, selected: n.id === id })));
      dispatchPanel({ type: 'SELECT', id });
      if (opts.center) {
        const n = rf.getNode(id);
        if (n) void rf.setCenter(n.position.x + (n.measured?.width ?? 240) / 2, n.position.y + (n.measured?.height ?? 80) / 2, { zoom: Math.max(rf.getZoom(), 0.9), duration: 450 });
      }
    },
    [rf, setNodes],
  );
  const closePanel = useCallback(() => {
    dispatchPanel({ type: 'CLOSE' });
    setNodes((ns) => (ns.some((n) => n.selected) ? ns.map((n) => (n.selected ? { ...n, selected: false } : n)) : ns));
  }, [setNodes]);

  // ---------- graph editing
  const isValidConnection = useCallback(
    (c: Connection | Edge) => {
      const s = nodes.find((n) => n.id === c.source);
      const t = nodes.find((n) => n.id === c.target);
      if (!s || !t || s.id === t.id || t.type === 'note' || s.type === 'note') return false;
      if (s.type === 'condition' || s.type === 'timer') return isMain(t);
      if (s.type === 'jump') return isStageNode(t) || t.type === 'condition' || t.type === 'timer';
      // From a stage / document step: the next step, or a side node (message, webhook, jump).
      return isStageNode(s) && (isMain(t) || ['message', 'webhook', 'jump'].includes(t.type!));
    },
    [nodes],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      remember();
      setEdges((es) => {
        const s = nodes.find((n) => n.id === c.source);
        const t = nodes.find((n) => n.id === c.target);
        let next = es;
        // Each output leads to one next step (a stage's single output, or a Depends-on's Yes / No):
        // re-connecting an output replaces its old link. Several steps may lead INTO one step — that is
        // where branches rejoin.
        if (isMain(s) && isMain(t)) {
          next = es.filter((e) => !(e.source === c.source && (e.sourceHandle ?? null) === (c.sourceHandle ?? null) && isMain(nodes.find((n) => n.id === e.target))));
        }
        // A Stage Jump points at exactly one stage.
        if (s?.type === 'jump') next = next.filter((e) => e.source !== c.source);
        return addEdge({ ...c, id: `e-${c.source}-${c.sourceHandle ? `${c.sourceHandle}-` : ''}${c.target}` }, next);
      });
    },
    [nodes, remember, setEdges],
  );

  const addNode = useCallback(
    (type: CanvasNodeType, position?: { x: number; y: number }) => {
      remember();
      const pos = position ?? freeSpot(rf.getNodes() as FlowNode[],rf.screenToFlowPosition({ x: window.innerWidth / 2 - 120, y: window.innerHeight / 2 - 40 }));
      let data: Record<string, unknown> = {};
      let id = uid(type);
      if (type === 'stage') {
        let n = def.stages.length + 1;
        while (def.stages.some((s) => s.key === `stage_${n}`)) n++;
        const stage: StageDef = { key: `stage_${n}`, name: `Stage ${n}`, color: STAGE_COLORS[n % STAGE_COLORS.length]!, responsibleGroups: [], planned: { mode: 'none' }, completion: { kind: 'manual' } };
        setDef((d) => ({ ...d, stages: [...d.stages, stage] }));
        id = `stage-${stage.key}`;
        data = { stageKey: stage.key };
      } else if (type === 'document') {
        // A document step is a stage that owns a file field for the generated document.
        let n = 1;
        while (def.stages.some((s) => s.key === `document_${n}`) || def.fields.some((f) => f.key === `document_${n}_file`)) n++;
        const key = `document_${n}`;
        const fieldKey = `${key}_file`;
        const stage: StageDef = {
          key,
          name: `Document ${n}`,
          color: '#4f46e5',
          responsibleGroups: [],
          planned: { mode: 'none' },
          completion: { kind: 'manual' },
          document: { fieldKey, fileName: 'Document {{record_number}}', requireReview: true, source: 'custom', format: 'pdf', orientation: 'portrait', body: '' },
        };
        const field: FieldDef = { key: fieldKey, label: 'Generated document', type: 'file', stageKey: key, required: true, unique: false, hidden: false, searchKey: false, frozen: false, lineItem: false, viewGroups: ['ALL'], editGroups: [] };
        setDef((d) => ({ ...d, stages: [...d.stages, stage], fields: [...d.fields, field] }));
        id = `stage-${key}`;
        data = { stageKey: key };
      } else if (type === 'condition') data = { label: 'Depends on', cases: [], otherwise: false };
      else if (type === 'jump') data = { label: 'Stage Jump', when: { mode: 'all', conditions: [] }, clearFields: [] };
      else if (type === 'timer') data = { base: { kind: 'previous_stage' }, tat: { kind: 'fixed', hours: 8 } };
      else if (type === 'message') data = { name: 'Message', event: 'stage_activated' };
      else if (type === 'note') data = { text: '' };
      setNodes((ns) => [...ns.map((n) => (n.selected ? { ...n, selected: false } : n)), { id, type, position: pos, data, selected: true }]);
      dispatchPanel({ type: 'SELECT', id });
    },
    [def.stages, def.fields, remember, rf, setNodes],
  );

  const deleteNodes = useCallback(
    (ids: string[]) => {
      if (!ids.length) return;
      remember();
      const gone = nodes.filter((n) => ids.includes(n.id));
      const stageKeys = gone.filter((n) => isStageNode(n)).map((n) => n.data.stageKey as string);
      if (stageKeys.length) setDef((d) => ({ ...d, stages: d.stages.filter((s) => !stageKeys.includes(s.key)), fields: d.fields.filter((f) => !stageKeys.includes(f.stageKey)) }));
      setNodes((ns) => ns.filter((n) => !ids.includes(n.id)));
      setEdges((es) => es.filter((e) => !ids.includes(e.source) && !ids.includes(e.target)));
      dispatchPanel({ type: 'REMOVED', ids });
    },
    [nodes, remember, setEdges, setNodes],
  );

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    const type = e.dataTransfer.getData('application/fms-node') as CanvasNodeType;
    if (type) addNode(type, rf.screenToFlowPosition({ x: e.clientX - 120, y: e.clientY - 30 }));
  };

  const tidy = () => {
    remember();
    const laid = layoutCanvas(canvas);
    setNodes((ns) =>
      ns.map((n) => {
        const m = laid.nodes.find((x) => x.id === n.id);
        return m ? { ...n, position: { x: m.x, y: m.y } } : n;
      }),
    );
    window.setTimeout(() => void rf.fitView(FIT), 60);
  };

  /** Dragging one step snaps it into line with its neighbours; several steps move freely. */
  const onNodesChangeAligned = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      const c = changes.length === 1 && changes[0]!.type === 'position' ? changes[0]! : null;
      if (c?.type === 'position' && c.dragging && c.position) {
        const all = rf.getNodes() as FlowNode[];
        const me = all.find((n) => n.id === c.id);
        if (me) {
          const near = all.filter((n) => n.id !== c.id && Math.abs(n.position.x - c.position!.x) < 1600 && Math.abs(n.position.y - c.position!.y) < 1200);
          const aligned = alignTo(me, c.position, near, rf.getZoom());
          setGuides((g) => (g.x === aligned.guides.x && g.y === aligned.guides.y ? g : aligned.guides));
          onNodesChange([{ ...c, position: aligned.pos }]);
          return;
        }
      }
      if (changes.some((x) => x.type === 'position' && !x.dragging)) setGuides((g) => (g.x === undefined && g.y === undefined ? g : {}));
      onNodesChange(changes);
    },
    [onNodesChange, rf],
  );

  /** Version history › Restore: the old version replaces the editor contents (undoable), saved like any edit. */
  const restoreVersion = (v: FlowVersion) => {
    remember();
    const layout = upgradeNodes(v.canvas ?? reconcileCanvas(canvas, v.definition, v.settings));
    setNodes(toNodes(layout));
    setEdges(toEdges(layout));
    setDef(v.definition);
    setSettings(v.settings);
    setRestoredFrom(v.version);
    dispatchPanel({ type: 'CLOSE' });
    window.setTimeout(() => void rf.fitView(FIT), 80);
    toast.success(`Version ${v.version} is in the editor`, { description: 'Review it, then Save to keep it. Undo brings back what you had.' });
  };

  // ---------- inspector callbacks
  const onNodeData = (id: string, patch: Record<string, unknown>) => {
    remember(true);
    setNodes((ns) => ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, ...patch } } : n)));
    // A removed path (or switched-off Otherwise) takes its connection with it.
    if ('cases' in patch || 'otherwise' in patch) {
      const node = nodes.find((n) => n.id === id);
      if (node?.type === 'condition') {
        const cc = conditionCases({ ...(node.data as ConditionNodeData), ...(patch as Partial<ConditionNodeData>) });
        const valid = new Set([...cc.cases.map((c) => c.id), ...(cc.otherwise ? [ELSE_HANDLE] : [])]);
        setEdges((es) => es.filter((e) => e.source !== id || valid.has(e.sourceHandle ?? '')));
      }
    }
  };
  /** Inspector "Goes to": connect one output of a node to a target (or disconnect it). */
  const connectOutput = (sourceId: string, handle: string | null, targetId: string | null) => {
    remember();
    setEdges((es) => {
      // A Depends-on output is identified by its handle; a Stage Jump has a single output.
      const rest = es.filter((e) => !(e.source === sourceId && (handle ? e.sourceHandle === handle : true)));
      return targetId ? [...rest, { id: `e-${sourceId}-${handle ? `${handle}-` : ''}${targetId}`, source: sourceId, target: targetId, sourceHandle: handle }] : rest;
    });
  };
  const onStage = (key: string, patch: Partial<StageDef>) => {
    remember(true);
    setDef((d) => ({ ...d, stages: d.stages.map((s) => (s.key === key ? { ...s, ...patch } : s)) }));
  };
  const onFields = (fn: (f: FieldDef[]) => FieldDef[]) => {
    remember(true);
    setDef((d) => ({ ...d, fields: fn(d.fields) }));
  };

  // ---------- keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input, textarea, select, [contenteditable]');
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === 's') {
        e.preventDefault();
        void doSave(false);
        return;
      }
      // An open dialog (preview, large field editor) owns the keyboard: Esc closes only the dialog,
      // and undo / delete must not change the canvas behind it.
      if (typing || document.querySelector('dialog[open]')) return;
      if (e.key === 'Escape') closePanel();
      else if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && e.key === '.') {
        e.preventDefault();
        dispatchPanel({ type: 'TOGGLE_SETTINGS' });
      } else if (e.key === 'Enter' && !mod) {
        // Enter opens the settings of the one selected step (a click only selects).
        const sel = nodes.filter((n) => n.selected);
        if (sel.length === 1 && !(e.target as HTMLElement).closest('button, a')) {
          e.preventDefault();
          select(sel[0]!.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  async function doSave(publish: boolean) {
    if (!canStartSave(save)) return;
    if (compiled.errors.length) {
      setIssuesOpen(true);
      toast.error('Fix the highlighted problems first', { description: compiled.errors[0]?.message });
      return;
    }
    dispatchSave({ type: 'START', publish });
    try {
      const r = await api<{ version: number; warnings: { message: string }[]; isDraft: boolean; publicFormId?: string | null }>(`/flows/${initial.flow.key}/editor`, {
        method: 'PUT',
        body: { canvas, definition: def, settings, calendarId, publish, ...(restoredFrom ? { restoredFrom } : {}) },
      });
      // The server owns public link ids (it replaces one that clashes with another flow): adopt its id
      // so the link shown in Stage › Public Form Access is the one that works.
      let savedDef = def;
      const intake = def.stages[0];
      if (intake?.publicForm && r.publicFormId && r.publicFormId !== intake.publicFormId) {
        savedDef = { ...def, stages: [{ ...intake, publicFormId: r.publicFormId }, ...def.stages.slice(1)] };
        setDef(savedDef);
      }
      setSavedAt(JSON.stringify([canvas, savedDef, settings, calendarId]));
      setIsDraft(r.isDraft);
      setRestoredFrom(null);
      dispatchSave({ type: 'SUCCEEDED', version: r.version, at: Date.now() });
      invalidateFlows();
      void qc.invalidateQueries({ queryKey: ['definition', initial.flow.key] });
      void qc.invalidateQueries({ queryKey: ['flow-versions', initial.flow.key] });
      if (publish) toast.success('Flow published — it is live');
      if (r.warnings.length) toast.message(`${r.warnings.length} note${r.warnings.length === 1 ? '' : 's'}`, { description: r.warnings[0]!.message });
    } catch (e) {
      const details = e instanceof ApiError ? (e.details as unknown as { errors?: { message: string }[] } | undefined) : undefined;
      dispatchSave({ type: 'FAILED', message: (e as Error).message });
      toast.error((e as Error).message, { description: details?.errors?.slice(1, 3).map((x) => x.message).join('\n') });
    }
  }

  function leave(to: string) {
    if (dirty && !window.confirm('You have unsaved changes. Leave anyway?')) return;
    navigate(to);
  }

  /** Human name of a node, for "→ leads to" labels. */
  const nodeName = useCallback(
    (id: string) => {
      const n = nodes.find((x) => x.id === id);
      if (!n) return 'Unknown';
      if (isStageNode(n)) return def.stages.find((s) => s.key === n.data.stageKey)?.name ?? (n.type === 'document' ? 'Document' : 'Stage');
      if (n.type === 'condition') return (n.data.label as string) || 'Depends on';
      if (n.type === 'timer') return 'Delay/Timer';
      return PALETTE.find((p) => p.type === n.type)?.label ?? n.type!;
    },
    [nodes, def.stages],
  );
  const targets = useMemo(() => new Map(edges.map((e) => [`${e.source}:${e.sourceHandle ?? ''}`, nodeName(e.target)])), [edges, nodeName]);

  // Path outputs are labelled; jump links are dashed; edges touching the selected node light up and flow.
  const viewEdges = useMemo(() => {
    const byId = new Map(nodes.map((n) => [n.id, n]));
    // The step whose settings are open, else the one selected step.
    const picked = nodes.filter((n) => n.selected);
    const focus = selectedId ?? (picked.length === 1 ? picked[0]!.id : null);
    return edges.map((e) => {
      const src = byId.get(e.source);
      const hot = !!focus && (e.source === focus || e.target === focus);
      let decorated: Edge = e;
      if (src?.type === 'condition') {
        const { cases } = conditionCases(src.data as ConditionNodeData);
        const k = cases.findIndex((c) => c.id === e.sourceHandle);
        const isElse = e.sourceHandle === ELSE_HANDLE;
        const text = isElse ? 'Otherwise' : k >= 0 ? cases[k]!.label || `Path ${k + 1}` : '?';
        const color = isElse ? 'var(--color-muted)' : '#0ea5e9';
        decorated = { ...e, label: text, labelStyle: { fill: color, fontWeight: 600, fontSize: 11 }, labelBgStyle: { fill: 'var(--color-surface)' }, labelBgPadding: [6, 3], labelBgBorderRadius: 6, style: { stroke: color, strokeWidth: 1.75 } };
      } else if (src?.type === 'jump') {
        decorated = { ...e, label: 'Jump', animated: true, labelStyle: { fill: '#e11d48', fontWeight: 600, fontSize: 11 }, labelBgStyle: { fill: 'var(--color-surface)' }, labelBgPadding: [6, 3], labelBgBorderRadius: 6, style: { stroke: '#e11d48', strokeWidth: 1.75, strokeDasharray: '6 4' } };
      }
      if (!hot) return decorated;
      return { ...decorated, animated: true, style: { ...decorated.style, stroke: (decorated.style?.stroke as string | undefined) ?? 'var(--color-info)', strokeWidth: 2.25 }, zIndex: 1 };
    });
  }, [edges, nodes, selectedId]);

  const shownNode = shown.kind === 'node' ? (nodes.find((n) => n.id === shown.id) ?? null) : null;
  const ctx = useMemo(
    () => ({ def, issues, targets, onPreview: setPreviewId, onOpen: (id: string) => select(id), onDelete: (id: string) => deleteNodes([id]) }),
    [def, issues, targets, select, deleteNodes],
  );
  const previewNode = previewId ? (nodes.find((n) => n.id === previewId) ?? null) : null;
  // A preview belongs to a node that exists: deleting it (or undoing its creation) ends the preview,
  // instead of the dialog popping up again later when an undo brings the node back.
  useEffect(() => {
    if (previewId && !previewNode) setPreviewId(null);
  }, [previewId, previewNode]);
  const errorCount = compiled.errors.length;
  const warnCount = compiled.warnings.length;
  const panelOpen = panel.kind !== 'closed';
  const saving = save.kind === 'saving';

  return (
    <EditorContext.Provider value={ctx}>
      <div className="flex h-full flex-col bg-bg">
        {/* ---------------- top bar */}
        <header className="glass z-20 flex h-14 shrink-0 items-center gap-2 border-x-0 border-t-0 px-3">
          <Button size="sm" icon={<ArrowLeft className="size-4" />} onClick={() => leave('/flows')}>
            Back
          </Button>
          <button
            type="button"
            className="flex min-w-0 items-center gap-2 rounded-xl px-3 py-1.5 font-semibold transition-colors hover:bg-surface-2"
            onClick={() => dispatchPanel({ type: 'TOGGLE_SETTINGS' })}
            title="Flow settings"
          >
            <span className="max-w-64 truncate">{def.name}</span>
            <Pencil className="size-3.5 text-muted" />
          </button>
          <Select className="h-8 w-auto py-0 text-[13px]" aria-label="View" value="flow" onChange={(e) => leave(e.target.value === 'form' ? `/admin/workflows?wf=${initial.flow.key}` : e.target.value === 'records' ? `/w/${initial.flow.key}` : `/w/${initial.flow.key}/reports`)}>
            <option value="flow">Flow Editor</option>
            <option value="form">Form editor (advanced)</option>
            {!isDraft && <option value="records">Records</option>}
            {!isDraft && <option value="reports">Reports</option>}
          </Select>
          <Badge tone={isDraft ? 'info' : 'success'}>{isDraft ? 'Draft' : 'Live'}</Badge>
          <span className={clsx('flex items-center gap-1 text-xs transition-opacity duration-300', dirty || save.kind === 'saved' ? 'opacity-100' : 'opacity-0')} aria-live="polite">
            {save.kind === 'saved' ? (
              <span className="flex items-center gap-1 text-success">
                <Check className="size-3.5" /> Saved v{save.version}
              </span>
            ) : (
              dirty && <span className={restoredFrom ? 'font-medium text-warning' : 'text-muted'}>{restoredFrom ? `Restored v${restoredFrom} — not saved yet` : 'Unsaved changes'}</span>
            )}
          </span>

          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setIssuesOpen(!issuesOpen)}
              aria-expanded={issuesOpen}
              className={clsx(
                'flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors duration-200',
                errorCount ? 'border-danger/40 bg-danger-soft text-danger' : warnCount ? 'border-warning/40 bg-warning-soft text-warning' : 'border-success/30 bg-success-soft text-success',
              )}
            >
              {errorCount ? <CircleAlert className="size-3.5" /> : warnCount ? <TriangleAlert className="size-3.5" /> : <CircleCheck className="size-3.5" />}
              {errorCount ? `${errorCount} problem${errorCount === 1 ? '' : 's'}` : warnCount ? `${warnCount} note${warnCount === 1 ? '' : 's'}` : 'Ready'}
            </button>
            <span className="mx-1 h-5 w-px bg-line" aria-hidden />
            <Button size="sm" variant="ghost" aria-label="Tidy layout" title="Tidy layout" icon={<LayoutGrid className="size-4" />} onClick={tidy} />
            <Button size="sm" variant="ghost" aria-label="Fit to screen" title="Fit to screen" icon={<Maximize2 className="size-4" />} onClick={() => void rf.fitView(FIT)} />
            <Button size="sm" variant="ghost" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={!past.current.length} icon={<Undo2 className="size-4" />} onClick={undo} />
            <Button size="sm" variant="ghost" aria-label="Redo" title="Redo (Ctrl+Y)" disabled={!future.current.length} icon={<Redo2 className="size-4" />} onClick={redo} />
            <Button size="sm" variant="ghost" title="Version history — compare and restore" icon={<History className="size-4" />} onClick={() => setHistoryOpen(true)} className="max-lg:[&>span]:sr-only">
              <span>History</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              aria-label="Flow settings"
              aria-pressed={panel.kind === 'settings'}
              title="Flow settings (Ctrl+.)"
              className={clsx(panel.kind === 'settings' && 'bg-surface-2 text-fg')}
              icon={<SlidersHorizontal className="size-4" />}
              onClick={() => dispatchPanel({ type: 'TOGGLE_SETTINGS' })}
            />
            <span className="mx-1 h-5 w-px bg-line" aria-hidden />
            <Button size="sm" icon={<Save className="size-4" />} loading={saving && !save.publish} disabled={!dirty || saving} onClick={() => void doSave(false)}>
              Save
            </Button>
            {isDraft && (
              <Button size="sm" variant="primary" icon={<Rocket className="size-4" />} loading={saving && save.publish} disabled={saving} onClick={() => void doSave(true)}>
                Publish
              </Button>
            )}
          </div>
        </header>

        <div className="relative flex min-h-0 flex-1 overflow-hidden">
          {/* ---------------- canvas */}
          <div className="dot-grid relative min-w-0 flex-1" onDragOver={(e) => (e.preventDefault(), (e.dataTransfer.dropEffect = 'move'))} onDrop={onDrop}>
            <ReactFlow<FlowNode, Edge>
              nodes={nodes}
              edges={viewEdges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChangeAligned}
              onEdgesChange={onEdgesChange}
              onConnect={onConnect}
              isValidConnection={isValidConnection}
              onNodeDragStart={() => remember()}
              onNodeDragStop={() => setGuides({})}
              onNodesDelete={(ns) => deleteNodes(ns.map((n) => n.id))}
              onEdgesDelete={() => remember()}
              // Moving or touching a step never opens its settings: a click selects it (its toolbar
              // offers Settings), a double-click / Enter / the Settings button opens them. While the
              // panel is already open, clicking another step switches the panel to it.
              onNodeClick={(_, n) => panel.kind === 'node' && dispatchPanel({ type: 'SELECT', id: n.id })}
              onNodeDoubleClick={(_, n) => select(n.id, { center: true })}
              onPaneClick={closePanel}
              selectNodesOnDrag={false}
              nodeDragThreshold={5}
              nodeClickDistance={5}
              deleteKeyCode={['Delete', 'Backspace']}
              defaultEdgeOptions={{ type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 }, style: { strokeWidth: 1.5 } }}
              connectionLineType={ConnectionLineType.SmoothStep}
              connectionLineStyle={{ stroke: 'var(--color-info)', strokeWidth: 2, strokeDasharray: '6 4' }}
              minZoom={0.2}
              maxZoom={1.75}
              proOptions={{ hideAttribution: true }}
            >
              <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="var(--color-line)" />
              <AlignmentGuides guides={guides} />
              <Controls position="bottom-left" showInteractive={false} />
              <MiniMap pannable zoomable position="bottom-right" nodeBorderRadius={6} nodeColor={(n) => (isStageNode(n) ? (def.stages.find((s) => s.key === n.data.stageKey)?.color ?? '#94a3b8') : '#cbd5e1')} maskColor="rgb(0 0 0 / 0.06)" />
            </ReactFlow>

            {/* ---------------- palette (collapses to a pill) */}
            <div
              className={clsx(
                'absolute left-4 top-4 z-10 overflow-hidden rounded-2xl border border-line/80 bg-surface/95 shadow-[var(--shadow-float)] backdrop-blur-xl transition-[width,max-height] duration-300 ease-[var(--ease-apple)]',
                paletteOpen ? 'max-h-[640px] w-[280px]' : 'max-h-12 w-12',
              )}
            >
              <button
                type="button"
                onClick={() => setPaletteOpen(true)}
                aria-label="Open steps panel"
                className={clsx('absolute left-0 top-0 grid size-12 place-items-center text-muted transition-opacity duration-200 hover:text-fg', paletteOpen ? 'pointer-events-none opacity-0' : 'opacity-100')}
              >
                <LayoutGrid className="size-5" />
              </button>
              <div className={clsx('w-[280px] p-4 transition-opacity duration-200', paletteOpen ? 'opacity-100 delay-100' : 'pointer-events-none opacity-0')}>
                <div className="mb-1 flex items-center justify-between">
                  <h2 className="text-[17px] font-semibold">Workflow Steps</h2>
                  <button type="button" onClick={() => setPaletteOpen(false)} aria-label="Collapse steps panel" className="grid size-7 place-items-center rounded-lg text-muted transition-colors hover:bg-surface-2 hover:text-fg">
                    <ChevronLeft className="size-4" />
                  </button>
                </div>
                <p className="mb-3 text-xs text-muted">Drag onto the canvas, or click to add.</p>
                <div className="grid grid-cols-2 gap-2">
                  {PALETTE.map((p) => {
                    const tone = TONES[p.tone]!;
                    return (
                      <button
                        key={p.type}
                        type="button"
                        draggable
                        title={p.hint}
                        tabIndex={paletteOpen ? 0 : -1}
                        onDragStart={(e) => {
                          e.dataTransfer.setData('application/fms-node', p.type);
                          e.dataTransfer.effectAllowed = 'move';
                        }}
                        onClick={() => addNode(p.type)}
                        className={clsx(
                          'flex cursor-grab flex-col items-center gap-1.5 rounded-xl border bg-surface px-2 py-3 text-[13px] font-medium transition-[transform,box-shadow] duration-200 ease-[var(--ease-apple)] hover:-translate-y-0.5 hover:shadow-[var(--shadow-float)] active:scale-[0.97] active:cursor-grabbing',
                          tone.border,
                        )}
                      >
                        <span className={clsx('grid size-8 place-items-center rounded-lg [&>svg]:size-4', tone.bg, tone.fg)}>{p.icon}</span>
                        {p.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* ---------------- checks */}
            {issuesOpen && (errorCount > 0 || warnCount > 0) && (
              <div className="absolute bottom-4 left-1/2 z-10 max-h-56 w-[min(640px,calc(100%-2rem))] -translate-x-1/2 animate-pop-in overflow-y-auto rounded-2xl border border-line bg-surface/95 p-3 shadow-[var(--shadow-float)] backdrop-blur-xl">
                <div className="mb-2 flex items-center justify-between">
                  <p className="text-sm font-semibold">Checks</p>
                  <button type="button" aria-label="Hide checks" className="grid size-7 place-items-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg" onClick={() => setIssuesOpen(false)}>
                    <X className="size-4" />
                  </button>
                </div>
                <ul className="space-y-0.5 text-sm">
                  {[...compiled.errors.map((x) => ({ ...x, level: 'error' as const })), ...compiled.warnings.map((x) => ({ ...x, level: 'warning' as const }))].map((x, i) => (
                    <li key={i}>
                      <button
                        type="button"
                        disabled={!x.nodeId}
                        onClick={() => x.nodeId && select(x.nodeId, { center: true })}
                        className={clsx('flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-colors enabled:hover:bg-surface-2', x.level === 'error' ? 'text-danger' : 'text-warning')}
                      >
                        {x.level === 'error' ? <CircleAlert className="mt-0.5 size-4 shrink-0" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0" />}
                        <span className="text-fg">{x.message}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {initial.otherRules > 0 && (
              <p className="absolute right-4 top-4 z-10 rounded-full border border-line bg-surface/95 px-3 py-1 text-xs text-muted shadow-[var(--shadow-soft)] backdrop-blur">
                + {initial.otherRules} rule{initial.otherRules === 1 ? '' : 's'} on the <Link className="text-info underline" to="/admin/rules">Rules page</Link>
              </p>
            )}
          </div>

          {/* ---------------- side panel: slides in for a node or flow settings, out on canvas click / Esc */}
          <div
            className={clsx('relative shrink-0 overflow-hidden', !resizing && 'transition-[width] duration-[380ms] ease-[var(--ease-apple)]')}
            style={{ width: panelOpen ? panelWidth : 0 }}
            aria-hidden={!panelOpen}
            inert={!panelOpen}
          >
            {/* Drag the left edge to resize; double-click resets. */}
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize settings panel"
              aria-valuemin={PANEL_MIN}
              aria-valuenow={panelWidth}
              tabIndex={0}
              onPointerDown={startResize}
              onDoubleClick={() => setPanelWidth(PANEL_DEFAULT)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft') setPanelWidth((w) => clampPanel(w + 40));
                if (e.key === 'ArrowRight') setPanelWidth((w) => clampPanel(w - 40));
              }}
              className={clsx('group absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize', resizing && 'bg-info/20')}
              title="Drag to resize · double-click to reset"
            >
              <span className={clsx('absolute inset-y-0 left-0 w-0.5 transition-colors', resizing ? 'bg-info' : 'bg-transparent group-hover:bg-info/60')} />
            </div>
            <div className={clsx('absolute inset-y-0 right-0 transition-[transform,opacity] duration-[380ms] ease-[var(--ease-apple)]', panelOpen ? 'translate-x-0 opacity-100' : 'translate-x-6 opacity-0')} style={{ width: panelWidth }}>
              <div key={shown.kind === 'node' ? shown.id : shown.kind} className="h-full animate-page-in">
                <Inspector
                  node={shownNode}
                  def={def}
                  settings={settings}
                  groups={initial.groups}
                  users={initial.users ?? []}
                  calendars={initial.calendars}
                  calendarId={calendarId}
                  savedStageKeys={savedStageKeys}
                  savedFieldKeys={savedFieldKeys}
                  onNodeData={onNodeData}
                  onStage={onStage}
                  onFields={onFields}
                  onSettings={(s) => (remember(true), setSettings(s))}
                  onCalendar={setCalendarId}
                  onDelete={(id) => deleteNodes([id])}
                  nodes={nodes}
                  edges={edges}
                  nodeName={nodeName}
                  onConnectOutput={connectOutput}
                  onClose={closePanel}
                  flowKey={initial.flow.key}
                  wide={panelWide}
                  onToggleWide={() => setPanelWidth(panelWide ? PANEL_DEFAULT : clampPanel(PANEL_WIDE))}
                  onPreview={setPreviewId}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
      {previewNode && (
        <StepPreview
          node={previewNode}
          def={def}
          flowKey={initial.flow.key}
          nodeName={nodeName}
          targetOf={(handle) => {
            const e = edges.find((x) => x.source === previewNode.id && (handle === null || x.sourceHandle === handle));
            return e ? nodeName(e.target) : null;
          }}
          onClose={() => setPreviewId(null)}
        />
      )}
      {historyOpen && <VersionHistory flowKey={initial.flow.key} editor={{ definition: def, settings, canvas }} dirty={dirty} isDraft={isDraft} onRestore={restoreVersion} onClose={() => setHistoryOpen(false)} />}
    </EditorContext.Provider>
  );
}
