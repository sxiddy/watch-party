// Real highlight clips: cut a few seconds straight out of a film file with
// ffmpeg, or grab one frame for the share card. The browser can't record
// these itself because archive.org's file servers don't allow other sites
// to read the video's pixels.
//
// "-c copy" copies the existing video instead of re-encoding it, so a clip
// takes a few seconds and almost no CPU. The cost: it starts at the nearest
// keyframe, so it can begin up to a couple of seconds early.
const { spawn } = require('child_process');
let ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch (e) { /* not installed: clips unavailable */ }

const MAX_SECONDS = 60;
const running = { n: 0 };

const onArchive = u => { try { const h = new URL(u).hostname; return h === 'archive.org' || h.endsWith('.archive.org'); } catch { return false; } };

// returns { status, error } on bad input, otherwise pipes ffmpeg into res
function sendClip(res, { src, start, end, type, name }) {
  if (!ffmpegPath) return res.status(503).json({ error: 'Clips aren’t available on this server' });
  if (!onArchive(src)) return res.status(400).json({ error: 'Only films from the Internet Archive can be clipped' });
  start = Math.max(0, +start || 0);
  end = +end || 0;
  if (!(end > start) || end - start > MAX_SECONDS) return res.status(400).json({ error: 'Clips can be up to a minute' });
  if (running.n >= 3) return res.status(503).json({ error: 'Busy cutting other clips, try again in a moment' });

  const frame = type === 'jpg';
  const args = frame
    ? ['-hide_banner', '-loglevel', 'error', '-ss', String((start + end) / 2), '-i', src, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '4', '-f', 'mjpeg', 'pipe:1']
    : ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', src, '-t', String(end - start), '-c', 'copy',
      '-movflags', 'frag_keyframe+empty_moov', '-avoid_negative_ts', 'make_zero', '-f', 'mp4', 'pipe:1'];

  running.n++;
  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = setTimeout(() => ff.kill('SIGKILL'), 60_000);
  let started = false, err = '';
  ff.stderr.on('data', d => { err += d; });
  ff.stdout.once('data', () => {
    started = true;
    res.set('Content-Type', frame ? 'image/jpeg' : 'video/mp4');
    res.set('Cache-Control', 'public, max-age=86400');
    if (!frame) res.set('Content-Disposition', `attachment; filename="${String(name || 'clip').replace(/[^\w.-]+/g, '-').slice(0, 60)}.mp4"`);
  });
  ff.stdout.pipe(res);
  ff.on('close', code => {
    running.n--;
    clearTimeout(kill);
    if (!started && !res.headersSent) {
      console.warn('[clip]', code, err.slice(0, 300));
      res.status(502).json({ error: 'Couldn’t cut that clip from the film' });
    }
  });
  res.on('close', () => ff.kill('SIGKILL')); // they gave up waiting
}

module.exports = { sendClip, available: () => !!ffmpegPath };
