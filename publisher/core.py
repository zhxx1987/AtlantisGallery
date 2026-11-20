"""Local MCP publisher for the public Atlantis Gallery on GitHub Pages."""

from itertools import count
import json
import mimetypes
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time
from typing import Any
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
from uuid import uuid4

from .package_asset import add_to_catalog, catalog_entry, check_catalog_slot, stage_package
from .creator_storage import hosting_urls, publish_creator_assets
from .social import sync_social
from .requirements_guide import verify_requirements
import hashlib


OWNER = 'zhxx1987'
REPO = f'{OWNER}/AtlantisGallery'
PAGES = f'https://{OWNER}.github.io/AtlantisGallery/'
API = 'https://api.github.com'
MAIN = 'main'



def git(*args, cwd=None, stdin=None):
    env = {**os.environ, 'GIT_TERMINAL_PROMPT': '0', 'GCM_INTERACTIVE': 'Never'}
    proxy = env.get('HTTPS_PROXY') or env.get('https_proxy')
    config = ['-c', f'http.proxy={proxy}'] if proxy else []
    input_options = {'stdin': subprocess.DEVNULL} if stdin is None else {'input': stdin}
    result = subprocess.run(
        ['git', *config, *args], cwd=cwd, env=env, **input_options,
        encoding='utf-8', errors='replace', capture_output=True, timeout=240, check=False,
    )
    if result.returncode:
        if args[0] == 'credential':
            raise ValueError('Sign in to Git Credential Manager using git credential-manager github login.')
        raise RuntimeError(f'Git {args[0]} failed. {result.stderr.strip()}')
    return result.stdout.strip()


class GitHub:
    def __init__(self):
        expected_login = os.environ.get('ATLANTIS_GALLERY_GITHUB_USER', '').strip()
        if expected_login and not re.fullmatch(r'[A-Za-z0-9-]+', expected_login):
            raise ValueError('Set ATLANTIS_GALLERY_GITHUB_USER to your GitHub username.')
        fields = ['protocol=https', 'host=github.com']
        if expected_login:
            fields.append('username=' + expected_login)
        try:
            credential = git('credential', 'fill', stdin='\n'.join(fields) + '\n\n')
        except ValueError as error:
            raise ValueError(f'{error} With multiple GitHub accounts, set ATLANTIS_GALLERY_GITHUB_USER in the MCP configuration.') from None
        token = dict(line.split('=', 1) for line in credential.splitlines() if '=' in line).get('password')
        if not token:
            raise ValueError('Sign in to Git Credential Manager using git credential-manager github login.')
        self.token = token
        user = self.request('/user')
        self.login = user['login']
        if not re.fullmatch(r'[A-Za-z0-9-]+', self.login):
            raise ValueError('Could not verify the GitHub account.')
        if expected_login and self.login.lower() != expected_login.lower():
            raise ValueError('The signed-in GitHub account differs from ATLANTIS_GALLERY_GITHUB_USER.')
        self.email = f"{user['id']}+{self.login}@users.noreply.github.com"

    def request(self, path, payload=None, missing=False, method=None):
        headers = {
            'Authorization': 'Bearer ' + self.token,
            'Accept': 'application/vnd.github+json',
            'Content-Type': 'application/json',
            'User-Agent': 'Atlantis-Gallery-Publisher',
        }
        request = Request(API + path, headers=headers, data=None if payload is None else json.dumps(payload).encode(), method=method)
        try:
            with urlopen(request, timeout=30) as response:
                return json.load(response)
        except HTTPError as error:
            if missing and error.code == 404:
                return None
            message = json.load(error).get('message', error.reason)
            raise RuntimeError(f'GitHub returned HTTP {error.code}. {message}') from None

    def upload_release_asset(self, repository, release_id, source, label):
        """Stream large archives to the fixed GitHub uploads origin, without loading them into RAM."""
        query = urlencode({'name': source.name, 'label': label})
        url = f'https://uploads.github.com/repos/{repository}/releases/{release_id}/assets?{query}'
        headers = {
            'Authorization': 'Bearer ' + self.token,
            'Accept': 'application/vnd.github+json',
            'Content-Type': mimetypes.guess_type(source.name)[0] or 'application/octet-stream',
            'Content-Length': str(source.stat().st_size),
            'User-Agent': 'Atlantis-Gallery-Publisher',
        }
        with source.open('rb') as stream:
            request = Request(url, headers=headers, data=stream, method='POST')
            try:
                with urlopen(request, timeout=900) as response:
                    return json.load(response)
            except HTTPError as error:
                message = json.load(error).get('message', error.reason)
                raise RuntimeError(f'Release upload returned HTTP {error.code}. {message}') from None

    def fork(self):
        path = f'/repos/{self.login}/AtlantisGallery'
        fork = self.request(path, missing=True)
        if fork is None:
            self.request(f'/repos/{REPO}/forks', {'default_branch_only': True})
            for _ in range(15):
                time.sleep(2)
                fork = self.request(path, missing=True)
                if fork and fork.get('parent'):
                    break
        if not fork or fork.get('parent', {}).get('full_name', '').lower() != REPO.lower():
            raise ValueError('The GitHub account needs a ready fork of AtlantisGallery under its original repository name.')
        return f'https://github.com/{self.login}/AtlantisGallery.git'

    def pending_submission(self, branch_prefix):
        fork_name = f'{self.login}/AtlantisGallery'.lower()
        for page in count(1):
            params = urlencode({'state': 'open', 'base': MAIN, 'per_page': 100, 'page': page})
            pulls = self.request(f'/repos/{REPO}/pulls?{params}')
            for pull in pulls:
                head = pull['head']
                source = head.get('repo') or {}
                if head['ref'].startswith(branch_prefix) and source.get('full_name', '').lower() == fork_name:
                    return pull
            if len(pulls) < 100:
                return None

    def submit(self, plan, package, temp):
        owner = self.login.lower() == OWNER
        slug = plan['metadata']['slug']
        asset_id = slug if owner else f'{self.login.lower()}-{slug}'
        work_url = PAGES + 'work.html?model=' + asset_id
        checkout = temp / 'gallery'
        upstream = f'https://github.com/{REPO}.git'
        # The shared repository may contain legacy models. Fetch only the index and small work folder.
        git('clone', '--quiet', '--depth', '1', '--filter=blob:none', '--sparse', '--branch', MAIN, upstream, str(checkout))
        git('sparse-checkout', 'set', '_data/works', f'models/{asset_id}', cwd=checkout)
        planned_hosting = hosting_urls(self.login, plan)
        check_catalog_slot(checkout, asset_id, catalog_entry(asset_id, plan, planned_hosting))
        branch_prefix = f"gallery/{asset_id}-{plan['approval_digest'][:12]}-"
        if not owner:
            fork = self.fork()
            pending = self.pending_submission(branch_prefix)
            if pending:
                return {'status': 'submitted', 'id': asset_id, 'pull_request_url': pending['html_url'],
                        'gallery_url_after_merge': work_url}

        hosting = publish_creator_assets(self, plan, package, temp, git)
        asset_added = add_to_catalog(checkout, asset_id, package, plan, hosting)
        social_added = owner and sync_social(self, checkout, REPO, PAGES, {asset_id})
        if not asset_added and not social_added:
            return {'status': 'already_published', 'id': asset_id, 'gallery_url': work_url,
                    'asset_repository_url': hosting['repository_url']}

        title = plan['metadata']['title']
        paths = [f'_data/works/{asset_id}.json', f'models/{asset_id}'] if asset_added else []
        if social_added:
            paths.append(f'models/{asset_id}/social.json')
        git('add', '--', *paths, cwd=checkout)
        message = f'Publish Gallery work: {title}' if asset_added else f'Add social links for {title}'
        git('-c', f'user.name={self.login}', '-c', f'user.email={self.email}',
            'commit', '--quiet', '-m', message, cwd=checkout)
        branch = MAIN if owner else branch_prefix + uuid4().hex[:8]
        for attempt in range(4):
            try:
                git('-c', f'credential.https://github.com.username={self.login}', 'push',
                    upstream if owner else fork, f'HEAD:refs/heads/{branch}', cwd=checkout)
                break
            except RuntimeError as error:
                if not owner or attempt == 3 or not any(s in str(error) for s in ('non-fast-forward', 'fetch first', 'failed to update ref')):
                    raise
                git('fetch', 'origin', MAIN, cwd=checkout)
                git('rebase', 'FETCH_HEAD', cwd=checkout)
        if owner:
            revision = git('rev-parse', 'HEAD', cwd=checkout)
            return {'status': 'published_pending_pages', 'id': asset_id, 'gallery_url': work_url,
                    'revision': revision, 'asset_repository_url': hosting['repository_url']}

        pull = self.request(f'/repos/{REPO}/pulls', {
            'title': f'Add Gallery work: {title}',
            'head': f'{self.login}:{branch}',
            'base': MAIN,
            'body': f'Public Gallery index submission.\n\nAsset ID: `{asset_id}`.\n\n'
                    f'Creator resources: {hosting["repository_url"]}\n\n'
                    f'Only the catalog entry and thumbnail are submitted to Gallery.\n\nPreview after merge: {work_url}',
        })
        return {'status': 'submitted', 'id': asset_id, 'pull_request_url': pull['html_url'],
                'gallery_url_after_merge': work_url, 'asset_repository_url': hosting['repository_url']}


def reviewed_plan(manifest_path, package, requirements_digest):
    verify_requirements(requirements_digest)
    plan = stage_package(manifest_path, package)
    plan['requirements_digest'] = requirements_digest
    plan['approval_digest'] = hashlib.sha256((plan['approval_digest'] + requirements_digest).encode()).hexdigest()
    return plan


def prepare_gallery_upload(manifest_path: str, requirements_digest: str) -> dict[str, Any]:
    """Validate a local submission.json and list every file and archive member that would be public.

    Show the creator this plan and ask for explicit public-upload approval. Keep the approval_digest
    for publish_gallery_asset. This tool uses local files and does not contact GitHub.
    """
    with tempfile.TemporaryDirectory(prefix='atlantis-gallery-') as folder:
        return reviewed_plan(manifest_path, Path(folder) / 'package', requirements_digest)


def publish_gallery_asset(manifest_path: str, approval_digest: str, requirements_digest: str, confirm_public: bool = False) -> dict[str, Any]:
    """Upload approved resources to the creator's own repository Pages and Releases.

    Set confirm_public only after the creator approves the exact plan from prepare_gallery_upload.
    Gallery receives only a catalog entry and thumbnail. Contributors get an index pull request;
    the Gallery owner publishes its index directly. Retry the same digest if resource Pages is building.
    """
    if confirm_public is not True:
        raise ValueError('Explicit approval to upload these files to public GitHub is required.')
    with tempfile.TemporaryDirectory(prefix='atlantis-gallery-') as folder:
        temp = Path(folder)
        package = temp / 'package'
        plan = reviewed_plan(manifest_path, package, requirements_digest)
        if approval_digest != plan['approval_digest']:
            raise ValueError('The files or metadata changed. Prepare the upload and review the new plan.')
        return GitHub().submit(plan, package, temp)
