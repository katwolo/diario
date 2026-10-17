// Cámara dentro de la app: evita abrir la app de cámara del móvil, que en Android
// puede hacer que el sistema cierre el navegador por falta de memoria.
let active = null;

export const cameraSupported = () => Boolean(navigator.mediaDevices?.getUserMedia);

export function closeCamera() {
  if (active) active.finish(null);
}

// Devuelve un Blob JPEG, null si se cancela, o lanza un error si no hay cámara o permiso.
export async function openCamera({ title = 'Hacer foto', maxSide = 2560 } = {}) {
  closeCamera();
  let facing = 'environment';
  let stream = await getStream(facing, maxSide);

  const el = document.createElement('div');
  el.className = 'cam';
  el.innerHTML = `
    <video playsinline autoplay muted></video>
    <div class="cam-top">
      <button type="button" class="cam-btn" data-cam="cancel" aria-label="Cancelar">✕</button>
      <span>${title}</span>
      <button type="button" class="cam-btn" data-cam="torch" aria-label="Linterna" hidden>⚡</button>
    </div>
    <div class="cam-bottom">
      <span class="cam-side"></span>
      <button type="button" class="cam-shutter" data-cam="shot" aria-label="Hacer foto"></button>
      <button type="button" class="cam-btn cam-side" data-cam="flip" aria-label="Cambiar cámara">⟲</button>
    </div>`;
  const video = el.querySelector('video');
  const torchBtn = el.querySelector('[data-cam=torch]');
  let torchOn = false;
  let done = false;

  const attach = () => {
    video.srcObject = stream;
    video.play().catch(() => {});
    const track = stream.getVideoTracks()[0];
    const caps = track.getCapabilities ? track.getCapabilities() : {};
    torchBtn.hidden = !caps.torch;
    torchOn = false;
    torchBtn.classList.remove('on');
  };

  return new Promise((resolve) => {
    const finish = (result) => {
      if (done) return;
      done = true;
      stream.getTracks().forEach((t) => t.stop());
      el.remove();
      active = null;
      resolve(result);
    };
    active = { finish };

    el.addEventListener('click', async (e) => {
      const action = e.target.closest('[data-cam]')?.dataset.cam;
      if (action === 'cancel') finish(null);
      else if (action === 'torch') {
        torchOn = !torchOn;
        try {
          await stream.getVideoTracks()[0].applyConstraints({ advanced: [{ torch: torchOn }] });
          torchBtn.classList.toggle('on', torchOn);
        } catch { torchOn = false; }
      } else if (action === 'flip') {
        facing = facing === 'environment' ? 'user' : 'environment';
        stream.getTracks().forEach((t) => t.stop());
        try {
          stream = await getStream(facing, maxSide);
          if (done) stream.getTracks().forEach((t) => t.stop());
          else attach();
        } catch {
          finish(null);
        }
      } else if (action === 'shot' && video.videoWidth) {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext('2d').drawImage(video, 0, 0);
        el.classList.add('flash');
        canvas.toBlob((blob) => finish(blob), 'image/jpeg', 0.88);
      }
    });

    document.body.appendChild(el);
    attach();
  });
}

function getStream(facing, maxSide) {
  return navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: facing },
      width: { ideal: maxSide },
      height: { ideal: Math.round((maxSide * 3) / 4) },
    },
  });
}
