"""Convert an older additive catalog PR on its clean branch before merging main."""
import argparse
import json
from pathlib import Path
import re
import subprocess


def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root)


def indexed(items):
    rows = {item['id']: item for item in items}
    if len(rows) != len(items):
        raise ValueError('Duplicate work ID in the catalog. Review this branch manually.')
    return rows


def migrate(root, upstream, apply=False):
    if git(root, 'status', '--porcelain').strip():
        raise ValueError('Run on a clean PR branch before starting a merge.')
    base = git(root, 'merge-base', 'HEAD', upstream).decode().strip()
    old_catalog = git(root, 'show', base + ':catalog.json')
    before = indexed(json.loads(old_catalog))
    head = indexed(json.loads((root / 'catalog.json').read_bytes()))
    if any(head.get(k) != row for k, row in before.items()):
        raise ValueError('This PR also changes existing records. Review it manually.')
    additions = sorted(head.keys() - before.keys())
    upstream_rows = indexed(json.loads(git(root, 'show', upstream + ':catalog.json')))
    for key in additions:
        if not re.fullmatch(r'[a-z0-9]+(?:-[a-z0-9]+)*', key):
            raise ValueError('Invalid work ID in PR.')
        path = '_data/works/' + key + '.json'
        if key in upstream_rows or git(root, 'ls-tree', upstream, '--', path) or (root / path).exists():
            raise ValueError(f'{key} already has a record. Review the same-ID change manually.')
    if apply and additions:
        folder = root / '_data' / 'works'
        folder.mkdir(exist_ok=True, parents=True)
        for key in additions:
            (folder / (key + '.json')).write_text(json.dumps(head[key], ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        (root / 'catalog.json').write_bytes(old_catalog)
    return additions


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('upstream', help='Fetched Gallery main ref, e.g. upstream/main')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    print(json.dumps(migrate(Path.cwd(), args.upstream, args.apply)))
