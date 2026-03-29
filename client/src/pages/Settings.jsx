import React, { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { Save, Key, Loader2, CheckCircle2, Eye, EyeOff, Plus, Trash2, RefreshCw, AlertCircle, Zap, X } from 'lucide-react';

function Section({ title, children }) {
  return (
    <div className="card p-6 space-y-4">
      <h2 className="font-semibold text-white text-base border-b border-gray-800 pb-3">{title}</h2>
      {children}
    </div>
  );
}

function ApiKeyField({ label, keyName, values, onChange, hint }) {
  const [show, setShow] = useState(false);
  return (
    <div>
      <label className="label">{label}</label>
      <div className="relative">
        <input
          type={show ? 'text' : 'password'}
          className="input pr-10 font-mono text-sm"
          value={values[keyName] || ''}
          onChange={e => onChange(keyName, e.target.value)}
          placeholder={hint}
        />
        <button type="button" onClick={() => setShow(v => !v)} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-500 hover:text-gray-300">
          {show ? <EyeOff size={15} /> : <Eye size={15} />}
        </button>
      </div>
    </div>
  );
}

function useCooldownSeconds(rateLimitedUntil) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    if (!rateLimitedUntil) { setSecs(0); return; }
    function tick() {
      const diff = Math.max(0, Math.round((new Date(rateLimitedUntil + 'Z') - Date.now()) / 1000));
      setSecs(diff);
    }
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [rateLimitedUntil]);
  return secs;
}

function TokenCooldown({ rateLimitedUntil, onExpired }) {
  const secs = useCooldownSeconds(rateLimitedUntil);
  useEffect(() => { if (secs === 0 && rateLimitedUntil) onExpired?.(); }, [secs, rateLimitedUntil]);
  if (!rateLimitedUntil || secs === 0) return null;
  return <span className="text-xs text-orange-400">auto-reset in {secs}s</span>;
}

function GeminiKeysSection() {
  const [tokens, setTokens] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newLabel, setNewLabel] = useState('');
  const [newToken, setNewToken] = useState('');
  const [adding, setAdding] = useState(false);
  const [editToken, setEditToken] = useState({});

  async function load() {
    const data = await api.getWhiskTokens();
    setTokens(data);
    setLoading(false);
  }
  useEffect(() => { load(); }, []);

  async function handleAdd(e) {
    e.preventDefault();
    if (!newLabel.trim() || !newToken.trim()) return;
    setAdding(true);
    try {
      await api.addWhiskToken(newLabel.trim(), newToken.trim());
      setNewLabel(''); setNewToken('');
      load();
    } catch (err) { alert(err.message); }
    finally { setAdding(false); }
  }

  async function handleDelete(id) {
    if (!confirm('Remove this API key?')) return;
    await api.deleteWhiskToken(id);
    setTokens(t => t.filter(x => x.id !== id));
  }

  async function handleReset(id) {
    await api.resetWhiskToken(id);
    load();
  }

  async function handleUpdateToken(id) {
    const token = editToken[id];
    if (!token?.trim()) return;
    await api.updateWhiskToken(id, { token: token.trim(), status: 'active' });
    setEditToken(t => ({ ...t, [id]: '' }));
    load();
  }

  const statusBadge = (s) => ({
    active: 'text-green-400 bg-green-900/30',
    rate_limited: 'text-red-400 bg-red-900/30',
    disabled: 'text-gray-500 bg-gray-800',
  }[s] || 'text-gray-500 bg-gray-800');

  return (
    <Section title="Image Generation — Gemini API Keys">
      <p className="text-sm text-gray-500">
        Gemini API keys (AIza...) from Google AI Studio. The app tries each active key in order,
        rotating when one hits its rate limit. Add multiple keys from different Google accounts
        for higher throughput.
      </p>

      {loading ? (
        <Loader2 size={20} className="animate-spin text-gray-600" />
      ) : (
        <div className="space-y-2">
          {tokens.length === 0 && (
            <p className="text-sm text-gray-600 italic">No API keys added yet. Add your first Gemini API key below.</p>
          )}
          {tokens.map(t => (
            <div key={t.id} className="bg-gray-800/50 border border-gray-700 rounded-lg p-3">
              <div className="flex items-center gap-3 mb-2">
                <span className="text-sm font-medium text-gray-200 flex-1">{t.label}</span>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusBadge(t.status)}`}>{t.status}</span>
                <span className="text-xs text-gray-600">{t.usage_count} uses</span>
                {t.status === 'rate_limited' && (
                  <>
                    <TokenCooldown rateLimitedUntil={t.rate_limited_until} onExpired={load} />
                    <button onClick={() => handleReset(t.id)} className="text-xs text-yellow-400 hover:text-yellow-300 flex items-center gap-1">
                      <RefreshCw size={11} /> Reset
                    </button>
                  </>
                )}
                <button onClick={() => handleDelete(t.id)} className="text-gray-700 hover:text-red-400 transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
              {t.last_error && (
                <p className="text-xs text-red-500 mb-2 truncate">{t.last_error}</p>
              )}
              <div className="flex gap-2">
                <input
                  className="input text-xs font-mono flex-1"
                  placeholder="Paste replacement key (AIza…)"
                  value={editToken[t.id] || ''}
                  onChange={e => setEditToken(tok => ({ ...tok, [t.id]: e.target.value }))}
                />
                <button
                  onClick={() => handleUpdateToken(t.id)}
                  disabled={!editToken[t.id]?.trim()}
                  className="btn-primary text-xs px-3 flex items-center gap-1"
                >
                  <RefreshCw size={12} /> Update
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add new key */}
      <form onSubmit={handleAdd} className="border-t border-gray-800 pt-4 space-y-3">
        <h3 className="text-sm font-medium text-gray-400">Add New Key</h3>
        <div className="grid grid-cols-2 gap-2">
          <input className="input text-sm" placeholder='Label (e.g. "Account 2")' value={newLabel} onChange={e => setNewLabel(e.target.value)} />
          <input className="input text-sm font-mono" placeholder="AIza… Gemini API key" value={newToken} onChange={e => setNewToken(e.target.value)} />
        </div>
        <button type="submit" disabled={adding || !newLabel.trim() || !newToken.trim()} className="btn-primary flex items-center gap-2 text-sm">
          {adding ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />} Add Key
        </button>
      </form>
    </Section>
  );
}

export default function Settings() {
  const [values, setValues] = useState({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getSettings().then(s => { setValues(s); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  function onChange(key, val) { setValues(v => ({ ...v, [key]: val })); }

  async function handleSave(e) {
    e.preventDefault();
    setSaving(true);
    try {
      await api.saveSettings(values);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) { alert(err.message); }
    finally { setSaving(false); }
  }

  if (loading) return (
    <div className="flex items-center justify-center py-16">
      <Loader2 size={28} className="animate-spin text-indigo-500" />
    </div>
  );

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Settings</h1>
        <p className="text-gray-500 text-sm mt-1">API keys and configuration — admin only</p>
      </div>

      <form onSubmit={handleSave} className="space-y-6">
        <Section title="Transcription — AssemblyAI">
          <ApiKeyField label="AssemblyAI API Key" keyName="assemblyai_api_key" values={values} onChange={onChange} hint="Your AssemblyAI key" />
          <p className="text-xs text-gray-500">
            Used to analyze voiceover audio and break it into timed scenes automatically.{' '}
            Get your free API key at{' '}
            <a href="https://assemblyai.com" target="_blank" rel="noopener noreferrer" className="text-indigo-400 hover:text-indigo-300 underline">assemblyai.com</a>
          </p>
        </Section>

        <Section title="Prompt Generation — GPT-4o-mini">
          <ApiKeyField label="OpenAI API Key (optional)" keyName="openai_api_key" values={values} onChange={onChange} hint="sk-... (optional)" />
          <p className="text-xs text-gray-500">
            Used by GPT-4o-mini to auto-generate vivid image prompts from scene text. If omitted, basic prompts are generated without AI.
          </p>
        </Section>

        <button
          type="submit"
          disabled={saving}
          className="btn-primary flex items-center gap-2"
        >
          {saved
            ? <><CheckCircle2 size={16} /> Saved!</>
            : saving
            ? <><Loader2 size={16} className="animate-spin" /> Saving…</>
            : <><Save size={16} /> Save Settings</>}
        </button>
      </form>

      <div className="mt-6 space-y-6">
        <Section title="Veo Animation (image-to-video)">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-medium text-gray-200">Animate scenes with Veo 2.0</div>
              <div className="text-xs text-gray-500 mt-0.5">
                After each image is generated, Veo animates it into an 8-second video clip.
                The render step then stitches these clips together instead of applying the Ken Burns effect.
                Uses the same Gemini API keys. Each clip takes ~1–3 minutes to generate.
              </div>
            </div>
            <button
              type="button"
              onClick={() => {
                const next = !(values.veo_enabled === 'true' || values.veo_enabled === '1');
                onChange('veo_enabled', next ? 'true' : 'false');
                api.saveSettings({ veo_enabled: next ? 'true' : 'false' });
              }}
              className={`ml-4 flex-shrink-0 w-12 h-6 rounded-full border-2 transition-colors relative ${
                (values.veo_enabled === 'true' || values.veo_enabled === '1')
                  ? 'bg-indigo-600 border-indigo-500'
                  : 'bg-gray-700 border-gray-600'
              }`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white transition-transform ${
                (values.veo_enabled === 'true' || values.veo_enabled === '1') ? 'translate-x-6' : 'translate-x-0.5'
              }`} />
            </button>
          </div>
          <p className="text-xs text-gray-600">
            Note: Veo image-to-video is currently available to Google One AI Premium subscribers and select API tiers.
            If generation fails, the render will fall back to static images with the Ken Burns effect automatically.
          </p>
        </Section>

        <GeminiKeysSection />
      </div>
    </div>
  );
}
