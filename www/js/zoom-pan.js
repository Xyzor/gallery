const MIN_SCALE = 1;
const MAX_SCALE = 8;
const DOUBLE_TAP_SCALE = 2.5;
const DOUBLE_TAP_MS = 300;
const TAP_SLOP_PX = 10;
const SWIPE_MIN_PX = 60;
const WHEEL_SENSITIVITY = 0.002;

/**
 * Pinch / wheel / double-tap zoom and drag panning for one image inside a stage element.
 *
 * Coordinates are measured from the stage centre, and the image is rendered with
 * `object-fit: contain` + `transform-origin: center`, so a transform of
 * `translate(x, y) scale(s)` maps content point c to screen point `x + c * s`.
 *
 * When not zoomed, a horizontal swipe calls `onSwipe(+1 | -1)` for pagination.
 */
export class ZoomPan {
  #stage;
  #onSwipe;
  #target = null;
  #scale = MIN_SCALE;
  #x = 0;
  #y = 0;
  #pointers = new Map();
  #gesture = null;
  #lastTap = null;

  constructor(stage, { onSwipe }) {
    this.#stage = stage;
    this.#onSwipe = onSwipe;

    stage.addEventListener('pointerdown', this.#onPointerDown);
    stage.addEventListener('pointermove', this.#onPointerMove);
    stage.addEventListener('pointerup', this.#onPointerUp);
    stage.addEventListener('pointercancel', this.#onPointerUp);
    stage.addEventListener('wheel', this.#onWheel, { passive: false });
    window.addEventListener('resize', () => this.#apply());
  }

  attach(target) {
    this.detach();
    this.#target = target;
    this.reset();
  }

  detach() {
    if (this.#target) this.#target.style.transform = '';
    this.#target = null;
    this.#pointers.clear();
    this.#gesture = null;
    this.#lastTap = null;
    this.#stage.classList.remove('is-zoomed');
  }

  reset() {
    this.#scale = MIN_SCALE;
    this.#x = 0;
    this.#y = 0;
    this.#apply();
  }

  /** Re-clamps the current position, e.g. once the image's natural size is known. */
  refresh() {
    this.#apply();
  }

  zoomBy(factor) {
    this.#zoomTo(this.#scale * factor, { x: 0, y: 0 });
  }

  get #isZoomed() {
    return this.#scale > MIN_SCALE;
  }

  // ---- gestures -------------------------------------------------------------

  #onPointerDown = (event) => {
    if (!this.#target || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    this.#stage.setPointerCapture(event.pointerId);
    this.#pointers.set(event.pointerId, this.#toStagePoint(event));

    if (this.#pointers.size === 1) this.#startDrag(this.#toStagePoint(event), false);
    if (this.#pointers.size === 2) this.#startPinch();
  };

  #onPointerMove = (event) => {
    if (!this.#pointers.has(event.pointerId)) return;
    const point = this.#toStagePoint(event);
    this.#pointers.set(event.pointerId, point);

    if (this.#gesture?.type === 'pinch') this.#movePinch();
    else if (this.#gesture?.type === 'drag') this.#moveDrag(point);
  };

  #onPointerUp = (event) => {
    if (!this.#pointers.has(event.pointerId)) return;
    const point = this.#toStagePoint(event);
    this.#pointers.delete(event.pointerId);
    const gesture = this.#gesture;

    if (gesture?.type === 'pinch') {
      // Continue panning with the finger that is still down, without triggering tap/swipe.
      const remaining = this.#pointers.values().next().value;
      if (remaining) this.#startDrag(remaining, true);
      else this.#gesture = null;
      return;
    }

    if (gesture?.type === 'drag' && this.#pointers.size === 0) {
      this.#gesture = null;
      if (event.type === 'pointercancel') return;
      if (!gesture.moved) this.#handleTap(point, event.timeStamp);
      else this.#handleSwipe(point.x - gesture.start.x, point.y - gesture.start.y);
    }
  };

  #onWheel = (event) => {
    if (!this.#target) return;
    event.preventDefault();
    const pixels = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * 16 : event.deltaY;
    this.#zoomTo(this.#scale * Math.exp(-pixels * WHEEL_SENSITIVITY), this.#toStagePoint(event));
  };

  #startDrag(point, alreadyMoved) {
    this.#gesture = { type: 'drag', start: point, originX: this.#x, originY: this.#y, moved: alreadyMoved };
  }

  #moveDrag(point) {
    const gesture = this.#gesture;
    const dx = point.x - gesture.start.x;
    const dy = point.y - gesture.start.y;
    if (Math.hypot(dx, dy) > TAP_SLOP_PX) gesture.moved = true;
    if (!this.#isZoomed) return; // Unzoomed drags are swipes, handled on release.

    this.#x = gesture.originX + dx;
    this.#y = gesture.originY + dy;
    this.#apply();
  }

  #startPinch() {
    const [a, b] = this.#pointers.values();
    const mid = midpoint(a, b);
    this.#gesture = {
      type: 'pinch',
      startDistance: Math.max(distance(a, b), 1),
      startScale: this.#scale,
      // The content point under the fingers stays under the fingers for the whole pinch.
      anchor: { x: (mid.x - this.#x) / this.#scale, y: (mid.y - this.#y) / this.#scale },
    };
  }

  #movePinch() {
    const [a, b] = this.#pointers.values();
    const { startDistance, startScale, anchor } = this.#gesture;
    const mid = midpoint(a, b);

    this.#scale = clamp(startScale * (distance(a, b) / startDistance), MIN_SCALE, MAX_SCALE);
    this.#x = mid.x - anchor.x * this.#scale;
    this.#y = mid.y - anchor.y * this.#scale;
    this.#apply();
  }

  #handleTap(point, time) {
    const last = this.#lastTap;
    const isDoubleTap = last && time - last.time < DOUBLE_TAP_MS && distance(last.point, point) < TAP_SLOP_PX * 2;

    if (!isDoubleTap) {
      this.#lastTap = { point, time };
      return;
    }

    this.#lastTap = null;
    if (this.#isZoomed) this.reset();
    else this.#zoomTo(DOUBLE_TAP_SCALE, point);
  }

  #handleSwipe(dx, dy) {
    if (this.#isZoomed) return;
    if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) < Math.abs(dy)) return;
    this.#onSwipe(dx < 0 ? 1 : -1); // Swipe left → next file.
  }

  // ---- transform ------------------------------------------------------------

  /** Zooms to `scale`, keeping the content under `point` fixed on screen. */
  #zoomTo(scale, point) {
    const next = clamp(scale, MIN_SCALE, MAX_SCALE);
    const ratio = next / this.#scale;
    this.#x = point.x - (point.x - this.#x) * ratio;
    this.#y = point.y - (point.y - this.#y) * ratio;
    this.#scale = next;
    this.#apply();
  }

  #apply() {
    if (!this.#target) return;

    if (this.#isZoomed) {
      this.#clampOffset();
    } else {
      this.#x = 0;
      this.#y = 0;
    }

    this.#target.style.transform = `translate(${this.#x}px, ${this.#y}px) scale(${this.#scale})`;
    this.#stage.classList.toggle('is-zoomed', this.#isZoomed);
  }

  /** Stops the picture edges from being dragged past the stage edges. */
  #clampOffset() {
    const stage = this.#stage.getBoundingClientRect();
    const content = this.#fittedContentSize(stage.width, stage.height);
    const maxX = Math.max(0, (content.width * this.#scale - stage.width) / 2);
    const maxY = Math.max(0, (content.height * this.#scale - stage.height) / 2);
    this.#x = clamp(this.#x, -maxX, maxX);
    this.#y = clamp(this.#y, -maxY, maxY);
  }

  /** Size of the picture itself (without letterboxing) at scale 1, as `object-fit: contain` draws it. */
  #fittedContentSize(stageWidth, stageHeight) {
    const naturalWidth = this.#target.naturalWidth || stageWidth;
    const naturalHeight = this.#target.naturalHeight || stageHeight;
    const fit = Math.min(stageWidth / naturalWidth, stageHeight / naturalHeight);
    return { width: naturalWidth * fit, height: naturalHeight * fit };
  }

  #toStagePoint(event) {
    const rect = this.#stage.getBoundingClientRect();
    return {
      x: event.clientX - rect.left - rect.width / 2,
      y: event.clientY - rect.top - rect.height / 2,
    };
  }
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function midpoint(a, b) {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
