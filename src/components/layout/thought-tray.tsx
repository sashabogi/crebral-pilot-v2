/**
 * ThoughtTray — right-side sliding panel that streams real-time agent thoughts.
 */

import { useEffect, useRef, useState } from 'react'
import { useHeartbeatStore, type ThoughtEvent } from '../../store/heartbeat-store'
import { useAppStore } from '../../store/app-store'
import { api } from '../../lib/tauri-bridge'
import {
  Brain, X, Trash2, Zap, Activity, Sparkles, AlertTriangle, Info, CheckCircle2, Lightbulb,
} from 'lucide-react'

const AGENT_COLORS = [
  '#3AAFB9', '#E8A838', '#E05A6D', '#7C6AE8', '#4CAF50',
  '#FF7043', '#42A5F5', '#AB47BC', '#26A69A', '#EC407A',
  '#8D6E63', '#FFCA28',
]

function getAgentColor(agentId: string, agents: Array<{ agentId: string }>): string {
  const idx = agents.findIndex((a) => a.agentId === agentId)
  return AGENT_COLORS[idx >= 0 ? idx % AGENT_COLORS.length : 0]
}

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

const EDGE_TAB_WIDTH = 30
const TRAY_PANEL_WIDTH = 320

const THOUGHT_ICONS: Record<string, React.ReactNode> = {
  info: <Zap size={13} style={{ color: 'var(--crebral-teal-400)' }} />,
  scoring: <Activity size={13} style={{ color: 'var(--crebral-amber-400)' }} />,
  decision: <Lightbulb size={13} style={{ color: 'var(--crebral-teal-500)' }} />,
  generating: <Sparkles size={13} style={{ color: 'var(--crebral-amber-500)' }} />,
  action: <CheckCircle2 size={13} style={{ color: 'var(--crebral-green)' }} />,
  error: <AlertTriangle size={13} style={{ color: 'var(--crebral-red)' }} />,
}

const DEFAULT_ICON = <Info size={13} style={{ color: 'var(--crebral-text-muted)' }} />

function formatTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/**
 * Splits an action message into a label and content preview.
 * E.g. "Created a post: The quick brown fox..." → <strong>Created a post:</strong> <em>The quick brown fox...</em>
 */
function formatActionMessage(message: string): React.ReactNode {
  const colonIdx = message.indexOf(':')
  if (colonIdx === -1 || colonIdx > 30) {
    // No content preview, just a label like "Upvoted a post"
    return <strong style={{ fontWeight: 600 }}>{message}</strong>
  }
  const label = message.slice(0, colonIdx + 1)
  const preview = message.slice(colonIdx + 1).trim()
  return (
    <>
      <strong style={{ fontWeight: 600 }}>{label}</strong>{' '}
      <span style={{ opacity: 0.7, fontStyle: 'italic' }}>{preview}</span>
    </>
  )
}

export function ThoughtTray() {
  const thoughts = useHeartbeatStore((s) => s.thoughts)
  const trayOpen = useHeartbeatStore((s) => s.trayOpen)
  const unreadCount = useHeartbeatStore((s) => s.unreadCount)
  const setTrayOpen = useHeartbeatStore((s) => s.setTrayOpen)
  const addThought = useHeartbeatStore((s) => s.addThought)
  const clearThoughts = useHeartbeatStore((s) => s.clearThoughts)
  const statuses = useHeartbeatStore((s) => s.statuses)
  const agents = useAppStore((s) => s.agents)

  const scrollRef = useRef<HTMLDivElement>(null)
  const prevLenRef = useRef(thoughts.length)

  const [coordRunning, setCoordRunning] = useState(false)
  const [firingAgentId, setFiringAgentId] = useState<string | null>(null)
  const coordRunningRef = useRef(false)

  useEffect(() => { coordRunningRef.current = coordRunning }, [coordRunning])
  useEffect(() => { void firingAgentId }, [firingAgentId])

  useEffect(() => {
    api.coordinator.status().then((status) => {
      const s = status as { isRunning?: boolean; currentAgentId?: string | null }
      if (s) {
        setCoordRunning(s.isRunning ?? false)
        setFiringAgentId(s.currentAgentId ?? null)
      }
    })

    const remove = api.coordinator.onStatusUpdated((_event, data) => {
      const s = data as { isRunning: boolean; currentAgentId: string | null }
      setCoordRunning(s.isRunning)
      setFiringAgentId(s.currentAgentId)
    })
    return () => remove()
  }, [])

  const isRunning = statuses.some((s) => s.running) || coordRunning

  useEffect(() => {
    const removeThought = api.heartbeat.onThought((_event, data) => {
      const thought = data as ThoughtEvent
      // Always prepend agent name so the user knows which agent is running
      if (thought.agentId) {
        const agentList = useAppStore.getState().agents
        const agent = agentList.find((a) => a.agentId === thought.agentId)
        const label = (agent?.displayName || agent?.name || thought.agentId.slice(0, 8)) as string
        thought.message = `[${label}] ${thought.message}`
      }
      addThought(thought)
    })
    return () => removeThought()
  }, [addThought])

  useEffect(() => {
    const prev = prevLenRef.current
    const curr = thoughts.length
    if (curr > prev && !trayOpen) {
      setTrayOpen(true)
    }
    prevLenRef.current = curr
  }, [thoughts.length, trayOpen, setTrayOpen])

  const totalWidth = trayOpen ? EDGE_TAB_WIDTH + TRAY_PANEL_WIDTH : EDGE_TAB_WIDTH

  return (
    <div
      style={{
        width: `${totalWidth}px`,
        minWidth: `${totalWidth}px`,
        transition: 'width 0.3s var(--crebral-ease-out), min-width 0.3s var(--crebral-ease-out)',
        display: 'flex',
        flexDirection: 'row',
        height: '100%',
        position: 'relative',
      }}
    >
      {/* Edge tab */}
      <button
        onClick={() => setTrayOpen(!trayOpen)}
        style={{
          width: `${EDGE_TAB_WIDTH}px`,
          minWidth: `${EDGE_TAB_WIDTH}px`,
          height: '100%',
          background: trayOpen ? 'var(--crebral-bg-card)' : 'var(--crebral-bg-sidebar)',
          borderTop: 'none',
          borderBottom: 'none',
          borderLeft: `1px solid ${trayOpen ? 'var(--crebral-border-card)' : 'var(--crebral-border-subtle)'}`,
          borderRight: trayOpen ? '1px solid var(--crebral-border-subtle)' : 'none',
          cursor: 'pointer',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 'var(--crebral-radius-sm)',
          padding: '8px 0',
          transition: 'background 0.25s ease, border-color 0.25s ease',
          position: 'relative',
          flexShrink: 0,
          outline: 'none',
          animation: isRunning ? 'thought-tab-pulse 2.5s ease-in-out infinite' : 'none',
        }}
        title={trayOpen ? 'Close thought stream' : 'Open thought stream'}
      >
        <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <Brain
            size={16}
            style={{
              color: isRunning ? 'var(--crebral-green)' : 'var(--crebral-text-tertiary)',
              transition: 'color 0.3s ease',
              filter: isRunning ? 'drop-shadow(0 0 4px var(--crebral-green-glow))' : 'none',
            }}
          />
          {isRunning && (
            <span
              style={{
                position: 'absolute',
                top: '-2px',
                right: '-4px',
                width: '6px',
                height: '6px',
                borderRadius: 'var(--crebral-radius-full)',
                background: 'var(--crebral-green)',
                boxShadow: '0 0 6px var(--crebral-green-glow)',
                animation: 'thought-dot-pulse 2s ease-in-out infinite',
              }}
            />
          )}
        </div>

        {unreadCount > 0 && !trayOpen && (
          <span
            style={{
              fontSize: '9px',
              fontFamily: 'var(--crebral-font-mono)',
              fontWeight: 700,
              color: '#fff',
              background: 'var(--crebral-red)',
              borderRadius: 'var(--crebral-radius-full)',
              minWidth: '16px',
              height: '16px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '0 3px',
              lineHeight: 1,
            }}
          >
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}

        <span
          style={{
            writingMode: 'vertical-rl',
            textOrientation: 'mixed',
            transform: 'rotate(180deg)',
            fontFamily: 'var(--crebral-font-heading)',
            fontSize: '10px',
            fontWeight: 600,
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            color: trayOpen ? 'var(--crebral-text-secondary)' : 'var(--crebral-text-muted)',
            transition: 'color 0.25s ease',
            userSelect: 'none',
          }}
        >
          Thoughts
        </span>
      </button>

      {/* Sliding panel */}
      <div
        style={{
          width: trayOpen ? `${TRAY_PANEL_WIDTH}px` : '0px',
          overflow: 'hidden',
          background: 'var(--crebral-bg-sidebar)',
          display: 'flex',
          flexDirection: 'column',
          transition: 'width 0.3s var(--crebral-ease-out)',
          flexShrink: 0,
        }}
      >
        <div style={{ width: `${TRAY_PANEL_WIDTH}px`, height: '100%', display: 'flex', flexDirection: 'column' }}>
          <div
            className="flex items-center justify-between px-4 py-3"
            style={{ borderBottom: '1px solid var(--crebral-border-subtle)', flexShrink: 0 }}
          >
            <h2 style={{ fontFamily: 'var(--crebral-font-heading)', fontSize: '13px', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--crebral-text-secondary)', margin: 0 }}>
              Thought Stream
            </h2>
            <div className="flex items-center gap-2">
              {thoughts.length > 0 && (
                <button onClick={clearThoughts} className="p-1 rounded transition-colors hover:bg-white/5" style={{ color: 'var(--crebral-text-tertiary)', border: 'none', background: 'none', cursor: 'pointer' }} title="Clear thoughts">
                  <Trash2 size={14} />
                </button>
              )}
              <button onClick={() => setTrayOpen(false)} className="p-1 rounded transition-colors hover:bg-white/5" style={{ color: 'var(--crebral-text-tertiary)', border: 'none', background: 'none', cursor: 'pointer' }} title="Close thought stream">
                <X size={16} />
              </button>
            </div>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3" style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {thoughts.length === 0 ? (
              <div style={{ textAlign: 'center', paddingTop: '32px', paddingBottom: '32px', color: 'var(--crebral-text-muted)', fontFamily: 'var(--crebral-font-body)' }}>
                <p style={{ fontSize: '13px', marginBottom: '4px' }}>No thoughts yet</p>
                <p style={{ fontSize: '11px', margin: 0 }}>Start Synaptogenesis to see the thought stream</p>
              </div>
            ) : (
              [...thoughts].reverse().map((t, i) => {
                const agentColor = t.agentId ? getAgentColor(t.agentId, agents) : null
                const isAction = t.type === 'action'
                const isDecision = t.type === 'decision'
                const isError = t.type === 'error'

                // Action and decision rows get slightly enhanced backgrounds
                const rowBg = isAction
                  ? 'rgba(74, 222, 128, 0.08)'
                  : isDecision
                    ? 'rgba(58, 175, 185, 0.06)'
                    : agentColor
                      ? hexToRgba(agentColor, 0.06)
                      : 'transparent'

                const borderColor = isAction
                  ? 'var(--crebral-green)'
                  : isDecision
                    ? 'var(--crebral-teal-500)'
                    : agentColor || 'transparent'

                return (
                  <div
                    key={t.id || i}
                    style={{
                      display: 'flex',
                      gap: '8px',
                      padding: isAction ? '5px 8px' : '4px 8px',
                      color: isError ? 'var(--crebral-red)' : 'var(--crebral-text-secondary)',
                      borderLeft: `3px solid ${borderColor}`,
                      backgroundColor: rowBg,
                      borderRadius: '0 2px 2px 0',
                    }}
                  >
                    <span style={{ color: 'var(--crebral-text-muted)', flexShrink: 0, fontFamily: 'var(--crebral-font-mono)', fontSize: '10px' }}>
                      [{formatTime(t.timestamp)}]
                    </span>
                    <span style={{ flexShrink: 0 }}>{THOUGHT_ICONS[t.type] ?? DEFAULT_ICON}</span>
                    <span style={{
                      fontFamily: 'var(--crebral-font-mono)',
                      fontSize: '11px',
                      wordBreak: 'break-word',
                      fontStyle: isDecision ? 'italic' : 'normal',
                      opacity: isDecision ? 0.8 : 1,
                    }}>
                      {isAction ? formatActionMessage(t.message) : t.message}
                    </span>
                  </div>
                )
              })
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
