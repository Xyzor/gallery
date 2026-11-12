import { fetchGallery } from './api.js';
import { countActiveSections, createEmptyCriteria, filterFiles, findDateBounds } from './filter.js';
import { FilterDialog } from './filter-dialog.js';
import { InfoDialog } from './info-dialog.js';
import { UploadDialog } from './upload-dialog.js';
import { Grid } from './grid.js';
import { Viewer } from './viewer.js';

const state = {
  files: [],          // files[] from the API, never modified
  filterFiles: [],    // filter_files[]: what the grid and viewer currently show
  criteria: createEmptyCriteria(),
};

const ui = {
  status: document.getElementById('status'),
  count: document.getElementById('result-count'),
  filterButton: document.getElementById('open-filter'),
  filterBadge: document.getElementById('filter-badge'),
  uploadButton: document.getElementById('open-upload'),
};

async function init() {
  let gallery;
  try {
    gallery = await fetchGallery();
  } catch (error) {
    showStatus(error.message);
    return;
  }

  state.files = gallery.files;

  const info = new InfoDialog(document.getElementById('info-dialog'));

  const viewer = new Viewer(document.getElementById('viewer'), {
    onClose: (index) => grid.reveal(index),
    onInfo: (file) => info.open(file),
  });

  const grid = new Grid(document.getElementById('grid'), document.getElementById('grid-sentinel'), {
    onSelect: (index) => viewer.open(state.filterFiles, index),
    onInfo: (index) => info.open(state.filterFiles[index]),
  });

  const filterDialog = new FilterDialog(document.getElementById('filter-dialog'), {
    groups: gallery.groups,
    kinds: [...new Set(gallery.files.map((file) => file.kind).filter(Boolean))],
    dateBounds: findDateBounds(gallery.files),
    onApply: (criteria) => applyFilter(grid, criteria),
  });

  ui.filterButton.addEventListener('click', () => filterDialog.open(state.criteria));
  ui.filterButton.disabled = false;

  const uploadDialog = new UploadDialog(document.getElementById('upload-dialog'), {
    groups: gallery.groups,
    // An upload may not reuse a name that exists anywhere in the gallery.
    existingNames: new Set(gallery.files.map((file) => file.FileName)),
  });
  ui.uploadButton.addEventListener('click', () => uploadDialog.open());
  ui.uploadButton.disabled = false;

  applyFilter(grid, state.criteria);
}

function applyFilter(grid, criteria) {
  state.criteria = criteria;
  state.filterFiles = filterFiles(state.files, criteria);
  grid.setFiles(state.filterFiles);
  renderSummary();
}

function renderSummary() {
  const shown = state.filterFiles.length;
  const total = state.files.length;
  const activeSections = countActiveSections(state.criteria);

  ui.count.textContent = activeSections > 0 ? `${shown} of ${total}` : `${total} files`;
  ui.filterBadge.textContent = String(activeSections);
  ui.filterBadge.hidden = activeSections === 0;

  if (total === 0) showStatus('The gallery is empty.');
  else if (shown === 0) showStatus('No files match the current filter.');
  else showStatus('');
}

function showStatus(message) {
  ui.status.textContent = message;
  ui.status.hidden = message === '';
}

init();
