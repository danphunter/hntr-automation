import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../utils/api';
import { ChevronRight, Film, Mic, Loader2, Upload, X } from 'lucide-react';

const STEPS = ['Details', 'Audio'];

export default function NewProject() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [styles, setStyles] = useState([]);
  const [form, setForm] = useState({ title: '', style_id: '' });
  const [audioFile, setAudioFile] = useState(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { api.getStyles().then(setStyles).catch(() => {}); }, []);

  function set(key, val) { setForm(f => ({ ...f, [key]: val })); }

  async function handleNext() {
    setError('');
    if (step === 0) {
      if (!form.title.trim()) { setError('Project title is required'); return; }
      if (!form.style_id) { setError('Please select a style'); return; }
      setStep(1);
    } else {
      // Create project + optionally upload audio
      setCreating(true);
      try {
        const project = await api.createProject({ ...form, script: '' });
        if (audioFile) {
          await api.uploadAudio(project.id, audioFile);
        }
        navigate(`/projects/${project.id}`);
      } catch (err) {
        setError(err.message);
        setCreating(false);
      }
    }
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-white">New Project</h1>
        <p className="text-gray-500 text-sm mt-1">Set up your video production project</p>
      </div>

      {/* Steps */}
      <div className="flex items-center gap-0 mb-8">
        {STEPS.map((s, i) => (
          <React.Fragment key={s}>
            <div className={`flex items-center gap-2 text-sm font-medium ${i === step ? 'text-indigo-400' : i < step ? 'text-green-400' : 'text-gray-600'}`}>
              <div className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold border ${
                i === step ? 'border-indigo-500 bg-indigo-900/50 text-indigo-400' :
                i < step ? 'border-green-600 bg-green-900/30 text-green-400' :
                'border-gray-700 text-gray-600'}`}>
                {i + 1}
              </div>
              {s}
            </div>
            {i < STEPS.length - 1 && <div className="flex-1 h-px bg-gray-800 mx-3" />}
          </React.Fragment>
        ))}
      </div>

      <div className="card p-6">
        {error && (
          <div className="flex items-center gap-2 text-red-400 text-sm bg-red-900/20 border border-red-800/40 rounded-lg p-3 mb-4">
            <X size={15} /> {error}
          </div>
        )}

        {/* Step 0: Details */}
        {step === 0 && (
          <div className="space-y-4">
            <div>
              <label className="label">Project Title *</label>
              <input className="input" value={form.title} onChange={e => set('title', e.target.value)} placeholder="e.g. David vs Goliath — Full Story" autoFocus />
            </div>
            <div>
              <label className="label">Video Style / Niche *</label>
              <div className="grid grid-cols-2 gap-2 mt-1">
                {styles.map(s => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => set('style_id', s.id)}
                    className={`text-left p-3 rounded-lg border transition-all ${
                      form.style_id === s.id
                        ? 'border-indigo-500 bg-indigo-900/20'
                        : 'border-gray-700 bg-gray-800/50 hover:border-gray-600'
                    }`}
                  >
                    <div className="text-lg mb-1">{s.icon}</div>
                    <div className="text-sm font-medium text-gray-200">{s.name}</div>
                    <div className="text-xs text-gray-500 mt-0.5 line-clamp-2">{s.description}</div>
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Step 1: Audio */}
        {step === 1 && (
          <div className="space-y-4">
            <div className="flex items-start gap-3 p-3 bg-blue-900/20 border border-blue-800/40 rounded-lg">
              <Mic size={16} className="text-blue-400 flex-shrink-0 mt-0.5" />
              <p className="text-sm text-blue-300">
                Upload your voiceover — it will be automatically transcribed and split into scenes with timing.
                You can also skip this and add audio from inside the project.
              </p>
            </div>
            <div>
              <label className="label">Voiceover Audio (MP3 / WAV)</label>
              {audioFile ? (
                <div className="flex items-center gap-3 p-4 bg-gray-800 border border-gray-700 rounded-lg">
                  <Mic size={20} className="text-green-400 flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-200 truncate">{audioFile.name}</div>
                    <div className="text-xs text-gray-500">{(audioFile.size / 1024 / 1024).toFixed(1)} MB</div>
                  </div>
                  <button onClick={() => setAudioFile(null)} className="text-gray-500 hover:text-red-400 transition-colors">
                    <X size={16} />
                  </button>
                </div>
              ) : (
                <label className="flex flex-col items-center gap-3 p-8 border-2 border-dashed border-gray-700 rounded-lg cursor-pointer hover:border-gray-600 hover:bg-gray-800/30 transition-all">
                  <Upload size={28} className="text-gray-600" />
                  <div className="text-center">
                    <div className="text-sm text-gray-400">Click to upload or drag & drop</div>
                    <div className="text-xs text-gray-600 mt-1">MP3, WAV, M4A — up to 200MB</div>
                  </div>
                  <input type="file" accept="audio/*" className="hidden" onChange={e => setAudioFile(e.target.files[0])} />
                </label>
              )}
            </div>
            {!audioFile && (
              <p className="text-xs text-gray-600 italic">You can skip this and add audio later from the project page.</p>
            )}
          </div>
        )}

        {/* Actions */}
        <div className="flex justify-between mt-6 pt-4 border-t border-gray-800">
          <button
            onClick={() => setStep(s => s - 1)}
            disabled={step === 0}
            className="btn-secondary"
          >
            Back
          </button>
          <button onClick={handleNext} disabled={creating} className="btn-primary flex items-center gap-2">
            {creating ? (
              <><Loader2 size={16} className="animate-spin" /> Creating…</>
            ) : step < STEPS.length - 1 ? (
              <>Next <ChevronRight size={16} /></>
            ) : (
              <>Create Project <Film size={16} /></>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
