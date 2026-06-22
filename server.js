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
app.use(express.json({ limit: '10mb' }));

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

// ffprobe se clip ka width/height/fps/codec nikalo (JSON output)
function probeClip(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,codec_name',
      '-of', 'json',
      filePath
    ];
    const proc = spawn('ffprobe', args);
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed: ${stderr.slice(-500)}`));
        return;
      }
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams?.[0];
        if (!stream) {
          reject(new Error('ffprobe: no video stream found'));
          return;
        }
        // r_frame_rate aata hai "25/1" jaisa string format mein, usko number mein convert karo
        const [num, den] = (stream.r_frame_rate || '25/1').split('/').map(Number);
        const fps = den ? Math.round((num / den) * 100) / 100 : num;
        resolve({
          width: stream.width,
          height: stream.height,
          fps,
          codec: stream.codec_name
        });
      } catch (e) {
        reject(new Error(`ffprobe parse error: ${e.message}`));
      }
    });
  });
}

// ── Core pipeline ────────────────────────────────────────────────────────────
// (Target resolution/fps ab per-job dynamically decide hota hai — sabse
// common format ko target banaya jata hai taake kam se kam clips re-encode hon)

async function processJob(jobId, clips, audioClips) {
  const jobDir = path.join(STORAGE_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // Step 1 — Download all clips (strictly sequential — order preserve karna zaroori hai)
  setJob(jobId, { status: 'downloading', progress: 0 });
  console.log(`[Job ${jobId}] Clips received in order:`, clips.map((c,i) => `${i+1}:${c.type}`).join(', '));
  const rawPaths = [];
  for (let i = 0; i < clips.length; i++) {
    const rawPath = path.join(jobDir, `raw_${i}.mp4`);
    await downloadFile(clips[i].url, rawPath);
    rawPaths.push(rawPath);
    setJob(jobId, { progress: Math.round(((i + 1) / clips.length) * 20) }); // 0-20%
  }

  // Step 2 — Har clip ka asal resolution/fps/codec probe karo (ffprobe se),
  // taake pata chale konsi clips already same format mein hain — unhe
  // re-encode karne ki zaroorat nahi, sirf jo alag hain unhi ko normalize karo.
  setJob(jobId, { status: 'analyzing', progress: 22 });
  const probes = [];
  for (let i = 0; i < rawPaths.length; i++) {
    try {
      const info = await probeClip(rawPaths[i]);
      probes.push(info);
    } catch (e) {
      console.warn(`[Job ${jobId}] Probe failed for clip ${i}, will normalize as fallback:`, e.message);
      probes.push(null); // null = unknown, force normalize
    }
  }

  // Sabse common resolution/fps dhundo (jo zyada clips mein match karta hai)
  // — usi ko target bana lo, taake kam se kam clips ko touch karna pade.
  const validProbes = probes.filter(p => p !== null);
  const counts = {};
  validProbes.forEach(p => {
    const key = `${p.width}x${p.height}@${p.fps}|${p.codec}`;
    counts[key] = (counts[key] || 0) + 1;
  });
  let targetKey = null;
  let maxCount = 0;
  for (const [key, count] of Object.entries(counts)) {
    if (count > maxCount) { maxCount = count; targetKey = key; }
  }

  let TARGET_W, TARGET_H, TARGET_FPS;
  if (targetKey) {
    const [res, codec] = targetKey.split('|');
    const [wh, fps] = res.split('@');
    [TARGET_W, TARGET_H] = wh.split('x').map(Number);
    TARGET_FPS = Number(fps);
  } else {
    // Koi clip probe nahi ho saki — safe default
    TARGET_W = 1920; TARGET_H = 1080; TARGET_FPS = 30;
  }

  console.log(`[Job ${jobId}] Target format: ${TARGET_W}x${TARGET_H}@${TARGET_FPS} (${maxCount}/${clips.length} clips already match)`);

  // Step 3 — Trim (agar zaroori ho) + sirf jo clips target se mismatch hain unhi ko normalize karo.
  // Matching clips ko bas trim karo (-c copy se, fast aur lossless) ya as-is rakho.
  setJob(jobId, { status: 'processing', progress: 25 });
  const normPaths = [];
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const inPath = rawPaths[i];
    const probe = probes[i];
    const outPath = path.join(jobDir, `norm_${i}.mp4`);
    const needsTrim = !!(clip.trimNeeded && clip.trimEnd);

    const matchesTarget = probe &&
      probe.width === TARGET_W &&
      probe.height === TARGET_H &&
      Math.abs(probe.fps - TARGET_FPS) < 0.5 &&
      probe.codec === 'h264';

    const args = ['-y', '-i', inPath];
    if (needsTrim) args.push('-t', String(clip.trimEnd));

    if (matchesTarget) {
      // Already sahi format mein — bas trim karo (ya copy), re-encode mat karo.
      // Yahi step quality 100% original rakhta hai jahan possible ho.
      if (needsTrim) {
        args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', outPath);
      } else {
        // Trim bhi nahi chahiye aur format bhi match — seedha copy
        fs.copyFileSync(inPath, outPath);
        normPaths.push(outPath);
        setJob(jobId, { progress: 25 + Math.round(((i + 1) / clips.length) * 55) });
        continue;
      }
    } else {
      // increase + crop: clip ko itna scale karo ke target ko POORA bhar de
      // (chhota side match), phir extra hissa center se crop kar do.
      // Isse black bars nahi aate — bas thoda zoom-in effect hota hai.
      args.push(
        '-vf', `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase,crop=${TARGET_W}:${TARGET_H},setsar=1,fps=${TARGET_FPS}`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
        '-threads', '2', '-x264-params', 'threads=2:lookahead_threads=1',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
        outPath
      );
    }

    await run('ffmpeg', args);
    normPaths.push(outPath);
    setJob(jobId, { progress: 25 + Math.round(((i + 1) / clips.length) * 55) }); // 25-80%
  }

  // Step 3 — Har clip ke liye audio fix karo:
  // Avatar clips → apna embedded audio rakho (bilkul touch mat karo)
  // Footage clips → mute hoti hain, unpe TTS audio overlay karo
  setJob(jobId, { status: 'audio', progress: 80 });
  const audioPaths = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const inPath = normPaths[i];
    const outPath = path.join(jobDir, `audio_fixed_${i}.mp4`);

    if (clip.ownAudio !== false) {
      // Avatar clip — apna audio already sahi hai, copy karo as-is
      fs.copyFileSync(inPath, outPath);
      audioPaths.push(outPath);
      console.log(`[Job ${jobId}] Clip ${i + 1}: avatar — own audio kept`);
    } else if (clip.ttsUrl) {
      // Footage clip — TTS audio download karke is clip pe overlay karo
      const ttsPath = path.join(jobDir, `tts_${i}.wav`);
      await downloadFile(clip.ttsUrl, ttsPath);

      await run('ffmpeg', [
        '-y',
        '-i', inPath,
        '-i', ttsPath,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
        '-shortest',
        outPath
      ]);

      try { fs.unlinkSync(ttsPath); } catch (_) {}
      audioPaths.push(outPath);
      console.log(`[Job ${jobId}] Clip ${i + 1}: footage — TTS audio overlaid`);
    } else {
      // Na ownAudio na ttsUrl — as-is copy karo (silent rahega)
      fs.copyFileSync(inPath, outPath);
      audioPaths.push(outPath);
      console.log(`[Job ${jobId}] Clip ${i + 1}: no audio info — kept as-is`);
    }

    setJob(jobId, { progress: 80 + Math.round(((i + 1) / clips.length) * 10) }); // 80-90%
  }

  // Step 4 — Concat (ab har clip ka audio sahi hai)
  setJob(jobId, { status: 'merging', progress: 90 });
  const listFile = path.join(jobDir, 'concat_list.txt');
  const listContent = audioPaths
    .map(p => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  fs.writeFileSync(listFile, listContent);

  const finalPath = path.join(jobDir, 'final.mp4');
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', finalPath]);

  // Cleanup intermediate files
  for (const p of [...rawPaths, ...normPaths, ...audioPaths, listFile]) {
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
    return res.status(400).json({ error: 'clips array required' });
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
