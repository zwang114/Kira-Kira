/**
 * getUserMedia lifecycle.
 *
 * Requires a secure context — localhost counts, so `npm run dev` is fine, but
 * a LAN IP over plain http will fail with NotAllowedError and no obvious clue.
 */

/** Which way the camera points. `environment` is the rear camera. */
export type Facing = 'user' | 'environment';

export interface CameraHandle {
  video: HTMLVideoElement;
  /** Which camera this handle opened. */
  facing: Facing;
  /** False once the camera track has ended (revoked, unplugged, or taken). */
  isLive(): boolean;
  stop(): void;
}

/**
 * Is there more than one camera to switch between?
 *
 * Used to hide the flip button on machines with a single camera — most
 * laptops. `enumerateDevices` only reports labels after permission is granted,
 * but it reports the COUNT regardless, which is all this needs.
 *
 * Returns false on any failure: a missing button is a smaller problem than one
 * that does nothing when pressed.
 */
export async function hasMultipleCameras(): Promise<boolean> {
  try {
    if (!navigator.mediaDevices?.enumerateDevices) return false;
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput').length > 1;
  } catch {
    return false;
  }
}

export async function startCamera(facing: Facing = 'environment'): Promise<CameraHandle> {
  if (!navigator.mediaDevices?.getUserMedia) {
    // On iOS this is what a NON-SECURE CONTEXT looks like: `mediaDevices` is
    // undefined entirely rather than the request being denied. Say so, because
    // "not supported" sends people hunting a camera bug when the real problem
    // is that the page is served over http.
    throw new Error(
      window.isSecureContext
        ? 'Camera not supported in this browser.'
        : 'Camera needs a secure connection — open this page over https.',
    );
  }

  /*
    `ideal`, not `exact`, on facingMode.

    `exact` REJECTS on a machine that has no camera facing that way — most
    laptops have only a front camera, so `exact: 'environment'` would fail
    outright there rather than falling back. `ideal` takes the best match and
    still prefers the requested side on a phone.
  */
  const stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: facing },
      width: { ideal: 640 },
      height: { ideal: 480 },
    },
    audio: false,
  });

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  video.srcObject = stream;

  /*
    A rejected `play()` is NOT harmless here.

    This used to be `.catch(() => {})`. On iOS in Low Power Mode `play()`
    rejects with NotAllowedError while the track stays `live` — so `isLive()`
    keeps returning true and the app renders black frames forever with no
    indication why. Rethrow so the caller's error path can surface it.
  */
  try {
    await video.play();
  } catch (err) {
    stream.getTracks().forEach((t) => t.stop());
    const name = (err as { name?: string })?.name;
    throw new Error(
      name === 'NotAllowedError'
        ? 'Video playback was blocked — check Low Power Mode, then retry.'
        : `Could not start video: ${(err as Error)?.message ?? name}`,
    );
  }

  // videoWidth is 0 until metadata arrives; drawing before then silently
  // produces empty frames.
  if (!video.videoWidth) {
    await new Promise<void>((res) => {
      video.addEventListener('loadedmetadata', () => res(), { once: true });
    });
  }

  /*
    Report the facing the browser ACTUALLY gave us, not the one requested.

    `facingMode: { ideal }` can hand back the other camera — a laptop asked for
    `environment` returns its only (front) camera. The mirror decision in
    `dither.ts` depends on which way the lens really points, so guessing from
    the request would mirror a rear camera on any device that substituted.
  */
  const settings = stream.getVideoTracks()[0]?.getSettings?.();
  const actualFacing: Facing =
    settings?.facingMode === 'environment' ? 'environment'
    : settings?.facingMode === 'user' ? 'user'
    // No `facingMode` in settings (common on desktop): trust the request.
    : facing;

  return {
    video,
    facing: actualFacing,
    isLive() {
      // A track can end without any error surfacing — the user revokes
      // permission, another app claims the device, or a USB camera is
      // unplugged. The video element keeps returning its last frame (or
      // black), so drawImage silently succeeds and the app looks like it's
      // working while showing nothing real.
      return stream.getVideoTracks().some((t) => t.readyState === 'live');
    },
    stop() {
      stream.getTracks().forEach((t) => t.stop());
      video.srcObject = null;
    },
  };
}

export function describeCameraError(err: unknown): string {
  const name = (err as { name?: string })?.name;
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission denied — check browser site settings.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera found on this device.';
    case 'NotReadableError':
      return 'Camera is in use by another app.';
    default:
      return `Could not start camera: ${(err as Error)?.message ?? name ?? 'unknown error'}`;
  }
}
