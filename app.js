// Desyner Studio: everything runs in the browser.
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FILL = new Set(['um', 'uh', 'erm', 'er', 'ah', 'hmm', 'mm', 'uhm', 'umm']);
const norm = w => w.toLowerCase().replace(/[^a-z0-9']/g, '');
const isFill = w => FILL.has(norm(w));
const ASPECTS = { '9:16': [1080, 1920], '1:1': [1080, 1080], '16:9': [1920, 1080] };
const MODEL = 'onnx-community/whisper-base_timestamped';
const HELLO = "Drop in a video and I'll write out everything you say. Then tell me what to cut, or click the words yourself.";
let P = null, videoURL = null, history = [], exportsList = [], playRange = null;

// ---------- storage (IndexedDB keeps your last project, including the video, on this laptop)
const db = new Promise((res, rej) => { const r = indexedDB.open('desyner-studio', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
const idb = async (mode, fn) => { const d = await db; return new Promise((res, rej) => { const t = d.transaction('kv', mode); const q = fn(t.objectStore('kv')); t.oncomplete = () => res(q && q.result); t.onerror = () => rej(t.error); }); };
const kvGet = k => idb('readonly', s => s.get(k));
const kvSet = (k, v) => idb('readwrite', s => { s.put(v, k); });
let saveT = null; const save = () => { clearTimeout(saveT); saveT = setTimeout(() => kvSet('project', P).catch(() => {}), 300); };

// ---------- upload + transcription
$('#drop').onclick = () => $('#file').click();
$('#drop').ondragover = e => e.preventDefault();
$('#drop').ondrop = e => { e.preventDefault(); load(e.dataTransfer.files[0]); };
$('#file').onchange = e => load(e.target.files[0]);
$('#newVid').onclick = () => { if (confirm('Start a new video? Your current edit on this laptop will be replaced.')) { $('#file').value = ''; $('#file').click(); } };

async function load(file) {
  if (!file) return;
  P = { name: file.name, status: 'transcribing', words: [], sentences: [], shorts: [], chat: [{ role: 'ai', text: HELLO }],
        style: { aspect: '9:16', fit: 'blur', captions: true, hook: '', wpl: 3, color: '#e8622c' } };
  history = []; exportsList = [];
  if (videoURL) URL.revokeObjectURL(videoURL);
  videoURL = URL.createObjectURL(file);
  $('#vid').src = videoURL;
  show(); draw();
  kvSet('video', file).catch(() => {});
  try {
    status('Reading the audio…', 0.02);
    const ab = await file.arrayBuffer();
    const ac = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    const buf = await ac.decodeAudioData(ab);
    let audio = buf.getChannelData(0);
    if (buf.numberOfChannels > 1) { const b = buf.getChannelData(1); const m = new Float32Array(audio.length); for (let i = 0; i < m.length; i++) m[i] = (audio[i] + b[i]) / 2; audio = m; }
    else audio = new Float32Array(audio);
    ac.close();
    const dur = audio.length / 16000;
    const worker = new Worker('worker.js', { type: 'module' });
    const t0 = performance.now(); let fake = null;
    worker.onmessage = e => {
      const m = e.data;
      if (m.type === 'load') status('Downloading the speech model (first time only)…', 0.05 + 0.35 * m.pct);
      if (m.type === 'status') { const est = dur * 0.6; fake = setInterval(() => status(m.text, Math.min(0.97, 0.4 + 0.57 * ((performance.now() - t0) / 1000) / Math.max(10, est))), 500); }
      if (m.type === 'error') { clearInterval(fake); P.status = 'error'; P.error = m.text; draw(); worker.terminate(); }
      if (m.type === 'done') {
        clearInterval(fake); worker.terminate();
        P.words = m.chunks.map(c => { const s = c.timestamp[0] ?? 0; let e = c.timestamp[1] ?? s + 0.3; if (e <= s) e = s + 0.12; return { w: c.text.trim(), s, e, del: false }; }).filter(w => w.w);
        P.sentences = buildSentences(P.words); P.status = 'ready';
        const f = P.words.filter(w => isFill(w.w)).length;
        P.chat.push({ role: 'ai', text: `Done. I wrote out ${P.words.length} words${f ? ` and spotted ${f} filler word${f > 1 ? 's' : ''}` : ''}. Try "make 3 shorts of 30 seconds", "make a short about pricing" or "cut 'you know'".` });
        save(); draw();
      }
    };
    worker.postMessage({ audio, model: MODEL }, [audio.buffer]);
  } catch (err) { P.status = 'error'; P.error = 'Could not read the audio in this video. Try an MP4 or MOV file. (' + err.message + ')'; draw(); }
}
function status(text, pct) { if (P.status !== 'transcribing') return; $('#transcript').innerHTML = `<span class="spin"></span> ${esc(text)}`; $('#tbar').style.display = 'block'; $('#tbar i').style.width = (pct * 100) + '%'; }
function buildSentences(W) {
  const S = []; let a = 0;
  W.forEach((w, i) => { const next = W[i + 1]; if (/[.!?]$/.test(w.w) || !next || next.s - w.e > 1.0) { S.push({ a, b: i }); a = i + 1; } });
  return S;
}
function show() { $('#uploadCard').style.display = 'none'; $('#editor').style.display = 'block'; }

// ---------- rendering the editor
function draw() {
  drawChat(); drawStyle(); drawShorts(); drawExports();
  const t = $('#transcript');
  $('#exportMain').disabled = P.status !== 'ready';
  if (P.status === 'transcribing') return;
  $('#tbar').style.display = 'none';
  if (P.status === 'error') { t.innerHTML = 'Something went wrong: ' + esc(P.error || ''); return; }
  const inS = new Set(); P.shorts.forEach(s => { for (let i = s.a; i <= s.b; i++) inS.add(i); });
  t.innerHTML = P.words.map((w, i) => `<span class="w${w.del ? ' del' : ''}${isFill(w.w) ? ' fill' : ''}${inS.has(i) ? ' inshort' : ''}" data-i="${i}">${esc(w.w)}</span>`).join(' ');
  const c = P.words.filter(w => w.del).length; $('#stats').textContent = c ? `${c} words cut` : '';
}
function drawChat() { const l = $('#chatlog'); l.innerHTML = (P ? P.chat : [{ role: 'ai', text: HELLO }]).map(m => `<div class="msg ${m.role}">${esc(m.text)}</div>`).join(''); l.scrollTop = 1e9; }
function drawStyle() { if (!P) return; const s = P.style; $('#aspect').value = s.aspect; $('#fit').value = s.fit; $('#caps').checked = s.captions; $('#color').value = s.color; if (document.activeElement !== $('#hook')) $('#hook').value = s.hook || ''; }
function drawShorts() {
  const d = $('#shorts');
  if (!P || !P.shorts.length) { d.innerHTML = 'No shorts yet. Ask in chat, or highlight words and tap “Make short”.'; return; }
  d.innerHTML = P.shorts.map((s, k) => `<div class="item"><b>${esc(s.title)}</b><br><small>about ${(P.words[s.b].e - P.words[s.a].s).toFixed(0)}s before cuts</small>
   <div class="row"><button data-p="${k}">▶ Preview</button><button class="pri" data-x="${k}">Export</button><button data-r="${k}">Remove</button></div></div>`).join('');
  d.querySelectorAll('[data-p]').forEach(b => b.onclick = () => { const s = P.shorts[b.dataset.p]; playFrom(s.a, s.b); });
  d.querySelectorAll('[data-x]').forEach(b => b.onclick = () => exportShort(+b.dataset.x));
  d.querySelectorAll('[data-r]').forEach(b => b.onclick = () => { snap(); P.shorts.splice(+b.dataset.r, 1); save(); draw(); });
}
function drawExports() {
  $('#exports').innerHTML = exportsList.map(e => `<div class="item"><b>${esc(e.label)}</b> <small>${e.aspect} · ${e.dur.toFixed(1)}s · ${e.ext.toUpperCase()}</small>
   <video src="${e.url}" controls playsinline preload="metadata"></video><div class="row"><a href="${e.url}" download="${esc(e.file)}"><button class="pri">Download</button></a></div></div>`).join('');
}

// ---------- style controls
const setStyle = o => { snap(); Object.assign(P.style, o); save(); drawStyle(); };
$('#aspect').onchange = e => setStyle({ aspect: e.target.value });
$('#fit').onchange = e => setStyle({ fit: e.target.value });
$('#caps').onchange = e => setStyle({ captions: e.target.checked });
$('#color').onchange = e => setStyle({ color: e.target.value });
$('#hook').onchange = e => setStyle({ hook: e.target.value });

// ---------- undo
function snap() { if (!P) return; history.push(JSON.stringify({ d: P.words.map(w => w.del), s: P.style, sh: P.shorts })); if (history.length > 40) history.shift(); }
function undo() { const h = history.pop(); if (!h) return false; const o = JSON.parse(h); P.words.forEach((w, i) => w.del = o.d[i]); P.style = o.s; P.shorts = o.sh; return true; }

// ---------- transcript interaction
let selIdx = null;
$('#transcript').addEventListener('mouseup', e => {
  setTimeout(() => {
    const s = getSelection();
    if (s && !s.isCollapsed && s.anchorNode) {
      const a = s.anchorNode.parentElement && s.anchorNode.parentElement.closest('.w'), b = s.focusNode.parentElement && s.focusNode.parentElement.closest('.w');
      if (a && b) {
        let i = +a.dataset.i, j = +b.dataset.i; if (i > j) [i, j] = [j, i]; selIdx = [i, j];
        const r = s.getRangeAt(0).getBoundingClientRect(), T = $('#tool');
        T.style.display = 'flex'; T.style.left = Math.max(8, r.left) + 'px'; T.style.top = Math.max(8, r.top - 50) + 'px'; return;
      }
    }
    $('#tool').style.display = 'none';
    const w = e.target.closest('.w'); if (w && P.status === 'ready') { snap(); const i = +w.dataset.i; P.words[i].del = !P.words[i].del; save(); draw(); }
  }, 10);
});
$('#tool').onclick = e => {
  const a = e.target.dataset.a; if (!a || !selIdx) return; const [i, j] = selIdx;
  $('#tool').style.display = 'none'; getSelection().removeAllRanges();
  if (a === 'play') return playFrom(i, j);
  snap();
  if (a === 'short') P.shorts.push({ title: titleAt(i), a: i, b: j });
  else for (let k = i; k <= j; k++) P.words[k].del = (a === 'cut');
  save(); draw();
};
document.addEventListener('scroll', () => $('#tool').style.display = 'none', true);
const titleAt = a => P.words.slice(a, a + 6).map(w => w.w).join(' ').replace(/[,.]$/, '') + '…';

// ---------- playback that follows your edit
const V = $('#vid');
function playFrom(a, b) { playRange = [a, b]; V.currentTime = P.words[a].s; V.play(); }
$('#playEdit').onclick = () => { if (!P || !P.words.length) return; playRange = null; const f = P.words.findIndex(w => !w.del); V.currentTime = f >= 0 ? Math.max(0, P.words[f].s - 0.05) : 0; V.play(); };
let lastCur = -1;
(function tick() {
  if (P && P.words.length && P.status === 'ready') {
    const t = V.currentTime, W = P.words; const i = W.findIndex(w => t < w.e + 0.02);
    if (!V.paused) {
      if (playRange && (i === -1 || i > playRange[1])) { V.pause(); playRange = null; }
      else if ($('#skip').checked && i >= 0 && W[i].del && t >= W[i].s - 0.03) { let j = i; while (j < W.length && W[j].del) j++; if (j >= W.length) V.pause(); else V.currentTime = W[j].s - 0.03; }
      else if ($('#skip').checked && i > 0 && !W[i].del && t < W[i].s - 0.5 && t > W[i - 1].e + 0.45) V.currentTime = W[i].s - 0.08;
    }
    if (i !== lastCur) {
      const old = document.querySelector('.w.cur'); if (old) old.classList.remove('cur');
      const el = document.querySelector(`.w[data-i="${i}"]`);
      if (el) { el.classList.add('cur'); const T = $('#transcript'); if (el.offsetTop - T.scrollTop > T.clientHeight - 40 || el.offsetTop < T.scrollTop) T.scrollTop = el.offsetTop - 60; }
      lastCur = i;
    }
  }
  requestAnimationFrame(tick);
})();

// ---------- chat brain
const NUM = { ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, 'a minute': 60, 'one minute': 60 };
const STOP = new Set(['the', 'and', 'about', 'for', 'with', 'that', 'this', 'where', 'talk', 'part', 'bit']);
function bestWindow(S, target, topic) {
  const W = P.words; const kw = (topic || '').toLowerCase().match(/[a-z0-9']+/g)?.filter(k => k.length > 2 && !STOP.has(k)) || [];
  let best = null, sb = -Infinity;
  for (let i = 0; i < S.length; i++) {
    let j = i; while (j + 1 < S.length && W[S[j + 1].b].e - W[S[i].a].s <= target * 1.2 && S[j + 1].a === S[j].b + 1) j++;
    const txt = W.slice(S[i].a, S[j].b + 1).map(w => w.w.toLowerCase()).join(' ');
    const hits = kw.reduce((n, k) => n + (txt.split(k).length - 1), 0);
    const dur = W[S[j].b].e - W[S[i].a].s;
    const sc = hits * 100 - Math.abs(dur - target);
    if (sc > sb) { sb = sc; best = { a: S[i].a, b: S[j].b, dur, hits }; }
  }
  return best;
}
function brain(msg) {
  const m = msg.toLowerCase().trim(), W = P.words, st = P.style, acts = [];
  if (/\bundo\b/.test(m)) return undo() ? 'Undone. Back to how it was before your last change.' : 'Nothing to undo yet.';
  snap();
  if (/\b(um+s?|uh+s?|fillers?|erm)\b/.test(m)) { let n = 0; W.forEach(w => { if (isFill(w.w) && !w.del) { w.del = true; n++; } }); acts.push(n ? `cut ${n} filler word${n > 1 ? 's' : ''}` : 'found no filler words left to cut'); }
  if (/(silence|pause|dead air|tighten)/.test(m)) acts.push('tightened the pauses (any gap over half a second gets trimmed when you export)');
  const quoted = [...msg.matchAll(/["“'‘]([^"”'’]{2,})["”'’]/g)].map(x => x[1]);
  if (quoted.length && /\b(delete|remove|cut|drop)\b/.test(m) && !/\b(hook|title)\b/.test(m)) {
    quoted.forEach(ph => { const toks = ph.split(/\s+/).map(norm); let found = 0;
      for (let i = 0; i + toks.length <= W.length; i++) if (toks.every((t, k) => norm(W[i + k].w) === t)) { for (let k = 0; k < toks.length; k++) W[i + k].del = true; found++; }
      acts.push(found ? `cut "${ph}" (${found}x)` : `couldn't find "${ph}" in what you said`); });
  }
  const fl = m.match(/(first|last) (sentence|line)/);
  if (fl && /\b(delete|remove|cut|drop)\b/.test(m) && P.sentences.length) { const s = P.sentences[fl[1] === 'first' ? 0 : P.sentences.length - 1]; for (let i = s.a; i <= s.b; i++) W[i].del = true; acts.push(`cut the ${fl[1]} sentence`); }
  if (/\b(shorts?|clips?|reels?|tiktoks?)\b/.test(m) && /\b(make|create|cut|pull|give|find|generate|get)\b/.test(m)) {
    let target = 30; const n = m.match(/(\d+)\s*(s\b|sec|second)/) || m.match(/(\d+)\s*(min|minute)/);
    if (n) target = +n[1] * (n[2].startsWith('min') ? 60 : 1); else for (const k in NUM) if (m.includes(k + ' sec') || m.includes(k + '-sec') || (k.includes('minute') && m.includes(k))) target = NUM[k];
    let count = 1; const c = m.match(/\b(\d|two|three|four|five)\s+(shorts|clips|reels|tiktoks)/); if (c) count = { two: 2, three: 3, four: 4, five: 5 }[c[1]] || +c[1] || 1;
    const t = m.match(/\b(?:about|on|covering)\s+(.+)/); const topic = t ? t[1].replace(/\b\d+\s*(s|sec|seconds?|min|minutes?)\b/g, '').trim() : null;
    let S = P.sentences.slice(); const made = [];
    for (let k = 0; k < Math.min(count, 5) && S.length; k++) {
      const b = bestWindow(S, target, topic); if (!b) break;
      P.shorts.push({ title: titleAt(b.a), a: b.a, b: b.b }); made.push(Math.round(b.dur) + 's');
      S = S.filter(s => s.b < b.a || s.a > b.b);
    }
    acts.push(made.length ? `made ${made.length} short${made.length > 1 ? 's' : ''}${topic ? ` about "${topic}"` : ''} (${made.join(', ')}). They're under Shorts` : "couldn't find a good section for a short");
    if (!/16:9|1:1|square|landscape/.test(m)) st.aspect = '9:16';
  }
  if (/(16:9|landscape|horizontal|widescreen|youtube video)/.test(m)) { st.aspect = '16:9'; acts.push('set the format to 16:9'); }
  else if (/(1:1|square)/.test(m)) { st.aspect = '1:1'; acts.push('set the format to 1:1 square'); }
  else if (/(9:16|vertical|portrait)/.test(m)) { st.aspect = '9:16'; acts.push('set the format to 9:16 vertical'); }
  if (/caption/.test(m)) {
    if (/\b(no|off|remove|hide|without|disable)\b/.test(m)) { st.captions = false; acts.push('turned captions off'); }
    else { st.captions = true; const n = m.match(/(\d)\s*words?/); if (n) st.wpl = +n[1]; acts.push('captions are on' + (n ? `, ${st.wpl} word${st.wpl > 1 ? 's' : ''} at a time` : '')); }
  }
  const h = msg.match(/\b(hook|title|headline)\b[^"“']*["“']([^"”']+)["”']/i) || msg.match(/\b(hook|title|headline)\s*(?:to|:|=|is)\s*(.+)$/i);
  if (/\b(remove|no|delete)\s+(the\s+)?(hook|title)/.test(m)) { st.hook = ''; acts.push('removed the hook title'); }
  else if (h) { st.hook = h[2].trim().slice(0, 60); acts.push(`set the hook title to "${st.hook}"`); }
  if (/\b(crop|zoom|fill the screen)\b/.test(m)) { st.fit = 'crop'; acts.push('switched to a full crop with no blurred bars'); }
  if (/\bblur/.test(m)) { st.fit = 'blur'; acts.push('switched to the blurred background'); }
  if (/\b(restore|bring back|reset)\b.*\b(all|everything)\b/.test(m)) { W.forEach(w => w.del = false); acts.push('brought back every word you cut'); }
  if (/\b(export|render|download)\b/.test(m)) acts.push('__export__');
  if (!acts.length) { history.pop();
    return 'I can do these right now: "remove the ums", "cut \'you know\'", "delete the first sentence", "make 3 shorts of 30 seconds", "make a short about pricing", "hook: 3 logo mistakes", "captions off", "make it 16:9", "undo" and "export". You can also click or highlight words in the transcript.'; }
  return acts;
}
async function send(text) {
  if (!P || P.status !== 'ready') { alert('Drop in a video first and wait for the transcript.'); return; }
  P.chat.push({ role: 'you', text });
  let r = brain(text), doExport = false;
  if (Array.isArray(r)) { doExport = r.includes('__export__'); r = r.filter(a => a !== '__export__');
    r = (r.length ? 'Done: ' + r.join('; ') + '.' : '') + (doExport ? (r.length ? ' ' : '') + 'Exporting your full edit now.' : ''); }
  P.chat.push({ role: 'ai', text: r.replace(/\.\./g, '.') }); save(); draw();
  if (doExport) exportMain();
}
$('#chatform').onsubmit = e => { e.preventDefault(); const t = $('#chatin').value.trim(); if (t) { $('#chatin').value = ''; send(t); } };
document.querySelectorAll('.chip').forEach(c => c.onclick = () => send(c.dataset.c));

// ---------- export (real-time render in the browser)
function intervalsFrom(idxs, maxGap = 0.45, pad = 0.08) {
  const W = P.words, iv = [], groups = [];
  for (const i of idxs) {
    const w = W[i]; let s = Math.max(0, w.s - pad); const e = w.e + pad;
    const contiguous = groups.length && i === groups[groups.length - 1].at(-1) + 1;
    if (iv.length && contiguous && s - iv.at(-1)[1] <= maxGap) { iv.at(-1)[1] = Math.max(iv.at(-1)[1], e); groups.at(-1).push(i); }
    else { if (iv.length && s < iv.at(-1)[1]) s = iv.at(-1)[1]; iv.push([s, e]); groups.push([i]); }
  }
  const caps = []; let t = 0;
  iv.forEach(([a, b], k) => { groups[k].forEach(i => caps.push({ w: W[i].w, s: Math.max(0, W[i].s - a + t), e: W[i].e - a + t })); t += b - a; });
  return { iv, caps, dur: t };
}
function capGroups(caps, n) {
  const G = []; let g = [];
  caps.forEach(w => { g.push(w); if (g.length >= n || /[.!?,]$/.test(w.w)) { G.push(g); g = []; } }); if (g.length) G.push(g);
  return G.map((g, i) => ({ words: g, s: g[0].s, e: i + 1 < G.length ? G[i + 1][0].s : g.at(-1).e + 0.3 }));
}
const small = document.createElement('canvas'); small.width = 54; small.height = 96; const sctx = small.getContext('2d');
function drawFrame(ctx, v, W, H, fit) {
  const vw = v.videoWidth, vh = v.videoHeight; if (!vw) return;
  const sar = vw / vh, dar = W / H;
  ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
  if (Math.abs(sar - dar) < 0.02) { ctx.drawImage(v, 0, 0, W, H); return; }
  if (fit === 'blur') {
    small.width = Math.round(W / 20); small.height = Math.round(H / 20);
    const s0 = Math.max(small.width / vw, small.height / vh); sctx.drawImage(v, (small.width - vw * s0) / 2, (small.height - vh * s0) / 2, vw * s0, vh * s0);
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high'; ctx.drawImage(small, 0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.fillRect(0, 0, W, H);
    if (sar > dar) { const fh = W / sar; ctx.drawImage(v, 0, (H - fh) / 2, W, fh); } else { const fw = H * sar; ctx.drawImage(v, (W - fw) / 2, 0, fw, H); }
  } else { const s = Math.max(W / vw, H / vh); ctx.drawImage(v, (W - vw * s) / 2, (H - vh * s) / 2, vw * s, vh * s); }
}
function drawCaps(ctx, G, t, W, H, st) {
  const k = W / 1080;
  if (st.hook && t < 3.2) {
    const fs = (H > W ? 76 : 60) * k; ctx.font = `${fs}px Anton, Impact, sans-serif`; const txt = st.hook.toUpperCase();
    let tw = ctx.measureText(txt).width; const maxw = W * 0.86; const sc = Math.min(1, maxw / tw); ctx.font = `${fs * sc}px Anton, Impact, sans-serif`; tw = ctx.measureText(txt).width;
    const y = H * (H > W ? 0.12 : 0.08), padX = 30 * k, padY = 18 * k;
    ctx.fillStyle = 'rgba(0,0,0,.85)'; ctx.fillRect((W - tw) / 2 - padX, y - padY, tw + padX * 2, fs * sc + padY * 2);
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'top'; ctx.textAlign = 'center'; ctx.fillText(txt, W / 2, y + 2 * k);
  }
  if (!st.captions) return;
  const g = G.find(g => t >= g.s && t < g.e); if (!g) return;
  let ai = -1; g.words.forEach((w, i) => { if (t >= w.s) ai = i; });
  let fs = (H > W ? 88 : 66) * k; const words = g.words.map(w => w.w.toUpperCase().replace(/[,.]+$/, ''));
  ctx.textBaseline = 'alphabetic'; ctx.textAlign = 'left';
  const setF = () => ctx.font = `900 ${fs}px Montserrat, Arial Black, sans-serif`; setF();
  const space = () => ctx.measureText(' ').width;
  let total = words.reduce((n, w) => n + ctx.measureText(w).width, 0) + space() * (words.length - 1);
  if (total > W * 0.88) { fs *= (W * 0.88) / total; setF(); total = words.reduce((n, w) => n + ctx.measureText(w).width, 0) + space() * (words.length - 1); }
  const y = H - H * (H > W ? 0.27 : 0.09); let x = (W - total) / 2;
  ctx.lineJoin = 'round'; ctx.lineWidth = fs * 0.16;
  words.forEach((w, i) => {
    const ww = ctx.measureText(w).width;
    ctx.strokeStyle = 'rgba(0,0,0,.95)'; ctx.strokeText(w, x, y);
    ctx.fillStyle = i === ai ? st.color : '#fff'; ctx.fillText(w, x, y);
    x += ww + space();
  });
}
function pickMime() {
  const opts = ['video/mp4;codecs=avc1.640028,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  return opts.find(o => window.MediaRecorder && MediaRecorder.isTypeSupported(o));
}
const once = (el, ev) => new Promise(r => el.addEventListener(ev, r, { once: true }));
let cancelRender = false;
$('#rcancel').onclick = () => { cancelRender = true; };
async function render(idxs, label) {
  if (!idxs.length) { alert('Nothing left to export: every word is cut.'); return; }
  const mime = pickMime(); if (!mime) { alert('This browser cannot record video. Please use Chrome or Edge.'); return; }
  await document.fonts.load('900 80px Montserrat'); await document.fonts.load('80px Anton');
  const st = { ...P.style }; const [W, H] = ASPECTS[st.aspect];
  const { iv, caps, dur } = intervalsFrom(idxs); const G = capGroups(caps, st.wpl || 3);
  const v = document.createElement('video'); v.src = videoURL; v.playsInline = true; v.preload = 'auto'; v.crossOrigin = 'anonymous';
  await once(v, 'loadedmetadata');
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H; const ctx = cv.getContext('2d');
  const ac = new AudioContext(); await ac.resume(); const src = ac.createMediaElementSource(v); const dest = ac.createMediaStreamDestination(); src.connect(dest);
  const stream = cv.captureStream(30); dest.stream.getAudioTracks().forEach(t => stream.addTrack(t));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 10_000_000, audioBitsPerSecond: 192_000 });
  const chunks = []; rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
  $('#rendering').style.display = 'grid'; $('#rtitle').textContent = 'RENDERING ' + label.toUpperCase();
  const prev = $('#rprev'); prev.innerHTML = ''; cv.style.height = '60vh'; prev.appendChild(cv);
  cancelRender = false; let base = 0, curA = iv[0][0], live = true;
  const paint = () => { drawFrame(ctx, v, W, H, st.fit); const t = base + Math.max(0, v.currentTime - curA); drawCaps(ctx, G, t, W, H, st); $('#rbar').style.width = Math.min(100, t / dur * 100) + '%'; };
  const loop = () => { if (!live) return; paint(); requestAnimationFrame(loop); }; requestAnimationFrame(loop);
  try {
    for (let k = 0; k < iv.length && !cancelRender; k++) {
      const [a, b] = iv[k]; curA = a; v.currentTime = a; await once(v, 'seeked'); paint();
      if (k === 0) rec.start(250); else rec.resume();
      await v.play();
      await new Promise(res => { const chk = () => { if (cancelRender || v.currentTime >= b || v.ended) res(); else setTimeout(chk, 8); }; chk(); });
      v.pause(); paint(); rec.pause(); base += b - a;
    }
  } finally {
    live = false; const stopped = once(rec, 'stop'); if (rec.state !== 'inactive') rec.stop(); await stopped; ac.close();
    $('#rendering').style.display = 'none';
  }
  if (cancelRender) return;
  const ext = mime.includes('mp4') ? 'mp4' : 'webm';
  const blob = new Blob(chunks, { type: mime.split(';')[0] });
  const file = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) + '-' + st.aspect.replace(':', 'x') + '.' + ext;
  exportsList.unshift({ label, url: URL.createObjectURL(blob), file, dur, aspect: st.aspect, ext });
  drawExports();
}
function exportMain() { render(P.words.map((w, i) => w.del ? -1 : i).filter(i => i >= 0), 'Full edit'); }
function exportShort(k) { const s = P.shorts[k]; const idx = []; for (let i = s.a; i <= s.b; i++) if (!P.words[i].del) idx.push(i); render(idx, s.title.replace('…', '')); }
$('#exportMain').onclick = exportMain;

// ---------- restore last project on this laptop
(async () => {
  drawChat(); drawShorts();
  try {
    const [p, vid] = await Promise.all([kvGet('project'), kvGet('video')]);
    if (p && vid && p.status === 'ready') { P = p; videoURL = URL.createObjectURL(vid); $('#vid').src = videoURL; show(); draw(); }
  } catch (_) {}
})();
