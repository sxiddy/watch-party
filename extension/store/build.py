# Builds the Chrome Web Store upload: store/back-row-sync.zip
#
# The folder version (load unpacked) works on any site with a video and can
# talk to a local server for testing. The store version is narrowed, because
# Google reviews broad permissions much more strictly:
#   - runs only on Netflix, Prime Video, JioHotstar and YouTube
#   - talks only to the live Back Row server
#   - no "tabs" permission (site access already gives the tab's title and address)
#   - no test page, no localhost option
# Run: python extension/store/build.py
import json, os, re, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
EXT = os.path.dirname(HERE)
OUT = os.path.join(HERE, 'back-row-sync.zip')

SITES = [
    'https://*.netflix.com/*',
    'https://*.primevideo.com/*',
    'https://*.amazon.com/*', 'https://*.amazon.in/*', 'https://*.amazon.co.uk/*',
    'https://*.hotstar.com/*',
    'https://*.youtube.com/*',
]
SERVER = 'https://watchpartyvinnovate-sync.onrender.com/*'
FILES = ['background.js', 'content.js', 'page-netflix.js', 'popup.css', 'popup.js',
         'lib/socket.io-4.8.min.js', 'lib/sync-core.js',
         'icons/icon16.png', 'icons/icon32.png', 'icons/icon48.png', 'icons/icon128.png']

def read(p):
    with open(os.path.join(EXT, p), encoding='utf-8') as f:
        return f.read()

manifest = json.loads(read('manifest.json'))
manifest['permissions'] = [p for p in manifest['permissions'] if p != 'tabs']
manifest['host_permissions'] = SITES + [SERVER]
manifest['description'] = 'Watch Netflix, Prime Video, JioHotstar or YouTube in sync with friends. Everyone plays it on their own account.'

# the popup's "This laptop (localhost)" server choice is for development only
popup = re.sub(r'\s*<option value="local">.*?</option>', '', read('popup.html'))

with zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('manifest.json', json.dumps(manifest, indent=2) + '\n')
    z.writestr('popup.html', popup)
    for f in FILES:
        z.write(os.path.join(EXT, f), f)
print('built', OUT)
