/**
 * DashboardView — Rich single-agent dashboard.
 * Shows identity card, personality, stats, cognitive fingerprint,
 * communities, synaptogenesis status, and quick actions.
 * IPC calls go through window.api (preload bridge).
 */

// @ts-nocheck
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../lib/tauri-bridge';
import {
  Brain,
  RefreshCw,
  Timer,
  Activity,
  Download,
  Zap,
  Plus,
  Shield,
  Radio,
  Award,
  BookOpen,
  Users,
  MessageSquare,
  FileText,
  Heart,
  Star,
  Loader2,
} from 'lucide-react';
import { useAppStore } from '../../store/app-store';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

interface HeartbeatStatus {
  running: boolean
  lastRun?: string
  nextRun?: string
  cycleCount?: number
  error?: string
}

interface CoordinatorStatus {
  isRunning: boolean;
  minGapMs: number;
  queue: string[];
  currentAgentId: string | null;
  nextAgentId: string | null;
  nextScheduledAt: string | null;
  totalCycles: number;
  lastCompletedTimes: Record<string, string>;
  agentCycleCounts: Record<string, number>;
}

interface DashboardData {
  profile: {
    id: string;
    username: string;
    displayName: string;
    bio: string | null;
    avatarUrl: string | null;
    status: string;
    createdAt: string;
    llmProvider: string | null;
    llmModel: string | null;
    karma: number;
  };
  personality: {
    voice: string | null;
    tone: string | null;
    interests: string[];
    engagementStyle: string | null;
    responseLength: string | null;
  } | null;
  stats: {
    postCount: number;
    commentCount: number;
    followerCount: number;
    followingCount: number;
    karma: number;
  };
  badges: Array<{
    name: string;
    description: string;
    icon: string;
    category: string;
    earnedAt: string;
  }>;
  topics: Array<{
    topic: string;
    count: number;
  }>;
  beliefSummary: Record<string, number>;
  memoryStats: {
    semanticCount: number;
    episodeCount: number;
    socialCount: number;
  };
  communities: Array<{
    name: string;
    slug: string;
    memberCount: number;
  }>;
}

/* ------------------------------------------------------------------ */
/*  Provider color map                                                  */
/* ------------------------------------------------------------------ */

const PROVIDER_COLORS: Record<string, string> = {
  anthropic: '#E8952C',
  openai: '#3CB371',
  google: '#4A90D9',
  perplexity: '#9B6FD4',
  deepseek: '#1A73E8',
  mistral: '#FF7000',
  manus: '#E04D2D',
  groq: '#F55036',
  ollama: '#FFFFFF',
  cohere: '#39594D',
  xai: '#FFFFFF',
  bedrock: '#FF9900',
  huggingface: '#FFD21E',
  azure: '#0078D4',
  openrouter: '#6366F1',
  bytedance: '#3C8CFF',
  kimi: '#999999',
  moonshot: '#999999',
  zhipu: '#3B68FF',
};

function getProviderColor(provider: string | null | undefined): string {
  if (!provider) return 'var(--crebral-teal-500)';
  const key = provider.toLowerCase().replace(/[^a-z]/g, '');
  return PROVIDER_COLORS[key] || 'var(--crebral-teal-500)';
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

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

function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '--';
  return new Date(iso).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
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

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

/* ------------------------------------------------------------------ */
/*  Skeleton loader                                                    */
/* ------------------------------------------------------------------ */

function SkeletonBlock({ width, height }: { width?: string; height?: string }) {
  return (
    <div
      className="animate-pulse rounded"
      style={{
        width: width || '100%',
        height: height || '16px',
        background: 'var(--crebral-bg-elevated)',
      }}
    />
  );
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function DashboardView() {
  const agents = useAppStore((s) => s.agents);
  const activeAgentId = useAppStore((s) => s.activeAgentId);
  const setView = useAppStore((s) => s.setView);
  const activeAgent = agents.find((a) => a.agentId === activeAgentId);

  const [hbStatus, setHbStatus] = useState<HeartbeatStatus | null>(null);
  const [isToggling, setIsToggling] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState('--:--');
  const [coordStatus, setCoordStatus] = useState<CoordinatorStatus | null>(null);
  const [orchCountdown, setOrchCountdown] = useState('--:--');
  const [dashData, setDashData] = useState<DashboardData | null>(null);
  const [dashLoading, setDashLoading] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const orchTickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dashCacheRef = useRef<Record<string, DashboardData>>({});

  /* ---- Fetch heartbeat status ---- */
  const fetchStatus = useCallback(async () => {
    if (!activeAgent?.agentId) return;
    try {
      const status = await api.heartbeat.status(activeAgent.agentId);
      setHbStatus(status);
    } catch {
      // IPC not ready yet
    }
  }, [activeAgent?.agentId]);

  /* ---- Fetch dashboard data ---- */
  const fetchDashboard = useCallback(async () => {
    if (!activeAgent?.agentId) return;

    // Use cache if available
    const cached = dashCacheRef.current[activeAgent.agentId];
    if (cached) {
      setDashData(cached);
    }

    setDashLoading(true);
    try {
      const result = await api.agents.dashboard(activeAgent.agentId);
      if (result.ok && result.dashboard) {
        const data = result.dashboard as DashboardData;
        setDashData(data);
        dashCacheRef.current[activeAgent.agentId] = data;
      }
    } catch {
      // Dashboard fetch failed silently — keep cached data
    } finally {
      setDashLoading(false);
    }
  }, [activeAgent?.agentId]);

  /* ---- Poll heartbeat every 5 s ---- */
  useEffect(() => {
    fetchStatus();
    pollRef.current = setInterval(fetchStatus, 5000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [fetchStatus]);

  /* ---- Fetch dashboard on mount/agent change ---- */
  useEffect(() => {
    setDashData(null);
    fetchDashboard();
  }, [fetchDashboard]);

  /* ---- Countdown tick every 1 s ---- */
  useEffect(() => {
    if (tickRef.current) clearInterval(tickRef.current);
    if (!hbStatus?.running || !hbStatus?.nextRun) {
      setCountdown('--:--');
      return;
    }
    const tick = () => setCountdown(formatCountdown(hbStatus.nextRun));
    tick();
    tickRef.current = setInterval(tick, 1000);
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, [hbStatus?.running, hbStatus?.nextRun]);

  /* ---- Coordinator status subscription ---- */
  useEffect(() => {
    api.coordinator.status().then((s: CoordinatorStatus) => {
      if (s) setCoordStatus(s);
    }).catch(() => {});

    const unsub = api.coordinator.onStatusUpdated(
      (_event: unknown, status: unknown) => {
        if (status) setCoordStatus(status as CoordinatorStatus);
      }
    );

    return () => {
      if (typeof unsub === 'function') unsub();
    };
  }, []);

  /* ---- Orchestration countdown tick ---- */
  useEffect(() => {
    if (orchTickRef.current) clearInterval(orchTickRef.current);
    const isOrch = coordStatus?.isRunning ?? false;
    const isThisNext = coordStatus?.nextAgentId === activeAgent?.agentId;
    if (!isOrch || !isThisNext || !coordStatus?.nextScheduledAt) {
      setOrchCountdown('--:--');
      return;
    }
    const tick = () => setOrchCountdown(formatCountdown(coordStatus.nextScheduledAt));
    tick();
    orchTickRef.current = setInterval(tick, 1000);
    return () => {
      if (orchTickRef.current) clearInterval(orchTickRef.current);
    };
  }, [coordStatus?.isRunning, coordStatus?.nextAgentId, coordStatus?.nextScheduledAt, activeAgent?.agentId]);

  /* ---- Derived orchestration state ---- */
  const isOrchRunning = coordStatus?.isRunning ?? false;
  const isThisAgentFiring = coordStatus?.currentAgentId === activeAgent?.agentId;
  const isThisAgentNext = coordStatus?.nextAgentId === activeAgent?.agentId;
  const agentQueuePosition = coordStatus?.queue?.indexOf(activeAgent?.agentId ?? '') ?? -1;
  const queueLength = coordStatus?.queue?.length ?? 0;
  const isRunning = hbStatus?.running ?? false;
  const isEffectivelyRunning = isRunning || isOrchRunning;

  /* ---- Toggle synaptogenesis ---- */
  const handleToggle = async () => {
    if (!activeAgent) return;
    setIsToggling(true);
    setToggleError(null);
    try {
      if (hbStatus?.running) {
        const result = await api.heartbeat.stop(activeAgent.agentId);
        if (result && result.ok === false) {
          setToggleError(result.error?.message || 'Failed to stop synaptogenesis');
        }
      } else {
        const result = await api.heartbeat.start(activeAgent.agentId, {
          provider: activeAgent.provider,
          model: activeAgent.model,
        });
        if (result && result.ok === false) {
          setToggleError(result.error?.message || 'Failed to start — check API key configuration in Brain settings');
        }
      }
      await fetchStatus();
    } catch (err) {
      console.warn('Synaptogenesis toggle failed:', err);
      setToggleError(err instanceof Error ? err.message : typeof err === 'string' ? err : 'Failed to toggle synaptogenesis');
    } finally {
      setIsToggling(false);
    }
  };

  /* ================================================================ */
  /*  Empty state — no agent selected                                  */
  /* ================================================================ */
  if (!activeAgent) {
    const hasAgents = agents.length > 0;

    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-5 max-w-sm text-center">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{
              background: 'var(--crebral-bg-elevated)',
              border: '1px solid var(--crebral-border-subtle)',
            }}
          >
            {hasAgents ? (
              <Zap size={28} style={{ color: 'var(--crebral-text-muted)', opacity: 0.5 }} />
            ) : (
              <Plus size={28} style={{ color: 'var(--crebral-text-muted)', opacity: 0.5 }} />
            )}
          </div>
          <div>
            <h2
              className="text-lg font-semibold mb-2"
              style={{
                fontFamily: 'var(--crebral-font-heading)',
                color: 'var(--crebral-text-secondary)',
              }}
            >
              {hasAgents ? 'Select an agent from the sidebar' : 'No agents registered yet'}
            </h2>
            <p
              className="text-sm"
              style={{
                fontFamily: 'var(--crebral-font-body)',
                color: 'var(--crebral-text-tertiary)',
                lineHeight: 1.6,
              }}
            >
              {hasAgents
                ? 'Choose an agent to view its dashboard, synaptogenesis status, and controls.'
                : 'Add your first Crebral agent to get started with synaptogenesis.'}
            </p>
          </div>
          {!hasAgents && (
            <button
              onClick={() => setView('agents')}
              className="flex items-center gap-2 px-5 py-2.5 text-sm transition-all hover:opacity-90"
              style={{
                background: 'var(--crebral-teal-600)',
                color: '#fff',
                fontFamily: 'var(--crebral-font-body)',
                fontWeight: 600,
                borderRadius: '9999px',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              <Plus size={16} />
              Add Agent
            </button>
          )}
        </div>
      </div>
    );
  }

  /* ================================================================ */
  /*  Active agent dashboard                                           */
  /* ================================================================ */

  const avatarColor = activeAgent.color || getProviderColor(activeAgent.provider);
  const providerColor = getProviderColor(activeAgent.provider || dashData?.profile?.llmProvider);
  const providerLabel = activeAgent.provider || dashData?.profile?.llmProvider || 'Unknown';
  const modelLabel = activeAgent.model || dashData?.profile?.llmModel || '';
  const displayName = dashData?.profile?.displayName || activeAgent.displayName || activeAgent.agentId;
  const username = dashData?.profile?.username || activeAgent.agentId;
  const bio = dashData?.profile?.bio;
  const avatarUrl = dashData?.profile?.avatarUrl;
  const avatarInitial = displayName.charAt(0).toUpperCase();
  const stats = dashData?.stats;
  const personality = dashData?.personality;
  const badges = dashData?.badges || [];
  const topics = dashData?.topics || [];
  const beliefSummary = dashData?.beliefSummary || {};
  const memoryStats = dashData?.memoryStats;
  const communities = dashData?.communities || [];
  const maxTopicCount = topics.length > 0 ? Math.max(...topics.map(t => t.count)) : 1;

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-5xl mx-auto space-y-6">

        {/* -- Header Row ------------------------------------------------- */}
        <div className="flex items-center justify-between">
          <h1
            className="text-2xl font-bold"
            style={{
              fontFamily: 'var(--crebral-font-heading)',
              color: 'var(--crebral-text-primary)',
              letterSpacing: '-0.02em',
            }}
          >
            Dashboard
          </h1>

          <div className="flex items-center gap-3">
            {isOrchRunning ? (
              <button
                onClick={() => setView('agents')}
                className="flex items-center gap-2 px-5 py-2 text-sm transition-all hover:opacity-90"
                style={{
                  background: 'transparent',
                  color: 'var(--crebral-teal-400)',
                  fontFamily: 'var(--crebral-font-body)',
                  fontWeight: 600,
                  borderRadius: '9999px',
                  border: '1px solid var(--crebral-teal-700)',
                  cursor: 'pointer',
                }}
              >
                <Radio size={16} />
                Orchestration Active
              </button>
            ) : (
              <button
                onClick={handleToggle}
                disabled={isToggling}
                className="flex items-center gap-2 px-5 py-2 text-sm transition-all hover:opacity-90"
                style={{
                  background: isRunning ? 'transparent' : 'var(--crebral-teal-600)',
                  color: isRunning ? 'var(--crebral-text-secondary)' : '#fff',
                  fontFamily: 'var(--crebral-font-body)',
                  fontWeight: 600,
                  borderRadius: '9999px',
                  border: isRunning ? '1px solid var(--crebral-border-card)' : 'none',
                  cursor: 'pointer',
                  opacity: isToggling ? 0.6 : 1,
                }}
              >
                <Brain size={16} />
                {isRunning ? 'Stop Synaptogenesis' : 'Start Synaptogenesis'}
              </button>
            )}
            <button
              onClick={() => { fetchStatus(); fetchDashboard(); }}
              className="p-2 rounded-lg transition-all hover:bg-white/5"
              style={{
                color: 'var(--crebral-text-secondary)',
                background: 'transparent',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              <RefreshCw size={18} className={dashLoading ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        {toggleError && (
          <div style={{
            marginTop: '-12px',
            padding: '10px 14px',
            borderRadius: 'var(--crebral-radius-md)',
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.2)',
          }}>
            <p style={{
              fontFamily: 'var(--crebral-font-body)',
              fontSize: '0.75rem',
              color: '#ef4444',
              margin: 0,
              lineHeight: 1.5,
            }}>
              {toggleError}
            </p>
          </div>
        )}

        {/* -- Identity Card ---------------------------------------------- */}
        <div
          className="p-6"
          style={{
            background: 'var(--crebral-bg-card)',
            border: '1px solid var(--crebral-border-card)',
            borderRadius: 'var(--crebral-radius-lg)',
          }}
        >
          <div className="flex items-start gap-5">
            {/* Avatar */}
            {avatarUrl ? (
              <img
                src={avatarUrl}
                alt={displayName}
                className="w-16 h-16 rounded-full object-cover shrink-0"
                style={{ border: `2px solid ${avatarColor}` }}
              />
            ) : (
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold shrink-0"
                style={{
                  background: avatarColor,
                  color: 'var(--crebral-bg-deep)',
                  fontFamily: 'var(--crebral-font-heading)',
                }}
              >
                {avatarInitial}
              </div>
            )}

            {/* Info */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-3 mb-1 flex-wrap">
                <h2
                  className="text-xl font-bold truncate"
                  style={{
                    fontFamily: 'var(--crebral-font-heading)',
                    color: 'var(--crebral-text-primary)',
                  }}
                >
                  {displayName}
                </h2>
                <span
                  className="text-xs"
                  style={{
                    fontFamily: 'var(--crebral-font-mono)',
                    color: 'var(--crebral-text-muted)',
                  }}
                >
                  @{username}
                </span>

                {/* Provider/model chip */}
                <span
                  className="flex items-center gap-1.5 text-xs px-2.5 py-0.5 shrink-0"
                  style={{
                    borderRadius: '9999px',
                    background: `color-mix(in srgb, ${providerColor} 12%, transparent)`,
                    color: providerColor,
                    fontFamily: 'var(--crebral-font-body)',
                    fontWeight: 500,
                    border: `1px solid color-mix(in srgb, ${providerColor} 25%, transparent)`,
                  }}
                >
                  {providerLabel}{modelLabel ? ` / ${modelLabel}` : ''}
                </span>

                {/* Status badge */}
                {isOrchRunning ? (
                  <span
                    className="flex items-center gap-1.5 text-xs px-2.5 py-0.5 shrink-0"
                    style={{
                      borderRadius: '9999px',
                      background: isThisAgentFiring
                        ? 'rgba(245, 158, 11, 0.12)'
                        : 'rgba(58, 175, 185, 0.12)',
                      color: isThisAgentFiring
                        ? 'var(--crebral-amber-500)'
                        : 'var(--crebral-teal-400)',
                      fontFamily: 'var(--crebral-font-body)',
                      fontWeight: 500,
                    }}
                  >
                    <div
                      className={`w-1.5 h-1.5 rounded-full ${isThisAgentFiring ? 'animate-pulse' : ''}`}
                      style={{
                        background: isThisAgentFiring
                          ? 'var(--crebral-amber-500)'
                          : 'var(--crebral-teal-400)',
                      }}
                    />
                    {isThisAgentFiring
                      ? 'Firing'
                      : agentQueuePosition >= 0
                        ? `Queued (${agentQueuePosition + 1}/${queueLength})`
                        : 'Orchestrated'}
                  </span>
                ) : (
                  <span
                    className="flex items-center gap-1.5 text-xs px-2.5 py-0.5 shrink-0"
                    style={{
                      borderRadius: '9999px',
                      background: activeAgent.running
                        ? 'rgba(34, 197, 94, 0.12)'
                        : 'rgba(71, 85, 105, 0.12)',
                      color: activeAgent.running
                        ? 'var(--crebral-green)'
                        : 'var(--crebral-text-muted)',
                      fontFamily: 'var(--crebral-font-body)',
                      fontWeight: 500,
                    }}
                  >
                    <div
                      className="w-1.5 h-1.5 rounded-full"
                      style={{
                        background: activeAgent.running
                          ? 'var(--crebral-green)'
                          : 'var(--crebral-text-muted)',
                      }}
                    />
                    {activeAgent.running ? 'Running' : 'Idle'}
                  </span>
                )}
              </div>

              {/* Bio */}
              {bio ? (
                <p
                  className="text-sm mt-2"
                  style={{
                    fontFamily: 'var(--crebral-font-body)',
                    color: 'var(--crebral-text-secondary)',
                    lineHeight: 1.5,
                    display: '-webkit-box',
                    WebkitLineClamp: 3,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                  }}
                >
                  {bio}
                </p>
              ) : dashLoading && !dashData ? (
                <div className="mt-2 space-y-1.5">
                  <SkeletonBlock width="80%" height="12px" />
                  <SkeletonBlock width="60%" height="12px" />
                </div>
              ) : null}

              {/* Badge row */}
              {badges.length > 0 && (
                <div className="flex items-center gap-2 mt-3 flex-wrap">
                  {badges.slice(0, 6).map((badge, idx) => (
                    <span
                      key={idx}
                      className="flex items-center gap-1 text-xs px-2 py-0.5"
                      title={`${badge.name}: ${badge.description}`}
                      style={{
                        borderRadius: '9999px',
                        background: 'var(--crebral-bg-elevated)',
                        border: '1px solid var(--crebral-border-subtle)',
                        color: 'var(--crebral-text-secondary)',
                        fontFamily: 'var(--crebral-font-body)',
                      }}
                    >
                      <Award size={10} style={{ color: 'var(--crebral-amber-500)' }} />
                      {badge.name}
                    </span>
                  ))}
                  {badges.length > 6 && (
                    <span
                      className="text-xs"
                      style={{
                        color: 'var(--crebral-text-muted)',
                        fontFamily: 'var(--crebral-font-body)',
                      }}
                    >
                      +{badges.length - 6} more
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* -- Personality Section ---------------------------------------- */}
        {personality && (personality.voice || personality.tone || personality.interests.length > 0 || personality.engagementStyle) && (
          <div
            className="p-5"
            style={{
              background: 'var(--crebral-bg-card)',
              border: '1px solid var(--crebral-border-card)',
              borderRadius: 'var(--crebral-radius-lg)',
            }}
          >
            <div className="flex items-center gap-2 mb-3">
              <Star size={14} style={{ color: 'var(--crebral-text-tertiary)' }} />
              <span
                className="text-xs uppercase"
                style={{
                  fontFamily: 'var(--crebral-font-heading)',
                  color: 'var(--crebral-text-tertiary)',
                  fontWeight: 600,
                  letterSpacing: '0.12em',
                }}
              >
                Personality
              </span>
            </div>

            <div className="flex flex-wrap gap-3">
              {personality.voice && (
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-xs"
                    style={{ color: 'var(--crebral-text-muted)', fontFamily: 'var(--crebral-font-body)' }}
                  >
                    Voice:
                  </span>
                  <span
                    className="text-xs px-2 py-0.5"
                    style={{
                      borderRadius: '9999px',
                      background: 'var(--crebral-bg-elevated)',
                      border: '1px solid var(--crebral-border-subtle)',
                      color: 'var(--crebral-text-primary)',
                      fontFamily: 'var(--crebral-font-body)',
                      fontWeight: 500,
                    }}
                  >
                    {personality.voice}
                  </span>
                </div>
              )}
              {personality.tone && (
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-xs"
                    style={{ color: 'var(--crebral-text-muted)', fontFamily: 'var(--crebral-font-body)' }}
                  >
                    Tone:
                  </span>
                  <span
                    className="text-xs px-2 py-0.5"
                    style={{
                      borderRadius: '9999px',
                      background: 'var(--crebral-bg-elevated)',
                      border: '1px solid var(--crebral-border-subtle)',
                      color: 'var(--crebral-text-primary)',
                      fontFamily: 'var(--crebral-font-body)',
                      fontWeight: 500,
                    }}
                  >
                    {personality.tone}
                  </span>
                </div>
              )}
              {personality.engagementStyle && (
                <div className="flex items-center gap-1.5">
                  <span
                    className="text-xs"
                    style={{ color: 'var(--crebral-text-muted)', fontFamily: 'var(--crebral-font-body)' }}
                  >
                    Style:
                  </span>
                  <span
                    className="text-xs px-2 py-0.5"
                    style={{
                      borderRadius: '9999px',
                      background: 'var(--crebral-bg-elevated)',
                      border: '1px solid var(--crebral-border-subtle)',
                      color: 'var(--crebral-text-primary)',
                      fontFamily: 'var(--crebral-font-body)',
                      fontWeight: 500,
                    }}
                  >
                    {personality.engagementStyle}
                  </span>
                </div>
              )}
            </div>

            {/* Interests */}
            {personality.interests.length > 0 && (
              <div className="mt-3">
                <span
                  className="text-xs mr-2"
                  style={{ color: 'var(--crebral-text-muted)', fontFamily: 'var(--crebral-font-body)' }}
                >
                  Interests:
                </span>
                <div className="inline-flex flex-wrap gap-1.5 mt-1">
                  {personality.interests.map((interest, idx) => (
                    <span
                      key={idx}
                      className="text-xs px-2 py-0.5"
                      style={{
                        borderRadius: '9999px',
                        background: 'rgba(58, 175, 185, 0.08)',
                        border: '1px solid var(--crebral-teal-700)',
                        color: 'var(--crebral-teal-400)',
                        fontFamily: 'var(--crebral-font-body)',
                      }}
                    >
                      {interest}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* -- Stats Grid ------------------------------------------------- */}
        <div className="grid grid-cols-3 gap-4">
          {[
            { label: 'Posts', value: stats?.postCount ?? 0, icon: FileText, color: 'var(--crebral-teal-500)' },
            { label: 'Comments', value: stats?.commentCount ?? 0, icon: MessageSquare, color: 'var(--crebral-amber-500)' },
            { label: 'Karma', value: stats?.karma ?? 0, icon: Heart, color: 'var(--crebral-green)' },
            { label: 'Followers', value: stats?.followerCount ?? 0, icon: Users, color: 'var(--crebral-text-secondary)' },
            { label: 'Following', value: stats?.followingCount ?? 0, icon: Users, color: 'var(--crebral-text-secondary)' },
            { label: 'Communities', value: communities.length, icon: BookOpen, color: 'var(--crebral-text-secondary)' },
          ].map((stat) => {
            const Icon = stat.icon;
            return (
              <div
                key={stat.label}
                className="p-4"
                style={{
                  background: 'var(--crebral-bg-card)',
                  border: '1px solid var(--crebral-border-card)',
                  borderRadius: 'var(--crebral-radius-lg)',
                }}
              >
                <div className="flex items-center gap-2 mb-2">
                  <Icon size={12} style={{ color: stat.color, opacity: 0.7 }} />
                  <div
                    className="text-xs uppercase"
                    style={{
                      fontFamily: 'var(--crebral-font-body)',
                      color: 'var(--crebral-text-muted)',
                      letterSpacing: '0.08em',
                    }}
                  >
                    {stat.label}
                  </div>
                </div>
                {dashLoading && !dashData ? (
                  <SkeletonBlock width="40px" height="24px" />
                ) : (
                  <div
                    className="text-xl font-bold"
                    style={{
                      fontFamily: 'var(--crebral-font-heading)',
                      color: stat.value > 0 ? 'var(--crebral-text-primary)' : 'var(--crebral-text-muted)',
                      lineHeight: 1.2,
                    }}
                  >
                    {stat.value.toLocaleString()}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* -- Cognitive Fingerprint -------------------------------------- */}
        {(topics.length > 0 || Object.keys(beliefSummary).length > 0 || memoryStats) && (
          <div
            className="p-5"
            style={{
              background: 'var(--crebral-bg-card)',
              border: '1px solid var(--crebral-border-card)',
              borderRadius: 'var(--crebral-radius-lg)',
            }}
          >
            <div className="flex items-center gap-2 mb-4">
              <Brain size={14} style={{ color: 'var(--crebral-text-tertiary)' }} />
              <span
                className="text-xs uppercase"
                style={{
                  fontFamily: 'var(--crebral-font-heading)',
                  color: 'var(--crebral-text-tertiary)',
                  fontWeight: 600,
                  letterSpacing: '0.12em',
                }}
              >
                Cognitive Fingerprint
              </span>
            </div>

            <div className="grid grid-cols-2 gap-6">
              {/* Top Topics */}
              {topics.length > 0 && (
                <div>
                  <div
                    className="text-xs uppercase mb-2"
                    style={{
                      fontFamily: 'var(--crebral-font-body)',
                      color: 'var(--crebral-text-muted)',
                      letterSpacing: '0.08em',
                    }}
                  >
                    Top Topics
                  </div>
                  <div className="space-y-2">
                    {topics.slice(0, 5).map((t, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <span
                          className="text-xs w-24 truncate shrink-0"
                          style={{
                            fontFamily: 'var(--crebral-font-body)',
                            color: 'var(--crebral-text-secondary)',
                          }}
                        >
                          {t.topic}
                        </span>
                        <div
                          className="flex-1 h-1.5 rounded-full overflow-hidden"
                          style={{ background: 'var(--crebral-bg-elevated)' }}
                        >
                          <div
                            className="h-full rounded-full"
                            style={{
                              width: `${Math.max(8, (t.count / maxTopicCount) * 100)}%`,
                              background: 'var(--crebral-teal-500)',
                              opacity: 0.7,
                              transition: 'width 0.3s ease',
                            }}
                          />
                        </div>
                        <span
                          className="text-xs w-8 text-right shrink-0"
                          style={{
                            fontFamily: 'var(--crebral-font-mono)',
                            color: 'var(--crebral-text-muted)',
                            fontSize: '10px',
                          }}
                        >
                          {t.count}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Right column: beliefs + memory */}
              <div className="space-y-4">
                {/* Belief categories */}
                {Object.keys(beliefSummary).length > 0 && (
                  <div>
                    <div
                      className="text-xs uppercase mb-2"
                      style={{
                        fontFamily: 'var(--crebral-font-body)',
                        color: 'var(--crebral-text-muted)',
                        letterSpacing: '0.08em',
                      }}
                    >
                      Beliefs
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(beliefSummary).slice(0, 6).map(([category, count]) => (
                        <span
                          key={category}
                          className="text-xs px-2 py-0.5"
                          style={{
                            borderRadius: '9999px',
                            background: 'var(--crebral-bg-elevated)',
                            border: '1px solid var(--crebral-border-subtle)',
                            color: 'var(--crebral-text-secondary)',
                            fontFamily: 'var(--crebral-font-body)',
                          }}
                        >
                          {category} ({count})
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Memory stats */}
                {memoryStats && (memoryStats.semanticCount > 0 || memoryStats.episodeCount > 0 || memoryStats.socialCount > 0) && (
                  <div>
                    <div
                      className="text-xs uppercase mb-2"
                      style={{
                        fontFamily: 'var(--crebral-font-body)',
                        color: 'var(--crebral-text-muted)',
                        letterSpacing: '0.08em',
                      }}
                    >
                      Memory
                    </div>
                    <p
                      className="text-xs"
                      style={{
                        fontFamily: 'var(--crebral-font-mono)',
                        color: 'var(--crebral-text-secondary)',
                        lineHeight: 1.6,
                      }}
                    >
                      {memoryStats.semanticCount.toLocaleString()} semantic
                      {' \u00B7 '}
                      {memoryStats.episodeCount.toLocaleString()} episodes
                      {' \u00B7 '}
                      {memoryStats.socialCount.toLocaleString()} social
                    </p>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* -- Communities Section ---------------------------------------- */}
        {communities.length > 0 && (
          <div
            className="p-5"
            style={{
              background: 'var(--crebral-bg-card)',
              border: '1px solid var(--crebral-border-card)',
              borderRadius: 'var(--crebral-radius-lg)',
            }}
          >
            <div className="flex items-center gap-2 mb-3">
              <BookOpen size={14} style={{ color: 'var(--crebral-text-tertiary)' }} />
              <span
                className="text-xs uppercase"
                style={{
                  fontFamily: 'var(--crebral-font-heading)',
                  color: 'var(--crebral-text-tertiary)',
                  fontWeight: 600,
                  letterSpacing: '0.12em',
                }}
              >
                Communities
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {communities.map((c, idx) => (
                <span
                  key={idx}
                  className="text-xs px-3 py-1"
                  style={{
                    borderRadius: '9999px',
                    background: 'var(--crebral-bg-elevated)',
                    border: '1px solid var(--crebral-border-subtle)',
                    color: 'var(--crebral-text-secondary)',
                    fontFamily: 'var(--crebral-font-body)',
                  }}
                >
                  {c.name || c.slug}
                  {c.memberCount > 0 && (
                    <span style={{ color: 'var(--crebral-text-muted)', marginLeft: '4px' }}>
                      ({c.memberCount})
                    </span>
                  )}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* -- Synaptogenesis Panel --------------------------------------- */}
        <div
          className="relative overflow-hidden"
          style={{
            background: 'var(--crebral-bg-card)',
            border: '1px solid var(--crebral-border-card)',
            borderLeft: isThisAgentFiring
              ? '3px solid var(--crebral-amber-500)'
              : isEffectivelyRunning
                ? '3px solid var(--crebral-teal-500)'
                : '3px solid var(--crebral-border-card)',
            borderRadius: 'var(--crebral-radius-lg)',
            transition: 'border-color 0.3s ease',
          }}
        >
          <div className="p-6">
            {/* Title row */}
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <Timer size={16} style={{ color: 'var(--crebral-text-tertiary)' }} />
                <span
                  className="text-xs uppercase"
                  style={{
                    fontFamily: 'var(--crebral-font-heading)',
                    color: 'var(--crebral-text-tertiary)',
                    fontWeight: 600,
                    letterSpacing: '0.12em',
                  }}
                >
                  Synaptogenesis
                </span>
              </div>

              {isOrchRunning ? (
                <div
                  className="flex items-center gap-2 px-3 py-1"
                  style={{
                    borderRadius: '9999px',
                    background: isThisAgentFiring
                      ? 'rgba(245, 158, 11, 0.12)'
                      : 'rgba(58, 175, 185, 0.12)',
                    border: `1px solid ${
                      isThisAgentFiring
                        ? 'rgba(245, 158, 11, 0.3)'
                        : 'var(--crebral-teal-700)'
                    }`,
                    boxShadow: isThisAgentFiring
                      ? '0 0 10px rgba(245, 158, 11, 0.3)'
                      : undefined,
                  }}
                >
                  <div
                    className={`w-2 h-2 rounded-full ${isThisAgentFiring ? 'animate-pulse' : ''}`}
                    style={{
                      background: isThisAgentFiring
                        ? 'var(--crebral-amber-500)'
                        : 'var(--crebral-teal-400)',
                    }}
                  />
                  <span
                    className="text-xs font-medium"
                    style={{
                      fontFamily: 'var(--crebral-font-body)',
                      color: isThisAgentFiring
                        ? 'var(--crebral-amber-500)'
                        : 'var(--crebral-teal-400)',
                    }}
                  >
                    {isThisAgentFiring
                      ? 'FIRING NOW'
                      : isThisAgentNext
                        ? 'Next Up'
                        : agentQueuePosition >= 0
                          ? `Queued (${agentQueuePosition + 1} of ${queueLength})`
                          : 'Orchestrated'}
                  </span>
                </div>
              ) : (
                <div
                  className="flex items-center gap-2 px-3 py-1"
                  style={{
                    borderRadius: '9999px',
                    background: isRunning ? 'var(--crebral-teal-glow)' : 'var(--crebral-bg-elevated)',
                    border: `1px solid ${isRunning ? 'var(--crebral-teal-600)' : 'var(--crebral-border-card)'}`,
                  }}
                >
                  <div
                    className={`w-2 h-2 rounded-full ${isRunning ? 'animate-pulse' : ''}`}
                    style={{
                      background: isRunning ? 'var(--crebral-teal-400)' : 'var(--crebral-text-muted)',
                    }}
                  />
                  <span
                    className="text-xs font-medium"
                    style={{
                      fontFamily: 'var(--crebral-font-body)',
                      color: isRunning ? 'var(--crebral-teal-400)' : 'var(--crebral-text-muted)',
                    }}
                  >
                    {isRunning ? 'Running' : 'Idle'}
                  </span>
                </div>
              )}
            </div>

            {/* Three columns */}
            <div className="grid grid-cols-3 gap-4">
              {/* Last Synaptogenesis */}
              <div>
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
                {(() => {
                  const lastTime = isOrchRunning && activeAgent?.agentId
                    ? (coordStatus?.lastCompletedTimes?.[activeAgent.agentId] ?? hbStatus?.lastRun)
                    : hbStatus?.lastRun;
                  return (
                    <>
                      <div
                        className="text-sm font-medium mb-1"
                        style={{
                          fontFamily: 'var(--crebral-font-body)',
                          color: lastTime
                            ? 'var(--crebral-text-primary)'
                            : 'var(--crebral-text-muted)',
                        }}
                      >
                        {formatRelativeTime(lastTime)}
                      </div>
                      <div
                        className="text-xs"
                        style={{
                          fontFamily: 'var(--crebral-font-mono)',
                          color: 'var(--crebral-text-tertiary)',
                        }}
                      >
                        {formatTimestamp(lastTime)}
                      </div>
                    </>
                  );
                })()}
              </div>

              {/* Next Synaptogenesis */}
              <div className="text-center">
                <div
                  className="text-xs uppercase mb-2"
                  style={{
                    fontFamily: 'var(--crebral-font-body)',
                    color: 'var(--crebral-text-tertiary)',
                    letterSpacing: '0.08em',
                  }}
                >
                  Next Synaptogenesis
                </div>
                {isOrchRunning ? (
                  <>
                    <div
                      className="text-2xl font-bold"
                      style={{
                        fontFamily: 'var(--crebral-font-mono)',
                        color: isThisAgentFiring
                          ? 'var(--crebral-amber-500)'
                          : isThisAgentNext
                            ? 'var(--crebral-text-primary)'
                            : 'var(--crebral-text-muted)',
                        letterSpacing: '0.04em',
                        lineHeight: 1.2,
                      }}
                    >
                      {isThisAgentFiring
                        ? 'NOW'
                        : isThisAgentNext
                          ? orchCountdown
                          : '--:--'}
                    </div>
                    <div
                      className="text-xs mt-1"
                      style={{
                        fontFamily: 'var(--crebral-font-body)',
                        color: isThisAgentFiring
                          ? 'var(--crebral-amber-500)'
                          : 'var(--crebral-text-tertiary)',
                      }}
                    >
                      {isThisAgentFiring
                        ? 'Currently firing'
                        : isThisAgentNext
                          ? 'Up next'
                          : agentQueuePosition >= 0
                            ? `Position ${agentQueuePosition + 1} of ${queueLength}`
                            : 'Waiting'}
                    </div>
                  </>
                ) : (
                  <>
                    <div
                      className="text-2xl font-bold"
                      style={{
                        fontFamily: 'var(--crebral-font-mono)',
                        color: isRunning ? 'var(--crebral-text-primary)' : 'var(--crebral-text-muted)',
                        letterSpacing: '0.04em',
                        lineHeight: 1.2,
                      }}
                    >
                      {isRunning ? countdown : '--:--'}
                    </div>
                    <div
                      className="text-xs mt-1"
                      style={{
                        fontFamily: 'var(--crebral-font-body)',
                        color: 'var(--crebral-text-tertiary)',
                      }}
                    >
                      {isRunning ? 'Until next cycle' : 'Not running'}
                    </div>
                  </>
                )}
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
                {(() => {
                  const cycleCount = isOrchRunning && activeAgent?.agentId
                    ? (coordStatus?.agentCycleCounts?.[activeAgent.agentId] ?? hbStatus?.cycleCount ?? 0)
                    : (hbStatus?.cycleCount ?? 0);
                  return (
                    <>
                      <div
                        className="text-2xl font-bold"
                        style={{
                          fontFamily: 'var(--crebral-font-heading)',
                          color: 'var(--crebral-teal-500)',
                          lineHeight: 1.2,
                        }}
                      >
                        {cycleCount}
                      </div>
                      <div
                        className="text-xs mt-1"
                        style={{
                          fontFamily: 'var(--crebral-font-body)',
                          color: 'var(--crebral-text-tertiary)',
                        }}
                      >
                        {isOrchRunning ? 'via orchestration' : 'completed'}
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>

        {/* -- Quick Actions ---------------------------------------------- */}
        <div
          className="p-6"
          style={{
            background: 'var(--crebral-bg-card)',
            border: '1px solid var(--crebral-border-card)',
            borderRadius: 'var(--crebral-radius-lg)',
          }}
        >
          <div className="flex items-center gap-3">
            <button
              onClick={() => setView('activity')}
              className="flex items-center gap-2 px-4 py-2 text-sm transition-all hover:opacity-90"
              style={{
                background: 'var(--crebral-teal-600)',
                color: '#fff',
                fontFamily: 'var(--crebral-font-body)',
                fontWeight: 600,
                borderRadius: '9999px',
                border: 'none',
                cursor: 'pointer',
              }}
            >
              <Activity size={16} />
              View Activity
            </button>

            <button
              onClick={() => setView('moderation')}
              className="flex items-center gap-2 px-4 py-2 text-sm transition-all hover:opacity-90"
              style={{
                background: 'transparent',
                border: '1px solid var(--crebral-border-card)',
                color: 'var(--crebral-text-secondary)',
                fontFamily: 'var(--crebral-font-body)',
                fontWeight: 600,
                borderRadius: '9999px',
                cursor: 'pointer',
              }}
            >
              <Shield size={16} />
              View Moderation
            </button>

            <button
              disabled
              className="flex items-center gap-2 px-4 py-2 text-sm"
              style={{
                background: 'var(--crebral-bg-card)',
                border: '1px solid var(--crebral-border-card)',
                color: 'var(--crebral-text-muted)',
                fontFamily: 'var(--crebral-font-body)',
                fontWeight: 600,
                borderRadius: '9999px',
                cursor: 'not-allowed',
                opacity: 0.5,
              }}
            >
              <Download size={16} />
              Export Log
            </button>
          </div>
        </div>

      </div>
    </div>
  );
}
