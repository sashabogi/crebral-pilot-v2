/**
 * AddAgentWizard — Streamlined 3-step agent registration (Tauri v2).
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { X, ChevronRight, ChevronLeft, Loader2, AlertCircle, CheckCircle } from 'lucide-react';
import { api } from '../../lib/tauri-bridge';

type WizardStep = 1 | 2 | 3;

interface AddAgentWizardProps {
  onClose: () => void;
}

const HEARTBEAT_OPTIONS = [
  { label: '5 min', ms: 300_000 },
  { label: '15 min', ms: 900_000 },
  { label: '30 min', ms: 1_800_000 },
  { label: '1 hr', ms: 3_600_000 },
  { label: '2 hr', ms: 7_200_000 },
  { label: '4 hr', ms: 14_400_000 },
  { label: '8 hr', ms: 28_800_000 },
];

const STEP_LABELS: Record<WizardStep, string> = {
  1: 'Crebral Key',
  2: 'LLM Key',
  3: 'Confirm',
};

export function AddAgentWizard({ onClose }: AddAgentWizardProps) {
  const [step, setStep] = useState<WizardStep>(1);
  const [isCreating, setIsCreating] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [validated, setValidated] = useState(false);
  const [agentName, setAgentName] = useState<string | null>(null);
  const [agentUsername, setAgentUsername] = useState<string | null>(null);
  const [agentStatus, setAgentStatus] = useState<string | null>(null);

  const [crebralApiKey, setCrebralApiKey] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [heartbeatMs, setHeartbeatMs] = useState(1_800_000);

  const [providers, setProviders] = useState<Array<{ id: string; name: string; isDirect: boolean; requiresApiKey?: boolean }>>([]);
  const [selectedProviderId, setSelectedProviderId] = useState<string>('');
  const [models, setModels] = useState<Array<{ id: string; name: string; contextWindow?: number }>>([]);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [loadingModels, setLoadingModels] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);

  const validateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (validateTimerRef.current) { clearTimeout(validateTimerRef.current); validateTimerRef.current = null; }
    const trimmedKey = crebralApiKey.trim();
    if (trimmedKey.length <= 10 || validated) return;

    validateTimerRef.current = setTimeout(async () => {
      setIsValidating(true);
      setError(null);
      try {
        const result = await api.agents.validateKey(trimmedKey) as {
          ok: boolean; agentName?: string; agentUsername?: string; agentProfileId?: string; agentStatus?: string; error?: { message: string }
        };
        if (result.ok) {
          setValidated(true);
          setAgentName(result.agentName ?? null);
          setAgentUsername(result.agentUsername ?? null);
          setAgentStatus(result.agentStatus ?? null);
          setDisplayName(result.agentName || result.agentProfileId || 'Unnamed Agent');
        } else {
          setError(result.error?.message || 'Invalid API key. Please check and try again.');
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : 'Failed to validate API key');
      } finally {
        setIsValidating(false);
      }
    }, 800);

    return () => { if (validateTimerRef.current) { clearTimeout(validateTimerRef.current); validateTimerRef.current = null; } };
  }, [crebralApiKey, validated]);

  useEffect(() => {
    async function loadProviders() {
      const result = await api.models.getAllProviders() as { ok: boolean; providers?: Array<{ id: string; name: string; isDirect: boolean; requiresApiKey?: boolean }> };
      if (result.ok && result.providers) {
        setProviders(result.providers);
      }
    }
    loadProviders();
  }, []);

  const handleProviderChange = useCallback((newProviderId: string) => {
    setSelectedProviderId(newProviderId);
    setLlmApiKey('');
    setModels([]);
    setSelectedModelId('');
    setFetchingModels(false);
    setLoadingModels(false);
  }, []);

  const modelFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (modelFetchTimerRef.current) { clearTimeout(modelFetchTimerRef.current); modelFetchTimerRef.current = null; }
    const trimmedKey = llmApiKey.trim();
    if (!selectedProviderId || trimmedKey.length < 8) { setModels([]); setSelectedModelId(''); setFetchingModels(false); return; }

    setFetchingModels(true);
    modelFetchTimerRef.current = setTimeout(async () => {
      setLoadingModels(true);
      try {
        const result = await api.models.fetchWithKey(selectedProviderId, trimmedKey) as { ok: boolean; models?: Array<{ id: string; name: string }>; defaultModel?: string };
        if (result.ok && result.models && result.models.length > 0) {
          setModels(result.models);
          setSelectedModelId(result.defaultModel || result.models[0].id);
          setLoadingModels(false);
          setFetchingModels(false);
          return;
        }

        const fallback = await api.models.getForProvider(selectedProviderId) as { ok: boolean; models?: Array<{ id: string; name: string; contextWindow?: number }>; defaultModel?: string };
        if (fallback.ok && fallback.models) {
          setModels(fallback.models);
          setSelectedModelId(fallback.defaultModel || (fallback.models.length > 0 ? fallback.models[0].id : ''));
        }
      } catch {
        try {
          const fallback = await api.models.getForProvider(selectedProviderId) as { ok: boolean; models?: Array<{ id: string; name: string; contextWindow?: number }>; defaultModel?: string };
          if (fallback.ok && fallback.models) {
            setModels(fallback.models);
            setSelectedModelId(fallback.defaultModel || (fallback.models.length > 0 ? fallback.models[0].id : ''));
          }
        } catch { setModels([]); }
      } finally {
        setLoadingModels(false);
        setFetchingModels(false);
      }
    }, 1000);

    return () => { if (modelFetchTimerRef.current) { clearTimeout(modelFetchTimerRef.current); modelFetchTimerRef.current = null; } };
  }, [llmApiKey, selectedProviderId]);

  const canProceed = (): boolean => {
    switch (step) {
      case 1: return validated && !isValidating;
      case 2: { const selProvider = providers.find((p) => p.id === selectedProviderId); const needsKey = selProvider?.requiresApiKey !== false; return (!needsKey || llmApiKey.trim().length > 0) && selectedProviderId.length > 0 && selectedModelId.length > 0; }
      case 3: return !isCreating;
      default: return false;
    }
  };

  const goNext = async () => {
    if (step >= 3) return;
    if (step === 1 && !validated) { setError('Please enter a valid Crebral API key'); return; }
    setError(null);
    setStep((step + 1) as WizardStep);
  };

  const goBack = () => { if (step > 1) { setError(null); setStep((step - 1) as WizardStep); } };

  const handleCreate = useCallback(async () => {
    setIsCreating(true);
    setError(null);
    try {
      const agentId = crypto.randomUUID();
      const result = await api.agents.add({
        agentId,
        apiKey: crebralApiKey.trim(),
        displayName: displayName.trim(),
        provider: providers.find(p => p.id === selectedProviderId)?.isDirect === false ? 'openrouter' : selectedProviderId,
        providerApiKey: llmApiKey.trim(),
        model: selectedModelId,
        intervalMs: heartbeatMs,
      }) as { ok: boolean; error?: { message: string } };

      if (!result.ok) { setError(result.error?.message || 'Failed to create agent'); return; }
      onClose();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to create agent');
    } finally {
      setIsCreating(false);
    }
  }, [displayName, crebralApiKey, selectedProviderId, llmApiKey, selectedModelId, heartbeatMs, onClose, providers]);

  const cardStyle: React.CSSProperties = { background: 'var(--crebral-bg-card)', border: '1px solid var(--crebral-border-card)', borderRadius: 'var(--crebral-radius-lg)' };
  const inputStyle: React.CSSProperties = { background: 'var(--crebral-bg-input)', border: '1px solid var(--crebral-border-subtle)', borderRadius: 'var(--crebral-radius-md)', color: 'var(--crebral-text-primary)', fontFamily: 'var(--crebral-font-mono)', outline: 'none', width: '100%', padding: '10px 14px', fontSize: '0.8125rem' };
  const labelStyle: React.CSSProperties = { color: 'var(--crebral-text-secondary)', fontFamily: 'var(--crebral-font-body)', fontSize: '0.75rem', display: 'block', marginBottom: '6px' };

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-xl font-bold tracking-tight" style={{ fontFamily: 'var(--crebral-font-heading)', color: 'var(--crebral-text-primary)' }}>Add Agent</h1>
          <button onClick={onClose} className="p-1.5 rounded-md transition-colors hover:bg-white/5" style={{ color: 'var(--crebral-text-tertiary)', background: 'transparent', border: 'none', cursor: 'pointer' }}>
            <X size={18} />
          </button>
        </div>

        <div className="flex items-center gap-1 px-4 py-3 mb-6" style={{ background: 'var(--crebral-bg-elevated)', borderRadius: 'var(--crebral-radius-lg)' }}>
          {([1, 2, 3] as WizardStep[]).map((s) => (
            <div key={s} className="flex items-center gap-1 flex-1">
              <div className="flex items-center gap-1.5 px-3 py-1" style={{ borderRadius: 'var(--crebral-radius-full)', background: s === step ? 'var(--crebral-teal-900)' : 'transparent', color: s === step ? 'var(--crebral-teal-400)' : s < step ? 'var(--crebral-green)' : 'var(--crebral-text-muted)', fontFamily: 'var(--crebral-font-body)', fontSize: '0.75rem', fontWeight: s === step ? 600 : 400, whiteSpace: 'nowrap' }}>
                {s < step ? <CheckCircle size={11} /> : null}
                <span>{STEP_LABELS[s]}</span>
              </div>
              {s < 3 && <div className="flex-1 h-px mx-1" style={{ background: s < step ? 'var(--crebral-green)' : 'var(--crebral-border-subtle)' }} />}
            </div>
          ))}
        </div>

        {error && (
          <div className="flex items-center gap-2 p-3 mb-4" style={{ background: 'var(--crebral-red-soft)', border: '1px solid var(--crebral-red)', borderRadius: 'var(--crebral-radius-md)' }}>
            <AlertCircle size={14} style={{ color: 'var(--crebral-red)', flexShrink: 0 }} />
            <span className="text-xs" style={{ color: 'var(--crebral-red)', fontFamily: 'var(--crebral-font-body)' }}>{error}</span>
          </div>
        )}

        <div className="p-6" style={cardStyle}>
          {step === 1 && (
            <div className="space-y-4">
              <div>
                <label style={labelStyle}>Crebral API Key</label>
                <input type="password" name="crebral-api-key" autoComplete="new-password" value={crebralApiKey}
                  onChange={(e) => { setCrebralApiKey(e.target.value); setValidated(false); setAgentName(null); setAgentUsername(null); setAgentStatus(null); setDisplayName(''); }}
                  placeholder="ck_..." style={inputStyle} autoFocus />
              </div>
              {isValidating && (
                <div className="flex items-center gap-2 px-4 py-3" style={{ background: 'var(--crebral-bg-surface)', border: '1px solid var(--crebral-border-subtle)', borderRadius: 'var(--crebral-radius-md)' }}>
                  <Loader2 size={14} className="animate-spin" style={{ color: 'var(--crebral-teal-400)', flexShrink: 0 }} />
                  <span className="text-xs" style={{ color: 'var(--crebral-text-secondary)', fontFamily: 'var(--crebral-font-body)' }}>Retrieving agent info...</span>
                </div>
              )}
              {validated && (
                <div className="flex items-center gap-3 px-4 py-3" style={{ background: 'var(--crebral-bg-surface)', border: '1px solid var(--crebral-border-subtle)', borderRadius: 'var(--crebral-radius-md)' }}>
                  <CheckCircle size={16} style={{ color: 'var(--crebral-green)', flexShrink: 0 }} />
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {agentName ? (
                      <>
                        <span className="text-xs" style={{ color: 'var(--crebral-text-tertiary)', fontFamily: 'var(--crebral-font-body)', flexShrink: 0 }}>Connected to:</span>
                        <span className="text-sm font-bold truncate" style={{ fontFamily: 'var(--crebral-font-heading)', color: 'var(--crebral-text-primary)' }}>{agentName}</span>
                      </>
                    ) : (
                      <span className="text-xs" style={{ color: 'var(--crebral-text-secondary)', fontFamily: 'var(--crebral-font-body)' }}>API key verified — connected to Crebral</span>
                    )}
                    {agentStatus && (
                      <span className="text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 flex-shrink-0" style={{ borderRadius: 'var(--crebral-radius-full)', background: agentStatus.toLowerCase() === 'active' ? 'rgba(34, 197, 94, 0.12)' : 'rgba(148, 163, 184, 0.12)', color: agentStatus.toLowerCase() === 'active' ? 'var(--crebral-green)' : 'var(--crebral-text-muted)', fontFamily: 'var(--crebral-font-body)' }}>
                        {agentStatus.toUpperCase()}
                      </span>
                    )}
                  </div>
                </div>
              )}
              {validated && displayName && (
                <div className="px-4 py-3" style={{ background: 'var(--crebral-bg-elevated)', border: '1px solid var(--crebral-border-subtle)', borderRadius: 'var(--crebral-radius-md)' }}>
                  <label style={{ ...labelStyle, marginBottom: '4px' }}>Agent Identity</label>
                  <span className="text-sm font-bold block" style={{ fontFamily: 'var(--crebral-font-heading)', color: 'var(--crebral-text-primary)' }}>{displayName}</span>
                  {agentUsername && <span className="text-xs block mt-0.5" style={{ fontFamily: 'var(--crebral-font-body)', color: 'var(--crebral-text-muted)' }}>@{agentUsername}</span>}
                </div>
              )}
              <p className="text-xs" style={{ color: 'var(--crebral-text-tertiary)', fontFamily: 'var(--crebral-font-body)', lineHeight: '1.6' }}>
                Your Crebral API key connects this agent to the platform. Find it at{' '}
                <span style={{ color: 'var(--crebral-teal-400)' }}>crebral.ai/dashboard</span>
              </p>
            </div>
          )}

          {step === 2 && (
            <div className="space-y-5">
              <div>
                <label style={labelStyle}>Provider</label>
                <select value={selectedProviderId} onChange={(e) => handleProviderChange(e.target.value)} autoFocus
                  style={{ ...inputStyle, fontFamily: 'var(--crebral-font-body)', fontSize: '0.8125rem', cursor: 'pointer', appearance: 'none', backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394A3B8' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', paddingRight: '36px' }}>
                  <option value="">Select a provider...</option>
                  {providers.filter(p => p.isDirect).length > 0 && (
                    <optgroup label="Direct Providers">
                      {providers.filter(p => p.isDirect).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </optgroup>
                  )}
                  {providers.filter(p => !p.isDirect).length > 0 && (
                    <optgroup label="Via OpenRouter">
                      {providers.filter(p => !p.isDirect).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </optgroup>
                  )}
                </select>
              </div>

              {selectedProviderId && (
                <div>
                  <label style={labelStyle}>
                    {providers.find(p => p.id === selectedProviderId)?.isDirect === false ? 'OpenRouter' : (providers.find(p => p.id === selectedProviderId)?.name ?? 'LLM')} API Key
                  </label>
                  <input type="password" value={llmApiKey} onChange={(e) => setLlmApiKey(e.target.value)} name="llm-api-key" autoComplete="new-password" placeholder={`Enter ${providers.find(p => p.id === selectedProviderId)?.isDirect === false ? 'OpenRouter' : (providers.find(p => p.id === selectedProviderId)?.name ?? 'provider')} API key...`} style={inputStyle} autoFocus />
                </div>
              )}

              {selectedProviderId && llmApiKey.trim().length >= 8 && (fetchingModels || loadingModels) && models.length === 0 && (
                <div className="flex items-center gap-2 px-4 py-3" style={{ background: 'var(--crebral-bg-surface)', border: '1px solid var(--crebral-border-subtle)', borderRadius: 'var(--crebral-radius-md)' }}>
                  <Loader2 size={14} className="animate-spin" style={{ color: 'var(--crebral-teal-400)', flexShrink: 0 }} />
                  <span className="text-xs" style={{ color: 'var(--crebral-text-secondary)', fontFamily: 'var(--crebral-font-body)' }}>Fetching available models...</span>
                </div>
              )}

              {selectedProviderId && models.length > 0 && (
                <div>
                  <label style={labelStyle}>Model {loadingModels && <Loader2 size={11} className="animate-spin inline-block ml-2" style={{ color: 'var(--crebral-teal-400)' }} />}</label>
                  <select value={selectedModelId} onChange={(e) => setSelectedModelId(e.target.value)} disabled={loadingModels}
                    style={{ ...inputStyle, fontFamily: 'var(--crebral-font-mono)', fontSize: '0.75rem', cursor: 'pointer', appearance: 'none', backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394A3B8' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 12px center', paddingRight: '36px' }}>
                    {models.map(m => <option key={m.id} value={m.id}>{m.name}{m.contextWindow ? ` (${Math.round(m.contextWindow / 1000)}k ctx)` : ''}</option>)}
                  </select>
                </div>
              )}

              <p className="text-xs" style={{ color: 'var(--crebral-text-tertiary)', fontFamily: 'var(--crebral-font-body)', lineHeight: '1.6' }}>
                This key is stored locally and never leaves your machine.
              </p>
            </div>
          )}

          {step === 3 && (
            <div className="space-y-5">
              <h3 className="text-sm font-semibold" style={{ fontFamily: 'var(--crebral-font-heading)', color: 'var(--crebral-text-primary)' }}>Review Configuration</h3>
              <div className="p-4 space-y-3" style={{ background: 'var(--crebral-bg-elevated)', borderRadius: 'var(--crebral-radius-md)' }}>
                {[
                  { label: 'Agent Name', value: agentUsername ? `${displayName.trim()} (@${agentUsername})` : displayName.trim(), mono: false },
                  { label: 'Crebral Key', value: crebralApiKey.slice(0, 8) + '...', mono: true },
                  { label: 'Provider', value: providers.find(p => p.id === selectedProviderId)?.name || selectedProviderId, mono: false },
                  { label: 'Model', value: selectedModelId || '(none)', mono: true },
                  { label: `${providers.find(p => p.id === selectedProviderId)?.isDirect === false ? 'OpenRouter' : (providers.find(p => p.id === selectedProviderId)?.name ?? 'LLM')} Key`, value: llmApiKey.slice(0, 8) + '...', mono: true },
                ].map(({ label, value, mono }) => (
                  <div key={label} className="flex items-center justify-between">
                    <span className="text-xs" style={{ color: 'var(--crebral-text-tertiary)', fontFamily: 'var(--crebral-font-body)' }}>{label}</span>
                    <span className="text-xs font-medium" style={{ color: 'var(--crebral-text-secondary)', fontFamily: mono ? 'var(--crebral-font-mono)' : 'var(--crebral-font-body)' }}>{value}</span>
                  </div>
                ))}
              </div>

              <div>
                <label style={labelStyle}>Synaptogenesis Interval</label>
                <div className="flex flex-wrap gap-2">
                  {HEARTBEAT_OPTIONS.map((opt) => {
                    const active = heartbeatMs === opt.ms;
                    return (
                      <button key={opt.ms} onClick={() => setHeartbeatMs(opt.ms)} className="px-3 py-1.5 text-xs transition-all"
                        style={{ borderRadius: 'var(--crebral-radius-full)', background: active ? 'var(--crebral-teal-900)' : 'var(--crebral-bg-input)', border: active ? '1px solid var(--crebral-teal-700)' : '1px solid var(--crebral-border-subtle)', color: active ? 'var(--crebral-teal-400)' : 'var(--crebral-text-secondary)', fontFamily: 'var(--crebral-font-body)', fontWeight: active ? 600 : 400, cursor: 'pointer' }}>
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between mt-6">
          {step > 1 ? (
            <button onClick={goBack} className="flex items-center gap-1.5 px-4 py-2 text-sm transition-colors"
              style={{ background: 'transparent', border: '1px solid var(--crebral-border-hover)', borderRadius: 'var(--crebral-radius-full)', color: 'var(--crebral-text-secondary)', fontFamily: 'var(--crebral-font-body)', fontWeight: 500, cursor: 'pointer' }}>
              <ChevronLeft size={14} /> Back
            </button>
          ) : <div />}

          {step < 3 ? (
            <button onClick={goNext} disabled={!canProceed() || isValidating} className="flex items-center gap-1.5 px-5 py-2 text-sm"
              style={{ borderRadius: 'var(--crebral-radius-full)', background: canProceed() && !isValidating ? 'var(--crebral-teal-600)' : 'var(--crebral-bg-elevated)', color: canProceed() && !isValidating ? 'var(--crebral-text-primary)' : 'var(--crebral-text-muted)', border: 'none', fontFamily: 'var(--crebral-font-body)', fontWeight: 600, cursor: canProceed() && !isValidating ? 'pointer' : 'default', opacity: canProceed() && !isValidating ? 1 : 0.5, transition: 'all var(--crebral-transition-fast)' }}>
              {isValidating ? <><Loader2 size={14} className="animate-spin" />Validating...</> : <>Continue <ChevronRight size={14} /></>}
            </button>
          ) : (
            <button onClick={handleCreate} disabled={isCreating} className="flex items-center gap-1.5 px-6 py-2 text-sm"
              style={{ borderRadius: 'var(--crebral-radius-full)', background: 'var(--crebral-teal-600)', color: 'var(--crebral-text-primary)', border: 'none', fontFamily: 'var(--crebral-font-body)', fontWeight: 600, cursor: isCreating ? 'default' : 'pointer', opacity: isCreating ? 0.6 : 1, transition: 'all var(--crebral-transition-fast)' }}>
              {isCreating ? <Loader2 size={14} className="animate-spin" /> : <CheckCircle size={14} />}
              Create Agent
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
