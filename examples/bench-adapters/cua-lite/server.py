"""CUA-Lite's native MiniWoB environment behind the shared signed GUI service."""
import asyncio
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from importlib import import_module
from importlib.metadata import version
from io import BytesIO
import json
from pathlib import Path
import sys
from threading import Thread

sys.path.append(str(Path(__file__).resolve().parent.parent.parent / "tools"))
service = import_module("orbit-gui-service.service")


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


class CuaLiteBackend:
    def __init__(self, plan):
        self.plan = plan
        self.loop = asyncio.new_event_loop()
        self.env = self.server = None
        self.obs = None
        self.details = {}
        self.call_number = 0

    def reset(self):
        if any(version(p) != "0.14.3" for p in ("browsergym-miniwob", "browsergym-core")):
            raise ValueError("Expected BrowserGym 0.14.3")
        self.server = ThreadingHTTPServer(("127.0.0.1", 7560), partial(QuietHandler, directory="/miniwob"))
        Thread(target=self.server.serve_forever, daemon=True).start()
        import lite.gym as gym
        self.env = gym.make(self.plan["task"], seed=self.plan["seed"], max_steps=self.plan["max_steps"])
        observation = self.loop.run_until_complete(self.env.reset())
        if not isinstance(observation.image, bytes):
            raise ValueError("Native reset omitted its screenshot")
        self.obs = {"screenshot": observation.image, "goal": observation.text or "", "last_action": "", "last_action_error": ""}
        return self.obs

    def spec(self):
        from PIL import Image
        from lite.core.tools.action_space.base import LiteDesktopActionSet
        from lite.core.tools import make_tool_call
        image = Image.open(BytesIO(self.obs["screenshot"]))
        metadata = self.env.metadata
        schemas = LiteDesktopActionSet.get_tool_schemas(include=metadata.valid_actions)
        schemas += metadata.extra_tool_schemas
        stop = make_tool_call("terminate", {"status": "success", "reason": ""}, call_id="orbit-finish")
        return {"action_set": "canonical", "width": image.width, "height": image.height,
            "observation": "screenshot", "stop_action": json.dumps(stop),
            "action_description": "Submit one canonical CUA-Lite tool call as JSON, with type=function and function={name,arguments}. "
                "Coordinates are normalized to [0,1000]. Original native tool schemas:\n" + json.dumps(schemas, ensure_ascii=False)}

    def step(self, action):
        from lite.core.tools.calls import validate_lite_tool_call
        try:
            call = json.loads(action)
        except ValueError:
            raise service.RequestError(400, "Action must be a canonical CUA-Lite JSON tool call") from None
        error = validate_lite_tool_call(call, "GUI action", require_id=False)
        if error:
            raise service.RequestError(400, error)
        if "id" not in call:
            self.call_number += 1
            call["id"] = f"orbit-gui-{self.call_number}"
        try:
            reply = self.loop.run_until_complete(self.env.step([call]))
        except (TypeError, ValueError, KeyError) as exc:
            # The native executor rejected the Agent's arguments: report it like a validation error
            # (the Agent may retry), not as an environment failure that would void the trial.
            raise service.RequestError(400, f"Native executor rejected the call: {type(exc).__name__}: {exc}"[:500]) from None
        frames = [image for result in reply.results for image in result.images]
        errors = [result.error for result in reply.results if result.error]
        self.obs = {"screenshot": frames[-1] if frames else self.obs["screenshot"],
            "goal": self.obs["goal"], "last_action": action, "last_action_error": "\n".join(errors),
            "frame_source": "native_step" if frames else "previous_observation"}
        if not frames:
            self.obs["text"] = "The native step returned no new frame; the preceding observation is shown."
        info = {"task_info": {"native_reward": reply.reward, "native_terminated": reply.terminated,
                "native_truncated": reply.truncated, "pool_unreachable": bool(reply.info.get("pool_unreachable"))}}
        return self.obs, reply.reward, reply.terminated, reply.truncated, info

    def close(self):
        try:
            if self.env is not None:
                self.loop.run_until_complete(self.env.close())
        finally:
            if self.server is not None:
                self.server.shutdown()
                self.server.server_close()
            self.loop.close()


if __name__ == "__main__":
    plan, output = Path(sys.argv[1]), Path(sys.argv[2])
    sys.exit(service.serve(plan, output, CuaLiteBackend(service.read(plan))))
