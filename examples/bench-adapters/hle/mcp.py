"""Minimal stdio MCP transport for the two upstream web tools."""
import json
import sys
from transport import call

TOOLS = [
    {'name': 'web_search', 'description': 'Search the web with benchmark contamination filtering.',
     'inputSchema': {'type': 'object', 'properties': {'query': {'type': 'string'}}, 'required': ['query'], 'additionalProperties': False}},
    {'name': 'web_fetch', 'description': 'Read a filtered web page or PDF as Markdown (maximum 60000 characters).',
     'inputSchema': {'type': 'object', 'properties': {'url': {'type': 'string'}}, 'required': ['url'], 'additionalProperties': False}},
]


def handle(req):
    method = req.get('method')
    if method == 'initialize':
        return {'protocolVersion': '2024-11-05', 'capabilities': {'tools': {}},
                'serverInfo': {'name': 'hle-web', 'version': '1'}}
    if method == 'tools/list':
        return {'tools': TOOLS}
    if method == 'ping':
        return {}
    if method == 'tools/call':
        params = req['params']
        if params.get('name') not in ('web_search', 'web_fetch'):
            raise ValueError('Unknown tool')
        value = call('/' + params['name'], params.get('arguments', {}))
        return {'content': [{'type': 'text', 'text': json.dumps(value, ensure_ascii=False)}]}
    raise ValueError('Unknown MCP method')


if __name__ == '__main__':
    for line in sys.stdin:
        req = json.loads(line)
        if 'id' not in req:
            continue
        try:
            result = handle(req)
            response = {'jsonrpc': '2.0', 'id': req['id'], 'result': result}
        except Exception as exc:
            response = {'jsonrpc': '2.0', 'id': req['id'], 'result': {
                'isError': True, 'content': [{'type': 'text', 'text': str(exc)}]}}
        print(json.dumps(response, ensure_ascii=False), flush=True)
