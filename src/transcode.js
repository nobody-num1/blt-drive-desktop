const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function probeDuration(ffmpeg, inputPath) {
  return new Promise((resolve, reject) => {
    let p;
    try { p = spawn(ffmpeg, ['-i', inputPath], { windowsHide: true }); }
    catch (e) { return reject(e); }
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', () => {
      const m = err.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
      if (m) resolve(parseInt(m[1], 10) * 3600 + parseInt(m[2], 10) * 60 + parseFloat(m[3]));
      else resolve(0);
    });
  });
}

function transcode(ffmpeg, inputPath, outputPath, height, crf, onProgress, audioStreamIdx) {
  return new Promise((resolve, reject) => {
    const args = [
      '-nostats', '-y', '-i', inputPath
    ];
    if (typeof audioStreamIdx === 'number' && audioStreamIdx >= 0) {
      args.push('-map', '0:v:0', '-map', '0:a:' + audioStreamIdx);
    }
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf || 23),
      '-pix_fmt', 'yuv420p', '-tag:v', 'avc1',
      '-vf', 'scale=-2:' + height,
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-progress', 'pipe:2',
      outputPath
    );
    let p;
    try { p = spawn(ffmpeg, args, { windowsHide: true }); }
    catch (e) { return reject(e); }
    let buf = '';
    let lastRestartAt = Date.now();
    p.stderr.on('data', d => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!onProgress) continue;
        let ms = null;
        let m = line.match(/^out_time_ms=(\d+)/);
        if (m) ms = parseInt(m[1], 10);
        else { m = line.match(/^out_time_us=(\d+)/); if (m) ms = parseInt(m[1], 10) / 1000; }
        if (ms === null) continue;
        const now = Date.now();
        if (now - lastRestartAt < 300) continue;
        lastRestartAt = now;
        onProgress(ms);
      }
    });
    p.on('error', reject);
    p.on('close', code => {
      if (code === 0) resolve(outputPath);
      else reject(new Error('ffmpeg a échoué (code ' + code + ')'));
    });
  });
}

function probeStreams(ffmpeg, inputPath) {
  return new Promise((resolve, reject) => {
    const args = ['-i', inputPath];
    let p;
    try { p = spawn(ffmpeg, args, { windowsHide: true }); }
    catch (e) { return reject(e); }
    let err = '';
    p.stderr.on('data', d => { err += d.toString(); });
    p.on('error', reject);
    p.on('close', () => {
      if (!err) return resolve({ audio: [], subtitles: [] });
      const audio = [];
      const subtitles = [];
      const lines = err.split('\n');
      for (const line of lines) {
        const am = line.match(/^\s*Stream\s+#0:(\d+)(?:\([^)]*\))?:\s*Audio:\s*(\S+)/);
        if (am) audio.push({ index: parseInt(am[1], 10), codec: am[2], line });
        const sm = line.match(/^\s*Stream\s+#0:(\d+)(?:\([^)]*\))?:\s*Subtitle:\s*(\S+)/);
        if (sm) subtitles.push({ index: parseInt(sm[1], 10), codec: sm[2], line });
      }
      resolve({ audio, subtitles });
    });
  });
}

async function extractAudioTracks(ffmpeg, inputPath, outDir, baseName) {
  const { audio } = await probeStreams(ffmpeg, inputPath);
  if (audio.length <= 1) return [];
  const tracks = [];
  for (let i = 0; i < audio.length; i++) {
    const trackNum = i + 1;
    const outName = baseName + '_a' + trackNum + '.mp4';
    const outPath = path.join(outDir, outName);
    await new Promise((resolve, reject) => {
      const args = [
        '-nostats', '-y', '-i', inputPath,
        '-map', '0:a:' + i,
        '-c:a', 'aac', '-b:a', '128k',
        '-movflags', '+faststart',
        outPath
      ];
      let p;
      try { p = spawn(ffmpeg, args, { windowsHide: true }); }
      catch (e) { return reject(e); }
      p.on('error', reject);
      p.on('close', code => { if (code === 0) resolve(); else reject(new Error('ffmpeg audio-' + trackNum + ' code ' + code)); });
    });
    const sz = fs.statSync(outPath).size;
    if (sz > 0) tracks.push({ trackNum, path: outPath, name: outName, size: sz });
  }
  return tracks;
}

async function extractSubtitles(ffmpeg, inputPath, outDir, baseName) {
  const { subtitles } = await probeStreams(ffmpeg, inputPath);
  if (!subtitles.length) return [];
  const tracks = [];
  for (let i = 0; i < subtitles.length; i++) {
    const subNum = i + 1;
    const outName = baseName + '_sub' + subNum + '.vtt';
    const outPath = path.join(outDir, outName);
    try {
      await new Promise((resolve, reject) => {
        const args = [
          '-nostats', '-y', '-i', inputPath,
          '-map', '0:s:' + i,
          '-c:s', 'webvtt',
          outPath
        ];
        let p;
        try { p = spawn(ffmpeg, args, { windowsHide: true }); }
        catch (e) { return reject(e); }
        p.on('error', reject);
        p.on('close', code => { if (code === 0) resolve(); else reject(new Error('ffmpeg sub-' + subNum + ' code ' + code)); });
      });
      const sz = fs.statSync(outPath).size;
      if (sz > 0) tracks.push({ subNum, path: outPath, name: outName, size: sz });
    } catch (e) { console.warn('Sous-titre #' + subNum + ' extraction échouée :', e.message); }
  }
  return tracks;
}

module.exports = { probeDuration, transcode, probeStreams, extractAudioTracks, extractSubtitles };