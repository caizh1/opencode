# ChipMate Render Service 自动更新详细设计

## 背景与目标

ChipMate 当前通过本地 VSIX 交付，render service 已经提供 `/packages/<file>` 静态文件服务。本设计把 render service 的 packages 目录升级为内网自动更新源：运维只需要把新的 `chipmate-<version>.vsix` 放入 packages 目录，render service 自动暴露版本清单，ChipMate 扩展每天检查一次并提示用户是否升级。

目标：

- 不接入 Marketplace，不改变扩展身份、SecretStorage key、配置命名空间或用户数据路径。
- render service 自动生成 `/packages/manifest.json`，无需手写 manifest。
- ChipMate 只从配置的 render service 下载 VSIX，并校验版本、extension id、同源路径和 SHA256。
- 用户选择升级后自动下载并调用 VS Code 的 `workbench.extensions.installExtension` 安装 VSIX。
- 安装后沿用现有 `Reload Window` 提示，不调用 `restartExtension`。
- 用户选择“明天再说”或关闭提示后，同一版本 24 小时内不再提示；若出现更高版本，可以立即提示。

非目标：

- 不做强制升级、后台静默安装或自动 reload。
- 不分发 render service Docker 镜像自身的自动更新。
- 不把私有 render endpoint 或 provider/RAG endpoint 固化到 tracked source。

## 服务端清单协议

`server/chipmate-word-render` 暴露：

- `GET /packages/manifest.json`
- `GET /packages/<file>`

`/packages/manifest.json` 由服务端扫描 `PACKAGE_ROOT` 自动生成。服务端读取每个 `.vsix` 内部的 `extension/package.json`，只收录 `publisher.name` 等于 `UPDATE_EXTENSION_ID` 的包，默认 `UPDATE_EXTENSION_ID=local.chipmate`。版本比较使用与扩展侧一致的 SemVer/prerelease 规则，支持 `0.2.0-build.N`；最高版本进入 `latest`。

清单结构：

```json
{
  "ok": true,
  "schemaVersion": 1,
  "service": "chipmate-word-render",
  "generatedAt": "2026-07-03T00:00:00.000Z",
  "latest": {
    "extensionId": "local.chipmate",
    "publisher": "local",
    "name": "chipmate",
    "version": "0.2.0-build.27",
    "filename": "chipmate-0.2.0-build.27.vsix",
    "url": "/packages/chipmate-0.2.0-build.27.vsix",
    "sha256": "<64-char-hex>",
    "sizeBytes": 12345678,
    "mtimeMs": 1780000000000
  },
  "packages": []
}
```

下载接口继续做路径穿越保护，只允许读取 `PACKAGE_ROOT` 下的普通文件，并返回 `content-length` 与 `cache-control: no-store`。`/health` 的 `capabilities.autoUpdateManifest` 会暴露 manifest endpoint、package root 和 extension id，便于现场排查。

## 客户端状态机

新增设置：

- `chipmate.updates.enabled`：默认 `true`。
- `chipmate.updates.manifestUrl`：默认空；为空时从 `chipmate.wordRender.remoteEndpoint` 推导 `<render-base>/packages/manifest.json`。
- `chipmate.updates.checkIntervalHours`：默认 `24`，最小 `1`。
- `chipmate.updates.maxDownloadBytes`：默认 `536870912`。

新增 `globalState`：

- `chipmate.autoUpdate.lastCheckAt`
- `chipmate.autoUpdate.nextPromptAt`
- `chipmate.autoUpdate.declinedVersion`
- `chipmate.autoUpdate.installingVersion`

检查流程：

1. 扩展激活后延迟检查一次，之后按 `checkIntervalHours` 调度。
2. 如果自动更新关闭或无法推导 manifest URL，只记录 Output 并跳过。
3. 拉取 manifest，校验 `ok=true`、`schemaVersion=1`、`latest` 字段完整。
4. 校验 `latest.extensionId` 等于当前扩展 id，`latest.version` 高于当前运行版本，`latest.url` 与 manifest 同源且位于 `/packages/`，`latest.sha256` 是合法 SHA256。
5. 如果同一版本已被用户拒绝且未到 `nextPromptAt`，跳过。
6. 弹窗提示用户升级或明天再说。
7. 用户升级时下载 VSIX 到 `globalStorageUri/updates/`，校验大小和 SHA256 后执行安装命令。
8. 安装命令完成后重试读取 `vscode.extensions.getExtension(extensionId)?.packageJSON.version`，确认 VS Code 已看到目标版本。
9. 安装成功后调用现有 reload prompt controller，提示 `Reload Window`。

失败处理：

- manifest 拉取失败、结构不合法、版本不新、下载失败、SHA256 不匹配或安装后元数据未刷新，都不会阻断扩展激活。
- 自动更新失败只弹出“ChipMate 自动升级失败，请查看 ChipMate Output”，详细阶段和版本信息写入 `[auto-update]` 日志。
- 日志只记录安全化后的 manifest 路径、版本、文件名和错误摘要，不输出私有 endpoint 全量敏感参数。

## 安全边界

- 自动更新源必须是当前配置的 render service 或显式 `chipmate.updates.manifestUrl`。
- VSIX 下载 URL 必须与 manifest 同源，并位于 `/packages/` 下。
- 安装前必须校验 SHA256。
- 只升级相同 extension id，不接受其他 publisher/name。
- 不修改 `publisher`、`name`、配置 key、SecretStorage key 或 extension kind。
- 私有默认值仍只能通过忽略文件 `.chipmate-vsix-defaults.local.json` 在打包时注入，不能写入 tracked source。

## 运维使用方式

1. 用现有 `bun run vsix` 生成新的 `chipmate-<version>.vsix`。
2. 把 VSIX 放入 render service host 的 packages 目录，例如 `/opt/chipmate/packages`。
3. 确认 manifest：

```bash
curl -fsS http://<server-ip>:6001/packages/manifest.json
```

4. 确认 `latest.version` 是目标版本，`latest.extensionId` 是 `local.chipmate`。
5. 用户侧 ChipMate 会按配置检查；也可以重启 VS Code 触发激活后的延迟检查。

## 测试与验收

自动化覆盖：

- `test/render-package-manifest.test.ts`：临时 VSIX fixture、extension id 过滤、latest 排序、SHA256/size/url 输出。
- `test/extension-auto-update.test.ts`：endpoint 推导、manifest 校验、同源限制、SHA256 校验函数、24 小时拒绝抑制。
- `test/extension-version.test.ts`：build prerelease 和 stable release 排序。
- `test/connection-recovery.test.ts`：继续使用 `workbench.action.reloadWindow`，不引入 `restartExtension`。
- `test/manifest.test.ts`：自动更新配置项和 render server capability wiring。

交付前验证：

```bash
bun test
bun run compile
bun run package
```

需要真实 VS Code 验收时，再执行：

```bash
bun run vsix
```

然后把生成的 VSIX 放到 render service packages 目录，用真实 VS Code 安装态验证“发现新版 -> 升级 -> Reload Window”闭环。
