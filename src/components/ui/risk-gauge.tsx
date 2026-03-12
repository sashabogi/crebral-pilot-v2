/**
 * RiskGauge — SVG semi-circular gauge for displaying moderation risk score.
 * Score is 0–1 (0% to 100%). Color transitions green → amber → red.
 */

interface RiskGaugeProps {
  score: number // 0 to 1
}

export function RiskGauge({ score }: RiskGaugeProps) {
  // Clamp score
  const clamped = Math.max(0, Math.min(1, score))
  const percentage = clamped * 100

  // Color: green (<30%), amber (30-60%), red (>60%)
  const color =
    clamped < 0.3
      ? 'var(--crebral-green)'
      : clamped < 0.6
        ? 'var(--crebral-amber-500)'
        : 'var(--crebral-red)'

  // SVG arc: semi-circle, strokeDasharray = percentage * 2.51 out of ~251 total
  // Arc path: M 16 96 A 80 80 0 0 1 176 96 (semi-circle, radius 80, center 96,96)
  const arcLength = 251 // approximate arc length of semi-circle with r=80
  const filled = clamped * arcLength

  // Needle: rotates from -90deg (0%) to 90deg (100%)
  const needleRotation = clamped * 180 - 90 // -90 to 90

  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 16 }}>
      {/* SVG gauge */}
      <div style={{ position: 'relative', width: 192, height: 104 }}>
        <svg width="192" height="96" viewBox="0 0 192 96">
          {/* Background arc */}
          <path
            d="M 16 96 A 80 80 0 0 1 176 96"
            fill="none"
            stroke="var(--crebral-border-card)"
            strokeWidth={12}
            strokeLinecap="round"
          />
          {/* Filled arc */}
          <path
            d="M 16 96 A 80 80 0 0 1 176 96"
            fill="none"
            stroke={color}
            strokeWidth={12}
            strokeLinecap="round"
            strokeDasharray={`${filled} ${arcLength}`}
            style={{
              transition: 'stroke-dasharray 0.6s ease, stroke 0.3s ease',
              filter: `drop-shadow(0 0 6px ${color})`,
            }}
          />
        </svg>

        {/* Needle */}
        <div
          style={{
            position: 'absolute',
            bottom: 8,
            left: '50%',
            width: 2,
            height: 68,
            background: `linear-gradient(to top, ${color}, transparent)`,
            transformOrigin: 'bottom center',
            transform: `translateX(-50%) rotate(${needleRotation}deg)`,
            transition: 'transform 0.6s ease',
          }}
        />
      </div>

      {/* Score display */}
      <div style={{ textAlign: 'center' }}>
        <div
          style={{
            fontFamily: 'var(--crebral-font-heading)',
            fontSize: '2rem',
            fontWeight: 700,
            color,
            lineHeight: 1,
          }}
        >
          {percentage.toFixed(1)}%
        </div>
        <div
          style={{
            fontFamily: 'var(--crebral-font-body)',
            fontSize: '0.75rem',
            color: 'var(--crebral-text-tertiary)',
            marginTop: 4,
          }}
        >
          Risk Score
        </div>
      </div>
    </div>
  )
}
