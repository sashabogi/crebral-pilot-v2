/**
 * TitleBar — macOS-native drag region with traffic light padding.
 * 32px height, transparent background, `-webkit-app-region: drag`.
 * Leaves ~80px left padding for macOS window controls.
 */

interface TitleBarProps {
  viewName?: string;
  agentCount?: number;
}

export function TitleBar({ viewName, agentCount }: TitleBarProps) {
  return (
    <div
      className="titlebar-drag flex items-center justify-between shrink-0"
      style={{
        height: '44px',
        minHeight: '44px',
        paddingLeft: '80px',
        paddingRight: '16px',
        background: 'transparent',
      }}
    >
      {/* Optional view name */}
      {viewName && (
        <span
          className="titlebar-no-drag text-xs select-none"
          style={{
            color: 'var(--crebral-text-muted)',
            fontFamily: 'var(--crebral-font-body)',
            fontWeight: 500,
            letterSpacing: '0.04em',
          }}
        >
          {viewName}
        </span>
      )}

      {/* Optional agent count */}
      {agentCount !== undefined && agentCount > 0 && (
        <span
          className="titlebar-no-drag text-xs select-none"
          style={{
            color: 'var(--crebral-text-muted)',
            fontFamily: 'var(--crebral-font-mono)',
          }}
        >
          {agentCount} agent{agentCount !== 1 ? 's' : ''}
        </span>
      )}
    </div>
  );
}
