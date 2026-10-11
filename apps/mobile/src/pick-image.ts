// Shared by Tips and Vetted: choose a screenshot on the web and shrink it for upload.

/**
 * Picks an image on the web and shrinks it to at most 1600px as JPEG, returning base64 without the data: prefix. Null when
 * nothing was chosen; an Error saying what went wrong when the picture can't be opened.
 */
export function pickImage(): Promise<{ data: string; mediaType: 'image/jpeg' } | null> {
  return new Promise((resolve, reject) => {
    if (typeof document === 'undefined') { reject(new Error('Adding a picture works in the web app (open CrownIQ in Safari).')); return; }
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*';
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = () => {
        const image = new window.Image();
        image.onload = () => {
          const scale = Math.min(1, 1600 / Math.max(image.width, image.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(image.width * scale); canvas.height = Math.round(image.height * scale);
          const context = canvas.getContext('2d');
          if (!context) { reject(new Error('This browser couldn’t prepare the picture. Paste the text instead.')); return; }
          context.drawImage(image, 0, 0, canvas.width, canvas.height);
          const data = canvas.toDataURL('image/jpeg', .85).split(',')[1] ?? '';
          if (data.length < 100) { reject(new Error('That picture came out empty. Try a screenshot instead.')); return; }
          resolve({ data, mediaType: 'image/jpeg' });
        };
        image.onerror = () => reject(new Error('That picture’s format couldn’t be opened. Try a screenshot (PNG or JPEG).'));
        image.src = String(reader.result);
      };
      reader.onerror = () => reject(new Error('Couldn’t read that file from your phone. Try again.'));
      reader.readAsDataURL(file);
    };
    input.click();
  });
}
