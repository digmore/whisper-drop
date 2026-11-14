const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ffmpegPath = require('ffmpeg-static');

const ROOT = path.join(__dirname, '..');
const SERVER_EXE = path.join(ROOT, 'bin', 'whisper', 'whisper-server.exe');
const MODEL_DIR = path.join(ROOT, 'models');
const DEFAULT_MODEL = 'ggml-large-v3-turbo-q5_0.bin';
const PORT = 8178;

let win;
let serverProc = null;

const defaults = {
  backend: 'whispercpp', // 'whispercpp' | 'openai'
  baseUrl: `http://127.0.0.1:${PORT}`,
  model: 'whisper-1', // only used by the openai-compatible backend
  language: 'auto',
  autoStart: true,
  autosave: false,
  format: 'srt', // 'txt' | 'srt' | 'vtt' (used by autosave)
  outputDir: '', // '' = next to the source file
  skipExisting: false, // autosave only: skip files whose transcript already exists
};

// Extensions picked up when walking a dropped folder. Files dropped explicitly are always accepted.
// (.ts is left out on purpose: it is far more likely TypeScript than MPEG transport stream.)
const MEDIA_EXT = new Set([
  '.mp3', '.wav', '.m4a', '.flac', '.ogg', '.oga', '.opus', '.aac', '.wma', '.aiff', '.aif', '.mka',
  '.mp4', '.m4v', '.mkv', '.mov', '.webm', '.avi', '.wmv', '.flv', '.mpg', '.mpeg', '.3gp',
]);
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

let currentJobId = null;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}
function loadSettings() {
  try {
    return { ...defaults, ...JSON.parse(fs.readFileSync(settingsFile(), 'utf8')) };
  } catch {
    return { ...defaults };
  }
}
function saveSettings(s) {
  fs.mkdirSync(path.dirname(settingsFile()), { recursive: true });
  fs.writeFileSync(settingsFile(), JSON.stringify(s, null, 2));
}

function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 720,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'index.html'));
}

// ---- whisper.cpp server management ----

function serverAvailable() {
  return fs.existsSync(SERVER_EXE) && fs.existsSync(path.join(MODEL_DIR, DEFAULT_MODEL));
}

async function isUp(baseUrl) {
  try {
    const r = await fetch(baseUrl, { signal: AbortSignal.timeout(1500) });
    return r.status < 500;
  } catch {
    return false;
  }
}

async function ensureServer(settings) {
  if (await isUp(settings.baseUrl)) return { ok: true, started: false };
  if (settings.backend !== 'whispercpp' || !settings.autoStart) {
    return { ok: false, error: `No server responding at ${settings.baseUrl}` };
  }
  if (!serverAvailable()) {
    return {
      ok: false,
      error: 'whisper-server or model not found. Run "npm run setup" or point Base URL at a running server.',
    };
  }
  if (!serverProc) {
    serverProc = spawn(
      SERVER_EXE,
      ['-m', path.join(MODEL_DIR, DEFAULT_MODEL), '--host', '127.0.0.1', '--port', String(PORT), '-fa', '-pp'],
      { cwd: path.dirname(SERVER_EXE), windowsHide: true }
    );
    serverProc.on('exit', () => (serverProc = null));
    // With -pp the server prints "progress =  49%" to stderr for the request in flight.
    serverProc.stderr.on('data', (d) => {
      const m = [...d.toString().matchAll(/progress\s*=\s*(\d+)%/g)];
      if (m.length && currentJobId !== null) {
        win?.webContents.send('progress', { id: currentJobId, phase: 'transcribe', pct: Number(m[m.length - 1][1]) });
      }
    });
  }
  for (let i = 0; i < 60; i++) {
    if (await isUp(settings.baseUrl)) return { ok: true, started: true };
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { ok: false, error: 'whisper-server did not become ready in 60s' };
}

// ---- audio extraction ----

function extractAudio(input, output) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      ffmpegPath,
      ['-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', output],
      { windowsHide: true }
    );
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + err.split('\n').slice(-4).join('\n')))
    );
  });
}

// ---- transcription ----

async function callServer(settings, wavPath) {
  const buf = await fs.promises.readFile(wavPath);
  const form = new FormData();
  form.append('file', new Blob([buf], { type: 'audio/wav' }), 'audio.wav');
  form.append('response_format', 'verbose_json');
  form.append('temperature', '0.0');
  if (settings.language && settings.language !== 'auto') form.append('language', settings.language);

  let url;
  if (settings.backend === 'openai') {
    url = settings.baseUrl.replace(/\/$/, '') + '/v1/audio/transcriptions';
    form.append('model', settings.model);
  } else {
    url = settings.baseUrl.replace(/\/$/, '') + '/inference';
  }

  const res = await fetch(url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Server returned ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json();
  const segments = (json.segments || []).map((s) => ({
    start: s.start,
    end: s.end,
    text: String(s.text || '').trim(),
  }));
  return { text: (json.text || '').trim(), segments };
}

ipcMain.handle('settings:get', () => ({ ...loadSettings(), serverAvailable: serverAvailable() }));
ipcMain.handle('dialog:chooseDir', async (_e, { title, useOutputDir } = {}) => {
  const cur = useOutputDir ? loadSettings().outputDir : '';
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: title || 'Choose folder',
    properties: useOutputDir ? ['openDirectory', 'createDirectory'] : ['openDirectory'],
    defaultPath: cur || undefined,
  });
  return canceled ? null : filePaths[0];
});
ipcMain.handle('settings:set', (_e, s) => {
  saveSettings({ ...loadSettings(), ...s });
  return true;
});

// Recursively collect media files. Dirent.isDirectory() is false for symlinks/junctions,
// so link loops cannot occur; hidden entries are skipped; order is natural ("2" before "10").
async function walk(dir, out) {
  let ents;
  try {
    ents = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable folder: skip
  }
  ents.sort((a, b) => collator.compare(a.name, b.name));
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.isFile() && MEDIA_EXT.has(path.extname(e.name).toLowerCase())) out.push(p);
  }
}

// Turns dropped paths (files and/or folders) into jobs. `relDir` is the file's folder relative to
// the PARENT of the dropped folder, so dropping "Course" mirrors as <out>/Course/Lesson 1/.
ipcMain.handle('expand', async (_e, paths) => {
  const entries = [];
  const empty = [];
  for (const p of paths) {
    let st;
    try {
      st = await fs.promises.stat(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      const found = [];
      await walk(p, found);
      if (!found.length) empty.push(p);
      const base = path.dirname(p);
      for (const f of found) {
        const rel = path.relative(base, f);
        entries.push({ filePath: f, rel, relDir: path.dirname(rel) });
      }
    } else if (st.isFile()) {
      entries.push({ filePath: p, rel: path.basename(p), relDir: '' });
    }
  }
  // Same base name in the same folder with different extensions (intro.mp3 + intro.mp4):
  // keep the extension in the transcript name so they don't collide.
  const groups = new Map();
  for (const e of entries) {
    const dirKey = e.relDir || path.dirname(e.filePath);
    const key = (dirKey + '\0' + path.parse(e.filePath).name).toLowerCase();
    groups.set(key, (groups.get(key) || 0) + 1);
    e.key = key;
  }
  for (const e of entries) {
    e.outName = groups.get(e.key) > 1 ? path.basename(e.filePath) : path.parse(e.filePath).name;
    delete e.key;
  }
  return { entries, empty };
});

// Where a transcript goes: mirrored under outputDir if set, otherwise next to the source.
function targetFor(sourcePath, kind, outputDir, relDir, outName) {
  const dir = outputDir ? path.join(outputDir, relDir || '') : path.dirname(sourcePath);
  const base = outName || path.parse(sourcePath).name;
  return { dir, base, file: path.join(dir, `${base}.${kind}`) };
}

ipcMain.handle('transcribe', async (_e, { id, filePath, relDir, outName }) => {
  const settings = loadSettings();
  if (settings.autosave && settings.skipExisting) {
    const t = targetFor(filePath, settings.format, settings.outputDir, relDir, outName);
    if (fs.existsSync(t.file)) return { ok: true, skipped: true, savedTo: t.file, segments: [], text: '' };
  }
  const tmp = path.join(os.tmpdir(), `whisper-drop-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  const phase = (p) => win?.webContents.send('progress', { id, phase: p, pct: null });
  try {
    phase('starting');
    const srv = await ensureServer(settings);
    if (!srv.ok) throw new Error(srv.error);
    phase('extract');
    await extractAudio(filePath, tmp);
    currentJobId = id;
    win?.webContents.send('progress', { id, phase: 'transcribe', pct: 0 });
    const result = await callServer(settings, tmp);
    let savedTo = null;
    if (settings.autosave) {
      try {
        savedTo = await autosave(filePath, settings.format, result, settings.outputDir, relDir, outName);
      } catch (e) {
        return { ok: true, ...result, saveError: e.message };
      }
    }
    return { ok: true, ...result, savedTo };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    currentJobId = null;
    fs.promises.unlink(tmp).catch(() => {});
  }
});

// Writes <input name>.<format> into outputDir (or next to the source if unset); never overwrites.
async function autosave(sourcePath, kind, result, outputDir, relDir, outName) {
  const t = targetFor(sourcePath, kind, outputDir, relDir, outName);
  await fs.promises.mkdir(t.dir, { recursive: true });
  let out = t.file;
  for (let n = 1; fs.existsSync(out); n++) out = path.join(t.dir, `${t.base} (${n}).${kind}`);
  await fs.promises.writeFile(out, format(kind, result), 'utf8');
  return out;
}

function ts(sec, sep) {
  const ms = Math.round(sec * 1000);
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  const f = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s}${sep}${f}`;
}

function format(kind, result) {
  if (kind === 'txt') return result.text + '\n';
  if (kind === 'srt')
    return result.segments.map((s, i) => `${i + 1}\n${ts(s.start, ',')} --> ${ts(s.end, ',')}\n${s.text}\n`).join('\n');
  if (kind === 'vtt')
    return 'WEBVTT\n\n' + result.segments.map((s) => `${ts(s.start, '.')} --> ${ts(s.end, '.')}\n${s.text}\n`).join('\n');
  throw new Error('unknown format');
}

ipcMain.handle('export', async (_e, { sourcePath, kind, result }) => {
  const parsed = path.parse(sourcePath);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: path.join(loadSettings().outputDir || parsed.dir, `${parsed.name}.${kind}`),
    filters: [{ name: kind.toUpperCase(), extensions: [kind] }],
  });
  if (canceled || !filePath) return null;
  await fs.promises.writeFile(filePath, format(kind, result), 'utf8');
  return filePath;
});

app.whenReady().then(createWindow);
app.on('before-quit', () => serverProc?.kill());
app.on('window-all-closed', () => app.quit());
