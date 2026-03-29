import React, { useState, useEffect } from 'react';
import { AlertTriangle, RefreshCw, CheckCircle2, X, Key, ChevronDown } from 'lucide-react';
import { api } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';

export default function WhiskTokenBanner() {
  const { isAdmin } = useAuth();
  const [tokens, setTokens] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [updates, setUpdates] = useState({});
  const [saving, setSaving] = useState({});
  const [saved, setSaved] = useState({});
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (isAdmin) api.getWhiskTokens().then(setTokens).catch(() => {});
  }, [isAdmin]);

  const expiredTokens = tokens.filter(t => t.status === 'rate_limited');
  const activeCount = tokens.filter(t => t.status === 'active').length;
  const allExpired = tokens.length > 0 && activeCount === 0;

  if (dismissed || tokens.length === 0 || expiredTokens.length === 0) return null;

  async function handleRefresh(e, tokenId) {
    e.preventDefault();
    const newToken = updates[tokenId];
    if (!newToken?.trim()) return;
    setSaving(s => ({ ...s, [tokenId]: true }));
    try {
      await api.updateWhiskToken(tokenId, { token: newToken.trim(), status: 'active' });
      const updated = await api.getWhiskTokens();
      setTokens(updated);
      setUpdates(u => ({ ...u, [tokenId]: '' }));
      setSaved(s => ({ ...s, [tokenId]: true }));
      setTimeout(() => setSaved(s => ({ ...s, [tokenId]: false })), 3000);
    } catch (err) {
      alert('Failed: ' + err.message);
    } finally {
      setSaving(s => ({ ...s, [tokenId]: false }));
    }
  }

  return (
    <div className={`border rounded-xl p-4 mb-6 ${allExpired ? 'bg-red-950/40 border-red-800/60' : 'bg-yellow-950/40 border-yellow-800/60'}`}>
      <div className="flex items-start gap-3">
        <AlertTriangle size={18} className={`flex-shrink-0 mt-0.5 ${allExpired ? 'text-red-400' : 'text-yellow-400'}`} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <p className={`font-semibold text-sm ${allExpired ? 'text-red-300' : 'text-yellow-300'}`}>
                {allExpired ? 'All Bearer tokens rate-limited — image gen down' : `${expiredTokens.length} Bearer token${expiredTokens.length > 1 ? 's' : ''} rate-limited`}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                {isAdmin
                  ? 'Paste fresh Bearer tokens below. Capture them from Flow\'s network tab (ya29.xxx) while logged into a Google account.'
                  : 'Ask Dan to refresh the Bearer tokens in Settings.'}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {isAdmin && (
                <button
                  onClick={() => setExpanded(v => !v)}
                  className="text-xs text-gray-300 hover:text-white bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg px-3 py-1.5 flex items-center gap-1.5 transition-colors"
                >
                  <Key size={13} /> {expanded ? 'Hide' : 'Refresh Keys'}
                  <ChevronDown size={13} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
                </button>
              )}
              <button onClick={() => setDismissed(true)} className="text-gray-600 hover:text-gray-400 p-1">
                <X size={15} />
              </button>
            </div>
          </div>

          {isAdmin && expanded && (
            <div className="mt-4 space-y-3">
              {expiredTokens.map(t => (
                <form key={t.id} onSubmit={e => handleRefresh(e, t.id)} className="flex gap-2 items-center">
                  <div className="flex-shrink-0 w-24 text-xs text-gray-400 font-medium truncate" title={t.label}>{t.label}</div>
                  <input
                    className="input text-xs font-mono flex-1"
                    placeholder="ya29.xxx — paste fresh Bearer token"
                    value={updates[t.id] || ''}
                    onChange={e => setUpdates(u => ({ ...u, [t.id]: e.target.value }))}
                  />
                  <button
                    type="submit"
                    disabled={saving[t.id] || !updates[t.id]?.trim()}
                    className="btn-primary text-xs flex items-center gap-1 whitespace-nowrap px-3 py-2"
                  >
                    {saved[t.id]
                      ? <><CheckCircle2 size={13} /> Done</>
                      : saving[t.id]
                      ? <><RefreshCw size={13} className="animate-spin" /> …</>
                      : <><RefreshCw size={13} /> Update</>}
                  </button>
                </form>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
