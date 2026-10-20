// The popup: start a party on this tab, or join one by code.
const $ = id => document.getElementById(id);
let tab = null;

const SITES = [[/netflix\.com/, 'Netflix'], [/primevideo\.com|amazon\./, 'Prime Video'], [/hotstar\.com/, 'JioHotstar'], [/youtube\.com/, 'YouTube']];
const siteName = url => (SITES.find(([re]) => re.test(url || '')) || [, ''])[1];
const send = msg => chrome.runtime.sendMessage(msg);

function cleanTitle(t, site) {
  // "Interstellar | Netflix" → "Interstellar"
  return String(t || '').replace(/\s*[|\-–]\s*(Netflix|Prime Video|Amazon.*|JioHotstar|Disney\+ Hotstar|Hotstar|YouTube)\s*$/i, '').trim() || (site ? site + ' movie' : 'Movie night');
}

function render(v) {
  $('setup').hidden = !!v.joined;
  $('room').hidden = !v.joined;
  $('err').hidden = !v.error;
  $('err').textContent = v.error || '';
  if (v.server) $('server').value = v.server;
  if (!v.joined) return;
  $('r-code').textContent = v.code;
  $('r-title').textContent = v.title ? 'Now showing: ' + v.title : '';
  const people = (v.members || []).filter(m => m.connected !== false);
  $('r-count').textContent = '(' + people.length + ')';
  $('r-members').replaceChildren(...people.map(m => {
    const li = document.createElement('li');
    const c = document.createElement('span'); c.className = 'c'; c.style.background = m.color;
    const n = document.createElement('span'); n.textContent = m.name + (m.id === v.you ? ' (you)' : '');
    const t = document.createElement('span'); t.className = 'tag';
    const d = m.status && m.status.drift;
    t.textContent = (m.host ? 'host · ' : '') + (d == null ? '' : Math.round(Math.abs(d) * 1000) + ' ms');
    li.append(c, n, t);
    return li;
  }));
  $('r-everyone-wrap').hidden = !v.isHost;
  $('r-everyone').checked = v.settings && v.settings.controlMode === 'everyone';
  $('r-meta').textContent = (v.conn === 'connected' ? 'Connected' : 'Reconnecting…') + (v.rtt ? ' · round trip ' + v.rtt + ' ms' : '') + (v.tabId !== tab?.id ? ' · syncing another tab' : '');
}

async function go(type) {
  const name = $('name').value.trim();
  if (!name) { $('name').focus(); return; }
  localStorage.setItem('br.name', name);
  const site = siteName(tab.url);
  const btn = $(type); btn.disabled = true;
  const old = btn.textContent; btn.textContent = type === 'start' ? 'Starting… (the server may take a minute to wake)' : 'Joining…';
  const v = await send({ type, name, code: $('code').value, server: $('server').value, tabId: tab.id, title: cleanTitle(tab.title, site), site, everyone: $('everyone').checked });
  btn.disabled = false; btn.textContent = old;
  render(v);
}

(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const site = siteName(tab && tab.url);
  $('site').textContent = site ? 'This tab: ' + site : 'This tab has no known streaming site, but any page with a video works.';
  $('name').value = localStorage.getItem('br.name') || '';
  render(await send({ type: 'get' }));
  $('start').onclick = () => go('start');
  $('join').onclick = () => go('join');
  $('code').onkeydown = e => { if (e.key === 'Enter') go('join'); };
  $('leave').onclick = async () => render(await send({ type: 'leave' }));
  $('r-everyone').onchange = async e => render(await send({ type: 'everyone', value: e.target.checked }));
  $('copy').onclick = async () => {
    const v = await send({ type: 'get' });
    await navigator.clipboard.writeText(v.invite + '\n(Room code: ' + v.code + '. Open the same film on your own app, click Back Row Sync and join with the code.)');
    $('copy').textContent = 'Copied!'; setTimeout(() => ($('copy').textContent = 'Copy invite link'), 1500);
  };
  $('open').onclick = async () => { const v = await send({ type: 'get' }); chrome.tabs.create({ url: v.invite }); };
  chrome.runtime.onMessage.addListener(m => { if (m.type === 'view') render(m.view); });
})();
