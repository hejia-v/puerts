# PuerTS Unity MCP Proxy

这个代理把链路从：

`Codex -> Unity MCP`

改成：

`Codex -> 本地 stdio 代理 -> Unity MCP`

代理当前只转发 `evalJsCode`，但会在 Unity 因 C# 编译触发 Domain Reload 后自动执行恢复流程：

- 调用 `GET /debug/wait-ready`
- 必要时调用 `POST /debug/reset`
- 重建 Unity MCP 上游连接
- 对可恢复错误自动重试

## 启动代理

在 `C:/Dev/puerts/unity/mcp_proj` 下执行：

```powershell
npm run proxy
```

## 一键回归

默认针对 `C:/Dev/BlockLoopShooter` 做完整验证：

```powershell
npm run proxy:verify
```

这个脚本会自动完成下面这些步骤：

- 连接代理并确认 `evalJsCode` 可用
- 在目标 Unity 工程里生成临时 smoke C# 文件
- 通过 `AssetDatabase.Refresh()` 触发真实编译和 Domain Reload
- 等待 Unity `/debug/wait-ready` 返回 ready
- 在同一个 MCP 客户端会话里再次调用 `evalJsCode`
- 校验新的 smoke marker 已生效
- 删除临时 smoke 文件并做一次清理刷新

## 可选参数

如果不是验证 `BlockLoopShooter`，可以改目标工程：

```powershell
node scripts/verify-puerts-unity-proxy.mjs --project C:/Path/To/YourUnityProject
```

也支持这些环境变量：

- `PUERTS_UNITY_BASE_URL`
  - 默认 `http://127.0.0.1:3100/mcp`
- `PUERTS_UNITY_TEST_PROJECT`
  - 默认 `C:/Dev/BlockLoopShooter`
- `PUERTS_UNITY_PROXY_NODE`
  - 默认当前执行脚本的 `node`
- `PUERTS_UNITY_VERIFY_WAIT_TIMEOUT_MS`
  - 默认 `60000`
- `PUERTS_UNITY_VERIFY_WAIT_POLL_MS`
  - 默认 `250`
- `PUERTS_UNITY_VERIFY_SETTLED_MS`
  - 默认 `8000`

## 前提

- Unity 侧 `PuertsEditorAssistant/MCP Server` 已启动
- Unity 包已经包含 `/health`、`/debug/editor-state`、`/debug/wait-ready`、`/debug/session`、`/debug/reset`
- Codex 项目级 MCP 配置已指向 `scripts/puerts-unity-proxy.mjs`
