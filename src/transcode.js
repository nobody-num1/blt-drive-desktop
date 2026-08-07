const { spawn } = require('child_process');

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

function transcode(ffmpeg, inputPath, outputPath, height, crf, onProgress) {
  return new Promise((resolve, reject) => {
    const args = [
      '-nostats', '-y', '-i', inputPath,
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', String(crf || 23),
      '-pix_fmt', 'yuv420p', '-tag:v', 'avc1',
      '-vf', 'scale=-2:' + height,
      '-c:a', 'aac', '-b:a', '128k',
      '-movflags', '+faststart',
      '-progress', 'pipe:2',
      outputPath
    ];
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

module.exports = { probeDuration, transcode };