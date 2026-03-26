import React from 'react';
import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Settings, Palette, LogOut, ShieldCheck, LayoutDashboard } from 'lucide-react';

function FooterLink({ to, icon: Icon, label, end = false }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium transition-colors ${
          isActive
            ? 'bg-indigo-600/20 text-indigo-400 border border-indigo-600/30'
            : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800'
        }`
      }
    >
      <Icon size={14} />
      {label}
    </NavLink>
  );
}

export default function Layout() {
  const { user, logout, isAdmin } = useAuth();
  const navigate = useNavigate();

  function handleLogout() {
    logout();
    navigate('/login');
  }

  return (
    <div className="min-h-screen bg-gray-950 flex flex-col">
      <main className="flex-1 overflow-y-auto pb-16">
        <Outlet />
      </main>

      {/* Bottom-left toolbar */}
      <div className="fixed bottom-4 left-4 z-50">
        <div className="flex flex-col gap-0.5 bg-gray-900 border border-gray-800 rounded-xl p-2 shadow-lg min-w-[160px]">
          <FooterLink to="/" icon={LayoutDashboard} label="Dashboard" end />
          {isAdmin && (
            <>
              <FooterLink to="/admin" icon={ShieldCheck} label="Admin Dashboard" end />
              <FooterLink to="/styles" icon={Palette} label="Styles & Templates" />
            </>
          )}
          <FooterLink to="/settings" icon={Settings} label="Settings" />

          <div className="h-px bg-gray-800 my-1" />

          <div className="flex items-center gap-2 px-2.5 py-1.5">
            <div className="w-5 h-5 rounded-full bg-indigo-700 flex items-center justify-center text-xs font-bold text-white flex-shrink-0">
              {user?.displayName?.[0] || user?.username?.[0] || 'U'}
            </div>
            <div className="flex flex-col min-w-0">
              <span className="text-xs font-medium text-gray-300 truncate">{user?.displayName || user?.username}</span>
              <span className="text-xs text-gray-600 capitalize">{user?.role}</span>
            </div>
          </div>

          <div className="h-px bg-gray-800 my-1" />

          <button
            onClick={handleLogout}
            className="flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-xs font-medium text-gray-400 hover:text-gray-200 hover:bg-gray-800 transition-colors w-full"
          >
            <LogOut size={14} />
            Logout
          </button>
        </div>
      </div>
    </div>
  );
}
