import {
  formatBytes, formatDuration, formatExifDate, formatExifDateTime, formatGroup,
} from './format.js';

const MISSING = '—';
const BYTE_COUNT = new Intl.NumberFormat('en-US');

/** [label, file → display text]. Every row is always shown; '' becomes MISSING. */
const ROWS = [
  ['File name', (file) => file.FileName ?? ''],
  ['Folder', (file) => (file.Directory ? formatGroup(file.Directory) : '')],
  ['Type', (file) => file.MIMEType ?? ''],
  ['Size', (file) => {
    const size = formatBytes(file.FileSize);
    return size ? `${size} (${BYTE_COUNT.format(file.FileSize)} bytes)` : '';
  }],
  ['Dimensions', (file) => (file.width && file.height ? `${file.width} × ${file.height}` : '')],
  ['Orientation', (file) => (file.orientation == null ? '' : String(file.orientation))],
  ['Duration', (file) => formatDuration(file.duration)],
  ['Date', (file) => formatExifDate(file.date)],
  ['Taken', (file) => formatExifDateTime(file.DateTimeOriginal, file.OffsetTimeOriginal)],
  ['Created', (file) => formatExifDateTime(file.CreateDate, file.OffsetTimeDigitized)],
];

/**
 * "Details" overlay: a table with one file's metadata. Opened from a tile's "i" button or
 * from the viewer; when opened over the viewer it stacks on top, so Escape closes it first.
 */
export class InfoDialog {
  #dialog;
  #body;

  constructor(dialog) {
    this.#dialog = dialog;
    this.#body = dialog.querySelector('.info__table tbody');
    dialog.addEventListener('click', this.#onClick);
  }

  /** @param {object} file one entry of files[] */
  open(file) {
    // Built as nodes: filenames and folder names are never parsed as HTML.
    this.#body.replaceChildren(...ROWS.map(([label, format]) => {
      const row = document.createElement('tr');
      const head = document.createElement('th');
      head.scope = 'row';
      head.textContent = label;
      const value = document.createElement('td');
      value.textContent = format(file) || MISSING;
      row.append(head, value);
      return row;
    }));
    if (!this.#dialog.open) this.#dialog.showModal();
  }

  #onClick = (event) => {
    const clickedBackdrop = event.target === this.#dialog;
    const clickedClose = event.target.closest('[data-action="close"]');
    if (clickedBackdrop || clickedClose) this.#dialog.close();
  };
}
