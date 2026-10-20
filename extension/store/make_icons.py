# Draws the extension icon (a red cinema ticket with a cream play mark on a dark tile) at every size Chrome needs.
import os
from PIL import Image, ImageDraw
out = os.path.join(os.path.dirname(__file__), '..', 'icons')
for size in (16, 32, 48, 128):
    s = size * 4  # draw big, then shrink, for smooth edges
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([0, 0, s - 1, s - 1], radius=s * .22, fill=(21, 16, 13))
    d.rounded_rectangle([s*.1, s*.26, s*.9, s*.74], radius=s*.06, fill=(217, 71, 43))
    for x in (s*.1, s*.9):  # the ticket's punched side notches
        d.ellipse([x - s*.08, s*.42, x + s*.08, s*.58], fill=(21, 16, 13))
    d.polygon([(s*.42, s*.36), (s*.42, s*.64), (s*.62, s*.5)], fill=(241, 233, 219))
    im.resize((size, size), Image.LANCZOS).save(os.path.join(out, f'icon{size}.png'))
