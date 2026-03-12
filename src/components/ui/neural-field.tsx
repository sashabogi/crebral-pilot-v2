import { useEffect, useRef, useCallback } from 'react'
import { useHeartbeatStore } from '../../store/heartbeat-store'

// ---------------------------------------------------------------------------
// Synaptogenesis intensity phases
// ---------------------------------------------------------------------------

type NeuralPhase = 'idle' | 'anticipation' | 'synaptogenesis' | 'cooldown'

interface IntensityParams {
  speedMultiplier: number   // < 1 = faster animations (duration multiplier)
  brightnessScale: number   // multiplier on node/line opacity (1 = idle)
  glowScale: number         // multiplier on glow overlay opacity
  pulseAmplitude: number    // 0 = no pulse, ~0.3 = organic heartbeat
  pulseFrequency: number    // Hz — ~0.8 for cardiac feel
}

const IDLE: IntensityParams = {
  speedMultiplier: 1.0,
  brightnessScale: 1.0,
  glowScale: 0.0,
  pulseAmplitude: 0.0,
  pulseFrequency: 0.0,
}

const ANTICIPATION_PEAK: IntensityParams = {
  speedMultiplier: 0.4,
  brightnessScale: 1.4,
  glowScale: 0.25,
  pulseAmplitude: 0.08,
  pulseFrequency: 0.5,
}

const SYNAPTOGENESIS: IntensityParams = {
  speedMultiplier: 0.15,
  brightnessScale: 2.0,
  glowScale: 1.0,
  pulseAmplitude: 0.35,
  pulseFrequency: 0.8,
}

const WARMUP_WINDOW_MS = 120_000   // 2 min before next cycle: anticipation begins
const COOLDOWN_DURATION_MS = 8_000 // 8 seconds to return to idle

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function lerpParams(a: IntensityParams, b: IntensityParams, t: number): IntensityParams {
  const ct = Math.max(0, Math.min(1, t))
  return {
    speedMultiplier: lerp(a.speedMultiplier, b.speedMultiplier, ct),
    brightnessScale: lerp(a.brightnessScale, b.brightnessScale, ct),
    glowScale: lerp(a.glowScale, b.glowScale, ct),
    pulseAmplitude: lerp(a.pulseAmplitude, b.pulseAmplitude, ct),
    pulseFrequency: lerp(a.pulseFrequency, b.pulseFrequency, ct),
  }
}

/** Ease-out cubic for smooth deceleration */
function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3)
}

/** Organic cardiac pulse: fast systole, slow diastole */
function cardiacPulse(time: number, frequency: number, amplitude: number): number {
  if (amplitude === 0 || frequency === 0) return 0
  // Use a modified sine that spends more time in the "down" phase
  const phase = (time * frequency) % 1
  // Quick rise (systole: 0-0.15), brief plateau (0.15-0.25), slow fall (diastole: 0.25-1.0)
  let wave: number
  if (phase < 0.15) {
    wave = Math.sin((phase / 0.15) * Math.PI * 0.5)  // 0→1 (quick rise)
  } else if (phase < 0.25) {
    wave = 1.0 - (phase - 0.15) / 0.1 * 0.15         // 1→0.85 (brief hold/plateau)
  } else {
    const fallPhase = (phase - 0.25) / 0.75
    wave = 0.85 * (1 - easeOutCubic(fallPhase))       // 0.85→0 (slow diastolic decay)
  }
  return wave * amplitude
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function NeuralField() {
  const containerRef = useRef<HTMLDivElement>(null)
  const glowOverlayRef = useRef<HTMLDivElement>(null)
  const initializedRef = useRef(false)
  const nodesRef = useRef<HTMLDivElement[]>([])
  const linesRef = useRef<HTMLDivElement[]>([])
  const nodeMetaRef = useRef<{ baseDuration: number; delay: number; isAmber: boolean }[]>([])
  const lineMetaRef = useRef<{ baseDuration: number; delay: number }[]>([])

  // Animation frame refs
  const rafRef = useRef<number>(0)
  const lastSpeedRef = useRef<number>(1.0)
  const cooldownStartRef = useRef<number | null>(null)
  const cooldownFromRef = useRef<IntensityParams>(IDLE)
  const prevCycleActiveRef = useRef<boolean>(false)

  // Coordinator state from heartbeat store
  const coordinatorRunning = useHeartbeatStore((s) => s.coordinatorRunning)
  const cycleActive = useHeartbeatStore((s) => s.cycleActive)
  const nextScheduledAt = useHeartbeatStore((s) => s.nextScheduledAt)

  // ---------------------------------------------------------------------------
  // Phase & parameter computation
  // ---------------------------------------------------------------------------

  const computePhase = useCallback((): { phase: NeuralPhase; params: IntensityParams } => {
    // If a cycle just ended, enter cooldown
    if (cooldownStartRef.current !== null) {
      const elapsed = Date.now() - cooldownStartRef.current
      if (elapsed >= COOLDOWN_DURATION_MS) {
        // Cooldown complete
        cooldownStartRef.current = null
        cooldownFromRef.current = IDLE
      } else {
        const t = easeOutCubic(elapsed / COOLDOWN_DURATION_MS)
        return {
          phase: 'cooldown',
          params: lerpParams(cooldownFromRef.current, IDLE, t),
        }
      }
    }

    // Active synaptogenesis
    if (cycleActive) {
      return { phase: 'synaptogenesis', params: SYNAPTOGENESIS }
    }

    // Anticipation: coordinator running, next scheduled within warmup window
    if (coordinatorRunning && nextScheduledAt) {
      const msUntilNext = new Date(nextScheduledAt).getTime() - Date.now()
      if (msUntilNext > 0 && msUntilNext <= WARMUP_WINDOW_MS) {
        const progress = 1 - msUntilNext / WARMUP_WINDOW_MS  // 0→1 as we approach
        return {
          phase: 'anticipation',
          params: lerpParams(IDLE, ANTICIPATION_PEAK, progress),
        }
      }
    }

    return { phase: 'idle', params: IDLE }
  }, [coordinatorRunning, cycleActive, nextScheduledAt])

  // ---------------------------------------------------------------------------
  // Detect cycle transitions for cooldown
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const wasCycleActive = prevCycleActiveRef.current
    prevCycleActiveRef.current = cycleActive

    // Transition from active → not active: begin cooldown
    if (wasCycleActive && !cycleActive) {
      cooldownStartRef.current = Date.now()
      cooldownFromRef.current = { ...SYNAPTOGENESIS }
    }
    // Transition from not active → active: cancel any cooldown
    if (!wasCycleActive && cycleActive) {
      cooldownStartRef.current = null
    }
  }, [cycleActive])

  // ---------------------------------------------------------------------------
  // Apply intensity parameters to DOM elements
  // ---------------------------------------------------------------------------

  const applyParams = useCallback((params: IntensityParams, time: number) => {
    const container = containerRef.current
    if (!container) return

    // Compute pulse offset for this frame
    const pulse = cardiacPulse(time / 1000, params.pulseFrequency, params.pulseAmplitude)
    const effectiveBrightness = params.brightnessScale + pulse

    // Only update CSS animation durations when speed changes significantly
    // to avoid constant style recalculation
    const speedChanged = Math.abs(params.speedMultiplier - lastSpeedRef.current) > 0.02
    if (speedChanged) {
      lastSpeedRef.current = params.speedMultiplier

      nodesRef.current.forEach((node, i) => {
        const meta = nodeMetaRef.current[i]
        if (!meta) return
        const animName = params.speedMultiplier < 0.25 ? 'nodeAppearActive' : 'nodeAppear'
        node.style.animation = `${animName} ${meta.baseDuration * params.speedMultiplier}s ${meta.delay * params.speedMultiplier}s infinite`
      })

      linesRef.current.forEach((line, i) => {
        const meta = lineMetaRef.current[i]
        if (!meta) return
        const animName = params.speedMultiplier < 0.25 ? 'lineAppearActive' : 'lineAppear'
        line.style.animation = `${animName} ${meta.baseDuration * params.speedMultiplier}s ${meta.delay * params.speedMultiplier}s infinite`
      })
    }

    // Apply brightness to nodes via filter (lightweight GPU-composited)
    const brightnessCSS = `brightness(${effectiveBrightness.toFixed(2)})`
    nodesRef.current.forEach((node) => {
      node.style.filter = brightnessCSS
    })
    linesRef.current.forEach((line) => {
      line.style.filter = brightnessCSS
    })

    // Glow overlay
    const overlay = glowOverlayRef.current
    if (overlay) {
      const glowOpacity = Math.max(0, Math.min(1, params.glowScale + pulse * 1.5))
      overlay.style.opacity = String(glowOpacity.toFixed(3))
      // Use CSS animation only during active synaptogenesis for the ambient glow
      if (params.pulseAmplitude > 0.1) {
        if (overlay.style.animationName !== 'neuralPulse') {
          overlay.style.animation = 'neuralPulse 1.25s ease-in-out infinite'
        }
      } else {
        if (overlay.style.animationName === 'neuralPulse') {
          overlay.style.animation = 'none'
        }
      }
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Create DOM nodes/lines once on mount
  // ---------------------------------------------------------------------------

  useEffect(() => {
    const container = containerRef.current
    if (!container || initializedRef.current) return
    initializedRef.current = true

    const nodeCount = 55
    const lineCount = 28
    const vw = window.innerWidth
    const vh = window.innerHeight

    const nodePositions: { x: number; y: number }[] = []
    const nodes: HTMLDivElement[] = []
    const lines: HTMLDivElement[] = []
    const nodeMeta: { baseDuration: number; delay: number; isAmber: boolean }[] = []
    const lineMeta: { baseDuration: number; delay: number }[] = []

    for (let i = 0; i < nodeCount; i++) {
      const x = Math.random() * 100
      const y = Math.random() * 100
      const size = 3 + Math.random() * 3.5
      const baseDuration = 3 + Math.random() * 5
      const delay = Math.random() * 4
      const isAmber = Math.random() > 0.75

      nodePositions.push({ x, y })

      const node = document.createElement('div')
      node.style.position = 'absolute'
      node.style.left = `${x}vw`
      node.style.top = `${y}vh`
      node.style.width = `${size}px`
      node.style.height = `${size}px`
      node.style.borderRadius = '50%'
      node.style.background = isAmber ? 'var(--crebral-amber-400)' : 'var(--crebral-teal-400)'
      const glowColor = isAmber ? 'rgba(251, 191, 36, 0.6)' : 'rgba(45, 212, 191, 0.6)'
      node.style.boxShadow = `0 0 ${size * 2}px ${glowColor}, 0 0 ${size * 4}px ${isAmber ? 'rgba(251, 191, 36, 0.2)' : 'rgba(45, 212, 191, 0.2)'}`
      node.style.opacity = '0'
      node.style.animation = `nodeAppear ${baseDuration}s ${delay}s infinite`
      node.style.willChange = 'opacity, transform, filter'

      container.appendChild(node)
      nodes.push(node)
      nodeMeta.push({ baseDuration, delay, isAmber })
    }

    for (let i = 0; i < lineCount; i++) {
      const aIdx = Math.floor(Math.random() * nodeCount)
      const bIdx = Math.floor(Math.random() * nodeCount)
      if (aIdx === bIdx) continue

      const a = nodePositions[aIdx]
      const b = nodePositions[bIdx]
      const dx = (b.x - a.x) * (vw / 100)
      const dy = (b.y - a.y) * (vh / 100)
      const length = Math.sqrt(dx * dx + dy * dy)
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI
      const baseDuration = 5 + Math.random() * 6
      const lineDelay = Math.random() * 5

      const line = document.createElement('div')
      line.style.position = 'absolute'
      line.style.left = `${a.x}vw`
      line.style.top = `${a.y}vh`
      line.style.width = `${Math.min(length, 350)}px`
      line.style.height = '1px'
      line.style.background =
        'linear-gradient(90deg, transparent 0%, rgba(45, 212, 191, 0.35) 20%, rgba(45, 212, 191, 0.35) 80%, transparent 100%)'
      line.style.transform = `rotate(${angle}deg)`
      line.style.transformOrigin = '0 0'
      line.style.opacity = '0'
      line.style.animation = `lineAppear ${baseDuration}s ${lineDelay}s infinite`
      line.style.willChange = 'opacity, filter'

      container.appendChild(line)
      lines.push(line)
      lineMeta.push({ baseDuration, delay: lineDelay })
    }

    nodesRef.current = nodes
    linesRef.current = lines
    nodeMetaRef.current = nodeMeta
    lineMetaRef.current = lineMeta

    return () => {
      while (container.firstChild) container.removeChild(container.firstChild)
      nodesRef.current = []
      linesRef.current = []
      nodeMetaRef.current = []
      lineMetaRef.current = []
      initializedRef.current = false
    }
  }, [])

  // ---------------------------------------------------------------------------
  // Animation loop — runs per-frame when active/cooldown, 1/s when idle
  // ---------------------------------------------------------------------------

  useEffect(() => {
    let intervalId: ReturnType<typeof setInterval> | null = null

    function tick(time?: number) {
      const { phase, params } = computePhase()
      applyParams(params, time ?? performance.now())

      // If we're in a phase that needs per-frame updates (pulse/cooldown),
      // use rAF. Otherwise fall back to 1-second interval.
      if (phase === 'synaptogenesis' || phase === 'cooldown' || (phase === 'anticipation' && params.pulseAmplitude > 0.02)) {
        // Cancel interval if it was set
        if (intervalId) { clearInterval(intervalId); intervalId = null }
        rafRef.current = requestAnimationFrame(tick)
      } else {
        // Cancel rAF if it was set
        if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
        // Start interval if not already running
        if (!intervalId) {
          intervalId = setInterval(() => tick(performance.now()), 1000)
        }
      }
    }

    // Kickstart
    tick(performance.now())

    return () => {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0 }
      if (intervalId) { clearInterval(intervalId); intervalId = null }
    }
  }, [computePhase, applyParams])

  return (
    <div
      ref={containerRef}
      style={{ position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh', overflow: 'hidden' }}
    >
      <div
        ref={glowOverlayRef}
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0,
          pointerEvents: 'none',
          transition: 'opacity 1s ease-in-out',
          background: 'radial-gradient(ellipse at center, var(--crebral-teal-glow) 0%, transparent 70%)',
        }}
      />
    </div>
  )
}
