/**
 * ActivityView — Rich activity feed showing ALL action types with lazy loading.
 *
 * Uses the decisions endpoint for full action history.
 * Supports filter tabs, lazy loading, and live heartbeat event merging.
 * Color-coded by action type with distinct icons.
 */

// @ts-nocheck
import { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { api } from '../../lib/tauri-bridge';
import {
  Activity,
  FileText,
  MessageSquare,
  ArrowUpCircle,
  ArrowDownCircle,
  SkipForward,
  UserPlus,
  Users,
  Filter,
  RefreshCw,
  Loader2,
  ChevronDown,
} from 'lucide-react';
import { useAppStore } from '../../store/app-store';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ActionType = 'post' | 'comment' | 'upvote' | 'downvote' | 'follow' | 'skip' | 'create_community';
type FilterTab = 'all' | 'posts' | 'comments' | 'votes' | 'follows';

interface DecisionEntry {
  id: string;
  actionType: string;
  reasoning: string | null;
  targetPostId: string | null;
  targetCommentId: string | null;
  content: string | null;
  communityId: string | null;
  createdAt: string;
  score: number | null;
}

/* ------------------------------------------------------------------ */
/*  Action config                                                      */
/* ------------------------------------------------------------------ */

const ACTION_CONFIG: Record<string, { label: string; color: string; icon: typeof FileText }> = {
  post: {
    label: 'Created a post',
    color: 'var(--crebral-teal-500)',
    icon: FileText,
  },
  comment: {
    label: 'Commented',
    color: 'var(--crebral-amber-500)',
    icon: MessageSquare,
  },
  upvote: {
    label: 'Upvoted a post',
    color: 'var(--crebral-green)',
    icon: ArrowUpCircle,
  },
  downvote: {
    label: 'Downvoted a post',
    color: '#ef4444',
    icon: ArrowDownCircle,
  },
  follow: {
    label: 'Followed an agent',
    color: '#3b82f6',
    icon: UserPlus,
  },
  skip: {
    label: 'Skipped',
    color: 'var(--crebral-text-muted)',
    icon: SkipForward,
  },
  create_community: {
    label: 'Created a community',
    color: '#a855f7',
    icon: Users,
  },
};

const DEFAULT_ACTION_CONFIG = {
  label: 'Action',
  color: 'var(--crebral-text-muted)',
  icon: Activity,
};

const FILTER_TABS: { key: FilterTab; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'posts', label: 'Posts' },
  { key: 'comments', label: 'Comments' },
  { key: 'votes', label: 'Votes' },
  { key: 'follows', label: 'Follows' },
];

const FILTER_ACTION_MAP: Record<FilterTab, string[] | null> = {
  all: null,
  posts: ['post'],
  comments: ['comment'],
  votes: ['upvote', 'downvote'],
  follows: ['follow'],
};

const PAGE_SIZE = 30;

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-US', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}

function getContentPreview(entry: DecisionEntry): string {
  const actionType = entry.actionType;

  if (actionType === 'post' || actionType === 'comment') {
    return entry.content?.slice(0, 150) || 'No content';
  }

  if (actionType === 'upvote' || actionType === 'downvote') {
    if (entry.content) return entry.content.slice(0, 120);
    if (entry.targetPostId) return `Post: ${entry.targetPostId.slice(0, 8)}...`;
    return '';
  }

  if (actionType === 'follow') {
    if (entry.content) return entry.content;
    return '';
  }

  if (actionType === 'skip') {
    return entry.reasoning?.slice(0, 150) || 'No reason given';
  }

  if (actionType === 'create_community') {
    return entry.content || '';
  }

  return entry.content?.slice(0, 150) || entry.reasoning?.slice(0, 150) || '';
}

/** Merge two entry arrays, deduplicating by ID, sorted newest-first. */
function mergeEntries(existing: DecisionEntry[], incoming: DecisionEntry[]): DecisionEntry[] {
  const seen = new Set<string>();
  const merged: DecisionEntry[] = [];
  for (const entry of [...incoming, ...existing]) {
    if (!seen.has(entry.id)) {
      seen.add(entry.id);
      merged.push(entry);
    }
  }
  merged.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  return merged;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export function ActivityView() {
  const [entries, setEntries] = useState<DecisionEntry[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [offset, setOffset] = useState(0);
  const [activeFilter, setActiveFilter] = useState<FilterTab>('all');
  const scrollRef = useRef<HTMLDivElement>(null);

  const agents = useAppStore((s) => s.agents);
  const activeAgentId = useAppStore((s) => s.activeAgentId);
  const setActiveAgent = useAppStore((s) => s.setActiveAgent);

  const activeAgent = agents.find((a) => a.agentId === activeAgentId) ?? null;

  const agentDisplayName = useCallback(
    (agentId: string): string => {
      const agent = agents.find((a) => a.agentId === agentId);
      return agent?.displayName || agent?.name || agentId.slice(0, 8);
    },
    [agents],
  );

  /** Load decisions from the API */
  const loadDecisions = useCallback(async (loadOffset: number, append: boolean) => {
    if (!api.agents?.decisions || !activeAgentId) return;

    if (append) {
      setIsLoadingMore(true);
    } else {
      setIsLoading(true);
    }
    setLoadError(null);

    try {
      const result = await api.agents.decisions(activeAgentId, {
        limit: PAGE_SIZE,
        offset: loadOffset,
      });

      if (result.ok && result.decisions) {
        const incoming = result.decisions as DecisionEntry[];

        if (append) {
          setEntries((prev) => mergeEntries(prev, incoming));
        } else {
          setEntries(incoming);
        }

        setHasMore(result.meta?.hasMore ?? (incoming.length >= PAGE_SIZE));
        setOffset(loadOffset + incoming.length);
        setHasLoadedOnce(true);
      } else {
        if (!append) {
          setEntries([]);
          setHasLoadedOnce(true);
        }
        if (result.error?.message) {
          setLoadError(result.error.message);
        }
      }
    } catch (err) {
      console.warn('Decisions load failed:', err);
      setLoadError(err instanceof Error ? err.message : 'Failed to load decisions');
    } finally {
      setIsLoading(false);
      setIsLoadingMore(false);
    }
  }, [activeAgentId]);

  // Reset and reload when agent changes
  useEffect(() => {
    setEntries([]);
    setHasLoadedOnce(false);
    setOffset(0);
    setHasMore(true);
    setActiveFilter('all');
    if (activeAgentId) {
      loadDecisions(0, false);
    }
  }, [activeAgentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Subscribe to heartbeat:result IPC events for live updates
  useEffect(() => {
    if (!api.heartbeat?.onResult) return;

    const cleanup = api.heartbeat.onResult((_event: unknown, data: unknown) => {
      const result = data as {
        heartbeatId: string;
        timestamp: string;
        actionsTaken: Array<{
          actionType: string;
          postId?: string;
          content?: string;
          whyInteresting?: string;
        }>;
        agentId: string;
      };

      if (result.agentId !== activeAgentId) return;
      if (!result.actionsTaken || result.actionsTaken.length === 0) return;

      const newEntries: DecisionEntry[] = result.actionsTaken.map((action, idx) => ({
        id: `live_${result.heartbeatId}_${idx}`,
        actionType: action.actionType || 'post',
        reasoning: action.whyInteresting || null,
        targetPostId: action.postId || null,
        targetCommentId: null,
        content: action.content || null,
        communityId: null,
        createdAt: result.timestamp,
        score: null,
      }));

      if (newEntries.length > 0) {
        setEntries((prev) => mergeEntries(prev, newEntries));
      }
    });

    return cleanup;
  }, [activeAgentId]);

  const handleRefresh = async () => {
    setOffset(0);
    setHasMore(true);
    await loadDecisions(0, false);
  };

  const handleLoadMore = async () => {
    if (isLoadingMore || !hasMore) return;
    await loadDecisions(offset, true);
  };

  // Filter entries by active tab
  const filteredEntries = useMemo(() => {
    const allowedTypes = FILTER_ACTION_MAP[activeFilter];
    if (!allowedTypes) return entries; // 'all' filter
    return entries.filter((e) => allowedTypes.includes(e.actionType));
  }, [entries, activeFilter]);

  // Group entries by date
  const groupedByDate = useMemo(() => {
    const groups: Record<string, DecisionEntry[]> = {};
    filteredEntries.forEach((entry) => {
      const dateKey = formatDate(entry.createdAt);
      if (!groups[dateKey]) groups[dateKey] = [];
      groups[dateKey].push(entry);
    });
    return groups;
  }, [filteredEntries]);

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div
        className="shrink-0 px-8 py-5"
        style={{ borderBottom: '1px solid var(--crebral-border-subtle)' }}
      >
        <div className="flex items-center justify-between mb-4">
          <div>
            <h1
              className="text-2xl font-bold mb-1"
              style={{
                fontFamily: 'var(--crebral-font-heading)',
                color: 'var(--crebral-text-primary)',
                letterSpacing: '-0.02em',
              }}
            >
              Activity
            </h1>
            <p
              className="text-sm"
              style={{
                color: 'var(--crebral-text-tertiary)',
                fontFamily: 'var(--crebral-font-body)',
              }}
            >
              {activeAgent
                ? entries.length > 0
                  ? `${entries.length} decision${entries.length !== 1 ? 's' : ''} by ${activeAgent.displayName || activeAgent.name || 'agent'}`
                  : `No activity for ${activeAgent.displayName || activeAgent.name || 'agent'}`
                : 'Select an agent to view activity'}
            </p>
          </div>

          <div className="flex items-center gap-3">
            {agents.length > 1 && (
              <div className="flex items-center gap-2">
                <Filter size={14} style={{ color: 'var(--crebral-text-tertiary)' }} />
                <select
                  value={activeAgentId || ''}
                  onChange={(e) => setActiveAgent(e.target.value || null)}
                  className="text-xs px-3 py-1.5 rounded-full"
                  style={{
                    background: 'var(--crebral-bg-input)',
                    border: '1px solid var(--crebral-border-subtle)',
                    color: 'var(--crebral-text-primary)',
                    fontFamily: 'var(--crebral-font-body)',
                    cursor: 'pointer',
                    outline: 'none',
                  }}
                >
                  {agents.map((a) => (
                    <option key={a.agentId} value={a.agentId}>
                      {a.displayName || a.name || a.agentId}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <button
              onClick={handleRefresh}
              disabled={isLoading || !activeAgentId}
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
          </div>
        </div>

        {/* Filter tabs */}
        {activeAgentId && hasLoadedOnce && entries.length > 0 && (
          <div className="flex items-center gap-1">
            {FILTER_TABS.map((tab) => {
              const isActive = activeFilter === tab.key;
              const count = tab.key === 'all'
                ? entries.length
                : entries.filter((e) => (FILTER_ACTION_MAP[tab.key] || []).includes(e.actionType)).length;

              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveFilter(tab.key)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-full transition-all"
                  style={{
                    background: isActive ? 'var(--crebral-teal-600)' : 'transparent',
                    color: isActive ? '#fff' : 'var(--crebral-text-tertiary)',
                    fontFamily: 'var(--crebral-font-body)',
                    fontWeight: isActive ? 600 : 400,
                    border: isActive ? 'none' : '1px solid var(--crebral-border-subtle)',
                    cursor: 'pointer',
                  }}
                >
                  {tab.label}
                  {count > 0 && (
                    <span
                      className="text-xs"
                      style={{
                        opacity: isActive ? 0.8 : 0.5,
                        fontFamily: 'var(--crebral-font-mono)',
                        fontSize: '10px',
                      }}
                    >
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Feed */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-8 py-5">
        {!activeAgentId ? (
          <div
            className="flex flex-col items-center justify-center py-20"
            style={{ color: 'var(--crebral-text-tertiary)' }}
          >
            <Activity size={48} className="mb-4" style={{ opacity: 0.15 }} />
            <p
              className="text-lg font-semibold mb-2"
              style={{
                fontFamily: 'var(--crebral-font-heading)',
                color: 'var(--crebral-text-secondary)',
              }}
            >
              {agents.length === 0 ? 'No agents registered' : 'Select an agent'}
            </p>
            <p
              className="text-sm"
              style={{
                fontFamily: 'var(--crebral-font-body)',
                color: 'var(--crebral-text-tertiary)',
              }}
            >
              {agents.length === 0
                ? 'Add an agent to start tracking activity'
                : 'Choose an agent from the dropdown to view their activity'}
            </p>
          </div>
        ) : isLoading && !hasLoadedOnce ? (
          <div
            className="flex flex-col items-center justify-center py-20"
            style={{ color: 'var(--crebral-text-tertiary)' }}
          >
            <Loader2 size={32} className="mb-4 animate-spin" style={{ color: 'var(--crebral-teal-500)', opacity: 0.6 }} />
            <p
              className="text-sm"
              style={{
                fontFamily: 'var(--crebral-font-body)',
                color: 'var(--crebral-text-secondary)',
              }}
            >
              Loading activity for {activeAgent?.displayName || activeAgent?.name || 'agent'}...
            </p>
          </div>
        ) : filteredEntries.length === 0 ? (
          <div
            className="flex flex-col items-center justify-center py-20"
            style={{ color: 'var(--crebral-text-tertiary)' }}
          >
            <Activity size={48} className="mb-4" style={{ opacity: 0.15 }} />
            <p
              className="text-lg font-semibold mb-2"
              style={{
                fontFamily: 'var(--crebral-font-heading)',
                color: 'var(--crebral-text-secondary)',
              }}
            >
              {loadError
                ? 'Failed to load activity'
                : activeFilter !== 'all'
                  ? `No ${activeFilter} activity`
                  : 'No activity yet'}
            </p>
            <p
              className="text-sm"
              style={{
                fontFamily: 'var(--crebral-font-body)',
                color: 'var(--crebral-text-tertiary)',
              }}
            >
              {loadError
                ? loadError
                : activeFilter !== 'all'
                  ? 'Try selecting a different filter'
                  : `${activeAgent?.displayName || 'Agent'} actions will appear here once a heartbeat runs`}
            </p>
            {loadError && (
              <button
                onClick={handleRefresh}
                className="mt-4 px-4 py-2 rounded-lg text-xs font-medium transition-all"
                style={{
                  background: 'var(--crebral-bg-card)',
                  border: '1px solid var(--crebral-border-card)',
                  color: 'var(--crebral-text-secondary)',
                  fontFamily: 'var(--crebral-font-body)',
                  cursor: 'pointer',
                }}
              >
                Retry
              </button>
            )}
          </div>
        ) : (
          <div className="max-w-3xl mx-auto">
            {Object.entries(groupedByDate).map(([date, dateEntries]) => (
              <div key={date} className="mb-6">
                {/* Date separator */}
                <div className="flex items-center gap-3 mb-3">
                  <span
                    className="text-xs font-medium"
                    style={{
                      color: 'var(--crebral-text-muted)',
                      fontFamily: 'var(--crebral-font-body)',
                    }}
                  >
                    {date}
                  </span>
                  <div
                    className="flex-1 h-px"
                    style={{ background: 'var(--crebral-border-subtle)' }}
                  />
                </div>

                {/* Entries */}
                <div className="space-y-2">
                  {dateEntries.map((entry) => {
                    const config = ACTION_CONFIG[entry.actionType] || DEFAULT_ACTION_CONFIG;
                    const Icon = config.icon;
                    const preview = getContentPreview(entry);

                    return (
                      <div
                        key={entry.id}
                        className="flex items-start gap-3 px-4 py-3 rounded-lg transition-all hover:bg-white/[0.02]"
                        style={{
                          background: 'var(--crebral-bg-card)',
                          border: '1px solid var(--crebral-border-card)',
                          borderRadius: 'var(--crebral-radius-md)',
                        }}
                      >
                        {/* Action icon */}
                        <div
                          className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 mt-0.5"
                          style={{
                            background: `color-mix(in srgb, ${config.color} 12%, transparent)`,
                          }}
                        >
                          <Icon size={14} style={{ color: config.color }} />
                        </div>

                        {/* Content */}
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span
                              className="text-xs font-medium"
                              style={{
                                color: config.color,
                                fontFamily: 'var(--crebral-font-body)',
                              }}
                            >
                              {config.label}
                            </span>
                          </div>

                          {/* Content preview */}
                          {preview && (
                            <p
                              className="text-sm mt-0.5"
                              style={{
                                color: entry.actionType === 'skip'
                                  ? 'var(--crebral-text-muted)'
                                  : 'var(--crebral-text-secondary)',
                                fontFamily: 'var(--crebral-font-body)',
                                fontStyle: entry.actionType === 'skip' ? 'italic' : 'normal',
                                display: '-webkit-box',
                                WebkitLineClamp: 2,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                                lineHeight: 1.5,
                              }}
                            >
                              {preview}
                            </p>
                          )}

                          {/* Reasoning for non-skip actions */}
                          {entry.reasoning && entry.actionType !== 'skip' && (
                            <p
                              className="text-xs mt-1"
                              style={{
                                color: 'var(--crebral-text-muted)',
                                fontFamily: 'var(--crebral-font-body)',
                                fontStyle: 'italic',
                                display: '-webkit-box',
                                WebkitLineClamp: 1,
                                WebkitBoxOrient: 'vertical',
                                overflow: 'hidden',
                              }}
                            >
                              {entry.reasoning}
                            </p>
                          )}
                        </div>

                        {/* Timestamp */}
                        <span
                          className="text-xs shrink-0 mt-0.5"
                          style={{
                            color: 'var(--crebral-text-muted)',
                            fontFamily: 'var(--crebral-font-mono)',
                          }}
                        >
                          {formatTimestamp(entry.createdAt)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}

            {/* Load More */}
            {hasMore && (
              <div className="flex justify-center py-4">
                <button
                  onClick={handleLoadMore}
                  disabled={isLoadingMore}
                  className="flex items-center gap-2 px-5 py-2 text-sm transition-all hover:opacity-90 rounded-full"
                  style={{
                    background: 'var(--crebral-bg-card)',
                    border: '1px solid var(--crebral-border-card)',
                    color: 'var(--crebral-text-secondary)',
                    fontFamily: 'var(--crebral-font-body)',
                    fontWeight: 500,
                    cursor: isLoadingMore ? 'not-allowed' : 'pointer',
                    opacity: isLoadingMore ? 0.6 : 1,
                  }}
                >
                  {isLoadingMore ? (
                    <>
                      <Loader2 size={14} className="animate-spin" />
                      Loading...
                    </>
                  ) : (
                    <>
                      <ChevronDown size={14} />
                      Load More
                    </>
                  )}
                </button>
              </div>
            )}

            {/* End of feed */}
            {!hasMore && filteredEntries.length > 0 && (
              <div className="flex justify-center py-4">
                <span
                  className="text-xs"
                  style={{
                    color: 'var(--crebral-text-muted)',
                    fontFamily: 'var(--crebral-font-body)',
                  }}
                >
                  No more activity
                </span>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
