import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';
import WhiskTokenBanner from '../components/WhiskTokenBanner';
import {
  Video, Clock, CheckCircle2, Loader2, AlertCircle,
  Film, Download, Image, FolderPlus, Plus,
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

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <WhiskTokenBanner />

      {/* Header */}
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="text-2xl font-bold text-white">Projects</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {loading ? 'Loading…' : `${projects.length} total · ${completed} completed`}
          </p>
        </div>
        <Link
          to="/projects/new"
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm rounded-lg shadow-lg shadow-indigo-900/30 transition-all hover:scale-105 active:scale-100"
        >
          <Plus size={16} />
          New Project
        </Link>
      </div>

      {/* Project list */}
      {loading ? (
        <div className="flex flex-col items-center justify-center py-24 text-gray-600">
          <Loader2 size={28} className="animate-spin mb-3" />
          <span className="text-sm">Loading projects…</span>
        </div>
      ) : projects.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 text-center">
          <div className="w-16 h-16 rounded-2xl bg-gray-900 border border-gray-800 flex items-center justify-center mb-4">
            <FolderPlus size={28} className="text-gray-600" />
          </div>
          <p className="text-gray-400 font-medium mb-1">No projects yet</p>
          <p className="text-gray-600 text-sm mb-6">Create your first video project to get started</p>
          <Link
            to="/projects/new"
            className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 hover:bg-indigo-500 text-white font-medium text-sm rounded-lg transition-all"
          >
            <Plus size={16} />
            New Project
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          {projects.map(p => {
            const timeTaken = formatDuration(p.started_at, p.completed_at);
            return (
              <div key={p.id} className="group flex items-center gap-4 p-4 rounded-xl bg-gray-900 border border-gray-800 hover:border-gray-700 hover:bg-gray-900/80 transition-all">
                <Link to={`/projects/${p.id}`} className="flex items-center gap-4 flex-1 min-w-0">
                  <div className="w-9 h-9 rounded-lg bg-indigo-900/40 border border-indigo-800/40 flex items-center justify-center flex-shrink-0">
                    <Film size={16} className="text-indigo-400" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-gray-100 group-hover:text-white truncate">{p.title}</span>
                      <StatusBadge status={p.status} />
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2 flex-wrap">
                      <span>{new Date(p.created_at).toLocaleDateString()}</span>
                      {p.style_id && (
                        <><span>·</span><span>{p.style_id.replace('style-', '')}</span></>
                      )}
                      {p.image_count > 0 && (
                        <><span>·</span><span className="flex items-center gap-1"><Image size={10} />{p.image_count}</span></>
                      )}
                      {timeTaken && (
                        <><span>·</span><span className="flex items-center gap-1 text-green-600"><Clock size={10} />{timeTaken}</span></>
                      )}
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
