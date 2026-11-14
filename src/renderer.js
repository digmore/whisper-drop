const $ = (id) => document.getElementById(id);
const drop = $('drop');
const jobsEl = $('jobs');
const queue = [];
const jobs = new Map(); // in-flight jobs by id, for progress events
let nextId = 1;
let running = false;
let batchTotal = 0;
let batchDone = 0;
let batchSkipped = 0;
let batchFailed = 0;
let batchCancelled = 0;
let paused = false; // user asked to hold the queue
let holding = false; // the pump loop is actually waiting at a hold point
let epoch = 0; // bumped by Reset so a job still unwinding can't touch the fresh list
const resumeWaiters = [];

// ---- settings ----
let outputDir = '';
(async () => {
  const s = await window.api.getSettings();
  $('lang').value = s.language;
  $('backend').value = s.backend;
  $('baseUrl').value = s.baseUrl;
  $('autosave').checked = s.autosave;
  $('skipExisting').checked = s.skipExisting;
  document.querySelector(`input[name=format][value=${s.format}]`).checked = true;
  outputDir = s.outputDir || '';
  syncFormats();
})();
function syncFormats() {
  const on = $('autosave').checked;
  $('formats').disabled = !on;
  $('outdir').disabled = !on;
  $('skipExisting').disabled = !on;
  $('dirLabel').textContent = outputDir || 'next to source file';
  $('dirLabel').title = outputDir;
  $('clearDir').hidden = !outputDir;
}
$('chooseDir').addEventListener('click', async () => {
  const dir = await window.api.chooseDir({ title: 'Choose output folder', useOutputDir: true });
  if (dir) { outputDir = dir; saveSettings(); }
});
$('clearDir').addEventListener('click', () => { outputDir = ''; saveSettings(); });
function saveSettings() {
  window.api.setSettings({
    language: $('lang').value,
    backend: $('backend').value,
    baseUrl: $('baseUrl').value,
    autosave: $('autosave').checked,
    skipExisting: $('skipExisting').checked,
    outputDir,
    format: document.querySelector('input[name=format]:checked').value,
  });
  syncFormats();
}
for (const id of ['lang', 'backend', 'baseUrl', 'autosave', 'skipExisting']) $(id).addEventListener('change', saveSettings);
document.querySelectorAll('input[name=format]').forEach((r) => r.addEventListener('change', saveSettings));

// ---- progress ----
const PHASE_LABEL = { starting: 'starting server…', extract: 'extracting audio…', transcribe: 'transcribing' };
window.api.onProgress(({ id, phase, pct }) => {
  const job = jobs.get(id);
  if (!job) return;
  setStatus(job, pct == null ? PHASE_LABEL[phase] : `${PHASE_LABEL[phase]} ${pct}%`, 'running');
  job.bar.className = pct == null ? 'bar indet' : 'bar';
  job.bar.firstChild.style.width = pct == null ? '' : pct + '%';
});

// ---- drag and drop ----
['dragenter', 'dragover'].forEach((ev) =>
  window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('over'); })
);
['dragleave', 'drop'].forEach((ev) =>
  window.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('over'); })
);
// Paths must be read synchronously inside the event handler; the FileList is not valid afterwards.
function pathsOf(files) {
  return [...files].map((f) => window.api.pathFor(f)).filter(Boolean);
}
window.addEventListener('drop', (e) => addPaths(pathsOf(e.dataTransfer.files)));
drop.addEventListener('click', () => $('picker').click());
$('picker').addEventListener('change', (e) => { addPaths(pathsOf(e.target.files)); e.target.value = ''; });
$('addFolder').addEventListener('click', async (e) => {
  e.stopPropagation();
  const dir = await window.api.chooseDir({ title: 'Choose a folder to transcribe' });
  if (dir) addPaths([dir]);
});

function note(text) {
  const d = document.createElement('div');
  d.className = 'note';
  d.textContent = text;
  jobsEl.append(d);
}

async function addPaths(paths) {
  if (!paths.length) return;
  const { entries, empty } = await window.api.expand(paths);
  for (const p of empty) note(`No media files found in ${p}`);
  if (!entries.length) return;
  if (!running && !queue.length) resetCounters(); // new batch
  batchTotal += entries.length;
  for (const e of entries) queue.push(makeJob(e));
  updateSummary();
  pump();
}

function resetCounters() {
  batchTotal = batchDone = batchSkipped = batchFailed = batchCancelled = 0;
}

function updateSummary() {
  $('queuebar').hidden = batchTotal === 0;
  const extra = [
    batchSkipped && `${batchSkipped} skipped`,
    batchFailed && `${batchFailed} failed`,
    batchCancelled && `${batchCancelled} cancelled`,
  ].filter(Boolean);
  let text = `${batchDone} / ${batchTotal} finished` + (extra.length ? ` (${extra.join(', ')})` : '');
  if (paused) text += holding ? ' · paused' : ' · pausing after current file…';
  $('summary').textContent = text;
  const busy = running || queue.length > 0;
  $('pauseBtn').textContent = paused ? 'Resume' : 'Pause';
  $('pauseBtn').disabled = !busy && !paused;
  $('stopBtn').disabled = !busy;
  $('resetBtn').disabled = batchTotal === 0 && !jobsEl.children.length;
}

// ---- queue controls ----
function wakeWaiters() {
  while (resumeWaiters.length) resumeWaiters.pop()();
}

$('pauseBtn').addEventListener('click', () => {
  paused = !paused;
  if (!paused) wakeWaiters();
  updateSummary();
});

// Stop: cancel the file in flight and drop everything still queued. Finished cards stay.
async function stopAll() {
  const pending = queue.splice(0);
  for (const job of pending) {
    jobs.delete(job.id);
    job.bar.remove();
    setStatus(job, 'cancelled', 'cancelled');
    batchDone++;
    batchCancelled++;
  }
  paused = false;
  wakeWaiters();
  if (running) await window.api.cancel(); // the job in flight reports back as cancelled
  updateSummary();
}
$('stopBtn').addEventListener('click', stopAll);

// Reset: stop everything and clear the list and its progress.
$('resetBtn').addEventListener('click', async () => {
  if ((running || queue.length) && !confirm('Stop all work and clear the list?')) return;
  epoch++;
  await stopAll();
  queue.length = 0;
  jobs.clear();
  jobsEl.replaceChildren();
  resetCounters();
  updateSummary();
});

// ---- jobs ----
function makeJob(entry) {
  const el = document.createElement('div');
  el.className = 'job';
  el.innerHTML = `<div class="job-head"><span class="name"></span><span class="status">queued</span></div><div class="bar"><i></i></div>`;
  const nameEl = el.querySelector('.name');
  nameEl.textContent = entry.rel;
  nameEl.title = entry.filePath;
  jobsEl.append(el);
  const job = {
    id: nextId++, filePath: entry.filePath, relDir: entry.relDir, outName: entry.outName,
    el, status: el.querySelector('.status'), bar: el.querySelector('.bar'),
  };
  jobs.set(job.id, job);
  return job;
}

function setStatus(job, text, cls) {
  job.status.textContent = text;
  job.status.className = 'status ' + (cls || '');
}

async function pump() {
  if (running) return;
  running = true;
  updateSummary();
  while (queue.length) {
    // Pause takes effect between files: the one in flight always finishes first.
    while (paused) {
      holding = true;
      updateSummary();
      await new Promise((r) => resumeWaiters.push(r));
    }
    holding = false;
    if (!queue.length) break; // Stop/Reset emptied the queue while we were holding
    const job = queue.shift();
    const myEpoch = epoch;
    setStatus(job, 'transcribing…', 'running');
    job.el.scrollIntoView({ block: 'nearest' });
    updateSummary();
    const res = await window.api.transcribe({
      id: job.id, filePath: job.filePath, relDir: job.relDir, outName: job.outName,
    });
    if (myEpoch !== epoch) continue; // list was reset while this job unwound; discard its result
    jobs.delete(job.id);
    batchDone++;
    if (res.cancelled) {
      batchCancelled++;
      setStatus(job, 'stopped', 'cancelled');
      job.bar.remove();
    } else if (!res.ok) {
      batchFailed++;
      setStatus(job, 'failed', 'error');
      job.bar.remove();
      const d = document.createElement('div');
      d.className = 'err';
      d.textContent = res.error;
      job.el.append(d);
    } else if (res.skipped) {
      batchSkipped++;
      setStatus(job, 'skipped · transcript exists', 'done');
      job.bar.className = 'bar done';
      job.bar.firstChild.style.width = '';
      addLine(job, 'saved', 'Existing → ' + res.savedTo);
    } else {
      setStatus(job, `done · ${res.segments.length} segments`, 'done');
      job.bar.className = 'bar done';
      job.bar.firstChild.style.width = '';
      if (res.saveError) addLine(job, 'err', 'Autosave failed: ' + res.saveError);
      else if (res.savedTo) addLine(job, 'saved', 'Saved → ' + res.savedTo);
      renderResult(job, res, batchTotal === 1);
    }
    updateSummary();
  }
  running = false;
  holding = false;
  updateSummary();
}

function addLine(job, cls, text) {
  const d = document.createElement('div');
  d.className = cls;
  d.textContent = text;
  job.el.append(d);
}

function fmt(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildText(res) {
  const text = document.createElement('div');
  text.className = 'text';
  if (res.segments.length) {
    for (const s of res.segments) {
      const row = document.createElement('div');
      row.className = 'seg';
      const t = document.createElement('time');
      t.textContent = fmt(s.start);
      const span = document.createElement('span');
      span.textContent = s.text;
      row.append(t, span);
      text.append(row);
    }
  } else {
    text.textContent = res.text;
  }
  return text;
}

// The transcript body is built lazily so a batch of hundreds of files doesn't create
// hundreds of large DOM trees. A single-file drop shows it open straight away.
function renderResult(job, res, openNow) {
  const actions = document.createElement('div');
  actions.className = 'actions';
  for (const kind of ['txt', 'srt', 'vtt']) {
    const b = document.createElement('button');
    b.textContent = 'Save .' + kind;
    b.onclick = async () => {
      const out = await window.api.exportAs({ sourcePath: job.filePath, kind, result: res });
      if (out) b.textContent = 'Saved ✓';
    };
    actions.append(b);
  }
  const copy = document.createElement('button');
  copy.textContent = 'Copy text';
  copy.onclick = () => navigator.clipboard.writeText(res.text);
  const toggle = document.createElement('button');
  let textEl = null;
  const setOpen = (open) => {
    if (open && !textEl) { textEl = buildText(res); job.el.append(textEl); }
    if (textEl) textEl.hidden = !open;
    toggle.textContent = open ? 'Hide text' : 'Show text';
  };
  toggle.onclick = () => setOpen(!textEl || textEl.hidden);
  actions.append(copy, toggle);
  job.el.append(actions);
  setOpen(!!openNow);
}
