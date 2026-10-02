// Transcription runs here, inside your browser. Nothing is uploaded anywhere.
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.7.5';
env.allowLocalModels = false;
let asr = null;
self.onmessage = async (e) => {
  const { audio, model } = e.data;
  try {
    if (!asr) {
      const progress = (p) => { if (p.status === 'progress' && p.total) self.postMessage({ type: 'load', file: p.file, pct: p.loaded / p.total }); };
      let device = 'wasm';
      try { if (navigator.gpu && await navigator.gpu.requestAdapter()) device = 'webgpu'; } catch (_) {}
      try {
        asr = await pipeline('automatic-speech-recognition', model, device === 'webgpu'
          ? { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback: progress }
          : { dtype: 'q8', progress_callback: progress });
      } catch (err) {
        asr = await pipeline('automatic-speech-recognition', model, { dtype: 'q8', progress_callback: progress });
      }
    }
    self.postMessage({ type: 'status', text: 'Listening to your video…' });
    const out = await asr(audio, { return_timestamps: 'word', chunk_length_s: 30, stride_length_s: 5 });
    self.postMessage({ type: 'done', chunks: out.chunks });
  } catch (err) {
    self.postMessage({ type: 'error', text: String(err && err.message || err) });
  }
};
