/**
 * BrainView — Full-page LLM configuration for the active agent.
 *
 * Shows provider, API key, model (progressive reveal), and synaptogenesis
 * interval. Reads stored config via api.agents.get() and saves
 * via api.agents.add() (upsert).
 */

// @ts-nocheck
import { useState, useEffect, useCallback, useRef } from 'react';
import { api } from '../../lib/tauri-bridge';
import {
  Brain,
  Loader2,
  AlertCircle,
  CheckCircle,
  Save,
  Info,
  Zap,
  XCircle,
} from 'lucide-react';
import { useAppStore } from '../../store/app-store';

/* -- Synaptogenesis interval options ---------------------------------------- */

const HEARTBEAT_OPTIONS = [
  { label: '5 min', ms: 300_000 },
  { label: '15 min', ms: 900_000 },
  { label: '30 min', ms: 1_800_000 },
  { label: '1 hr', ms: 3_600_000 },
  { label: '2 hr', ms: 7_200_000 },
  { label: '4 hr', ms: 14_400_000 },
  { label: '8 hr', ms: 28_800_000 },
];

/* =========================================================================
   Component
   ========================================================================= */

export function BrainView() {
  const agents = useAppStore((s) => s.agents);
  const activeAgentId = useAppStore((s) => s.activeAgentId);
  const loadAgentsStore = useAppStore((s) => s.loadAgents);
  const activeAgent = agents.find((a) => a.agentId === activeAgentId);

  /* -- Loading / saving state ---------------------------------------------- */
  const [isLoadingAgent, setIsLoadingAgent] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  /* -- Original stored values (for dirty checking) ------------------------- */
  const [storedAgent, setStoredAgent] = useState<StoredAgent | null>(null);

  /* -- Form state ---------------------------------------------------------- */
  const [selectedProviderId, setSelectedProviderId] = useState('');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [selectedModelId, setSelectedModelId] = useState('');
  const [heartbeatMs, setHeartbeatMs] = useState(1_800_000);
  const [isRunning, setIsRunning] = useState(false);

  /* -- Provider / model lists ---------------------------------------------- */
  const [providers, setProviders] = useState<
    Array<{ id: string; name: string; isDirect: boolean }>
  >([]);
  const [models, setModels] = useState<
    Array<{ id: string; name: string; contextWindow?: number }>
  >([]);
  const [loadingModels, setLoadingModels] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);

  /* -- Track whether the provider was intentionally changed ---------------- */
  const [providerChanged, setProviderChanged] = useState(false);

  /* -- Connection test state ----------------------------------------------- */
  const [isTesting, setIsTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  /* -- Load agent config + providers on mount / agent change --------------- */

  useEffect(() => {
    if (!activeAgentId) {
      setIsLoadingAgent(false);
      return;
    }

    const agentId = activeAgentId;
    let cancelled = false;

    async function load() {
      setIsLoadingAgent(true);
      setError(null);
      setSuccessMsg(null);
      setProviderChanged(false);
      initialModelFetchDone.current = false;

      try {
        // Fetch providers
        if (api.models?.getAllProviders) {
          const pResult = await api.models.getAllProviders();
          if (!cancelled && pResult.ok && pResult.providers) {
            setProviders(pResult.providers);
          }
        }

        // Fetch full agent config (including providerApiKey)
        if (api.agents?.get) {
          const result = await api.agents.get(agentId);
          if (!cancelled && result.ok && result.agent) {
            const a = result.agent;
            setStoredAgent(a);
            setSelectedProviderId(a.provider || '');
            setLlmApiKey(a.providerApiKey || '');
            setSelectedModelId(a.model || '');
            setHeartbeatMs(a.intervalMs ?? 1_800_000);
          } else if (!cancelled) {
            setStoredAgent(null);
            setSelectedProviderId('');
            setLlmApiKey('');
            setSelectedModelId('');
            setHeartbeatMs(1_800_000);
            if (result.error?.message) {
              setError(result.error.message);
            }
          }
        }

        // Check if currently running
        if (api.heartbeat?.status) {
          const hb = await api.heartbeat.status(agentId);
          if (!cancelled) setIsRunning(hb?.running ?? false);
        }
      } catch (err) {
        if (!cancelled) {
          setError(
            err instanceof Error ? err.message : 'Failed to load agent config',
          );
        }
      } finally {
        if (!cancelled) setIsLoadingAgent(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [activeAgentId]);

  /* -- Fetch models when stored agent loads (initial) ---------------------- */

  const initialModelFetchDone = useRef(false);

  useEffect(() => {
    if (!storedAgent || initialModelFetchDone.current) return;
    if (!storedAgent.provider || !storedAgent.providerApiKey) return;

    initialModelFetchDone.current = true;

    async function fetchInitialModels() {
      setLoadingModels(true);
      try {
        // If the key is "REDACTED", the backend has a real key stored but
        // never exposes it to the frontend. Use the server-side fetch command
        // that resolves the real key from keychain/JSON.
        if (storedAgent!.providerApiKey === 'REDACTED' && api.models?.fetchForAgent) {
          const result = await api.models.fetchForAgent(
            storedAgent!.agentId,
            storedAgent!.provider,
          );
          if (result.ok && result.models && result.models.length > 0) {
            setModels(result.models);
            const found = result.models.find(
              (m) => m.id === storedAgent!.model,
            );
            if (found) {
              setSelectedModelId(found.id);
            } else {
              setSelectedModelId(
                result.defaultModel || result.models[0].id,
              );
            }
            return;
          }
        }

        // Key is a real user-entered value (not REDACTED) — use it directly
        if (storedAgent!.providerApiKey !== 'REDACTED' && api.models?.fetchWithKey) {
          const result = await api.models.fetchWithKey(
            storedAgent!.provider,
            storedAgent!.providerApiKey,
          );
          if (result.ok && result.models && result.models.length > 0) {
            setModels(result.models);
            const found = result.models.find(
              (m) => m.id === storedAgent!.model,
            );
            if (found) {
              setSelectedModelId(found.id);
            } else {
              setSelectedModelId(
                result.defaultModel || result.models[0].id,
              );
            }
            return;
          }
        }
        // Fallback: static model list
        if (api.models?.getForProvider) {
          const fallback = await api.models.getForProvider(
            storedAgent!.provider,
          );
          if (fallback.ok && fallback.models) {
            setModels(fallback.models);
            const found = fallback.models.find(
              (m) => m.id === storedAgent!.model,
            );
            if (found) {
              setSelectedModelId(found.id);
            } else if (fallback.defaultModel) {
              setSelectedModelId(fallback.defaultModel);
            } else if (fallback.models.length > 0) {
              setSelectedModelId(fallback.models[0].id);
            }
          }
        }
      } catch {
        // Ignore — models will just be empty
      } finally {
        setLoadingModels(false);
      }
    }
    fetchInitialModels();
  }, [storedAgent]);

  /* -- Reset key + models when provider changes ---------------------------- */

  const handleProviderChange = useCallback((newProviderId: string) => {
    setSelectedProviderId(newProviderId);
    setProviderChanged(true);
    setLlmApiKey('');
    setModels([]);
    setSelectedModelId('');
    setFetchingModels(false);
    setLoadingModels(false);
    setTestResult(null);
  }, []);

  /* -- Connection test handler --------------------------------------------- */
  const handleTestConnection = useCallback(async () => {
    if (!selectedProviderId || !llmApiKey.trim()) return;
    setIsTesting(true);
    setTestResult(null);
    try {
      const result = await api.models.fetchWithKey(selectedProviderId, llmApiKey.trim());
      if (result.ok && result.models && result.models.length > 0) {
        setTestResult({ ok: true, message: `Connected — ${result.models.length} models available` });
        // Populate model dropdown so user can save immediately after testing
        setModels(result.models);
        if (!selectedModelId || !result.models.find((m) => m.id === selectedModelId)) {
          setSelectedModelId(result.defaultModel || result.models[0].id);
        }
        // Cancel any pending debounced fetch since we already have models
        if (modelFetchTimerRef.current) {
          clearTimeout(modelFetchTimerRef.current);
          modelFetchTimerRef.current = null;
        }
        setFetchingModels(false);
        setLoadingModels(false);
      } else if (result.ok) {
        setTestResult({ ok: true, message: 'Connected' });
      } else {
        setTestResult({ ok: false, message: result.error?.message || 'Connection failed' });
      }
    } catch (err) {
      setTestResult({ ok: false, message: err instanceof Error ? err.message : 'Connection failed' });
    } finally {
      setIsTesting(false);
    }
  }, [selectedProviderId, llmApiKey, selectedModelId]);

  /* -- Debounced model fetch when API key changes -------------------------- */

  const modelFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );

  useEffect(() => {
    // Skip during initial load — handled by the initial fetch effect.
    // UNLESS the stored agent has no provider key (initial fetch was skipped),
    // in which case we allow the debounced fetch to run when the user enters a key.
    if (!providerChanged && storedAgent && !initialModelFetchDone.current && storedAgent.providerApiKey)
      return;

    if (modelFetchTimerRef.current) {
      clearTimeout(modelFetchTimerRef.current);
      modelFetchTimerRef.current = null;
    }

    const trimmedKey = llmApiKey.trim();

    if (!selectedProviderId || trimmedKey.length < 8) {
      if (providerChanged) {
        setModels([]);
        setSelectedModelId('');
      }
      setFetchingModels(false);
      return;
    }

    // Don't re-fetch if nothing changed from stored values
    if (
      !providerChanged &&
      storedAgent &&
      selectedProviderId === storedAgent.provider &&
      trimmedKey === storedAgent.providerApiKey
    ) {
      return;
    }

    setFetchingModels(true);

    modelFetchTimerRef.current = setTimeout(async () => {
      setLoadingModels(true);
      try {
        if (api.models?.fetchWithKey) {
          const result = await api.models.fetchWithKey(
            selectedProviderId,
            trimmedKey,
          );
          if (result.ok && result.models && result.models.length > 0) {
            setModels(result.models);
            if (result.defaultModel) {
              setSelectedModelId(result.defaultModel);
            } else {
              setSelectedModelId(result.models[0].id);
            }
            setLoadingModels(false);
            setFetchingModels(false);
            return;
          }
        }

        // Fallback: static model list
        if (api.models?.getForProvider) {
          const fallback = await api.models.getForProvider(
            selectedProviderId,
          );
          if (fallback.ok && fallback.models) {
            setModels(fallback.models);
            if (fallback.defaultModel) {
              setSelectedModelId(fallback.defaultModel);
            } else if (fallback.models.length > 0) {
              setSelectedModelId(fallback.models[0].id);
            }
          }
        }
      } catch {
        try {
          if (api.models?.getForProvider) {
            const fallback = await api.models.getForProvider(
              selectedProviderId,
            );
            if (fallback.ok && fallback.models) {
              setModels(fallback.models);
              if (fallback.defaultModel) {
                setSelectedModelId(fallback.defaultModel);
              } else if (fallback.models.length > 0) {
                setSelectedModelId(fallback.models[0].id);
              }
            }
          }
        } catch {
          setModels([]);
        }
      } finally {
        setLoadingModels(false);
        setFetchingModels(false);
      }
    }, 1000);

    return () => {
      if (modelFetchTimerRef.current) {
        clearTimeout(modelFetchTimerRef.current);
        modelFetchTimerRef.current = null;
      }
    };
  }, [llmApiKey, selectedProviderId, providerChanged, storedAgent]);

  /* -- Save handler -------------------------------------------------------- */

  const handleSave = useCallback(async () => {
    if (!storedAgent) return;

    setIsSaving(true);
    setError(null);
    setSuccessMsg(null);

    try {
      const result = await api.agents.add({
        agentId: storedAgent.agentId,
        name: storedAgent.name,
        displayName: storedAgent.displayName,
        color: storedAgent.color,
        provider: providers.find(p => p.id === selectedProviderId)?.isDirect === false
          ? 'openrouter'
          : selectedProviderId,
        providerApiKey: llmApiKey.trim(),
        model: selectedModelId,
        intervalMs: heartbeatMs,
      } as AgentConfig);

      if (!result.ok) {
        setError(result.error?.message || 'Failed to save settings');
        return;
      }

      setSuccessMsg('Saved');
      await loadAgentsStore();

      // Clear success message after a short delay
      setTimeout(() => {
        setSuccessMsg(null);
      }, 2000);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to save settings',
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    storedAgent,
    selectedProviderId,
    llmApiKey,
    selectedModelId,
    heartbeatMs,
    loadAgentsStore,
    providers,
  ]);

  /* -- Shared styles ------------------------------------------------------- */

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

  const selectChevron = `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2394A3B8' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E")`;

  /* -- Can save? ----------------------------------------------------------- */

  const canSave =
    selectedProviderId.length > 0 &&
    llmApiKey.trim().length > 0 &&
    selectedModelId.length > 0 &&
    !isSaving;

  /* =========================================================================
     Empty state — no agent selected
     ========================================================================= */

  if (!activeAgent) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="flex flex-col items-center gap-5 max-w-sm text-center">
          <div
            className="w-16 h-16 rounded-2xl flex items-center justify-center"
            style={{
              background: 'var(--crebral-bg-elevated)',
              border: '1px solid var(--crebral-border-subtle)',
            }}
          >
            <Brain
              size={28}
              style={{ color: 'var(--crebral-text-muted)', opacity: 0.5 }}
            />
          </div>
          <div>
            <h2
              className="text-lg font-semibold mb-2"
              style={{
                fontFamily: 'var(--crebral-font-heading)',
                color: 'var(--crebral-text-secondary)',
              }}
            >
              Select an agent from the sidebar
            </h2>
            <p
              className="text-sm"
              style={{
                fontFamily: 'var(--crebral-font-body)',
                color: 'var(--crebral-text-tertiary)',
                lineHeight: 1.6,
              }}
            >
              Choose an agent to configure its LLM provider, model, and
              synaptogenesis interval.
            </p>
          </div>
        </div>
      </div>
    );
  }

  /* =========================================================================
     Main view — agent selected
     ========================================================================= */

  const agentDisplayName =
    activeAgent.displayName || activeAgent.name || activeAgent.agentId;

  // Current config summary
  const currentProvider = providers.find(
    (p) => p.id === selectedProviderId,
  );

  return (
    <div className="h-full overflow-y-auto p-8">
      <div className="max-w-3xl mx-auto space-y-6">
        {/* -- Header Row --------------------------------------------------- */}
        <div className="flex items-center justify-between">
          <h1
            className="text-2xl font-bold"
            style={{
              fontFamily: 'var(--crebral-font-heading)',
              color: 'var(--crebral-text-primary)',
              letterSpacing: '-0.02em',
            }}
          >
            Brain{' '}
            <span
              style={{
                color: 'var(--crebral-text-tertiary)',
                fontWeight: 400,
              }}
            >
              &mdash; {agentDisplayName}
            </span>
          </h1>

          {/* Success badge */}
          {successMsg && (
            <div
              className="flex items-center gap-1.5 px-3 py-1"
              style={{
                borderRadius: '9999px',
                background: 'rgba(34, 197, 94, 0.12)',
                border: '1px solid var(--crebral-green)',
                animation: 'fadeIn 0.2s ease',
              }}
            >
              <CheckCircle
                size={13}
                style={{ color: 'var(--crebral-green)' }}
              />
              <span
                className="text-xs font-medium"
                style={{
                  color: 'var(--crebral-green)',
                  fontFamily: 'var(--crebral-font-body)',
                }}
              >
                {successMsg}
              </span>
            </div>
          )}
        </div>

        {/* -- Error banner ------------------------------------------------- */}
        {error && (
          <div
            className="flex items-center gap-2 p-3"
            style={{
              background: 'var(--crebral-red-soft)',
              border: '1px solid var(--crebral-red)',
              borderRadius: 'var(--crebral-radius-md)',
            }}
          >
            <AlertCircle
              size={14}
              style={{
                color: 'var(--crebral-red)',
                flexShrink: 0,
              }}
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

        {/* -- Loading state ------------------------------------------------ */}
        {isLoadingAgent ? (
          <div
            className="flex items-center justify-center py-24"
            style={{ color: 'var(--crebral-text-muted)' }}
          >
            <Loader2 size={24} className="animate-spin" />
          </div>
        ) : (
          <>
            {/* -- Content card --------------------------------------------- */}
            <div className="p-6 space-y-5" style={cardStyle}>
              {/* Current config summary */}
              {(selectedProviderId || selectedModelId) && (
                <div
                  className="flex items-center gap-3 px-4 py-3"
                  style={{
                    background: 'var(--crebral-bg-elevated)',
                    border: '1px solid var(--crebral-border-subtle)',
                    borderRadius: 'var(--crebral-radius-md)',
                  }}
                >
                  <Brain
                    size={16}
                    style={{
                      color: 'var(--crebral-teal-400)',
                      flexShrink: 0,
                    }}
                  />
                  <div className="flex items-center gap-2 flex-1 min-w-0">
                    {currentProvider && (
                      <span
                        className="text-xs font-semibold px-2 py-0.5"
                        style={{
                          borderRadius: '9999px',
                          background: 'var(--crebral-teal-900)',
                          color: 'var(--crebral-teal-400)',
                          fontFamily: 'var(--crebral-font-body)',
                          flexShrink: 0,
                        }}
                      >
                        {currentProvider.name}
                      </span>
                    )}
                    {selectedModelId && (
                      <span
                        className="text-xs truncate"
                        style={{
                          color: 'var(--crebral-text-secondary)',
                          fontFamily: 'var(--crebral-font-mono)',
                        }}
                      >
                        {selectedModelId}
                      </span>
                    )}
                  </div>
                </div>
              )}

              {/* Running note */}
              {isRunning && (
                <div
                  className="flex items-start gap-2 px-4 py-3"
                  style={{
                    background: 'var(--crebral-bg-elevated)',
                    border: '1px solid var(--crebral-border-subtle)',
                    borderRadius: 'var(--crebral-radius-md)',
                  }}
                >
                  <Info
                    size={14}
                    style={{
                      color: 'var(--crebral-teal-400)',
                      flexShrink: 0,
                      marginTop: '1px',
                    }}
                  />
                  <span
                    className="text-xs"
                    style={{
                      color: 'var(--crebral-text-secondary)',
                      fontFamily: 'var(--crebral-font-body)',
                      lineHeight: '1.5',
                    }}
                  >
                    This agent is currently running. Changes will take effect
                    on the next synaptogenesis cycle.
                  </span>
                </div>
              )}

              {/* 1. Provider dropdown */}
              <div>
                <label style={labelStyle}>Provider</label>
                <select
                  value={selectedProviderId}
                  onChange={(e) => handleProviderChange(e.target.value)}
                  style={{
                    ...inputStyle,
                    fontFamily: 'var(--crebral-font-body)',
                    fontSize: '0.8125rem',
                    cursor: 'pointer',
                    appearance: 'none',
                    backgroundImage: selectChevron,
                    backgroundRepeat: 'no-repeat',
                    backgroundPosition: 'right 12px center',
                    paddingRight: '36px',
                  }}
                >
                  <option value="">Select a provider...</option>
                  {providers.length > 0 && (
                    <>
                      {providers.filter((p) => p.isDirect).length > 0 && (
                        <optgroup label="Direct Providers">
                          {providers
                            .filter((p) => p.isDirect)
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </optgroup>
                      )}
                      {providers.filter((p) => !p.isDirect).length > 0 && (
                        <optgroup label="Via OpenRouter">
                          {providers
                            .filter((p) => !p.isDirect)
                            .map((p) => (
                              <option key={p.id} value={p.id}>
                                {p.name}
                              </option>
                            ))}
                        </optgroup>
                      )}
                    </>
                  )}
                </select>
              </div>

              {/* 2. API Key input -- appears after provider selected */}
              {selectedProviderId && (
                <div>
                  <label style={labelStyle}>
                    {providers.find((p) => p.id === selectedProviderId)?.isDirect === false
                      ? 'OpenRouter'
                      : (providers.find((p) => p.id === selectedProviderId)?.name ?? 'LLM')}{' '}
                    API Key
                  </label>
                  <input
                    type="password"
                    value={llmApiKey}
                    onChange={(e) => { setLlmApiKey(e.target.value); setTestResult(null); }}
                    name="llm-api-key-brain"
                    autoComplete="new-password"
                    placeholder={`Enter ${providers.find((p) => p.id === selectedProviderId)?.isDirect === false ? 'OpenRouter' : (providers.find((p) => p.id === selectedProviderId)?.name ?? 'provider')} API key...`}
                    style={inputStyle}
                  />
                  <div className="flex items-center justify-between mt-1.5">
                    <p
                      className="text-xs"
                      style={{
                        color: 'var(--crebral-text-muted)',
                        fontFamily: 'var(--crebral-font-body)',
                      }}
                    >
                      Stored locally on your machine.
                    </p>
                    <button
                      onClick={handleTestConnection}
                      disabled={isTesting || llmApiKey.trim().length < 4}
                      className="flex items-center gap-1 px-2.5 py-1 text-xs transition-all"
                      style={{
                        borderRadius: 'var(--crebral-radius-full)',
                        background: 'var(--crebral-bg-elevated)',
                        border: '1px solid var(--crebral-border-subtle)',
                        color: 'var(--crebral-text-secondary)',
                        fontFamily: 'var(--crebral-font-body)',
                        cursor: isTesting || llmApiKey.trim().length < 4 ? 'default' : 'pointer',
                        opacity: llmApiKey.trim().length < 4 ? 0.4 : 1,
                        flexShrink: 0,
                      }}
                    >
                      {isTesting ? (
                        <Loader2 size={11} className="animate-spin" />
                      ) : (
                        <Zap size={11} />
                      )}
                      {isTesting ? 'Testing...' : 'Test Connection'}
                    </button>
                  </div>
                  {testResult && (
                    <div
                      className="flex items-center gap-1.5 mt-2 px-3 py-2"
                      style={{
                        borderRadius: 'var(--crebral-radius-md)',
                        background: testResult.ok ? 'rgba(34, 197, 94, 0.08)' : 'var(--crebral-red-soft)',
                        border: `1px solid ${testResult.ok ? 'var(--crebral-green)' : 'var(--crebral-red)'}`,
                      }}
                    >
                      {testResult.ok ? (
                        <CheckCircle size={12} style={{ color: 'var(--crebral-green)', flexShrink: 0 }} />
                      ) : (
                        <XCircle size={12} style={{ color: 'var(--crebral-red)', flexShrink: 0 }} />
                      )}
                      <span
                        className="text-xs"
                        style={{
                          color: testResult.ok ? 'var(--crebral-green)' : 'var(--crebral-red)',
                          fontFamily: 'var(--crebral-font-body)',
                        }}
                      >
                        {testResult.message}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* 3. Fetching indicator */}
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
                      style={{
                        color: 'var(--crebral-teal-400)',
                        flexShrink: 0,
                      }}
                    />
                    <span
                      className="text-xs"
                      style={{
                        color: 'var(--crebral-text-secondary)',
                        fontFamily: 'var(--crebral-font-body)',
                      }}
                    >
                      Fetching available models...
                    </span>
                  </div>
                )}

              {/* 4. Model dropdown -- appears after models fetched */}
              {selectedProviderId && models.length > 0 && (
                <div>
                  <label style={labelStyle}>
                    Model
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
                      appearance: 'none',
                      backgroundImage: selectChevron,
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

              {/* 5. Synaptogenesis interval */}
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
                <p
                  className="text-xs mt-2"
                  style={{
                    color: 'var(--crebral-text-muted)',
                    fontFamily: 'var(--crebral-font-body)',
                  }}
                >
                  How often the agent syncs with the network to discover and
                  engage.
                </p>
              </div>
            </div>

            {/* -- Save button ---------------------------------------------- */}
            <div className="flex items-center justify-end">
              <button
                onClick={handleSave}
                disabled={!canSave}
                className="flex items-center gap-1.5 px-5 py-2 text-sm"
                style={{
                  borderRadius: '9999px',
                  background: canSave
                    ? 'var(--crebral-teal-600)'
                    : 'var(--crebral-bg-elevated)',
                  color: canSave
                    ? 'var(--crebral-text-primary)'
                    : 'var(--crebral-text-muted)',
                  border: 'none',
                  fontFamily: 'var(--crebral-font-body)',
                  fontWeight: 600,
                  cursor: canSave ? 'pointer' : 'default',
                  opacity: canSave ? 1 : 0.5,
                  transition: 'all var(--crebral-transition-fast)',
                }}
              >
                {isSaving ? (
                  <Loader2 size={14} className="animate-spin" />
                ) : (
                  <Save size={14} />
                )}
                Save Changes
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
