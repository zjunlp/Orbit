# 长对话复盘的开发验证

Conversation 的轮次目录和消息区都只挂载可见行与缓冲行。消息按事件拆分，因此单轮也有同样的挂载上限。
工具结果在折叠时仍可搜索，展开状态跨虚拟卸载保留；`?turn=`、`h/l/e`、失败按钮与 ATIF 关联轮次沿用现有语义。
Conversation 的 Refresh 刷新产物目录、环境与会话，并取消正在被替代的读取。

## 样本与测量口径

测试数据在 `packages/web/test/fixtures/conversation.ts`，由确定性生成器产生，并在界面明确显示 **SYNTHETIC TEST DATA**。
它们不是 Agent 执行、评分结果或真实 daemon 集成验证。浏览器通过拦截 API 返回这些数据，运行真实应用页面。

- 多轮样本：1,000 轮 / 10,000 条事件，消息与工具调用各半，第 851 轮标为失败。
- 单轮样本：1 轮 / 5,000 条事件，含 2,500 个工具结果，符合现有每轮 5,000 条事件的契约上限。
- 消息有不同高度与换行；每个工具结果有 30 行；搜索使用最后一个折叠工具结果中的标记。

2026-11-17 在同一台机器、同版本无界面 Chromium 153.0.8010.12、1540 × 1050 窗口测量；无 CPU/网络节流，预热 Vite 与依赖缓存后各重复 5 次，取中位数。
优化前版本为 `dee64d0`。打开计时包含导航、合成 API 读取和首次事件呈现；搜索计至命中计数更新；多轮跳转计至失败标题进入视口，单轮跳转计至末尾工具进入视口。
每项完成后再等待两次动画帧；这是开发服务器上的浏览器耗时，包含测试驱动开销，不是生产环境或真实 daemon 的延迟保证。

| 样本 | 指标 | 优化前 | 优化后 |
| --- | --- | ---: | ---: |
| 1,000 轮 / 10,000 事件 | 打开 | 3,874 ms | 1,117 ms |
| 1,000 轮 / 10,000 事件 | 搜索 | 1,624 ms | 126 ms |
| 1,000 轮 / 10,000 事件 | 跳转 | 4,182 ms | 156 ms |
| 1,000 轮 / 10,000 事件 | 首屏挂载事件 | 10,000 | 13 |
| 1,000 轮 / 10,000 事件 | 首屏挂载目录项 | 1,000 | 11 |
| 1 轮 / 5,000 事件 | 打开 | 1,816 ms | 929 ms |
| 1 轮 / 5,000 事件 | 搜索 | 155 ms | 76 ms |
| 1 轮 / 5,000 事件 | 跳转 | 92 ms | 161 ms |
| 1 轮 / 5,000 事件 | 首屏挂载事件 | 5,000 | 14 |
| 1 轮 / 5,000 事件 | 首屏挂载目录项 | 1 | 1 |

单轮末尾原本就可直接滚到；虚拟化需要挂载和测量末尾事件，因此也单独报告该耗时。

## 复现

先启动待测版本的开发服务器：

```bash
pnpm --filter @zjunlp/orbit-web dev --host 127.0.0.1 --port 4186 --strictPort
```

浏览器依赖为开发依赖 `playwright-core`。使用已安装的匹配 Chromium，或按项目下载规则通过本机代理安装浏览器：
`pnpm --filter @zjunlp/orbit-web exec playwright-core install chromium`。
独立终端中运行：

```bash
ORBIT_WEB_URL=http://127.0.0.1:4186 pnpm --filter @zjunlp/orbit-web test:browser
ORBIT_BROWSER_MEASURE=1 ORBIT_BROWSER_OUTPUT=/tmp/conversation-after pnpm --filter @zjunlp/orbit-web test:browser
```

非默认浏览器位置可用 `ORBIT_CHROMIUM_PATH=/absolute/path/to/chromium` 指定。
比较旧版本时，保持当前测试驱动与样本不变，对旧源码另起同配置开发服务器，再设置：

```bash
ORBIT_WEB_URL=http://127.0.0.1:4187 ORBIT_BROWSER_BASELINE=1 ORBIT_BROWSER_OUTPUT=/tmp/conversation-before pnpm --filter @zjunlp/orbit-web test:browser
```

基线模式仅运行测量，允许旧页面全量挂载。优化后模式还验证挂载数量、网址/历史/快捷键/失败跳转、搜索与展开、滚动后展开状态、窄屏布局，
并分别延迟 Run、目录、会话、环境读取后切换 Trial；刷新与离页也要取消读取。测试入口在 StrictMode 下复用同一个 hook 切换资源，验证立即隐藏旧内容，
同时测试原始文件读取，以及明确标注的忽略取消信号的传输替身，确保过期响应保护仍然有效。

录制单独演示时不要同时启用测量；视频动作会放慢以便观看：

```bash
ORBIT_BROWSER_VIDEO=1 ORBIT_BROWSER_OUTPUT=/tmp/conversation-demo pnpm --filter @zjunlp/orbit-web test:browser
```

输出目录包含 `results.json`、两类样本与窄屏截图；录制模式另有 `conversation-demo.webm`。失败时生成 `failure.png`。
测量、截图和视频保存在源码仓库外；常规回归与构建仍由 `pnpm verify` 执行，浏览器回归使用上述独立命令。
