# Impression

A camera built on letterforms.

Point it at something and the image is rendered as a field of dots — optionally
stencilled through a letter. Every dot that newly appears rings a note, so **you
hear the picture forming**. Press the shutter and the dots freeze into an
artifact. Then a playhead sweeps across it, playing each column like a score:
row height maps to pitch, top notes high.

---

## Getting started

1. Open the app and **allow camera access**
2. **Tap once** — this unlocks audio (browsers require a tap before playing sound)
3. Tap the **speaker icon** to unmute the chime — it starts silent on purpose

You should now hear soft tones as you move the camera around.

## The five icons across the top

| icon | what it does |
|---|---|
| aperture | auto-level panel — helps in dim or flat light |
| invert | flips light and dark |
| sound | choose which instrument each dot shape plays |
| **mask** | **turn this on** — stencils the image inside a letter |
| speaker | mute / unmute the chime |

The mask is **off by default**, so the app opens as a plain dotted camera view.
Turning it on is where the app becomes itself.

## Changing the letter

Swipe left or right on the image. A–Z.

## The four small dials

- **RES** — dot resolution
- **(ρ)** — dot density
- **EXP** — exposure
- **CONT** — contrast

RES and (ρ) change the look most. EXP and CONT affect the live camera only.

## Taking and playing a shot

Press the **big button** to freeze the image. Then:

- **Play** — the playhead sweeps left to right, sounding each column
- **Drag the large dial** — scrub by hand, like bowing across the letter
- **1× / 2× / 3×** — sweep speed
- **Loop** — repeat

Struck dots light up orange and fade behind the playhead.

Press the button again to return to the camera.

**Note:** while an image is frozen, the letter, mask, invert and RES controls
are disabled — changing them would invalidate the capture. Return to live first.

## Sound Config

Four dot shapes (square, circle, diamond, cross) are assigned by brightness, and
each plays its own instrument. Open the sound icon, turn the **left wheel** to
pick a shape and the **right wheel** to pick its voice.

**Careful:** turning only the left wheel overwrites each shape it passes with
the currently-selected voice. Set the voice on the right wheel each time you
land on a new shape.

---

## Install on a phone

Open the deployed URL in Safari → Share → **Add to Home Screen**. After the
first load it works offline — no network, no server.

## Running it locally

```bash
npm install
npm run dev      # development, hot reload
npm run build    # production build + generated service worker
npm run serve    # serve the built app, with offline support
```

The camera needs HTTPS. `npm run dev` serves over HTTPS using certs in
`.certs/` (not committed — see `DEPLOY.md` to regenerate). On plain HTTP, iOS
reports "Camera not supported in this browser".

Deployment instructions are in [DEPLOY.md](DEPLOY.md).
