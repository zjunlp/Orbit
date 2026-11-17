"""Loopback bridge for a native provider CLI; only forwards approved model routes."""
import http.server
from urllib.parse import urlsplit
from transport import Connection


class Relay(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *args):
        pass

    def do_POST(self):
        parsed = urlsplit(self.path)
        if parsed.path not in ('/v1/messages', '/v1/messages/count_tokens') or parsed.query not in ('', 'beta=true'):
            self.send_error(403)
            return
        size = int(self.headers.get('Content-Length', '0'))
        if not 0 < size <= 16 * 1024 * 1024:
            self.send_error(413)
            return
        conn = Connection(timeout=300)
        try:
            body = self.rfile.read(size)
            headers = {k: v for k, v in self.headers.items()
                       if k.lower() in ('content-type', 'authorization', 'x-api-key', 'anthropic-version', 'anthropic-beta')}
            conn.request('POST', '/model' + parsed.path, body, headers)
            response = conn.getresponse()
            self.send_response(response.status)
            self.send_header('Content-Type', response.getheader('Content-Type', 'application/json'))
            self.send_header('Connection', 'close')
            self.end_headers()
            while chunk := response.read1(65536):
                self.wfile.write(chunk)
                self.wfile.flush()
        except (OSError, ValueError, TimeoutError):
            self.close_connection = True
        finally:
            conn.close()
            self.close_connection = True


if __name__ == '__main__':
    http.server.ThreadingHTTPServer(('127.0.0.1', 18080), Relay).serve_forever()
