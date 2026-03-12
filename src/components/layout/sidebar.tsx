/**
 * Sidebar — 80px icon-only navigation for the Crebral desktop client.
 */

import { LayoutDashboard, Network, Activity, Brain, Settings, Plus, ShieldAlert } from 'lucide-react'
import { useAppStore } from '../../store/app-store'
import crebralIcon from '../../assets/icon-small.png'

export type ViewId = 'dashboard' | 'agents' | 'activity' | 'moderation' | 'brain' | 'settings'

const AGENT_COLORS = [
  '#3AAFB9', '#E8A838', '#E05A6D', '#7C6AE8', '#4CAF50',
  '#FF7043', '#42A5F5', '#AB47BC', '#26A69A', '#EC407A',
  '#8D6E63', '#FFCA28',
]

function hexToRgba(hex: string, alpha: number): string {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

interface SidebarProps {
  activeView: ViewId
  onViewChange: (view: ViewId) => void
  onAddAgent?: () => void
  connectionStatus?: 'connected' | 'disconnected' | 'error'
}

const AGENT_NAV_ITEMS: { id: ViewId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'moderation', label: 'Moderation', icon: ShieldAlert },
  { id: 'brain', label: 'Brain', icon: Brain },
]

const GLOBAL_NAV_ITEMS_MULTI: { id: ViewId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'agents', label: 'Orchestration', icon: Network },
  { id: 'settings', label: 'Settings', icon: Settings },
]

const GLOBAL_NAV_ITEMS_SINGLE: { id: ViewId; label: string; icon: typeof LayoutDashboard }[] = [
  { id: 'agents', label: 'Agents', icon: Network },
  { id: 'settings', label: 'Settings', icon: Settings },
]

export function Sidebar({
  activeView,
  onViewChange,
  onAddAgent,
  connectionStatus = 'disconnected',
}: SidebarProps) {
  const agents = useAppStore((s) => s.agents)
  const activeAgentId = useAppStore((s) => s.activeAgentId)
  const setActiveAgent = useAppStore((s) => s.setActiveAgent)
  const agentLimit = useAppStore((s) => s.agentLimit)
  const isSingleAgentMode = (agentLimit !== null && agentLimit <= 1) || agents.length <= 1
  const GLOBAL_NAV_ITEMS = isSingleAgentMode ? GLOBAL_NAV_ITEMS_SINGLE : GLOBAL_NAV_ITEMS_MULTI

  const activeAgentIndex = agents.findIndex((a) => a.agentId === activeAgentId)
  const activeAgent = activeAgentIndex >= 0 ? agents[activeAgentIndex] : undefined
  const accentColor = (activeAgent?.color && activeAgent.color !== '#3AAFB9') ? activeAgent.color : (activeAgentIndex >= 0 ? AGENT_COLORS[activeAgentIndex % AGENT_COLORS.length] : '#3AAFB9')

  const statusColor =
    connectionStatus === 'connected'
      ? 'var(--crebral-green)'
      : connectionStatus === 'error'
        ? 'var(--crebral-red)'
        : 'var(--crebral-text-muted)'

  return (
    <div
      className="flex flex-col h-full shrink-0"
      style={{
        width: '80px',
        minWidth: '80px',
        background: 'var(--crebral-bg-sidebar)',
        borderRight: '1px solid var(--crebral-border-subtle)',
      }}
    >
      <style>{`
        ${agents.map((ag, idx) => {
          const c = (ag.color && ag.color !== '#3AAFB9') ? ag.color as string : AGENT_COLORS[idx % AGENT_COLORS.length]
          return `@keyframes agent-glow-${idx} {
          0%, 100% { box-shadow: 0 0 4px ${hexToRgba(c, 0.4)}; }
          50% { box-shadow: 0 0 12px ${hexToRgba(c, 0.7)}; }
        }`
        }).join('\n')}
      `}</style>

      <div
        className="flex items-center justify-center"
        style={{
          height: '56px',
          minHeight: '56px',
          borderBottom: '1px solid var(--crebral-border-subtle)',
        }}
      >
        <img
          src={crebralIcon}
          alt="Crebral"
          draggable={false}
          style={{
            width: '32px',
            height: '32px',
            cursor: 'pointer',
            transition: 'all 0.3s ease',
            filter: `drop-shadow(0 0 4px ${hexToRgba(accentColor, 0.5)})`,
          }}
          title="Crebral"
        />
      </div>

      {(agents.length > 0 || onAddAgent) && (
        <div
          className="flex flex-col items-center gap-1.5 px-2 py-3"
          style={{
            borderBottom: '1px solid var(--crebral-border-subtle)',
            maxHeight: '220px',
            overflowY: agents.length > 5 ? 'auto' : 'visible',
            overflowX: 'hidden',
          }}
        >
          {agents.map((ag, idx) => {
            const isActive = ag.agentId === activeAgentId
            const isRunning = (ag.running as boolean | undefined) ?? false
            const agentColor = (ag.color && ag.color !== '#3AAFB9') ? ag.color as string : AGENT_COLORS[idx % AGENT_COLORS.length]
            const borderColor = isRunning ? agentColor : hexToRgba(agentColor, 0.4)
            const initial = ((ag.displayName || ag.name || ag.agentId || 'A') as string)
              .charAt(0)
              .toUpperCase()

            return (
              <button
                key={ag.agentId}
                onClick={() => setActiveAgent(ag.agentId)}
                title={`${ag.displayName || ag.name || ag.agentId}${isRunning ? ' (running)' : ''}`}
                style={{
                  width: '36px',
                  height: '36px',
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: '0.75rem',
                  fontWeight: 600,
                  fontFamily: 'var(--crebral-font-heading)',
                  color: 'var(--crebral-bg-deep)',
                  background: agentColor,
                  border: `2px solid ${borderColor}`,
                  cursor: 'pointer',
                  transition: 'all 0.3s ease',
                  boxShadow: isActive
                    ? `0 0 0 2px var(--crebral-bg-sidebar), 0 0 0 4px ${agentColor}`
                    : 'none',
                  animation: isRunning ? `agent-glow-${idx} 2s ease-in-out infinite` : 'none',
                  opacity: isActive ? 1 : 0.65,
                  transform: isActive ? 'scale(1)' : 'scale(0.88)',
                  flexShrink: 0,
                }}
              >
                {initial}
              </button>
            )
          })}

          {onAddAgent && (
            <button
              onClick={onAddAgent}
              title="Add agent"
              style={{
                width: '28px',
                height: '28px',
                borderRadius: '50%',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'transparent',
                border: '1.5px dashed var(--crebral-border-hover)',
                color: 'var(--crebral-text-muted)',
                cursor: 'pointer',
                transition: 'all 0.2s ease',
                flexShrink: 0,
              }}
            >
              <Plus size={13} />
            </button>
          )}
        </div>
      )}

      <div
        className="flex-1 flex flex-col items-center gap-2 pt-3"
        style={{
          background: activeAgent
            ? `linear-gradient(180deg, ${hexToRgba(accentColor, 0.06)} 0%, transparent 60%)`
            : 'transparent',
          transition: 'background 0.3s ease',
        }}
      >
        {AGENT_NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const isActive = activeView === item.id
          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              title={item.label}
              className="relative w-12 h-12 rounded-lg flex items-center justify-center"
              style={{
                background: isActive ? hexToRgba(accentColor, 0.12) : 'transparent',
                color: isActive ? accentColor : 'var(--crebral-text-secondary)',
                border: 'none',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
              }}
            >
              {isActive && (
                <div
                  className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-7 rounded-r"
                  style={{ background: accentColor, transition: 'background 0.3s ease' }}
                />
              )}
              <Icon size={20} />
            </button>
          )
        })}
      </div>

      <div
        className="flex flex-col items-center gap-2 py-3"
        style={{ borderTop: '1px solid var(--crebral-border-subtle)' }}
      >
        {GLOBAL_NAV_ITEMS.map((item) => {
          const Icon = item.icon
          const isActive = activeView === item.id
          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              title={item.label}
              className="relative w-12 h-12 rounded-lg flex items-center justify-center"
              style={{
                background: isActive ? hexToRgba(accentColor, 0.12) : 'transparent',
                color: isActive ? accentColor : 'var(--crebral-text-secondary)',
                border: 'none',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
              }}
            >
              {isActive && (
                <div
                  className="absolute left-0 top-1/2 -translate-y-1/2 w-1 h-7 rounded-r"
                  style={{ background: accentColor, transition: 'background 0.3s ease' }}
                />
              )}
              <Icon size={20} />
            </button>
          )
        })}
      </div>

      <div
        className="flex items-center justify-center py-5"
        style={{ borderTop: '1px solid var(--crebral-border-subtle)' }}
      >
        <div
          className="w-2.5 h-2.5 rounded-full"
          title={
            connectionStatus === 'connected'
              ? 'Connected'
              : connectionStatus === 'error'
                ? 'Connection error'
                : 'Disconnected'
          }
          style={{
            background: statusColor,
            boxShadow: connectionStatus === 'connected' ? `0 0 6px ${statusColor}` : 'none',
          }}
        />
      </div>
    </div>
  )
}
