import { exifToIsoDay } from './format.js';

/**
 * Filter criteria. An empty set / empty date means "no restriction" for that section.
 * `undated` adds the files without a date to the date section's result.
 * @typedef {{groups: Set<string>, kinds: Set<string>, from: string, to: string, undated: boolean}} Criteria
 */

/** @returns {Criteria} */
export function createEmptyCriteria() {
  return { groups: new Set(), kinds: new Set(), from: '', to: '', undated: false };
}

/** Number of sections that currently restrict the result (used for the filter badge). */
export function countActiveSections(criteria) {
  const hasDates = Boolean(criteria.from || criteria.to || criteria.undated);
  return [criteria.groups.size > 0, criteria.kinds.size > 0, hasDates].filter(Boolean).length;
}

/**
 * Builds filter_files[] from files[]. Keeps the original order, so the grid stays deterministic.
 * @param {object[]} files
 * @param {Criteria} criteria
 */
export function filterFiles(files, criteria) {
  return files.filter((file) => matches(file, criteria));
}

/** Earliest and latest `date` day, used as bounds for the date inputs. */
export function findDateBounds(files) {
  let min = '';
  let max = '';
  for (const file of files) {
    const day = exifToIsoDay(file.date);
    if (!day) continue;
    if (!min || day < min) min = day;
    if (!max || day > max) max = day;
  }
  return { min, max };
}

function matches(file, criteria) {
  if (criteria.groups.size > 0 && !criteria.groups.has(file.Directory)) return false;
  if (criteria.kinds.size > 0 && !criteria.kinds.has(file.kind)) return false;
  return matchesDate(exifToIsoDay(file.date), criteria);
}

/**
 * Date section: files in the from/to range, plus the files without a date when `undated`
 * is checked. Only the checkbox → only undated files; neither → no restriction.
 */
function matchesDate(day, { from, to, undated }) {
  const hasRange = Boolean(from || to);
  if (!hasRange && !undated) return true;
  if (!day) return undated; // A file without a date can't be placed inside an interval.
  if (!hasRange) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}
