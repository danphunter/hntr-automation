import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';
import { analyzeScript, recalcTimings, formatTime } from '../utils/scriptAnalyzer';
import {
  ChevronLeft, Mic, Scissors, Image, Film, Download, Loader2,
  RefreshCw, Upload, Play, Clock, CheckCircle2, AlertCircle,
  Wand2, Save, Trash2, Plus, MoreVertical, ExternalLink, X, Zap,
} from 'lucide-react';

const TABS = [
  { id: 'scenes', label: 'Scenes & Images', icon: Scissors },
  { id: 'audio', label: 'Audio', icon: Mic },
  { id: 'render', label: 'Export Video', icon: Film },
];

function SceneCard({ scene, index, onUpdate, onRegenerate, onDelete, generatingId }) {
  const [editingText, setEditingText] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState(false);
  const [localText, setLocalText] = useState(scene.text);
  const [localPrompt, setLocalPrompt] = useState(scene.image_prompt || '');
  const [localDuration, setLocalDuration] = useState(scene.duration);
  const isGenerating = generatingId === scene.id;

  function saveText() {
    setEditingText(false);
    if (localText !== scene.text || localDuration !== scene.duration) {
      onUpdate(scene.id, { text: localText, duration: parseFloat(localDuration) });
    }
  }

  function savePrompt() {
    setEditingPrompt(false);
    if (localPrompt !== scene.image_prompt) {
      onUpdate(scene.id, { image_prompt: localPrompt });
    }
  }

  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 bg-gray-800/50 border-b border-gray-800">
        <div className="w-7 h-7 rounded-lg bg-indigo-900/60 border border-indigo-800/40 flex items-center justify-center text-xs font-bold text-indigo-400 flex-shrink-0">
          {index + 1}
        </div>
        <div className="flex-1 min-w-0 flex items-center gap-2">
          <span className="text-xs font-mono text-gray-500">
            {formatTime(scene.start_time)} → {formatTime(scene.end_time)}
          </span>
          <span className="text-xs text-gray-600">({scene.duration}s)</span>
        </div>
        <div className="flex items-center gap-1">
          {scene.status === 'generated' && <CheckCircle2 size={14} className="text-green-400" />}
          {scene.status === 'pending' && <Clock size={14} className="text-gray-600" />}
          <button onClick={() => onDelete(scene.id)} className="text-gray-700 hover:text-red-400 transition-colors ml-1">
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="p-4 flex gap-4">
        {/* Image */}
        <div className="w-44 flex-shrink-0">
          <div className="aspect-video rounded-lg overflow-hidden bg-gray-800 border border-gray-700 relative">
            {scene.image_url ? (
              <img src={scene.image_url} alt={`Scene ${index + 1}`} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-700">
                <Image size={24} />
              </div>
            )}
            {isGenerating && (
              <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                <Loader2 size={20} className="animate-spin text-indigo-400" />
              </div>
            )}
          </div>
          <div className="flex gap-1 mt-2">
            <button
              onClick={() => onRegenerate(scene.id)}
              disabled={isGenerating}
              className="flex-1 text-xs py-1.5 rounded-md bg-indigo-900/40 hover:bg-indigo-900/60 text-indigo-400 border border-indigo-800/40 transition-colors flex items-center justify-center gap-1 disabled:opacity-50"
            >
              {isGenerating ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
              {scene.image_url ? 'Regen' : 'Generate'}
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0 space-y-3">
          {/* Scene text */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Scene Text</span>
              <button onClick={() => setEditingText(v => !v)} className="text-xs text-gray-600 hover:text-gray-400">
                {editingText ? 'Cancel' : 'Edit'}
              </button>
            </div>
            {editingText ? (
              <div className="space-y-2">
                <textarea
                  className="input text-sm resize-none"
                  rows={3}
                  value={localText}
                  onChange={e => setLocalText(e.target.value)}
                  autoFocus
                />
                <div className="flex items-center gap-2">
                  <label className="text-xs text-gray-500">Duration (s):</label>
                  <input type="number" step="0.5" min="1" max="60" className="input text-xs w-20" value={localDuration} onChange={e => setLocalDuration(e.target.value)} />
                  <button onClick={saveText} className="btn-primary text-xs py-1 px-3"><Save size={11} /></button>
                </div>
              </div>
            ) : (
              <p className="text-sm text-gray-300 leading-relaxed">{scene.text}</p>
            )}
          </div>

          {/* Image prompt */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-medium text-gray-500 uppercase tracking-wider">Image Prompt</span>
              <button onClick={() => setEditingPrompt(v => !v)} className="text-xs text-gray-600 hover:text-gray-400">
                {editingPrompt ? 'Cancel' : 'Edit'}
              </button>
            </div>
            {editingPrompt ? (
              <div className="space-y-2">
                <textarea
                  className="input text-xs resize-none font-mono"
                  rows={3}
                  value={localPrompt}
                  onChange={e => setLocalPrompt(e.target.value)}
                  autoFocus
                />
                <button onClick={savePrompt} className="btn-primary text-xs py-1 px-3 flex items-center gap-1"><Save size={11} /> Save prompt</button>
              </div>
            ) : (
              <p className="text-xs text-gray-500 font-mono line-clamp-2">
                {scene.image_prompt || <span className="text-gray-700 italic">No prompt yet — click "Auto-generate prompts" or edit manually</span>}
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ProjectDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { isAdmin, user } = useAuth();
  const [project, setProject] = useState(null);
  const [scenes, setScenes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('scenes');
  const [generatingId, setGeneratingId] = useState(null);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [generatingPrompts, setGeneratingPrompts] = useState(false);
  const [savingScenes, setSavingScenes] = useState(false);
  const [renderJobId, setRenderJobId] = useState(null);
  const [renderProgress, setRenderProgress] = useState(null);
  const [audioFile, setAudioFile] = useState(null);
  const [uploadingAudio, setUploadingAudio] = useState(false);
  const [usePlaceholders, setUsePlaceholders] = useState(false);
  const [error, setError] = useState('');
  const [transcribeSyncing, setTranscribeSyncing] = useState(false);
  const [timingSynced, setTimingSynced] = useState(false);
  const pollRef = useRef(null);

  async function loadProject() {
    const data = await api.getProject(id);
    setProject(data);
    setScenes(data.scenes || []);
  }

  useEffect(() => {
    loadProject().finally(() => setLoading(false));
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [id]);

  // Auto-analyze script into scenes if none exist
  useEffect(() => {
    if (project && scenes.length === 0 && project.script) {
      const analyzed = analyzeScript(project.script);
      setScenes(analyzed);
    }
  }, [project]);

  function handleUpdateScene(sceneId, updates) {
    setScenes(prev => {
      const updated = prev.map(s => s.id === sceneId ? { ...s, ...updates } : s);
      return recalcTimings(updated);
    });
  }

  function handleDeleteScene(sceneId) {
    setScenes(prev => recalcTimings(prev.filter(s => s.id !== sceneId)));
  }

  function handleAddScene() {
    const lastScene = scenes[scenes.length - 1];
    const newScene = {
      id: `scene-${Date.now()}`,
      scene_order: scenes.length,
      text: 'New scene — double click to edit',
      start_time: lastScene ? lastScene.end_time : 0,
      end_time: (lastScene ? lastScene.end_time : 0) + 5,
      duration: 5,
      image_prompt: '',
      image_url: '',
      status: 'pending',
    };
    setScenes(prev => [...prev, newScene]);
  }

  async function handleSaveScenes() {
    setSavingScenes(true);
    try {
      const saved = await api.saveScenes(id, scenes);
      setScenes(saved);
    } catch (err) { setError(err.message); }
    finally { setSavingScenes(false); }
  }

  async function handleGeneratePrompts() {
    setGeneratingPrompts(true);
    setError('');
    try {
      await handleSaveScenes();
      const result = await api.generatePrompts(id);
      const updated = scenes.map(s => {
        const found = result.scenes.find(r => r.id === s.id);
        return found ? { ...s, image_prompt: found.image_prompt } : s;
      });
      setScenes(updated);
    } catch (err) { setError(err.message); }
    finally { setGeneratingPrompts(false); }
  }

  async function handleRegenerateImage(sceneId) {
    setGeneratingId(sceneId);
    setError('');
    try {
      // Save scenes first to persist prompt edits
      await api.saveScenes(id, scenes);
      const result = await api.generateImage(sceneId);
      setScenes(prev => prev.map(s => s.id === sceneId ? { ...s, image_url: result.image_url, status: 'generated' } : s));
    } catch (err) {
      setError(err.message);
      // Check for token expired
      if (err.message?.toLowerCase().includes('rate_limited') || err.message?.toLowerCase().includes('token')) {
        setError('Whisk token expired. ' + err.message);
      }
    }
    finally { setGeneratingId(null); }
  }

  async function handleGenerateAll() {
    setGeneratingAll(true);
    setError('');
    try {
      await handleSaveScenes();
      for (const scene of scenes) {
        if (scene.status !== 'generated') {
          setGeneratingId(scene.id);
          try {
            const result = await api.generateImage(scene.id);
            setScenes(prev => prev.map(s => s.id === scene.id ? { ...s, image_url: result.image_url, status: 'generated' } : s));
          } catch (err) {
            setError(`Scene ${scene.scene_order + 1}: ${err.message}`);
            setGeneratingId(null);
          }
        }
      }
    } finally {
      setGeneratingAll(false);
      setGeneratingId(null);
    }
  }

  async function handleUploadAudio() {
    if (!audioFile) return;
    setUploadingAudio(true);
    try {
      await api.uploadAudio(id, audioFile);
      await loadProject();
      setAudioFile(null);
    } catch (err) { setError(err.message); return; }
    finally { setUploadingAudio(false); }

    // Auto-sync timing via AssemblyAI in the background after upload
    setTranscribeSyncing(true);
    setTimingSynced(false);
    try {
      const result = await api.transcribeAudio(id);
      setScenes(result.scenes);
      setTimingSynced(true);
      setTimeout(() => setTimingSynced(false), 4000);
    } catch (err) {
      // Timing sync failure is non-fatal — editor can proceed without it
      console.warn('AssemblyAI auto-sync failed:', err.message);
    } finally {
      setTranscribeSyncing(false);
    }
  }

  async function handleStartRender() {
    setError('');
    // Bug fix 3: validate at least one image exists before starting render
    const hasAnyImage = scenes.some(s => s.image_url);
    if (!hasAnyImage && !usePlaceholders) {
      setError('Generate at least one image or enable placeholder mode before rendering.');
      return;
    }
    try {
      await handleSaveScenes();
      const result = await api.startRender(id, usePlaceholders);
      setRenderJobId(result.jobId);
      setRenderProgress({ status: 'processing', progress: 0 });

      pollRef.current = setInterval(async () => {
        const status = await api.getRenderStatus(result.jobId);
        setRenderProgress(status);
        if (status.status === 'complete' || status.status === 'error') {
          clearInterval(pollRef.current);
          if (status.status === 'complete') {
            await loadProject();
          }
        }
      }, 2000);
    } catch (err) { setError(err.message); }
  }

  if (loading) return (
    <div className="flex items-center justify-center py-24">
      <Loader2 size={32} className="animate-spin text-indigo-500" />
    </div>
  );

  if (!project) return (
    <div className="p-6 text-center">
      <p className="text-gray-500">Project not found</p>
      <Link to="/" className="btn-primary mt-4 inline-block">Back to Dashboard</Link>
    </div>
  );

  const totalDuration = scenes.reduce((a, s) => a + s.duration, 0);
  const imagesReady = scenes.filter(s => s.status === 'generated').length;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start gap-4 mb-6">
        <Link to={isAdmin ? '/admin' : '/dashboard'} className="text-gray-500 hover:text-gray-300 mt-1 flex-shrink-0">
          <ChevronLeft size={20} />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-2xl font-bold text-white truncate">{project.title}</h1>
          <div className="flex items-center gap-3 mt-1 text-sm text-gray-500 flex-wrap">
            <span>{scenes.length} scenes</span>
            <span>·</span>
            <span>{formatTime(totalDuration)} est.</span>
            <span>·</span>
            <span className={`capitalize ${
              project.status === 'complete' ? 'text-green-400' :
              project.status === 'rendering' ? 'text-yellow-400' :
              project.status === 'in_progress' ? 'text-blue-400' : 'text-gray-500'
            }`}>{project.status?.replace('_', ' ')}</span>
          </div>
        </div>
        {project.status === 'complete' && (
          <a
            href={api.downloadUrl(id)}
            className="btn-primary flex items-center gap-2 flex-shrink-0"
            download
          >
            <Download size={16} /> Download MP4
          </a>
        )}
      </div>

      {error && (
        <div className="flex items-start gap-2 text-red-400 text-sm bg-red-900/20 border border-red-800/40 rounded-lg p-3 mb-4">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span>{error}</span>
          <button onClick={() => setError('')} className="ml-auto text-red-600 hover:text-red-400"><X size={14} /></button>
        </div>
      )}
      {transcribeSyncing && (
        <div className="flex items-center gap-2 text-indigo-300 text-sm bg-indigo-900/20 border border-indigo-800/40 rounded-lg p-3 mb-4">
          <Loader2 size={15} className="animate-spin flex-shrink-0" />
          <span>Syncing scene timings from audio via AssemblyAI…</span>
        </div>
      )}
      {timingSynced && (
        <div className="flex items-center gap-2 text-green-300 text-sm bg-green-900/20 border border-green-800/40 rounded-lg p-3 mb-4">
          <CheckCircle2 size={15} className="flex-shrink-0" />
          <span>Timing synced — scene start/end times updated from voiceover.</span>
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-800 mb-6">
        {TABS.map(t => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
              activeTab === t.id
                ? 'text-indigo-400 border-indigo-500'
                : 'text-gray-500 border-transparent hover:text-gray-300'
            }`}
          >
            <t.icon size={15} /> {t.label}
          </button>
        ))}
      </div>

      {/* ── SCENES TAB ── */}
      {activeTab === 'scenes' && (
        <div>
          {/* Toolbar */}
          <div className="flex items-center gap-2 mb-4 flex-wrap">
            <button onClick={handleSaveScenes} disabled={savingScenes} className="btn-secondary flex items-center gap-2 text-sm">
              {savingScenes ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />} Save Scenes
            </button>
            <button onClick={handleGeneratePrompts} disabled={generatingPrompts || generatingAll} className="btn-secondary flex items-center gap-2 text-sm">
              {generatingPrompts ? <Loader2 size={14} className="animate-spin" /> : <Wand2 size={14} />} Auto-generate Prompts
            </button>
            <button onClick={handleGenerateAll} disabled={generatingAll || generatingPrompts} className="btn-primary flex items-center gap-2 text-sm">
              {generatingAll ? <Loader2 size={14} className="animate-spin" /> : <Zap size={14} />}
              {generatingAll ? 'Generating…' : `Generate All Images (${scenes.length - imagesReady} left)`}
            </button>
            <div className="ml-auto text-xs text-gray-500">
              {imagesReady}/{scenes.length} images ready
            </div>
          </div>

          {scenes.length === 0 ? (
            <div className="card p-10 text-center">
              <Scissors size={32} className="text-gray-700 mx-auto mb-3" />
              <p className="text-gray-500">No scenes yet</p>
              {project.script && (
                <button onClick={() => setScenes(analyzeScript(project.script))} className="btn-primary mt-4 inline-flex items-center gap-2">
                  <Wand2 size={15} /> Auto-detect Scenes from Script
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {scenes.map((scene, i) => (
                <SceneCard
                  key={scene.id}
                  scene={scene}
                  index={i}
                  onUpdate={handleUpdateScene}
                  onRegenerate={handleRegenerateImage}
                  onDelete={handleDeleteScene}
                  generatingId={generatingId}
                />
              ))}
              <button onClick={handleAddScene} className="w-full p-3 border-2 border-dashed border-gray-800 rounded-xl text-gray-600 hover:border-gray-700 hover:text-gray-500 transition-colors text-sm flex items-center justify-center gap-2">
                <Plus size={16} /> Add Scene
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── AUDIO TAB ── */}
      {activeTab === 'audio' && (
        <div className="max-w-xl space-y-4">
          {project.audio_filename ? (
            <div className="card p-4">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-10 h-10 bg-green-900/40 border border-green-800/40 rounded-lg flex items-center justify-center">
                  <Mic size={18} className="text-green-400" />
                </div>
                <div>
                  <div className="text-sm font-medium text-gray-200">{project.audio_filename}</div>
                  <div className="text-xs text-green-400">Audio uploaded</div>
                </div>
              </div>
              <audio controls src={`/api/projects/${id}/audio`} className="w-full" />
            </div>
          ) : (
            <div className="card p-6 text-center border-dashed">
              <Mic size={32} className="text-gray-700 mx-auto mb-3" />
              <p className="text-gray-500 text-sm">No audio uploaded yet</p>
            </div>
          )}

          <div className="card p-4">
            <h3 className="font-medium text-gray-200 mb-3">
              {project.audio_filename ? 'Replace Audio' : 'Upload Voiceover'}
            </h3>
            {audioFile ? (
              <div className="flex items-center gap-3 mb-3 p-3 bg-gray-800 rounded-lg">
                <Mic size={16} className="text-indigo-400" />
                <span className="text-sm text-gray-300 flex-1 truncate">{audioFile.name}</span>
                <button onClick={() => setAudioFile(null)} className="text-gray-600 hover:text-red-400"><X size={14} /></button>
              </div>
            ) : (
              <label className="flex items-center gap-3 p-4 border border-dashed border-gray-700 rounded-lg cursor-pointer hover:border-gray-600 hover:bg-gray-800/30 transition-all mb-3">
                <Upload size={20} className="text-gray-600" />
                <span className="text-sm text-gray-500">Click to upload MP3 / WAV</span>
                <input type="file" accept="audio/*" className="hidden" onChange={e => setAudioFile(e.target.files[0])} />
              </label>
            )}
            <button
              onClick={handleUploadAudio}
              disabled={!audioFile || uploadingAudio}
              className="btn-primary w-full flex items-center justify-center gap-2"
            >
              {uploadingAudio ? <><Loader2 size={15} className="animate-spin" /> Uploading…</> : <><Upload size={15} /> Upload Audio</>}
            </button>
          </div>
        </div>
      )}

      {/* ── RENDER TAB ── */}
      {activeTab === 'render' && (
        <div className="max-w-xl space-y-4">
          {/* Status */}
          <div className="card p-4">
            <h3 className="font-medium text-gray-200 mb-3 flex items-center gap-2"><Film size={16} className="text-indigo-400" /> Render Status</h3>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between text-gray-400">
                <span>Scenes</span>
                <span className="text-gray-200">{scenes.length}</span>
              </div>
              <div className="flex justify-between text-gray-400">
                <span>Images Ready</span>
                <span className={imagesReady === scenes.length ? 'text-green-400' : 'text-yellow-400'}>
                  {imagesReady} / {scenes.length}
                </span>
              </div>
              <div className="flex justify-between text-gray-400">
                <span>Audio</span>
                <span className={project.audio_filename ? 'text-green-400' : 'text-gray-600'}>
                  {project.audio_filename || 'Not uploaded'}
                </span>
              </div>
              <div className="flex justify-between text-gray-400">
                <span>Est. Duration</span>
                <span className="text-gray-200">{formatTime(totalDuration)}</span>
              </div>
            </div>
          </div>

          {/* Placeholder option */}
          {imagesReady < scenes.length && (
            <label className="card p-3 flex items-center gap-3 cursor-pointer hover:border-gray-700 transition-colors">
              <input
                type="checkbox"
                checked={usePlaceholders}
                onChange={e => setUsePlaceholders(e.target.checked)}
                className="w-4 h-4 accent-indigo-500"
              />
              <div>
                <div className="text-sm text-gray-300">Use placeholder images for missing scenes</div>
                <div className="text-xs text-gray-600">Renders with colored frames where images aren't ready yet</div>
              </div>
            </label>
          )}

          {/* Render progress */}
          {renderProgress && (
            <div className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-300 capitalize">{renderProgress.status}</span>
                <span className="text-sm text-indigo-400">{renderProgress.progress}%</span>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-2">
                <div
                  className="bg-indigo-600 h-2 rounded-full transition-all duration-500"
                  style={{ width: `${renderProgress.progress}%` }}
                />
              </div>
              {renderProgress.status === 'complete' && (
                <p className="text-green-400 text-sm mt-2 flex items-center gap-1.5">
                  <CheckCircle2 size={15} /> Render complete!
                </p>
              )}
              {renderProgress.status === 'error' && (
                <p className="text-red-400 text-sm mt-2">{renderProgress.error}</p>
              )}
            </div>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <button
              onClick={handleStartRender}
              disabled={!project.audio_filename || (imagesReady === 0 && !usePlaceholders) || renderProgress?.status === 'processing'}
              className="btn-primary flex-1 flex items-center justify-center gap-2"
            >
              {renderProgress?.status === 'processing'
                ? <><Loader2 size={16} className="animate-spin" /> Rendering…</>
                : <><Play size={16} /> Start Render</>}
            </button>
            {project.status === 'complete' && (
              <a
                href={api.downloadUrl(id)}
                className="btn-secondary flex items-center gap-2"
                download
              >
                <Download size={16} /> Download MP4
              </a>
            )}
          </div>

          {!project.audio_filename && (
            <p className="text-xs text-yellow-500 flex items-center gap-1.5">
              <AlertCircle size={13} /> Upload audio first before rendering
            </p>
          )}
          {imagesReady === 0 && !usePlaceholders && (
            <p className="text-xs text-yellow-500 flex items-center gap-1.5">
              <AlertCircle size={13} /> Generate at least one image or enable placeholder mode
            </p>
          )}

          <div className="card p-4 bg-gray-900/30 text-xs text-gray-500 space-y-1">
            <p className="font-medium text-gray-400">What gets exported:</p>
            <p>• Each scene image displayed for its duration</p>
            <p>• Ken Burns zoom/pan effect applied per scene</p>
            <p>• Voiceover audio overlaid and synced</p>
            <p>• 1920×1080 MP4, H.264, ready for CapCut</p>
          </div>
        </div>
      )}
    </div>
  );
}
