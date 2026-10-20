# Promo video

`bussola-promo.mp4`: a 30-second promo (1920×1080, 30 fps, English) showing the
bank notification → draft → one-tap confirm flow, every account in one total,
income and expenses by month, and the investments portfolio.

The video is drawn in `promo.html` (open it in a browser to watch it play in a
loop; add `?lang=it` for Italian) and recorded frame by frame:

```bash
node tools/promo/render.mjs                  # writes tools/promo/bussola-promo.mp4
node tools/promo/render.mjs --lang it        # an Italian copy, bussola-promo-it.mp4
node tools/promo/render.mjs --stills 4 9.9   # single frames, to check a moment
```

It needs Playwright with a Chromium, ffmpeg, and Python 3 with numpy. The
soundtrack is synthesised by `soundtrack.py`, so there is no third-party audio.
Banks, merchants and amounts are made up.

The landing page (`landing/build.sh`) serves the video with `poster.jpg`, the
frame at 6.8 s. `poster-play.jpg` is the same frame at 1280×720 with a play
button, for the README, which links it to the video on the landing page.
