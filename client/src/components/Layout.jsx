import React, { useState } from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  LayoutDashboard, FolderPlus, Settings, Palette, LogOut,
  Video, ChevronLeft, Menu, X, ShieldCheck,
} from 'lucide-react';

function NavItem({ to, icon: Icon, label, end = false }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${
          isActive
            ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-600/30'
            : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
        }`
      }
    >
      <Icon size={18} />
      {label}
    </NavLink>
  );
}

export default function Layout() {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(true);

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="min-h-screen flex bg-gray-950">
      {/* Sidebar */}
      <aside className={`${sidebarOpen ? 'w-60' : 'w-0 overflow-hidden'} flex-shrink-0 bg-gray-900 border-r border-gray-800 flex flex-col transition-all duration-200`}>
        {/* Logo */}
        <div className="p-5 border-b border-gray-800">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center flex-shrink-0">
              <Video size={16} className="text-white" />
            </div>
            <div>
              <div className="font-bold text-white text-sm leading-tight">HNTR Automation</div>
              <div className="text-xs text-gray-500">Video Production Suite</div>
            </div>
          </div>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {isAdmin && (
            <>
              <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider px-3 py-2">Admin</p>
              <NavItem to="/admin" icon={ShieldCheck} label="Admin Dashboard" end />
              <NavItem to="/styles" icon={Palette} label="Styles & Templates" />
              <NavItem to="/settings" icon={Settings} label="Settings" />
              <div className="border-t border-gray-800 my-2" />
              <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider px-3 py-2">Workspace</p>
            </>
          )}
          {!isAdmin && (
            <NavItem to="/dashboard" icon={LayoutDashboard} label="My Projects" />
          )}
          <NavItem to="/projects/new" icon={FolderPlus} label="New Project" />
        </nav>

        {/* User */}
        <div className="p-3 border-t border-gray-800">
          <div className="flex items-center gap-3 px-3 py-2 rounded-lg bg-gray-800/50">
            <div className="w-8 h-8 rounded-full bg-indigo-700 flex items-center justify-center text-sm font-bold text-white flex-shrink-0">
              {user?.displayName?.[0] || user?.username?.[0] || 'U'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-gray-200 truncate">{user?.displayName || user?.username}</div>
              <div className="text-xs text-gray-500 capitalize">{user?.role}</div>
            </div>
            <button onClick={handleLogout} title="Logout" className="text-gray-500 hover:text-gray-300 transition-colors">
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>

      {/* Main */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <header className="h-14 bg-gray-900/50 border-b border-gray-800 flex items-center px-4 gap-4 flex-shrink-0">
          <button onClick={() => setSidebarOpen(v => !v)} className="text-gray-500 hover:text-gray-300 transition-colors">
            {sidebarOpen ? <ChevronLeft size={20} /> : <Menu size={20} />}
          </button>
        </header>

        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
