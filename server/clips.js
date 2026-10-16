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

// The static Linux ffmpeg crashes (SIGSEGV) when it looks up a hostname
// itself, so it never goes online: it reads the film through this tiny
// relay on 127.0.0.1, and Node does the actual download (range requests
// and archive.org's redirects included). Only archive.org URLs get through.
let relay = null;
function startRelay() {
  if (!relay) {
    relay = require('http').createServer(async (req, res) => {
      const u = new URL(req.url, 'http://x').searchParams.get('u');
      if (!onArchive(u)) { res.statusCode = 400; return res.end(); }
      try {
        // time limit on getting an answer only; the download itself can take as long as ffmpeg needs
        const ac = new AbortController(), t = setTimeout(() => ac.abort(), 45_000);
        const up = await fetch(u, { headers: req.headers.range ? { range: req.headers.range } : {}, signal: ac.signal });
        clearTimeout(t);
        res.on('close', () => ac.abort());
        const h = { 'content-type': up.headers.get('content-type') || 'video/mp4', 'accept-ranges': 'bytes' };
        for (const k of ['content-length', 'content-range']) if (up.headers.get(k)) h[k] = up.headers.get(k);
        res.writeHead(up.status, h);
        if (req.method === 'HEAD' || !up.body) return res.end();
        const { Readable } = require('stream');
        const body = Readable.fromWeb(up.body);
        body.on('error', () => res.destroy());
        res.on('close', () => body.destroy()); // ffmpeg jumped elsewhere in the file
        body.pipe(res);
      } catch (e) { console.warn('[clip] relay', e.message); res.statusCode = 502; res.end(); }
    }).listen(0, '127.0.0.1');
    relay.unref();
  }
}
function relayUrl(src) {
  return `http://127.0.0.1:${relay.address().port}/?u=${encodeURIComponent(src)}`;
}

// returns { status, error } on bad input, otherwise pipes ffmpeg into res
function sendClip(res, { src, start, end, type, name }) {
  if (!ffmpegPath) return res.status(503).json({ error: 'Clips aren’t available on this server' });
  if (!onArchive(src)) return res.status(400).json({ error: 'Only films from the Internet Archive can be clipped' });
  start = Math.max(0, +start || 0);
  end = +end || 0;
  if (!(end > start) || end - start > MAX_SECONDS) return res.status(400).json({ error: 'Clips can be up to a minute' });
  if (running.n >= 3) return res.status(503).json({ error: 'Busy cutting other clips, try again in a moment' });

  const frame = type === 'jpg';
  if (!relay || !relay.listening) return res.status(503).json({ error: 'Clips are starting up, try again in a second' });
  src = relayUrl(src);
  const args = frame
    ? ['-hide_banner', '-loglevel', 'error', '-ss', String((start + end) / 2), '-i', src, '-frames:v', '1', '-vf', 'scale=960:-2', '-q:v', '4', '-f', 'mjpeg', 'pipe:1']
    : ['-hide_banner', '-loglevel', 'error', '-ss', String(start), '-i', src, '-t', String(end - start), '-c', 'copy',
      '-movflags', 'frag_keyframe+empty_moov', '-avoid_negative_ts', 'make_zero', '-f', 'mp4', 'pipe:1'];

  running.n++;
  const ff = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  const kill = setTimeout(() => ff.kill('SIGKILL'), 60_000);
  let started = false, err = '';
  ff.stderr.on('data', d => { err += d; });
  // only start the reply once ffmpeg has produced something, so a failure becomes a real error
  ff.stdout.once('data', chunk => {
    started = true;
    res.set('Content-Type', frame ? 'image/jpeg' : 'video/mp4');
    res.set('Cache-Control', 'public, max-age=86400');
    if (!frame) res.set('Content-Disposition', `attachment; filename="${String(name || 'clip').replace(/[^\w.-]+/g, '-').slice(0, 60)}.mp4"`);
    res.write(chunk);
    ff.stdout.pipe(res);
  });
  ff.on('error', e => { err += e.message; }); // e.g. the ffmpeg binary is missing
  ff.on('close', (code, signal) => {
    running.n--;
    clearTimeout(kill);
    if (!started && !res.headersSent) {
      console.warn('[clip] failed', code, signal, err.slice(0, 300));
      res.status(502).json({ error: 'Couldn’t cut that clip from the film' });
    }
  });
  res.on('close', () => ff.kill('SIGKILL')); // they gave up waiting
}

if (ffmpegPath) startRelay();

// one quick self-check at startup, so the server log says whether clips work here
if (ffmpegPath) {
  require('child_process').execFile(ffmpegPath, ['-version'], { timeout: 10_000 }, (e, out) =>
    console.log('[clip] ffmpeg', e ? 'FAILED: ' + (e.signal || e.code || e.message) : 'ok: ' + String(out).split(/\r?\n/)[0]));
}

module.exports = { _relayUrl: relayUrl, sendClip, available: () => !!ffmpegPath && require('fs').existsSync(ffmpegPath) };
