// EXIF dates look like "2020:02:12 12:32:16". Invalid cameras write "0000:00:00 00:00:00".
const EXIF_DATE = /^(\d{4}):(\d{2}):(\d{2})(?: (\d{2}):(\d{2}))?/;

/**
 * Converts an EXIF date to a "YYYY-MM-DD" day string (the <input type="date"> format),
 * so days compare as plain strings with no time-zone conversion.
 * @returns {string|null}
 */
export function exifToIsoDay(value) {
  const match = parseExif(value);
  return match ? `${match.year}-${match.month}-${match.day}` : null;
}

/** "2020:02:12 12:32:16" → "2020-02-12 12:32" (wall-clock time as recorded). */
export function formatExifDate(value) {
  const match = parseExif(value);
  if (!match) return '';
  const day = `${match.year}-${match.month}-${match.day}`;
  return match.hour ? `${day} ${match.hour}:${match.minute}` : day;
}

/**
 * "2026:08:28 09:54:00" + "+02:00" → "2026-08-28 09:54:00 +02:00". A value that carries its
 * own offset ("2024:03:04 11:00:00+01:00", videos) keeps it and `offset` is ignored.
 * @returns {string} '' when the value is missing or invalid
 */
export function formatExifDateTime(value, offset) {
  if (!parseExif(value)) return '';
  const text = value.trim();
  const day = text.slice(0, 10).replaceAll(':', '-');
  const ownOffset = text.slice(19).trim();
  const zone = ownOffset || (typeof offset === 'string' ? offset : '');
  return `${day}${text.slice(10, 19)}${zone ? ` ${zone}` : ''}`;
}

/** "gallery/2023/holiday" → "2023 - holiday"; files directly in gallery/ have "gallery". */
export function formatGroup(directory) {
  const path = directory.replace(/^gallery(\/|$)/, '');
  return path === '' ? 'Gallery (top level)' : path.replaceAll('/', ' - ');
}

/**
 * "gallery/2023/holiday" → "2023/holiday", the `group` the upload API expects. null for
 * "gallery" itself: the API only accepts folders below it.
 */
export function groupFromDirectory(directory) {
  const path = directory.replace(/^gallery(\/|$)/, '');
  return path === '' ? null : path;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

/**
 * Formats exiftool's Duration as "m:ss" or "h:mm:ss".
 *
 * exiftool stores Duration in seconds (the raw track length divided by the file's TimeScale),
 * so a JSON number, as produced with `-n`, is seconds and may have decimals (e.g. 12.345).
 * Without `-n` exiftool prints "12.35 s" (under 30 s) or "0:01:05"; both are accepted too.
 * @returns {string} '' when the value is missing or invalid
 */
export function formatDuration(value) {
  const totalSeconds = Math.round(durationToSeconds(value));
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '';

  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = String(totalSeconds % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
    : `${minutes}:${seconds}`;
}

function durationToSeconds(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string' || value.trim() === '') return NaN;

  // exiftool may append " (approx)" when the duration was estimated from the bit rate.
  const text = value.trim().replace(/\s*\(approx\)$/, '').replace(/\s*s$/, '');
  if (!text.includes(':')) return Number(text);
  // "h:mm:ss" or "m:ss" → seconds
  return text.split(':').reduce((total, part) => total * 60 + Number(part), 0);
}

/** `kind` is "image" or "video", set by the backend from the file extension. */
export function isVideo(file) {
  return file.kind === 'video';
}

function parseExif(value) {
  const match = typeof value === 'string' ? EXIF_DATE.exec(value) : null;
  if (!match || match[1] === '0000') return null;
  const [, year, month, day, hour, minute] = match;
  return { year, month, day, hour, minute };
}
