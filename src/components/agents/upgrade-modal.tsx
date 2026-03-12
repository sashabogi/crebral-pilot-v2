/**
 * UpgradeModal — shown when user hits their agent limit.
 * Follows the same overlay pattern as add-agent-wizard.
 */

import { X, ArrowUpRight, Sparkles } from 'lucide-react';
import { api } from '../../lib/tauri-bridge';

const TIER_UPGRADES: Record<string, { next: string; price: string; agents: string; contact?: boolean }> = {
  free: { next: 'Starter', price: 'See pricing', agents: '3' },
  basic: { next: 'Starter', price: 'See pricing', agents: '3' },
  starter: { next: 'Pro', price: 'See pricing', agents: '10' },
  pro: { next: 'Research', price: 'Contact us', agents: 'Unlimited', contact: true },
};

function tierLabel(tier: string): string {
  const labels: Record<string, string> = {
    free: 'Free',
    basic: 'Free',
    starter: 'Starter',
    pro: 'Pro',
    research: 'Research',
  };
  return labels[tier.toLowerCase()] ?? tier;
}

interface UpgradeModalProps {
  tier: string;
  agentCount: number;
  agentLimit: number;
  onClose: () => void;
}

export function UpgradeModal({ tier, agentCount, agentLimit, onClose }: UpgradeModalProps) {
  const upgrade = TIER_UPGRADES[tier.toLowerCase()] ?? TIER_UPGRADES.pro;

  const handleViewPlans = async () => {
    try {
      await api.openExternal('https://www.crebral.com/pricing');
    } catch {
      // Fallback — shouldn't happen
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.60)' }}
    >
      <div className="absolute inset-0" onClick={onClose} />
      <div
        className="relative z-10 w-full max-w-md"
        style={{
          background: 'var(--crebral-bg-body)',
          border: '1px solid var(--crebral-border-card)',
          borderRadius: 'var(--crebral-radius-lg)',
          boxShadow: '0 24px 48px rgba(0, 0, 0, 0.4)',
          overflow: 'hidden',
        }}
      >
        {/* Header accent bar */}
        <div
          style={{
            height: '3px',
            background: 'linear-gradient(90deg, var(--crebral-teal-600), var(--crebral-teal-500))',
          }}
        />

        <div style={{ padding: '28px 32px 24px' }}>
          {/* Close button */}
          <button
            onClick={onClose}
            style={{
              position: 'absolute',
              top: '16px',
              right: '16px',
              background: 'transparent',
              border: 'none',
              color: 'var(--crebral-text-muted)',
              cursor: 'pointer',
              padding: '4px',
              borderRadius: 'var(--crebral-radius-md)',
              transition: 'color 0.15s ease',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--crebral-text-secondary)'; }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--crebral-text-muted)'; }}
          >
            <X size={18} />
          </button>

          {/* Icon */}
          <div
            style={{
              width: '48px',
              height: '48px',
              borderRadius: '12px',
              background: 'rgba(58, 175, 185, 0.10)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: '20px',
            }}
          >
            <Sparkles size={22} style={{ color: 'var(--crebral-teal-500)' }} />
          </div>

          {/* Title */}
          <h2
            style={{
              fontFamily: 'var(--crebral-font-heading)',
              fontSize: '1.25rem',
              fontWeight: 700,
              color: 'var(--crebral-text-primary)',
              letterSpacing: '-0.02em',
              marginBottom: '8px',
            }}
          >
            Agent limit reached
          </h2>

          {/* Current plan info */}
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '8px',
              marginBottom: '24px',
            }}
          >
            <span
              style={{
                padding: '3px 10px',
                borderRadius: '9999px',
                background: 'rgba(58, 175, 185, 0.10)',
                color: 'var(--crebral-teal-500)',
                fontFamily: 'var(--crebral-font-body)',
                fontSize: '0.7rem',
                fontWeight: 700,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              {tierLabel(tier)} Plan
            </span>
            <span
              style={{
                fontFamily: 'var(--crebral-font-mono)',
                fontSize: '0.8rem',
                color: 'var(--crebral-text-tertiary)',
              }}
            >
              {agentCount} of {agentLimit} agent{agentLimit !== 1 ? 's' : ''} used
            </span>
          </div>

          {/* Upgrade card */}
          <div
            style={{
              background: 'var(--crebral-bg-card)',
              border: '1px solid var(--crebral-border-card)',
              borderRadius: 'var(--crebral-radius-lg)',
              padding: '20px',
              marginBottom: '24px',
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'flex-start',
                marginBottom: '12px',
              }}
            >
              <div>
                <div
                  style={{
                    fontFamily: 'var(--crebral-font-heading)',
                    fontSize: '1rem',
                    fontWeight: 700,
                    color: 'var(--crebral-text-primary)',
                    letterSpacing: '-0.01em',
                  }}
                >
                  {upgrade.next}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--crebral-font-body)',
                    fontSize: '0.8rem',
                    color: 'var(--crebral-text-tertiary)',
                    marginTop: '2px',
                  }}
                >
                  {upgrade.agents} agent{upgrade.agents !== '1' ? 's' : ''}
                </div>
              </div>
              <div
                style={{
                  fontFamily: 'var(--crebral-font-heading)',
                  fontSize: '1.15rem',
                  fontWeight: 700,
                  color: 'var(--crebral-teal-500)',
                }}
              >
                {upgrade.price}
              </div>
            </div>
          </div>

          {/* Actions */}
          <div style={{ display: 'flex', gap: '12px' }}>
            <button
              onClick={handleViewPlans}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '8px',
                padding: '10px 20px',
                borderRadius: 'var(--crebral-radius-full)',
                background: 'var(--crebral-teal-600)',
                color: '#fff',
                border: 'none',
                fontFamily: 'var(--crebral-font-body)',
                fontWeight: 600,
                fontSize: '0.875rem',
                cursor: 'pointer',
                transition: 'opacity 0.15s ease',
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.88'; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
            >
              View Plans
              <ArrowUpRight size={15} />
            </button>
            <button
              onClick={onClose}
              style={{
                padding: '10px 20px',
                borderRadius: 'var(--crebral-radius-full)',
                background: 'transparent',
                color: 'var(--crebral-text-secondary)',
                border: '1px solid var(--crebral-border-card)',
                fontFamily: 'var(--crebral-font-body)',
                fontWeight: 600,
                fontSize: '0.875rem',
                cursor: 'pointer',
                transition: 'all 0.15s ease',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = 'var(--crebral-text-muted)';
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = 'var(--crebral-border-card)';
              }}
            >
              Close
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
