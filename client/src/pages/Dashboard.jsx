import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';
import WhiskTokenBanner from '../components/WhiskTokenBanner';
import {
  Plus, Video, Clock, CheckCircle2, Loader2, AlertCircle,
  Film, Search, SortDesc,
} from 'lucide-react';

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
  const [search, setSearch] = useState('');

  useEffect(() => {
    api.getProjects()
      .then(setProjects)
      .catch(console.error)
      .finally(() => setLoading(false));
  }, []);

  const thisWeek = projects.filter(p => {
    const d = new Date(p.created_at);
    return Date.now() - d.getTime() < 7 * 24 * 60 * 60 * 1000;
  });
  const completed = projects.filter(p => p.status === 'complete');

  const filtered = projects.filter(p =>
    p.title.toLowerCase().includes(search.toLowerCase()) ||
    (p.notes || '').toLowerCase().includes(search.toLowerCase())
  );

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
          {filtered.map(p => (
            <Link
              key={p.id}
              to={`/projects/${p.id}`}
              className="card p-4 flex items-center gap-4 hover:border-gray-700 hover:bg-gray-900/80 transition-all group block"
            >
              <div className="w-10 h-10 rounded-lg bg-indigo-900/40 border border-indigo-800/40 flex items-center justify-center flex-shrink-0">
                <Film size={18} className="text-indigo-400" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-gray-100 group-hover:text-white truncate">{p.title}</span>
                  <StatusBadge status={p.status} />
                </div>
                <div className="text-xs text-gray-500 mt-0.5 flex items-center gap-2">
                  <span>{p.style_id ? p.style_id.replace('style-', '') : 'No style'}</span>
                  <span>·</span>
                  <span>{new Date(p.created_at).toLocaleDateString()}</span>
                  {p.notes && <><span>·</span><span className="truncate">{p.notes}</span></>}
                </div>
              </div>
              {p.status === 'complete' && (
                <span className="text-xs text-green-400 flex-shrink-0">↓ Ready to download</span>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
