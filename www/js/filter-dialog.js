import { formatGroup } from './format.js';

/**
 * Filter overlay. Reads/writes Criteria objects; it never filters anything itself.
 */
export class FilterDialog {
  #dialog;
  #form;
  #fromInput;
  #toInput;
  #undatedInput;
  #groupSearch;
  #noMatch;
  #selectedCount;
  #onApply;

  constructor(dialog, { groups, kinds, dateBounds, onApply }) {
    this.#dialog = dialog;
    this.#form = dialog.querySelector('#filter-form');
    this.#fromInput = dialog.querySelector('#filter-from');
    this.#toInput = dialog.querySelector('#filter-to');
    this.#undatedInput = dialog.querySelector('#filter-undated');
    this.#groupSearch = dialog.querySelector('#filter-group-search');
    this.#noMatch = dialog.querySelector('.filter__no-match');
    this.#selectedCount = dialog.querySelector('.filter__selected-count');
    this.#onApply = onApply;

    const groupList = dialog.querySelector('#filter-groups');
    renderCheckboxes(groupList, 'group', groups);
    renderCheckboxes(dialog.querySelector('#filter-kinds'), 'kind', kinds);
    setDateBounds([this.#fromInput, this.#toInput], dateBounds);
    // What the folder search matches: the shown label ("2023 - holiday") and the path.
    for (const box of this.#checkboxes('group')) {
      const label = box.closest('label');
      label.dataset.search = fold(`${label.textContent}\n${box.value}`);
    }

    this.#form.addEventListener('submit', this.#onSubmit);
    this.#form.addEventListener('reset', this.#onReset);
    this.#toInput.addEventListener('input', () => this.#toInput.setCustomValidity(''));
    this.#fromInput.addEventListener('input', () => this.#toInput.setCustomValidity(''));
    this.#groupSearch.addEventListener('input', () => this.#applyGroupSearch());
    // Enter would submit the form, i.e. apply the filter and close the overlay.
    this.#groupSearch.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') event.preventDefault();
    });
    groupList.addEventListener('change', () => this.#renderSelectedCount());
    dialog.addEventListener('click', this.#onClick);
  }

  /** Opens the overlay showing the currently applied criteria. */
  open(criteria) {
    this.#fill(criteria);
    this.#groupSearch.value = '';
    this.#applyGroupSearch();
    this.#renderSelectedCount();
    this.#dialog.showModal();
  }

  #onSubmit = (event) => {
    event.preventDefault();
    const criteria = this.#read();

    if (criteria.from && criteria.to && criteria.from > criteria.to) {
      this.#toInput.setCustomValidity('"To" must be on or after "From".');
      this.#toInput.reportValidity();
      return;
    }

    this.#onApply(criteria);
    this.#dialog.close();
  };

  /**
   * Clear (the form's reset button): the browser resets the fields right after this event, the
   * search box included. Show every folder now; the count can only be 0 afterwards.
   */
  #onReset = () => {
    for (const box of this.#checkboxes('group')) box.closest('label').hidden = false;
    this.#noMatch.hidden = true;
    this.#selectedCount.textContent = countText(0);
  };

  /** Hides the folders that don't match the search. Only hides: checked folders stay checked. */
  #applyGroupSearch() {
    const query = fold(this.#groupSearch.value.trim());
    let shown = 0;
    for (const box of this.#checkboxes('group')) {
      const label = box.closest('label');
      label.hidden = !label.dataset.search.includes(query);
      if (!label.hidden) shown += 1;
    }
    this.#noMatch.hidden = shown > 0;
  }

  /** Counts every checked folder, hidden by the search or not. */
  #renderSelectedCount() {
    this.#selectedCount.textContent = countText(this.#checkedValues('group').size);
  }

  #onClick = (event) => {
    const clickedBackdrop = event.target === this.#dialog;
    const clickedClose = event.target.closest('[data-action="close"]');
    if (clickedBackdrop || clickedClose) this.#dialog.close();
  };

  #fill(criteria) {
    for (const box of this.#checkboxes('group')) box.checked = criteria.groups.has(box.value);
    for (const box of this.#checkboxes('kind')) box.checked = criteria.kinds.has(box.value);
    this.#fromInput.value = criteria.from;
    this.#toInput.value = criteria.to;
    this.#undatedInput.checked = criteria.undated;
    this.#toInput.setCustomValidity('');
  }

  /** @returns {import('./filter.js').Criteria} */
  #read() {
    return {
      groups: this.#checkedValues('group'),
      kinds: this.#checkedValues('kind'),
      from: this.#fromInput.value,
      to: this.#toInput.value,
      undated: this.#undatedInput.checked,
    };
  }

  #checkboxes(name) {
    return this.#form.querySelectorAll(`input[type="checkbox"][name="${name}"]`);
  }

  #checkedValues(name) {
    return new Set([...this.#checkboxes(name)].filter((box) => box.checked).map((box) => box.value));
  }
}

function renderCheckboxes(container, name, values) {
  const options = [...values].sort().map((value) => {
    const label = document.createElement('label');
    label.className = 'option';

    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = name;
    input.value = value;
    input.className = 'option__input';

    const text = document.createElement('span');
    text.className = 'option__text';

    if (name === 'group') {
      text.textContent = formatGroup(value);
    } else if (name === 'kind') {
      text.textContent = KIND_LABELS[value] ?? value;
    } else {
      text.textContent = value;
    }

    label.append(input, text);
    return label;
  });
  container.replaceChildren(...options);
}

const KIND_LABELS = { image: 'Images', video: 'Videos' };

/** Case- and accent-insensitive form for the folder search: "Nyár" → "nyar". */
function fold(text) {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

function countText(count) {
  if (count === 0) return 'No folders selected';
  return count === 1 ? '1 folder selected' : `${count} folders selected`;
}

function setDateBounds(inputs, { min, max }) {
  for (const input of inputs) {
    if (min) input.min = min;
    if (max) input.max = max;
  }
}
