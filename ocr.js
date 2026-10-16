// OCR gratuito en el propio móvil con Tesseract.js (se descarga la primera vez que se usa).
const SRC = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
let loading = null;

function loadLibrary() {
  if (window.Tesseract) return Promise.resolve();
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = SRC;
      s.onload = resolve;
      s.onerror = () => {
        loading = null;
        reject(new Error('No se pudo cargar el reconocedor de texto (¿sin conexión?)'));
      };
      document.head.appendChild(s);
    });
  }
  return loading;
}

// Une las líneas de un mismo párrafo y quita los guiones de final de línea.
function tidy(text) {
  return text
    .replace(/\r/g, '')
    .replace(/-\n(?=\p{Ll})/gu, '')
    .replace(/([^\n])\n(?!\n|\s*[-•*·]|\s*\d+[.)])/g, '$1 ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function recognize(image, onProgress) {
  await loadLibrary();
  const { data } = await window.Tesseract.recognize(image, 'spa', {
    logger: (m) => {
      if (m.status === 'recognizing text') onProgress?.(m.progress);
      else onProgress?.(null, m.status);
    },
  });
  return tidy(data.text || '');
}
