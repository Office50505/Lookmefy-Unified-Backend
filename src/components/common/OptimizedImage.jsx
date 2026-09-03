import { useEffect, useRef } from 'react';

export function highResolutionImageSource(src) {
  const value = String(src || '').trim();
  if (!/(?:m\.media-amazon\.(?:com|in)|images-(?:na|eu|fe)\.ssl-images-amazon\.com)\/images\//i.test(value)) return value;

  // Imported Amazon products often use small thumbnails such as SX342, UY445,
  // UL320, or multi-part FM/QL variants. Request the same CDN asset larger so
  // product detail imagery stays crisp on retina displays.
  if (/\._[^.]*_\.(?=(?:avif|jpe?g|png|webp)(?:[?#]|$))/i.test(value)) {
    return value.replace(/\._[^.]*_\.(?=(?:avif|jpe?g|png|webp)(?:[?#]|$))/i, '._AC_SL1500_.');
  }

  return value.replace(/\.((?:avif|jpe?g|png|webp)(?:[?#].*)?)$/i, '._AC_SL1500_.$1');
}

/**
 * @typedef {import('react').ImgHTMLAttributes<HTMLImageElement> & {
 *   eager?: boolean;
 *   fallbackSrc?: string;
 *   highResolution?: boolean;
 * }} OptimizedImageProps
 */

/**
 * Shared image primitive for consistent lazy loading and async decoding.
 *
 * @param {OptimizedImageProps} props
 */
export default function OptimizedImage({ eager = false, loading, decoding = 'async', fetchPriority, fallbackSrc = '/assets/hero2.png', highResolution = true, src, onError, ...props }) {
  const fallbackApplied = useRef(false);
  const imageSrc = highResolution ? highResolutionImageSource(src) : String(src || '').trim();

  useEffect(() => {
    fallbackApplied.current = false;
  }, [imageSrc, fallbackSrc]);

  const handleError = (event) => {
    onError?.(event);
    if (fallbackApplied.current || !fallbackSrc || event.currentTarget.src.endsWith(fallbackSrc)) return;
    fallbackApplied.current = true;
    event.currentTarget.src = fallbackSrc;
  };

  return (
    <img
      src={imageSrc}
      loading={loading || (eager ? 'eager' : 'lazy')}
      decoding={decoding}
      fetchPriority={fetchPriority || (eager ? 'high' : 'auto')}
      onError={handleError}
      {...props}
    />
  );
}
