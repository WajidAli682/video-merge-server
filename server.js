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

// GSAP → MP4 converter (Puppeteer + headless Chrome)
async function convertGsapToMp4(gsapUrl, duration, width, height, outputPath) {
  let chromium, puppeteer;
  try {
    chromium = require('@sparticuz/chromium-min');
    puppeteer = require('puppeteer-core');
  } catch (e) {
    throw new Error('Puppeteer/Chromium not installed: ' + e.message);
  }

  const browser = await puppeteer.launch({
    args: [
      ...chromium.args,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--single-process',
    ],
    defaultViewport: { width, height },
    executablePath: await chromium.executablePath(
      'https://github.com/Sparticuz/chromium/releases/download/v121.0.0/chromium-v121.0.0-pack.tar'
    ),
    headless: true,
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height });

    const fps = 25;
    const totalFrames = Math.ceil(duration * fps);

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
<style>* { margin:0; padding:0; } body { width:${width}px; height:${height}px; overflow:hidden; background:#000; } #c { width:${width}px; height:${height}px; position:relative; }</style>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.2/gsap.min.js"></script>
</head><body><div id="c"></div>
<script type="module">
import { createAnimation } from '${gsapUrl}';
const anim = createAnimation(document.getElementById('c'));
anim.seek(0);
window.__anim = anim;
window.__ready = true;
</script></body></html>`;

    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await page.waitForFunction(() => window.__ready === true, { timeout: 15000 });

    // Frame-by-frame screenshot capture
    const frames = [];
    for (let f = 0; f < totalFrames; f++) {
      const t = f / fps;
      await page.evaluate((time) => { if(window.__anim) window.__anim.seek(time); }, t);
      const shot = await page.screenshot({ type: 'jpeg', quality: 85 });
      frames.push(shot);
    }
    await browser.close();
    console.log(`GSAP: ${frames.length} frames captured`);

    // Frames → MP4
    await new Promise((resolve, reject) => {
      const ffmpegProc = spawn('ffmpeg', [
        '-y', '-f', 'image2pipe', '-framerate', String(fps),
        '-i', 'pipe:0',
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
        '-pix_fmt', 'yuv420p', '-an', outputPath
      ]);
      let stderr = '';
      ffmpegProc.stderr.on('data', d => { stderr += d.toString(); });
      ffmpegProc.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error('ffmpeg frames: ' + stderr.slice(-300)));
      });
      ffmpegProc.on('error', reject);
      (async () => {
        for (const frame of frames) { ffmpegProc.stdin.write(frame); }
        ffmpegProc.stdin.end();
      })();
    });
    console.log('GSAP → MP4 done:', outputPath);
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}

async function processJob(jobId, clips, audioClips) {
  const jobDir = path.join(STORAGE_DIR, jobId);
  fs.mkdirSync(jobDir, { recursive: true });

  // Step 0 — GSAP scenes pehle convert karo (Puppeteer)
  // Sequential: pehle sab gsap → mp4, phir ffmpeg pipeline
  // Isse RAM peak alag time pe hogi — crash nahi hoga
  const gsapScenes = clips.filter(c => c.type === 'gsap');
  if (gsapScenes.length > 0) {
    setJob(jobId, { status: 'gsap', progress: 0 });
    console.log(`[Job ${jobId}] GSAP scenes: ${gsapScenes.length} — converting pehle`);
    
    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      if (clip.type !== 'gsap') continue;
      
      const gsapMp4Path = path.join(jobDir, `gsap_${i}.mp4`);
      // Non-gsap clips ka resolution probe karke actual target size nikalo
      // Taake GSAP seedha sahi size mein render ho — koi scaling nahi
      let w = clip.width || 720;
      let h = clip.height || 1280;
      const nonGsapClip = clips.find((c, idx) => idx !== i && c.type !== 'gsap' && c.url && !c.url.startsWith('file://'));
      if (nonGsapClip) {
        // Ek non-gsap clip temporarily download karke probe karo
        const tempProbe = path.join(jobDir, `probe_temp_${i}.mp4`);
        try {
          await downloadFile(nonGsapClip.url, tempProbe);
          const probeInfo = await probeClip(tempProbe);
          if (probeInfo) { w = probeInfo.width; h = probeInfo.height; }
          fs.unlinkSync(tempProbe);
          console.log(`[Job ${jobId}] GSAP target size from probe: ${w}x${h}`);
        } catch (e) {
          console.warn(`[Job ${jobId}] Probe failed, using default size: ${w}x${h}`);
          try { fs.unlinkSync(tempProbe); } catch(_) {}
        }
      }
      const dur = clip.trimEnd || clip.sceneDuration || 7;
      
      console.log(`[Job ${jobId}] GSAP clip ${i+1}: converting (${w}x${h}, ${dur}s)`);
      try {
        await convertGsapToMp4(clip.url, dur, w, h, gsapMp4Path);
        // clip ka url replace karo converted mp4 se
        clips[i] = { ...clip, url: `file://${gsapMp4Path}`, _gsapLocalPath: gsapMp4Path, type: 'video' };
        console.log(`[Job ${jobId}] GSAP clip ${i+1}: done`);
      } catch (err) {
        console.error(`[Job ${jobId}] GSAP clip ${i+1} FAILED: ${err.message} — black placeholder use karenge`);
        // Fallback: black video
        const blackPath = path.join(jobDir, `black_${i}.mp4`);
        await run('ffmpeg', ['-y', '-f', 'lavfi', '-i', `color=c=black:size=${w}x${h}:rate=25`, '-t', String(dur), '-c:v', 'libx264', '-preset', 'ultrafast', blackPath]);
        clips[i] = { ...clip, url: `file://${blackPath}`, _gsapLocalPath: blackPath, type: 'video' };
      }
    }
    console.log(`[Job ${jobId}] All GSAP scenes converted`);
  }

  // Ensure jobDir exists
  fs.mkdirSync(jobDir, { recursive: true });

  // Step 1 — Download all clips (sequential — order guaranteed)
  setJob(jobId, { status: 'downloading', progress: 0 });
  console.log(`[Job ${jobId}] Clips received:`, clips.map((c,i) => `${i+1}:${c.type}`).join(', '));
  const rawPathsFinal = [];
  const clipsFinal = [];
  for (let i = 0; i < clips.length; i++) {
    const rawPath = path.join(jobDir, `raw_${i}.mp4`);
    try {
      if (clips[i].url.startsWith('file://')) {
        // GSAP converted file — already local, copy karo
        const localPath = clips[i].url.replace('file://', '');
        fs.copyFileSync(localPath, rawPath);
      } else {
        await downloadFile(clips[i].url, rawPath);
      }
      rawPathsFinal.push(rawPath);
      clipsFinal.push(clips[i]);
    } catch (err) {
      console.error(`[Job ${jobId}] Clip ${i+1} download FAILED: ${err.message}`);
    }
    setJob(jobId, { progress: Math.round(((i + 1) / clips.length) * 20) });
  }
  console.log(`[Job ${jobId}] ${rawPathsFinal.length}/${clips.length} clips downloaded successfully`);

  // Step 2 — Probe clips
  setJob(jobId, { status: 'analyzing', progress: 22 });
  const probes = [];
  for (let i = 0; i < rawPathsFinal.length; i++) {
    try {
      const info = await probeClip(rawPathsFinal[i]);
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
  for (let i = 0; i < clipsFinal.length; i++) {
    const clip = clipsFinal[i];
    const inPath = rawPathsFinal[i];
    const probe = probes[i];
    const outPath = path.join(jobDir, `norm_${i}.mp4`);
    const needsTrim = !!(clip.trimNeeded && clip.trimEnd);

    const matchesTarget = probe &&
      probe.width === TARGET_W &&
      probe.height === TARGET_H &&
      Math.abs(probe.fps - TARGET_FPS) < 0.5 &&
      probe.codec === 'h264';

    const args = ['-y', '-i', inPath];
    // trimEnd available ho to hamesha -t lagao — chahe trimNeeded true/false ho.
    // Agar clip already chhoti hai (extend case), loop-extend baad mein handle karega.
    // Agar clip lambi hai aur trimNeeded=false set hua (extension ne galat calculate kiya),
    // tab bhi trimEnd se cut ho jayegi.
    if (clip.trimEnd) args.push('-t', String(clip.trimEnd));

    // GSAP clip — already sahi size mein render ho chuki hai, sirf copy karo
    // clips array mein 'gsap' type video ban gaya hai file:// URL ke saath
    if (clip.url && clip.url.startsWith('file://')) {
      // Direct copy — already correct size, koi normalize nahi
      fs.copyFileSync(inPath, outPath);
      console.log(`[Job ${jobId}] Clip ${i+1}: GSAP already correct size — copied directly`);
      normPaths.push(outPath);
      try { fs.unlinkSync(inPath); } catch (_) {}
      setJob(jobId, { progress: 25 + Math.round(((i + 1) / clipsFinal.length) * 55) });
      continue;
    }

    // Image scene — static image ko video mein convert karo
    if (clip.type === 'image') {
      const imgDur = clip.trimEnd || clip.sceneDuration || 5;
      // Image download karo (.jpg/.png/.webp)
      const imgPath = path.join(jobDir, `img_${i}.jpg`);
      await downloadFile(clip.url, imgPath);
      // ffmpeg: image → looped video (sceneDuration seconds)
      // Image → video: tune stillimage + ultrafast + keyframe interval minimize karo
      // -tune stillimage: static content ke liye ffmpeg ka built-in optimization
      // -g 1: har frame keyframe — loop/seek issues nahi hote, RAM bhi kam
      await run('ffmpeg', [
        '-y',
        '-loop', '1',
        '-framerate', String(TARGET_FPS),  // input framerate set karo
        '-i', imgPath,
        '-t', String(imgDur),
        '-vf', `scale=${TARGET_W}:${TARGET_H}:force_original_aspect_ratio=decrease,pad=${TARGET_W}:${TARGET_H}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
        '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'stillimage', '-crf', '28',
        '-g', '1',        // har frame keyframe — static image ke liye perfect
        '-threads', '1',
        '-an',
        outPath
      ]);
      try { fs.unlinkSync(imgPath); } catch (_) {}
      console.log(`[Job ${jobId}] Clip ${i+1}: image→video converted (dur=${imgDur.toFixed(3)}s)`);
      normPaths.push(outPath);
      try { fs.unlinkSync(inPath); } catch (_) {}
      setJob(jobId, { progress: 25 + Math.round(((i + 1) / clipsFinal.length) * 55) });
      continue; // baaki normalize logic skip karo
    }

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
        '-c:v', 'libx264', '-preset', 'medium', '-crf', '17',  // slow→medium: quality almost same, RAM ~40% kam
        '-threads', '2', '-x264-params', 'threads=2:lookahead_threads=1',
        '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
        outPath
      );
      await run('ffmpeg', args);
    }
    // Per-clip log + loop-extend agar clip trimEnd se chhoti ho
    const actualDur = await probeDuration(outPath).catch(() => null);
    console.log(`[Job ${jobId}] Clip ${i+1}/${clips.length}: type=${clip.type} matchesTarget=${!!matchesTarget} needsTrim=${needsTrim} trimEnd=${clip.trimEnd?.toFixed(3) ?? 'null'} actualDur=${actualDur?.toFixed(3) ?? 'err'}`);

    // Agar clip ki actual duration trimEnd se alag hai — fix karo:
    // Case 1: actualDur > trimEnd — trim karo (already handled upar, but double-check)
    // Case 2: actualDur < trimEnd — loop extend karo
    // (HeyGen editor mein kuch footage clips repeat/loop ho ke longer duration fill karti hain)
    // Note: needsTrim check nahi karte — trimEnd available hona kaafi hai
    if (clip.trimEnd && actualDur !== null && actualDur < clip.trimEnd - 0.1) {
      console.log(`[Job ${jobId}] Clip ${i+1}: chhoti hai (${actualDur?.toFixed(3)}s < ${clip.trimEnd.toFixed(3)}s) — loop extend kar rahe hain`);
      const loopedPath = path.join(jobDir, `looped_${i}.mp4`);
      // Loop extend: ultrafast preset use karo — RAM bachaao (Railway 512MB limit)
      // Quality yahan matter nahi karta — sirf duration extend kar rahe hain,
      // asli quality encode baad mein norm step mein already ho chuki hai.
      // Ek hi pass mein exact trimEnd tak cut karo — 2 pass ki zaroorat nahi.
      await run('ffmpeg', [
        '-y',
        '-stream_loop', '-1',
        '-i', outPath,
        '-t', String(clip.trimEnd),  // seedha exact duration — no buffer needed
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '17',
        '-threads', '1',  // single thread — RAM aur CPU dono bachao
        '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
        loopedPath
      ]);
      try { fs.unlinkSync(outPath); } catch (_) {}
      fs.renameSync(loopedPath, outPath);
      const newDur = await probeDuration(outPath).catch(() => null);
      console.log(`[Job ${jobId}] Clip ${i+1}: loop extend done — newDur=${newDur?.toFixed(3)}s (target: ${clip.trimEnd.toFixed(3)}s)`);
    }

    normPaths.push(outPath);
    // Raw file turant delete karo — disk space bachao (100+ clips ke liye zaroori)
    try { fs.unlinkSync(inPath); } catch (_) {}
    setJob(jobId, { progress: 25 + Math.round(((i + 1) / clipsFinal.length) * 55) });
  }

  // Step 4 — Per-clip audio merge, phir final concat
  // HeyGen ka approach: har clip ko uski apni audio ke saath merge karo,
  // phir sab merged clips concat karo. Master overlay nahi — isliye drift zero.
  setJob(jobId, { status: 'audio', progress: 80 });
  console.log(`[Job ${jobId}] audioClips received: ${audioClips?.length || 0}`);

  const mergedClipPaths = [];

  for (let i = 0; i < normPaths.length; i++) {
    const normPath = normPaths[i];
    const clip = clipsFinal[i];
    const mergedPath = path.join(jobDir, `merged_${i}.mp4`);
    const audioClip = Array.isArray(audioClips) ? audioClips[i] : null;

    if (audioClip && audioClip.url) {
      // Is clip ki audio download karo
      const audioPath = path.join(jobDir, `audio_${i}.wav`);
      try {
        await downloadFile(audioClip.url, audioPath);
        const size = fs.statSync(audioPath).size;
        console.log(`[Job ${jobId}] Clip ${i+1}: audio downloaded ${size} bytes`);

        // Video + audio merge — clip ki exact duration tak
        const clipDur = clip.trimEnd || await probeDuration(normPath).catch(() => null);
        await run('ffmpeg', [
          '-y',
          '-i', normPath,
          '-i', audioPath,
          '-map', '0:v:0',
          '-map', '1:a:0',
          '-c:v', 'copy',
          '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-ac', '2',
          ...(clipDur ? ['-t', String(clipDur)] : []),
          mergedPath
        ]);
        try { fs.unlinkSync(audioPath); } catch (_) {}
        console.log(`[Job ${jobId}] Clip ${i+1}: video+audio merged (dur=${clipDur ? clipDur.toFixed(3) : 'full'}s)`);
      } catch (err) {
        console.error(`[Job ${jobId}] Clip ${i+1} audio FAILED: ${err.message} — video only`);
        fs.copyFileSync(normPath, mergedPath);
      }
    } else {
      // Avatar clip — apna audio already embedded hai — as-is copy
      fs.copyFileSync(normPath, mergedPath);
      console.log(`[Job ${jobId}] Clip ${i+1}: avatar own audio — copied as-is`);
    }

    // Norm file turant cleanup
    try { fs.unlinkSync(normPath); } catch (_) {}
    mergedClipPaths.push(mergedPath);
    setJob(jobId, { progress: 80 + Math.round(((i + 1) / normPaths.length) * 15) });
  }

  // Final concat — sab merged clips ek saath
  setJob(jobId, { status: 'audio', progress: 95 });
  const listFile = path.join(jobDir, 'concat_list.txt');
  fs.writeFileSync(listFile, mergedClipPaths.map(p => `file '${p.replace(/'/g, "'\''")}'`).join('\n'));

  const finalPath = path.join(jobDir, 'final.mp4');
  await run('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', finalPath]);

  // Cleanup
  for (const p of mergedClipPaths) { try { fs.unlinkSync(p); } catch (_) {} }
  try { fs.unlinkSync(listFile); } catch (_) {}

  const finalDur = await probeDuration(finalPath).catch(() => null);
  console.log(`[Job ${jobId}] Final concat done — duration: ${finalDur ? finalDur.toFixed(3) : 'unknown'}s`);

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
