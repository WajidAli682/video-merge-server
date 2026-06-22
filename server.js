// server.js — video-merge-server
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

app.use('/files', express.static(STORAGE_DIR));

const jobs = {};

function setJob(jobId, patch) {
  jobs[jobId] = { ...(jobs[jobId] || {}), ...patch };
}

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
        const hint = signal === 'SIGKILL'
          ? ' (signal SIGKILL — server memory limit se zyada use ho gayi)'
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
      if (code !== 0) { reject(new Error(`ffprobe failed: ${stderr.slice(-500)}`)); return; }
      try {
        const data = JSON.parse(stdout);
        const stream = data.streams?.[0];
        if (!stream) { reject(new Error('ffprobe: no video stream found')); return; }
        const [num, den] = (stream.r_frame_rate || '25/1').split('/').map(Number);
        const fps = den ? Math.round((num / den) * 100) / 100 : num;
        resolve({ width: stream.width, height: stream.height, fps, codec: stream.codec_name });
      } catch (e) {
        reject(new Error(`ffprobe parse error: ${e.message}`));
      }
    });
  });
}

// Video file ki exact duration nikalo (seconds mein)
function probeDuration(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-show_entries', 'format=duration',
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
      if (code !== 0) { reject(new Error(`ffprobe duration failed: ${stderr.slice(-300)}`)); return; }
      try {
        const data = JSON.parse(stdout);
        resolve(parseFloat(data.format?.duration || '0'));
      } catch (e) {
        reject(new Error(`ffprobe duration parse error: ${e.message}`));
      }
    });
  });
}

async function processJob(jobId, clips, audioClips) {
  const jobDir = path.join(STORAGE_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // Step 1 — Download all clips
  setJob(jobId, { status: 'downloading', progress: 0 });
  console.log(`[Job ${jobId}] Clips received:`, clips.map((c,i) => `${i+1}:${c.type}`).join(', '));
  const rawPaths = [];
  for (let i = 0; i < clips.length; i++) {
    const rawPath = path.join(jobDir, `raw_${i}.mp4`);
    await downloadFile(clips[i].url, rawPath);
    rawPaths.push(rawPath);
    setJob(jobId, { progress: Math.round(((i + 1) / clips.length) * 20) });
  }

  // Step 2 — Probe clips
  setJob(jobId, { status: 'analyzing', progress: 22 });
  const probes = [];
  for (let i = 0; i < rawPaths.length; i++) {
    try {
      const info = await probeClip(rawPaths[i]);
      probes.push(info);
    } catch (e) {
      console.warn(`[Job ${jobId}] Probe failed for clip ${i}:`, e.message);
      probes.push(null);
    }
  }

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
    const [res] = targetKey.split('|');
    const [wh, fps] = res.split('@');
    [TARGET_W, TARGET_H] = wh.split('x').map(Number);
    TARGET_FPS = Number(fps);
  } else {
    TARGET_W = 1920; TARGET_H = 1080; TARGET_FPS = 30;
  }

  console.log(`[Job ${jobId}] Target format: ${TARGET_W}x${TARGET_H}@${TARGET_FPS} (${maxCount}/${clips.length} clips already match)`);

  // Step 3 — Normalize/trim clips
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
      if (needsTrim) {
        // -c copy ki jagah re-encode karo — keyframe alignment issue:
        // -c copy sirf keyframe boundary pe cut karta hai, exact trimEnd pe nahi.
        // Agar keyframe 4.0s pe hai aur trimEnd 5.8s hai, clip 4.0s pe cut hogi.
        // Re-encode se exact frame-accurate trim hoti hai.
        // -preset fast use kar rahe hain (slow nahi) — trim-only clip ke liye sufficient.
        args.push(
          '-c:v', 'libx264', '-preset', 'fast', '-crf', '17',
          '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
          outPath
        );
        await run('ffmpeg', args);
      } else {
        fs.copyFileSync(inPath, outPath);
      }
    } else {
      args.push(
        '-vf', `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=increase,crop=${TARGET_W}:${TARGET_H},setsar=1,fps=${TARGET_FPS}`,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', '17',
        '-threads', '2', '-x264-params', 'threads=2:lookahead_threads=1',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
        outPath
      );
      await run('ffmpeg', args);
    }
    normPaths.push(outPath);
    setJob(jobId, { progress: 25 + Math.round(((i + 1) / clips.length) * 55) });
  }

  // Step 4 — Concat all clips (video only, strip audio)
  setJob(jobId, { status: 'audio', progress: 80 });
  const listFile = path.join(jobDir, 'concat_list.txt');
  const listContent = normPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n');
  fs.writeFileSync(listFile, listContent);

  const videoOnlyPath = path.join(jobDir, 'video_only.mp4');
  // -an = audio strip — video only concat, taake embedded avatar audio interference na kare
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c:v', 'copy', '-an', videoOnlyPath]);

  let finalPath = videoOnlyPath;

  // Step 5 — Audio overlay
  console.log(`[Job ${jobId}] audioClips received: ${audioClips?.length || 0}`);

  if (Array.isArray(audioClips) && audioClips.length > 0) {
    setJob(jobId, { status: 'audio', progress: 85 });

    // Download audio files
    const audioRawPaths = [];
    for (let i = 0; i < audioClips.length; i++) {
      const audioPath = path.join(jobDir, `audio_${i}.wav`);
      try {
        await downloadFile(audioClips[i].url, audioPath);
        const size = fs.statSync(audioPath).size;
        console.log(`[Job ${jobId}] Audio ${i + 1}/${audioClips.length}: downloaded ${size} bytes`);
        audioRawPaths.push(audioPath);
      } catch (err) {
        console.error(`[Job ${jobId}] Audio ${i + 1} download FAILED: ${err.message}`);
      }
    }

    if (audioRawPaths.length > 0) {
      // Concat audio
      const audioListFile = path.join(jobDir, 'audio_list.txt');
      fs.writeFileSync(audioListFile, audioRawPaths.map(p => `file '${p.replace(/'/g, "'\\''")}'`).join('\n'));
      const masterAudioPath = path.join(jobDir, 'master_audio.aac');
      await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', audioListFile,
        '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2', masterAudioPath]);

      // Video ki exact duration nikalo — is duration tak audio overlay karo
      // (-shortest use nahi karna: agar audio thoda lambi ho to video pe clip hogi,
      //  agar thodi chhoti ho to end mein silence — dono cases mein sync safe hai)
      const videoDuration = await probeDuration(videoOnlyPath);
      console.log(`[Job ${jobId}] Video duration: ${videoDuration.toFixed(3)}s`);

      // Audio ko video duration tak exactly trim/pad karo
      const audioFixedPath = path.join(jobDir, 'master_audio_fixed.aac');
      await run('ffmpeg', ['-y', '-i', masterAudioPath,
        '-t', String(videoDuration),   // exactly video ki duration tak — na zyada, na kam
        '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
        audioFixedPath]);

      // Overlay — no -shortest, explicit -t se control
      const withAudioPath = path.join(jobDir, 'final.mp4');
      await run('ffmpeg', ['-y',
        '-i', videoOnlyPath,
        '-i', audioFixedPath,
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac', '-b:a', '192k',
        '-t', String(videoDuration),   // output exactly video duration tak
        withAudioPath]);

      finalPath = withAudioPath;

      // Cleanup
      for (const p of [...audioRawPaths, audioListFile, masterAudioPath, audioFixedPath, videoOnlyPath]) {
        try { fs.unlinkSync(p); } catch (_) {}
      }
      console.log(`[Job ${jobId}] Audio overlay complete — final duration: ${videoDuration.toFixed(3)}s`);
    } else {
      // Koi audio download nahi ho saka
      const fp = path.join(jobDir, 'final.mp4');
      fs.renameSync(videoOnlyPath, fp);
      finalPath = fp;
    }
  } else {
    // No audioClips — video as-is
    const fp = path.join(jobDir, 'final.mp4');
    fs.renameSync(videoOnlyPath, fp);
    finalPath = fp;
  }

  // Cleanup intermediates
  for (const p of [...rawPaths, ...normPaths, listFile]) {
    try { fs.unlinkSync(p); } catch (_) {}
  }

  setJob(jobId, { status: 'done', progress: 100, downloadUrl: `/files/${jobId}/final.mp4` });
}

app.get('/', (req, res) => res.json({ ok: true, service: 'video-merge-server' }));

app.post('/merge', (req, res) => {
  const { clips, audio } = req.body || {};
  if (!Array.isArray(clips) || clips.length === 0) {
    return res.status(400).json({ error: 'clips array required' });
  }
  for (const c of clips) {
    if (!c.url) return res.status(400).json({ error: 'Har clip mein url chahiye' });
  }

  const audioClips = Array.isArray(audio) ? audio.filter(a => a && a.url) : [];
  const jobId = uuidv4();
  setJob(jobId, { status: 'queued', progress: 0, total: clips.length, createdAt: Date.now() });
  res.json({ jobId });

  processJob(jobId, clips, audioClips).catch(err => {
    console.error(`[Job ${jobId}] FAILED:`, err.message);
    setJob(jobId, { status: 'error', error: err.message });
  });
});

app.get('/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

const MAX_JOB_AGE_MS = 2 * 60 * 60 * 1000;
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
setInterval(cleanupOldJobs, 30 * 60 * 1000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`video-merge-server listening on port ${PORT}`));
