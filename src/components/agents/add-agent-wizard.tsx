/**
 * AddAgentWizard — Simplified 2-step agent activation wizard (Tauri v2).
 *
 * Scenario A (synced agents): Skips Crebral key step, goes straight to
 *   provider selection + BYOK guide + key entry -> settings + confirm.
 *
 * Scenario B (manual): Crebral key step available as fallback via toggle.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import {
  X,
  ChevronRight,
  ChevronLeft,
  Loader2,
  AlertCircle,
  CheckCircle,
  ExternalLink,
  KeyRound,
  Zap,
  Info,
} from 'lucide-react';
import { api } from '../../lib/tauri-bridge';
import { useAppStore } from '../../store/app-store';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type WizardMode = 'synced' | 'manual';
type WizardStep = 1 | 2 | 3; // 3 only used in manual mode

interface AddAgentWizardProps {
  onClose: () => void;
}

// ---------------------------------------------------------------------------
// BYOK Provider Guide data (inlined from web repo)
// ---------------------------------------------------------------------------

interface ProviderGuide {
  key: string;
  name: string;
  productName: string;
  apiKeyUrl: string;
  steps: string[];
  freeTier: boolean;
  billingNote: string;
  importantNote?: string;
  description: string;
}

const PROVIDER_GUIDES: ProviderGuide[] = [
  {
    key: 'openai',
    name: 'OpenAI',
    productName: 'ChatGPT / GPT',
    apiKeyUrl: 'https://platform.openai.com/api-keys',
    steps: [
      'Sign up or log in at platform.openai.com',
      "Click 'API Keys' in the left sidebar",
      "Click 'Create new secret key'",
      "Copy the key — you won't see it again",
    ],
    freeTier: false,
    billingNote: 'Pay-as-you-go billing. Requires adding a payment method.',
    importantNote:
      'Even if you pay for ChatGPT Plus, you need a separate API key with its own billing at platform.openai.com',
    description: 'Industry-leading AI models including GPT-4o and o4-mini',
  },
  {
    key: 'anthropic',
    name: 'Anthropic',
    productName: 'Claude',
    apiKeyUrl: 'https://console.anthropic.com/settings/keys',
    steps: [
      'Sign up or log in at console.anthropic.com',
      'Go to Settings → API Keys',
      "Click 'Create Key'",
      'Copy the key',
    ],
    freeTier: true,
    billingNote: '$5 free credit for new accounts.',
    importantNote:
      'Separate from any Claude Pro subscription — this is API access.',
    description: 'Claude models known for nuanced reasoning and safety',
  },
  {
    key: 'google',
    name: 'Google',
    productName: 'Gemini',
    apiKeyUrl: 'https://aistudio.google.com/apikey',
    steps: [
      'Go to aistudio.google.com/apikey',
      'Sign in with your Google account',
      "Click 'Create API Key'",
      'Copy the key',
    ],
    freeTier: true,
    billingNote: 'Generous free tier with rate limits.',
    description: 'Gemini models with broad multimodal capabilities',
  },
  {
    key: 'deepseek',
    name: 'DeepSeek',
    productName: 'DeepSeek',
    apiKeyUrl: 'https://platform.deepseek.com/api_keys',
    steps: [
      'Sign up at platform.deepseek.com',
      'Go to API Keys',
      "Click 'Create new key'",
      'Copy the key',
    ],
    freeTier: true,
    billingNote: 'Very low cost — one of the cheapest providers.',
    description: 'High-quality reasoning at a fraction of the cost',
  },
  {
    key: 'perplexity',
    name: 'Perplexity',
    productName: 'Sonar',
    apiKeyUrl: 'https://www.perplexity.ai/settings/api',
    steps: [
      'Sign up or log in at perplexity.ai',
      'Go to Settings → API',
      "Click 'Generate' to create a key",
      'Copy the key',
    ],
    freeTier: false,
    billingNote: 'Pay-as-you-go.',
    description: 'Search-augmented AI with real-time web access',
  },
  {
    key: 'xai',
    name: 'xAI',
    productName: 'Grok',
    apiKeyUrl: 'https://console.x.ai/',
    steps: [
      'Sign up at console.x.ai',
      'Go to Dashboard → API Keys',
      "Click 'Create'",
      'Copy the key',
    ],
    freeTier: true,
    billingNote: 'Free monthly credit for new accounts ($25/month).',
    description: 'Grok models with real-time knowledge and bold reasoning',
  },
  {
    key: 'mistral',
    name: 'Mistral',
    productName: 'Mistral',
    apiKeyUrl: 'https://console.mistral.ai/api-keys',
    steps: [
      'Sign up at console.mistral.ai',
      'Go to API Keys',
      "Click 'Create new key'",
      'Copy the key',
    ],
    freeTier: true,
    billingNote: 'Free tier available with rate limits.',
    description:
      'Efficient European AI models with strong multilingual support',
  },
  {
    key: 'openrouter',
    name: 'OpenRouter',
    productName: 'OpenRouter',
    apiKeyUrl: 'https://openrouter.ai/keys',
    steps: [
      'Sign up at openrouter.ai',
      'Go to Keys',
      "Click 'Create Key'",
      'Copy the key',
    ],
    freeTier: true,
    billingNote:
      'Access 200+ models with one key. Some free models available.',
    importantNote:
      'OpenRouter is a router — one API key gives you access to models from every provider (OpenAI, Anthropic, Google, and more).',
    description: 'One key, 200+ models from every major provider',
  },
];

function getGuideForProvider(providerKey: string): ProviderGuide | undefined {
  return PROVIDER_GUIDES.find((g) => g.key === providerKey);
}

// Provider brand colors (matching web design system)
const PROVIDER_COLORS: Record<string, string> = {
  openai: '#3CB371',
  anthropic: '#E8952C',
  google: '#4A90D9',
  deepseek: '#1A73E8',
  perplexity: '#9B6FD4',
  xai: '#FFFFFF',
  mistral: '#FF7000',
  openrouter: '#6366F1',
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const HEARTBEAT_OPTIONS = [
  { label: '5 min', ms: 300_000 },
  { label: '15 min', ms: 900_000 },
  { label: '30 min', ms: 1_800_000 },
  { label: '1 hr', ms: 3_600_000 },
  { label: '2 hr', ms: 7_200_000 },
  { label: '4 hr', ms: 14_400_000 },
  { label: '8 hr', ms: 28_800_000 },
];

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AddAgentWizard({ onClose }: AddAgentWizardProps) {
  const agents = useAppStore((s) => s.agents);

  // Detect mode: if user has synced agents, skip Crebral key step
  const hasSyncedAgents = agents.length > 0;
  const [mode, setMode] = useState<WizardMode>(hasSyncedAgents ? 'synced' : 'manual');
  const [step, setStep] = useState<WizardStep>(1);

  const [isCreating, setIsCreating] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [isValidatingLlmKey, setIsValidatingLlmKey] = useState(false);
  const [llmKeyValid, setLlmKeyValid] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validated, setValidated] = useState(false);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [agentUsername, setAgentUsername] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);

  // Manual mode: Crebral API key
  const [crebralApiKey, setCrebralApiKey] = useState('');
  const [displayName, setDisplayName] = useState('');

  // Provider + LLM key
  const [llmApiKey, setLlmApiKey] = useState('');
  const [heartbeatMs, setHeartbeatMs] = useState(1_800_000);
  const [selectedGuideKey, setSelectedGuideKey] = useState<string | null>(null);

  const [providers, setProviders] = useState<
    Array<{ id: string; name: string; isDirect: boolean; requiresApiKey?: boolean }>
  >([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const [models, setModels] = useState<
    Array<{ id: string; name: string; contextWindow?: number }>
  >([]);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);

  const validateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // -- Step labels depend on mode --
  const stepLabels: Record<number, string> =
    mode === 'synced'
      ? { 1: 'Provider & Key', 2: 'Settings' }
      : { 1: 'Crebral Key', 2: 'Provider & Key', 3: 'Settings' };
  const totalSteps = mode === 'synced' ? 2 : 3;

  // The provider step number differs by mode
  const providerStep: WizardStep = mode === 'synced' ? 1 : 2;
  const settingsStep: WizardStep = mode === 'synced' ? 2 : 3;
  const crebralKeyStep: WizardStep | null = mode === 'manual' ? 1 : null;

  // ---------------------------------------------------------------------------
  // Crebral key validation (manual mode only)
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (mode !== 'manual') return;
    if (validateTimerRef.current) {
      clearTimeout(validateTimerRef.current);
      validateTimerRef.current = null;
    }
    const trimmedKey = crebralApiKey.trim();
    if (trimmedKey.length <= 10 || validated) return;

    validateTimerRef.current = setTimeout(async () => {
      setIsValidating(true);
      setError(null);
      try {
        const result = (await api.agents.validateKey(trimmedKey)) as {
          ok: boolean;
          agentName?: string;
          agentUsername?: string;
          agentProfileId?: string;
          agentStatus?: string;
          error?: { message: string };
        };
        if (result.ok) {
          setValidated(true);
          setAgentName(result.agentName ?? null);
          setAgentUsername(result.agentUsername ?? null);
          setAgentStatus(result.agentStatus ?? null);
          setDisplayName(
            result.agentName || result.agentProfileId || 'Unnamed Agent',
          );
        } else {
          setError(
            result.error?.message ||
              'Invalid API key. Please check and try again.',
          );
        }
      } catch (err: unknown) {
        setError(
          err instanceof Error ? err.message : 'Failed to validate API key',
        );
      } finally {
        setIsValidating(false);
      }
    }, 800);

    return () => {
      if (validateTimerRef.current) {
        clearTimeout(validateTimerRef.current);
        validateTimerRef.current = null;
      }
    };
  }, [crebralApiKey, validated, mode]);

  // ---------------------------------------------------------------------------
  // Load providers
  // ---------------------------------------------------------------------------

  useEffect(() => {
    async function loadProviders() {
      const result = (await api.models.getAllProviders()) as {
        ok: boolean;
        providers?: Array<{
          id: string;
          name: string;
          isDirect: boolean;
          requiresApiKey?: boolean;
        }>;
      };
      if (result.ok && result.providers) {
        setProviders(result.providers);
      }
    }
    loadProviders();
  }, []);

  // ---------------------------------------------------------------------------
  // Provider selection
  // ---------------------------------------------------------------------------

  const handleProviderSelect = useCallback(
    (providerKey: string) => {
      // Find the matching system provider
      const matching = providers.find(
        (p) =>
          p.id === providerKey ||
          p.name.toLowerCase() === providerKey.toLowerCase(),
      );
      if (matching) {
        setSelectedProviderId(matching.id);
      } else {
        setSelectedProviderId(providerKey);
      }
      setSelectedGuideKey(providerKey);
      setLlmApiKey('');
      setModels([]);
      setSelectedModelId('');
      setFetchingModels(false);
      setLoadingModels(false);
      setLlmKeyValid(false);
      setIsValidatingLlmKey(false);
    },
    [providers],
  );

  // ---------------------------------------------------------------------------
  // Model fetching when LLM key is entered
  // ---------------------------------------------------------------------------

  const modelFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (modelFetchTimerRef.current) {
      clearTimeout(modelFetchTimerRef.current);
      modelFetchTimerRef.current = null;
    }
    const trimmedKey = llmApiKey.trim();
    if (!selectedProviderId || trimmedKey.length < 8) {
      setModels([]);
      setSelectedModelId('');
      setFetchingModels(false);
      setLlmKeyValid(false);
      setIsValidatingLlmKey(false);
      return;
    }

    setFetchingModels(true);
    setIsValidatingLlmKey(true);
    setLlmKeyValid(false);
    modelFetchTimerRef.current = setTimeout(async () => {
      setLoadingModels(true);
      try {
        const result = (await api.models.fetchWithKey(
          selectedProviderId,
          trimmedKey,
        )) as {
          ok: boolean;
          models?: Array<{ id: string; name: string }>;
          defaultModel?: string;
        };
        if (result.ok && result.models && result.models.length > 0) {
          setModels(result.models);
          setSelectedModelId(result.defaultModel || result.models[0].id);
          setLoadingModels(false);
          setFetchingModels(false);
          setLlmKeyValid(true);
          setIsValidatingLlmKey(false);
          return;
        }

        const fallback = (await api.models.getForProvider(
          selectedProviderId,
        )) as {
          ok: boolean;
          models?: Array<{
            id: string;
            name: string;
            contextWindow?: number;
          }>;
          defaultModel?: string;
        };
        if (fallback.ok && fallback.models) {
          setModels(fallback.models);
          setSelectedModelId(
            fallback.defaultModel ||
              (fallback.models.length > 0 ? fallback.models[0].id : ''),
          );
          // Key may still be valid even if fetch didn't return models directly
          setLlmKeyValid(true);
        }
      } catch {
        try {
          const fallback = (await api.models.getForProvider(
            selectedProviderId,
          )) as {
            ok: boolean;
            models?: Array<{
              id: string;
              name: string;
              contextWindow?: number;
            }>;
            defaultModel?: string;
          };
          if (fallback.ok && fallback.models) {
            setModels(fallback.models);
            setSelectedModelId(
              fallback.defaultModel ||
                (fallback.models.length > 0 ? fallback.models[0].id : ''),
            );
          }
        } catch {
          setModels([]);
        }
      } finally {
        setLoadingModels(false);
        setFetchingModels(false);
        setIsValidatingLlmKey(false);
      }
    }, 1000);

    return () => {
      if (modelFetchTimerRef.current) {
        clearTimeout(modelFetchTimerRef.current);
        modelFetchTimerRef.current = null;
      }
    };
  }, [llmApiKey, selectedProviderId]);

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  const canProceed = (): boolean => {
    if (step === crebralKeyStep) {
      return validated && !isValidating;
    }
    if (step === providerStep) {
      const selProvider = providers.find((p) => p.id === selectedProviderId);
      const needsKey = selProvider?.requiresApiKey !== false;
      return (
        (!needsKey || llmApiKey.trim().length > 0) &&
        selectedProviderId.length > 0 &&
        selectedModelId.length > 0
      );
    }
    if (step === settingsStep) {
      return !isCreating;
    }
    return false;
  };

  const goNext = async () => {
    if (step >= totalSteps) return;
    if (step === crebralKeyStep && !validated) {
      setError('Please enter a valid Crebral API key');
      return;
    }
    setError(null);
    setStep((step + 1) as WizardStep);
  };

  const goBack = () => {
    if (step > 1) {
      setError(null);
      setStep((step - 1) as WizardStep);
    }
  };

  // ---------------------------------------------------------------------------
  // Create agent
  // ---------------------------------------------------------------------------

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    try {
      const agentId = crypto.randomUUID();
      const resolvedProvider =
        providers.find((p) => p.id === selectedProviderId)?.isDirect === false
          ? 'openrouter'
          : selectedProviderId;

      // For synced mode, use empty crebralApiKey (backend uses provisioned key)
      const apiKey = mode === 'manual' ? crebralApiKey.trim() : '';
      const name =
        mode === 'manual'
          ? displayName.trim()
          : `Agent ${agents.length + 1}`;

      const result = (await api.agents.add({
        agentId,
        apiKey,
        displayName: name,
        provider: resolvedProvider,
        providerApiKey: llmApiKey.trim(),
        model: selectedModelId,
        intervalMs: heartbeatMs,
      })) as { ok: boolean; error?: { message: string } };

      if (!result.ok) {
        setError(result.error?.message || 'Failed to create agent');
        return;
      }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setIsCreating(false);
    }
  }, [
    displayName,
    crebralApiKey,
    selectedProviderId,
    llmApiKey,
    selectedModelId,
    heartbeatMs,
    onClose,
    providers,
    mode,
    agents.length,
  ]);

  // ---------------------------------------------------------------------------
  // Shared styles
  // ---------------------------------------------------------------------------

  const cardStyle: React.CSSProperties = {
    background: 'var(--crebral-bg-card)',
    border: '1px solid var(--crebral-border-card)',
    borderRadius: 'var(--crebral-radius-lg)',
  };
  const inputStyle: React.CSSProperties = {
    background: 'var(--crebral-bg-input)',
    border: '1px solid var(--crebral-border-subtle)',
    borderRadius: 'var(--crebral-radius-md)',
    color: 'var(--crebral-text-primary)',
    fontFamily: 'var(--crebral-font-mono)',
    outline: 'none',
    width: '100%',
    padding: '10px 14px',
    fontSize: '0.8125rem',
  };
  const labelStyle: React.CSSProperties = {
    color: 'var(--crebral-text-secondary)',
    fontFamily: 'var(--crebral-font-body)',
    fontSize: '0.75rem',
    display: 'block',
    marginBottom: '6px',
  };

  // ---------------------------------------------------------------------------
  // Render: Provider card grid
  // ---------------------------------------------------------------------------

  const renderProviderCards = () => {
    return (
      <div className="grid grid-cols-2 gap-2">
        {PROVIDER_GUIDES.map((guide) => {
          const isSelected = selectedGuideKey === guide.key;
          const color = PROVIDER_COLORS[guide.key] || 'var(--crebral-text-secondary)';
          return (
            <button
              key={guide.key}
              onClick={() => handleProviderSelect(guide.key)}
              className="flex flex-col items-start p-3 text-left transition-all"
              style={{
                background: isSelected
                  ? `${color}10`
                  : 'var(--crebral-bg-elevated)',
                border: isSelected
                  ? `1px solid ${color}40`
                  : '1px solid var(--crebral-border-subtle)',
                borderRadius: 'var(--crebral-radius-md)',
                cursor: 'pointer',
              }}
            >
              <span
                className="text-sm font-semibold"
                style={{
                  fontFamily: 'var(--crebral-font-heading)',
                  color: isSelected ? color : 'var(--crebral-text-primary)',
                }}
              >
                {guide.name}
              </span>
              <span
                className="text-[11px] mt-0.5"
                style={{
                  fontFamily: 'var(--crebral-font-body)',
                  color: 'var(--crebral-text-tertiary)',
                }}
              >
                {guide.productName}
              </span>
            </button>
          );
        })}
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Render: BYOK guide inline
  // ---------------------------------------------------------------------------

  const renderBYOKGuide = () => {
    if (!selectedGuideKey) return null;
    const guide = getGuideForProvider(selectedGuideKey);
    if (!guide) return null;

    const color = PROVIDER_COLORS[guide.key] || 'var(--crebral-teal-400)';

    return (
      <div
        className="mt-4 p-4 space-y-3"
        style={{
          background: 'var(--crebral-bg-elevated)',
          border: '1px solid var(--crebral-border-subtle)',
          borderRadius: 'var(--crebral-radius-md)',
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between">
          <span
            className="text-xs font-semibold uppercase tracking-wider"
            style={{
              fontFamily: 'var(--crebral-font-heading)',
              color,
            }}
          >
            Get your {guide.name} API Key
          </span>
          {guide.freeTier && (
            <span
              className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5"
              style={{
                borderRadius: 'var(--crebral-radius-full)',
                background: 'rgba(34, 197, 94, 0.12)',
                color: 'var(--crebral-green)',
                fontFamily: 'var(--crebral-font-body)',
              }}
            >
              Free tier
            </span>
          )}
        </div>

        {/* Description */}
        <p
          className="text-xs"
          style={{
            color: 'var(--crebral-text-secondary)',
            fontFamily: 'var(--crebral-font-body)',
            lineHeight: '1.6',
          }}
        >
          {guide.description}
        </p>

        {/* Steps */}
        <ol className="space-y-1.5 pl-0 list-none">
          {guide.steps.map((s, i) => (
            <li key={i} className="flex items-start gap-2">
              <span
                className="flex-shrink-0 flex items-center justify-center text-[10px] font-bold"
                style={{
                  width: '18px',
                  height: '18px',
                  borderRadius: 'var(--crebral-radius-full)',
                  background: `${color}18`,
                  color,
                  fontFamily: 'var(--crebral-font-body)',
                  marginTop: '1px',
                }}
              >
                {i + 1}
              </span>
              <span
                className="text-xs"
                style={{
                  color: 'var(--crebral-text-secondary)',
                  fontFamily: 'var(--crebral-font-body)',
                  lineHeight: '1.5',
                }}
              >
                {s}
              </span>
            </li>
          ))}
        </ol>

        {/* Link to provider key page */}
        <button
          onClick={() => api.openExternal(guide.apiKeyUrl)}
          className="flex items-center gap-1.5 text-xs transition-colors"
          style={{
            background: 'transparent',
            border: 'none',
            color,
            fontFamily: 'var(--crebral-font-body)',
            fontWeight: 500,
            cursor: 'pointer',
            padding: 0,
          }}
        >
          <ExternalLink size={12} />
          Open {guide.name} API Keys page
        </button>

        {/* Billing note */}
        <p
          className="text-[11px]"
          style={{
            color: 'var(--crebral-text-muted)',
            fontFamily: 'var(--crebral-font-body)',
            lineHeight: '1.5',
          }}
        >
          {guide.billingNote}
        </p>

        {/* Important note */}
        {guide.importantNote && (
          <div
            className="flex items-start gap-2 p-2.5"
            style={{
              background: 'var(--crebral-bg-surface)',
              border: '1px solid var(--crebral-border-subtle)',
              borderRadius: 'var(--crebral-radius-sm)',
            }}
          >
            <Info
              size={13}
              style={{
                color: 'var(--crebral-amber-400)',
                flexShrink: 0,
                marginTop: '1px',
              }}
            />
            <span
              className="text-[11px]"
              style={{
                color: 'var(--crebral-text-tertiary)',
                fontFamily: 'var(--crebral-font-body)',
                lineHeight: '1.5',
              }}
            >
              {guide.importantNote}
            </span>
          </div>
        )}
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Render: Step indicators
  // ---------------------------------------------------------------------------

  const renderStepIndicator = () => {
    const steps = Array.from({ length: totalSteps }, (_, i) => i + 1);
    return (
      <div
        className="flex items-center gap-1 px-4 py-3 mb-6"
        style={{
          background: 'var(--crebral-bg-elevated)',
          borderRadius: 'var(--crebral-radius-lg)',
        }}
      >
        {steps.map((s) => (
          <div key={s} className="flex items-center gap-1 flex-1">
            <div
              className="flex items-center gap-1.5 px-3 py-1"
              style={{
                borderRadius: 'var(--crebral-radius-full)',
                background:
                  s === step ? 'var(--crebral-teal-900)' : 'transparent',
                color:
                  s === step
                    ? 'var(--crebral-teal-400)'
                    : s < step
                      ? 'var(--crebral-green)'
                      : 'var(--crebral-text-muted)',
                fontFamily: 'var(--crebral-font-body)',
                fontSize: '0.75rem',
                fontWeight: s === step ? 600 : 400,
                whiteSpace: 'nowrap',
              }}
            >
              {s < step ? <CheckCircle size={11} /> : null}
              <span>{stepLabels[s]}</span>
            </div>
            {s < totalSteps && (
              <div
                className="flex-1 h-px mx-1"
                style={{
                  background:
                    s < step
                      ? 'var(--crebral-green)'
                      : 'var(--crebral-border-subtle)',
                }}
              />
            )}
          </div>
        ))}
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Render: Crebral key step (manual mode only)
  // ---------------------------------------------------------------------------

  const renderCrebralKeyStep = () => (
    <div className="space-y-4">
      <div>
        <label style={labelStyle}>Crebral API Key</label>
        <input
          type="password"
          name="crebral-api-key"
          autoComplete="new-password"
          value={crebralApiKey}
          onChange={(e) => {
            setCrebralApiKey(e.target.value);
            setValidated(false);
            setAgentName(null);
            setAgentUsername(null);
            setAgentStatus(null);
            setDisplayName('');
          }}
          placeholder="ck_..."
          style={inputStyle}
          autoFocus
        />
      </div>
      {isValidating && (
        <div
          className="flex items-center gap-2 px-4 py-3"
          style={{
            background: 'var(--crebral-bg-surface)',
            border: '1px solid var(--crebral-border-subtle)',
            borderRadius: 'var(--crebral-radius-md)',
          }}
        >
          <Loader2
            size={14}
            className="animate-spin"
            style={{ color: 'var(--crebral-teal-400)', flexShrink: 0 }}
          />
          <span
            className="text-xs"
            style={{
              color: 'var(--crebral-text-secondary)',
              fontFamily: 'var(--crebral-font-body)',
            }}
          >
            Retrieving agent info...
          </span>
        </div>
      )}
      {validated && (
        <div
          className="flex items-center gap-3 px-4 py-3"
          style={{
            background: 'var(--crebral-bg-surface)',
            border: '1px solid var(--crebral-border-subtle)',
            borderRadius: 'var(--crebral-radius-md)',
          }}
        >
          <CheckCircle
            size={16}
            style={{ color: 'var(--crebral-green)', flexShrink: 0 }}
          />
          <div className="flex items-center gap-2 flex-1 min-w-0">
            {agentName ? (
              <>
                <span
                  className="text-xs"
                  style={{
                    color: 'var(--crebral-text-tertiary)',
                    fontFamily: 'var(--crebral-font-body)',
                    flexShrink: 0,
                  }}
                >
                  Connected to:
                </span>
                <span
                  className="text-sm font-bold truncate"
                  style={{
                    fontFamily: 'var(--crebral-font-heading)',
                    color: 'var(--crebral-text-primary)',
                  }}
                >
                  {agentName}
                </span>
              </>
            ) : (
              <span
                className="text-xs"
                style={{
                  color: 'var(--crebral-text-secondary)',
                  fontFamily: 'var(--crebral-font-body)',
                }}
              >
                API key verified — connected to Crebral
              </span>
            )}
            {agentStatus && (
              <span
                className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 flex-shrink-0"
                style={{
                  borderRadius: 'var(--crebral-radius-full)',
                  background:
                    agentStatus.toLowerCase() === 'active'
                      ? 'rgba(34, 197, 94, 0.12)'
                      : 'rgba(148, 163, 184, 0.12)',
                  color:
                    agentStatus.toLowerCase() === 'active'
                      ? 'var(--crebral-green)'
                      : 'var(--crebral-text-muted)',
                  fontFamily: 'var(--crebral-font-body)',
                }}
              >
                {agentStatus.toUpperCase()}
              </span>
            )}
          </div>
        </div>
      )}
      {validated && displayName && (
        <div
          className="px-4 py-3"
          style={{
            background: 'var(--crebral-bg-elevated)',
            border: '1px solid var(--crebral-border-subtle)',
            borderRadius: 'var(--crebral-radius-md)',
          }}
        >
          <label style={{ ...labelStyle, marginBottom: '4px' }}>
            Agent Identity
          </label>
          <span
            className="text-sm font-bold block"
            style={{
              fontFamily: 'var(--crebral-font-heading)',
              color: 'var(--crebral-text-primary)',
            }}
          >
            {displayName}
          </span>
          {agentUsername && (
            <span
              className="text-xs block mt-0.5"
              style={{
                fontFamily: 'var(--crebral-font-body)',
                color: 'var(--crebral-text-muted)',
              }}
            >
              @{agentUsername}
            </span>
          )}
        </div>
      )}
      <p
        className="text-xs"
        style={{
          color: 'var(--crebral-text-tertiary)',
          fontFamily: 'var(--crebral-font-body)',
          lineHeight: '1.6',
        }}
      >
        Your Crebral API key connects this agent to the platform. Find it at{' '}
        <span style={{ color: 'var(--crebral-teal-400)' }}>
          crebral.ai/dashboard
        </span>
      </p>
    </div>
  );

  // ---------------------------------------------------------------------------
  // Render: Provider + BYOK step
  // ---------------------------------------------------------------------------

  const renderProviderStep = () => {
    const selectedProvider = providers.find(
      (p) => p.id === selectedProviderId,
    );
    const providerLabel =
      selectedProvider?.isDirect === false
        ? 'OpenRouter'
        : (selectedProvider?.name ?? 'Provider');

    return (
      <div className="space-y-4">
        {/* Provider card grid */}
        <div>
          <label style={labelStyle}>Choose your AI provider</label>
          {renderProviderCards()}
        </div>

        {/* BYOK Guide */}
        {selectedGuideKey && renderBYOKGuide()}

        {/* API Key input */}
        {selectedGuideKey && (
          <div className="mt-4">
            <label style={labelStyle}>
              <KeyRound
                size={12}
                className="inline-block mr-1.5"
                style={{ verticalAlign: 'text-bottom' }}
              />
              {providerLabel} API Key
            </label>
            <div className="relative">
              <input
                type="password"
                value={llmApiKey}
                onChange={(e) => setLlmApiKey(e.target.value)}
                name="llm-api-key"
                autoComplete="new-password"
                placeholder={`Paste your ${providerLabel} API key here...`}
                style={inputStyle}
              />
              {/* Inline validation indicator */}
              {llmApiKey.trim().length >= 8 && (
                <div
                  className="absolute right-3 top-1/2 -translate-y-1/2"
                  style={{ pointerEvents: 'none' }}
                >
                  {isValidatingLlmKey ? (
                    <Loader2
                      size={14}
                      className="animate-spin"
                      style={{ color: 'var(--crebral-teal-400)' }}
                    />
                  ) : llmKeyValid ? (
                    <CheckCircle
                      size={14}
                      style={{ color: 'var(--crebral-green)' }}
                    />
                  ) : null}
                </div>
              )}
            </div>
            <p
              className="text-[11px] mt-1.5"
              style={{
                color: 'var(--crebral-text-muted)',
                fontFamily: 'var(--crebral-font-body)',
              }}
            >
              Stored locally on your machine. Never sent to Crebral servers.
            </p>
          </div>
        )}

        {/* Fetching models indicator */}
        {selectedProviderId &&
          llmApiKey.trim().length >= 8 &&
          (fetchingModels || loadingModels) &&
          models.length === 0 && (
            <div
              className="flex items-center gap-2 px-4 py-3"
              style={{
                background: 'var(--crebral-bg-surface)',
                border: '1px solid var(--crebral-border-subtle)',
                borderRadius: 'var(--crebral-radius-md)',
              }}
            >
              <Loader2
                size={14}
                className="animate-spin"
                style={{ color: 'var(--crebral-teal-400)', flexShrink: 0 }}
              />
              <span
                className="text-xs"
                style={{
                  color: 'var(--crebral-text-secondary)',
                  fontFamily: 'var(--crebral-font-body)',
                }}
              >
                Validating key and fetching models...
              </span>
            </div>
          )}

        {/* Model selector */}
        {selectedProviderId && models.length > 0 && (
          <div>
            <label style={labelStyle}>
              Model{' '}
              {loadingModels && (
                <Loader2
                  size={11}
                  className="animate-spin inline-block ml-2"
                  style={{ color: 'var(--crebral-teal-400)' }}
                />
              )}
            </label>
            <select
              value={selectedModelId}
              onChange={(e) => setSelectedModelId(e.target.value)}
              disabled={loadingModels}
              style={{
                ...inputStyle,
                fontFamily: 'var(--crebral-font-mono)',
                fontSize: '0.75rem',
                cursor: 'pointer',
                appearance: 'none' as const,
                backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394A3B8' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`,
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'right 12px center',
                paddingRight: '36px',
              }}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                  {m.contextWindow
                    ? ` (${Math.round(m.contextWindow / 1000)}k ctx)`
                    : ''}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Render: Settings + Confirm step
  // ---------------------------------------------------------------------------

  const renderSettingsStep = () => {
    const selectedProvider = providers.find(
      (p) => p.id === selectedProviderId,
    );
    const providerLabel =
      selectedProvider?.isDirect === false
        ? 'OpenRouter'
        : (selectedProvider?.name ?? 'LLM');
    const guide = selectedGuideKey
      ? getGuideForProvider(selectedGuideKey)
      : null;

    return (
      <div className="space-y-5">
        <h3
          className="text-sm font-semibold"
          style={{
            fontFamily: 'var(--crebral-font-heading)',
            color: 'var(--crebral-text-primary)',
          }}
        >
          Review & Activate
        </h3>

        {/* Summary */}
        <div
          className="p-4 space-y-3"
          style={{
            background: 'var(--crebral-bg-elevated)',
            borderRadius: 'var(--crebral-radius-md)',
          }}
        >
          {[
            ...(mode === 'manual'
              ? [
                  {
                    label: 'Agent',
                    value: agentUsername
                      ? `${displayName.trim()} (@${agentUsername})`
                      : displayName.trim(),
                    mono: false,
                  },
                  {
                    label: 'Crebral Key',
                    value: crebralApiKey.slice(0, 8) + '...',
                    mono: true,
                  },
                ]
              : []),
            {
              label: 'Provider',
              value: guide?.name || selectedProvider?.name || selectedProviderId,
              mono: false,
            },
            {
              label: 'Model',
              value: selectedModelId || '(none)',
              mono: true,
            },
            {
              label: `${providerLabel} Key`,
              value:
                llmApiKey.trim().length > 8
                  ? llmApiKey.slice(0, 8) + '...'
                  : '(none)',
              mono: true,
            },
          ].map(({ label, value, mono }) => (
            <div key={label} className="flex items-center justify-between">
              <span
                className="text-xs"
                style={{
                  color: 'var(--crebral-text-tertiary)',
                  fontFamily: 'var(--crebral-font-body)',
                }}
              >
                {label}
              </span>
              <span
                className="text-xs font-medium"
                style={{
                  color: 'var(--crebral-text-secondary)',
                  fontFamily: mono
                    ? 'var(--crebral-font-mono)'
                    : 'var(--crebral-font-body)',
                }}
              >
                {value}
              </span>
            </div>
          ))}
        </div>

        {/* Heartbeat interval */}
        <div>
          <label style={labelStyle}>Synaptogenesis Interval</label>
          <div className="flex flex-wrap gap-2">
            {HEARTBEAT_OPTIONS.map((opt) => {
              const active = heartbeatMs === opt.ms;
              return (
                <button
                  key={opt.ms}
                  onClick={() => setHeartbeatMs(opt.ms)}
                  className="px-3 py-1.5 text-xs transition-all"
                  style={{
                    borderRadius: 'var(--crebral-radius-full)',
                    background: active
                      ? 'var(--crebral-teal-900)'
                      : 'var(--crebral-bg-input)',
                    border: active
                      ? '1px solid var(--crebral-teal-700)'
                      : '1px solid var(--crebral-border-subtle)',
                    color: active
                      ? 'var(--crebral-teal-400)'
                      : 'var(--crebral-text-secondary)',
                    fontFamily: 'var(--crebral-font-body)',
                    fontWeight: active ? 600 : 400,
                    cursor: 'pointer',
                  }}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    );
  };

  // ---------------------------------------------------------------------------
  // Main render
  // ---------------------------------------------------------------------------

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-xl mx-auto">
        {/* Header */}
        <div className="flex items-center justify-between mb-6">
          <h1
            className="text-xl font-bold tracking-tight"
            style={{
              fontFamily: 'var(--crebral-font-heading)',
              color: 'var(--crebral-text-primary)',
            }}
          >
            {mode === 'synced' ? 'Activate Agent' : 'Add Agent'}
          </h1>
          <button
            onClick={onClose}
            className="p-1.5 rounded-md transition-colors hover:bg-white/5"
            style={{
              color: 'var(--crebral-text-tertiary)',
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
            }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Mode toggle — show when in synced mode so user can switch to manual */}
        {mode === 'synced' && (
          <button
            onClick={() => {
              setMode('manual');
              setStep(1);
              setError(null);
            }}
            className="flex items-center gap-1.5 text-xs mb-4 transition-colors"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--crebral-text-muted)',
              fontFamily: 'var(--crebral-font-body)',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <KeyRound size={11} />
            Have a Crebral API key? Add manually
          </button>
        )}
        {mode === 'manual' && hasSyncedAgents && (
          <button
            onClick={() => {
              setMode('synced');
              setStep(1);
              setError(null);
            }}
            className="flex items-center gap-1.5 text-xs mb-4 transition-colors"
            style={{
              background: 'transparent',
              border: 'none',
              color: 'var(--crebral-text-muted)',
              fontFamily: 'var(--crebral-font-body)',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <Zap size={11} />
            Back to quick setup
          </button>
        )}

        {/* Step indicators */}
        {renderStepIndicator()}

        {/* Error banner */}
        {error && (
          <div
            className="flex items-center gap-2 p-3 mb-4"
            style={{
              background: 'var(--crebral-red-soft)',
              border: '1px solid var(--crebral-red)',
              borderRadius: 'var(--crebral-radius-md)',
            }}
          >
            <AlertCircle
              size={14}
              style={{ color: 'var(--crebral-red)', flexShrink: 0 }}
            />
            <span
              className="text-xs"
              style={{
                color: 'var(--crebral-red)',
                fontFamily: 'var(--crebral-font-body)',
              }}
            >
              {error}
            </span>
          </div>
        )}

        {/* Card body */}
        <div className="p-6" style={cardStyle}>
          {step === crebralKeyStep && renderCrebralKeyStep()}
          {step === providerStep && renderProviderStep()}
          {step === settingsStep && renderSettingsStep()}
        </div>

        {/* "I don't have a key" helper — manual mode, step 1 */}
        {mode === 'manual' && step === 1 && !validated && (
          <div
            className="mt-3 p-3 flex items-start gap-2"
            style={{
              background: 'var(--crebral-bg-elevated)',
              border: '1px solid var(--crebral-border-subtle)',
              borderRadius: 'var(--crebral-radius-md)',
            }}
          >
            <Info
              size={13}
              style={{
                color: 'var(--crebral-amber-400)',
                flexShrink: 0,
                marginTop: '1px',
              }}
            />
            <div>
              <button
                onClick={() => api.openExternal('https://crebral.ai')}
                className="text-xs font-medium transition-colors"
                style={{
                  background: 'transparent',
                  border: 'none',
                  color: 'var(--crebral-teal-400)',
                  fontFamily: 'var(--crebral-font-body)',
                  cursor: 'pointer',
                  padding: 0,
                }}
              >
                I don't have a key yet
              </button>
              <p
                className="text-[11px] mt-1"
                style={{
                  color: 'var(--crebral-text-muted)',
                  fontFamily: 'var(--crebral-font-body)',
                  lineHeight: '1.5',
                }}
              >
                Create an agent at crebral.ai first, then come back with your
                API key. Or sign in above to sync your agents automatically.
              </p>
            </div>
          </div>
        )}

        {/* Navigation footer */}
        <div className="flex items-center justify-between mt-6">
          {step > 1 ? (
            <button
              onClick={goBack}
              className="flex items-center gap-1.5 px-4 py-2 text-sm transition-colors"
              style={{
                background: 'transparent',
                border: '1px solid var(--crebral-border-hover)',
                borderRadius: 'var(--crebral-radius-full)',
                color: 'var(--crebral-text-secondary)',
                fontFamily: 'var(--crebral-font-body)',
                fontWeight: 500,
                cursor: 'pointer',
              }}
            >
              <ChevronLeft size={14} /> Back
            </button>
          ) : (
            <div />
          )}

          {step < totalSteps ? (
            <button
              onClick={goNext}
              disabled={!canProceed() || isValidating}
              className="flex items-center gap-1.5 px-5 py-2 text-sm"
              style={{
                borderRadius: 'var(--crebral-radius-full)',
                background:
                  canProceed() && !isValidating
                    ? 'var(--crebral-teal-600)'
                    : 'var(--crebral-bg-elevated)',
                color:
                  canProceed() && !isValidating
                    ? 'var(--crebral-text-primary)'
                    : 'var(--crebral-text-muted)',
                border: 'none',
                fontFamily: 'var(--crebral-font-body)',
                fontWeight: 600,
                cursor:
                  canProceed() && !isValidating ? 'pointer' : 'default',
                opacity: canProceed() && !isValidating ? 1 : 0.5,
                transition: 'all var(--crebral-transition-fast)',
              }}
            >
              {isValidating ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  Validating...
                </>
              ) : (
                <>
                  Continue <ChevronRight size={14} />
                </>
              )}
            </button>
          ) : (
            <button
              onClick={handleCreate}
              disabled={isCreating}
              className="flex items-center gap-1.5 px-6 py-2 text-sm"
              style={{
                borderRadius: 'var(--crebral-radius-full)',
                background: 'var(--crebral-teal-600)',
                color: 'var(--crebral-text-primary)',
                border: 'none',
                fontFamily: 'var(--crebral-font-body)',
                fontWeight: 600,
                cursor: isCreating ? 'default' : 'pointer',
                opacity: isCreating ? 0.6 : 1,
                transition: 'all var(--crebral-transition-fast)',
              }}
            >
              {isCreating ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <Zap size={14} />
              )}
              Activate Agent
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
