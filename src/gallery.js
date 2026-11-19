import { galleryUrl, loadCatalog, readPage, workUrl } from './catalog.js';
import { engineOrderButton } from './engine-order.js';

const PAGE_SIZE = 12;
const catalogList = document.querySelector('#catalog');
const notice = document.querySelector('#catalog-status');
const count = document.querySelector('#count');
const pagination = document.querySelector('#pagination');

function createCard(item, page) {
  const entry = document.createElement('li');
  const link = document.createElement('a');
  link.className = 'card';
  link.href = workUrl(item.id, page);

  const preview = document.createElement('div');
  preview.className = 'card-preview';
  const placeholder = document.createElement('span');
  placeholder.textContent = 'No preview available';
  placeholder.setAttribute('aria-hidden', 'true');
  preview.append(placeholder);
  if (item.thumbnail) {
    const image = document.createElement('img');
    image.alt = '';
    image.loading = 'lazy';
    image.decoding = 'async';
    image.addEventListener('error', () => image.remove(), { once: true });
    image.src = item.thumbnail;
    preview.append(image);
  }

  const body = document.createElement('div');
  body.className = 'card-body';
  const title = document.createElement('h2');
  title.textContent = item.title;
  const creator = document.createElement('p');
  creator.textContent = item.creator || 'Anonymous Creator';
  body.append(title, creator);
  link.append(preview, body);
  entry.append(link, engineOrderButton(item));
  return entry;
}

function pageLink(label, page, ariaLabel = label) {
  const link = document.createElement('a');
  link.href = galleryUrl(page);
  link.textContent = label;
  link.setAttribute('aria-label', ariaLabel);
  return link;
}

function renderPagination(page, lastPage) {
  if (page > 1) pagination.append(pageLink('Previous', page - 1));

  const pages = new Set([1, lastPage]);
  for (let number = Math.max(1, page - 2); number <= Math.min(lastPage, page + 2); number++) {
    pages.add(number);
  }
  let previous = 0;
  for (const number of [...pages].sort((a, b) => a - b)) {
    if (number - previous > 1) {
      const gap = document.createElement('span');
      gap.textContent = '…';
      gap.setAttribute('aria-hidden', 'true');
      pagination.append(gap);
    }
    const link = pageLink(String(number), number, `Page ${number}`);
    if (number === page) link.setAttribute('aria-current', 'page');
    pagination.append(link);
    previous = number;
  }

  if (page < lastPage) pagination.append(pageLink('Next', page + 1));
  pagination.hidden = false;
}

const params = new URLSearchParams(location.search);
const oldId = params.get('model');
if (oldId) {
  location.replace(workUrl(oldId, readPage(params)));
} else {
  try {
    const items = await loadCatalog();
    count.textContent = `${items.length} ${items.length === 1 ? 'work' : 'works'}`;
    count.hidden = false;
    if (items.length === 0) {
      notice.textContent = 'No public works yet.';
    } else {
      const lastPage = Math.ceil(items.length / PAGE_SIZE);
      const page = Math.min(lastPage, readPage(params));
      if ((params.get('page') ?? '1') !== String(page)) {
        history.replaceState(null, '', galleryUrl(page));
      }
      const first = (page - 1) * PAGE_SIZE;
      catalogList.replaceChildren(...items.slice(first, first + PAGE_SIZE).map(item => createCard(item, page)));
      notice.hidden = true;
      renderPagination(page, lastPage);
    }
  } catch (error) {
    notice.textContent = 'Could not load the gallery. Refresh to try again.';
    console.error(error);
  }
}
