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
  avatarUrl?: string | null;
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
  const [isDragging, setIsDragging] = useState(false);
  const dragYRef = useRef(0);
  const dragRowRef = useRef<HTMLDivElement | null>(null);
  const tableRef = useRef<HTMLDivElement | null>(null);
  // Live-reorder drag state: holds the current visual order of agent IDs during drag
  const [dragLiveOrder, setDragLiveOrder] = useState<string[] | null>(null);
  const dragSourceIndex = useRef<number | null>(null);
  const dragCurrentIndex = useRef<number | null>(null);
  const rowRectsRef = useRef<DOMRect[]>([]);
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
          avatarUrl: a.avatarUrl || null,
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

  /* ── Load min gap from persisted settings on mount ────────────── */

  useEffect(() => {
    (async () => {
      try {
        const settings = await api.settings.get();
        if (settings && typeof (settings as any).minGapMs === 'number' && (settings as any).minGapMs > 0) {
          setMinGapMinutes(Math.round((settings as any).minGapMs / 60000));
        }
      } catch {
        // settings not available yet
      }
    })();
  }, []);

  /* ── Min gap change ────────────────────────────────────────────── */

  const handleMinGapChange = async (newMinutes: number) => {
    const clamped = Math.max(1, Math.min(60, newMinutes));
    setMinGapMinutes(clamped);
    const ms = clamped * 60000;
    try {
      await api.coordinator.setMinGap(ms);
    } catch (err) {
      console.warn('setMinGap failed:', err);
    }
    // Persist to settings store so it survives app restart
    try {
      await api.settings.set({ minGapMs: ms });
    } catch (err) {
      console.warn('persist minGapMs failed:', err);
    }
  };

  /* ── Reorder helpers ─────────────────────────────────────────── */

  const commitReorder = useCallback(
    async (newOrder: string[]) => {
      setSavedOrder(newOrder);
      try {
        await api.agents.saveOrder(newOrder);
      } catch (err) {
        console.warn('Save order failed:', err);
      }
      if (coordStatus?.isRunning) {
        try {
          await api.coordinator.reorder(newOrder);
          await fetchCoordStatus();
        } catch (err) {
          console.warn('Coordinator reorder failed:', err);
        }
      }
    },
    [coordStatus, fetchCoordStatus],
  );

  /* ── Move up / move down ──────────────────────────────────────── */

  const handleMoveUp = useCallback(
    async (index: number) => {
      if (index <= 0) return;
      const currentOrder = mergedAgents.map((a) => a.agentId);
      const newOrder = [...currentOrder];
      [newOrder[index - 1], newOrder[index]] = [newOrder[index], newOrder[index - 1]];
      await commitReorder(newOrder);
    },
    [mergedAgents, commitReorder],
  );

  const handleMoveDown = useCallback(
    async (index: number) => {
      if (index >= mergedAgents.length - 1) return;
      const currentOrder = mergedAgents.map((a) => a.agentId);
      const newOrder = [...currentOrder];
      [newOrder[index], newOrder[index + 1]] = [newOrder[index + 1], newOrder[index]];
      await commitReorder(newOrder);
    },
    [mergedAgents, commitReorder],
  );

  /* ── Mouse-event drag-and-drop reorder ────────────────────────── */

  // Use a ref to reliably track the drop target across mouse events
  const dragOverRef = useRef<number | null>(null);

  const handleMouseDragStart = useCallback(
    (e: React.MouseEvent, index: number) => {
      e.preventDefault();
      e.stopPropagation();
      const row = (e.target as HTMLElement).closest('[data-agent-row]') as HTMLDivElement | null;
      if (!row || !tableRef.current) return;

      // Snapshot initial row rects before any transforms
      const rows = tableRef.current.querySelectorAll('[data-agent-row]');
      const rects: DOMRect[] = [];
      rows.forEach((r) => rects.push((r as HTMLElement).getBoundingClientRect()));
      rowRectsRef.current = rects;

      const rowHeight = rects.length > 1 ? rects[1].top - rects[0].top : rects[0]?.height ?? 48;
      const startY = e.clientY;
      const initialOrder = mergedAgents.map((a) => a.agentId);

      setDraggedIndex(index);
      dragYRef.current = 0;
      setIsDragging(true);
      setDragLiveOrder([...initialOrder]);
      setDragOverIndex(null);
      dragOverRef.current = null;
      dragRowRef.current = row;
      dragSourceIndex.current = index;
      dragCurrentIndex.current = index;

      // Track last known position to avoid redundant state updates
      let lastOverIndex = index;

      const handleMouseMove = (ev: MouseEvent) => {
        const deltaY = ev.clientY - startY;
        dragYRef.current = deltaY;

        // Determine which slot the cursor is over based on the delta
        // and the original row height. This is stable because we use
        // the initial snapshot, not live DOM measurements.
        const rawOffset = Math.round(deltaY / rowHeight);
        let newIndex = index + rawOffset;
        newIndex = Math.max(0, Math.min(mergedAgents.length - 1, newIndex));

        if (newIndex !== lastOverIndex) {
          lastOverIndex = newIndex;
          dragCurrentIndex.current = newIndex;

          // Build live-reordered list: remove dragged item, insert at new position
          const reordered = [...initialOrder];
          const [moved] = reordered.splice(index, 1);
          reordered.splice(newIndex, 0, moved);
          setDragLiveOrder(reordered);
          setDragOverIndex(newIndex);
          dragOverRef.current = newIndex;
        }
      };

      const handleMouseUp = () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);

        // Capture the final order BEFORE clearing state
        const finalIndex = dragCurrentIndex.current;
        const finalOrder = finalIndex !== null && finalIndex !== index
          ? (() => {
              const reordered = [...initialOrder];
              const [moved] = reordered.splice(index, 1);
              reordered.splice(finalIndex, 0, moved);
              return reordered;
            })()
          : null;

        // Clear drag visual state
        setIsDragging(false);
        dragYRef.current = 0;
        setDraggedIndex(null);
        setDragOverIndex(null);
        setDragLiveOrder(null);
        dragOverRef.current = null;
        dragSourceIndex.current = null;
        dragCurrentIndex.current = null;
        rowRectsRef.current = [];

        // Persist the reorder if the position actually changed
        if (finalOrder) {
          commitReorder(finalOrder);
        }
      };

      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
    },
    [mergedAgents, commitReorder],
  );

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

          {/* ── Orchestration Control Panel (multi-agent only) ─────── */}
          {!isSingleAgentMode && (
            <div
              style={{
                background: 'var(--crebral-bg-card)',
                border: '1px solid var(--crebral-border-card)',
                borderLeft: isOrchRunning
                  ? '3px solid var(--crebral-teal-500)'
                  : '3px solid var(--crebral-teal-700)',
                borderRadius: 'var(--crebral-radius-lg)',
                overflow: 'hidden',
              }}
            >
              {/* Top row: Min Gap | Next Synapse | Total Cycles */}
              <div
                className="grid grid-cols-[1fr_1.4fr_0.8fr]"
                style={{ borderBottom: '1px solid var(--crebral-border-card)' }}
              >
                {/* ── Min Gap Control ──────────────────────────── */}
                <div
                  className="p-4"
                  style={{ borderRight: '1px solid var(--crebral-border-card)' }}
                >
                  <div
                    className="text-xs uppercase mb-2"
                    style={{
                      fontFamily: 'var(--crebral-font-body)',
                      color: 'var(--crebral-text-muted)',
                      letterSpacing: '0.08em',
                    }}
                  >
                    Min Gap
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      max={60}
                      value={minGapMinutes}
                      onChange={(e) => handleMinGapChange(parseInt(e.target.value) || 1)}
                      style={{
                        width: '56px',
                        padding: '4px 8px',
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
                    <span
                      className="text-xs"
                      style={{
                        fontFamily: 'var(--crebral-font-body)',
                        color: 'var(--crebral-text-muted)',
                      }}
                    >
                      min
                    </span>
                  </div>
                  <div
                    className="mt-2 text-xs"
                    style={{
                      fontFamily: 'var(--crebral-font-mono)',
                      color: 'var(--crebral-text-tertiary)',
                    }}
                  >
                    {totalCycleMinutes > 0
                      ? `${totalAgents} agents \u00d7 ${minGapMinutes}m = ${totalCycleMinutes}m cycle`
                      : '--'}
                  </div>
                </div>

                {/* ── Next Synapse (center, prominent) ─────────── */}
                <div
                  className="p-4 flex flex-col items-center justify-center"
                  style={{ borderRight: '1px solid var(--crebral-border-card)' }}
                >
                  <div
                    className="text-xs uppercase mb-1"
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
                        className="text-sm truncate mb-0.5"
                        style={{
                          fontFamily: 'var(--crebral-font-body)',
                          color: 'var(--crebral-teal-400)',
                          fontWeight: 600,
                          maxWidth: '100%',
                        }}
                      >
                        {nextAgentName}
                      </div>
                      <div
                        className="text-2xl font-bold"
                        style={{
                          fontFamily: 'var(--crebral-font-mono)',
                          color: 'var(--crebral-text-primary)',
                          letterSpacing: '0.06em',
                          lineHeight: 1.2,
                        }}
                      >
                        {countdown}
                      </div>
                    </>
                  ) : (
                    <div
                      className="text-2xl font-bold"
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

                {/* ── Total Cycles (right) ─────────────────────── */}
                <div className="p-4 flex flex-col items-center justify-center">
                  <div
                    className="text-xs uppercase mb-1"
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
              </div>

              {/* Bottom row: Queue Order (full width) */}
              <div className="px-4 py-3">
                <div className="flex items-center gap-3 flex-wrap">
                  <span
                    className="text-xs uppercase"
                    style={{
                      fontFamily: 'var(--crebral-font-body)',
                      color: 'var(--crebral-text-muted)',
                      letterSpacing: '0.08em',
                      flexShrink: 0,
                    }}
                  >
                    Queue
                  </span>
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
                                padding: '3px 10px',
                                borderRadius: '9999px',
                                background: 'var(--crebral-bg-elevated)',
                                border: '1px solid var(--crebral-border-card)',
                                fontFamily: 'var(--crebral-font-body)',
                                fontSize: '0.7rem',
                                color: 'var(--crebral-text-secondary)',
                              }}
                            >
                              <span style={{ color: 'var(--crebral-teal-500)', marginRight: '3px', fontWeight: 700 }}>
                                {idx + 1}
                              </span>
                              {name}
                            </span>
                          );
                        })}
                        {pausedInQueue.map((ag) => (
                          <span
                            key={ag.agentId}
                            style={{
                              padding: '3px 10px',
                              borderRadius: '9999px',
                              background: 'var(--crebral-bg-elevated)',
                              border: '1px dashed var(--crebral-border-card)',
                              fontFamily: 'var(--crebral-font-body)',
                              fontSize: '0.7rem',
                              color: 'var(--crebral-text-muted)',
                              opacity: 0.5,
                            }}
                          >
                            {ag.displayName}
                            <span style={{ marginLeft: '4px', fontSize: '0.55rem', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
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
          )}

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
                  : '44px 36px 1fr 100px 100px 64px 120px',
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
            <div ref={tableRef}>
            {(() => {
              // During drag, render in the live-reordered order so items
              // visually settle into their new positions without snapping.
              const displayAgents: AgentRow[] = dragLiveOrder
                ? dragLiveOrder
                    .map((id) => mergedAgents.find((a) => a.agentId === id))
                    .filter(Boolean) as AgentRow[]
                : mergedAgents;

              return displayAgents.length > 0 ? (
              displayAgents.map((agent, idx) => {
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
                // Identify the dragged card by its agent ID (stable across reorders)
                const draggedAgentId = draggedIndex !== null ? mergedAgents[draggedIndex]?.agentId : null;
                const isBeingDragged = isDragging && agent.agentId === draggedAgentId;

                return (
                  <div
                    key={agent.agentId}
                    data-agent-row
                    className="grid items-center px-5 py-3 hover:bg-white/[0.02]"
                    style={{
                      gridTemplateColumns: isSingleAgentMode
                        ? '1fr 100px 80px'
                        : '44px 36px 1fr 100px 100px 64px 120px',
                      gap: '12px',
                      borderBottom: '1px solid var(--crebral-border-subtle)',
                      opacity: isPaused ? 0.5 : (isBeingDragged ? 0.9 : 1),
                      position: 'relative',
                      zIndex: isBeingDragged ? 50 : 1,
                      transform: isBeingDragged
                        ? 'scale(1.015)'
                        : 'scale(1)',
                      transition: isBeingDragged
                        ? 'box-shadow 0.15s ease, opacity 0.15s ease, transform 0.1s ease'
                        : 'transform 0.2s cubic-bezier(0.2, 0, 0, 1), box-shadow 0.2s ease, opacity 0.2s ease',
                      boxShadow: isBeingDragged
                        ? '0 8px 24px rgba(0, 0, 0, 0.35), 0 2px 8px rgba(58, 175, 185, 0.15)'
                        : 'none',
                      background: isBeingDragged
                        ? 'var(--crebral-bg-elevated)'
                        : 'transparent',
                      borderRadius: isBeingDragged ? 'var(--crebral-radius-md)' : '0',
                    }}
                  >
                    {/* Drop indicator line */}
                    {/* Drag handle + move buttons (multi-agent only) */}
                    {!isSingleAgentMode && (
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '2px',
                      }}
                    >
                      {/* Drag grip */}
                      <div
                        className="cursor-grab active:cursor-grabbing"
                        style={{
                          color: 'var(--crebral-text-muted)',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          padding: '2px',
                          transition: 'color 0.12s ease',
                          userSelect: 'none',
                        }}
                        onMouseEnter={(e) => {
                          (e.currentTarget as HTMLElement).style.color = 'var(--crebral-text-secondary)';
                        }}
                        onMouseLeave={(e) => {
                          (e.currentTarget as HTMLElement).style.color = 'var(--crebral-text-muted)';
                        }}
                        onMouseDown={(e) => {
                          // Pass the index from the ORIGINAL mergedAgents array, not the display order
                          const origIdx = mergedAgents.findIndex((a) => a.agentId === agent.agentId);
                          if (origIdx !== -1) handleMouseDragStart(e, origIdx);
                        }}
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
                      {/* Move up / down buttons */}
                      <div style={{ display: 'flex', flexDirection: 'column', gap: '0px' }}>
                        <button
                          onClick={() => handleMoveUp(rowIndex)}
                          disabled={rowIndex === 0}
                          title="Move up"
                          style={{
                            background: 'transparent',
                            border: 'none',
                            cursor: rowIndex === 0 ? 'default' : 'pointer',
                            color: 'var(--crebral-text-muted)',
                            padding: '0px',
                            display: 'flex',
                            opacity: rowIndex === 0 ? 0.25 : 1,
                            transition: 'color 0.12s ease, opacity 0.12s ease',
                          }}
                          onMouseEnter={(e) => { if (rowIndex > 0) (e.currentTarget as HTMLElement).style.color = 'var(--crebral-teal-500)'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--crebral-text-muted)'; }}
                        >
                          <ChevronUp size={12} />
                        </button>
                        <button
                          onClick={() => handleMoveDown(rowIndex)}
                          disabled={rowIndex >= mergedAgents.length - 1}
                          title="Move down"
                          style={{
                            background: 'transparent',
                            border: 'none',
                            cursor: rowIndex >= mergedAgents.length - 1 ? 'default' : 'pointer',
                            color: 'var(--crebral-text-muted)',
                            padding: '0px',
                            display: 'flex',
                            opacity: rowIndex >= mergedAgents.length - 1 ? 0.25 : 1,
                            transition: 'color 0.12s ease, opacity 0.12s ease',
                          }}
                          onMouseEnter={(e) => { if (rowIndex < mergedAgents.length - 1) (e.currentTarget as HTMLElement).style.color = 'var(--crebral-teal-500)'; }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--crebral-text-muted)'; }}
                        >
                          <ChevronDown size={12} />
                        </button>
                      </div>
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
                          overflow: 'hidden',
                        }}
                      >
                        {agent.avatarUrl ? (
                          <img
                            src={agent.avatarUrl as string}
                            alt=""
                            draggable={false}
                            style={{
                              width: '100%',
                              height: '100%',
                              borderRadius: '50%',
                              objectFit: 'cover',
                            }}
                          />
                        ) : (
                          initial
                        )}
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
            );
            })()}
            </div>

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
