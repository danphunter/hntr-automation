import React, { useState, useEffect } from 'react';
import { api } from '../utils/api';
import { Plus, Save, Trash2, X, Loader2, Layers } from 'lucide-react';

const STYLE_TYPES = [
  { value: 'all_image', label: 'All Image' },
  { value: 'all_video', label: 'All Video' },
  { value: 'alternating', label: 'Alternating' },
  { value: 'first_n_video', label: 'First N Video' },
];

function emptyConfig(styleType) {
  if (styleType === 'alternating') return { startWith: 'image' };
  if (styleType === 'first_n_video') return { n: 5 };
  return {};
}

function ConfigFields({ styleType, config, onChange }) {
  if (styleType === 'alternating') {
    return (
      <div>
        <label className="label">Start with</label>
        <select
          className="input"
          value={config.startWith || 'image'}
          onChange={e => onChange({ ...config, startWith: e.target.value })}
        >
          <option value="image">Image</option>
          <option value="video">Video</option>
        </select>
      </div>
    );
  }
  if (styleType === 'first_n_video') {
    return (
      <div>
        <label className="label">Number of video scenes</label>
        <input
          type="number"
          min={1}
          max={50}
          className="input"
          value={config.n ?? 5}
          onChange={e => onChange({ ...config, n: parseInt(e.target.value, 10) || 1 })}
        />
      </div>
    );
  }
  return null;
}

// ── Create Style Modal ────────────────────────────────────────────────────────
function CreateStyleModal({ onClose, onCreate }) {
  const [form, setForm] = useState({ name: '', style_type: 'all_image', style_config: {} });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function set(key, val) {
    setForm(f => {
      const next = { ...f, [key]: val };
      if (key === 'style_type') next.style_config = emptyConfig(val);
      return next;
    });
  }

  async function handleSubmit(e) {
    e.preventDefault();
    if (!form.name.trim()) { setError('Name is required'); return; }
    setSaving(true);
    setError('');
    try {
      const niche = await api.createNiche(form);
      onCreate(niche);
      onClose();
    } catch (err) {
      setError(err.message);
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-gray-900 border border-gray-700 rounded-2xl shadow-2xl w-full max-w-md mx-4">
        <div className="flex items-center justify-between p-5 border-b border-gray-800">
          <h2 className="text-lg font-semibold text-white">Create Style</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300 transition-colors">
            <X size={18} />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          {error && (
            <div className="flex items-center gap-2 text-red-400 text-sm bg-red-900/20 border border-red-800/40 rounded-lg p-3">
              <X size={14} /> {error}
            </div>
          )}

          <div>
            <label className="label">Name *</label>
            <input
              className="input"
              value={form.name}
              onChange={e => set('name', e.target.value)}
              placeholder="e.g. Documentary"
              autoFocus
            />
          </div>

          <div>
            <label className="label">Style type</label>
            <select
              className="input"
              value={form.style_type}
              onChange={e => set('style_type', e.target.value)}
            >
              {STYLE_TYPES.map(t => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>

          <ConfigFields
            styleType={form.style_type}
            config={form.style_config}
            onChange={cfg => set('style_config', cfg)}
          />

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn-primary flex items-center gap-2">
              {saving ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}
              Create Style
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Style Row (inline editing) ────────────────────────────────────────────────
function StyleRow({ niche, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({
    name: niche.name,
    style_type: niche.style_type,
    style_config: niche.style_config || {},
  });
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  function set(key, val) {
    setForm(f => {
      const next = { ...f, [key]: val };
      if (key === 'style_type') next.style_config = emptyConfig(val);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const updated = await api.updateNiche(niche.id, form);
      onUpdate(updated);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!window.confirm(`Delete style "${niche.name}"? Projects using it will lose their style assignment.`)) return;
    setDeleting(true);
    try {
      await api.deleteNiche(niche.id);
      onDelete(niche.id);
    } finally {
      setDeleting(false);
    }
  }

  const styleLabel = STYLE_TYPES.find(t => t.value === niche.style_type)?.label || niche.style_type;

  return (
    <div className="card p-5">
      {editing ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Name</label>
              <input
                className="input"
                value={form.name}
                onChange={e => set('name', e.target.value)}
              />
            </div>
            <div>
              <label className="label">Style type</label>
              <select
                className="input"
                value={form.style_type}
                onChange={e => set('style_type', e.target.value)}
              >
                {STYLE_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          <ConfigFields
            styleType={form.style_type}
            config={form.style_config}
            onChange={cfg => set('style_config', cfg)}
          />

          <div className="flex items-center gap-2 pt-1">
            <button onClick={handleSave} disabled={saving} className="btn-primary flex items-center gap-1.5 text-sm py-1.5 px-3">
              {saving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
              Save
            </button>
            <button onClick={() => setEditing(false)} className="btn-secondary text-sm py-1.5 px-3">
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-4">
          <div className="flex-1 min-w-0">
            <div className="font-medium text-gray-100">{niche.name}</div>
            <div className="flex items-center gap-2 mt-1 flex-wrap">
              <span className="text-xs bg-indigo-900/40 border border-indigo-800/40 text-indigo-300 rounded px-2 py-0.5">
                {styleLabel}
              </span>
              {niche.style_type === 'alternating' && (
                <span className="text-xs text-gray-500">
                  starts with {niche.style_config?.startWith || 'image'}
                </span>
              )}
              {niche.style_type === 'first_n_video' && (
                <span className="text-xs text-gray-500">
                  first {niche.style_config?.n ?? 5} scenes as video
                </span>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              onClick={() => setEditing(true)}
              className="text-xs text-gray-500 hover:text-gray-200 px-2.5 py-1.5 rounded hover:bg-gray-800 transition-colors"
            >
              Edit
            </button>
            <button
              onClick={handleDelete}
              disabled={deleting}
              className="text-gray-600 hover:text-red-400 p-1.5 rounded hover:bg-gray-800 transition-colors"
            >
              {deleting ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function Styles() {
  const [niches, setNiches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);

  useEffect(() => {
    api.getNiches()
      .then(setNiches)
      .finally(() => setLoading(false));
  }, []);

  function handleCreated(niche) {
    setNiches(prev => [...prev, niche].sort((a, b) => a.name.localeCompare(b.name)));
  }

  function handleUpdated(updated) {
    setNiches(prev => prev.map(n => n.id === updated.id ? updated : n));
  }

  function handleDeleted(id) {
    setNiches(prev => prev.filter(n => n.id !== id));
  }

  return (
    <div className="p-6 max-w-3xl mx-auto">
      {showCreate && (
        <CreateStyleModal
          onClose={() => setShowCreate(false)}
          onCreate={handleCreated}
        />
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Layers size={22} className="text-indigo-400" />
            Styles
          </h1>
          <p className="text-gray-500 text-sm mt-1">
            Define content styles and their media generation settings.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary flex items-center gap-2"
        >
          <Plus size={16} />
          Create Style
        </button>
      </div>

      {/* Style types legend */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-6">
        {STYLE_TYPES.map(t => (
          <div key={t.value} className="bg-gray-900 border border-gray-800 rounded-lg p-3 text-center">
            <div className="text-xs font-medium text-gray-300">{t.label}</div>
            <div className="text-xs text-gray-600 mt-0.5">
              {t.value === 'all_image' && 'Every scene → image'}
              {t.value === 'all_video' && 'Every scene → video'}
              {t.value === 'alternating' && 'Image / video alternating'}
              {t.value === 'first_n_video' && 'First N scenes → video'}
            </div>
          </div>
        ))}
      </div>

      {/* Style list */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="animate-spin text-indigo-400" />
        </div>
      ) : niches.length === 0 ? (
        <div className="text-center py-16 text-gray-600">
          <Layers size={36} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No styles yet.</p>
          <button
            onClick={() => setShowCreate(true)}
            className="mt-3 text-indigo-400 hover:text-indigo-300 text-sm underline underline-offset-2"
          >
            Create your first style
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {niches.map(niche => (
            <StyleRow
              key={niche.id}
              niche={niche}
              onUpdate={handleUpdated}
              onDelete={handleDeleted}
            />
          ))}
        </div>
      )}
    </div>
  );
}
