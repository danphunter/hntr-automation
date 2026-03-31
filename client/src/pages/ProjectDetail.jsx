import React, { useState, useEffect, useRef } from 'react';
import { useParams, Link } from 'react-router-dom';
import { api } from '../utils/api';
import { useAuth } from '../contexts/AuthContext';
import { recalcTimings, formatTime } from '../utils/scriptAnalyzer';
import {
  ChevronLeft, ChevronRight, Mic, Scissors, Image, Film, Download,
  Loader2, RefreshCw, Upload, Clock, CheckCircle2, AlertCircle,
  Save, Trash2, Plus, X, FileText, Play,
} from 'lucide-react';


const STEPS = [
  { id: 1, label: 'Project Details', icon: FileText },
  { id: 2, label: 'Upload Audio',    icon: Mic },
  { id: 3, label: 'Transcription',   icon: Scissors },
  { id: 4, label: 'Images',          icon: Image },
  { id: 5, label: 'Render',          icon: Film },
];

// ââ Scene card for Step 3 (transcription review) ââââââââââââââââââââââââââââââ
function TranscriptSceneCard({ scene, index, onUpdate, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [localText, setLocalText] = useState(scene.text);
  const [localDuration, setLocalDuration] = useState(scene.duration);

  function save() {
    setEditing(false);
    if (localText !== scene.text || parseFloat(localDuration) !== scene.duration) {
      onUpdate(scene.id, { text: localText, duration: parseFloat(localDuration) });
    }
  }

  return (
    <div className="card p-4">
      <div className="flex items-start gap-3">
        <div className="w-7 h-7 rounded-lg bg-indigo-900/60 border border-indigo-800/40 flex items-center justify-center text-xs font-bold text-indigo-400 flex-shrink-0 mt-0.5">
          {index + 1}
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-2">
            <span className="text-xs font-mono text-gray-500">
              {formatTime(scene.start_time)} → {formatTime(scene.end_time)}
            </span>
            <span className="text-xs text-gray-600 bg-gray-800 rounded px-1.5 py-0.5">
              {scene.duration}s
            </span>
          </div>
          {editing ? (
            <div className="space-y-2">
              <textarea
                className="input text-sm resize-none w-full"
                rows={3}
                value={localText}
                onChange={e => setLocalText(e.target.value)}
                autoFocus
              />
              <div className="flex items-center gap-2 flex-wrap">
                <label className="text-xs text-gray-500">Duration (s):</label>
                <input
                  type="number" step="0.5" min="1" max="60"
                  className="input text-xs w-20"
                  value={localDuration}
                  onChange={e => setLocalDuration(e.target.value)}
                />
                <button onClick={save} className="btn-primary text-xs py-1 px-3 flex items-center gap-1">
                  <Save size={11} /> Save
                </button>
                <button onClick={() => setEditing(false)} className="text-xs text-gray-600 hover:text-gray-400">
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <p className="text-sm text-gray-300 leading-relaxed">{scene.text}</p>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={() => setEditing(v => !v)}
            className="text-xs text-gray-600 hover:text-gray-400 px-2 py-1 rounded hover:bg-gray-800"
          >
            Edit
          </button>
          <button onClick={() => onDelete(scene.id)} className="text-gray-700 hover:text-red-400 p-1">
            <Trash2 size={13} />
          </button>
        </div>
      </div>
    </div>
  );
}

// ââ Scene card for Step 4 (image generation) âââââââââââââââââââââââââââââââââ
function ImageSceneCard({ scene, index, onRegenerate, generatingId, onPreview }) {
  const isGenerating = generatingId === scene.id;
  return (
    <div className="card overflow-hidden">
      <div className="flex items-center gap-3 px-4 py-2.5 bg-gray-800/50 border-b border-gray-800">
        <div className="w-6 h-6 rounded bg-indigo-900/60 border border-indigo-800/40 flex items-center justify-center text-xs font-bold text-indigo-400 flex-shrink-0">
          {index + 1}
        </div>
        <span className="text-xs font-mono text-gray-500 flex-1 truncate">
          {formatTime(scene.start_time)} → {formatTime(scene.end_time)} · {scene.duration}s
        </span>
        {isGenerating && <Loader2 size={13} className="animate-spin text-indigo-400 flex-shrink-0" />}
        {!isGenerating && scene.status === 'generated' && <CheckCircle2 size={13} className="text-green-400 flex-shrink-0" />}
        {!isGenerating && scene.status !== 'generated' && <Clock size={13} className="text-gray-600 flex-shrink-0" />}
      </div>
      <div className="p-3 flex gap-3">
        <div className="w-36 flex-shrink-0">
          <div
            className={`aspect-video rounded-lg overflow-hidden bg-gray-800 border border-gray-700 relative ${scene.image_url && !isGenerating ? "cursor-pointer hover:opacity-80" : ""}`}
            onClick={() => scene.image_url && !isGenerating && onPreview(scene)}
            title={scene.image_url ? "Click to enlarge" : ""}
          >
            {scene.image_url ? (
              <img src={scene.image_url} alt={`Scene ${index + 1}`} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center text-gray-700">
                {isGenerating
                  ? <Loader2 size={20} className="animate-spin text-indigo-400" />
                  : <Image size={20} />}
              </div>
            )}
            {isGenerating && scene.image_url && (
              <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                <Loader2 size={18} className="animate-spin text-indigo-400" />
              </div>
            )}
          </div>
          <button
            onClick={() => onRegenerate(scene.id)}
            disabled={isGenerating || !scene.image_url}
            className="mt-1.5 w-full text-xs py-1 rounded bg-indigo-900/40 hover:bg-indigo-900/60 text-indigo-400 border border-indigo-800/40 transition-colors flex items-center justify-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isGenerating ? <Loader2 size={10} className="animate-spin" /> : <RefreshCw size={10} />}
            Regenerate
          </button>
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-gray-300 leading-relaxed line-clamp-4">{scene.text}</p>
          {scene.image_prompt && (
            <p className="text-xs text-gray-600 font-mono mt-2 line-clamp-2">{scene.image_prompt}</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ââ Main component ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
export default function ProjectDetail() {
  const { id } = useParams();
  const { isAdmin } = useAuth();

  const [project, setProject] = useState(null);
  const [scenes, setScenes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');

  // Step 1
  const [styles, setStyles] = useState([]);
  const [editTitle, setEditTitle] = useState('');
  const [editStyleId, setEditStyleId] = useState('');
  const [savingDetails, setSavingDetails] = useState(false);

  // Step 2
  const [audioFile, setAudioFile] = useState(null);
  const [uploadingAudio, setUploadingAudio] = useState(false);

  // Step 3
  const [transcribing, setTranscribing] = useState(false);
  const transcribeTriggered = useRef(false);

  // Step 4
  const [generatingPrompts, setGeneratingPrompts] = useState(false);
  const [generatingId, setGeneratingId] = useState(null);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [genProgress, setGenProgress] = useState({ current: 0, total: 0 });
  const scenesRef = useRef([]);
  const autoGenTriggered = useRef(false);

  // Step 5
  const [renderProgress, setRenderProgress] = useState(null);
  const [usePlaceholders, setUsePlaceholders] = useState(false);
  const pollRef = useRef(null);

  // Lightbox
  const [lightboxScene, setLightboxScene] = useState(null);

  // Keep scenesRef in sync for use inside async auto-generate
  useEffect(() => { scenesRef.current = scenes; }, [scenes]);

  // Sync lightbox image when scene regenerates
  useEffect(() => {
    if (lightboxScene) {
      const updated = scenes.find(s => s.id === lightboxScene.id);
      if (updated) setLightboxScene(updated);
    }
  }, [scenes]); // eslint-disable-line react-hooks/exhaustive-deps

  // ââ Initial load ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  useEffect(() => {
    Promise.all([api.getProject(id), api.getStyles()])
      .then(([proj, stls]) => {
        const scns = proj.scenes || [];
        setProject(proj);
        setScenes(scns);
        setEditTitle(proj.title || '');
        // style_id may be null for older projects - fall back to matching by style name
        const styleId = proj.style_id
          ? String(proj.style_id)
          : (stls.find(s => s.name === proj.style)?.id ? String(stls.find(s => s.name === proj.style)?.id) : '');
        setEditStyleId(styleId);
        setStyles(stls);
        setStep(detectInitialStep(proj, scns));
      })
      .finally(() => setLoading(false));
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [id]);

  function detectInitialStep(proj, scns) {
    if (!proj.audio_filename) return 2;
    if (!scns || scns.length === 0) return 3;
    if (scns.some(s => s.status !== 'generated')) return 4;
    return 5;
  }

  // ââ Step 3: auto-transcribe on entry ââââââââââââââââââââââââââââââââââââââââ
  useEffect(() => {
    if (
      step === 3 &&
      project?.audio_filename &&
      scenes.length === 0 &&
      !transcribing &&
      !transcribeTriggered.current
    ) {
      transcribeTriggered.current = true;
      handleTranscribe();
    }
  }, [step]); // eslint-disable-line react-hooks/exhaustive-deps

<<<<<<< HEAD
=======

>>>>>>> efd1665 (Trigger image generation directly from Generate Images button)
  // ââ Shared helpers ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  async function loadProject() {
    const data = await api.getProject(id);
    setProject(data);
    setScenes(data.scenes || []);
    return data;
  }

  // ââ Step 1 ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  async function handleSaveDetails() {
    setSavingDetails(true);
    setError('');
    try {
      const updated = await api.updateProject(id, {
        title: editTitle,
        style_id: editStyleId,
        style: selectedStyle?.name || '',
      });
      setProject(updated);
      setStep(2);
    } catch (err) { setError(err.message); }
    finally { setSavingDetails(false); }
  }

  // ââ Step 2 ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  async function handleUploadAudio() {
    if (!audioFile) return;
    setUploadingAudio(true);
    setError('');
    try {
      await api.uploadAudio(id, audioFile);
      await loadProject();
      setAudioFile(null);
      // Reset transcription state for new audio
      transcribeTriggered.current = false;
      setScenes([]);
      setStep(3);
    } catch (err) { setError(err.message); }
    finally { setUploadingAudio(false); }
  }

  // ââ Step 3 ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  async function handleTranscribe() {
    setTranscribing(true);
    setError('');
    try {
      // Start the job (returns immediately with { status: 'processing', jobId })
      await api.transcribeAudio(id);

      // Poll every 3 seconds until done
      await new Promise((resolve, reject) => {
        const interval = setInterval(async () => {
          try {
            const result = await api.getTranscribeStatus(id);
            if (result.status === 'completed') {
              clearInterval(interval);
              setScenes(result.scenes || []);
              await loadProject();
              resolve();
            } else if (result.status === 'error') {
              clearInterval(interval);
              reject(new Error(result.message || 'Transcription failed'));
            }
            // else still processing - keep polling
          } catch (e) {
            clearInterval(interval);
            reject(e);
          }
        }, 3000);
      });
    } catch (err) {
      setError(err.message);
      transcribeTriggered.current = false;
    } finally {
      setTranscribing(false);
    }
  }

  function handleUpdateScene(sceneId, updates) {
    setScenes(prev => recalcTimings(prev.map(s => s.id === sceneId ? { ...s, ...updates } : s)));
  }

  function handleDeleteScene(sceneId) {
    setScenes(prev => recalcTimings(prev.filter(s => s.id !== sceneId)));
  }

  function handleAddScene() {
    const lastScene = scenes[scenes.length - 1];
    setScenes(prev => [...prev, {
      id: `scene-${Date.now()}`,
      scene_order: prev.length,
      text: 'New scene',
      start_time: lastScene ? lastScene.end_time : 0,
      end_time: (lastScene ? lastScene.end_time : 0) + 5,
      duration: 5,
      image_prompt: '',
      image_url: '',
      status: 'pending',
    }]);
  }

  async function handleGoToImages() {
    setError('');
    try {
      await api.saveScenes(id, scenes);
      autoGenTriggered.current = true;
      setStep(4);
      handleAutoGenerate();
    } catch (err) { setError(err.message); }
  }

  // ââ Step 4 ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ

  async function handleAutoGenerate(initialScenes) {
    setGeneratingAll(true);
    setError('');
    try {
      let workingScenes = initialScenes || scenesRef.current;

      // Generate prompts if any scene is missing one
      if (workingScenes.some(s => !s.image_prompt)) {
        setGeneratingPrompts(true);
        try {
          const result = await api.generatePrompts(id);
          workingScenes = workingScenes.map(s => {
            const found = result.scenes.find(r => r.id === s.id);
            return found ? { ...s, image_prompt: found.image_prompt } : s;
          });
          setScenes(workingScenes);
        } finally {
          setGeneratingPrompts(false);
        }
      }

      // Generate images for pending scenes
      const pending = workingScenes.filter(s => s.status !== 'generated');
      setGenProgress({ current: 0, total: pending.length });

      for (let i = 0; i < pending.length; i++) {
        const scene = pending[i];
        setGeneratingId(scene.id);
        setGenProgress({ current: i + 1, total: pending.length });
        try {
          const result = await api.generateImage(scene.id);
          setScenes(prev => prev.map(s =>
            s.id === scene.id ? { ...s, image_url: result.image_url, status: 'generated' } : s
          ));
        } catch (err) {
          setError(`Scene ${(scene.scene_order ?? i) + 1}: ${err.message}`);
        }
      }
    } finally {
      setGeneratingAll(false);
      setGeneratingId(null);
    }
  }

  async function handleRegenerateImage(sceneId) {
    setGeneratingId(sceneId);
    setError('');
    try {
      await api.saveScenes(id, scenes);
      const result = await api.generateImage(sceneId);
      setScenes(prev => prev.map(s =>
        s.id === sceneId ? { ...s, image_url: result.image_url, status: 'generated', video_url: null, video_status: 'pending' } : s
      ));
    } catch (err) { setError(err.message); }
    finally { setGeneratingId(null); }
  }

  // ââ Step 5 ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  async function handleStartRender() {
    setError('');
    try {
      await api.saveScenes(id, scenes);
      const result = await api.startRender(id, usePlaceholders);
      setRenderProgress({ status: 'processing', progress: 0 });

      pollRef.current = setInterval(async () => {
        const status = await api.getRenderStatus(result.jobId);
        setRenderProgress(status);
        if (status.status === 'complete' || status.status === 'error') {
          clearInterval(pollRef.current);
          if (status.status === 'complete') await loadProject();
        }
      }, 2000);
    } catch (err) { setError(err.message); }
  }

  // ââ Computed ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
  const totalDuration = scenes.reduce((a, s) => a + (s.duration || 0), 0);
  const imagesReady = scenes.filter(s => s.status === 'generated').length;
  const selectedStyle = styles.find(s => String(s.id) === String(editStyleId));

  // ââ Render ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ
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

  return (
    <div className="p-6 max-w-3xl mx-auto">

      {/* ââ Page header âââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      <div className="flex items-center gap-3 mb-6">
        <Link to={isAdmin ? '/admin' : '/'} className="text-gray-500 hover:text-gray-300 flex-shrink-0">
          <ChevronLeft size={20} />
        </Link>
        <div className="flex-1 min-w-0">
          <h1 className="text-xl font-bold text-white truncate">{project.title}</h1>
          <div className="text-xs text-gray-500 mt-0.5">
            {scenes.length} scenes · {formatTime(totalDuration)} ·{' '}
            <span className={`capitalize ${
              project.status === 'complete'  ? 'text-green-400' :
              project.status === 'rendering' ? 'text-yellow-400' :
              project.status === 'in_progress' ? 'text-blue-400' : 'text-gray-500'
            }`}>{project.status?.replace('_', ' ')}</span>
          </div>
        </div>
      </div>

      {/* ââ Wizard progress bar âââââââââââââââââââââââââââââââââââââââââââââââ */}
      <div className="flex items-center mb-8">
        {STEPS.map((s, i) => {
          const isDone    = step > s.id;
          const isCurrent = step === s.id;
          const Icon = s.icon;
          return (
            <React.Fragment key={s.id}>
              <button
                onClick={() => (isDone || isCurrent) && setStep(s.id)}
                disabled={!isDone && !isCurrent}
                className={`flex flex-col items-center gap-1 flex-shrink-0 ${isDone ? 'cursor-pointer' : isCurrent ? 'cursor-default' : 'cursor-default'}`}
              >
                <div className={`w-9 h-9 rounded-full flex items-center justify-center border-2 transition-all ${
                  isDone    ? 'bg-indigo-600 border-indigo-600 text-white'
                : isCurrent ? 'bg-gray-900 border-indigo-500 text-indigo-400'
                :             'bg-gray-900 border-gray-700 text-gray-600'
                }`}>
                  {isDone ? <CheckCircle2 size={16} /> : <Icon size={15} />}
                </div>
                <span className={`text-xs font-medium hidden sm:block whitespace-nowrap ${
                  isCurrent ? 'text-indigo-400' : isDone ? 'text-gray-400' : 'text-gray-600'
                }`}>{s.label}</span>
              </button>
              {i < STEPS.length - 1 && (
                <div className={`flex-1 h-0.5 mx-1 transition-all ${step > s.id ? 'bg-indigo-600' : 'bg-gray-800'}`} />
              )}
            </React.Fragment>
          );
        })}
      </div>

      {/* ââ Global error banner âââââââââââââââââââââââââââââââââââââââââââââââ */}
      {error && (
        <div className="flex items-start gap-2 text-red-400 text-sm bg-red-900/20 border border-red-800/40 rounded-lg p-3 mb-4">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError('')} className="text-red-600 hover:text-red-400 flex-shrink-0"><X size={14} /></button>
        </div>
      )}

      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {/* STEP 1 - Project Details                                            */}
      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {step === 1 && (
        <div className="card p-6 space-y-5">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <FileText size={18} className="text-indigo-400" /> Project Details
          </h2>

          <div>
            <label className="label">Project Title</label>
            <input
              className="input w-full"
              value={editTitle}
              onChange={e => setEditTitle(e.target.value)}
              placeholder="Enter project title"
            />
          </div>

          <div>
            <label className="label">Style / Niche</label>
            <select
              className="input w-full"
              value={editStyleId}
              onChange={e => setEditStyleId(e.target.value)}
            >
              <option value="">Select a style...</option>
              {styles.map(s => (
                <option key={s.id} value={s.id}>{s.icon} {s.name}</option>
              ))}
            </select>
            {selectedStyle?.description && (
              <p className="text-xs text-gray-500 mt-1.5">{selectedStyle.description}</p>
            )}
          </div>

          <button
            onClick={handleSaveDetails}
            disabled={savingDetails || !editTitle.trim() || !editStyleId}
            className="btn-primary w-full flex items-center justify-center gap-2"
          >
            {savingDetails && <Loader2 size={15} className="animate-spin" />}
            Next: Upload Audio <ChevronRight size={15} />
          </button>
        </div>
      )}

      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {/* STEP 2 - Upload Audio                                               */}
      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {step === 2 && (
        <div className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Mic size={18} className="text-indigo-400" /> Upload Voiceover
          </h2>

          {project.audio_filename && (
            <div className="p-3 bg-green-900/20 border border-green-800/40 rounded-lg flex items-center gap-3">
              <CheckCircle2 size={16} className="text-green-400 flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-sm text-gray-200 truncate">{project.audio_filename}</div>
                <div className="text-xs text-green-400">Audio uploaded</div>
              </div>
            </div>
          )}

          {audioFile ? (
            <div className="flex items-center gap-3 p-3 bg-gray-800 rounded-lg">
              <Mic size={16} className="text-indigo-400 flex-shrink-0" />
              <span className="text-sm text-gray-300 flex-1 truncate">{audioFile.name}</span>
              <button onClick={() => setAudioFile(null)} className="text-gray-600 hover:text-red-400 flex-shrink-0"><X size={14} /></button>
            </div>
          ) : (
            <label className="flex flex-col items-center gap-3 p-8 border-2 border-dashed border-gray-700 rounded-xl cursor-pointer hover:border-indigo-700 hover:bg-indigo-900/10 transition-all">
              <Upload size={28} className="text-gray-600" />
              <div className="text-center">
                <div className="text-sm text-gray-300 font-medium">Click to upload voiceover</div>
                <div className="text-xs text-gray-600 mt-0.5">MP3, WAV, M4A supported</div>
              </div>
              <input type="file" accept="audio/*" className="hidden" onChange={e => { if (e.target.files[0]) setAudioFile(e.target.files[0]); }} />
            </label>
          )}

          {uploadingAudio && (
            <div className="flex items-center gap-3 p-3 bg-indigo-900/20 border border-indigo-800/40 rounded-lg">
              <Loader2 size={16} className="animate-spin text-indigo-400" />
              <span className="text-sm text-indigo-300">Uploading audio...</span>
            </div>
          )}

          <div className="flex gap-3">
            <button onClick={() => setStep(1)} className="btn-secondary flex items-center gap-2">
              <ChevronLeft size={15} /> Back
            </button>
            <button
              onClick={handleUploadAudio}
              disabled={!audioFile || uploadingAudio}
              className="btn-primary flex-1 flex items-center justify-center gap-2"
            >
              {uploadingAudio
                ? <><Loader2 size={15} className="animate-spin" /> Uploading...</>
                : <><Upload size={15} /> Upload & Continue</>}
            </button>
          </div>

          {project.audio_filename && !audioFile && (
            <button
              onClick={() => { transcribeTriggered.current = false; setStep(3); }}
              className="btn-secondary w-full flex items-center justify-center gap-2 text-sm"
            >
              Use existing audio and continue <ChevronRight size={14} />
            </button>
          )}
        </div>
      )}

      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {/* STEP 3 - Transcription                                              */}
      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {step === 3 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Scissors size={18} className="text-indigo-400" /> Transcription
          </h2>

          {/* Transcribing state */}
          {transcribing && (
            <div className="card p-10 text-center">
              <Loader2 size={36} className="animate-spin text-indigo-500 mx-auto mb-4" />
              <p className="text-gray-200 font-medium">Transcribing audio...</p>
              <p className="text-sm text-gray-500 mt-1.5">
                AssemblyAI is processing your voiceover. This usually takes 30-90 seconds.
              </p>
            </div>
          )}

          {/* Scenes list */}
          {!transcribing && scenes.length > 0 && (
            <>
              <p className="text-sm text-gray-400">
                {scenes.length} scenes detected. Review and adjust text or timing if needed.
              </p>
              <div className="space-y-2">
                {scenes.map((scene, i) => (
                  <TranscriptSceneCard
                    key={scene.id}
                    scene={scene}
                    index={i}
                    onUpdate={handleUpdateScene}
                    onDelete={handleDeleteScene}
                  />
                ))}
                <button
                  onClick={handleAddScene}
                  className="w-full p-2.5 border-2 border-dashed border-gray-800 rounded-xl text-gray-600 hover:border-gray-700 hover:text-gray-500 transition-colors text-sm flex items-center justify-center gap-2"
                >
                  <Plus size={15} /> Add Scene
                </button>
              </div>
              <div className="flex gap-3 pt-2">
                <button onClick={() => setStep(2)} className="btn-secondary flex items-center gap-2">
                  <ChevronLeft size={15} /> Back
                </button>
                <button
                  onClick={handleGoToImages}
                  className="btn-primary flex-1 flex items-center justify-center gap-2"
                >
                  Generate Images <ChevronRight size={15} />
                </button>
              </div>
            </>
          )}

          {/* Empty / error state */}
          {!transcribing && scenes.length === 0 && (
            <div className="card p-8 text-center space-y-3">
              <AlertCircle size={28} className="text-yellow-500 mx-auto" />
              <p className="text-gray-400">No scenes detected. Try re-running transcription.</p>
              <button
                onClick={() => { transcribeTriggered.current = true; handleTranscribe(); }}
                className="btn-primary flex items-center justify-center gap-2 mx-auto"
              >
                <RefreshCw size={14} /> Retry Transcription
              </button>
            </div>
          )}
        </div>
      )}

      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {/* STEP 4 - Image Generation                                           */}
      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {step === 4 && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold text-white flex items-center gap-2">
              <Image size={18} className="text-indigo-400" /> Image Generation
            </h2>
            <span className="text-sm text-gray-500">{imagesReady}/{scenes.length} ready</span>
          </div>

          {/* Generation progress indicator */}
          {(generatingPrompts || generatingAll) && (
            <div className="card p-4 flex items-center gap-3">
              <Loader2 size={18} className="animate-spin text-indigo-400 flex-shrink-0" />
              <div className="flex-1">
                <div className="text-sm text-gray-300 font-medium">
                  {generatingPrompts
                    ? 'Generating image prompts...'
                    : `Generating image ${genProgress.current} of ${genProgress.total}...`}
                </div>
                {!generatingPrompts && genProgress.total > 0 && (
                  <div className="mt-2 w-full bg-gray-800 rounded-full h-1.5">
                    <div
                      className="bg-indigo-600 h-1.5 rounded-full transition-all"
                      style={{ width: `${(genProgress.current / genProgress.total) * 100}%` }}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Regenerate prompts button — forces re-run even if prompts already exist */}
          {!generatingAll && !generatingPrompts && (
            <button
              onClick={async () => {
                setGeneratingPrompts(true);
                setError('');
                try {
                  const result = await api.generatePrompts(id);
                  setScenes(prev => prev.map(s => {
                    const found = result.scenes.find(r => r.id === s.id);
                    return found ? { ...s, image_prompt: found.image_prompt } : s;
                  }));
                } catch (err) { setError(err.message); }
                finally { setGeneratingPrompts(false); }
              }}
              className="btn-secondary text-sm flex items-center gap-2"
            >
              <RefreshCw size={13} /> Regenerate Prompts
            </button>
          )}

          {/* Resume button when generation was interrupted */}
          {!generatingAll && !generatingPrompts && scenes.some(s => s.status !== 'generated') && imagesReady > 0 && (
            <button
              onClick={() => handleAutoGenerate()}
              className="btn-secondary text-sm flex items-center gap-2"
            >
              <RefreshCw size={13} /> Resume Generation ({scenes.length - imagesReady} remaining)
            </button>
          )}

          {/* Scene cards */}
          <div className="space-y-3">
            {scenes.map((scene, i) => (
              <ImageSceneCard
                key={scene.id}
                scene={scene}
                index={i}
                onRegenerate={handleRegenerateImage}
                generatingId={generatingId}
                onPreview={setLightboxScene}
              />
            ))}
          </div>

          <div className="flex gap-3 pt-2">
            <button onClick={() => setStep(3)} className="btn-secondary flex items-center gap-2">
              <ChevronLeft size={15} /> Back
            </button>
            <button
              onClick={() => setStep(5)}
              className="btn-primary flex-1 flex items-center justify-center gap-2"
            >
              Render Video <ChevronRight size={15} />
            </button>
          </div>
        </div>
      )}

      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {/* STEP 5 - Render & Download                                          */}
      {/* ââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââââ */}
      {step === 5 && (
        <div className="space-y-4">
          <h2 className="text-lg font-semibold text-white flex items-center gap-2">
            <Film size={18} className="text-indigo-400" /> Render & Download
          </h2>

          {/* Summary */}
          <div className="card p-4 space-y-2 text-sm">
            <div className="flex justify-between text-gray-400">
              <span>Scenes</span>
              <span className="text-gray-200">{scenes.length}</span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>Images Ready</span>
              <span className={imagesReady === scenes.length ? 'text-green-400' : 'text-yellow-400'}>
                {imagesReady}/{scenes.length}
              </span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>Audio</span>
              <span className={project.audio_filename ? 'text-green-400' : 'text-red-400'}>
                {project.audio_filename || 'Missing'}
              </span>
            </div>
            <div className="flex justify-between text-gray-400">
              <span>Est. Duration</span>
              <span className="text-gray-200">{formatTime(totalDuration)}</span>
            </div>
          </div>

          {/* Placeholder toggle when some images are missing */}
          {imagesReady < scenes.length && (
            <label className="card p-3 flex items-center gap-3 cursor-pointer hover:border-gray-700 transition-colors">
              <input
                type="checkbox"
                checked={usePlaceholders}
                onChange={e => setUsePlaceholders(e.target.checked)}
                className="w-4 h-4 accent-indigo-500 flex-shrink-0"
              />
              <div>
                <div className="text-sm text-gray-300">Use placeholder images for missing scenes</div>
                <div className="text-xs text-gray-600">Renders with colored frames where images aren't ready</div>
              </div>
            </label>
          )}


          {/* Render progress */}
          {renderProgress && (
            <div className="card p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-300 capitalize">{renderProgress.message || renderProgress.status}</span>
                <span className="text-sm text-indigo-400">{renderProgress.progress}%</span>
              </div>
              <div className="w-full bg-gray-800 rounded-full h-2.5">
                <div
                  className="bg-indigo-600 h-2.5 rounded-full transition-all duration-500"
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

          {/* Warnings */}
          {!project.audio_filename && (
            <p className="text-xs text-yellow-500 flex items-center gap-1.5">
              <AlertCircle size={13} /> Audio is required before rendering
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-3">
            <button onClick={() => setStep(4)} className="btn-secondary flex items-center gap-2">
              <ChevronLeft size={15} /> Back
            </button>
            {project.status === 'complete' ? (
              <a
                href={api.downloadUrl(id)}
                className="btn-primary flex-1 flex items-center justify-center gap-2"
                download={`${project.title}.mp4`}
              >
                <Download size={15} /> Download {project.title}.mp4
              </a>
            ) : (
              <button
                onClick={handleStartRender}
                disabled={
                  !project.audio_filename ||
                  (imagesReady === 0 && !usePlaceholders) ||
                  renderProgress?.status === 'processing'
                }
                className="btn-primary flex-1 flex items-center justify-center gap-2"
              >
                {renderProgress?.status === 'processing'
                  ? <><Loader2 size={15} className="animate-spin" /> Rendering...</>
                  : <><Play size={15} /> Start Render</>}
              </button>
            )}
          </div>

          <div className="card p-4 bg-gray-900/30 text-xs text-gray-500 space-y-1">
            <p className="font-medium text-gray-400">What gets exported:</p>
            <p>• Each scene image displayed for its duration</p>
            <p>• Static images</p>
            <p>• Voiceover audio overlaid and synced</p>
            <p>• 1920x1080 MP4, H.264, ready for CapCut</p>
          </div>
        </div>
      )}

      {/* Lightbox */}
      {lightboxScene && (
        <div
          className="fixed inset-0 bg-black/90 z-50 flex items-center justify-center p-4"
          onClick={() => setLightboxScene(null)}
        >
          <div className="relative w-full max-w-4xl" onClick={e => e.stopPropagation()}>
            <button
              onClick={() => setLightboxScene(null)}
              className="absolute -top-10 right-0 text-gray-400 hover:text-white"
            >
              <X size={22} />
            </button>
            <div className="relative rounded-xl overflow-hidden bg-gray-900">
              {lightboxScene.image_url ? (
                <img src={lightboxScene.image_url} alt="Scene preview" className="w-full" />
              ) : (
                <div className="aspect-video flex items-center justify-center text-gray-600">
                  <Image size={48} />
                </div>
              )}
              {generatingId === lightboxScene.id && (
                <div className="absolute inset-0 bg-black/60 flex items-center justify-center">
                  <Loader2 size={32} className="animate-spin text-indigo-400" />
                </div>
              )}
            </div>
            <div className="mt-3 flex items-start justify-between gap-4">
              <p className="text-sm text-gray-300 leading-relaxed flex-1">{lightboxScene.text}</p>
              <button
                onClick={() => handleRegenerateImage(lightboxScene.id)}
                disabled={generatingId === lightboxScene.id || !lightboxScene.image_url}
                className="flex-shrink-0 flex items-center gap-2 px-4 py-2 bg-indigo-700 hover:bg-indigo-600 text-white text-sm rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {generatingId === lightboxScene.id
                  ? <Loader2 size={14} className="animate-spin" />
                  : <RefreshCw size={14} />}
                Regenerate
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}