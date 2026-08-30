const https = require('https');
const fs = require('fs');
const path = require('path');

const YT_DLP_DIR = path.join(__dirname, 'yt-dlp');
const YT_DLP_EXE = path.join(YT_DLP_DIR, 'yt-dlp.exe');
const URL = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe';

if (fs.existsSync(YT_DLP_EXE)) {
  console.log('yt-dlp.exe déjà présent');
  process.exit(0);
}

console.log('Téléchargement de yt-dlp.exe...');
fs.mkdirSync(YT_DLP_DIR, { recursive: true });

const file = fs.createWriteStream(YT_DLP_EXE);
https.get(URL, { headers: { 'User-Agent': 'BLT-Drive' } }, (res) => {
  if (res.statusCode === 302 || res.statusCode === 301) {
    https.get(res.headers.location, (res2) => {
      res2.pipe(file);
      file.on('finish', () => { file.close(); console.log('yt-dlp.exe téléchargé'); });
    });
    return;
  }
  if (res.statusCode !== 200) {
    console.error('Erreur:', res.statusCode);
    process.exit(1);
  }
  res.pipe(file);
  file.on('finish', () => { file.close(); console.log('yt-dlp.exe téléchargé'); });
}).on('error', (e) => {
  console.error('Erreur réseau:', e.message);
  process.exit(1);
});
