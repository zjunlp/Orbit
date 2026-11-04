"""Add the bridge MCP server to the per-Run Agent home, then preserve the original argv."""

import json
import os
from pathlib import Path
import sys


def configure():
    if not os.environ.get("ORBIT_GUI_URL"):
        return
    tool = "/tools/orbit-computer.py"
    home = os.environ.get("CODEX_HOME")
    if home and Path(home).resolve().is_relative_to("/orbit/agent"):
        Path(home).mkdir(parents=True, exist_ok=True)
        import tomllib
        path = Path(home) / "config.toml"
        text = path.read_text() if path.exists() else ""
        config = tomllib.loads(text)
        if "orbit-computer" not in config.get("mcp_servers", {}):
            with path.open("a") as stream:
                stream.write('\n[mcp_servers.orbit-computer]\ncommand = "python"\n'
                             f'args = ["{tool}", "mcp"]\n'
                             f'env = {{ ORBIT_GUI_URL = {json.dumps(os.environ["ORBIT_GUI_URL"])} }}\n')
    home = os.environ.get("CLAUDE_CONFIG_DIR")
    if home and Path(home).resolve().is_relative_to("/orbit/agent"):
        Path(home).mkdir(parents=True, exist_ok=True)
        path = Path(home) / ".claude.json"
        config = json.loads(path.read_text()) if path.exists() else {}
        servers = config.setdefault("mcpServers", {})
        if "orbit-computer" not in servers:
            servers["orbit-computer"] = {"command": "python", "args": [tool, "mcp"],
                                         "env": {"ORBIT_GUI_URL": os.environ["ORBIT_GUI_URL"]}}
            path.write_text(json.dumps(config))
            path.chmod(0o600)


if __name__ == "__main__":
    try:
        configure()
    except (OSError, ValueError, TypeError) as exc:
        print(f"MCP configuration unavailable ({type(exc).__name__}); use the orbit-computer CLI.", file=sys.stderr)
    os.execvp(sys.argv[1], sys.argv[1:])
