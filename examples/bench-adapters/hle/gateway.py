"""Per-trial network service. Only model forwarding and filtered web tools are exposed."""
import http.client
import http.server
import json
import os
import signal
import sys
from pathlib import Path
import socket
import socketserver
import ssl
import threading
import time
from urllib.parse import parse_qs, quote, urljoin, urlsplit
import xml.etree.ElementTree as ET

from filtering import Blocked, Policy, public_addresses

MAX_BYTES = 20 * 1024 * 1024


class PinnedHTTPS(http.client.HTTPSConnection):
    def __init__(self, name, port, address):
        super().__init__(name, port, timeout=40, context=ssl.create_default_context())
        self.address = address

    def connect(self):
        raw = socket.create_connection(self.address, timeout=self.timeout)
        self.sock = self._context.wrap_socket(raw, server_hostname=self.host)


class PinnedHTTP(http.client.HTTPConnection):
    def __init__(self, name, port, address):
        super().__init__(name, port, timeout=40)
        self.address = address

    def connect(self):
        self.sock = socket.create_connection(self.address, timeout=self.timeout)


def request(url, *, data=None, headers=None):
    parsed = urlsplit(url)
    addresses = public_addresses(url)
    address = sorted(addresses, key=lambda a: a[0] != socket.AF_INET)[0][4][:2]
    cls = PinnedHTTPS if parsed.scheme == 'https' else PinnedHTTP
    conn = cls(parsed.hostname, parsed.port or (443 if parsed.scheme == 'https' else 80), address)
    conn.request('POST' if data is not None else 'GET',
                 parsed.path + ('?' + parsed.query if parsed.query else ''), body=data,
                 headers={'User-Agent': 'Orbit-HLE/1', **(headers or {})})
    return conn, conn.getresponse()


class Gateway:
    def __init__(self, config):
        self.config = config
        self.policy = Policy(json.loads(Path(config['blocklist']).read_text()), config['question'])
        self.cache = {}
        self.lock = threading.Lock()
        self.calls = 0

    def audit(self, kind, **data):
        with self.lock:
            with Path('/evidence/web.jsonl').open('a') as f:
                f.write(json.dumps({'time': time.time(), 'kind': kind, **data}, ensure_ascii=False) + '\n')

    def fetch_bytes(self, url, *, search=False):
        for _ in range(6):
            if not search:
                self.policy.url(url)
            conn, response = request(url)
            try:
                if response.status in (301, 302, 303, 307, 308):
                    target = urljoin(url, response.getheader('Location', ''))
                    if search:
                        parsed = urlsplit(target)
                        args = parse_qs(parsed.query)
                        if (parsed.scheme != 'https' or parsed.hostname not in ('www.bing.com', 'cn.bing.com', 'bing.com')
                                or parsed.path != '/search' or args.get('format') != ['rss']
                                or args.get('q') != parse_qs(urlsplit(url).query).get('q')):
                            raise ValueError('Search backend redirected outside its approved endpoint')
                    url = target
                    continue
                if response.status != 200:
                    raise ValueError(f'Web HTTP {response.status}')
                content_type = response.getheader('Content-Type', '').lower()
                data = response.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    raise ValueError('Web document exceeds 20 MiB')
                return url, content_type, data
            finally:
                conn.close()
        raise Blocked('redirect_limit')

    def search(self, query):
        self.policy.query(query)
        url = 'https://www.bing.com/search?format=rss&q=' + quote(query)
        _, _, data = self.fetch_bytes(url, search=True)
        root = ET.fromstring(data)
        if root.tag != 'rss':
            raise ValueError('Search backend did not return RSS')
        items = root.findall('./channel/item')[:20]
        accepted = []
        for item in items:
            row = {key: (item.findtext(tag) or '') for key, tag in
                   [('url', 'link'), ('title', 'title'), ('snippet', 'description')]}
            try:
                self.policy.result(**row)
                accepted.append(row)
            except Blocked as exc:
                self.audit('blocked_result', url=row['url'], rule=str(exc))
        return {'results': accepted, 'backend': 'bing-rss', 'candidates': len(items)}

    def fetch(self, url):
        self.policy.url(url)
        if url not in self.cache:
            final, content_type, data = self.fetch_bytes(url)
            if 'application/pdf' in content_type or data.startswith(b'%PDF-'):
                import pymupdf
                doc = pymupdf.open(stream=data, filetype='pdf')
                try:
                    title = doc.metadata.get('title', '')
                    text = '\n\n'.join(page.get_text() for page in doc)
                finally:
                    doc.close()
            elif 'text/html' in content_type or 'application/xhtml+xml' in content_type:
                import trafilatura
                meta = trafilatura.extract_metadata(data)
                title = meta.title if meta and meta.title else ''
                text = trafilatura.extract(data, output_format='markdown', include_tables=True,
                                          include_links=True, include_images=False) or ''
            elif content_type.startswith('text/plain') or content_type.startswith('text/markdown'):
                title, text = '', data.decode('utf-8', errors='replace')
            else:
                raise Blocked('non_text_media')
            self.cache[url] = {'url': final, 'title': title, 'markdown': text}
        value = self.cache[url]
        self.policy.url(value['url'])
        self.policy.text(value['title'])
        self.policy.text(value['markdown'])
        text = value['markdown']
        return {**value, 'markdown': text[:60000], 'truncated': len(text) > 60000}

    def tool(self, kind, data):
        with self.lock:
            self.calls += 1
            if self.calls > 200:
                raise ValueError('Web tool budget exhausted')
        try:
            if kind == 'web_search' and set(data) == {'query'}:
                result = self.search(data['query'])
            elif kind == 'web_fetch' and set(data) == {'url'}:
                result = self.fetch(data['url'])
            else:
                raise ValueError('Invalid tool arguments')
            self.audit(kind, arguments=data, status='ok')
            return result
        except Exception as exc:
            self.audit(kind, arguments=data, status='blocked' if isinstance(exc, Blocked) else 'error',
                       rule=str(exc)[:500])
            raise


class Handler(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    gateway = None

    def log_message(self, *args):
        pass

    def reply(self, code, data):
        raw = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        try:
            size = int(self.headers.get('Content-Length', '0'))
            if not 0 < size <= 16 * 1024 * 1024:
                raise ValueError('Invalid request size')
            raw = self.rfile.read(size)
            data = json.loads(raw)
            if self.path in ('/web_search', '/web_fetch'):
                try:
                    return self.reply(200, self.gateway.tool(self.path[1:], data))
                except Blocked as exc:
                    return self.reply(403, {'error': str(exc)})
                except Exception as exc:
                    return self.reply(502, {'error': type(exc).__name__ + ': ' + str(exc)[:500]})
            if self.path not in ('/model/v1/messages', '/model/v1/messages/count_tokens'):
                raise Blocked('unknown_route')
            if not isinstance(data, dict) or data.get('model') != self.gateway.config['model']:
                raise Blocked('unexpected_model')
            if any(t.get('type') not in (None, 'custom') for t in data.get('tools', [])):
                raise Blocked('provider_server_tools_disabled')
            headers = {k: v for k, v in self.headers.items() if k.lower() in
                       ('content-type', 'authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta')}
            endpoint = self.gateway.config['modelBaseUrl'].rstrip('/') + self.path.removeprefix('/model')
            conn, response = request(endpoint, data=raw, headers=headers)
            try:
                self.send_response(response.status)
                self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
                self.send_header('Connection', 'close')
                self.end_headers()
                while chunk := response.read1(65536):
                    self.wfile.write(chunk)
                    self.wfile.flush()
            finally:
                conn.close()
                self.close_connection = True
        except Blocked as exc:
            self.reply(403, {'error': str(exc)})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception as exc:
            self.reply(502, {'error': type(exc).__name__})


class Server(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True


if __name__ == '__main__':
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    config = json.loads(Path('/gateway-config.json').read_text())
    Path('/evidence').mkdir(exist_ok=True)
    Handler.gateway = Gateway(config)
    path = '/hle-ipc/gateway.sock'
    if Path(path).exists():
        Path(path).unlink()
    with Server(path, Handler) as server:
        os.chmod(path, 0o666)
        server.serve_forever()
