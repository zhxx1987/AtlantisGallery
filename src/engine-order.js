import { workUrl } from './catalog.js';

const engines = {
  unreal: {
    name: 'Unreal Engine (UE)',
    implementation: 'Import the source meshes and materials into the target project. Assemble a reusable Actor or Blueprint, implement the authored controls in Blueprint or C++, and place an instance in a playable level.',
    verify: 'Open the level in the Unreal Editor and exercise the controls in Play In Editor.',
  },
  godot: {
    name: 'Godot',
    implementation: 'Import the model and materials, then compose a reusable PackedScene (.tscn). Bind authored controls to scene nodes using GDScript or C#, signals, and the project input map. Include a runnable example scene.',
    verify: 'Run the example scene in Godot and exercise the controls on the instantiated asset.',
  },
  unity: {
    name: 'Unity',
    implementation: 'Import the meshes and materials into the target project. Build a reusable prefab, implement the authored controls in C# components using the project input conventions, and instantiate it in a sample scene.',
    verify: 'Open the scene in the Unity Editor and exercise the controls in Play Mode.',
  },
};

function sourceList(item, spec) {
  const sources = new Map();
  function add(label, path, base = location.href) {
    if (typeof path !== 'string' || !path.trim()) return;
    const url = new URL(path, base);
    if (['https:', 'http:'].includes(url.protocol) && !sources.has(url.href)) {
      sources.set(url.href, { label, url: url.href });
    }
  }
  add('Preview model', item.model);
  add('Interaction specification', item.interaction);
  add('Interactive vehicle preview', item.vehicleEntry);
  for (const file of item.downloads || []) add(file.label, file.url);
  add('Asset repository', item.assetRepository);
  const model = item.model && new URL(item.model, location.href);
  if (model && spec?.logic) {
    add('Operation script', spec.logic.module, model);
    add('Operation configuration', spec.logic.config, model);
    if (!spec.logic.module && spec.logic.profile === 'microwave') {
      add('Operation script', './logic/microwave_logic.py', import.meta.url);
    }
  }
  return [...sources.values()];
}

function makeOrder(item, engineId, spec) {
  const engine = engines[engineId];
  const created = new Date().toISOString();
  const suffix = Array.from(crypto.getRandomValues(new Uint8Array(8)), n => n.toString(16).padStart(2, '0')).join('');
  const slug = item.id.replace(/[^a-z0-9_-]+/gi, '-');
  return {
    kind: 'game-engine-assembly',
    id: [slug, engineId, suffix].join('-'),
    created,
    assignee: 'Codex',
    engine: engine.name,
    asset: { id: item.id, title: item.title, creator: item.creator, description: item.description, gallery: workUrl(item.id).href },
    sources: sourceList(item, spec),
    task: 'Implement the asset and its published interactive behavior in the selected game engine. Work directly in the designated engine project and use its installed version and conventions.',
    implementation: [
      'Inspect the model, interaction data and original operation scripts, including the motion files inside the downloads. Identify the inputs, controlled nodes, initial state, limits and timing before porting the behavior.',
      'Preserve scale, coordinate conversion, hierarchy, materials, textures and joint pivots. Convert unsupported source formats as needed and keep the converted assets with the project.',
      engine.implementation,
      'Reproduce the behavior described by the source scripts and interaction data using native engine components. For a static prop, deliver the reusable asset and a demonstration scene. Report any missing references or unverified behavior.',
    ],
    acceptance: [
      engine.verify,
      'Compare the imported appearance and each documented state transition against the source. Check initial pose, movement limits and repeatability where applicable.',
      'Return the engine version, reusable asset and scene paths, script-to-component bindings, controls, test results and a screenshot or short capture from the running scene.',
    ],
  };
}

async function interactionSpec(item, signal) {
  if (!item.interaction) return null;
  try {
    const response = await fetch(item.interaction, { signal });
    return response.ok ? await response.json() : null;
  } catch {
    // The ticket still includes the published descriptor URL and download archives.
    return null;
  }
}

function openOrder(item) {
  const dialog = document.createElement('dialog');
  dialog.className = 'engine-dialog';
  dialog.setAttribute('aria-labelledby', 'engine-order-heading');
  dialog.innerHTML = [
    '<header><h2 id="engine-order-heading">Game engine work order</h2><button type="button" class="engine-secondary" data-close>Close</button></header>',
    '<p class="engine-asset"></p>',
    '<form><label>Game engine<select name="engine" autofocus></select></label>',
    '<button class="primary" type="submit">Create work order</button></form>',
    '<section hidden><label>Work order for Codex<textarea readonly spellcheck="false"></textarea></label>',
    '<div class="engine-actions"><button type="button" class="primary" data-copy>Copy for Codex</button>',
    '<a class="engine-secondary" download>Download JSON</a></div></section>',
    '<p class="engine-status" role="status"></p>',
  ].join('');
  dialog.querySelector('.engine-asset').textContent = item.title;
  const select = dialog.querySelector('select');
  for (const [id, engine] of Object.entries(engines)) select.add(new Option(engine.name, id));
  const create = dialog.querySelector('[type=submit]');
  const result = dialog.querySelector('section');
  const field = dialog.querySelector('textarea');
  const download = dialog.querySelector('[download]');
  const status = dialog.querySelector('[role=status]');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  const spec = interactionSpec(item, controller.signal).finally(() => clearTimeout(timeout));
  let fileUrl;

  function resetResult() {
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = undefined;
    result.hidden = true;
    create.hidden = false;
    status.textContent = '';
  }
  select.addEventListener('change', resetResult);
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  dialog.addEventListener('close', () => {
    controller.abort();
    resetResult();
    dialog.remove();
  }, { once: true });
  dialog.querySelector('form').onsubmit = async event => {
    event.preventDefault();
    if (create.disabled || !result.hidden) return;
    create.disabled = select.disabled = true;
    status.textContent = 'Preparing work order…';
    try {
      const descriptor = await spec;
      if (!dialog.open) return;
      const order = makeOrder(item, select.value, descriptor);
      field.value = JSON.stringify(order, null, 2);
      fileUrl = URL.createObjectURL(new Blob([field.value], { type: 'application/json' }));
      download.href = fileUrl;
      download.download = order.id + '.json';
      create.hidden = true;
      result.hidden = false;
      download.click();
      status.textContent = 'Work order created. Give the JSON file or its contents to Codex in your engine project.';
      dialog.querySelector('[data-copy]').focus();
    } catch {
      status.textContent = 'Could not create the work order. Check the asset links and try again.';
    } finally {
      create.disabled = select.disabled = false;
    }
  };
  dialog.querySelector('[data-copy]').onclick = async () => {
    try {
      await navigator.clipboard.writeText(field.value);
      status.textContent = 'Work order copied. Paste it into Codex in your engine project.';
    } catch {
      field.focus();
      field.select();
      status.textContent = 'Copy the selected work order and paste it into Codex.';
    }
  };
  document.body.append(dialog);
  dialog.showModal();
}

export function engineOrderButton(item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'engine-order-button';
  button.textContent = 'Codex Assemble to Game Engine';
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-label', button.textContent + ' — ' + item.title);
  button.onclick = () => openOrder(item);
  return button;
}
