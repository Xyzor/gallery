import { uploadFile } from './api.js';
import { formatBytes, groupFromDirectory } from './format.js';

// The same list as api_fgallery's media-types.js: the API accepts nothing else.
const UPLOAD_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.mp4', '.mov', '.webm', '.m4v'];
const MAX_UPLOAD_BYTES = 2 * 1024 ** 3;   // the API's limit (MAX_UPLOAD_BYTES in its upload.js)
// The API works on 8 uploads at a time; browsers allow about 6 connections per host.
const UPLOAD_CONCURRENCY = 4;
// The API's limits for a group path (parseGroup() in its upload.js).
const MAX_GROUP_DEPTH = 8;
const MAX_NAME_BYTES = 255;
const BAD_CHARS = /[\x00-\x1f\x7f\\]/;
const utf8 = new TextEncoder();
const IS_ANDROID = /Android/i.test(navigator.userAgent);

const STATUS_TEXT = {
  ready: 'Ready',
  collision: 'Already in the gallery',
  duplicate: 'Selected twice',
  'same-basename': 'Name clashes with another selected file',
  unsupported: 'Unsupported type',
  'too-large': 'Larger than 2 GB',
  queued: 'Waiting',
  done: 'Uploaded',
};
// A row with one of these keeps Upload disabled until it is removed.
const BLOCKING = new Set(['collision', 'duplicate', 'same-basename', 'unsupported', 'too-large']);
// Rows that have not been sent yet; only these are (re)classified.
const NOT_STARTED = new Set(['ready', ...BLOCKING]);

/**
 * Upload overlay: files picked by the user go into one folder, one request per file. The
 * folder is an existing group picked from the suggestions, a new path typed in, or an existing
 * one edited; the API creates missing folders. Upload is enabled only when the folder path is
 * valid, at least one file is listed and no row is blocked (a name that already exists anywhere
 * in the gallery, a name or basename picked twice, an unsupported type or a file over the
 * API's size limit).
 */
export class UploadDialog {
  #dialog;
  #groupInput;
  #groupList;
  #groupNote;
  /** Existing group paths without the "gallery/" prefix; new ones are added after uploading. */
  #knownGroups;
  #fileInput;
  #table;
  #body;
  #empty;
  #hint;
  #uploadButton;
  #clearButton;
  /** Every FileName in the gallery; names uploaded in this session are added. */
  #existingNames;

  /** @type {{id: number, file: File, status: string, progress: number, error: string}[]} */
  #rows = [];
  #nextId = 1;
  #uploading = false;
  #lastRun = null;            // { done, failed } of the last finished upload
  #statusCells = new Map();   // row id → its Status <td>, updated in place while uploading

  constructor(dialog, { groups, existingNames }) {
    this.#dialog = dialog;
    this.#groupInput = dialog.querySelector('#upload-group');
    this.#groupList = dialog.querySelector('#upload-groups');
    this.#groupNote = dialog.querySelector('.upload__group-note');
    this.#fileInput = dialog.querySelector('#upload-input');
    this.#table = dialog.querySelector('.upload__table');
    this.#body = this.#table.querySelector('tbody');
    this.#empty = dialog.querySelector('.upload__empty');
    this.#hint = dialog.querySelector('.upload__hint');
    this.#uploadButton = dialog.querySelector('[data-action="upload"]');
    this.#clearButton = dialog.querySelector('[data-action="clear"]');
    this.#existingNames = existingNames;

    // The top level ("gallery") is left out: the API needs a folder below it.
    this.#knownGroups = new Set(groups.map(groupFromDirectory).filter((group) => group !== null));
    this.#renderGroupOptions();
    // An image/video-only filter makes Android open its Photo Picker, which renames every file
    // to its media ID ("1000012345.jpg"). Without one Android opens the Files picker, which
    // keeps the original name (PXL_…); unsupported files are still marked in the table.
    if (!IS_ANDROID) this.#fileInput.accept = UPLOAD_EXTENSIONS.join(',');

    this.#fileInput.addEventListener('change', this.#onFilesChosen);
    // Typing only changes the controls, never the table.
    this.#groupInput.addEventListener('input', () => this.#renderControls());
    dialog.addEventListener('click', this.#onClick);
    this.#render();
  }

  open() {
    if (!this.#dialog.open) this.#dialog.showModal();
  }

  #onFilesChosen = () => {
    for (const file of this.#fileInput.files) {
      this.#rows.push({ id: this.#nextId++, file, status: 'ready', progress: 0, error: '' });
    }
    // Reset, so that picking the same file again fires another change event.
    this.#fileInput.value = '';
    this.#lastRun = null;
    this.#classify();
    this.#render();
  };

  #onClick = (event) => {
    if (event.target === this.#dialog || event.target.closest('[data-action="close"]')) {
      this.#dialog.close();   // running uploads go on; reopening shows their progress
      return;
    }
    const button = event.target.closest('[data-action]');
    switch (button?.dataset.action) {
      case 'remove': {
        const id = Number(button.dataset.id);
        this.#rows = this.#rows.filter((row) => row.id !== id);
        this.#classify();
        this.#render();
        break;
      }
      case 'clear':
        if (this.#uploading) return;
        this.#rows = [];
        this.#groupInput.value = '';
        this.#lastRun = null;
        this.#render();
        break;
      case 'upload':
        this.#upload();
        break;
      default:
        break;
    }
  };

  /** Gives every row that has not been sent yet its status. */
  #classify() {
    // Rows waiting or in flight still hold their name; uploaded names are in #existingNames.
    // The API refuses two media files with the same basename in one folder (clip.mp4 and
    // clip.webm would share the preview clip.jpg), so selected files are compared by
    // basename as well; unsupported types don't count, as for the API.
    const nameCounts = new Map();
    const stemCounts = new Map();
    for (const row of this.#rows) {
      if (!NOT_STARTED.has(row.status) && row.status !== 'queued' && row.status !== 'uploading') continue;
      const { name } = row.file;
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
      if (isUploadable(name)) stemCounts.set(stemOf(name), (stemCounts.get(stemOf(name)) ?? 0) + 1);
    }
    for (const row of this.#rows) {
      if (!NOT_STARTED.has(row.status)) continue;
      const { name, size } = row.file;
      if (!isUploadable(name)) row.status = 'unsupported';
      else if (size > MAX_UPLOAD_BYTES) row.status = 'too-large';
      else if (this.#existingNames.has(name)) row.status = 'collision';
      else if (nameCounts.get(name) > 1) row.status = 'duplicate';
      else if (stemCounts.get(stemOf(name)) > 1) row.status = 'same-basename';
      else row.status = 'ready';
    }
  }

  #count(...statuses) {
    return this.#rows.filter((row) => statuses.includes(row.status)).length;
  }

  #group() {
    return parseGroupPath(this.#groupInput.value);
  }

  #canUpload() {
    const { group, error } = this.#group();
    return !this.#uploading && group !== '' && !error
      && this.#count('ready') > 0 && this.#count(...BLOCKING) === 0;
  }

  async #upload() {
    if (!this.#canUpload()) return;
    const { group } = this.#group();   // normalised, e.g. "/2019/holiday/" → "2019/holiday"
    const queue = this.#rows.filter((row) => row.status === 'ready');
    for (const row of queue) row.status = 'queued';
    this.#uploading = true;
    this.#lastRun = null;
    this.#render();

    // A few workers share one queue: each file is its own request, at most
    // UPLOAD_CONCURRENCY of them at a time.
    const next = () => queue.shift();
    const worker = async () => {
      for (let row = next(); row; row = next()) {
        row.status = 'uploading';
        this.#render();
        const result = await uploadFile(row.file, group, (fraction) => {
          row.progress = fraction;
          this.#updateStatusCell(row);
        });
        row.status = result.ok ? 'done' : 'failed';
        row.error = result.error ?? '';
        if (result.ok) this.#existingNames.add(row.file.name);
        this.#render();
      }
    };
    await Promise.all(Array.from({ length: UPLOAD_CONCURRENCY }, worker));

    this.#uploading = false;
    this.#lastRun = { done: this.#count('done'), failed: this.#count('failed') };
    // A folder the API just created is now an existing one.
    if (this.#lastRun.done > 0 && !this.#knownGroups.has(group)) {
      this.#knownGroups.add(group);
      this.#renderGroupOptions();
    }
    // Files added while uploading may now collide with what was just uploaded.
    this.#classify();
    this.#render();
  }

  #render() {
    this.#statusCells.clear();
    this.#body.replaceChildren(...this.#rows.map((row) => this.#renderRow(row)));
    this.#table.hidden = this.#rows.length === 0;
    this.#empty.hidden = this.#rows.length > 0;
    this.#renderControls();
  }

  #renderControls() {
    this.#groupInput.disabled = this.#uploading;
    this.#uploadButton.disabled = !this.#canUpload();
    this.#clearButton.disabled = this.#uploading || this.#rows.length === 0;
    this.#hint.textContent = this.#hintText();

    const { group, error } = this.#group();
    this.#groupNote.textContent = error ?? (group && !this.#knownGroups.has(group) ? this.#newFolderNote(group) : '');
    this.#groupNote.classList.toggle('is-error', Boolean(error));
  }

  /** "2019/holiday/beach" → "New folder inside 2019/holiday." (the deepest existing parent). */
  #newFolderNote(group) {
    const segments = group.split('/');
    for (let depth = segments.length - 1; depth > 0; depth -= 1) {
      const parent = segments.slice(0, depth).join('/');
      if (this.#knownGroups.has(parent)) return `New folder inside ${parent}.`;
    }
    return 'New folder.';
  }

  #renderGroupOptions() {
    const paths = [...this.#knownGroups].sort((a, b) => a.localeCompare(b));
    this.#groupList.replaceChildren(...paths.map((path) => new Option(path)));
  }

  #renderRow(row) {
    const tr = document.createElement('tr');
    tr.dataset.status = row.status;

    // Built as nodes: filenames are never parsed as HTML.
    const name = document.createElement('td');
    name.className = 'upload__name';
    name.textContent = row.file.name;

    const size = document.createElement('td');
    size.className = 'upload__size';
    size.textContent = formatBytes(row.file.size) || '0 B';

    const status = document.createElement('td');
    status.className = 'upload__status';
    this.#statusCells.set(row.id, status);
    this.#fillStatus(status, row);

    const action = document.createElement('td');
    action.className = 'upload__action';
    if (row.status !== 'queued' && row.status !== 'uploading' && row.status !== 'done') {
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'icon-button upload__remove';
      remove.dataset.action = 'remove';
      remove.dataset.id = String(row.id);
      remove.setAttribute('aria-label', `Remove ${row.file.name}`);
      remove.textContent = '×';
      action.append(remove);
    }

    tr.append(name, size, status, action);
    return tr;
  }

  #fillStatus(cell, row) {
    if (row.status === 'uploading') cell.textContent = `Uploading ${Math.round(row.progress * 100)} %`;
    else if (row.status === 'failed') cell.textContent = `Failed: ${row.error}`;
    else cell.textContent = STATUS_TEXT[row.status];
    cell.classList.toggle('is-error', BLOCKING.has(row.status) || row.status === 'failed');
    cell.classList.toggle('is-done', row.status === 'done');
  }

  /** Progress events only touch the one cell, not the whole table. */
  #updateStatusCell(row) {
    const cell = this.#statusCells.get(row.id);
    if (cell) this.#fillStatus(cell, row);
  }

  #hintText() {
    if (this.#uploading) {
      const finished = this.#count('done', 'failed');
      const total = finished + this.#count('queued', 'uploading');
      return `Uploading… ${finished} of ${total} finished.`;
    }

    // Right after an upload, with nothing new added: report the result.
    if (this.#lastRun && this.#count('ready', ...BLOCKING) === 0) {
      const { done, failed } = this.#lastRun;
      // The note under the file list already says when new files show up.
      return `${done} uploaded${failed ? `, ${failed} failed` : ''}.`;
    }

    const problems = [];
    const { group, error } = this.#group();
    if (error) problems.push('Fix the folder path.');
    else if (group === '') problems.push('Choose or type a folder.');
    if (this.#count('ready', ...BLOCKING) === 0) problems.push('Add at least one file.');
    const clashes = this.#count('collision', 'duplicate', 'same-basename');
    if (clashes > 0) {
      problems.push(`${clashes} file(s) already exist in the gallery or clash with another selected file: remove them to upload.`);
    }
    const invalid = this.#count('unsupported', 'too-large');
    if (invalid > 0) problems.push(`${invalid} file(s) can't be uploaded: remove them to upload.`);
    return problems.join(' ');
  }
}

/**
 * Normalises a typed folder path the way the API's parseGroup() does (NFC, trimmed, no leading
 * or trailing "/") and checks it against the API's rules, so a path that passes here is never
 * refused there.
 * @returns {{group: string, error: string | null}} group '' when the field is empty
 */
function parseGroupPath(text) {
  const group = text.normalize('NFC').trim().replace(/^\/+|\/+$/g, '');
  if (group === '') return { group, error: null };

  const segments = group.split('/');
  const fail = (error) => ({ group, error });
  if (segments.length > MAX_GROUP_DEPTH) return fail(`Up to ${MAX_GROUP_DEPTH} folder levels.`);
  // Paths start below gallery/; this would create gallery/gallery/….
  if (segments[0] === 'gallery') return fail('Leave out "gallery/": paths start below it.');
  for (const segment of segments) {
    if (segment === '') return fail('A folder name is empty (two slashes in a row).');
    if (segment !== segment.trim()) return fail("A folder name can't start or end with a space.");
    if (segment.startsWith('.')) return fail("A folder name can't start with a dot.");
    if (BAD_CHARS.test(segment)) return fail("Folder names can't contain \\ or control characters.");
    if (segment === '_preview_') return fail('_preview_ is reserved for previews.');
    if (utf8.encode(segment).length > MAX_NAME_BYTES) return fail('A folder name is too long.');
  }
  return { group, error: null };
}

function extensionOf(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

function isUploadable(name) {
  return UPLOAD_EXTENSIONS.includes(extensionOf(name));
}

/** "clip.mp4" → "clip": the same rule as stemOf() in the API's upload.js. */
function stemOf(name) {
  return name.replace(/\.[^.]*$/, '');
}
