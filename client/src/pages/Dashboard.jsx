import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';
import {
  Video, Clock, CheckCircle2, Loader2, AlertCircle,
  Film, Download, Image, FolderPlus, Trash2,
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

  useEffect(() => {
    api.getProjects()
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const completed = projects.filter(p => p.status === 'complete').length;

  async function handleDelete(e, project) {
    e.preventDefault();
    if (!window.confirm(`Delete "${project.title}"? This cannot be undone.`)) return;
    try {
      await api.deleteProject(project.id);
      setProjects(prev => prev.filter(p => p.id !== project.id));
    } catch (err) {
      alert('Failed to delete: ' + err.message);
    }
  }

  return (
    <div className="p-10 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-4xl font-bold text-white">Projects</h1>
          <p className="text-gray-500 text-base mt-1">
            {loading ? 'Loading…' : `${projects.length} total · ${completed} completed`}
          </p>
        </div>
        <Link
          to="/projects/new"
          className="flex items-center gap-2 px-5 py-2.5 bg-indigo-700 hover:bg-indigo-600 text-white font-semibold text-sm rounded-xl transition-all"
        >
          <FolderPlus size={16} /> New Project
        </Link>
      </div>

      {/* Project list */}
      <div className="border-2 border-dashed border-gray-800 rounded-2xl p-4">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-20 text-gray-600">
            <Loader2 size={32} className="animate-spin mb-3" />
            <span className="text-sm">Loading projects…</span>
          </div>
        ) : projects.length === 0 ? (
          <div className="flex items-center justify-center py-20 text-gray-700 text-sm">
            No projects yet — create one above
          </div>
        ) : (
          <div className="space-y-3">
            {projects.map(p => {
              const timeTaken = formatDuration(p.started_at, p.completed_at);
              return (
                <div key={p.id} className="group flex items-center gap-5 p-5 rounded-xl bg-gray-900 border border-gray-800 hover:border-gray-700 hover:bg-gray-900/80 transition-all">
                  <Link to={`/projects/${p.id}`} className="flex items-center gap-5 flex-1 min-w-0">
                    <div className="w-12 h-12 rounded-xl bg-indigo-900/40 border border-indigo-800/40 flex items-center justify-center flex-shrink-0">
                      <Film size={20} className="text-indigo-400" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-3 flex-wrap">
                        <span className="text-base font-semibold text-gray-100 group-hover:text-white truncate">{p.title}</span>
                        <StatusBadge status={p.status} />
                      </div>
                      <div className="text-sm text-gray-500 mt-0.5 flex items-center gap-2 flex-wrap">
                        <span>{new Date(p.created_at).toLocaleDateString()}</span>
                        {p.image_count > 0 && (
                          <><span>·</span><span className="flex items-center gap-1"><Image size={12} />{p.image_count}</span></>
                        )}
                        {timeTaken && (
                          <><span>·</span><span className="flex items-center gap-1 text-green-600"><Clock size={12} />{timeTaken}</span></>
                        )}
                      </div>
                    </div>
                  </Link>
                  {p.status === 'complete' && (
                    <a
                      href={api.downloadUrl(p.id)}
                      onClick={e => e.stopPropagation()}
                      className="flex-shrink-0 flex items-center gap-2 text-sm text-green-400 hover:text-green-300 bg-green-900/20 hover:bg-green-900/40 border border-green-900/40 px-4 py-2 rounded-xl transition-all"
                      title="Download final video"
                    >
                      <Download size={15} /> Download
                    </a>
                  )}
                  <button
                    onClick={e => handleDelete(e, p)}
                    className="flex-shrink-0 p-2 text-gray-600 hover:text-red-400 hover:bg-red-900/20 rounded-xl transition-all opacity-0 group-hover:opacity-100"
                    title="Delete project"
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
