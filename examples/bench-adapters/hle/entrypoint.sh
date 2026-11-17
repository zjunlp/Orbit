#!/bin/sh
set -eu
if [ -n "${HLE_SOCKET:-}" ]; then
    python3 -B -c 'import sys,importlib.metadata
assert sys.version_info[:3] == (3,11,16), "HLE requires Python 3.11.16"
for line in open("/hle-requirements.txt"):
 line=line.strip()
 if line and not line.startswith("#"):
  name,version=line.split("==")
  assert importlib.metadata.version(name) == version, "HLE package version mismatch: " + name'
    python3 -B /hle-adapter/relay.py &
    python3 -c 'import socket,time
for _ in range(100):
 try:
  s=socket.create_connection(("127.0.0.1",18080),0.1);s.close();break
 except OSError: time.sleep(0.05)
else: raise RuntimeError("Model relay did not start")'
fi
exec "$@"
