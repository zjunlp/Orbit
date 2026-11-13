#!/bin/sh
set -eu
if [ "${2:-}" = verify ]; then
    exec python "$@"
fi
export DISPLAY=:99
Xvfb "$DISPLAY" -screen 0 1280x1024x24 +extension GLX +render -noreset -nolisten tcp &
xvfb=$!
for attempt in $(seq 1 50); do
    if [ -S /tmp/.X11-unix/X99 ]; then
        exec python "$@"
    fi
    kill -0 "$xvfb" 2>/dev/null || break
    sleep 0.1
done
echo "RLBench Xvfb failed to start" >&2
exit 1
