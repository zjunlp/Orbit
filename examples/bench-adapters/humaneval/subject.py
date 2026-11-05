"""The C1 subject inside the solve Run: writes $ORBIT_OUTPUT/completion.json for one HumanEval prompt."""
import json
import os
from pathlib import Path
import re
import sys
import urllib.request

method, problem = sys.argv[1], json.loads(Path(sys.argv[2]).read_text())
if method == "oracle":
    completion = problem["completion"]
elif method == "empty":
    completion = ""
else:
    body = {"model": os.environ["ORBIT_MODEL"], "temperature": float(os.environ.get("ORBIT_TEMPERATURE", "0")),
            "messages": [{"role": "user", "content": "Complete the following Python function. Reply with the "
                          "complete function in one ```python code block.\n\n" + problem["prompt"]}]}
    req = urllib.request.Request(os.environ["ORBIT_BASE_URL"].rstrip("/") + "/chat/completions",
                                 data=json.dumps(body).encode(),
                                 headers={"Content-Type": "application/json",
                                          "Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"})
    with urllib.request.urlopen(req, timeout=300) as r:
        text = json.load(r)["choices"][0]["message"]["content"]
    code = (re.findall(r"```(?:python)?\n(.*?)```", text, re.S) or [text])[0]
    # The check program is prompt + completion: keep only what follows the prompt's signature.
    completion = code.split(problem["prompt"].rstrip(), 1)[-1] if problem["prompt"].rstrip() in code else code
out = Path(os.environ.get("ORBIT_OUTPUT", "."))
(out / "completion.json").write_text(json.dumps({"task_id": problem["task_id"], "completion": completion}))
