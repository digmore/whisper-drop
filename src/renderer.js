const $ = (id) => document.getElementById(id);
const drop = $('drop');
const jobsEl = $('jobs');
const queue = [];
let running = false;

// ---- settings ----
(async () => {
  const s = await window.api.getSettings();
  $('lang').value = s.language;
  $('backend').value = s.backend;
  $('baseUrl').value = s.baseUrl;
  $('autosave').checked = s.autosave;
  document.querySelector(`input[name=format][value=${s.format}]`).checked = true;
  outputDir = s.outputDir || '';
  syncFormats();
})();
let outputDir = '';
function syncFormats() {
  const on = $('autosave').checked;
  $('formats').disabled = !on;
  $('outdir').disabled = !on;
  $('dirLabel').textContent = outputDir || 'next to source file';
  $('dirLabel').title = outputDir;
  $('clearDir').hidden = !outputDir;
}
$('chooseDir').addEventListener('click', async () => {
  const dir = await window.api.chooseDir();
  if (dir) { outputDir = dir; saveSettings(); }
});
$('clearDir').addEventListener('click', () => { outputDir = ''; saveSettings(); });
function saveSettings() {
  window.api.setSettings({
    language: $('lang').value,
    backend: $('backend').value,
    baseUrl: $('baseUrl').value,
    autosave: $('autosave').checked,
    outputDir,
    format: document.querySelector('input[name=format]:checked').value,
  });
  syncFormats();
}
for (const id of ['lang', 'backend', 'baseUrl', 'autosave']) $(id).addEventListener('change', saveSettings);
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
window.addEventListener('drop', (e) => addFiles(e.dataTransfer.files));
drop.addEventListener('click', () => $('picker').click());
$('picker').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

function addFiles(files) {
  for (const f of files) {
    const p = window.api.pathFor(f);
    if (!p) continue;
    const job = makeJob(p, f.name);
    queue.push(job);
  }
  pump();
}

// ---- jobs ----
const jobs = new Map();
let nextId = 1;

function makeJob(filePath, name) {
  const el = document.createElement('div');
  el.className = 'job';
  el.innerHTML = `<div class="job-head"><span class="name"></span><span class="status">queued</span></div><div class="bar"><i></i></div>`;
  el.querySelector('.name').textContent = name;
  jobsEl.prepend(el);
  const job = { id: nextId++, filePath, el, status: el.querySelector('.status'), bar: el.querySelector('.bar') };
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
  while (queue.length) {
    const job = queue.shift();
    setStatus(job, 'transcribing…', 'running');
    const res = await window.api.transcribe({ id: job.id, filePath: job.filePath });
    jobs.delete(job.id);
    if (!res.ok) {
      setStatus(job, 'failed', 'error');
      job.bar.remove();
      const d = document.createElement('div');
      d.className = 'err';
      d.textContent = res.error;
      job.el.append(d);
      continue;
    }
    setStatus(job, `done · ${res.segments.length} segments`, 'done');
    job.bar.className = 'bar done';
    job.bar.firstChild.style.width = '';
    if (res.savedTo || res.saveError) {
      const d = document.createElement('div');
      d.className = res.saveError ? 'err' : 'saved';
      d.textContent = res.saveError ? 'Autosave failed: ' + res.saveError : 'Saved → ' + res.savedTo;
      job.el.append(d);
    }
    renderResult(job, res);
  }
  running = false;
}

function fmt(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function renderResult(job, res) {
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
  actions.append(copy);

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
  job.el.append(actions, text);
}
