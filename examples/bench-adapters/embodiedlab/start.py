"""Start the native wall clock just before the Agent command."""
import json
import os
import sys
import urllib.request


def main(command):
    request = urllib.request.Request('http://lab:8765/v1/trial/start', data=b'{}')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(request, timeout=5) as response:
        remaining = json.load(response)['remaining_s']
    if remaining <= 0:
        raise RuntimeError('The native trial wall budget has already expired')
    os.execvp('timeout', ['timeout', '--kill-after=5s', f'{remaining}s', *command])


if __name__ == '__main__':
    main(sys.argv[1:])
