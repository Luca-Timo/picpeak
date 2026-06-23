/**
 * Admin → Workflows → canvas editor (React Flow).
 *
 * Drag nodes from the palette, connect handle→handle (branch/gate/loop expose
 * yes/no · confirm/deny · loop/exit handles), click a node to edit its config
 * in the side panel, and Save (writes a new version; in-flight runs keep
 * theirs). The graph maps 1:1 onto workflow_nodes/workflow_edges.
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import {
  ReactFlow, Background, Controls, MiniMap, addEdge, useNodesState, useEdgesState,
  Handle, Position, type Connection, type Node, type Edge,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ArrowLeft, Save, Trash2 } from 'lucide-react';
import { Button, Loading } from '../../../components/common';
import { workflowsService, type WorkflowNodeType } from '../../../services/workflows.service';

const PALETTE: WorkflowNodeType[] = ['trigger', 'condition', 'branch', 'loop', 'wait', 'action', 'gate', 'webhook'];
const TRIGGERS = [
  'invoice.sent', 'invoice.paid', 'invoice.overdue', 'quote.accepted', 'quote.declined',
  'contract.signed', 'event.date_approaching', 'gallery.published', 'gallery.expiring', 'customer.created',
];

const COLORS: Record<string, string> = {
  trigger: '#1D9E75', condition: '#BA7517', branch: '#BA7517', loop: '#378ADD',
  wait: '#888780', action: '#534AB7', gate: '#7F77DD', webhook: '#888780',
};

const SOURCE_HANDLES: Record<string, string[]> = {
  condition: ['yes', 'no'], branch: ['yes', 'no'], gate: ['confirm', 'deny'], loop: ['loop', 'exit'],
};

function WfNode({ data }: { data: { label: string; nodeType: string } }) {
  const handles = SOURCE_HANDLES[data.nodeType];
  const color = COLORS[data.nodeType] || '#888780';
  return (
    <div style={{ borderColor: color }} className="rounded-md border-2 bg-white dark:bg-neutral-900 px-3 py-2 min-w-[140px] text-center shadow-sm">
      {data.nodeType !== 'trigger' && <Handle type="target" position={Position.Top} />}
      <div className="text-[10px] uppercase tracking-wide" style={{ color }}>{data.nodeType}</div>
      <div className="text-sm text-neutral-900 dark:text-neutral-100">{data.label}</div>
      {handles ? (
        handles.map((h, i) => (
          <Handle key={h} id={h} type="source" position={Position.Bottom} style={{ left: `${(100 / (handles.length + 1)) * (i + 1)}%` }}>
          </Handle>
        ))
      ) : (
        <Handle type="source" position={Position.Bottom} />
      )}
    </div>
  );
}

const nodeTypes = { wf: WfNode };

export const WorkflowEditorPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { id } = useParams<{ id: string }>();
  const workflowId = Number(id);

  const { data: workflow, isLoading } = useQuery({
    queryKey: ['workflow', workflowId],
    queryFn: () => workflowsService.get(workflowId),
    enabled: Number.isFinite(workflowId),
  });

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [name, setName] = useState('');
  const [triggerType, setTriggerType] = useState('invoice.sent');
  const [enabled, setEnabled] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [configText, setConfigText] = useState('{}');
  const [counter, setCounter] = useState(1);

  useEffect(() => {
    if (!workflow) return;
    setName(workflow.name);
    setTriggerType(workflow.trigger_type);
    setEnabled(workflow.enabled === true || workflow.enabled === 1);
    setNodes(workflow.nodes.map((n) => ({
      id: n.node_key,
      type: 'wf',
      position: { x: n.pos_x || 0, y: n.pos_y || 0 },
      data: { label: n.node_key, nodeType: n.type, config: n.config || {} },
    })));
    setEdges(workflow.edges.map((e, i) => ({
      id: `e${i}`,
      source: e.from_node,
      target: e.to_node,
      sourceHandle: e.from_handle || undefined,
      label: e.from_handle || undefined,
    })));
  }, [workflow, setNodes, setEdges]);

  const onConnect = useCallback((c: Connection) => {
    setEdges((eds) => addEdge({ ...c, label: c.sourceHandle || undefined }, eds));
  }, [setEdges]);

  const addNode = (type: WorkflowNodeType) => {
    const key = type === 'trigger' ? 'trigger' : `${type}_${counter}`;
    setCounter((c) => c + 1);
    setNodes((nds) => nds.concat({
      id: key, type: 'wf', position: { x: 120 + Math.random() * 240, y: 120 + Math.random() * 240 },
      data: { label: key, nodeType: type, config: {} },
    }));
  };

  const selectedNode = useMemo(() => nodes.find((n) => n.id === selectedId) || null, [nodes, selectedId]);
  useEffect(() => {
    if (selectedNode) setConfigText(JSON.stringify((selectedNode.data as any).config || {}, null, 2));
  }, [selectedNode]);

  const applyConfig = () => {
    if (!selectedId) return;
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(configText || '{}'); } catch (e) { toast.error(t('workflows.editor.badJson', 'Config is not valid JSON') as string); return; }
    setNodes((nds) => nds.map((n) => (n.id === selectedId ? { ...n, data: { ...n.data, config: parsed } } : n)));
    toast.success(t('workflows.editor.configApplied', 'Config applied (remember to Save)') as string);
  };

  const deleteSelected = () => {
    if (!selectedId) return;
    setNodes((nds) => nds.filter((n) => n.id !== selectedId));
    setEdges((eds) => eds.filter((e) => e.source !== selectedId && e.target !== selectedId));
    setSelectedId(null);
  };

  const saveMutation = useMutation({
    mutationFn: () => workflowsService.update(workflowId, {
      name: name.trim() || 'Untitled',
      trigger_type: triggerType,
      enabled,
      nodes: nodes.map((n) => ({
        node_key: n.id, type: (n.data as any).nodeType, config: (n.data as any).config || {},
        pos_x: Math.round(n.position.x), pos_y: Math.round(n.position.y),
      })),
      edges: edges.map((e) => ({
        from_node: e.source, from_handle: e.sourceHandle || null, to_node: e.target,
      })),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workflow', workflowId] });
      qc.invalidateQueries({ queryKey: ['workflows'] });
      toast.success(t('workflows.editor.saved', 'Workflow saved') as string);
    },
    onError: (err: any) => toast.error(err?.response?.data?.error || (t('workflows.editor.saveFailed', 'Could not save') as string)),
  });

  if (isLoading) return <div className="p-10"><Loading /></div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 flex-wrap">
        <Button variant="ghost" size="sm" onClick={() => navigate('/admin/workflows')} aria-label={t('common.back', 'Back') as string}>
          <ArrowLeft className="w-4 h-4" />
        </Button>
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          className="px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100"
          placeholder={t('workflows.editor.namePlaceholder', 'Workflow name') as string}
        />
        <select
          value={triggerType} onChange={(e) => setTriggerType(e.target.value)}
          className="px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100 text-sm"
        >
          {TRIGGERS.map((tr) => <option key={tr} value={tr}>{tr}</option>)}
        </select>
        <label className="text-sm text-neutral-700 dark:text-neutral-300 flex items-center gap-1.5">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {t('workflows.enabled', 'Enabled')}
        </label>
        <div className="ml-auto">
          <Button variant="primary" isLoading={saveMutation.isPending} onClick={() => saveMutation.mutate()} leftIcon={<Save className="w-4 h-4" />}>
            {t('common.saveChanges', 'Save changes')}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {PALETTE.map((type) => (
          <button
            key={type} type="button" onClick={() => addNode(type)}
            className="text-xs px-2 py-1 rounded border border-neutral-300 dark:border-neutral-600 text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-800"
          >
            + {type}
          </button>
        ))}
      </div>

      <div className="flex gap-3" style={{ height: '70vh' }}>
        <div className="flex-1 rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
          <ReactFlow
            nodes={nodes} edges={edges} nodeTypes={nodeTypes}
            onNodesChange={onNodesChange} onEdgesChange={onEdgesChange} onConnect={onConnect}
            onNodeClick={(_, n) => setSelectedId(n.id)} fitView
          >
            <Background />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        {selectedNode && (
          <div className="w-72 rounded-lg border border-neutral-200 dark:border-neutral-700 p-3 space-y-2 bg-white dark:bg-neutral-900">
            <div className="flex items-center justify-between">
              <div className="text-sm font-medium text-neutral-900 dark:text-neutral-100">{(selectedNode.data as any).nodeType} · {selectedNode.id}</div>
              <Button variant="ghost" size="sm" onClick={deleteSelected} aria-label={t('common.delete', 'Delete') as string}>
                <Trash2 className="w-4 h-4 text-red-600 dark:text-red-400" />
              </Button>
            </div>
            <label className="block text-xs text-neutral-500 dark:text-neutral-400">{t('workflows.editor.config', 'Config (JSON)')}</label>
            <textarea
              value={configText} onChange={(e) => setConfigText(e.target.value)} rows={10}
              className="w-full text-xs font-mono p-2 rounded border border-neutral-300 dark:border-neutral-600 bg-neutral-50 dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
            />
            <Button variant="outline" size="sm" onClick={applyConfig}>{t('workflows.editor.applyConfig', 'Apply config')}</Button>
          </div>
        )}
      </div>
    </div>
  );
};
