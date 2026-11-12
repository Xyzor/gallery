const FILES_ENDPOINT = '/api/get-files';
const UPLOAD_ENDPOINT = '/api/upload';

// The upload API's error codes, as shown in the upload table.
const UPLOAD_ERRORS = {
  already_exists: 'Already exists',
  same_basename_exists: 'Another file with this name exists in the folder',
  unsupported_type: 'Unsupported type',
  content_does_not_match_type: "Content doesn't match the file type",
  file_too_large: 'Too large',
  busy: 'Server busy, try again',
  insufficient_storage: 'Server disk full',
};

/**
 * Loads the gallery index once. Everything after this (filtering, paging) is local.
 * @returns {Promise<{files: object[], groups: string[]}>}
 */
export async function fetchGallery() {
  const response = await fetch(FILES_ENDPOINT, { headers: { Accept: 'application/json' } });
  if (!response.ok) {
    throw new Error(`Could not load the gallery (HTTP ${response.status}).`);
  }

  const data = await response.json();
  return {
    files: asArray(data.files),
    groups: asArray(data.groups),
  };
}

/**
 * Uploads one file into `group` (a folder below gallery/, e.g. "2023/holiday").
 * XMLHttpRequest rather than fetch, because only it reports upload progress.
 * @param {File} file
 * @param {string} group
 * @param {(fraction: number) => void} onProgress  0..1 while the body is sent
 * @returns {Promise<{ok: boolean, error?: string}>} never rejects
 */
export function uploadFile(file, group, onProgress) {
  return new Promise((resolve) => {
    const form = new FormData();
    form.append('group', group);
    form.append('file', file, file.name);

    const request = new XMLHttpRequest();
    request.open('POST', UPLOAD_ENDPOINT);
    request.responseType = 'json';
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    });
    request.addEventListener('load', () => {
      if (request.status === 201) return resolve({ ok: true });
      const code = request.response?.error;
      resolve({ ok: false, error: UPLOAD_ERRORS[code] ?? `HTTP ${request.status}` });
    });
    request.addEventListener('error', () => resolve({ ok: false, error: 'Network error' }));
    request.send(form);
  });
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}
