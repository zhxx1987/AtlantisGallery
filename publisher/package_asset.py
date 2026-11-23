"""Build a Gallery submission from an explicit list of local files."""

import hashlib
import json
from pathlib import Path, PurePosixPath
import posixpath
import re
import shutil
from datetime import datetime, timezone
from urllib.parse import quote
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


MODEL_TYPES = {'.usd', '.usda', '.usdc', '.usdz', '.glb', '.gltf'}
IMAGE_TYPES = {'.png', '.jpg', '.jpeg', '.webp'}
DEPENDENCY_TYPES = MODEL_TYPES | IMAGE_TYPES | {'.bin', '.ktx2', '.exr', '.hdr', '.py', '.json'}
MAX_PREVIEW_FILE = 100 * 1024 * 1024
MAX_PREVIEW_TOTAL = 900 * 1024 * 1024
MAX_RELEASE_FILE = 2 * 1024 * 1024 * 1024
MAX_THUMBNAIL = 1024 * 1024
STORAGE = 'creator-pages-and-releases/1'
SCHEMA = 'atlantis-gallery-submission/1'
PACKAGE_LAYOUT = 'model-controls-source/1'
CONTROL_TYPES = {'.py', '.js', '.mjs', '.css', '.wasm', '.html'}
ASSEMBLY_GUIDANCE = '''Extract model.zip and controls.zip into the SAME dedicated directory,
preserving relative paths. Keep modeling-code.zip in a separate source directory.
Use the current work-page downloads when updating; replace the previous controller files.
Read the supplied runtime manifests and entry points before launching. Activate one
controller per model instance. Do not infer an unavailable runtime from a download label.
Simplified ground vehicles require acceleration, coasting, braking and parking hold,
stop-before-reverse, ground-contact traction, bounded per-wheel spring/damper suspension,
terrain pitch/roll, mild brake dive with damped settling, airborne and landing response.
Bind actual wheels, arms and tracks to their pivots and travelled distance. Use a fixed
timestep and safe input release on lost focus. Exercise controls and observed transforms.
Third-person operation hides the cursor with pointer capture and a cursor:none fallback.
Exit on Esc, blur, hidden tab or capture loss; restore the cursor and release all inputs.
Gallery inspection and operation share the exact same Viewer, canvas, renderer, lighting,
shadows and post-processing instances. Only add the driving scene and logic module.
Keep the shared 2048-square shadow footprint near the vehicle and follow its travel.
Native real physics must use its own solver without duplicate procedural integration.
'''


def assembly_document(runtime):
    if runtime == 'isaac':
        specific = ('Use the selected mode in isaac-runtimes.json when supplied. Resolve its entry, '
                    'USD and dependencies in the merged directory. Native PhysX requires Isaac Sim; '
                    'browser/Pyodide code alone is not a native Isaac adapter. If no Isaac adapter '
                    'is supplied, implement and test one before claiming Isaac support.')
    else:
        specific = ('For Unreal, Unity or Godot, preserve authored key mappings, units, pivots and '
                    'part hierarchy. Adapt the portable motion core and host input/render bindings. '
                    'Isaac omni/pxr/PhysX Python cannot run unchanged in another engine. Use that '
                    'engine\'s native solver for real physics and test braking, contact and suspension.')
    return '# Assemble in ' + ('Isaac Sim' if runtime == 'isaac' else 'a Game Engine') + '\n\n' + ASSEMBLY_GUIDANCE + '\n' + specific + '\n'


def read_json(path):
    return json.loads(path.read_text(encoding='utf-8-sig'))


def write_json(path, data):
    path.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def validate_slug(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', value) or len(value) > 60:
        raise ValueError('slug must use lowercase letters, digits and single hyphens, up to 60 characters.')
    return value


def relative_file(root, name, extensions=None):
    if not isinstance(name, str) or not name or '\\' in name or ':' in name:
        raise ValueError('Use file paths relative to the manifest, with forward slashes.')
    path = PurePosixPath(name)
    if path.as_posix() != name or path.is_absolute() or any(part.startswith('.') for part in path.parts):
        raise ValueError(f'Invalid relative file path: {name}')
    if extensions and path.suffix.lower() not in extensions:
        raise ValueError(f'Unsupported file type: {name}')
    absolute = root.joinpath(*path.parts).resolve()
    if not absolute.is_relative_to(root) or not absolute.is_file():
        raise ValueError(f'File must exist inside the export folder: {name}')
    return absolute


def files_field(data, key):
    value = data.get(key, [])
    if not isinstance(value, list) or not all(isinstance(name, str) and name for name in value):
        raise ValueError(f'{key} must be an array of relative file paths.')
    return value


def zip_files(path, sources):
    with ZipFile(path, 'w', compression=ZIP_DEFLATED) as archive:
        for name, source in sorted(sources.items()):
            member = ZipInfo(name)
            member.compress_type = ZIP_DEFLATED
            with source.open('rb') as reader, archive.open(member, 'w', force_zip64=True) as writer:
                shutil.copyfileobj(reader, writer)


def stage_package(manifest, output):
    manifest = Path(manifest).resolve(strict=True)
    data = read_json(manifest)
    if not isinstance(data, dict) or data.get('schema') != SCHEMA:
        raise ValueError(f'The manifest must use schema {SCHEMA}.')
    root = manifest.parent
    slug = validate_slug(data.get('slug'))
    metadata = {'slug': slug}
    for key in ('title', 'creator', 'description'):
        value = data.get(key, '')
        if not isinstance(value, str) or (key != 'description' and not value.strip()):
            raise ValueError(f'{key} must be text. A title and creator are required.')
        if value.strip():
            metadata[key] = value.strip()

    model = data.get('model')
    preview = {model: relative_file(root, model, MODEL_TYPES)}
    operable = data.get('operableVehicle')
    if type(operable) is not bool:
        raise ValueError('Declare operableVehicle as true for a vehicle with operating logic, or false otherwise.')
    if data.get('vehicleEntry') is not None:
        raise ValueError('HTML vehicleEntry is no longer supported. Supply a vehicleController module that uses the Gallery host renderer.')
    controller = data.get('vehicleController')
    if controller is not None:
        if not operable or not isinstance(controller, dict) or controller.get('schema') != 'atlantis-gallery-vehicle/1':
            raise ValueError('vehicleController requires operableVehicle=true and schema atlantis-gallery-vehicle/1.')
        if controller.get('renderer') != 'gallery-shared' or controller.get('thirdPersonCursor') != 'hidden':
            raise ValueError('Vehicle controllers must declare renderer=gallery-shared and thirdPersonCursor=hidden.')
        base = controller.get('base', './')
        if not isinstance(base, str) or '\\' in base or ':' in base or base.startswith('/'):
            raise ValueError('vehicleController.base must be a relative directory.')
        base = posixpath.normpath(posixpath.join(posixpath.dirname(model), base))
        if base == '..' or base.startswith('../'):
            raise ValueError('vehicleController.base escapes the submission.')
        descriptor = dict(controller)
        descriptor['base'] = 'preview/' + (quote(base) + '/' if base != '.' else '')
        metadata['vehicleController'] = descriptor
    dependencies = DEPENDENCY_TYPES | {'.js', '.mjs', '.css', '.wasm', '.html', '.ogg', '.mp3', '.wav'} if controller else DEPENDENCY_TYPES
    for name in files_field(data, 'previewFiles'):
        preview[name] = relative_file(root, name, dependencies)
    if controller:
        references = list(controller.get('assets', {}).values())
        if controller.get('module'):
            references.append(controller['module'])
        elif controller.get('profile') not in ('t10', 'ember-29'):
            raise ValueError('Supply a vehicleController.module exporting install(context), or a supported vehicle profile.')
        for reference in references:
            if not isinstance(reference, str) or '\\' in reference or ':' in reference or reference.startswith('/'):
                raise ValueError('Vehicle controller dependencies must be relative preview files.')
            name = posixpath.normpath(posixpath.join(base, reference))
            if name not in preview:
                raise ValueError('List the vehicle controller module and assets in previewFiles: ' + name)
    model_archive = {
        name: path for name, path in preview.items()
        if PurePosixPath(name).suffix.lower() not in CONTROL_TYPES
    } | {
        name: relative_file(root, name)
        for name in files_field(data, 'modelFiles')
    }
    controls = {
        name: path for name, path in preview.items()
        if PurePosixPath(name).suffix.lower() in CONTROL_TYPES
    } | {
        name: relative_file(root, name)
        for name in files_field(data, 'motionFiles') + files_field(data, 'controlFiles')
    }
    # Explicit controls win classification; the two archives merge without collisions.
    for name in controls:
        model_archive.pop(name, None)
    sources = {name: relative_file(root, name) for name in files_field(data, 'sourceFiles')}
    if not sources:
        raise ValueError('List the final modeling code for all parts in sourceFiles.')
    thumbnail = relative_file(root, data.get('thumbnail'), IMAGE_TYPES)
    if thumbnail.stat().st_size > MAX_THUMBNAIL:
        raise ValueError('Use a thumbnail no larger than 1 MiB. Only the thumbnail and catalog entry go to Gallery.')
    interaction = None
    native_vehicle = False
    if data.get('interaction'):
        interaction = relative_file(root, data['interaction'], {'.json'})
        spec = read_json(interaction)
        if not isinstance(spec, dict) or spec.get('schema') not in {
            'atlantis-gallery-interactions/1', 'atlantis-gallery-interactions/2',
        }:
            raise ValueError('Use a supported Gallery interaction schema.')
        logic = spec.get('logic')
        if isinstance(logic, dict) and logic.get('schema') == 'atlantis-native-oven/1':
            if operable or logic != {'schema': 'atlantis-native-oven/1', 'profile': 'electric-oven', 'scene': 'scene.json'}:
                raise ValueError('Use the supported native electric oven with its packaged scene.json.')
            scene_name = posixpath.join(posixpath.dirname(model), 'scene.json')
            if scene_name not in preview:
                raise ValueError('List the oven scene.json in previewFiles.')
            scene = read_json(preview[scene_name])
            assets = scene.get('assets', [])
            if (scene.get('schema') != 'aps-webgpu-scene/1' or scene.get('oven_controls', {}).get('schema') != 'atlantis-oven/1'
                    or len(assets) != 1 or assets[0].get('kind') != 'glb' or assets[0].get('file') != posixpath.basename(model)):
                raise ValueError('The native oven scene must reference its preview GLB.')
        elif logic is not None:
            if not isinstance(logic, dict) or not (
                logic.get('profile') == 'microwave' or (
                    logic.get('schema') == 'atlantis-python-motion/1'
                    and logic.get('profile') == 'tiger-ii'
                )
            ):
                raise ValueError('Use declarative actions or a Python profile already supported by Gallery.')
            if logic.get('schema') == 'atlantis-python-motion/1':
                native_vehicle = logic.get('profile') == 'tiger-ii'
                # Vehicle references are relative to the preview model, just as in the browser.
                for field in ('module', 'config'):
                    reference = logic.get(field)
                    if not isinstance(reference, str) or not reference or '\\' in reference or ':' in reference or reference.startswith('/'):
                        raise ValueError(f'logic.{field} must be a relative preview file.')
                    name = posixpath.normpath(posixpath.join(posixpath.dirname(model), reference))
                    if name not in preview:
                        raise ValueError(f'List the vehicle {field} in previewFiles: {name}')
        controls[data['interaction']] = interaction
        model_archive.pop(data['interaction'], None)
    if native_vehicle and not operable:
        raise ValueError('Declare operableVehicle=true for this vehicle controller.')
    if operable and not (controller or native_vehicle):
        raise ValueError('An operable vehicle requires a shared-renderer vehicleController or supported native Gallery controller.')
    work_order = None
    if data.get('workOrder'):
        work_order = relative_file(root, data['workOrder'], {'.json'})
        if not isinstance(read_json(work_order), (dict, list)):
            raise ValueError('workOrder must be a JSON object or array.')
        # Reviewed work orders belong to the editable source package, not a fourth download.
        sources[data['workOrder']] = work_order
    runtimes = data.get('isaacRuntimes', [])
    if not isinstance(runtimes, list) or not all(isinstance(name, str) for name in runtimes) or len(set(runtimes)) != len(runtimes) or any(
        name not in ('game', 'real-physics') for name in runtimes
    ):
        raise ValueError('isaacRuntimes must list supplied game and/or real-physics adapters.')
    if runtimes:
        runtime_file = controls.get('isaac-runtimes.json')
        if not runtime_file:
            raise ValueError('List isaac-runtimes.json in controlFiles for advertised Isaac runtimes.')
        runtime_data = read_json(runtime_file)
        if not isinstance(runtime_data, dict) or not isinstance(runtime_data.get('modes'), dict):
            raise ValueError('isaac-runtimes.json must contain a modes object.')
        modes = runtime_data.get('modes', {})
        for mode in runtimes:
            detail = modes.get(mode, {})
            if not isinstance(detail, dict):
                raise ValueError(f'Isaac {mode} must define an entry and USD.')
            for field in ('entry', 'usd'):
                if detail.get(field) not in model_archive | controls:
                    raise ValueError(f'Isaac {mode}.{field} must name a packaged file.')
        metadata['isaacRuntimes'] = runtimes

    preview_bytes = sum(path.stat().st_size for path in preview.values())
    if preview_bytes > MAX_PREVIEW_TOTAL:
        raise ValueError('The preview exceeds 900 MiB. Optimize the web preview; complete files can remain in the release downloads.')
    for name, path in preview.items():
        if path.stat().st_size >= MAX_PREVIEW_FILE:
            raise ValueError(f'{name} exceeds the 100 MiB preview Git file limit. Optimize or split the preview export.')
    output.mkdir(parents=True)
    for name, source in preview.items():
        dest = output / 'preview' / name
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, dest)
    # Both archives use the same preview bytes that will be uploaded to the viewer.
    for archive in (model_archive, controls):
        archive.update({name: output / 'preview' / name for name in preview if name in archive})
    generated = output / '.assembly-documents'
    generated.mkdir()
    for filename, runtime in (('ASSEMBLE_ISAAC.md', 'isaac'), ('ASSEMBLE_GAME_ENGINE.md', 'engine')):
        if filename not in controls:
            path = generated / filename
            path.write_text(assembly_document(runtime), encoding='utf-8')
            controls[filename] = path
        model_archive.pop(filename, None)
    thumbnail_name = 'preview' + thumbnail.suffix.lower()
    shutil.copyfile(thumbnail, output / thumbnail_name)
    zip_files(output / 'model.zip', model_archive)
    zip_files(output / 'controls.zip', controls)
    zip_files(output / 'modeling-code.zip', sources)
    shutil.rmtree(generated)
    metadata.update(model='preview/' + quote(model), thumbnail=thumbnail_name)
    metadata['downloads'] = [
        {'kind': 'model', 'label': 'Download Model', 'file': 'model.zip'},
        {'kind': 'controls', 'label': 'Download Controls', 'file': 'controls.zip'},
        {'kind': 'modeling-source', 'label': 'Download Modeling Source', 'file': 'modeling-code.zip'},
    ]
    metadata.update(packageLayout=PACKAGE_LAYOUT, operableVehicle=operable)
    if interaction:
        shutil.copyfile(interaction, output / 'interaction.json')
        metadata['interaction'] = 'interaction.json'

    storage = {
        'schema': STORAGE,
        'repository_name': 'atlantis-' + slug,
        'repository_owner': 'signed-in GitHub creator',
        'preview_host': 'creator repository GitHub Pages',
        'downloads_host': 'creator repository GitHub Releases',
        'gallery_files': ['_data/works/<asset-id>.json', 'models/<asset-id>/' + thumbnail_name],
        'generated_creator_files': ['.atlantis-gallery.json', '.gitattributes', '.nojekyll', 'index.html', '<version>/publication.json'],
    }
    digest = hashlib.sha256(json.dumps({'metadata': metadata, 'storage': storage}, sort_keys=True).encode())
    public_files = []
    for path in sorted(output.rglob('*')):
        if not path.is_file():
            continue
        name = path.relative_to(output).as_posix()
        size = path.stat().st_size
        if size >= MAX_RELEASE_FILE:
            raise ValueError(f'{name} exceeds the 2 GiB release asset limit. Split the download package.')
        with path.open('rb') as stream:
            checksum = hashlib.file_digest(stream, 'sha256').hexdigest()
        destination = 'creator-releases' if name in {'model.zip', 'controls.zip', 'modeling-code.zip'} else 'creator-pages'
        if name == thumbnail_name:
            destination = 'gallery-thumbnail'
        if destination == 'creator-pages' and size >= MAX_PREVIEW_FILE:
            raise ValueError(f'{name} exceeds the 100 MiB preview file limit.')
        if destination == 'gallery-thumbnail' and size > MAX_THUMBNAIL:
            raise ValueError('The thumbnail exceeds 1 MiB.')
        public_files.append({'file': name, 'bytes': size, 'sha256': checksum, 'destination': destination})
    digest.update(json.dumps(public_files, sort_keys=True).encode())
    if sum(item['bytes'] for item in public_files if item['destination'] == 'creator-pages') > MAX_PREVIEW_TOTAL:
        raise ValueError('The preview exceeds 900 MiB.')
    return {
        'metadata': metadata,
        'storage': storage,
        'files': public_files,
        'model_archive_contents': sorted(model_archive),
        'control_archive_contents': sorted(controls),
        'code_archive_contents': sorted(sources),
        'work_order_included': work_order is not None,
        'approval_digest': digest.hexdigest(),
    }


def catalog_entry(asset_id, plan, hosting):
    """Resolve public URLs without copying asset bytes into the Gallery repository."""
    base = hosting['preview_base_url'].rstrip('/') + '/'
    entry = {'id': asset_id, **plan['metadata']}
    del entry['slug']
    if 'vehicleController' in entry:
        entry['vehicleController'] = dict(entry['vehicleController'])
        entry['vehicleController']['base'] = base + entry['vehicleController']['base']
    for field in ('model', 'interaction'):
        if field in entry:
            entry[field] = base + entry[field]
    entry['thumbnail'] = f'./models/{asset_id}/' + entry['thumbnail']
    entry['downloads'] = [
        {'kind': item['kind'], 'label': item['label'], 'url': hosting['download_urls'][item['file']]}
        for item in entry['downloads']
    ]
    entry['assetRepository'] = hosting['repository_url']
    return entry


def check_catalog_slot(checkout, asset_id, entry):
    catalog = read_json(checkout / 'catalog.json')
    existing = next((item for item in catalog if item['id'] == asset_id), None)
    record = checkout / '_data' / 'works' / (asset_id + '.json')
    if record.exists():
        if existing:
            raise ValueError(f'Duplicate catalog records for {asset_id}.')
        existing = read_json(record)
        existing.pop('publishedAt', None)
    if existing and existing != entry:
        # Creator repositories are checked against the signed-in owner before publication.
        # Permit updating that same creator's individual record, preserving its work ID.
        if not record.exists() or not existing.get('assetRepository') or (
            existing['assetRepository'] != entry.get('assetRepository')
            or existing.get('creator') != entry.get('creator')
        ):
            raise ValueError(f'{asset_id} belongs to another record or creator. Do not overwrite it.')
    destination = checkout / 'models' / asset_id
    if not existing and destination.exists():
        raise ValueError(f'{asset_id} already has Gallery files. Pick a new slug.')
    return existing


def add_to_catalog(checkout, asset_id, package, plan, hosting):
    entry = catalog_entry(asset_id, plan, hosting)
    existing = check_catalog_slot(checkout, asset_id, entry)
    destination = checkout / 'models' / asset_id
    if existing or destination.exists():
        thumbnail = destination / plan['metadata']['thumbnail']
        expected = next(item for item in plan['files'] if item['destination'] == 'gallery-thumbnail')
        merged = {**existing, **entry} if existing else entry
        same_thumbnail = thumbnail.is_file() and hashlib.sha256(thumbnail.read_bytes()).hexdigest() == expected['sha256']
        if existing == merged and same_thumbnail:
            return False
        record = checkout / '_data' / 'works' / (asset_id + '.json')
        if existing and record.exists():
            original = read_json(record)
            merged = {**original, **entry}
            destination.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(package / plan['metadata']['thumbnail'], thumbnail)
            write_json(record, merged)
            return True
        raise ValueError(f'{asset_id} already exists. Pick a new slug to submit a new work.')

    destination.mkdir(parents=True)
    shutil.copyfile(package / plan['metadata']['thumbnail'], destination / plan['metadata']['thumbnail'])
    records = checkout / '_data' / 'works'
    records.mkdir(parents=True, exist_ok=True)
    entry['publishedAt'] = datetime.now(timezone.utc).isoformat()
    write_json(records / (asset_id + '.json'), entry)
    return True
