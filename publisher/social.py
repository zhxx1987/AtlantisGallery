"""Provision the GitHub discussion and favorite link for published assets."""

from itertools import count
import re

from .package_asset import read_json, write_json


def graphql(github, query, **variables):
    response = github.request('/graphql', {'query': query, 'variables': variables})
    if response.get('errors'):
        messages = ', '.join(error['message'] for error in response['errors'])
        raise RuntimeError(f'GitHub Discussions request failed. {messages}')
    return response['data']


def discussion_marker(asset_id):
    return f'<!-- atlantis-gallery-asset: {asset_id} -->'


def existing_discussions(github, repository, category_id):
    cursor = None
    indexed = {}
    while True:
        result = graphql(github, """
            query ($repository: ID!, $category: ID!, $cursor: String) {
              node(id: $repository) {
                ... on Repository {
                  discussions(first: 100, after: $cursor, categoryId: $category) {
                    nodes { number url body }
                    pageInfo { hasNextPage endCursor }
                  }
                }
              }
            }""", repository=repository, category=category_id, cursor=cursor)['node']['discussions']
        for discussion in result['nodes']:
            for line in discussion['body'].splitlines():
                match = re.fullmatch(r'<!-- atlantis-gallery-asset: ([a-z0-9-]+) -->', line)
                if match:
                    indexed.setdefault(match[1], discussion)
        if not result['pageInfo']['hasNextPage']:
            return indexed
        cursor = result['pageInfo']['endCursor']


def existing_gists(github, wanted):
    indexed = {}
    for page in count(1):
        gists = github.request(f'/gists?per_page=100&page={page}')
        for gist in gists:
            asset_id = wanted.get(gist['description'])
            if asset_id and f'atlantis-gallery-{asset_id}.md' in gist['files']:
                indexed.setdefault(asset_id, gist)
        if len(indexed) == len(wanted) or len(gists) < 100:
            return indexed


def sync_social(github, checkout, repo, pages, asset_ids=None):
    owner, name = repo.split('/')
    if github.login.lower() != owner.lower():
        raise ValueError(f'Sign in as {owner} to set up Gallery social links.')

    manifest = checkout / 'social.json'
    entries = read_json(manifest) if manifest.is_file() else {}
    catalog = read_json(checkout / 'catalog.json')
    catalog.extend(read_json(path) for path in sorted((checkout / '_data' / 'works').glob('*.json')))
    works = [item for item in catalog if item['id'] not in entries
             and (asset_ids is None or item['id'] in asset_ids)
             and not (checkout / 'models' / item['id'] / 'social.json').is_file()]
    if not works:
        return False
    if any(not re.fullmatch(r'[a-z0-9-]+', item['id']) for item in works):
        raise ValueError('Gallery asset IDs must use lowercase letters, digits, and hyphens.')

    repository = graphql(github, """
        query ($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            id hasDiscussionsEnabled
            discussionCategories(first: 25) { nodes { id slug } }
          }
        }""", owner=owner, name=name)['repository']
    if not repository['hasDiscussionsEnabled']:
        raise ValueError(f'Enable Discussions on {repo} before syncing Gallery social links.')
    category = next(
        (item['id'] for item in repository['discussionCategories']['nodes'] if item['slug'] == 'announcements'),
        None,
    )
    if not category:
        raise ValueError(f'Create or restore the Announcements discussion category on {repo}.')

    discussions = existing_discussions(github, repository['id'], category)
    gists = existing_gists(github, {f'Atlantis Gallery: {item["id"]}': item['id'] for item in works})
    for item in works:
        asset_id = item['id']
        work_url = f'{pages}work.html?model={asset_id}'
        discussion = discussions.get(asset_id)
        if discussion is None:
            discussion = graphql(github, """
                mutation ($input: CreateDiscussionInput!) {
                  createDiscussion(input: $input) { discussion { number url } }
                }""", input={
                    'repositoryId': repository['id'],
                    'categoryId': category,
                    'title': f'Gallery asset · {item["title"]}',
                    'body': (
                        f'{discussion_marker(asset_id)}\n\n'
                        f'[Open in Atlantis Gallery]({work_url})\n\n'
                        'Use the up arrow to like this asset. Leave comments below.'
                    ),
                })['createDiscussion']['discussion']
        gist = gists.get(asset_id)
        if gist is None:
            gist = github.request('/gists', {
                'description': f'Atlantis Gallery: {asset_id}',
                'public': False,
                'files': {f'atlantis-gallery-{asset_id}.md': {
                    'content': (
                        f'[Open in Atlantis Gallery]({work_url})\n\n'
                        f'[Comments on GitHub]({discussion["url"]})\n'
                    ),
                }},
            })
        destination = checkout / 'models' / asset_id / 'social.json'
        write_json(destination, {'discussion': discussion['number'], 'gist': gist['id']})
    return True
