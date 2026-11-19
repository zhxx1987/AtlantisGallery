async function readEntries(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error('Could not load the gallery catalog.');
  const catalog = await response.json();
  if (!Array.isArray(catalog)) throw new Error('Invalid gallery catalog format.');
  return catalog;
}

export async function loadCatalog() {
  const [legacy, works] = await Promise.all([readEntries('./catalog.json'), readEntries('./entries.json')]);
  works.sort((a, b) => (b.publishedAt || '').localeCompare(a.publishedAt || '') || a.id.localeCompare(b.id));
  const catalog = [...works, ...legacy];
  if (new Set(catalog.map(work => work.id)).size !== catalog.length) throw new Error('Duplicate Gallery work ID.');
  return catalog;
}

export function readPage(params) {
  const page = Number(params.get('page'));
  return Number.isSafeInteger(page) && page > 0 ? page : 1;
}

export function galleryUrl(page = 1) {
  const url = new URL('./', location.href);
  if (page > 1) url.searchParams.set('page', page);
  return url;
}

export function workUrl(id, page = 1) {
  const url = new URL('./work.html', location.href);
  url.searchParams.set('model', id);
  if (page > 1) url.searchParams.set('page', page);
  return url;
}
