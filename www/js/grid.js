import { getImage, whenSettled } from './media-cache.js';
import { formatDuration, isVideo } from './format.js';

const PAGE_SIZE = 60;
// Start rendering the next page well before the user reaches the end of the list.
const PRELOAD_MARGIN = '800px 0px';

/**
 * Deterministic square grid with infinite loading: tiles are appended one page at a time
 * when a sentinel below the grid comes near the viewport.
 */
export class Grid {
  #list;
  #sentinel;
  #observer;
  #files = [];
  #renderedCount = 0;
  /** Tiles are reused across filter changes, so their preview images are never re-fetched. */
  #tiles = new Map();

  constructor(list, sentinel, { onSelect, onInfo }) {
    this.#list = list;
    this.#sentinel = sentinel;
    this.#observer = new IntersectionObserver(this.#onIntersect, { rootMargin: PRELOAD_MARGIN });

    list.addEventListener('click', (event) => {
      const button = event.target.closest('[data-index]');
      if (!button) return;
      const index = Number(button.dataset.index);
      if (button.classList.contains('tile__info')) onInfo(index);
      else onSelect(index);
    });
  }

  /** Replaces the grid content with a new filter_files[] list. */
  setFiles(files) {
    this.#files = files;
    this.#renderedCount = 0;
    this.#list.replaceChildren();
    window.scrollTo({ top: 0 });
    this.#renderNextPage();
    this.#rearmObserver();
  }

  /** Makes sure the tile at `index` exists, then scrolls it into view and focuses it. */
  reveal(index) {
    while (index >= this.#renderedCount && this.#hasMore()) this.#renderNextPage();
    this.#rearmObserver();

    const file = this.#files[index];
    const button = file && this.#tiles.get(file)?.firstElementChild;
    if (!button) return;
    button.scrollIntoView({ block: 'nearest' });
    button.focus({ preventScroll: true });
  }

  #hasMore() {
    return this.#renderedCount < this.#files.length;
  }

  #onIntersect = (entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    this.#renderNextPage();
    this.#rearmObserver();
  };

  /**
   * An IntersectionObserver only reports changes. Re-observing forces a fresh check, so another
   * page is loaded if the sentinel is still near the viewport (e.g. on large screens).
   */
  #rearmObserver() {
    this.#observer.unobserve(this.#sentinel);
    if (this.#hasMore()) this.#observer.observe(this.#sentinel);
  }

  #renderNextPage() {
    const end = Math.min(this.#renderedCount + PAGE_SIZE, this.#files.length);
    const fragment = document.createDocumentFragment();

    for (let index = this.#renderedCount; index < end; index += 1) {
      const tile = this.#getTile(this.#files[index]);
      // Both the tile button and its "i" button point at the same file.
      for (const button of tile.children) button.dataset.index = String(index);
      fragment.append(tile);
    }

    this.#list.append(fragment);
    this.#renderedCount = end;
  }

  #getTile(file) {
    let tile = this.#tiles.get(file);
    // A tile whose preview failed is rebuilt, which retries the download.
    if (!tile || tile.querySelector('.tile__image.is-broken')) {
      tile = createTile(file);
      this.#tiles.set(file, tile);
    }
    return tile;
  }
}

function createTile(file) {
  const item = document.createElement('li');
  item.className = 'grid__item';

  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'tile';
  button.setAttribute('aria-label', file.FileName ?? 'Open file');

  // previewImageUrl is null until create_previews.sh has run for this file. The full-size
  // original is deliberately never used instead: it is far too big for a tile.
  if (file.previewImageUrl) {
    const image = getImage(file.previewImageUrl);
    image.className = 'tile__image';
    image.alt = '';
    whenSettled(image).then((state) => {
      image.classList.add(state === 'loaded' ? 'is-loaded' : 'is-broken');
    });
    button.append(image);
  } else {
    button.append(createPlaceholder(file));
  }

  if (isVideo(file)) {
    const length = formatDuration(file.duration);
    button.append(createVideoBadge(length));
    const name = file.FileName ?? 'Video';
    button.setAttribute('aria-label', length ? `${name} (video, ${length})` : `${name} (video)`);
  }

  // A sibling of the tile button, not a child: a button inside a button is invalid HTML.
  const info = document.createElement('button');
  info.type = 'button';
  info.className = 'info-button tile__info';
  info.textContent = 'i';
  info.setAttribute('aria-label', `Details for ${file.FileName ?? 'this file'}`);

  item.append(button, info);
  return item;
}

function createPlaceholder(file) {
  const placeholder = document.createElement('span');
  placeholder.className = 'tile__placeholder';
  placeholder.setAttribute('aria-hidden', 'true');
  placeholder.textContent = file.FileName ?? '';
  return placeholder;
}

function createVideoBadge(length) {
  const badge = document.createElement('span');
  badge.className = 'tile__badge';
  badge.setAttribute('aria-hidden', 'true');

  const icon = document.createElement('span');
  icon.className = 'tile__badge-icon';
  icon.textContent = '▶';
  badge.append(icon);

  if (length) {
    const time = document.createElement('span');
    time.className = 'tile__badge-time';
    time.textContent = length;
    badge.append(time);
  }
  return badge;
}
