import { galleryUrl, loadCatalog, readPage, workUrl } from './catalog.js';

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const loading = $('loading');
const controls = $('controls');
const status = $('status');
const fileInput = $('file');
const shareButton = $('share');
const actionIds = ['frame', 'recolor', 'restore'];
controls.addEventListener('motionerror', event => { status.textContent = event.detail; });

$('back').href = galleryUrl(readPage(params));

function showDetails(item) {
  $('title').textContent = item.title;
  $('creator').textContent = item.creator || 'Anonymous Creator';
  $('description').textContent = item.description || '';
  $('about-work').hidden = !item.description;
  document.title = `${item.title} · Atlantis Gallery`;

  const downloads = $('downloads');
  downloads.replaceChildren();
  for (const file of item.downloads || []) {
    const link = document.createElement('a');
    link.className = 'download';
    link.href = file.url;
    link.download = '';
    link.textContent = file.label;
    downloads.append(link);
  }
  if (!downloads.children.length) downloads.textContent = 'No downloads are available for this work.';
  $('isaac-assembly').hidden = !item.id;
  $('work-social').hidden = !item.id;
}

async function setupSocial(item) {
  const hint = $('social-hint');
  hint.textContent = 'Loading GitHub links…';
  try {
    const response = await fetch(new URL('../social.json', import.meta.url));
    if (!response.ok) throw new Error('Could not load the Gallery social links.');
    const entries = await response.json();
    let entry = entries[item.id];
    if (!entry) {
      const perWork = await fetch(new URL('../models/' + encodeURIComponent(item.id) + '/social.json', import.meta.url));
      if (perWork.ok) entry = await perWork.json();
    }
    if (!Number.isSafeInteger(entry?.discussion) || entry.discussion <= 0 ||
        typeof entry.gist !== 'string' || !/^[\da-f]{32}$/.test(entry.gist)) {
      hint.textContent = 'GitHub links are pending for this work.';
      return;
    }
    const discussion = `https://github.com/zhxx1987/AtlantisGallery/discussions/${entry.discussion}`;
    $('like-work').href = discussion;
    $('comment-work').href = discussion + '#discussion_bucket';
    $('favorite-work').href = `https://gist.github.com/zhxx1987/${entry.gist}`;
    $('social-links').hidden = false;
    hint.textContent = 'Upvote or leave a comment in the GitHub discussion. Star the gist to save it under Starred gists.';
  } catch (error) {
    hint.textContent = 'GitHub links could not be loaded. Refresh to try again.';
    console.error(error);
  }
}

function isaacPrompt(item) {
  const files = new Map((item.downloads || []).map(file => [new URL(file.url, location.href).href, file.label]));
  for (const [path, label] of [[item.model, 'Gallery preview model'], [item.interaction, 'Gallery interaction data']]) {
    if (!path) continue;
    const url = new URL(path, location.href).href;
    if (!files.has(url)) files.set(url, label);
  }
  return [
    `Assemble ${JSON.stringify(item.title)} in my Isaac Sim workspace.`,
    ...(item.isaacRuntimes ? [
      `Selected runtime: ${$('isaac-runtime').value}.`,
      'Read ASSEMBLE_ISAAC.md and isaac-runtimes.json in the download first. Use the selected mode entry and its matching USD. Never run both controllers on the same tank.',
      'Use assemble_isaac.py --mode ' + $('isaac-runtime').value + ' with Isaac Sim python.bat. Keep all controls and instructions in English.',
    ] : []),
    `Gallery work — ${workUrl(item.id).href}`,
    '',
    'Use the model and motion downloads for assembly. Use the preview and interaction data as fallbacks.',
    ...Array.from(files, ([url, label]) => `- ${label} — ${url}`),
    '',
    '1. Use the downloaded files in my workspace or fetch them from the links. Extract the package into a dedicated ' +
      'folder and preserve relative paths. Inspect the USD layers, textures, scripts, and launch instructions.',
    '2. Use my installed Isaac Sim version. Prefer the packaged Isaac stage and launcher when available. Add the ' +
      'asset to the destination stage I specify, or create a separate stage for it. Review scripts before running ' +
      'them and bind the controls to the actual USD prims and joints. If the work ships only with interaction ' +
      'data, create a small Isaac adapter for the supported actions.',
    '3. Open the assembled stage in Isaac Sim and test the available controls and observed motion. Report the ' +
      'stage path, launch command, test results, and any missing dependencies or unsupported actions.',
  ].join('\n');
}

function setupIsaacPrompt(item) {
  $('isaac-runtime-choice').hidden = !item.isaacRuntimes;
  $('assemble-isaac').addEventListener('click', async () => {
    const prompt = isaacPrompt(item);
    const message = $('isaac-prompt-status');
    const field = $('isaac-prompt');
    try {
      await navigator.clipboard.writeText(prompt);
      field.hidden = true;
      message.textContent = 'Prompt copied. Paste it into Codex.';
    } catch {
      field.value = prompt;
      field.hidden = false;
      message.textContent = 'Copy the prompt below and paste it into Codex.';
      field.focus();
      field.select();
    }
  });
}

async function loadInteraction(url) {
  if (!url) return {};
  const response = await fetch(url);
  if (!response.ok) throw new Error('Could not load the interaction file.');
  return response.json();
}

function setupViewer(viewer) {
  for (const id of actionIds) $(id).addEventListener('click', () => viewer[id]());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;

    const url = URL.createObjectURL(file);
    fileInput.disabled = true;
    loading.hidden = false;
    loading.textContent = 'Loading local model…';
    try {
      const result = await viewer.load(url, {}, file.name);
      showDetails({ title: file.name, creator: 'Local Preview' });
      shareButton.hidden = true;
      $('share-status').hidden = true;
      setModelActions(result);
    } catch (error) {
      status.textContent = 'Could not open the local model. Select a valid USD or glTF file.';
      console.error(error);
    } finally {
      URL.revokeObjectURL(url);
      loading.hidden = true;
      fileInput.disabled = false;
      fileInput.value = '';
    }
  });

}

function setModelActions(result) {
  $('frame').disabled = false;
  $('recolor').disabled = result.meshes === 0;
  $('restore').disabled = result.meshes === 0;
  $('interaction-panel').hidden = !controls.children.length;
  status.textContent = result.errors.join(' · ');
}

async function showWork() {
  const id = params.get('model');
  const item = id && (await loadCatalog()).find(entry => entry.id === id);
  if (!item) {
    $('work-status').textContent = 'This work could not be found. Return to the gallery to browse other works.';
    return;
  }
  showDetails(item);
  $('work-status').hidden = true;
  $('work').hidden = false;
  setupIsaacPrompt(item);
  void setupSocial(item);

  // Sharing and download links remain available if the 3D renderer cannot start.
  shareButton.addEventListener('click', async () => {
    const url = workUrl(item.id).href;
    const message = $('share-status');
    try {
      await navigator.clipboard.writeText(url);
      message.textContent = 'Link copied.';
    } catch {
      message.textContent = url;
    }
    message.hidden = false;
  });

  if (item.vehicleEntry) {
    const repository = /^https:\/\/github\.com\/([\w-]+)\/(atlantis-[\w-]+)$/.exec(item.assetRepository || '');
    const controller = new URL(item.vehicleEntry);
    if (!repository || controller.origin !== `https://${repository[1].toLowerCase()}.github.io` ||
        !controller.pathname.startsWith('/' + repository[2] + '/')) {
      throw new Error('Vehicle entry must belong to the creator’s Gallery asset repository.');
    }
    const inspect = params.get('view') === 'model';
    const actions = document.querySelector('.stage-actions');
    const link = document.createElement('a');
    const destination = workUrl(item.id, readPage(params));
    if (!inspect) destination.searchParams.set('view', 'model');
    link.href = destination.href;
    link.className = 'file-button';
    link.textContent = inspect ? 'Operate Vehicle' : 'Inspect Model';
    if (!inspect) {
      const ride = document.createElement('iframe');
      ride.className = 'ride-frame';
      ride.title = item.title + ' · operating controls';
      ride.sandbox = 'allow-scripts allow-same-origin allow-pointer-lock';
      ride.src = controller.href;
      $('stage').replaceChildren(ride);
      actions.replaceChildren(link);
      return;
    }
    actions.prepend(link);
  }

  try {
    const { GalleryViewer } = await import('./viewer.js');
    const viewer = new GalleryViewer($('stage'), controls);
    await viewer.init();
    setupViewer(viewer);
    loading.textContent = 'Loading model…';
    let spec = {};
    let interactionWarning;
    try {
      spec = await loadInteraction(item.interaction);
    } catch (error) {
      interactionWarning = 'Could not load the model controls.';
      console.error(error);
    }
    try {
      const result = await viewer.load(item.model, spec);
      setModelActions(result);
      const issues = [interactionWarning, ...result.errors].filter(Boolean);
      status.textContent = issues.join(' · ');
    } finally {
      fileInput.disabled = false;
    }
  } catch (error) {
    status.textContent = 'Could not load the 3D preview.';
    console.error(error);
  } finally {
    loading.hidden = true;
  }
}

try {
  await showWork();
} catch (error) {
  $('work-status').textContent = 'Could not load this work. Refresh to try again.';
  console.error(error);
}
