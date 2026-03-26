import React, { useState, useEffect, useCallback } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';
import WhiskTokenBanner from '../components/WhiskTokenBanner';
import {
  Plus, Video, Clock, CheckCircle2, Loader2, AlertCircle,
  Film, Search, Download, Image, ListVideo, X,
} from 'lucide-react';

function formatDuration(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const ms = new Date(endIso) - new Date(startIso);
  if (ms <= 0) return null;
  const mins = Math.floor(ms / 60000);
  const hrs = Math.floor(mins / 60);
  if (hrs > 0) return `${hrs}h ${mins % 60}m`;
  if (mins > 0) return `${mins}m`;
  return `${Math.floor(ms / 1000)}s`;
}

const STATUS_META = {
  draft: { label: 'Draft', color: 'text-gray-400 bg-gray-800', icon: Clock },
  in_progress: { label: 'In Progress', color: 'text-blue-400 bg-blue-900/30', icon: Loader2 },
  rendering: { label: 'Rendering', color: 'text-yellow-400 bg-yellow-900/30', icon: Film },
  complete: { label: 'Complete', color: 'text-green-400 bg-green-900/30', icon: CheckCircle2 },
  error: { label: 'Error', color: 'text-red-400 bg-red-900/30', icon: AlertCircle },
};

const BATCH_PROJECT_STATUS = {
  waiting: { label: 'Waiting', color: 'text-gray-400' },
  rendering: { label: 'Rendering…', color: 'text-yellow-400' },
  done: { label: 'Done', color: 'text-green-400' },
  failed: { label: 'Failed', color: 'text-red-400' },
};

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.draft;
  const Icon = meta.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-1 rounded-full ${meta.color}`}>
      <Icon size={11} className={status === 'rendering' || status === 'in_progress' ? 'animate-spin' : ''} />
      {meta.label}
    </span>
  );
}

export default function Dashboard() {
  const { user } = useAuth();
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [batchId, setBatchId] = useState(null);
  const [batchStatus, setBatchStatus] = useState(null);

  const refreshProjects = useCallback(() => {
    api.getProjects().then(setProjects).catch(console.error);
  }, []);

  useEffect(() => {
    api.getProjects()
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  // Poll batch status
  useEffect(() => {
    if (!batchId) return;
    const interval = setInterval(async () => {
      try {
        const status = await api.getBatchStatus(batchId);
        setBatchStatus(status);
        if (status.status === 'complete') {
          clearInterval(interval);
          refreshProjects();
        }
      } catch {}
    }, 2000);
    return () => clearInterval(interval);
  }, [batchId, refreshProjects]);

  const thisWeek = projects.filter(p => {
    const d = new Date(p.created_at);
    return Date.now() - d.getTime() < 7 * 24 * 60 * 60 * 1000;
  });
  const completed = projects.filter(p => p.status === 'complete');

  const filtered = projects.filter(p =>
    p.title.toLowerCase().includes(search.toLowerCase()) ||
    (p.notes || '').toLowerCase().includes(search.toLowerCase())
  );

  function isBatchEligible(p) {
    return p.status === 'draft' && p.image_count > 0;
  }

  function toggleSelect(id) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function startBatch() {
    const ids = [...selected];
    try {
      const { batchId: id } = await api.startBatchRender(ids);
      setBatchId(id);
      setBatchStatus(null);
      setSelected(new Set());
    } catch (err) {
      alert('Failed to start batch: ' + err.message);
    }
  }

  function dismissBatch() {
    setBatchId(null);
    setBatchStatus(null);
  }

  const batchRunning = batchStatus && batchStatus.status === 'processing';

  return (
    <div className="p-6 max-w-5xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">My Projects</h1>
        <p className="text-gray-500 text-sm mt-1">Welcome back, {user?.displayName || user?.username}</p>
      </div>

      <WhiskTokenBanner />

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        {[
          { label: 'Total Projects', value: projects.length, icon: Video, color: 'text-indigo-400' },
          { label: 'This Week', value: thisWeek.length, icon: Clock, color: 'text-blue-400' },
          { label: 'Completed', value: completed.length, icon: CheckCircle2, color: 'text-green-400' },
        ].map(({ label, value, icon: Icon, color }) => (
          <div key={label} className="card p-4">
            <div className="flex items-center gap-3">
              <div className={`${color} opacity-80`}><Icon size={20} /></div>
              <div>
                <div className="text-2xl font-bold text-white">{value}</div>
                <div className="text-xs text-gray-500">{label}</div>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Batch status panel */}
      {batchStatus && (
        <div className="card p-4 mb-4 border-yellow-800/40">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-2">
                {batchRunning
                  ? <Loader2 size={15} className="animate-spin text-yellow-400" />
                  : <CheckCircle2 size={15} className="text-green-400" />}
                <span className="text-sm font-medium text-white">
                  {batchRunning
                    ? `Rendering ${batchStatus.currentIndex}/${batchStatus.total}${batchStatus.currentProjectTitle ? ` — ${batchStatus.currentProjectTitle}` : ''}`
                    : `Batch complete — ${batchStatus.completed} done, ${batchStatus.failed} failed`}
                </span>
              </div>
              <div className="flex flex-wrap gap-2">
                {batchStatus.projects.map((p, i) => {
                  const proj = projects.find(x => x.id === p.id);
                  const meta = BATCH_PROJECT_STATUS[p.status] || BATCH_PROJECT_STATUS.waiting;
                  return (
                    <span key={p.id} className={`text-xs ${meta.color} bg-gray-800 px-2 py-0.5 rounded`}>
                      {proj?.title || `Project ${p.id}`}: {meta.label}
                      {p.error && <span className="text-red-400 ml-1">({p.error})</span>}
                    </span>
                  );
                })}
              </div>
            </div>
            {!batchRunning && (
              <button onClick={dismissBatch} className="text-gray-500 hover:text-gray-300 flex-shrink-0">
                <X size={16} />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Header row */}
      <div className="flex items-center gap-3 mb-4">
        <div className="relative flex-1">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-500" />
          <input
            className="input pl-9 text-sm"
            placeholder="Search projects…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
        {selected.size > 0 && (
          <button
            onClick={startBatch}
            className="btn-primary flex items-center gap-2 whitespace-nowrap bg-yellow-600 hover:bg-yellow-500"
          >
            <ListVideo size={16} /> Batch Render ({selected.size})
          </button>
        )}
        <Link to="/projects/new" className="btn-primary flex items-center gap-2 whitespace-nowrap">
          <Plus size={16} /> New Project
        </Link>
      </div>

      {/* Project list */}
      {loading ? (
        <div className="text-center py-16 text-gray-600">
          <Loader2 size={32} className="animate-spin mx-auto mb-3" />
          Loading projects…
        </div>
      ) : filtered.length === 0 ? (
        <div className="card p-12 text-center">
          <Video size={40} className="text-gray-700 mx-auto mb-4" />
          <p className="text-gray-400 font-medium">
            {search ? 'No projects match your search' : 'No projects yet'}
          </p>
          {!search && (
            <Link to="/projects/new" className="btn-primary inline-flex items-center gap-2 mt-4">
              <Plus size={16} /> Create your first project
            </Link>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map(p => {
            const timeTaken = formatDuration(p.started_at, p.completed_at);
            const eligible = isBatchEligible(p);
            const isSelected = selected.has(p.id);
            const batchProjectStatus = batchStatus?.projects.find(x => x.id === p.id);
            return (
              <div
                key={p.id}
                className={`card p-4 flex items-center gap-3 hover:border-gray-700 hover:bg-gray-900/80 transition-all group ${isSelected ? 'border-yellow-700/60 bg-yellow-900/10' : ''}`}
              >
                {/* Checkbox for batch-eligible projects */}
                {eligible ? (
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={() => toggleSelect(p.id)}
                    onClick={e => e.stopPropagation()}
                    className="w-4 h-4 flex-shrink-0 accent-yellow-500 cursor-pointer"
                  />
                ) : (
                  <div className="w-4 flex-shrink-0" />
                )}

                <Link to={`/projects/${p.id}`} className="flex items-center gap-4 flex-1 min-w-0">
                  <div className="w-10 h-10 rounded-lg bg-indigo-900/40 border border-indigo-800/40 flex items-center justify-center flex-shrink-0">
                    <Film size={18} className="text-indigo-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-100 group-hover:text-white truncate">{p.title}</span>
                      <StatusBadge status={p.status} />
                      {batchProjectStatus && (
                        <span className={`text-xs px-1.5 py-0.5 rounded ${BATCH_PROJECT_STATUS[batchProjectStatus.status]?.color || 'text-gray-400'} bg-gray-800`}>
                          {BATCH_PROJECT_STATUS[batchProjectStatus.status]?.label}
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2 flex-wrap">
                      <span>{p.style_id ? p.style_id.replace('style-', '') : 'No style'}</span>
                      <span>·</span>
                      <span>{new Date(p.created_at).toLocaleDateString()}</span>
                      {p.image_count > 0 && (
                        <><span>·</span><span className="flex items-center gap-1"><Image size={11} />{p.image_count} image{p.image_count !== 1 ? 's' : ''}</span></>
                      )}
                      {timeTaken && (
                        <><span>·</span><span className="flex items-center gap-1 text-green-600"><Clock size={11} />{timeTaken}</span></>
                      )}
                      {p.notes && <><span>·</span><span className="truncate max-w-32">{p.notes}</span></>}
                    </div>
                  </div>
                </Link>
                {p.status === 'complete' && (
                  <a
                    href={api.downloadUrl(p.id)}
                    onClick={e => e.stopPropagation()}
                    className="flex-shrink-0 flex items-center gap-1.5 text-xs text-green-400 hover:text-green-300 bg-green-900/20 hover:bg-green-900/40 border border-green-900/40 px-3 py-1.5 rounded-lg transition-all"
                    title="Download final video"
                  >
                    <Download size={13} /> Download
                  </a>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
