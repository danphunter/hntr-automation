import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../utils/api';
import {
  Users, Video, CheckCircle2, Film, Clock, Loader2,
  TrendingUp, Plus, AlertCircle, UserPlus, Trash2, X,
} from 'lucide-react';

const STATUS_COLORS = {
  draft: 'text-gray-400 bg-gray-800',
  in_progress: 'text-blue-400 bg-blue-900/30',
  rendering: 'text-yellow-400 bg-yellow-900/30',
  complete: 'text-green-400 bg-green-900/30',
  error: 'text-red-400 bg-red-900/30',
};

function StatCard({ label, value, icon: Icon, color }) {
  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-3">
        <span className="text-sm text-gray-500">{label}</span>
        <Icon size={18} className={color} />
      </div>
      <div className="text-3xl font-bold text-white">{value}</div>
    </div>
  );
}

function AddUserModal({ onClose, onAdded }) {
  const [form, setForm] = useState({ username: '', password: '', displayName: '', role: 'editor' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  async function handleSubmit(e) {
    e.preventDefault();
    setLoading(true); setError('');
    try {
      await api.createUser(form);
      onAdded();
      onClose();
    } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center p-4 z-50" onClick={onClose}>
      <div className="card p-6 w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold text-white">Add Editor</h3>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-300"><X size={18} /></button>
        </div>
        <form onSubmit={handleSubmit} className="space-y-3">
          <div>
            <label className="label">Display Name</label>
            <input className="input" value={form.displayName} onChange={e => setForm(f => ({ ...f, displayName: e.target.value }))} placeholder="Alice" required />
          </div>
          <div>
            <label className="label">Username</label>
            <input className="input" value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="alice" required />
          </div>
          <div>
            <label className="label">Password</label>
            <input type="password" className="input" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="••••••••" required />
          </div>
          <div>
            <label className="label">Role</label>
            <select className="input" value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
              <option value="editor">Editor</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <div className="flex gap-2 pt-1">
            <button type="button" onClick={onClose} className="btn-secondary flex-1">Cancel</button>
            <button type="submit" disabled={loading} className="btn-primary flex-1">{loading ? 'Adding…' : 'Add Editor'}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

export default function AdminDashboard() {
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddUser, setShowAddUser] = useState(false);

  async function loadData() {
    const [s, u] = await Promise.all([api.getAdminStats(), api.getAdminUsers()]);
    setStats(s); setUsers(u);
  }

  useEffect(() => { loadData().finally(() => setLoading(false)); }, []);

  async function handleDeleteUser(id, name) {
    if (!confirm(`Delete user "${name}"? Their projects will remain.`)) return;
    await api.deleteUser(id);
    setUsers(u => u.filter(x => x.id !== id));
  }

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <Loader2 size={32} className="animate-spin text-indigo-500" />
    </div>
  );

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-white">Admin Dashboard</h1>
        <p className="text-gray-500 text-sm mt-1">Overview of all production activity</p>
      </div>

      {/* Stats grid */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        <StatCard label="Total Projects" value={stats?.totalProjects || 0} icon={Video} color="text-indigo-400" />
        <StatCard label="This Week" value={stats?.thisWeek || 0} icon={TrendingUp} color="text-blue-400" />
        <StatCard label="This Month" value={stats?.thisMonth || 0} icon={Clock} color="text-purple-400" />
        <StatCard label="Completed" value={stats?.completed || 0} icon={CheckCircle2} color="text-green-400" />
      </div>

      <div className="grid lg:grid-cols-3 gap-6">
        {/* Editor stats */}
        <div className="lg:col-span-1">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-white flex items-center gap-2"><Users size={16} className="text-indigo-400" /> Editors</h2>
            <button onClick={() => setShowAddUser(true)} className="btn-primary text-xs flex items-center gap-1 px-3 py-1.5">
              <UserPlus size={13} /> Add
            </button>
          </div>
          <div className="space-y-2">
            {users.filter(u => u.role === 'editor').map(u => (
              <div key={u.id} className="card p-3 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-indigo-900/60 flex items-center justify-center text-sm font-bold text-indigo-300 flex-shrink-0">
                  {u.display_name[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-200">{u.display_name}</div>
                  <div className="text-xs text-gray-500">{u.project_count} project{u.project_count !== 1 ? 's' : ''}</div>
                </div>
                <button onClick={() => handleDeleteUser(u.id, u.display_name)} className="text-gray-700 hover:text-red-400 transition-colors">
                  <Trash2 size={14} />
                </button>
              </div>
            ))}
            {/* Per-editor stats */}
            {stats?.perEditor?.map(e => (
              <div key={e.username} className="card p-3 bg-gray-900/50">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-gray-400 font-medium">{e.display_name}</span>
                  <span className="text-indigo-400">{e.this_week} this week</span>
                </div>
                <div className="mt-1 flex gap-3 text-xs text-gray-600">
                  <span>{e.total} total</span>
                  <span>{e.completed} done</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Recent projects */}
        <div className="lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-white flex items-center gap-2"><Film size={16} className="text-indigo-400" /> Recent Projects</h2>
            <Link to="/projects/new" className="btn-primary text-xs flex items-center gap-1 px-3 py-1.5">
              <Plus size={13} /> New
            </Link>
          </div>
          <div className="space-y-2">
            {stats?.recentProjects?.map(p => (
              <Link
                key={p.id}
                to={`/projects/${p.id}`}
                className="card p-3 flex items-center gap-3 hover:border-gray-700 transition-colors block"
              >
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-200 truncate">{p.title}</div>
                  <div className="text-xs text-gray-500 mt-0.5">{p.editor_name} · {new Date(p.created_at).toLocaleDateString()}</div>
                </div>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${STATUS_COLORS[p.status] || STATUS_COLORS.draft}`}>
                  {p.status?.replace('_', ' ')}
                </span>
              </Link>
            ))}
            {!stats?.recentProjects?.length && (
              <div className="card p-8 text-center text-gray-600">
                <Film size={28} className="mx-auto mb-2 text-gray-800" />
                No projects yet
              </div>
            )}
          </div>
        </div>
      </div>

      {showAddUser && (
        <AddUserModal onClose={() => setShowAddUser(false)} onAdded={loadData} />
      )}
    </div>
  );
}
