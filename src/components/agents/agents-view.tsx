/**
 * AgentsView — Orchestration Panel for the Crebral desktop client.
 *
 * Shows coordinator status, agent table with per-agent metrics,
 * schedule settings, and queue order. Includes AddAgentWizard overlay.
 */

// @ts-nocheck
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../lib/tauri-bridge';
import {
  Plus,
  Trash2,
  RefreshCw,
  Loader2,
  Zap,
  Bot,
  Brain,
  ChevronUp,
  ChevronDown,
  Pause,
  Play,
  Check,
} from 'lucide-react';
import { AddAgentWizard } from './add-agent-wizard';
import { UpgradeModal } from './upgrade-modal';
import { useAppStore } from '../../store/app-store';

/* ── Agent Color Palette ───────────────────────────────────────────── */

const AGENT_COLORS = [
  '#3AAFB9', '#E8A838', '#E05A6D', '#7C6AE8',
  '#4CAF50', '#FF7043', '#42A5F5', '#AB47BC',
  '#26A69A', '#EC407A', '#8D6E63', '#FFCA28',
];

/* ── Color Swatch Picker ──────────────────────────────────────────── */

function ColorSwatchPicker({
  currentColor,
  onSelect,
  onClose,
}: {
  currentColor: string;
  onSelect: (color: string) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    // Delay listener to avoid the triggering click
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 0);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [onClose]);

  return (
    <div
      ref={popoverRef}
      style={{
        position: 'absolute',
        top: '100%',
        left: 0,
        marginTop: '6px',
        padding: '8px',
        background: 'var(--crebral-bg-elevated)',
        border: '1px solid var(--crebral-border-card)',
        borderRadius: 'var(--crebral-radius-md)',
        boxShadow: '0 12px 32px rgba(0, 0, 0, 0.5)',
        zIndex: 100,
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: '6px',
        width: '132px',
      }}
    >
      {AGENT_COLORS.map((color) => {
        const isSelected = color.toLowerCase() === currentColor.toLowerCase();
        return (
          <button
            key={color}
            onClick={() => onSelect(color)}
            title={color}
            style={{
              width: '24px',
              height: '24px',
              borderRadius: '50%',
              background: color,
              border: isSelected
                ? '2px solid var(--crebral-text-primary)'
                : '2px solid transparent',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: 0,
              transition: 'transform 0.12s ease, border-color 0.12s ease',
              transform: isSelected ? 'scale(1.15)' : 'scale(1)',
              outline: 'none',
            }}
            onMouseEnter={(e) => {
              if (!isSelected) (e.currentTarget as HTMLElement).style.transform = 'scale(1.15)';
            }}
            onMouseLeave={(e) => {
              if (!isSelected) (e.currentTarget as HTMLElement).style.transform = 'scale(1)';
            }}
          >
            {isSelected && (
              <Check size={12} strokeWidth={3} style={{ color: 'var(--crebral-bg-deep)' }} />
            )}
          </button>
        );
      })}
    </div>
  );
}

/* ── Types ─────────────────────────────────────────────────────────── */

interface AgentRow {
  agentId: string;
  displayName: string;
  color?: string;
  provider: string;
  model: string;
  running: boolean;
  lastRunAt?: string | null;
  cycleCount?: number;
}

interface CoordinatorStatus {
  isRunning: boolean;
  minGapMs: number;
  queue: string[];
  pausedAgentIds: string[];
  currentAgentId: string | null;
  nextAgentId: string | null;
  nextScheduledAt: string | null;
  totalCycles: number;
  lastCompletedTimes: Record<string, string>;
  agentCycleCounts: Record<string, number>;
}

/* ── Helpers ───────────────────────────────────────────────────────── */

const PROVIDER_LABELS: Record<string, string> = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  google: 'Google',
  mistral: 'Mistral',
  groq: 'Groq',
  cohere: 'Cohere',
  openrouter: 'OpenRouter',
  moonshotai: 'Moonshot AI',
  deepseek: 'DeepSeek',
  xai: 'xAI',
  perplexity: 'Perplexity',
  minimax: 'MiniMax',
  qwen: 'Qwen',
  ollama: 'Ollama',
};

function providerLabel(id: string): string {
  return PROVIDER_LABELS[id] || id.charAt(0).toUpperCase() + id.slice(1);
}

function formatRelativeTime(iso: string | null | undefined): string {
  if (!iso) return '--';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 0) return 'just now';
  const secs = Math.floor(diff / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatCountdown(iso: string | null | undefined): string {
  if (!iso) return '--:--';
  const diff = new Date(iso).getTime() - Date.now();
  if (diff <= 0) return '00:00';
  const totalSecs = Math.floor(diff / 1000);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${pad(mins)}:${pad(secs)}`;
}

/* ── Status Badge ──────────────────────────────────────────────────── */

type AgentStatus = 'FIRING' | 'NEXT' | 'IDLE' | 'PAUSED';

function StatusBadge({ status }: { status: AgentStatus }) {
  const styles: Record<AgentStatus, { bg: string; color: string; glow?: string }> = {
    FIRING: {
      bg: 'rgba(245, 158, 11, 0.12)',
      color: 'var(--crebral-amber-500)',
      glow: '0 0 8px rgba(245, 158, 11, 0.4)',
    },
    NEXT: {
      bg: 'rgba(58, 175, 185, 0.12)',
      color: 'var(--crebral-teal-500)',
    },
    IDLE: {
      bg: 'rgba(100, 116, 139, 0.10)',
      color: 'var(--crebral-text-muted)',
    },
    PAUSED: {
      bg: 'rgba(161, 140, 100, 0.10)',
      color: 'var(--crebral-text-muted)',
    },
  };
  const s = styles[status];
  return (
    <span
      style={{
        borderRadius: '9999px',
        padding: '2px 10px',
        fontSize: '0.65rem',
        fontWeight: 700,
        background: s.bg,
        color: s.color,
        fontFamily: 'var(--crebral-font-body)',
        textTransform: 'uppercase',
        letterSpacing: '0.08em',
        boxShadow: s.glow,
      }}
    >
      {status}
    </span>
  );
}

/* ═══════════════════════════════════════════════════════════════════════
   Component
   ═══════════════════════════════════════════════════════════════════════ */

export function AgentsView() {
  const [agents, setAgents] = useState<AgentRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [firingId, setFiringId] = useState<string | null>(null);
  const [showWizard, setShowWizard] = useState(false);
  const [coordStatus, setCoordStatus] = useState<CoordinatorStatus | null>(null);
  const [isTogglingOrch, setIsTogglingOrch] = useState(false);
  const [minGapMinutes, setMinGapMinutes] = useState(6);
  const [countdown, setCountdown] = useState('--:--');
  const [pausedAgentIds, setPausedAgentIds] = useState<Set<string>>(new Set());
  const [colorPickerAgentId, setColorPickerAgentId] = useState<string | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [savedOrder, setSavedOrder] = useState<string[]>([]);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [singleAgentHbStatus, setSingleAgentHbStatus] = useState<{ running: boolean; lastRun?: string; cycleCount?: number } | null>(null);
  const [isTogglingSingle, setIsTogglingSingle] = useState(false);

  const tier = useAppStore((s) => s.tier);
  const agentLimit = useAppStore((s) => s.agentLimit);
  const gatewayEnabled = true; // Gateway is always active — all cycles route through gateway.crebral.ai
  const loadAccountInfo = useAppStore((s) => s.loadAccountInfo);
  const loadAgentsStore = useAppStore((s) => s.loadAgents);
  const validateConnection = useAppStore((s) => s.validateConnection);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dragHandleActive = useRef(false);

  /* ── Reset drag handle on global mouseup ─────────────────────── */

  useEffect(() => {
    const resetHandle = () => { dragHandleActive.current = false; };
    window.addEventListener('mouseup', resetHandle);
    return () => window.removeEventListener('mouseup', resetHandle);
  }, []);

  /* ── Load agents from IPC ──────────────────────────────────────── */

  const fetchAgents = useCallback(async () => {
    setIsLoading(true);
    try {
      if (api.agents?.list) {
        const list = await api.agents.list();
        const mapped: AgentRow[] = list.map((a: any) => ({
          agentId: a.agentId ?? a.id,
          displayName: a.displayName || a.name || a.agentId || a.id || 'Agent',
          color: a.color || undefined,
          provider: a.provider || '',
          model: a.model || '',
          running: a.running ?? false,
          lastRunAt: null,
          cycleCount: 0,
        }));
        setAgents(mapped);
      }
    } catch (err) {
      console.warn('Failed to load agents:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  /* ── Fetch coordinator status ──────────────────────────────────── */

  const fetchCoordStatus = useCallback(async () => {
    try {
      const status = await api.coordinator.status();
      if (status) {
        setCoordStatus(status);
        if (status.minGapMs) {
          setMinGapMinutes(Math.round(status.minGapMs / 60000));
        }
        // Restore paused state from coordinator
        if (status.pausedAgentIds) {
          setPausedAgentIds(new Set(status.pausedAgentIds));
        }
      }
    } catch {
      // coordinator not available yet
    }
  }, []);

  /* ── Merge coordinator data into agents & sort by queue order ──── */

  const mergedAgents: AgentRow[] = (() => {
    const enriched = agents.map((ag) => ({
      ...ag,
      lastRunAt: coordStatus?.lastCompletedTimes?.[ag.agentId] ?? ag.lastRunAt,
      cycleCount: coordStatus?.agentCycleCounts?.[ag.agentId] ?? ag.cycleCount ?? 0,
    }));

    // Use coordinator queue when running, otherwise use saved order
    const queue = coordStatus?.isRunning ? coordStatus?.queue : null;
    const order = queue && queue.length > 0 ? queue : (savedOrder.length > 0 ? savedOrder : null);
    if (!order || order.length === 0) return enriched;

    // Sort agents by their position in the order array.
    // Agents not in the order are appended at the end in their original order.
    return [...enriched].sort((a, b) => {
      const posA = order.indexOf(a.agentId);
      const posB = order.indexOf(b.agentId);
      // Both in order → sort by position
      if (posA !== -1 && posB !== -1) return posA - posB;
      // Only one in order → that one comes first
      if (posA !== -1) return -1;
      if (posB !== -1) return 1;
      // Neither in order → preserve original order
      return 0;
    });
  })();

  /* ── Fetch per-agent heartbeat status when coordinator not running */

  const fetchFallbackStatus = useCallback(async (agentList: AgentRow[]) => {
    if (!api.heartbeat?.status) return;
    const updated = await Promise.all(
      agentList.map(async (ag) => {
        try {
          const s = await api.heartbeat.status(ag.agentId);
          return {
            ...ag,
            lastRunAt: (s as any)?.lastRun ?? ag.lastRunAt,
            cycleCount: (s as any)?.cycleCount ?? ag.cycleCount,
          };
        } catch {
          return ag;
        }
      }),
    );
    setAgents(updated);
  }, []);

  /* ── Fetch saved agent order ──────────────────────────────────── */

  const fetchSavedOrder = useCallback(async () => {
    try {
      if (api.agents?.getOrder) {
        const result = await api.agents.getOrder();
        if (result.ok && result.agentOrder && result.agentOrder.length > 0) {
          setSavedOrder(result.agentOrder);
        }
      }
    } catch {
      // saved order not available
    }
  }, []);

  /* ── Initial load + polling ────────────────────────────────────── */

  useEffect(() => {
    fetchAgents();
    fetchCoordStatus();
    fetchSavedOrder();
    loadAccountInfo();
  }, [fetchAgents, fetchCoordStatus, fetchSavedOrder, loadAccountInfo]);

  useEffect(() => {
    if (!api.account?.onInfoUpdated) return;
    const unsub = api.account.onInfoUpdated((_event: any, _data: any) => {
      loadAccountInfo();
    });
    return unsub;
  }, [loadAccountInfo]);

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);

    if (coordStatus?.isRunning) {
      pollRef.current = setInterval(fetchCoordStatus, 3000);
    } else if (agents.length > 0) {
      fetchFallbackStatus(agents);
    }

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [coordStatus?.isRunning, agents.length, fetchCoordStatus, fetchFallbackStatus]);

  /* ── Countdown tick ────────────────────────────────────────────── */

  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);

    if (!coordStatus?.isRunning || !coordStatus?.nextScheduledAt) {
      setCountdown('--:--');
      return;
    }

    const tick = () => setCountdown(formatCountdown(coordStatus.nextScheduledAt));
    tick();
    tickRef.current = setInterval(tick, 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [coordStatus?.isRunning, coordStatus?.nextScheduledAt]);

  /* ── Orchestration toggle ──────────────────────────────────────── */

  const handleOrchToggle = async () => {
    setIsTogglingOrch(true);
    try {
      if (coordStatus?.isRunning) {
        await api.coordinator.stop();
      } else {
        await api.coordinator.start();
      }
      await fetchCoordStatus();
      await fetchAgents();
    } catch (err) {
      console.warn('Orchestration toggle failed:', err);
    } finally {
      setIsTogglingOrch(false);
    }
  };

  /* ── Single-agent heartbeat polling ───────────────────────────── */

  const fetchSingleAgentStatus = useCallback(async () => {
    if (agents.length !== 1 || !api.heartbeat?.status) return;
    try {
      const s = await api.heartbeat.status(agents[0].agentId);
      setSingleAgentHbStatus(s as any);
    } catch {
      // Not available yet
    }
  }, [agents]);

  useEffect(() => {
    if (agents.length !== 1) return;
    fetchSingleAgentStatus();
    const interval = setInterval(fetchSingleAgentStatus, 5000);
    return () => clearInterval(interval);
  }, [agents.length, fetchSingleAgentStatus]);

  /* ── Single-agent synaptogenesis toggle ─────────────────────── */

  const handleSingleAgentToggle = async () => {
    if (agents.length !== 1) return;
    const agent = agents[0];
    setIsTogglingSingle(true);
    try {
      if (singleAgentHbStatus?.running) {
        await api.heartbeat.stop(agent.agentId);
      } else {
        await api.heartbeat.start(agent.agentId, {
          provider: agent.provider,
          model: agent.model,
        });
      }
      await fetchSingleAgentStatus();
      await fetchAgents();
    } catch (err) {
      console.warn('Single-agent toggle failed:', err);
    } finally {
      setIsTogglingSingle(false);
    }
  };

  /* ── Min gap change ────────────────────────────────────────────── */

  const handleMinGapChange = async (newMinutes: number) => {
    const clamped = Math.max(1, Math.min(60, newMinutes));
    setMinGapMinutes(clamped);
    try {
      await api.coordinator.setMinGap(clamped * 60000);
    } catch (err) {
      console.warn('setMinGap failed:', err);
    }
  };

  /* ── Drag-and-drop reorder ────────────────────────────────────── */

  const handleDragStart = useCallback(
    (e: React.DragEvent, index: number) => {
      setDraggedIndex(index);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(index));
      // Slight delay so the browser captures the row as drag image first
      requestAnimationFrame(() => {
        setDraggedIndex(index);
      });
    },
    [],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent, index: number) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (draggedIndex === null || index === draggedIndex) {
        setDragOverIndex(null);
        return;
      }
      setDragOverIndex(index);
    },
    [draggedIndex],
  );

  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, dropIndex: number) => {
      e.preventDefault();
      if (draggedIndex === null || draggedIndex === dropIndex) {
        setDraggedIndex(null);
        setDragOverIndex(null);
        return;
      }

      // Build new order from the currently displayed (merged) agent list
      const currentOrder = mergedAgents.map((a) => a.agentId);
      const newOrder = [...currentOrder];
      const [moved] = newOrder.splice(draggedIndex, 1);
      newOrder.splice(dropIndex, 0, moved);

      setDraggedIndex(null);
      setDragOverIndex(null);

      // Always persist the new order to store.json
      setSavedOrder(newOrder);
      try {
        await api.agents.saveOrder(newOrder);
      } catch (err) {
        console.warn('Save order failed:', err);
      }

      // If orchestrator is running, also update the live coordinator queue
      if (coordStatus?.isRunning) {
        try {
          await api.coordinator.reorder(newOrder);
          await fetchCoordStatus();
        } catch (err) {
          console.warn('Coordinator reorder failed:', err);
        }
      }
    },
    [draggedIndex, mergedAgents, coordStatus, fetchCoordStatus],
  );

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
    setDragOverIndex(null);
    dragHandleActive.current = false;
  }, []);

  /* ── Toggle agent pause ─────────────────────────────────────── */

  const handleTogglePause = useCallback(
    async (agentId: string) => {
      const isPaused = pausedAgentIds.has(agentId);

      try {
        if (isPaused) {
          await api.coordinator.resumeAgent(agentId);
        } else {
          await api.coordinator.pauseAgent(agentId);
        }
      } catch (err) {
        console.warn('Toggle pause failed:', err);
      }

      // Optimistic update for snappy UI
      const newPaused = new Set(pausedAgentIds);
      if (isPaused) {
        newPaused.delete(agentId);
      } else {
        newPaused.add(agentId);
      }
      setPausedAgentIds(newPaused);

      await fetchCoordStatus();
    },
    [pausedAgentIds, fetchCoordStatus],
  );

  /* ── Fire single agent ─────────────────────────────────────────── */

  const handleFire = async (agent: AgentRow) => {
    setFiringId(agent.agentId);
    try {
      await api.heartbeat.start(agent.agentId, {
        provider: agent.provider,
        model: agent.model,
      });
      await fetchAgents();
    } catch (err) {
      console.warn('Fire agent failed:', err);
    } finally {
      setFiringId(null);
    }
  };

  /* ── Delete agent ──────────────────────────────────────────────── */

  const handleDelete = useCallback(
    async (agentId: string) => {
      const confirmed = window.confirm('Remove this agent? This action cannot be undone.');
      if (!confirmed) return;

      setDeletingId(agentId);
      try {
        await api.agents.remove(agentId);
        await loadAgentsStore();
        await validateConnection();
        await fetchAgents();
      } catch (err) {
        console.warn('Failed to delete agent:', err);
      } finally {
        setDeletingId(null);
      }
    },
    [fetchAgents, loadAgentsStore, validateConnection],
  );

  /* ── Wizard close ──────────────────────────────────────────────── */

  const handleWizardClose = useCallback(async () => {
    setShowWizard(false);
    await loadAgentsStore();
    await validateConnection();
    await fetchAgents();
  }, [fetchAgents, loadAgentsStore, validateConnection]);

  /* ── Update agent color ──────────────────────────────────────── */

  const handleColorChange = useCallback(
    async (agentId: string, color: string) => {
      try {
        await api.agents.updateColor(agentId, color);
        // Update local state immediately for snappy feedback
        setAgents((prev) =>
          prev.map((a) => (a.agentId === agentId ? { ...a, color } : a)),
        );
      } catch (err) {
        console.warn('Failed to update agent color:', err);
      }
      setColorPickerAgentId(null);
    },
    [],
  );

  /* ── Derived values ────────────────────────────────────────────── */

  const isOrchRunning = coordStatus?.isRunning ?? false;
  const isSingleAgentMode = (agentLimit !== null && agentLimit <= 1) || agents.length <= 1;
  const activeAgents = agents.filter((a) => a.running).length;
  const totalAgents = agents.length;
  const totalCycles = coordStatus?.totalCycles ?? 0;
  const totalCycleMinutes = totalAgents > 0 ? totalAgents * minGapMinutes : 0;

  const nextAgentId = coordStatus?.nextAgentId;
  const nextAgentName = nextAgentId
    ? (agents.find((a) => a.agentId === nextAgentId)?.displayName ?? nextAgentId)
    : null;

  const queueOrder = coordStatus?.isRunning && coordStatus?.queue?.length
    ? coordStatus.queue
    : (savedOrder.length > 0 ? savedOrder : agents.map((a) => a.agentId));

  function getAgentStatus(ag: AgentRow): AgentStatus {
    if (pausedAgentIds.has(ag.agentId)) return 'PAUSED';
    if (!isOrchRunning) return 'IDLE';
    if (ag.agentId === coordStatus?.currentAgentId) return 'FIRING';
    if (ag.agentId === coordStatus?.nextAgentId) return 'NEXT';
    return 'IDLE';
  }

  /* ════════════════════════════════════════════════════════════════
     Render
     ════════════════════════════════════════════════════════════════ */

  return (
    <>
      <div className="h-full overflow-y-auto p-8">
        <div className="max-w-5xl mx-auto space-y-6">

          {/* ── Header ─────────────────────────────────────────────── */}
          <div className="flex items-center justify-between">
            <div>
              <h1
                className="text-2xl font-bold mb-1"
                style={{
                  fontFamily: 'var(--crebral-font-heading)',
                  color: 'var(--crebral-text-primary)',
                  letterSpacing: '-0.02em',
                }}
              >
                {isSingleAgentMode ? 'Agents' : 'Orchestration'}
              </h1>
              <p
                className="text-sm"
                style={{
                  color: 'var(--crebral-text-tertiary)',
                  fontFamily: 'var(--crebral-font-body)',
                }}
              >
                {totalAgents > 0
                  ? `${totalAgents} agent${totalAgents !== 1 ? 's' : ''} registered`
                  : 'No agents registered yet'}
              </p>
            </div>

            <div className="flex items-center gap-3">
              <button
                onClick={fetchAgents}
                disabled={isLoading}
                className="p-2 rounded-lg transition-all hover:bg-white/5"
                style={{
                  color: 'var(--crebral-text-secondary)',
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                }}
              >
                <RefreshCw size={16} className={isLoading ? 'animate-spin' : ''} />
              </button>

              {isSingleAgentMode ? (
                /* Single-agent: direct start/stop synaptogenesis */
                agents.length > 0 && (
                  <button
                    onClick={handleSingleAgentToggle}
                    disabled={isTogglingSingle}
                    className="flex items-center gap-2 px-5 py-2 text-sm transition-all hover:opacity-90"
                    style={{
                      borderRadius: '9999px',
                      background: singleAgentHbStatus?.running ? 'transparent' : 'var(--crebral-teal-600)',
                      color: singleAgentHbStatus?.running ? 'var(--crebral-text-secondary)' : '#fff',
                      border: singleAgentHbStatus?.running
                        ? '1px solid var(--crebral-border-card)'
                        : 'none',
                      fontFamily: 'var(--crebral-font-body)',
                      fontWeight: 600,
                      cursor: 'pointer',
                      opacity: isTogglingSingle ? 0.6 : 1,
                    }}
                  >
                    {isTogglingSingle ? (
                      <Loader2 size={15} className="animate-spin" />
                    ) : (
                      <Brain size={15} />
                    )}
                    {singleAgentHbStatus?.running ? 'Stop Synaptogenesis' : 'Start Synaptogenesis'}
                  </button>
                )
              ) : (
                /* Multi-agent: orchestration toggle */
                <button
                  onClick={handleOrchToggle}
                  disabled={isTogglingOrch}
                  className="flex items-center gap-2 px-5 py-2 text-sm transition-all hover:opacity-90"
                  style={{
                    borderRadius: '9999px',
                    background: isOrchRunning ? 'transparent' : 'var(--crebral-teal-600)',
                    color: isOrchRunning ? 'var(--crebral-text-secondary)' : '#fff',
                    border: isOrchRunning
                      ? '1px solid var(--crebral-border-card)'
                      : 'none',
                    fontFamily: 'var(--crebral-font-body)',
                    fontWeight: 600,
                    cursor: 'pointer',
                    opacity: isTogglingOrch ? 0.6 : 1,
                  }}
                >
                  {isTogglingOrch ? (
                    <Loader2 size={15} className="animate-spin" />
                  ) : null}
                  {isOrchRunning ? 'Stop Orchestration' : 'Start Orchestration'}
                </button>
              )}
            </div>
          </div>

          {/* ── Single-Agent Status Card ────────────────────────────── */}
          {isSingleAgentMode && agents.length > 0 && (
            <div
              className="p-6"
              style={{
                background: 'var(--crebral-bg-card)',
                border: '1px solid var(--crebral-border-card)',
                borderLeft: singleAgentHbStatus?.running
                  ? '3px solid var(--crebral-teal-500)'
                  : '3px solid var(--crebral-border-card)',
                borderRadius: 'var(--crebral-radius-lg)',
                transition: 'border-color 0.3s ease',
              }}
            >
              <div className="grid grid-cols-3 gap-4">
                {/* Status */}
                <div>
                  <div
                    className="text-xs uppercase mb-2"
                    style={{
                      fontFamily: 'var(--crebral-font-body)',
                      color: 'var(--crebral-text-tertiary)',
                      letterSpacing: '0.08em',
                    }}
                  >
                    Status
                  </div>
                  <div className="flex items-center gap-2">
                    <div
                      className={`w-2 h-2 rounded-full ${singleAgentHbStatus?.running ? 'animate-pulse' : ''}`}
                      style={{
                        background: singleAgentHbStatus?.running
                          ? 'var(--crebral-teal-400)'
                          : 'var(--crebral-text-muted)',
                      }}
                    />
                    <span
                      className="text-sm font-medium"
                      style={{
                        fontFamily: 'var(--crebral-font-body)',
                        color: singleAgentHbStatus?.running
                          ? 'var(--crebral-teal-400)'
                          : 'var(--crebral-text-muted)',
                      }}
                    >
                      {singleAgentHbStatus?.running ? 'Running' : 'Idle'}
                    </span>
                  </div>
                </div>

                {/* Last Run */}
                <div className="text-center">
                  <div
                    className="text-xs uppercase mb-2"
                    style={{
                      fontFamily: 'var(--crebral-font-body)',
                      color: 'var(--crebral-text-tertiary)',
                      letterSpacing: '0.08em',
                    }}
                  >
                    Last Synaptogenesis
                  </div>
                  <div
                    className="text-sm font-medium"
                    style={{
                      fontFamily: 'var(--crebral-font-body)',
                      color: singleAgentHbStatus?.lastRun
                        ? 'var(--crebral-text-primary)'
                        : 'var(--crebral-text-muted)',
                    }}
                  >
                    {formatRelativeTime(singleAgentHbStatus?.lastRun)}
                  </div>
                </div>

                {/* Cycles */}
                <div className="text-right">
                  <div
                    className="text-xs uppercase mb-2"
                    style={{
                      fontFamily: 'var(--crebral-font-body)',
                      color: 'var(--crebral-text-tertiary)',
                      letterSpacing: '0.08em',
                    }}
                  >
                    Cycles
                  </div>
                  <div
                    className="text-2xl font-bold"
                    style={{
                      fontFamily: 'var(--crebral-font-heading)',
                      color: 'var(--crebral-teal-500)',
                      lineHeight: 1.2,
                    }}
                  >
                    {singleAgentHbStatus?.cycleCount ?? 0}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ── Summary Metric Cards (multi-agent only) ──────────────── */}
          {!isSingleAgentMode && <div className="grid grid-cols-4 gap-4">
            {/* Total Cycles */}
            <div
              className="p-4"
              style={{
                background: 'var(--crebral-bg-card)',
                border: '1px solid var(--crebral-border-card)',
                borderLeft: '3px solid var(--crebral-teal-700)',
                borderRadius: 'var(--crebral-radius-lg)',
              }}
            >
              <div
                className="text-xs uppercase mb-2"
                style={{
                  fontFamily: 'var(--crebral-font-body)',
                  color: 'var(--crebral-text-muted)',
                  letterSpacing: '0.08em',
                }}
              >
                Total Cycles
              </div>
              <div
                className="text-2xl font-bold"
                style={{
                  fontFamily: 'var(--crebral-font-heading)',
                  color: 'var(--crebral-teal-500)',
                  lineHeight: 1.2,
                }}
              >
                {totalCycles}
              </div>
            </div>

            {/* Effective Interval */}
            <div
              className="p-4"
              style={{
                background: 'var(--crebral-bg-card)',
                border: '1px solid var(--crebral-border-card)',
                borderLeft: '3px solid var(--crebral-teal-700)',
                borderRadius: 'var(--crebral-radius-lg)',
              }}
            >
              <div
                className="text-xs uppercase mb-2"
                style={{
                  fontFamily: 'var(--crebral-font-body)',
                  color: 'var(--crebral-text-muted)',
                  letterSpacing: '0.08em',
                }}
              >
                Effective Interval
              </div>
              <div
                className="text-sm font-bold"
                style={{
                  fontFamily: 'var(--crebral-font-heading)',
                  color:
                    totalCycleMinutes > 0
                      ? 'var(--crebral-text-primary)'
                      : 'var(--crebral-text-muted)',
                  lineHeight: 1.3,
                }}
              >
                {totalCycleMinutes > 0
                  ? `${totalAgents}×${minGapMinutes}m = ${totalCycleMinutes}m cycle`
                  : '--'}
              </div>
            </div>

            {/* Active / Total */}
            <div
              className="p-4"
              style={{
                background: 'var(--crebral-bg-card)',
                border: '1px solid var(--crebral-border-card)',
                borderLeft: '3px solid var(--crebral-teal-700)',
                borderRadius: 'var(--crebral-radius-lg)',
              }}
            >
              <div
                className="text-xs uppercase mb-2"
                style={{
                  fontFamily: 'var(--crebral-font-body)',
                  color: 'var(--crebral-text-muted)',
                  letterSpacing: '0.08em',
                }}
              >
                Active / Total
              </div>
              <div
                className="text-2xl font-bold"
                style={{
                  fontFamily: 'var(--crebral-font-heading)',
                  color:
                    activeAgents > 0
                      ? 'var(--crebral-green)'
                      : 'var(--crebral-text-muted)',
                  lineHeight: 1.2,
                }}
              >
                {activeAgents}
                <span
                  style={{ color: 'var(--crebral-text-muted)', fontWeight: 400 }}
                >
                  /{totalAgents}
                </span>
              </div>
            </div>

            {/* Next Synapse */}
            <div
              className="p-4"
              style={{
                background: 'var(--crebral-bg-card)',
                border: '1px solid var(--crebral-border-card)',
                borderLeft: isOrchRunning
                  ? '3px solid var(--crebral-teal-500)'
                  : '3px solid var(--crebral-teal-700)',
                borderRadius: 'var(--crebral-radius-lg)',
              }}
            >
              <div
                className="text-xs uppercase mb-2"
                style={{
                  fontFamily: 'var(--crebral-font-body)',
                  color: 'var(--crebral-text-muted)',
                  letterSpacing: '0.08em',
                }}
              >
                Next Synapse
              </div>
              {nextAgentName ? (
                <>
                  <div
                    className="text-xs truncate mb-1"
                    style={{
                      fontFamily: 'var(--crebral-font-body)',
                      color: 'var(--crebral-teal-400)',
                      fontWeight: 600,
                    }}
                  >
                    {nextAgentName}
                  </div>
                  <div
                    className="text-xl font-bold"
                    style={{
                      fontFamily: 'var(--crebral-font-mono)',
                      color: 'var(--crebral-text-primary)',
                      letterSpacing: '0.04em',
                    }}
                  >
                    {countdown}
                  </div>
                </>
              ) : (
                <div
                  className="text-xl font-bold"
                  style={{
                    fontFamily: 'var(--crebral-font-mono)',
                    color: 'var(--crebral-text-muted)',
                    letterSpacing: '0.04em',
                  }}
                >
                  --
                </div>
              )}
            </div>
          </div>}

          {/* ── Agent Table ─────────────────────────────────────────── */}
          <div
            style={{
              background: 'var(--crebral-bg-card)',
              border: '1px solid var(--crebral-border-card)',
              borderRadius: 'var(--crebral-radius-lg)',
              overflow: 'hidden',
            }}
          >
            {/* Table header */}
            <div
              className="grid px-5 py-3"
              style={{
                gridTemplateColumns: isSingleAgentMode
                  ? '1fr 100px 80px'
                  : '20px 36px 1fr 100px 100px 64px 120px',
                gap: '12px',
                borderBottom: '1px solid var(--crebral-border-subtle)',
                background: 'var(--crebral-bg-elevated)',
              }}
            >
              {(isSingleAgentMode
                ? ['AGENT', 'STATUS', 'ACTIONS']
                : ['', '#', 'AGENT', 'STATUS', 'LAST RUN', 'CYCLES', 'ACTIONS']
              ).map((col) => (
                <div
                  key={col || '__handle'}
                  style={{
                    fontFamily: 'var(--crebral-font-body)',
                    fontSize: '0.65rem',
                    fontWeight: 700,
                    color: 'var(--crebral-text-muted)',
                    letterSpacing: '0.1em',
                    textTransform: 'uppercase',
                  }}
                >
                  {col}
                </div>
              ))}
            </div>

            {/* Rows */}
            {mergedAgents.length > 0 ? (
              mergedAgents.map((agent, idx) => {
                const isFiring = firingId === agent.agentId;
                const isDeleting = deletingId === agent.agentId;
                const isPaused = pausedAgentIds.has(agent.agentId);
                const agentStatus = getAgentStatus(agent);
                const avatarBg = (agent.color && agent.color !== '#3AAFB9')
                  ? agent.color
                  : AGENT_COLORS[idx % AGENT_COLORS.length];
                const initial = (agent.displayName || 'A').charAt(0).toUpperCase();

                // Compute queue position (paused agents still show position but dimmed)
                const queuePos = queueOrder.indexOf(agent.agentId);

                const rowIndex = idx;

                return (
                  <div
                    key={agent.agentId}
                    draggable={!isSingleAgentMode}
                    onDragStart={!isSingleAgentMode ? (e) => {
                      if (!dragHandleActive.current) {
                        e.preventDefault();
                        return;
                      }
                      handleDragStart(e, rowIndex);
                    } : undefined}
                    onDragOver={!isSingleAgentMode ? (e) => handleDragOver(e, rowIndex) : undefined}
                    onDragLeave={!isSingleAgentMode ? handleDragLeave : undefined}
                    onDrop={!isSingleAgentMode ? (e) => handleDrop(e, rowIndex) : undefined}
                    onDragEnd={!isSingleAgentMode ? handleDragEnd : undefined}
                    className="grid items-center px-5 py-3 transition-all hover:bg-white/[0.02]"
                    style={{
                      gridTemplateColumns: isSingleAgentMode
                        ? '1fr 100px 80px'
                        : '20px 36px 1fr 100px 100px 64px 120px',
                      gap: '12px',
                      borderBottom: '1px solid var(--crebral-border-subtle)',
                      opacity: isPaused ? 0.5 : (draggedIndex === rowIndex ? 0.3 : 1),
                      borderTop: !isSingleAgentMode && dragOverIndex === rowIndex && draggedIndex !== null
                        ? '2px solid #3AAFB9'
                        : '2px solid transparent',
                    }}
                  >
                    {/* Drag handle (multi-agent only) */}
                    {!isSingleAgentMode && (
                    <div
                      className="cursor-grab active:cursor-grabbing"
                      style={{
                        color: 'var(--crebral-text-muted)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        padding: '0 2px',
                        transition: 'color 0.12s ease',
                      }}
                      onMouseEnter={(e) => {
                        (e.currentTarget as HTMLElement).style.color = 'var(--crebral-text-secondary)';
                      }}
                      onMouseLeave={(e) => {
                        (e.currentTarget as HTMLElement).style.color = 'var(--crebral-text-muted)';
                      }}
                      onMouseDown={() => { dragHandleActive.current = true; }}
                      onMouseUp={() => { dragHandleActive.current = false; }}
                    >
                      <svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor">
                        <circle cx="2" cy="2" r="1.5"/>
                        <circle cx="8" cy="2" r="1.5"/>
                        <circle cx="2" cy="8" r="1.5"/>
                        <circle cx="8" cy="8" r="1.5"/>
                        <circle cx="2" cy="14" r="1.5"/>
                        <circle cx="8" cy="14" r="1.5"/>
                      </svg>
                    </div>
                    )}

                    {/* # (multi-agent only) */}
                    {!isSingleAgentMode && (
                    <div
                      style={{
                        fontFamily: 'var(--crebral-font-mono)',
                        fontSize: '0.75rem',
                        color: 'var(--crebral-text-muted)',
                      }}
                    >
                      {isPaused ? '\u2014' : (queuePos >= 0 ? queuePos + 1 : '\u2014')}
                    </div>
                    )}

                    {/* Agent */}
                    <div className="flex items-center gap-3 min-w-0">
                      {/* Color swatch dot */}
                      <div style={{ position: 'relative', flexShrink: 0 }}>
                        <button
                          onClick={() =>
                            setColorPickerAgentId(
                              colorPickerAgentId === agent.agentId ? null : agent.agentId,
                            )
                          }
                          title="Change agent color"
                          style={{
                            width: '16px',
                            height: '16px',
                            borderRadius: '50%',
                            background: avatarBg,
                            border: '2px solid rgba(255,255,255,0.12)',
                            cursor: 'pointer',
                            padding: 0,
                            transition: 'transform 0.12s ease, box-shadow 0.12s ease',
                            outline: 'none',
                            display: 'block',
                          }}
                          onMouseEnter={(e) => {
                            (e.currentTarget as HTMLElement).style.transform = 'scale(1.25)';
                            (e.currentTarget as HTMLElement).style.boxShadow = `0 0 6px ${avatarBg}`;
                          }}
                          onMouseLeave={(e) => {
                            (e.currentTarget as HTMLElement).style.transform = 'scale(1)';
                            (e.currentTarget as HTMLElement).style.boxShadow = 'none';
                          }}
                        />
                        {colorPickerAgentId === agent.agentId && (
                          <ColorSwatchPicker
                            currentColor={avatarBg}
                            onSelect={(color) => handleColorChange(agent.agentId, color)}
                            onClose={() => setColorPickerAgentId(null)}
                          />
                        )}
                      </div>
                      <div
                        className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold shrink-0"
                        style={{
                          background: avatarBg,
                          color: 'var(--crebral-bg-deep)',
                          fontFamily: 'var(--crebral-font-heading)',
                        }}
                      >
                        {initial}
                      </div>
                      <div className="min-w-0">
                        <div
                          className="text-sm font-semibold truncate"
                          style={{
                            fontFamily: 'var(--crebral-font-heading)',
                            color: 'var(--crebral-text-primary)',
                          }}
                        >
                          {agent.displayName}
                        </div>
                        {(agent.provider || agent.model || gatewayEnabled) && (
                          <div
                            className="flex items-center gap-1.5 text-xs truncate"
                            style={{
                              fontFamily: 'var(--crebral-font-mono)',
                              color: 'var(--crebral-text-tertiary)',
                            }}
                          >
                            <span className="truncate">
                              {agent.provider && providerLabel(agent.provider)}
                              {agent.provider && agent.model && (
                                <span style={{ margin: '0 4px', color: 'var(--crebral-text-muted)' }}>
                                  ·
                                </span>
                              )}
                              {agent.model}
                            </span>
                            {gatewayEnabled && (
                              <span
                                className="shrink-0 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full"
                                style={{
                                  fontSize: '0.6rem',
                                  fontFamily: 'var(--crebral-font-body)',
                                  fontWeight: 600,
                                  background: 'rgba(58, 175, 185, 0.12)',
                                  color: 'var(--crebral-teal-400)',
                                  border: '1px solid rgba(58, 175, 185, 0.2)',
                                  letterSpacing: '0.03em',
                                }}
                                title="Heartbeat cycles routed via Gateway server"
                              >
                                <svg width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                                </svg>
                                GW
                              </span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Status */}
                    <div>
                      {isSingleAgentMode ? (
                        <span
                          className="flex items-center gap-1.5 text-xs"
                          style={{
                            fontFamily: 'var(--crebral-font-body)',
                            fontWeight: 500,
                            color: singleAgentHbStatus?.running
                              ? 'var(--crebral-teal-400)'
                              : 'var(--crebral-text-muted)',
                          }}
                        >
                          <div
                            className={`w-1.5 h-1.5 rounded-full ${singleAgentHbStatus?.running ? 'animate-pulse' : ''}`}
                            style={{
                              background: singleAgentHbStatus?.running
                                ? 'var(--crebral-teal-400)'
                                : 'var(--crebral-text-muted)',
                            }}
                          />
                          {singleAgentHbStatus?.running ? 'Running' : 'Idle'}
                        </span>
                      ) : (
                        <StatusBadge status={agentStatus} />
                      )}
                    </div>

                    {/* Last Run (multi-agent only) */}
                    {!isSingleAgentMode && (
                    <div
                      style={{
                        fontFamily: 'var(--crebral-font-body)',
                        fontSize: '0.75rem',
                        color: agent.lastRunAt
                          ? 'var(--crebral-text-secondary)'
                          : 'var(--crebral-text-muted)',
                      }}
                    >
                      {formatRelativeTime(agent.lastRunAt)}
                    </div>
                    )}

                    {/* Cycles (multi-agent only) */}
                    {!isSingleAgentMode && (
                    <div
                      style={{
                        fontFamily: 'var(--crebral-font-mono)',
                        fontSize: '0.875rem',
                        fontWeight: 600,
                        color:
                          (agent.cycleCount ?? 0) > 0
                            ? 'var(--crebral-teal-500)'
                            : 'var(--crebral-text-muted)',
                      }}
                    >
                      {agent.cycleCount ?? 0}
                    </div>
                    )}

                    {/* Actions */}
                    <div className="flex items-center gap-1">
                      {/* Pause / Resume toggle (multi-agent only) */}
                      {!isSingleAgentMode && (
                      <button
                        onClick={() => handleTogglePause(agent.agentId)}
                        title={isPaused ? 'Resume agent' : 'Pause agent'}
                        className="h-7 w-7 rounded flex items-center justify-center transition-all hover:bg-white/10"
                        style={{
                          color: isPaused
                            ? 'var(--crebral-teal-500)'
                            : 'var(--crebral-text-muted)',
                          background: 'transparent',
                          border: 'none',
                          cursor: 'pointer',
                        }}
                      >
                        {isPaused ? <Play size={14} /> : <Pause size={14} />}
                      </button>
                      )}

                      {/* Fire button (multi-agent only) */}
                      {!isSingleAgentMode && (
                      <button
                        onClick={() => handleFire(agent)}
                        disabled={isFiring || isOrchRunning || isPaused}
                        title={
                          isPaused
                            ? 'Resume agent to fire manually'
                            : isOrchRunning
                              ? 'Stop orchestration to fire manually'
                              : 'Fire this agent now'
                        }
                        className="h-7 w-7 rounded flex items-center justify-center transition-all hover:bg-white/10"
                        style={{
                          color: isFiring
                            ? 'var(--crebral-amber-500)'
                            : 'var(--crebral-text-muted)',
                          background: 'transparent',
                          border: 'none',
                          cursor: isFiring || isOrchRunning || isPaused ? 'default' : 'pointer',
                          opacity: isOrchRunning || isPaused ? 0.3 : 1,
                        }}
                      >
                        {isFiring ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Zap size={14} />
                        )}
                      </button>
                      )}

                      {/* Delete */}
                      <button
                        onClick={() => handleDelete(agent.agentId)}
                        disabled={isDeleting}
                        title="Remove agent"
                        className="h-7 w-7 rounded flex items-center justify-center transition-all hover:bg-white/10"
                        style={{
                          color: 'var(--crebral-text-muted)',
                          background: 'transparent',
                          border: 'none',
                          cursor: isDeleting ? 'default' : 'pointer',
                          opacity: isDeleting ? 0.4 : 1,
                        }}
                      >
                        {isDeleting ? (
                          <Loader2 size={14} className="animate-spin" />
                        ) : (
                          <Trash2 size={14} />
                        )}
                      </button>
                    </div>
                  </div>
                );
              })
            ) : (
              /* Empty state */
              <div
                className="flex flex-col items-center justify-center py-16"
                style={{ color: 'var(--crebral-text-tertiary)' }}
              >
                <Bot size={40} className="mb-3" style={{ opacity: 0.15 }} />
                <p
                  className="text-sm font-semibold mb-1"
                  style={{
                    fontFamily: 'var(--crebral-font-heading)',
                    color: 'var(--crebral-text-secondary)',
                  }}
                >
                  No agents registered yet
                </p>
                <p
                  className="text-xs"
                  style={{
                    fontFamily: 'var(--crebral-font-body)',
                    color: 'var(--crebral-text-tertiary)',
                  }}
                >
                  Add your first agent to begin orchestration.
                </p>
              </div>
            )}

            {/* Table footer: Add Agent */}
            <div
              className="flex items-center justify-between px-5 py-3"
              style={{ background: 'var(--crebral-bg-elevated)' }}
            >
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    if (agentLimit !== null && agents.length >= agentLimit) {
                      setShowUpgrade(true);
                    } else {
                      setShowWizard(true);
                    }
                  }}
                  className="flex items-center gap-2 px-4 py-2 text-sm transition-all hover:opacity-90"
                  style={{
                    borderRadius: 'var(--crebral-radius-full)',
                    background: 'var(--crebral-teal-600)',
                    color: 'var(--crebral-text-primary)',
                    border: 'none',
                    fontFamily: 'var(--crebral-font-body)',
                    fontWeight: 600,
                    cursor: 'pointer',
                  }}
                >
                  <Plus size={14} />
                  Add Agent
                </button>
                {agentLimit !== null && (
                  <span
                    style={{
                      fontFamily: 'var(--crebral-font-mono)',
                      fontSize: '0.7rem',
                      color: agents.length >= agentLimit
                        ? 'var(--crebral-amber-500, #E8A838)'
                        : 'var(--crebral-text-muted)',
                      fontWeight: 600,
                    }}
                  >
                    {agents.length}/{agentLimit}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* ── Schedule Settings (multi-agent only) ──────────────── */}
          {!isSingleAgentMode && <div
            className="p-6"
            style={{
              background: 'var(--crebral-bg-card)',
              border: '1px solid var(--crebral-border-card)',
              borderRadius: 'var(--crebral-radius-lg)',
            }}
          >
            <div
              className="text-xs uppercase mb-5"
              style={{
                fontFamily: 'var(--crebral-font-heading)',
                color: 'var(--crebral-text-tertiary)',
                fontWeight: 700,
                letterSpacing: '0.12em',
              }}
            >
              Schedule Settings
            </div>

            <div className="grid grid-cols-2 gap-6">
              {/* Min Gap */}
              <div>
                <div
                  className="text-xs uppercase mb-3"
                  style={{
                    fontFamily: 'var(--crebral-font-body)',
                    color: 'var(--crebral-text-muted)',
                    letterSpacing: '0.08em',
                  }}
                >
                  Min Gap (Minutes)
                </div>
                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min={1}
                    max={60}
                    value={minGapMinutes}
                    onChange={(e) => handleMinGapChange(parseInt(e.target.value) || 1)}
                    style={{
                      width: '72px',
                      padding: '6px 10px',
                      borderRadius: 'var(--crebral-radius-md)',
                      background: 'var(--crebral-bg-elevated)',
                      border: '1px solid var(--crebral-border-card)',
                      color: 'var(--crebral-text-primary)',
                      fontFamily: 'var(--crebral-font-mono)',
                      fontSize: '0.875rem',
                      outline: 'none',
                    }}
                  />
                  <div className="flex flex-col gap-0.5">
                    <button
                      onClick={() => handleMinGapChange(minGapMinutes + 1)}
                      className="p-0.5 rounded hover:bg-white/5"
                      style={{
                        color: 'var(--crebral-text-muted)',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      <ChevronUp size={12} />
                    </button>
                    <button
                      onClick={() => handleMinGapChange(minGapMinutes - 1)}
                      className="p-0.5 rounded hover:bg-white/5"
                      style={{
                        color: 'var(--crebral-text-muted)',
                        background: 'transparent',
                        border: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      <ChevronDown size={12} />
                    </button>
                  </div>
                </div>

                <div
                  className="mt-3 text-xs"
                  style={{
                    fontFamily: 'var(--crebral-font-body)',
                    color: 'var(--crebral-text-tertiary)',
                  }}
                >
                  Per-Agent Interval:{' '}
                  <span style={{ color: 'var(--crebral-text-secondary)', fontWeight: 600 }}>
                    {totalAgents > 0
                      ? `${totalAgents} agents × ${minGapMinutes}m gap = ${totalCycleMinutes}m cycle`
                      : '--'}
                  </span>
                </div>
              </div>

              {/* Queue Order */}
              <div>
                <div
                  className="text-xs uppercase mb-3"
                  style={{
                    fontFamily: 'var(--crebral-font-body)',
                    color: 'var(--crebral-text-muted)',
                    letterSpacing: '0.08em',
                  }}
                >
                  Queue Order
                </div>
                <div className="flex flex-wrap gap-2">
                  {(() => {
                    const activeInQueue = queueOrder.filter((id) => !pausedAgentIds.has(id));
                    const pausedInQueue = agents.filter((a) => pausedAgentIds.has(a.agentId));

                    if (activeInQueue.length === 0 && pausedInQueue.length === 0) {
                      return (
                        <span
                          style={{
                            fontFamily: 'var(--crebral-font-body)',
                            fontSize: '0.75rem',
                            color: 'var(--crebral-text-muted)',
                          }}
                        >
                          No agents in queue
                        </span>
                      );
                    }

                    return (
                      <>
                        {activeInQueue.map((agentId, idx) => {
                          const ag = agents.find((a) => a.agentId === agentId);
                          const name = ag?.displayName ?? agentId;
                          return (
                            <span
                              key={agentId}
                              style={{
                                padding: '4px 10px',
                                borderRadius: '9999px',
                                background: 'var(--crebral-bg-elevated)',
                                border: '1px solid var(--crebral-border-card)',
                                fontFamily: 'var(--crebral-font-body)',
                                fontSize: '0.75rem',
                                color: 'var(--crebral-text-secondary)',
                              }}
                            >
                              <span style={{ color: 'var(--crebral-text-muted)', marginRight: '4px' }}>
                                {idx + 1}.
                              </span>
                              {name}
                            </span>
                          );
                        })}
                        {pausedInQueue.map((ag) => (
                          <span
                            key={ag.agentId}
                            style={{
                              padding: '4px 10px',
                              borderRadius: '9999px',
                              background: 'var(--crebral-bg-elevated)',
                              border: '1px dashed var(--crebral-border-card)',
                              fontFamily: 'var(--crebral-font-body)',
                              fontSize: '0.75rem',
                              color: 'var(--crebral-text-muted)',
                              opacity: 0.5,
                            }}
                          >
                            {ag.displayName}
                            <span style={{ marginLeft: '4px', fontSize: '0.6rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                              paused
                            </span>
                          </span>
                        ))}
                      </>
                    );
                  })()}
                </div>
              </div>
            </div>
          </div>}

        </div>
      </div>

      {/* ── Wizard overlay ──────────────────────────────────────────── */}
      {showWizard && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'rgba(0, 0, 0, 0.60)' }}
        >
          <div className="absolute inset-0" onClick={() => setShowWizard(false)} />
          <div
            className="relative z-10 w-full max-w-xl max-h-[85vh] overflow-y-auto"
            style={{
              background: 'var(--crebral-bg-body)',
              border: '1px solid var(--crebral-border-card)',
              borderRadius: 'var(--crebral-radius-lg)',
              boxShadow: '0 24px 48px rgba(0, 0, 0, 0.4)',
            }}
          >
            <AddAgentWizard onClose={handleWizardClose} />
          </div>
        </div>
      )}

      {/* ── Upgrade modal ─────────────────────────────────────────────── */}
      {showUpgrade && (
        <UpgradeModal
          tier={tier ?? 'free'}
          agentCount={agents.length}
          agentLimit={agentLimit ?? 1}
          onClose={() => setShowUpgrade(false)}
        />
      )}
    </>
  );
}
