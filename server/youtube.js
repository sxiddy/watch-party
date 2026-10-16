// Title and channel for a YouTube video, from YouTube's public oEmbed
// endpoint (no key needed). Done here rather than in the browser because
// oEmbed doesn't allow cross-origin requests.
const cache = new Map(); // id -> { at, data }, small LRU

async function youtubeInfo(id) {
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.data;
  const url = 'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id);
  const res = await fetch(url, { signal: AbortSignal.timeout(6000) });
  let data;
  if (res.ok) {
    const j = await res.json();
    data = {
      ok: true, id,
      title: String(j.title || '').slice(0, 200) || 'YouTube video',
      channel: String(j.author_name || '').slice(0, 80),
      thumb: `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    };
  } else if (res.status === 401 || res.status === 403) {
    // the owner switched off playing it on other sites
    data = { ok: false, id, error: 'no-embed' };
  } else if (res.status === 404 || res.status === 400) {
    data = { ok: false, id, error: 'not-found' };
  } else {
    throw new Error('YouTube ' + res.status);
  }
  cache.set(id, { at: Date.now(), data });
  if (cache.size > 300) cache.delete(cache.keys().next().value);
  return data;
}

module.exports = { youtubeInfo };
