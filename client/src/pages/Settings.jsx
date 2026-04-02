import React, { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { Save, Loader2, CheckCircle2, Eye, EyeOff } from 'lucide-react';

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

function NumberField({ label, keyName, values, onChange, hint }) {
  return (
    <div>
      <label className="label">{label}</label>
      <input
        type="number"
        className="input text-sm"
        value={values[keyName] || ''}
        onChange={e => onChange(keyName, e.target.value)}
        placeholder={hint}
      />
    </div>
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

        <Section title="Image Generation — useapi.net Google Flow">
          <ApiKeyField label="useapi.net API Token" keyName="useapi_token" values={values} onChange={onChange} hint="Your useapi.net API token" />
          <ApiKeyField label="CapSolver API Key" keyName="capsolver_api_key" values={values} onChange={onChange} hint="Your CapSolver API key (auto-registers with useapi.net on save)" />
          <p className="text-xs text-gray-500">
            useapi.net proxies Google Flow (Imagen 4) image generation. Get your token at useapi.net.
            Providing a CapSolver key auto-registers it with useapi.net on save.
          </p>
          <div className="grid grid-cols-3 gap-3">
            <NumberField label="Flow Image Batch Size" keyName="flow_image_batch_size" values={values} onChange={onChange} hint="20" />
            <NumberField label="Flow Image Wait Time (s)" keyName="flow_image_wait_time" values={values} onChange={onChange} hint="20" />
            <NumberField label="Flow Video Batch Size" keyName="flow_video_batch_size" values={values} onChange={onChange} hint="5" />
          </div>
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
    </div>
  );
}
