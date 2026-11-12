import { getImage, getVideo, whenSettled } from './media-cache.js';
import { formatBytes, formatExifDate, isVideo } from './format.js';
import { ZoomPan } from './zoom-pan.js';

const ZOOM_STEP = 1.5;

/**
 * Full-screen overlay that shows files[i].SourceFile, with prev/next pagination
 * over the same list the grid shows, and zoom/pan for pictures.
 */
export class Viewer {
  #dialog;
  #stage;
  #metaEl;
  #zoomControls;
  #prevButton;
  #nextButton;
  #zoomPan;
  #onClose;
  #onInfo;

  #files = [];
  #index = -1;
  #media = null;

  constructor(dialog, { onClose, onInfo }) {
    this.#dialog = dialog;
    this.#stage = dialog.querySelector('#viewer-stage');
    this.#metaEl = dialog.querySelector('#viewer-meta');
    this.#zoomControls = dialog.querySelector('#viewer-zoom');
    this.#prevButton = dialog.querySelector('[data-action="prev"]');
    this.#nextButton = dialog.querySelector('[data-action="next"]');
    this.#onClose = onClose;
    this.#onInfo = onInfo;
    this.#zoomPan = new ZoomPan(this.#stage, { onSwipe: (step) => this.#go(step) });

    dialog.addEventListener('click', this.#onClick);
    dialog.addEventListener('keydown', this.#onKeyDown);
    dialog.addEventListener('close', this.#onDialogClose);
  }

  /** @param {object[]} files the current filter_files[] list @param {number} index */
  open(files, index) {
    this.#files = files;
    this.#show(index);
    if (!this.#dialog.open) this.#dialog.showModal();
  }

  #go(step) {
    const next = this.#index + step;
    if (next >= 0 && next < this.#files.length) this.#show(next);
  }

  #show(index) {
    this.#releaseMedia();

    const file = this.#files[index];
    const media = isVideo(file) ? getVideo(file.SourceFile) : getImage(file.SourceFile);
    this.#index = index;
    this.#media = media;

    if (media instanceof HTMLImageElement) {
      media.alt = file.FileName ?? '';
      media.className = 'viewer__media viewer__media--image';
      this.#zoomPan.attach(media);
    } else {
      media.className = 'viewer__media viewer__media--video';
    }

    this.#zoomControls.hidden = !(media instanceof HTMLImageElement);
    this.#stage.replaceChildren(media);
    this.#trackLoading(media);
    this.#renderInfo(file);
    this.#preloadNeighbours();
  }

  #trackLoading(media) {
    this.#stage.classList.add('is-loading');
    whenSettled(media).then((state) => {
      if (this.#media !== media) return; // The user already moved on.
      this.#stage.classList.remove('is-loading');
      if (state === 'loaded') {
        this.#zoomPan.refresh();
      } else {
        this.#stage.append(createErrorMessage());
      }
    });
  }

  #renderInfo(file) {
    const position = `${this.#index + 1} / ${this.#files.length}`;
    const details = [formatExifDate(file.date), formatBytes(file.FileSize), position].filter(Boolean);
    // One line each; built as nodes so no value is ever parsed as HTML.
    this.#metaEl.replaceChildren(...details.flatMap((text, i) =>
      i === 0 ? [text] : [document.createElement('br'), text]));
    this.#prevButton.disabled = this.#index <= 0;
    this.#nextButton.disabled = this.#index >= this.#files.length - 1;
  }

  /** Warms the cache for the neighbouring pictures so paging feels instant. */
  #preloadNeighbours() {
    for (const neighbour of [this.#files[this.#index - 1], this.#files[this.#index + 1]]) {
      if (neighbour && !isVideo(neighbour)) getImage(neighbour.SourceFile);
    }
  }

  #releaseMedia() {
    if (this.#media instanceof HTMLVideoElement) this.#media.pause();
    this.#zoomPan.detach();
    this.#media = null;
  }

  #onClick = (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    switch (action) {
      case 'close': this.#dialog.close(); break;
      case 'info': this.#onInfo(this.#files[this.#index]); break;
      case 'prev': this.#go(-1); break;
      case 'next': this.#go(1); break;
      case 'zoom-in': this.#zoomPan.zoomBy(ZOOM_STEP); break;
      case 'zoom-out': this.#zoomPan.zoomBy(1 / ZOOM_STEP); break;
      case 'zoom-reset': this.#zoomPan.reset(); break;
      default: break;
    }
  };

  #onKeyDown = (event) => {
    // Leave arrow keys to a focused <video> (seeking) and to form controls.
    if (event.target instanceof HTMLMediaElement) return;
    const isImage = this.#media instanceof HTMLImageElement;

    switch (event.key) {
      case 'ArrowLeft': this.#go(-1); break;
      case 'ArrowRight': this.#go(1); break;
      case '+': case '=': if (isImage) this.#zoomPan.zoomBy(ZOOM_STEP); break;
      case '-': if (isImage) this.#zoomPan.zoomBy(1 / ZOOM_STEP); break;
      case '0': if (isImage) this.#zoomPan.reset(); break;
      default: return;
    }
    event.preventDefault();
  };

  #onDialogClose = () => {
    this.#releaseMedia();
    this.#stage.replaceChildren();
    this.#stage.classList.remove('is-loading');
    this.#onClose(this.#index);
  };
}

function createErrorMessage() {
  const message = document.createElement('p');
  message.className = 'viewer__error';
  message.textContent = 'This file could not be loaded.';
  return message;
}
