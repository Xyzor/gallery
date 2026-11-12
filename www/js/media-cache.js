/**
 * In-memory media cache: every <img>/<video> element ever created is kept, keyed by URL.
 *
 * Moving an already-loaded element back into the DOM never triggers a new request, so each
 * file is downloaded at most once per page lifetime. A refresh or closing the tab drops it.
 *
 * Why elements rather than blobs: the CSP allows neither `blob:` URLs (img-src / media-src)
 * nor `data:` URLs for video (media-src 'self'), so keeping the loaded elements is the only
 * way to hold media in memory under this policy.
 */
const images = new Map();
const videos = new Map();

/**
 * A cached element that failed (e.g. a network drop) is replaced, so asking again retries the
 * download. Loading and loaded elements are always reused.
 * @returns {HTMLImageElement} starts downloading immediately on first request
 */
export function getImage(url) {
  // new Image().src = null would request "/null".
  if (!url) throw new TypeError('getImage: missing url');
  let image = images.get(url);
  if (!image || currentState(image) === 'error') {
    image = new Image();
    image.decoding = 'async';
    image.draggable = false;
    image.src = url;
    images.set(url, image);
  }
  return image;
}

/** @returns {HTMLVideoElement} */
export function getVideo(url) {
  let video = videos.get(url);
  if (!video || currentState(video) === 'error') {
    video = document.createElement('video');
    video.controls = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = url;
    videos.set(url, video);
  }
  return video;
}

/**
 * Resolves once the element can be shown ('loaded') or has failed ('error').
 * Resolves immediately for elements that already settled earlier.
 * @param {HTMLImageElement|HTMLVideoElement} element
 * @returns {Promise<'loaded'|'error'>}
 */
export function whenSettled(element) {
  const state = currentState(element);
  if (state) return Promise.resolve(state);

  const readyEvent = element instanceof HTMLVideoElement ? 'loadedmetadata' : 'load';
  return new Promise((resolve) => {
    const settle = (result) => () => {
      element.removeEventListener(readyEvent, onReady);
      element.removeEventListener('error', onError);
      resolve(result);
    };
    const onReady = settle('loaded');
    const onError = settle('error');
    element.addEventListener(readyEvent, onReady);
    element.addEventListener('error', onError);
  });
}

function currentState(element) {
  if (element instanceof HTMLVideoElement) {
    if (element.error) return 'error';
    return element.readyState >= HTMLMediaElement.HAVE_METADATA ? 'loaded' : null;
  }
  if (!element.complete) return null;
  return element.naturalWidth > 0 ? 'loaded' : 'error';
}
