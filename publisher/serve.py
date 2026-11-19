"""Preview the Gallery locally, including its Pages-generated catalog."""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
import json
from pathlib import Path
from urllib.parse import urlsplit


class GalleryHandler(SimpleHTTPRequestHandler):
    def send_head(self):
        if urlsplit(self.path).path != '/entries.json':
            return super().send_head()
        folder = Path(self.directory) / '_data' / 'works'
        entries = [json.loads(p.read_bytes()) for p in sorted(folder.glob('*.json'))]
        payload = json.dumps(entries).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        return BytesIO(payload)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('port', type=int, default=8080, nargs='?')
    root = Path(__file__).resolve().parents[1]
    handler = partial(GalleryHandler, directory=str(root))
    ThreadingHTTPServer(('127.0.0.1', parser.parse_args().port), handler).serve_forever()
