import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

/*
  HTTPS over the LAN, so the app can run on a phone.

  `getUserMedia` requires a SECURE CONTEXT. `http://<lan-ip>` is not one, and
  iOS does not merely refuse permission — `navigator.mediaDevices` is
  `undefined` entirely, so `camera.ts` reports "Camera not supported in this
  browser" and you go hunting the wrong bug. HTTPS is not a nicety here; it is
  the difference between the camera existing and not.

  Certs are mkcert-issued and live in `.certs/` (gitignored, never commit a
  private key). They carry an IP SAN for 10.0.0.250 — iOS rejects an
  IP-addressed cert without one — plus `OX-0181-CHI-LT.local`, which resolves
  over mDNS and therefore survives a DHCP lease change. Prefer the `.local`
  URL on the phone for that reason.

  Regenerate after an IP change:
    cd .certs && mkcert 10.0.0.250 OX-0181-CHI-LT.local localhost 127.0.0.1

  If the certs are absent the server still starts, over plain HTTP, so desktop
  work is never blocked by a missing cert — but the camera will not work from
  the phone in that state.
*/
const certDir = path.resolve(__dirname, '.certs');
const key = path.join(certDir, '10.0.0.250+3-key.pem');
const cert = path.join(certDir, '10.0.0.250+3.pem');
// `IMPRESSION_HTTP=1 npm run dev` forces plain HTTP — useful for automated
// browsers that will not accept a locally-trusted CA.
const forceHttp = process.env.IMPRESSION_HTTP === '1';
const haveCerts = !forceHttp && fs.existsSync(key) && fs.existsSync(cert);

if (!haveCerts) {
  console.warn(
    '\n[impression] No certs in .certs/ — serving plain HTTP.\n' +
    '             The camera will NOT work from a phone without HTTPS.\n',
  );
}

const httpsOption = haveCerts
  ? { key: fs.readFileSync(key), cert: fs.readFileSync(cert) }
  : undefined;

export default defineConfig({
  /*
    `preview` serves the PRODUCTION build from `dist/` — which is the only
    mode where the service worker exists, so it is the only way to test or use
    offline support on the phone.

    HTTPS is declared EXPLICITLY here rather than relying on `preview`
    inheriting `server`. It does inherit today, but the camera depends on it:
    on plain HTTP iOS leaves `navigator.mediaDevices` undefined, which surfaces
    as the misleading "Camera not supported in this browser". A silent
    regression to HTTP would look like a camera bug, not a config change.

    Service workers also require a secure context, so without this the offline
    support would simply never install.
  */
  preview: {
    host: true,
    port: 5180,
    ...(httpsOption ? { https: httpsOption } : {}),
  },
  server: {
    // Bind 0.0.0.0, not just localhost, or the phone cannot reach the server.
    host: true,
    port: 5180,
    ...(httpsOption ? { https: httpsOption } : {}),
  },
});
