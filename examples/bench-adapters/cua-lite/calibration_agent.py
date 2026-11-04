"""Screenshot-only click-test positive calibration, not a general MiniWoB oracle."""
from io import BytesIO


class ClickTest:
    async def sample(self, env):
        from PIL import Image
        from lite.core.tools import make_tool_call
        observation = await env.reset()
        if 'Click the button' not in (observation.text or ''):
            raise ValueError('This script only calibrates MiniWoB click-test')
        picture = Image.open(BytesIO(observation.image)).convert('RGB')
        yellow = [(x, y) for y in range(picture.height) for x in range(picture.width)
                  if picture.getpixel((x, y)) == (255, 255, 0)]
        if not yellow:
            raise ValueError('Missing native MiniWoB instruction area')
        right, bottom = max(x for x, _ in yellow), max(y for _, y in yellow)
        button = [(x, y) for y in range(bottom + 1, picture.height) for x in range(right + 1)
                  if picture.getpixel((x, y)) == (239, 239, 239)]
        if not button:
            raise ValueError('Expected the native gray Click Me button')
        x = round(1000 * sum(p[0] for p in button) / len(button) / picture.width)
        y = round(1000 * sum(p[1] for p in button) / len(button) / picture.height)
        await env.step([make_tool_call('click', {'coordinate': [x, y]}, call_id='calibration-click')])


def make_agent(context):
    return ClickTest()
