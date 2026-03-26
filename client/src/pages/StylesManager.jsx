import React, { useState, useEffect } from 'react';
import { api } from '../utils/api';
import {
  Plus, Edit2, Trash2, X, Save, Loader2,
  Image, Lock, Film, Camera,
} from 'lucide-react';

function ScenePatternEditor({ pattern, onChange }) {
  // pattern is an array like ["image", "video", "image"]
  function toggleSlot(i) {
    const next = [...pattern];
    next[i] = next[i] === 'image' ? 'video' : 'image';
    onChange(next);
  }
  function addSlot(type) { onChange([...pattern, type]); }
  function removeSlot(i) {
    const next = pattern.filter((_, idx) => idx !== i);
    onChange(next.length ? next : ['image']);
  }

  const label = pattern.length === 1
    ? (pattern[0] === 'image' ? 'All images (Ken Burns)' : 'All video clips')
    : `Repeating: ${pattern.join(' → ')}`;

  return (
    <div>
      <label className="label">Scene Pattern <span className="text-gray-600 font-normal">(repeats for all scenes)</span></label>
      <div className="flex flex-wrap gap-2 mb-2">
        {pattern.map((type, i) => (
          <div key={i} className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => toggleSlot(i)}
              className={`flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition-all ${
                type === 'image'
                  ? 'bg-indigo-900/40 border-indigo-700 text-indigo-300 hover:bg-indigo-900/60'
                  : 'bg-purple-900/40 border-purple-700 text-purple-300 hover:bg-purple-900/60'
              }`}
              title="Click to toggle image/video"
            >
              {type === 'image' ? <Camera size={11} /> : <Film size={11} />}
              {type}
            </button>
            {pattern.length > 1 && (
              <button type="button" onClick={() => removeSlot(i)} className="text-gray-700 hover:text-red-400">
                <X size={10} />
              </button>
            )}
          </div>
        ))}
        <button type="button" onClick={() => addSlot('image')} className="text-xs text-gray-600 hover:text-gray-400 border border-dashed border-gray-700 hover:border-gray-600 px-2 py-1 rounded-lg flex items-center gap-1">
          <Plus size={10} /> image
        </button>
        <button type="button" onClick={() => addSlot('video')} className="text-xs text-gray-600 hover:text-gray-400 border border-dashed border-gray-700 hover:border-gray-600 px-2 py-1 rounded-lg flex items-center gap-1">
          <Plus size={10} /> video
        </button>
      </div>
      <p className="text-xs text-gray-600">{label}</p>
    </div>
  );
}

function parsePattern(raw) {
  if (!raw) return ['image'];
  try { const p = JSON.parse(raw); return Array.isArray(p) && p.length ? p : ['image']; } catch { return ['image']; }
}

function StyleModal({ style, onClose, onSaved }) {
  const isNew = !style;
  const [form, setForm] = useState({
    name: style?.name || '',
    description: style?.description || '',
    prompt_prefix: style?.prompt_prefix || '',
    prompt_suffix: style?.prompt_suffix || '',
    color: style?.color || '#6366F1',
    icon: style?.icon || '🎬',
    scene_pattern: parsePattern(style?.scene_pattern),
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function set(k, v) { setForm(f => ({ ...f, [k]: v })); }

  async function handleSubmit(e) {
    e.preventDefault();
    setSaving(true); setError('');
    try {
      const payload = { ...form, scene_pattern: JSON.stringify(form.scene_pattern) };
      if (isNew) await api.createStyle(payload);
      else await api.updateStyle(style.id, payload);
      onSaved();
      onClose();
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="card p-6 w-full max-w-lg max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h3 className="font-semibold text-white">{isNew ? 'New Style Template' : `Edit: ${style.name}`}</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={18} /></button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-6 gap-3">
            <div className="col-span-1">
              <label className="label">Icon</label>
              <input className="input text-center text-xl" value={form.icon} onChange={e => set('icon', e.target.value)} maxLength={4} />
            </div>
            <div className="col-span-5">
              <label className="label">Style Name *</label>
              <input className="input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Epic Fantasy" required />
            </div>
          </div>

          <div>
            <label className="label">Description</label>
            <input className="input" value={form.description} onChange={e => set('description', e.target.value)} placeholder="Brief description of this style" />
          </div>

          <div>
            <label className="label">Accent Color</label>
            <div className="flex gap-2 items-center">
              <input type="color" className="w-10 h-10 rounded cursor-pointer bg-transparent border-0" value={form.color} onChange={e => set('color', e.target.value)} />
              <input className="input flex-1 font-mono text-sm" value={form.color} onChange={e => set('color', e.target.value)} />
            </div>
          </div>

          <div>
            <label className="label">Prompt Prefix</label>
            <textarea className="input text-sm font-mono resize-none" rows={3} value={form.prompt_prefix} onChange={e => set('prompt_prefix', e.target.value)} placeholder="Text added to the START of every image prompt (e.g. 'cinematic painterly biblical scene,')" />
            <p className="text-xs text-gray-600 mt-1">Added before the scene description</p>
          </div>

          <div>
            <label className="label">Prompt Suffix</label>
            <textarea className="input text-sm font-mono resize-none" rows={2} value={form.prompt_suffix} onChange={e => set('prompt_suffix', e.target.value)} placeholder="Text added to the END of every image prompt (e.g. ', 16:9 widescreen')" />
            <p className="text-xs text-gray-600 mt-1">Added after the scene description</p>
          </div>

          <div className="p-3 bg-gray-800/50 rounded-lg text-xs text-gray-500 font-mono">
            <p className="text-gray-400 font-medium mb-1">Preview prompt structure:</p>
            <p className="text-gray-600">{form.prompt_prefix || '[prefix]'} <span className="text-indigo-400">[scene description]</span> {form.prompt_suffix || '[suffix]'}</p>
          </div>

          <ScenePatternEditor
            pattern={form.scene_pattern}
            onChange={p => set('scene_pattern', p)}
          />

          {error && <p className="text-red-400 text-sm">{error}</p>}

          <div className="flex gap-2 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary flex-1 flex items-center justify-center gap-2">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />}
              {isNew ? 'Create Style' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ReferenceImages({ style, onUpdated }) {
  const [uploading, setUploading] = useState(false);
  const [desc, setDesc] = useState('');

  async function handleUpload(file) {
    setUploading(true);
    try {
      await api.uploadStyleRef(style.id, file, desc);
      setDesc('');
      onUpdated();
    } catch (err) { alert(err.message); }
    finally { setUploading(false); }
  }

  async function handleDelete(refId) {
    if (!confirm('Remove this reference image?')) return;
    await api.deleteStyleRef(refId);
    onUpdated();
  }

  return (
    <div className="mt-3 border-t border-gray-800 pt-3">
      <p className="text-xs font-semibold text-gray-500 uppercase tracking-wider mb-2 flex items-center gap-1.5">
        <Image size={12} /> Character Reference Images
      </p>

      <div className="flex gap-2 flex-wrap mb-2">
        {(style.references || []).map(ref => (
          <div key={ref.id} className="relative group">
            <img
              src={ref.url}
              alt={ref.description || ref.original_name}
              className="w-16 h-16 object-cover rounded-lg border border-gray-700"
              title={ref.description || ref.original_name}
            />
            <button
              onClick={() => handleDelete(ref.id)}
              className="absolute -top-1.5 -right-1.5 w-5 h-5 bg-red-900 border border-red-700 rounded-full text-red-300 hover:text-white opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center"
            >
              <X size={10} />
            </button>
          </div>
        ))}

        <label className={`w-16 h-16 border-2 border-dashed border-gray-700 rounded-lg flex items-center justify-center cursor-pointer hover:border-gray-600 hover:bg-gray-800/30 transition-all ${uploading ? 'opacity-50 pointer-events-none' : ''}`}>
          {uploading ? <Loader2 size={16} className="animate-spin text-gray-600" /> : <Plus size={18} className="text-gray-600" />}
          <input type="file" accept="image/*" className="hidden" onChange={e => e.target.files[0] && handleUpload(e.target.files[0])} />
        </label>
      </div>

      <input className="input text-xs" placeholder="Description for next upload (optional)" value={desc} onChange={e => setDesc(e.target.value)} />
      <p className="text-xs text-gray-700 mt-1">These images are passed to the image generator to maintain character consistency across all scenes in this style.</p>
    </div>
  );
}

export default function StylesManager() {
  const [styles, setStyles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingStyle, setEditingStyle] = useState(null);
  const [showNew, setShowNew] = useState(false);

  async function load() {
    const data = await api.getStyles();
    setStyles(data);
    setLoading(false);
  }

  useEffect(() => { load(); }, []);

  async function handleDelete(style) {
    if (style.is_default) return;
    if (!confirm(`Delete style "${style.name}"?`)) return;
    await api.deleteStyle(style.id);
    setStyles(s => s.filter(x => x.id !== style.id));
  }

  if (loading) return (
    <div className="flex items-center justify-center py-16">
      <Loader2 size={28} className="animate-spin text-indigo-500" />
    </div>
  );

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-white">Styles & Templates</h1>
          <p className="text-gray-500 text-sm mt-1">Manage video styles, prompt templates, and character reference images</p>
        </div>
        <button onClick={() => setShowNew(true)} className="btn-primary flex items-center gap-2">
          <Plus size={16} /> New Style
        </button>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {styles.map(s => (
          <div key={s.id} className="card p-4" style={{ borderLeft: `3px solid ${s.color}` }}>
            <div className="flex items-start gap-3">
              <div className="text-2xl">{s.icon}</div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <h3 className="font-semibold text-gray-100">{s.name}</h3>
                  {s.is_default && (
                    <span className="text-xs px-1.5 py-0.5 bg-gray-800 text-gray-500 rounded flex items-center gap-1">
                      <Lock size={9} /> default
                    </span>
                  )}
                </div>
                <p className="text-sm text-gray-500 mt-0.5">{s.description}</p>
                {s.scene_pattern && (() => {
                  const p = parsePattern(s.scene_pattern);
                  const summary = p.length === 1
                    ? (p[0] === 'image' ? 'All images' : 'All video')
                    : p.join(' → ') + ' (repeating)';
                  return (
                    <p className="text-xs text-gray-600 mt-1 flex items-center gap-1">
                      <Film size={10} /> {summary}
                    </p>
                  );
                })()}
                <div className="flex items-center gap-2 mt-2">
                  <button
                    onClick={() => setEditingStyle(s)}
                    className="text-xs text-gray-500 hover:text-gray-300 flex items-center gap-1 transition-colors"
                  >
                    <Edit2 size={12} /> Edit
                  </button>
                  {!s.is_default && (
                    <button
                      onClick={() => handleDelete(s)}
                      className="text-xs text-gray-600 hover:text-red-400 flex items-center gap-1 transition-colors"
                    >
                      <Trash2 size={12} /> Delete
                    </button>
                  )}
                  <span className="text-xs text-gray-700 ml-auto">
                    {(s.references || []).length} ref{(s.references || []).length !== 1 ? 's' : ''}
                  </span>
                </div>
              </div>
            </div>

            <ReferenceImages style={s} onUpdated={load} />
          </div>
        ))}
      </div>

      {showNew && <StyleModal onClose={() => setShowNew(false)} onSaved={load} />}
      {editingStyle && <StyleModal style={editingStyle} onClose={() => setEditingStyle(null)} onSaved={load} />}
    </div>
  );
}
