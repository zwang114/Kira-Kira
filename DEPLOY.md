# Deploying Impression

The app is a plain static web app — HTML, JS, CSS, two fonts. **No Apple
dependencies, no build server, no backend.** Anything that serves static files
over HTTPS will run it.

HTTPS is not optional: `getUserMedia` requires a secure context, and so does
the service worker. Every host below provides it automatically.

---

## Why deploying is worth doing

Two things you cannot get from the LAN dev server:

1. **No browser chrome.** iOS grants standalone mode (fullscreen, no Safari UI)
   only over an origin it fully trusts. A locally-trusted mkcert CA on a
   `.local` hostname is not that; a real public certificate is. This is the
   most likely fix for "it still opens in a browser".
2. **Sharing.** Anyone with the URL can open it and add it to their own home
   screen. No Apple account, no cable, no 7-day expiry.

---

## Option A — Vercel CLI, no git required

This machine has no working `git` (Apple's `git` is gated behind an unaccepted
Xcode license), so the CLI path is the one that works today. It uploads the
folder directly.

```bash
cd app-v2
npx vercel login        # opens a browser; you authenticate
npx vercel --prod       # builds and deploys
```

The CLI prints the live URL. `vercel.json` already sets the build command,
output directory, SPA rewrites and cache headers, so accept the detected
defaults when prompted.

## Option B — GitHub + Vercel (needs working git)

Requires `sudo xcodebuild -license accept` first, from an admin account.

```bash
cd app-v2
git init
git add .
git commit -m "Impression: camera built on letterforms"
git branch -M main
git remote add origin https://github.com/<you>/impression.git
git push -u origin main
```

Then at vercel.com: New Project, import the repo, deploy. Every later push
deploys automatically.

## Option C — anything else static

`npm run build` then upload `dist/` to Netlify, Cloudflare Pages, GitHub
Pages, or any static host. The only requirement is HTTPS.

---

## After deploying

1. Open the URL on the phone in Safari
2. Grant camera access when asked
3. Share → **Add to Home Screen**
4. Launch from the icon — it should now be fullscreen, no Safari UI
5. It works offline after that first load

---

## What `vercel.json` does, and why

- **`sw.js` → `max-age=0, must-revalidate`.** The load-bearing one. If the
  service worker itself is cached, browsers keep serving an OLD worker, which
  keeps serving an OLD app — the classic failure where users are pinned to a
  stale version and refreshing does not help.
- **`/assets/*` and `/fonts/*` → one year, `immutable`.** Safe because Vite
  content-hashes these filenames; different content always means a different
  name.
- **SPA rewrites.** Any path that is not a real file resolves to `index.html`.
  The negative lookahead excludes the real asset directories so they are served
  as themselves rather than rewritten to HTML.

## Security notes

- **`.certs/` is gitignored and must stay so** — it contains a private key. It
  is only for LAN HTTPS in development; a deployed build uses the host's TLS.
- **A deployment is public.** Anyone with the URL can open it. The URL is an
  obscure random subdomain by default and a deployment can be deleted at any
  time, but it is not private or access-controlled.
- No analytics, no tracking, no backend. The camera feed never leaves the
  device — every frame is processed locally and nothing is uploaded.

## Local development is unaffected

```bash
npm run dev      # hot reload, no service worker  (https://localhost:5180)
npm run build    # production build + generated sw.js
npm run serve    # serve the built app, WITH offline support
```

Offline support exists only in the production build. That is deliberate: the
worker precaches content-hashed filenames that exist only in a build, and in
dev it would serve stale code on every edit.
