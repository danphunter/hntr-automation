const BASE = '/api';

function getToken() {
  return localStorage.getItem('yt_token');
}

async function request(method, path, body, isFormData = false) {
  const token = getToken();
  const headers = {};
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (!isFormData) headers['Content-Type'] = 'application/json';

  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: isFormData ? body : body ? JSON.stringify(body) : undefined,
  });

  if (res.status === 401) {
    localStorage.removeItem('yt_token');
    localStorage.removeItem('yt_user');
    window.location.href = '/login';
    throw new Error('Unauthorized');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

export const api = {
  // Auth
  login: (u, p) => request('POST', '/auth/login', { username: u, password: p }),
  me: () => request('GET', '/auth/me'),
  changePassword: (cur, next) => request('POST', '/auth/change-password', { currentPassword: cur, newPassword: next }),

  // Projects
  getProjects: () => request('GET', '/projects'),
  getProject: (id) => request('GET', `/projects/${id}`),
  createProject: (data) => request('POST', '/projects', data),
  updateProject: (id, data) => request('PUT', `/projects/${id}`, data),
  deleteProject: (id) => request('DELETE', `/projects/${id}`),
  uploadAudio: (id, file) => {
    const fd = new FormData();
    fd.append('audio', file);
    return request('POST', `/projects/${id}/upload-audio`, fd, true);
  },
  transcribeAudio: (id, overrideScript = true) => request('POST', `/projects/${id}/transcribe`, { overrideScript }),
  getTranscribeStatus: (id) => request('GET', `/projects/${id}/transcribe-status`),
  saveScenes: (id, scenes) => request('POST', `/projects/${id}/scenes`, { scenes }),
  updateScene: (projectId, sceneId, data) => request('PUT', `/projects/${projectId}/scenes/${sceneId}`, data),

  // Styles
  getStyles: () => request('GET', '/styles'),
  getStyle: (id) => request('GET', `/styles/${id}`),
  createStyle: (data) => request('POST', '/styles', data),
  updateStyle: (id, data) => request('PUT', `/styles/${id}`, data),
  deleteStyle: (id) => request('DELETE', `/styles/${id}`),
  uploadStyleRef: (styleId, file, description, referenceType = 'subject') => {
    const fd = new FormData();
    fd.append('image', file);
    fd.append('description', description || '');
    fd.append('reference_type', referenceType);
    return request('POST', `/styles/${styleId}/references`, fd, true);
  },
  deleteStyleRef: (refId) => request('DELETE', `/styles/references/${refId}`),

  // Image generation
  generateImage: (sceneId) => request('POST', `/generate/image/${sceneId}`),
  generatePrompts: (projectId) => request('POST', `/generate/prompts/${projectId}`),

  // Flow tokens (stored in whisk_tokens table, same API paths)
  getWhiskTokens: () => request('GET', '/generate/whisk-tokens'),
  addWhiskToken: (label, token, projectId) => request('POST', '/generate/whisk-tokens', { label, token, ...(projectId ? { project_id: projectId } : {}) }),
  updateWhiskToken: (id, data) => request('PUT', `/generate/whisk-tokens/${id}`, data),
  deleteWhiskToken: (id) => request('DELETE', `/generate/whisk-tokens/${id}`),
  resetWhiskToken: (id) => request('POST', `/generate/whisk-tokens/${id}/reset`),
  // Render
  startRender: (projectId, usePlaceholders = false) =>
    request('POST', `/render/${projectId}`, { usePlaceholders }),
  getRenderStatus: (jobId) => request('GET', `/render/status/${jobId}`),
  downloadUrl: (projectId) => `${BASE}/render/download/${projectId}?token=${getToken()}`,

  // Settings
  getSettings: () => request('GET', '/settings'),
  saveSettings: (data) => request('PUT', '/settings', data),
  hasKeys: () => request('GET', '/settings/has-keys'),

  // Admin
  getAdminStats: () => request('GET', '/admin/stats'),
  getAdminUsers: () => request('GET', '/admin/users'),
  createUser: (data) => request('POST', '/admin/users', data),
  deleteUser: (id) => request('DELETE', `/admin/users/${id}`),
  assignProject: (projectId, editorId) => request('POST', '/admin/assign', { projectId, editorId }),
};
