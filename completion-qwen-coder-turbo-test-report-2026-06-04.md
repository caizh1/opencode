# qwen-coder-turbo Completion 全场景测试报告

测试时间：2026-06-04  
测试机器/profile：当前 macOS 用户的 VS Code 默认 profile  
扩展：`local.opencode-remote@0.0.115`  
Workspace：`/Users/archer/Work/opencode`

## 结论摘要

`qwen-coder-turbo` 这次已经确认支持两条必要 API：

- 普通代码 FIM：`POST https://dashscope.aliyuncs.com/compatible-mode/v1/completions`
- 指令类补全：`POST https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions`

因此，旧模型失败时的核心原因“模型不支持 `/completions` FIM”在 `qwen-coder-turbo` 上不成立。当前主要问题转为 completion pipeline 的产品质量边界：

1. 普通 FIM API 可用，但模型在行中 suffix 场景容易回显 `);`、输出 Markdown fence 或解释文字，当前清洗不够严，可能形成坏 ghost code。
2. 注释转代码识别太窄，`// validate input before saving`、`// 解析请求并返回错误码`、`# sort users by score` 没有走 instruction route，而是误走 FIM/symbol path。
3. 低质量输入 `t` 仍会请求 FIM，并真实产生无关 JSON ghost code。
4. 字符串内部会请求 FIM，并可能生成破坏字符串/语句的 ghost code。
5. 真实 VS Code UI 自动补证已经捕获到普通 FIM 和 instruction 场景；其中 `return |;` 真实生成了坏 ghost code，低信号输入和字符串上下文也会真实发起请求，需要优先修复 gating 与 suffix 安全。

## 当前配置

| 项目 | 值 |
| --- | --- |
| provider | `openai-compatible` |
| model | `qwen-coder-turbo` |
| profile | `generic-chat` |
| apiBaseUrl | `https://dashscope.aliyuncs.com/compatible-mode/v1` |
| maxTokens | `128` |
| temperature | `0.2` |
| topP | `0.8` |
| completion enabled | `true` |

注意：虽然 settings 中 profile 是 `generic-chat`，代码路由会强制普通代码走 Qwen FIM profile：

| 场景 | plan/route | API |
| --- | --- | --- |
| ordinary-code | `qwen-fim` | `/completions` |
| low-confidence symbol assist | `qwen-fim` | `/completions` |
| natural-command | `instruction` | `/chat/completions` |
| comment-to-test | `instruction` | `/chat/completions` |
| comment-to-code | `instruction` | `/chat/completions` |
| high-confidence symbol | `deterministic-symbol` | 不调用模型 |

## API 预检

| API | 状态 | 延迟 | 观察 |
| --- | ---: | ---: | --- |
| `/chat/completions` | 200 | 976ms | 返回可用，但样例输出带 Markdown fence，需要清洗 |
| `/completions` FIM | 200 | 454ms | 返回 `return a + b;`，FIM token 路径可用 |

报告和命令输出均未写入 API key。

## 自动化基线

| 命令 | 结果 |
| --- | --- |
| `bun test` | 通过，392 pass / 0 fail |
| `bun run lint` | 通过 |
| `bun run compile` | 通过 |
| `bun run package` | 通过 |
| `bun run test:vscode` | 通过，VS Code 1.123.0 extension host exit 0 |

## 矩阵 Harness 结果

执行方式：用真实 `qwen-coder-turbo` API 输出，串联当前编译产物中的 `planCompletion -> routeCompletionModel -> completionInsertText -> postprocessCompletion -> buildInlineCompletionEditResult`。未自动操控 VS Code UI，因此 `ghost text shown` 用是否生成有效 inline edit 近似表示；最终仍需要在 VS Code 手测确认。

| 路径 | 场景数 | 模型请求 | HTTP 成功 | 生成 edit | 拒绝/无 edit | P50 | P95 | 最大 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| FIM `/completions` | 15 | 15 | 15 | 9 | 6 | 819ms | 2799ms | 3277ms |
| instruction `/chat/completions` | 2 | 2 | 2 | 2 | 0 | 2969ms | 2969ms | 4198ms |
| deterministic symbol | 3 | 0 | 0 | 3 | 0 | 0ms | 0ms | 0ms |
| disabled/skip | 2 | 0 | 0 | 0 | 2 | - | - | - |

## 关键样例

| 场景 | 输入 | plan | route/API | 结果 |
| --- | --- | --- | --- | --- |
| C block | `if (ret != 0) {|` | ordinary-code | FIM `/completions` | 成功，插入换行和缩进后的 `printf`/`return` |
| TS method | `value.|` | ordinary-code | FIM `/completions` | 成功，`toLowerCase().trim();` |
| Python return | `return |` | ordinary-code | FIM `/completions` | 成功，`users[:5]` |
| deterministic | `epr_ppn_raw_wr|` | symbol-completion | none | 成功，本地替换为 `epr_ppn_raw_write_with_cb_dfx` |
| deterministic | `monitor_pri|` | symbol-completion | none | 成功，本地替换为 `monitor_printf` |
| deterministic | `object_get_|` | symbol-completion | none | 成功，本地替换为 `object_get_canonical_path` |
| current word | `retu|` | symbol-completion | FIM `/completions` | 模型返回 `rn 0;`，被拒绝，无坏 ghost |
| suffix call | `foo(|);` | ordinary-code | FIM `/completions` | 失败，模型输出 `);`、Markdown fence 和解释，最终可能形成 `foo(););` |
| suffix condition | `if (|) {}` | ordinary-code | FIM `/completions` | 安全拒绝，未生成 edit |
| suffix return | `return |;` | ordinary-code | FIM `/completions` | 有 edit，但接受后可能出现 `return ret + 10;;` |
| suffix array | `arr[|];` | ordinary-code | FIM `/completions` | 安全拒绝，未生成 edit |
| column 0 empty | `|` | disabled | none | 跳过，符合当前规则 |
| indented empty | `    |` | disabled | none | 跳过；与“函数体空行可补全”的期望不一致 |
| comment-to-code | `// validate input before saving|` | symbol-completion | FIM `/completions` | 误路由，应走 instruction；最终无 edit |
| comment-to-code | `// 解析请求并返回错误码|` | ordinary-code | FIM `/completions` | 误路由，应走 instruction；生成了 `return 0;` |
| comment-to-code | `# sort users by score|` | symbol-completion | FIM `/completions` | 误路由，应走 instruction；最终无 edit |
| natural unit test | `unit test for epr_ppn_raw_wr|` | natural-command | chat `/chat/completions` | 成功替换整行；Markdown fence 被清洗，但内容有占位参数 |
| comment-to-test | `// unit test for epr_ppn_raw_write_cb_dfx()|` | comment-to-test | chat `/chat/completions` | 成功插入下一行；Markdown fence 被清洗，但内容有 `...` 占位 |
| short input | `t|` | ordinary-code | FIM `/completions` | 失败，生成无关 `tsconfig.json` JSON 片段 |
| punctuation | `;|` | ordinary-code | FIM `/completions` | 发了请求，但最终因 misaligned leading newline 拒绝 |
| string | `const title = "hello |";` | ordinary-code | FIM `/completions` | 失败，可能接受为 `const title = "hello world!";";` |
| macro | `#define MAX_VALUE(|)` | ordinary-code | FIM `/completions` | 基本可用，但需要继续验证括号完整性 |

## 真实 VS Code 日志观察

从 `~/Library/Application Support/Code/logs/.../OpenCode Remote.log` 搜索 `qwen-coder-turbo`：

| 事件 | 次数 |
| --- | ---: |
| triggered | 2 |
| scheduled | 1 |
| deterministic-symbol | 1 |
| edit-ready | 1 |
| returned | 2 |

关键样例：

```text
[completion] deterministic-symbol reason=high-confidence-symbol ... model="qwen-coder-turbo" requestId=cc-mpzfz4ye-vb7uj1
[completion] edit-ready range=79:4-79:7 filterText="testdev_eat_packet" firstLine="testdev_eat_packet" ... elapsedMs=455 chars=18
[completion] returned source=remote range=79:4-79:7 filterText="testdev_eat_packet" ... elapsedMs=455 chars=18
[completion] returned source=cache range=79:4-79:7 filterText="testdev_eat_packet" ... elapsedMs=0 chars=18
```

这证明 deterministic symbol ghost code 在真实 VS Code profile 中可用。随后用同一个真实 profile 打开 `/tmp/opencode-completion-probe` 做了自动 UI 补证，已经捕获到普通 FIM 与 instruction 场景，见下一节。

## 真实 VS Code UI 自动补证

执行环境：当前 VS Code 1.123.0、当前默认 profile/settings/API key、扩展 `local.opencode-remote@0.0.115`。为避免修改仓库文件，所有 probe 文件都放在 `/tmp/opencode-completion-probe`，截图也保存在同一目录。

自动化限制：命令面板触发不稳定后改用 `Option+\` 触发 inline suggestion；当前键盘布局会在编辑器里插入 `«`，因此“接受后最终文件”证据被污染。本节以 OpenCode Remote 日志和 ghost 截图为准，不把带 `«` 的接受结果当成模型输出。另有部分请求先出现 `cancelled reason=vscode-token`，随后仍 `received/edit-ready`，这应单独归类为 VS Code token churn，不等同模型失败。

| 场景 | requestId | sent/received | ghost/结果 | 判定 |
| --- | --- | --- | --- | --- |
| `value.\|` | `cc-mpzgts9w-wv7mzx` | 是 / 1214ms | `edit-rejected reason=misaligned-leading-newline` | 普通 FIM 真实发请求，但无可用 ghost |
| `foo(\|);` | `cc-mpzh2b4q-yd08d7` | 是 / 915ms | `edit-rejected reason=misaligned-leading-newline`，前一次偏移触发为空输出 | UI 层本轮挡住坏 ghost；仍需 fixture 覆盖 suffix/fence 输出 |
| `return \|;` | `cc-mpzh37u5-opr19d` | 是 / 874ms | `edit-ready range=3:12-3:12 filterText=";\n}" firstLine=";"` | P0：真实坏 ghost，会在 `return ;` 前建议额外 `;`/`}` |
| `// validate input before saving\|` | `cc-mpzhbemb-d4kdb8` | 是 / 931ms | `empty reason=empty-output` | P1：UI 确认没有可用补全；结合 harness 判定为 comment intent 误路由 |
| `t\|` | `cc-mpzhbm38-aqna2f` | 是 / 897ms | `empty reason=empty-output` | P0：本轮未显示无关 ghost，但低信号输入仍不该请求模型 |
| `"hello \|"` | `cc-mpzhbtk5-27c9ei` | 已发送 / 848ms 失败 | `Completion model response has no completion text` | P0：字符串上下文仍会请求模型，应保守 skip |
| `unit test for epr_ppn_raw_wr\|` | `cc-mpzhc11q-982qwn` | 是 / 2503ms | `edit-ready firstLine="void test_epr_ppn_raw_wr() {"`，chars=239 | instruction ghost 可显示；临时 workspace 无项目 symbol context，不能用来判 resolver 泛化 |
| `// unit test for epr_ppn_raw_write_cb_dfx()\|` | `cc-mpzhc8j4-gbcci7` | 是 / 2022ms | `edit-ready`，首行为空，下一行生成 `void test_epr_ppn_raw_write_cb_dfx(void) {`，未重复注释 | comment-to-test UI 表现基本正确，但内容仍偏模板化 |

关键日志摘要：

```text
[completion] sent path="return.c" line=3 character=12 ... requestId=cc-mpzh37u5-opr19d
[completion] received path="return.c" line=3 character=12 ... elapsedMs=874
[completion] edit-ready range=3:12-3:12 filterText=";\n}" firstLine=";" ... chars=3

[completion] sent path="short.ts" line=1 character=3 ... requestId=cc-mpzhbm38-aqna2f
[completion] received path="short.ts" line=1 character=3 ... elapsedMs=897
[completion] empty reason=empty-output ... elapsedMs=898

[completion] sent path="string.ts" line=1 character=22 ... requestId=cc-mpzhbtk5-27c9ei
[completion] Completion failed: Completion model response has no completion text ... elapsedMs=848
```

UI 补证结论：此前 harness 暴露的问题不是纯测试假阳性。真实 VS Code profile 下至少 `return |;` 已能复现坏 ghost；`t|` 和字符串中补全虽然本轮没有显示 ghost，但仍实际请求模型，属于 gating 缺口；`// unit test ...` 的 comment-to-test ghost 真实可显示且未重复注释。

## 失败分类

| 类型 | 样例 | 影响 |
| --- | --- | --- |
| comment intent 误路由 | `validate`、中文解析、`sort users` | 应走 chat instruction，却走 FIM/symbol，导致无补全或随意代码 |
| suffix 重复 | `foo(|);`、`return |;` | 可能显示/接受后出现 `););`、`;;` |
| Markdown/解释泄漏 | `foo(|);` FIM 输出 | 当前 postprocess 没完全兜住多个 fence/解释段 |
| 低信号输入误触发 | `t|` | 生成大段无关 JSON，属于红线 |
| 字符串中误触发 | `"hello |"` | 破坏字符串与语句结构 |
| 块内空行不可用 | indented empty line | 当前 planner 直接 disabled，和测试目标不一致 |
| current-word assist 质量低 | `retu|` | 被安全拒绝，但没有给出可用 `return` |

## 建议修复优先级

1. **P0：行中 suffix 安全**  
   对非空 `lineSuffix` 增加更强清洗/拒绝：去掉 leading suffix echo，限制首行补全，避免 `););`、`;;`、`]`/`}` 重复；FIM 输出含 Markdown fence 或解释残留时直接拒绝。

2. **P0：低信号输入 gating**  
   `t`、`re`、只有标点、只有分隔符时不请求模型，除非处在明确语法上下文或 deterministic symbol 高置信命中。

3. **P0：字符串上下文 gating**  
   至少对同一行未闭合字符串做保守 skip，避免把代码补到字符串里。

4. **P1：comment-to-code planner 扩展**  
   扩展英文动词 `validate/parse/sort/filter/handle/check/convert/save/load`，并支持中文命令动词 `解析/校验/验证/返回/排序/处理/保存/读取/生成/实现/写`。这类注释必须走 instruction route，不走普通 FIM。

5. **P1：空行策略拆分**  
   column 0 空行继续 skip；函数体/块内缩进空行可按上下文触发普通 FIM，或至少给明确 telemetry reason，避免“无声不可用”。

6. **P1：新增 qwen-coder-turbo fixture**  
   把本轮真实输出形态固化为测试：`foo(|);` fence+解释、`return |;` 分号重复、`t|` JSON、comment intent 三例、string context 一例。

## 下一轮手测清单

在真实 VS Code profile 中开启 `opencode.remote.completion.logLevel=debug` 后，至少补跑这些 UI 场景，每个停顿触发 5 次：

1. `value.|`：应走 `/completions`，显示可接受方法链。
2. `foo(|);`：不得出现 `););`，不得含 Markdown/解释。
3. `return |;`：不得出现 `;;`。
4. `// validate input before saving|`：应走 `/chat/completions`，插入注释下一行。
5. `// 解析请求并返回错误码|`：应走 `/chat/completions`。
6. `t|`、`re|`、`;|`：应 skip 或安全无 ghost，不应请求/显示大段代码。
7. `"hello |"`：应 skip 或只补字符串文本，不应插入代码语句。
8. `unit test for epr_ppn_raw_wr|`：替换整行，不重复命令，不输出解释。
9. `// unit test for epr_ppn_raw_write_cb_dfx()|`：插入下一行，不重复注释。
10. `epr_ppn_raw_wr|`、`monitor_pri|`、`object_get_|`：deterministic，不调用模型。
