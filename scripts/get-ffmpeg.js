// Makes sure the ffmpeg binary used for highlight clips is downloaded.
// ffmpeg-static fetches it in its own install script, which newer npm
// versions can skip; this runs as our own postinstall, so it always runs.
const fs = require('fs');
const { execFileSync } = require('child_process');
try {
  const bin = require('ffmpeg-static');
  if (bin && fs.existsSync(bin)) process.exit(0);
  execFileSync(process.execPath, [require.resolve('ffmpeg-static/install.js')], { stdio: 'inherit' });
} catch (e) {
  console.warn('[ffmpeg] not installed, highlight clips will be unavailable:', e.message);
}
