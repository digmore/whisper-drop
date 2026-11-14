// Screenshot capture for video files: decide *when* to grab stills, grab them with ffmpeg,
// and build the Markdown transcript that interleaves them with the speech.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

// Analysis frames: 1 per second, downscaled with area averaging (which also acts as a blur) to
// 8-bit grayscale. Small enough to diff in JS, big enough to see a line of typed text.
const W = 320;
const H = 180;
const N = W * H;

// Tuning knobs per preset. These are starting points, not gospel; see README.
//   delta       per-pixel luma difference (0-255) that counts as "this pixel changed"
//   frac        fraction of pixels that must differ from the last kept frame to count as a change
//   stableFrac  frame-to-frame change below this means the picture has settled
//   settle      seconds the picture must hold still before we capture it
//   maxWait     give up waiting for stillness after this long (continuous motion) and capture anyway
//   minGap      never capture more often than this (seconds)
//   maxGap      safety net: capture at least this often even if nothing changed (seconds)
const PRESETS = {
  slides: { delta: 24, frac: 0.04, stableFrac: 0.003, settle: 1, maxWait: 8, minGap: 2, maxGap: Infinity },
  screen: { delta: 16, frac: 0.02, stableFrac: 0.002, settle: 2, maxWait: 8, minGap: 4, maxGap: 60 },
};

// The maxGap safety net uses a much finer comparison than normal change detection, and only fires
// if something really did change. Otherwise a static screen would yield a copy of itself every minute.
const FINE_DELTA = 8;
const FINE_FRAC = 0.001;

function track(active, proc) {
  active?.procs.add(proc);
  proc.on('close', () => active?.procs.delete(proc));
}

// Runs ffmpeg to completion, collecting stderr.
function runFfmpeg(ffmpegPath, args, active) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args, { windowsHide: true });
    track(active, p);
    let err = '';
    p.stderr.on('data', (d) => (err += d.toString()));
    p.on('error', reject);
    p.on('close', (code) => resolve({ code, stderr: err }));
  });
}

// Finds out whether the file has a real video stream (cover art does not count) and its duration.
async function probe(ffmpegPath, file) {
  const { stderr } = await runFfmpeg(ffmpegPath, ['-hide_banner', '-i', file]);
  const streams = stderr.match(/Stream #\d+:\d+[^\n]*: Video:[^\n]*/g) || [];
  const hasVideo = streams.some((s) => !/attached pic/i.test(s));
  const m = stderr.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  const duration = m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
  return { hasVideo, duration };
}

function planInterval(duration, interval) {
  if (!duration) throw new Error('could not determine video duration for interval capture');
  const times = [Math.min(1, duration / 2)];
  for (let t = interval; t < duration; t += interval) times.push(t);
  return times;
}

// Scene-change planning: stream 1 fps grayscale frames out of ffmpeg and walk them through a small
// state machine. Compares against the last *kept* frame (not the previous one) so slow fades cannot
// creep under the threshold, then waits for the picture to settle so mid-transition frames are
// skipped. Returns capture times in seconds.
function planScene(ffmpegPath, file, duration, p, active, onProgress) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      ffmpegPath,
      ['-v', 'error', '-i', file, '-map', '0:v:0', '-an', '-sn',
        '-vf', `fps=1,scale=${W}:${H}:flags=area,format=gray`, '-f', 'rawvideo', '-'],
      { windowsHide: true }
    );
    track(active, proc);

    const shots = [];
    const kept = []; // every frame we have captured; new candidates are checked against all of them
    let ref = null; // the state the viewer last saw: the last kept frame, or a later look-alike of an older one
    let prev = null;
    let pending = null; // { since, stableFrom, forced }
    let lastShot = -Infinity;
    let nextForcedAt = p.maxGap; // earliest time the safety net may look again
    let lastDRef = 0;
    let k = -1;
    let buf = Buffer.alloc(0);
    let lastPct = -1;
    let err = '';

    const fracAt = (a, b, delta) => {
      let c = 0;
      for (let i = 0; i < N; i++) {
        const d = a[i] - b[i];
        if (d > delta || -d > delta) c++;
      }
      return c / N;
    };
    const frac = (a, b) => fracAt(a, b, p.delta);

    const step = (f) => {
      const t = ++k;
      const dRef = ref ? frac(f, ref) : 1;
      const dPrev = prev ? frac(f, prev) : 1;
      lastDRef = dRef;
      if (!pending) {
        if (dRef > p.frac) {
          pending = { since: t, stableFrom: t, forced: false };
        } else if (t >= nextForcedAt) {
          // Safety net: only worth a capture if something below the normal threshold changed.
          if (ref && fracAt(f, ref, FINE_DELTA) > FINE_FRAC) pending = { since: t, stableFrom: t, forced: true };
          else nextForcedAt = t + p.maxGap;
        }
      } else if (dPrev > p.stableFrac) {
        pending.stableFrom = t; // still moving: restart the stillness clock
      }
      if (pending) {
        const stableFor = t - pending.stableFrom;
        const waited = t - pending.since;
        if (stableFor >= p.settle || waited >= p.maxWait) {
          if (!pending.forced && ref && dRef <= p.frac) {
            pending = null; // flickered and came back: nothing new to show
          } else if (!pending.forced && kept.some((old) => frac(f, old) <= p.frac)) {
            // Back to something we already captured (popup closed, returned to an earlier slide):
            // don't repeat the image, but measure future changes from this state.
            ref = f;
            pending = null;
          } else if (t - lastShot >= p.minGap) {
            const ts = stableFor >= p.settle ? pending.stableFrom : t;
            shots.push(ts);
            kept.push(f);
            lastShot = ts;
            ref = f;
            nextForcedAt = ts + p.maxGap;
            pending = null;
          }
        }
      }
      prev = f;
      if (duration && onProgress) {
        const pct = Math.min(99, Math.floor((100 * t) / duration));
        if (pct !== lastPct) onProgress((lastPct = pct));
      }
    };

    proc.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= N) {
        const f = Buffer.from(buf.subarray(0, N)); // copy: frames are kept as references
        buf = buf.subarray(N);
        step(f);
      }
    });
    proc.stderr.on('data', (d) => (err += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (active?.cancelled) return resolve(shots);
      if (pending && (pending.forced || lastDRef > p.frac) && k - lastShot >= p.minGap) {
        // Video ended while still waiting to settle. Skip it if it only repeats an earlier capture.
        const last = prev;
        if (pending.forced || !last || !kept.some((old) => frac(last, old) <= p.frac)) shots.push(pending.stableFrom);
      }
      if (code !== 0 && k < 0) return reject(new Error('video analysis failed: ' + err.trim().split('\n').pop()));
      resolve(shots);
    });
  });
}

function hms(sec, sep = ':') {
  const s = Math.floor(sec);
  const parts = [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, '0'));
  return parts.join(sep);
}

// Grabs one full-resolution still per timestamp (scaled down to at most 1600 px wide, JPEG).
// Returns [{ t, name }] for the stills that were actually produced.
async function captureShots(ffmpegPath, file, times, destDir, base, active, onProgress) {
  await fs.promises.mkdir(destDir, { recursive: true });
  const out = [];
  for (let i = 0; i < times.length; i++) {
    if (active?.cancelled) throw new Error('cancelled');
    const t = times[i];
    const name = `${base}_${hms(t, '-')}.jpg`;
    const dest = path.join(destDir, name);
    await runFfmpeg(
      ffmpegPath,
      ['-y', '-v', 'error', '-ss', String(t), '-i', file, '-map', '0:v:0', '-frames:v', '1',
        '-vf', "scale='min(1600,iw)':-2", '-q:v', '3', dest],
      active
    );
    const st = await fs.promises.stat(dest).catch(() => null);
    if (st && st.size > 0) out.push({ t, name });
    onProgress?.(Math.floor((100 * (i + 1)) / times.length));
  }
  return out;
}

// Markdown links must have spaces and brackets percent-encoded to survive viewers.
function mdLink(...parts) {
  return parts.map((s) => encodeURIComponent(s).replace(/\(/g, '%28').replace(/\)/g, '%29')).join('/');
}

// A screenshot at time t goes just before the segment that is being spoken at t (or the next one),
// so each image heads the passage it illustrates.
function buildMarkdown({ title, sourceName, segments, text, shots, shotsDirName }) {
  const lines = [`# ${title}`, '', `Source: \`${sourceName}\``, ''];
  const sorted = [...shots].sort((a, b) => a.t - b.t);
  let i = 0;
  const emitUpTo = (limit) => {
    while (i < sorted.length && sorted[i].t < limit) {
      const s = sorted[i++];
      lines.push(`![${hms(s.t)}](${mdLink(shotsDirName, s.name)})`, '');
    }
  };
  if (segments.length) {
    for (const seg of segments) {
      emitUpTo(seg.end);
      lines.push(`**[${hms(seg.start)}]** ${seg.text}`, '');
    }
  } else if (text) {
    lines.push(text, '');
  }
  emitUpTo(Infinity);
  return lines.join('\n');
}

module.exports = { PRESETS, probe, planInterval, planScene, captureShots, buildMarkdown, hms };
