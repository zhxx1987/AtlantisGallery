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
    entry = data.get('vehicleEntry')
    if entry is not None:
        if not operable:
            raise ValueError('vehicleEntry requires operableVehicle=true.')
        preview[entry] = relative_file(root, entry, {'.html'})
        metadata['vehicleEntry'] = 'preview/' + quote(entry)
    dependencies = DEPENDENCY_TYPES | {'.js', '.mjs', '.css', '.wasm', '.html', '.ogg', '.mp3', '.wav'} if entry else DEPENDENCY_TYPES
    for name in files_field(data, 'previewFiles'):
        preview[name] = relative_file(root, name, dependencies)
    model_archive = preview | {
        name: relative_file(root, name)
        for name in files_field(data, 'modelFiles') + files_field(data, 'motionFiles')
    }
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
        if logic is not None:
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
        model_archive[data['interaction']] = interaction
    if native_vehicle and not operable:
        raise ValueError('Declare operableVehicle=true for this vehicle controller.')
    if operable and not (entry or native_vehicle):
        raise ValueError('An operable vehicle requires a packaged HTML vehicleEntry or a supported native vehicle controller.')
    work_order = None
    if data.get('workOrder'):
        work_order = relative_file(root, data['workOrder'], {'.json'})
        if not isinstance(read_json(work_order), (dict, list)):
            raise ValueError('workOrder must be a JSON object or array.')

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
    # Archive the same preview bytes that will be uploaded to the viewer.
    model_archive.update({name: output / 'preview' / name for name in preview})
    thumbnail_name = 'preview' + thumbnail.suffix.lower()
    shutil.copyfile(thumbnail, output / thumbnail_name)
    zip_files(output / 'model.zip', model_archive)
    zip_files(output / 'modeling-code.zip', sources)
    metadata.update(model='preview/' + quote(model), thumbnail=thumbnail_name)
    metadata['downloads'] = [
        {'label': 'Download Model and Motion Files', 'file': 'model.zip'},
        {'label': 'Download Modeling Code', 'file': 'modeling-code.zip'},
    ]
    if interaction:
        shutil.copyfile(interaction, output / 'interaction.json')
        metadata['interaction'] = 'interaction.json'
    if work_order:
        shutil.copyfile(work_order, output / 'work-order.json')
        metadata['downloads'].append({'label': 'Download Work Order', 'file': 'work-order.json'})

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
        destination = 'creator-releases' if name in {'model.zip', 'modeling-code.zip', 'work-order.json'} else 'creator-pages'
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
        'code_archive_contents': sorted(sources),
        'work_order_included': work_order is not None,
        'approval_digest': digest.hexdigest(),
    }


def catalog_entry(asset_id, plan, hosting):
    """Resolve public URLs without copying asset bytes into the Gallery repository."""
    base = hosting['preview_base_url'].rstrip('/') + '/'
    entry = {'id': asset_id, **plan['metadata']}
    del entry['slug']
    for field in ('model', 'interaction', 'vehicleEntry'):
        if field in entry:
            entry[field] = base + entry[field]
    entry['thumbnail'] = f'./models/{asset_id}/' + entry['thumbnail']
    entry['downloads'] = [
        {'label': item['label'], 'url': hosting['download_urls'][item['file']]}
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
        raise ValueError(f'{asset_id} already exists. Pick a new slug to submit a new work.')
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
        if existing == entry and thumbnail.is_file() and hashlib.sha256(thumbnail.read_bytes()).hexdigest() == expected['sha256']:
            return False
        raise ValueError(f'{asset_id} already exists. Pick a new slug to submit a new work.')

    destination.mkdir(parents=True)
    shutil.copyfile(package / plan['metadata']['thumbnail'], destination / plan['metadata']['thumbnail'])
    records = checkout / '_data' / 'works'
    records.mkdir(parents=True, exist_ok=True)
    entry['publishedAt'] = datetime.now(timezone.utc).isoformat()
    write_json(records / (asset_id + '.json'), entry)
    return True
