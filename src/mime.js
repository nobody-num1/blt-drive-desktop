const EXT_MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mkv: 'video/x-matroska', webm: 'video/webm',
  mov: 'video/quicktime', avi: 'video/x-msvideo', mpg: 'video/mpeg', mpeg: 'video/mpeg',
  ts: 'video/mp2t', flv: 'video/x-flv', wmv: 'video/x-ms-wmv', ogv: 'video/ogg', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  svg: 'image/svg+xml', bmp: 'image/bmp', txt: 'text/plain', md: 'text/markdown',
  json: 'application/json', js: 'text/javascript', css: 'text/css', html: 'text/html', pdf: 'application/pdf'
};

const VIDEO_EXT = ['mp4', 'm4v', 'mkv', 'mov', 'avi', 'webm', 'flv', 'wmv', 'mpg', 'mpeg', 'ts', 'm2ts', 'ogv', '3gp', 'ogg'];

function extOf(name) {
  return (String(name || '').toLowerCase().split('.').pop() || '');
}

function mimeFor(name) {
  const ext = extOf(name);
  return EXT_MIME[ext] || 'application/octet-stream';
}

function isVideoPath(p) {
  const base = String(p).split(/[\\/]/).pop() || '';
  return VIDEO_EXT.includes(extOf(base));
}

module.exports = { mimeFor, isVideoPath };