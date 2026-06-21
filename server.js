// server.js — video-merge-server
// Job-based: POST /merge -> jobId turant milta hai, background mein process hota hai,
// GET /status/:jobId se poll karo jab tak status 'done' na ho.
// ─────────────────────────────────────────────────────────────────────────────

const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const STORAGE_DIR = path.join(__dirname, 'storage');
if (!fs.existsSync(STORAGE_DIR)) fs.mkdirSync(STORAGE_DIR, { recursive: true });

// Final merged videos yahan se serve hote hain: /files/<jobId>/final.mp4
app.use('/files', express.static(STORAGE_DIR));

// ── In-memory job store ─────────────────────────────────────────────────────
const jobs = {}; // jobId -> { status, progress, total, downloadUrl, error, createdAt }

function setJob(jobId, patch) {
  jobs[jobId] = { ...(jobs[jobId] || {}), ...patch };
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
      } else if (signal) {
        // code null + signal set = process ko OS ne kill kiya — Railway pe
        // ye almost hamesha OOM (memory limit) ki wajah se hota hai.
        const hint = signal === 'SIGKILL'
          ? ' (signal SIGKILL — server memory limit se zyada use ho gayi, isliye process kill hua. Railway plan ka RAM badhao ya ffmpeg ka resource usage kam karo.)'
          : '';
        reject(new Error(`${cmd} killed by signal ${signal}${hint}: ${stderr.slice(-1500)}`));
      } else {
        reject(new Error(`${cmd} exited with code ${code}: ${stderr.slice(-1500)}`));
      }
    });
  });
}

async function downloadFile(url, destPath) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) for ${url.substring(0, 100)}`);
  const arrayBuf = await res.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(arrayBuf));
}

// ── Core pipeline ────────────────────────────────────────────────────────────
const TARGET_W = 1920;
const TARGET_H = 1080;
const TARGET_FPS = 30;

async function processJob(jobId, clips) {
  const jobDir = path.join(STORAGE_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // Step 1 — Download all clips
  setJob(jobId, { status: 'downloading', progress: 0 });
  const rawPaths = [];
  for (let i = 0; i < clips.length; i++) {
    const rawPath = path.join(jobDir, `raw_${i}.mp4`);
    await downloadFile(clips[i].url, rawPath);
    rawPaths.push(rawPath);
    setJob(jobId, { progress: Math.round(((i + 1) / clips.length) * 30) }); // 0-30%
  }

  // Step 2 — Trim (agar zaroori ho) + normalize har clip ek common
  // format/resolution/fps mein, taake concat mein fail na ho.
  setJob(jobId, { status: 'processing' });
  const normPaths = [];
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const inPath = rawPaths[i];
    const outPath = path.join(jobDir, `norm_${i}.mp4`);

    const args = ['-y', '-i', inPath];

    // Avatar clips poori rakho. Stock-footage jo trim hui thi, sirf
    // [0, trimEnd] tak kaato — sceneDuration/trimEnd extension se aata hai.
    if (clip.trimNeeded && clip.trimEnd) {
      args.push('-t', String(clip.trimEnd));
    }

    args.push(
      '-vf', `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=${TARGET_FPS}`,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-threads', '2', '-x264-params', 'threads=2:lookahead_threads=1',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      outPath
    );

    await run('ffmpeg', args);
    normPaths.push(outPath);
    setJob(jobId, { progress: 30 + Math.round(((i + 1) / clips.length) * 50) }); // 30-80%
  }

  // Step 3 — Concat (sab ek hi format mein hain ab, isliye -c copy safe hai)
  setJob(jobId, { status: 'merging', progress: 85 });
  const listFile = path.join(jobDir, 'concat_list.txt');
  const listContent = normPaths
    .map(p => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listFile, listContent);

  const finalPath = path.join(jobDir, 'final.mp4');
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', finalPath]);

  // Cleanup intermediate files (sirf final.mp4 rakho, disk space bachao)
  for (const p of [...rawPaths, ...normPaths, listFile]) {
    try { fs.unlinkSync(p); } catch (_) {}
  }

  setJob(jobId, {
    status: 'done',
    progress: 100,
    downloadUrl: `/files/${jobId}/final.mp4`
  });
}

// ── Routes ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ ok: true, service: 'video-merge-server' });
});

app.post('/merge', (req, res) => {
  const { clips } = req.body || {};

  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: 'clips array required: [{url, type, trimEnd, trimNeeded}, ...]' });
  }
  for (const c of clips) {
    if (!c.url) return res.status(400).json({ error: 'Har clip mein url chahiye' });
  }

  const jobId = uuidv4();
  setJob(jobId, {
    status: 'queued',
    progress: 0,
    total: clips.length,
    createdAt: Date.now()
  });

  res.json({ jobId });

  // Background mein process karo, response pehle hi bhej diya
  processJob(jobId, clips).catch(err => {
    console.error(`[Job ${jobId}] FAILED:`, err.message);
    setJob(jobId, { status: 'error', error: err.message });
  });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

// ── Old job cleanup (disk space bachane ke liye) ───────────────────────────
const MAX_JOB_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

function cleanupOldJobs() {
  const now = Date.now();
  for (const jobId of Object.keys(jobs)) {
    const job = jobs[jobId];
    if (job.createdAt && now - job.createdAt > MAX_JOB_AGE_MS) {
      const jobDir = path.join(STORAGE_DIR, jobId);
      fs.rm(jobDir, { recursive: true, force: true }, () => {});
      delete jobs[jobId];
      console.log(`[Cleanup] Removed old job ${jobId}`);
    }
  }
}
setInterval(cleanupOldJobs, 30 * 60 * 1000); // har 30 min check karo

// ── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`video-merge-server listening on port ${PORT}`);
});
