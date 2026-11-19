"""Read the public Gallery sharing contract used by authors and publishers."""
import hashlib
from html.parser import HTMLParser
from urllib.request import Request, urlopen


GUIDE_URL = 'https://zhxx1987.github.io/AtlantisGallery/publish.html'


class GuideText(HTMLParser):
    def __init__(self):
        super().__init__()
        self.in_main = False
        self.parts = []

    def handle_starttag(self, tag, attrs):
        if tag == 'main':
            self.in_main = True
        if self.in_main and tag in {'li', 'p', 'h1', 'h2', 'pre', 'blockquote', 'summary'}:
            self.parts.append('\n')
        if self.in_main and tag == 'a':
            href = dict(attrs).get('href')
            if href:
                self.parts.append(f' [{href}] ')

    def handle_endtag(self, tag):
        if tag == 'main':
            self.in_main = False

    def handle_data(self, data):
        if self.in_main:
            self.parts.append(data)


def read_gallery_requirements() -> dict:
    """Read the current live Gallery sharing page before planning or publishing a submission."""
    request = Request(GUIDE_URL, headers={'Cache-Control': 'no-cache', 'User-Agent': 'Atlantis-Gallery'})
    with urlopen(request, timeout=20) as response:
        if response.geturl() != GUIDE_URL:
            raise ValueError('Unexpected Gallery guide destination.')
        body = response.read(524289)
    if len(body) > 524288 or b'id="operable-vehicles"' not in body:
        raise ValueError('The current Gallery sharing requirements could not be verified. Retry the live guide.')
    parser = GuideText()
    parser.feed(body.decode('utf-8'))
    parser.close()
    guide = '\n'.join(line.strip() for line in ''.join(parser.parts).splitlines() if line.strip())
    if not guide or parser.in_main:
        raise ValueError('The Gallery sharing guide is incomplete.')
    return {'url': GUIDE_URL, 'requirements': guide,
            'requirements_digest': hashlib.sha256(guide.encode()).hexdigest()}


def verify_requirements(digest):
    if not digest or read_gallery_requirements()['requirements_digest'] != digest:
        raise ValueError('Read the current Gallery sharing requirements and pass the returned requirements_digest.')
