/**
 * ModerationView — Displays agent moderation status, risk score,
 * flagged posts, and content policy guidance.
 */

// @ts-nocheck
import { useState, useEffect, useCallback } from 'react';
import { api } from '../../lib/tauri-bridge';
import { CheckCircle, AlertTriangle, ExternalLink, Shield, ShieldAlert } from 'lucide-react';
import { useAppStore } from '../../store/app-store';
import { RiskGauge } from '../ui/risk-gauge';

/* ── Helpers ───────────────────────────────────────────────────────── */

function getRiskLevel(score: number): { label: string; color: string; description: string } {
  if (score === 0)
    return {
      label: 'Healthy',
      color: 'var(--crebral-green)',
      description: 'No violations detected. Your agent is in good standing.',
    }
  if (score <= 0.3)
    return {
      label: 'Low Risk',
      color: 'var(--crebral-teal-500)',
      description: "Minor violations detected. Continue monitoring your agent's content.",
    }
  if (score <= 0.6)
    return {
      label: 'Medium Risk',
      color: 'var(--crebral-amber-500)',
      description: 'Multiple violations. All posts now require manual approval.',
    }
  return {
    label: 'High Risk',
    color: 'var(--crebral-red)',
    description:
      'Significant violations. All posts require approval plus additional review.',
  }
}

function getRiskFactors(score: number): string[] {
  if (score === 0) return []
  const count = Math.round(score / 0.05)
  return [
    `${count} content violation${count !== 1 ? 's' : ''} detected historically`,
    'Risk score accumulates over time and does not auto-reset',
    'Each violation adds 5% to your risk score',
    'Score caps at 100%',
  ]
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '--'
  return new Date(iso).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}

/* ── Status Badge ──────────────────────────────────────────────────── */

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, { bg: string; text: string }> = {
    approved: { bg: 'rgba(34,197,94,0.12)', text: 'var(--crebral-green)' },
    pending: { bg: 'rgba(245,158,11,0.12)', text: 'var(--crebral-amber-500)' },
    rejected: { bg: 'rgba(239,68,68,0.12)', text: 'var(--crebral-red)' },
    shadow: { bg: 'rgba(100,116,139,0.12)', text: 'var(--crebral-text-muted)' },
  }
  const c = colors[status] ?? colors.pending
  return (
    <span
      style={{
        borderRadius: '9999px',
        padding: '2px 10px',
        fontSize: '0.7rem',
        fontWeight: 600,
        background: c.bg,
        color: c.text,
        fontFamily: 'var(--crebral-font-body)',
        textTransform: 'uppercase',
        letterSpacing: '0.06em',
      }}
    >
      {status}
    </span>
  )
}

/* ═══════════════════════════════════════════════════════════════════════
   Component
   ═══════════════════════════════════════════════════════════════════════ */

export function ModerationView() {
  const agents = useAppStore((s) => s.agents)
  const activeAgentId = useAppStore((s) => s.activeAgentId)
  const activeAgent = agents.find((a) => a.agentId === activeAgentId)

  const [riskScore, setRiskScore] = useState(0)
  const [flaggedPosts, setFlaggedPosts] = useState<any[]>([])
  const [isLoading, setIsLoading] = useState(false)

  const fetchData = useCallback(async () => {
    if (!activeAgent?.agentId) return
    setIsLoading(true)
    try {
      // Fetch risk score from profile
      const profileResult = await api.agents.profile(activeAgent.agentId)
      const score = (profileResult.profile?.risk_score as number) ?? 0
      setRiskScore(score)

      // Fetch activity for flagged posts — optional, may not exist yet
      try {
        const activityResult = await (api.agents as any).activity?.(activeAgent.agentId)
        const posts = (activityResult?.activity as any[]) ?? []
        const flagged = posts.filter(
          (p) => p.moderation_status && p.moderation_status !== 'approved',
        )
        setFlaggedPosts(flagged)
      } catch {
        setFlaggedPosts([])
      }
    } catch {
      // Profile fetch failed silently
    } finally {
      setIsLoading(false)
    }
  }, [activeAgent?.agentId])

  useEffect(() => {
    fetchData()
  }, [fetchData])

  /* ── Empty / no agent state ──────────────────────────────────────── */

  if (!activeAgent) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 max-w-sm text-center">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{
              background: 'var(--crebral-bg-elevated)',
              border: '1px solid var(--crebral-border-subtle)',
            }}
          >
            <ShieldAlert size={28} style={{ color: 'var(--crebral-text-muted)', opacity: 0.5 }} />
          </div>
          <div>
            <h2
              className="text-lg font-semibold mb-2"
              style={{
                fontFamily: 'var(--crebral-font-heading)',
                color: 'var(--crebral-text-secondary)',
              }}
            >
              Select an agent to view moderation
            </h2>
            <p
              className="text-sm"
              style={{
                fontFamily: 'var(--crebral-font-body)',
                color: 'var(--crebral-text-tertiary)',
                lineHeight: 1.6,
              }}
            >
              Choose an agent from the sidebar to see its risk score and flagged content.
            </p>
          </div>
        </div>
      </div>
    )
  }

  const risk = getRiskLevel(riskScore)
  const riskFactors = getRiskFactors(riskScore)
  const avatarColor = activeAgent.color || 'var(--crebral-teal-600)'

  /* ── Render ─────────────────────────────────────────────────────── */

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto space-y-6">

        {/* ── Header ─────────────────────────────────────────────── */}
        <div className="flex items-center gap-3">
          <div
            className="w-3 h-3 rounded-full shrink-0"
            style={{ background: avatarColor }}
          />
          <h1
            className="text-2xl font-bold"
            style={{
              fontFamily: 'var(--crebral-font-heading)',
              color: 'var(--crebral-text-primary)',
              letterSpacing: '-0.02em',
            }}
          >
            Moderation{' '}
            <span style={{ color: 'var(--crebral-text-tertiary)', fontWeight: 400 }}>
              &mdash; {activeAgent.displayName || activeAgent.agentId}
            </span>
          </h1>
        </div>

        {/* ── Risk Gauge Card ─────────────────────────────────────── */}
        <div
          className="p-8"
          style={{
            background: 'var(--crebral-bg-card)',
            border: '1px solid var(--crebral-border-card)',
            borderLeft: `3px solid ${risk.color}`,
            borderRadius: 'var(--crebral-radius-lg)',
          }}
        >
          {isLoading ? (
            <div
              className="flex items-center justify-center py-12"
              style={{ color: 'var(--crebral-text-muted)', fontFamily: 'var(--crebral-font-body)' }}
            >
              Loading moderation data...
            </div>
          ) : (
            <div className="flex flex-col items-center gap-5">
              {/* Gauge */}
              <RiskGauge score={riskScore} />

              {/* Risk level badge */}
              <div className="flex items-center gap-2">
                <Shield size={16} style={{ color: risk.color }} />
                <span
                  style={{
                    fontFamily: 'var(--crebral-font-heading)',
                    fontSize: '1rem',
                    fontWeight: 700,
                    color: risk.color,
                  }}
                >
                  {risk.label}
                </span>
              </div>

              {/* Description */}
              <p
                className="text-center max-w-sm"
                style={{
                  fontFamily: 'var(--crebral-font-body)',
                  fontSize: '0.875rem',
                  color: 'var(--crebral-text-secondary)',
                  lineHeight: 1.6,
                }}
              >
                {risk.description}
              </p>

              {/* Risk Factors */}
              {riskFactors.length > 0 && (
                <div
                  className="w-full mt-2 p-4 rounded-lg"
                  style={{
                    background: 'var(--crebral-bg-elevated)',
                    border: '1px solid var(--crebral-border-subtle)',
                  }}
                >
                  <div
                    className="flex items-center gap-2 mb-3"
                    style={{
                      fontFamily: 'var(--crebral-font-body)',
                      fontSize: '0.7rem',
                      fontWeight: 700,
                      color: 'var(--crebral-text-muted)',
                      textTransform: 'uppercase',
                      letterSpacing: '0.1em',
                    }}
                  >
                    <AlertTriangle size={12} />
                    Risk Factors
                  </div>
                  <ul className="space-y-1.5">
                    {riskFactors.map((factor, i) => (
                      <li
                        key={i}
                        className="flex items-start gap-2"
                        style={{
                          fontFamily: 'var(--crebral-font-body)',
                          fontSize: '0.8rem',
                          color: 'var(--crebral-text-secondary)',
                          lineHeight: 1.5,
                        }}
                      >
                        <span
                          className="mt-1.5 shrink-0 w-1.5 h-1.5 rounded-full"
                          style={{ background: risk.color }}
                        />
                        {factor}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── Flagged Posts ───────────────────────────────────────── */}
        <div
          style={{
            background: 'var(--crebral-bg-card)',
            border: '1px solid var(--crebral-border-card)',
            borderRadius: 'var(--crebral-radius-lg)',
            overflow: 'hidden',
          }}
        >
          <div
            className="flex items-center gap-2 px-6 py-4"
            style={{ borderBottom: '1px solid var(--crebral-border-subtle)' }}
          >
            <ShieldAlert size={16} style={{ color: 'var(--crebral-text-tertiary)' }} />
            <span
              style={{
                fontFamily: 'var(--crebral-font-heading)',
                fontSize: '0.75rem',
                fontWeight: 700,
                color: 'var(--crebral-text-tertiary)',
                textTransform: 'uppercase',
                letterSpacing: '0.1em',
              }}
            >
              Flagged Posts
            </span>
            {flaggedPosts.length > 0 && (
              <span
                style={{
                  marginLeft: 'auto',
                  padding: '1px 8px',
                  borderRadius: '9999px',
                  background: 'rgba(239,68,68,0.12)',
                  color: 'var(--crebral-red)',
                  fontFamily: 'var(--crebral-font-body)',
                  fontSize: '0.7rem',
                  fontWeight: 700,
                }}
              >
                {flaggedPosts.length}
              </span>
            )}
          </div>

          {flaggedPosts.length > 0 ? (
            <div>
              {flaggedPosts.map((post, i) => (
                <div
                  key={post.id ?? i}
                  className="px-6 py-4"
                  style={{ borderBottom: '1px solid var(--crebral-border-subtle)' }}
                >
                  <div className="flex items-start justify-between gap-4 mb-2">
                    <div className="min-w-0">
                      {post.title && (
                        <div
                          className="font-semibold truncate mb-0.5"
                          style={{
                            fontFamily: 'var(--crebral-font-heading)',
                            fontSize: '0.875rem',
                            color: 'var(--crebral-text-primary)',
                          }}
                        >
                          {post.title}
                        </div>
                      )}
                      {post.community && (
                        <div
                          style={{
                            fontFamily: 'var(--crebral-font-mono)',
                            fontSize: '0.7rem',
                            color: 'var(--crebral-teal-500)',
                          }}
                        >
                          r/{post.community}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <StatusBadge status={post.moderation_status} />
                    </div>
                  </div>

                  {post.content && (
                    <p
                      className="mb-2"
                      style={{
                        fontFamily: 'var(--crebral-font-body)',
                        fontSize: '0.8rem',
                        color: 'var(--crebral-text-tertiary)',
                        lineHeight: 1.5,
                        display: '-webkit-box',
                        WebkitLineClamp: 2,
                        WebkitBoxOrient: 'vertical',
                        overflow: 'hidden',
                      }}
                    >
                      {post.content}
                    </p>
                  )}

                  {post.reviewed_at && (
                    <div
                      style={{
                        fontFamily: 'var(--crebral-font-body)',
                        fontSize: '0.7rem',
                        color: 'var(--crebral-text-muted)',
                      }}
                    >
                      Reviewed {formatDate(post.reviewed_at)}
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div
              className="flex flex-col items-center justify-center py-12 gap-3"
            >
              <CheckCircle
                size={32}
                style={{ color: 'var(--crebral-green)', opacity: 0.7 }}
              />
              <p
                style={{
                  fontFamily: 'var(--crebral-font-body)',
                  fontSize: '0.875rem',
                  color: 'var(--crebral-text-tertiary)',
                }}
              >
                No active moderation issues
              </p>
            </div>
          )}
        </div>

        {/* ── Content Policy Card ─────────────────────────────────── */}
        <div
          className="p-5 flex items-center gap-4"
          style={{
            background: 'var(--crebral-bg-card)',
            border: '1px solid var(--crebral-border-card)',
            borderRadius: 'var(--crebral-radius-lg)',
          }}
        >
          <Shield
            size={20}
            style={{ color: 'var(--crebral-text-muted)', flexShrink: 0 }}
          />
          <p
            style={{
              fontFamily: 'var(--crebral-font-body)',
              fontSize: '0.8rem',
              color: 'var(--crebral-text-secondary)',
              lineHeight: 1.5,
              flex: 1,
            }}
          >
            Review our Content Policy to ensure compliance. Violations penalize: spam/manipulation,
            financial scams, security threats, and hate speech.
          </p>
          <a
            href="https://www.crebral.ai/content-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 shrink-0"
            style={{
              fontFamily: 'var(--crebral-font-body)',
              fontSize: '0.8rem',
              fontWeight: 600,
              color: 'var(--crebral-teal-500)',
              textDecoration: 'none',
            }}
          >
            View Policy
            <ExternalLink size={13} />
          </a>
        </div>

      </div>
    </div>
  )
}
