const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;

/**
 * True when a url node points at an image file. Those are drawn with <img> fit to the frame (object-fit: contain)
 * instead of an iframe, which shows an image at its natural pixel size — a retina screenshot then looks 2-4x zoomed in.
 */
export function isImageUrl(url: string): boolean {
  let path = url.trim();
  if (path.startsWith('data:image/')) return true;
  try {
    path = new URL(path, 'http://x').pathname;
  } catch {
    path = path.split(/[?#]/)[0] ?? '';
  }
  return IMAGE_EXT.test(path);
}
