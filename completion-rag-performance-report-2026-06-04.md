# Completion 可用性与 RAG 性能测试报告

测试时间：2026-06-04 19:33 +0800  
测试仓库：`/Users/archer/Work/opencode`  
测试扩展：`local.opencode-remote@0.0.115`  
VS Code：`1.123.0` `arm64`  
Bun：`1.3.14`  
Git HEAD：`62a199c10`  

说明：本报告只使用当前机器、当前 VS Code 用户 profile、当前 globalStorage 和当前日志中的证据。未清空用户 globalStorage，未卸载扩展，未修改用户 settings 或 SecretStorage。

## 1. 当前配置快照

| 项 | 值 |
|---|---|
| Completion enabled | `true` |
| Completion provider | `openai-compatible` |
| Completion profile | `generic-chat` |
| Completion API base | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| Completion model | `qwen3-coder-next` |
| OpenCode server | `http://localhost:13002` |
| RAG embedding endpoint | `http://localhost:1234/v1/embeddings` |
| RAG embedding model | `text-embedding-bge-reranker-v2-m3` |
| RAG embedding batchSize | `512` |
| RAG embedding concurrentRequests | `1` |
| RAG encodingFormat | `auto`, effective logs show `base64` |
| RAG rerank endpoint | `http://localhost:1235/v1/rerank` |
| RAG rerank model | `bge-reranker-v2-m3-Q8_0` |
| RAG allowedHosts | includes `dashscope.aliyuncs.com` |

## 2. 自动化基线

| 命令 | 结果 |
|---|---:|
| `bun test` | 通过，392 pass / 0 fail |
| `bun run lint` | 通过 |
| `bun run compile` | 通过 |
| `bun run package` | 通过 |
| `bun run test:vscode` | 通过，VS Code 1.123.0 extension host 激活和命令注册正常 |

Completion 关键回归测试已覆盖并通过：

| 场景 | 自动化结果 |
|---|---|
| `unit test for epr_ppn_raw_wr` | 解析到 `epr_ppn_raw_write_with_cb_dfx`，不展示 echoed prefix |
| `// unit test for epr_ppn_raw_write_cb_dfx()` | comment-to-test 插入到下一行，不重复注释 |
| 普通代码补全 | router 走 Qwen FIM 路径 |
| 高置信 symbol completion | deterministic resolver，不调用模型 |
| 行中 suffix overlap | 不重复 `);` |

## 3. Completion 真实 profile 观测

真实 VS Code `OpenCode Remote` 日志里只观察到当前配置组合：`openai-compatible + generic-chat + qwen3-coder-next`。没有修改用户配置去切换 `qwen-coder-fim` 或 `opencode` provider。

### 3.1 真实日志统计

来源：`~/Library/Application Support/Code/logs/**/1-OpenCode Remote.log`

| 指标 | 数值 |
|---|---:|
| completion requestId 数 | 7 |
| triggered | 7 |
| scheduled | 7 |
| sent | 3 |
| received | 0 |
| edit-ready | 0 |
| returned / ghost text | 0 |
| cancelled | 10 |
| failed | 2 |
| sent / triggered | 42.9% |
| returned / triggered | 0% |
| failed / sent | 66.7% |
| elapsed 样本 P50 / P95 / P99 | 28ms / 564ms / 564ms |

### 3.2 主要失败原因

| 原因 | 次数 | 说明 |
|---|---:|---|
| `vscode-token` | 5 | 用户继续输入或 VS Code 取消 inline request |
| `stale-key` | 5 | 新请求替换旧请求 |
| `404 model_not_supported` | 2 | DashScope compatible endpoint 返回：`Unsupported model qwen3-coder-next for OpenAI compatibility mode` |

结论：当前 profile 下 completion pipeline 可以触发、调度和发请求，但没有任何可用 ghost text。直接原因是当前配置的 `qwen3-coder-next` 被 OpenAI compatibility endpoint 拒绝，导致模型响应失败。自动化测试证明本地 completion pipeline 的 planner/router/postprocess/edit 逻辑是好的，但真实可用性被模型配置挡住了。

## 4. CodeGraph 合成性能基线

| files | mode | parseMs | indexMs | files/s | peakHeap | shards | query P50 | query P95 | query P99 | incrementalMs | recoveryMs |
|---:|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1,000 | full-index | 44 | 37 | 12,345.7 | 17.2MB | 4 | 3ms | 7ms | 7ms | 32 | 29 |
| 10,000 | full-index | 388 | 382 | 12,987.0 | 158.6MB | 40 | 36ms | 75ms | 75ms | 350 | 346 |
| 100,000 | full-index | 4,855 | 4,820 | 10,335.9 | 1.26GB | 400 | 597ms | 830ms | 830ms | 4,357 | 4,374 |

结论：纯本地 codegraph parser/indexer 在合成数据上吞吐稳定，100k 文件仍能在约 9.7 秒 parse+index 完成；query P95 到 830ms，主要随索引规模上升。

## 5. 真实 globalStorage 索引状态

### 5.1 `/Users/archer/Work/opencode`

| 指标 | 数值 |
|---|---:|
| codegraph files | 3 |
| functions | 7 |
| source bytes | 484 |
| codegraph shards | 2 |
| manifest size | 20,838 bytes |
| RAG chunks | 15 / 15 |
| RAG state | `ready` |
| RAG buildElapsedMs | 1,494ms |
| RAG chunks/min | 602.4 |
| RAG size | 76KB |

注意：该 RAG manifest 显示 extensionVersion 为 `0.0.114`，当前安装扩展为 `0.0.115`。小索引仍为 ready，但跨版本 partial resume 风险应以当前代码策略处理。

### 5.2 `/Users/archer/Work/qemu`

| 指标 | 数值 |
|---|---:|
| codegraph files | 6,810 |
| functions | 68,846 |
| macros | 84,522 |
| types | 17,971 |
| globals | 10,122 |
| source bytes | 77,527,481 |
| codegraph shards | 277 |
| codegraph shard size | 199MB |
| manifest size | 370,598,511 bytes |
| total index dir size | 678MB |
| RAG meta/vector shards | 94 / 94 |
| RAG size | 125MB |
| RAG vector bytes | 107,057,152 |

历史日志中该大索引的 load 时间有明显波动：

| loaded sharded index | 时间 |
|---|---:|
| best observed | 513ms |
| common observed | 558ms / 2,527ms / 2,771ms / 3,673ms / 5,118ms |
| worst observed | 11,802ms |

## 6. 真实 RAG 建立性能

qemu RAG 当前最终状态：

| 指标 | 数值 |
|---|---:|
| state / availability | `paused` / `paused` |
| paused reason | provider error |
| chunks | 31,612 / 85,839 |
| pending | 54,227 |
| buildElapsedMs | 1,326,906ms |
| elapsed | 22.1 min |
| chunks/min | 1,429.4 |
| estimated remaining | 37.9 min |
| configuredWorkers | 1 |
| active/max workers | 2 / 2 |
| effectiveConcurrency | 1.85 |
| request limit | 91 / 100 used when paused |

RAG summary 日志：

| 指标 | 数值 |
|---|---:|
| requestSecTotal | 2,457.51s |
| requestSecP50 | 27.91s |
| requestSecP95 | 41.75s |
| responseBytesTotal | 984,435,795 |
| retries | 0 |
| rateLimits | 0 |
| timeouts | 0 |
| chunksPerMin | 1,429.4 |

关键日志事件：

| 事件 | 证据 |
|---|---|
| batch 89 成功 | `inputCount=329`, `embeddingRequestSec=45.45`, `responseBytes=10,242,773` |
| batch 90 成功 | `inputCount=316`, `embeddingRequestSec=36.82`, `responseBytes=9,839,944` |
| batch 91 暂停 | `provider error: fetch failed`, `batchStatus=paused` |
| final summary | `embedded 31612/85839 chunk(s)`, `paused=provider-error` |
| auto resume | `auto resume skipped reason=provider-error` |

本地服务探测：

| 探测 | 结果 |
|---|---|
| rerank POST 最小请求 | HTTP 200，约 53.9ms |
| embedding POST 两个短输入，20s timeout | 超时，无响应 |
| OpenCode `/health` GET | HTTP 200，但返回 HTML app shell，不是 JSON health |

结论：RAG 建立主要瓶颈在 embedding provider 请求耗时和 provider 稳定性。扩展侧批处理、checkpoint、base64 normalize 和 rerank 都有日志证据；本轮没有 429、503、timeout 计数，但出现了 `fetch failed`，并且 provider-error 不自动恢复。

## 7. 真实 Local Analysis Bridge 查询性能

Bridge 文件存在：

| workspace | endpoint | 状态 |
|---|---|---|
| opencode | `http://127.0.0.1:55407` | 端口不可达，可能是旧窗口生成的 stale tool |
| qemu | `http://127.0.0.1:64707` | 可用 |

qemu bridge 实测：

| 查询 | 结果 |
|---|---:|
| `getSymbol monitor_printf` | HTTP 200，92ms，1 条 evidence，文件 `monitor/monitor.c` |
| `queryEvidence who calls monitor_printf` | HTTP 200，11,618ms，40 条 evidence，响应体 146,715,217 bytes |
| 日志中两次 `queryEvidence` | 24,413ms 和 22,693ms，均 evidence=40 |

结论：符号级精确查询很快，hybrid `queryEvidence` 在 qemu 大仓下返回体异常大，达到 146MB，即使 evidence 数量只有 40。这会显著拖慢查询、Bridge、OpenCode tool 调用和模型前置 evidence 阶段。需要重点检查 `queryEvidence` tool 返回结构是否包含了过大的 data/snapshot/trace 内容，或 evidence budget 是否没有作用到整个 JSON response。

## 8. 重点结论

1. Completion 当前不可用不是 pipeline 失败，而是模型配置失败。`qwen3-coder-next` 被当前 DashScope OpenAI compatibility endpoint 拒绝，真实日志中 ghost text 成功率为 0%。
2. Completion 本地质量保护通过自动化验证。echoed prefix、重复注释、suffix overlap、deterministic symbol completion、comment-to-test 路由均已有测试通过。
3. CodeGraph 本地索引性能健康。100k synthetic parse+index 约 9.7s，吞吐约 10k files/s。
4. qemu 大仓 RAG 建立可推进，但 embedding 请求慢且最终 provider-error 暂停。当前 31,612 / 85,839 chunks，约 22.1 分钟完成 36.8%，估算剩余约 38 分钟。
5. RAG embedding 的请求耗时是主要瓶颈。日志 P50/P95 为 27.91s/41.75s，单 batch 响应约 10MB，累计响应约 984MB。
6. `queryEvidence` 在大仓下响应体过大。一次 40 条 evidence 的查询返回 146MB，这是当前 RAG 查询性能最明显的风险点。
7. opencode workspace 的 `.opencode/tools` bridge endpoint 已 stale；qemu bridge endpoint 可用。生成 tool 文件不能单独证明对应 VS Code 窗口仍在。

## 9. 建议下一步

1. 先修正 completion 模型配置。选择当前 endpoint 支持的 OpenAI-compatible 模型，或切换到支持 raw `/v1/completions` 的 `qwen-coder-fim` 配置后重新观察 ghost text。
2. Completion 复测时至少记录 20 次停顿输入，而不是快速连续输入；快速输入会主要产生 `vscode-token` 和 `stale-key` 取消。
3. 对 RAG embedding，优先验证 batchSize `128` 或 `256` 是否比 `512` 更稳定。当前 token cap 已把 512 拆到约 300 到 450 输入，但 provider 仍有 28 到 45 秒请求。
4. provider-error 应考虑作为可恢复暂停加入自动 resume，或在 UI 中明确提示需要手动 resume。
5. 优先收敛 `queryEvidence` 返回体。目标是 40 条 evidence 响应保持在 `analysis.maxEvidenceBytes` 量级，而不是 100MB 级。
6. qemu manifest 已达 370MB，且 load 时间最差 11.8s。建议继续推进 derived/index manifest 分片化，避免大 JSON manifest 成为冷启动瓶颈。

## 10. 已执行命令

```bash
bun test
bun run lint
bun run compile
bun run package
bun run test:vscode
bun run benchmark:codegraph -- --files=1000
bun run benchmark:codegraph -- --files=10000
bun run benchmark:codegraph -- --files=100000
```

