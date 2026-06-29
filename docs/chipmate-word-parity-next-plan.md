# ChipMate 通用 Word Parity 下一步计划

日期：2026-06-28

## 结论

接下来最适合优先做这三项：

1. 视觉 QA 闭环
2. preset/header 丰富度
3. direct helper fallback

优先级应按上述顺序执行。原因是：视觉 QA 闭环最直接影响用户感知的“Codex 文档生成质量”；preset/header 决定新建文档的版式多样性和专业感；direct helper fallback 主要是边角能力和扩展性补强，应放在核心可用版稳定之后。

## 目标范围

目标是让 ChipMate 在离线环境中具备接近 Codex 的通用本地 Word `.docx` 生成、编辑、审阅、渲染和质量检查能力。

当前目标不包括：

- Google Drive 导入。
- native Google Docs 输出。
- 为“芯片详细设计文档”单独实现一套 Word 生成流水线。
- 移除现有通用 draw.io / Mermaid / diagram 能力。
- 将私有 provider、私有 endpoint 或本地打包默认值写入源码。

详细设计文档能力后续应作为独立 skill 使用通用 Word 能力，而不是绕过通用 Word 工具再做一套特定流水线。

## 执行原则

- 模型负责文档意图：受众、文档类型、内容结构、章节顺序、form factor、preset、header pattern、修订策略和最终取舍。
- 工具负责确定性执行：读取 `.docx`、生成 `.docx`、应用 locator-based edits、写入 Word 结构、渲染 PDF/PNG、产出质量证据。
- 不为了单个文档场景写死业务逻辑。
- 不把详细设计文档需求混入通用 Word pipeline。
- 所有新增能力必须保持本地离线可运行，不依赖在线渲染服务。
- 能 fail closed 的地方不要静默降级；若视觉 QA、字段刷新或 helper fallback 不可用，最终回答必须明确说明。

## 执行进度

- 状态：已完成。
- Checklist：79/79 已完成，0 项剩余。
- 最终验证：`bun run compile`、`bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/chat-html.test.ts test/manifest.test.ts test/skills-permissions.test.ts`、`bun run package` 均已通过。
- VSIX：本轮未要求 VS Code 手装实测，未执行 `bun run vsix`，因此未 bump VSIX；已执行源码私有 provider/RAG 字符串扫描，结果无匹配。
- 本机渲染依赖：`soffice` 和 `pdftoppm` 均可用；Word render 相关测试已通过。
- 最新对齐矩阵：`docs/chipmate-word-parity-matrix-no-google-docs.md`。

## P0：视觉 QA 闭环

### 目标

把当前“能渲染 Word 并展示 PNG artifact”的能力升级为“生成/编辑后自动形成可审计的视觉 QA 闭环”，尽量对齐 Codex 的 render -> inspect PNGs -> iterate 工作方式。

### 当前差距

ChipMate 当前已经能：

- 使用 `render_word_document` 渲染本地 `.docx`。
- 生成 PDF 和 page PNG artifact。
- 在聊天 UI 中展示页面 PNG 预览。
- 生成 page visual summaries。

但还没有完全做到：

- 模型在生成/编辑后稳定进入视觉复核步骤。
- 模型基于渲染页面证据主动判断是否需要修正文档。
- 对明显分页、裁剪、表格溢出、空白页、边缘墨迹等问题形成“修复 -> 重渲染 -> 再检查”的受控循环。
- 在 provider 不支持图像输入时，清楚地区分“自动视觉摘要检查”和“模型逐页看图检查”。

### 设计

新增 Word Visual QA Loop，作为通用 documents skill 的运行协议，而不是新建业务流水线。

建议引入结构化概念：

```ts
type WordVisualQaVerdict = {
  status: "pass" | "needs-fix" | "blocked";
  inspectedPages: number[];
  evidence: Array<{
    page: number;
    kind: "page-png" | "visual-summary" | "render-warning";
    path?: string;
    finding: string;
    severity: "info" | "warning" | "error";
  }>;
  fixes?: Array<{
    target: "content" | "layout" | "table" | "figure" | "header-footer" | "field" | "unknown";
    action: string;
  }>;
  limitations: string[];
};
```

### 实施步骤

- [x] 在 documents skill 中明确：新建文档、重大改写、版式相关编辑后必须调用 `render_word_document` 或读取 `create_word_document` / `apply_word_document_edits` 返回的 render result。
- [x] 在 direct agent 层增加 Word render artifact 后处理：当工具返回 page PNG 和 visual summaries 时，生成 bounded QA context。
- [x] 如果当前 provider 支持图像输入，则把 page PNG 作为视觉上下文交给模型复核。
- [x] 如果当前 provider 不支持图像输入，则只使用 visual summaries 和结构化 warnings，不声称“模型逐页看图通过”。
- [x] 增加最大迭代次数，建议默认 2 次，防止文档生成陷入无限修复循环。
- [x] 当视觉 QA 发现可修复问题时，要求模型走现有通用路径：`inspect_word_document` -> `apply_word_document_edits` -> 重新 render。
- [x] 当问题来自新建文档整体布局且 locator edit 不合适时，允许重新调用 `create_word_document` 生成新版 `.docx`，但必须保留最终 artifact 和 warnings。
- [x] 在 final response 中只交付最终 `.docx` 路径和必要 warning；除非用户要求，不暴露所有中间 PNG。

### UI/体验补强

- [x] 保留现有 Word render card。
- [x] 为多页文档增加更清晰的 page preview 状态：已渲染、未完成视觉渲染、有风险。
- [x] 支持打开首个 PNG、打开 PDF、显示 artifact。
- [x] 后续可增加“打开全部页面预览”的轻量 viewer，但这不是 P0 必须项。（已确认本轮非必须项，保留为后续增强。）

### 测试计划

- [x] 新增/更新 `test/direct-agent-client.test.ts`：确认 Word render artifact 会进入 assistant parts，并能被后续上下文识别。
- [x] 新增/更新 `test/chat-html.test.ts`：确认 wordRender card、PNG preview、warnings 正常渲染。
- [x] 新增/更新 `test/doc-agent.test.ts`：构造空白页、表格溢出、缺 alt text、缺 repeated header 等风险时，render result 有结构化 warning。
- [x] 增加 provider 不支持图像输入的测试：最终状态必须是“自动视觉摘要/结构检查”，不能说“逐页视觉检查通过”。
- [x] 增加最大迭代次数测试，防止重复 render/edit 死循环。

### 验收标准

- [x] 普通新建 `.docx` 请求会生成 Word、渲染 PDF/PNG、形成 QA verdict。
- [x] 版式风险会被模型披露或触发修复。
- [x] 若渲染依赖缺失，最终回答明确说明视觉 QA 未完成。
- [x] 若 provider 不支持图像输入，最终回答不冒充 Codex 式逐页视觉检查。

## P1：preset/header 丰富度

### 目标

补齐 Codex documents skill 中设计 preset、archetype alias 和 header pattern 的表达力，使 ChipMate 新建文档不只是“能生成”，而是能按文档类型生成更自然、更专业的版式。

### 当前差距

ChipMate 当前已有 4 个核心 preset：

- `google_docs_default`
- `standard_business_brief`
- `compact_reference_guide`
- `narrative_proposal`

但还需要补强：

- archetype alias 的精细 token 覆盖。
- first-page header pattern。
- header/footer/page furniture 的可配置选择。
- preset audit 对 token 精确落地的检查。

### 设计

建议新增或扩展：

```ts
type WordPresetAlias =
  | "rfi_response"
  | "decision_memo"
  | "launch_messaging_guide"
  | "contract_negotiation_brief"
  | "neighborhood_business_proposal"
  | "grant_proposal";

type WordHeaderPattern =
  | "none"
  | "memo_masthead"
  | "proposal_centerpiece"
  | "editorial_cover"
  | "customer_pack"
  | "workshop_agenda"
  | "customer_story";
```

`WordDocLayoutSpec` 可扩展：

```ts
layout: {
  preset: WordDesignPreset;
  presetAlias?: WordPresetAlias;
  headerPattern?: WordHeaderPattern;
  overrides?: Array<{
    role: string;
    reason: string;
    tokenChanges: Record<string, unknown>;
  }>;
}
```

### 实施步骤

- [x] 把 preset token 从当前 theme resolver 扩展为显式 token map，覆盖 page、margin、body、headings、lists、tables、callouts、headers、footers。
- [x] 增加 preset alias 到 base preset 的映射，并写入 alias-specific token overrides。
- [x] 增加 header pattern 数据结构，先支持 6 个 Codex 同类 pattern。
- [x] 在 `WordDocBuilder` 中实现 first-page header/title block 渲染。
- [x] 确保 `google_docs_default` 保持简单，不引入复杂 header furniture。
- [x] 更新 documents skill：要求模型在新建文档/重大重写时选择一个 preset；非 Google Docs 本地 Word 文档可以选择 header pattern。
- [x] 增加 style/preset audit：检查 page geometry、heading spacing、list indent、table width、header/footer 是否符合 token。

### 测试计划

- [x] 每个 base preset 生成一个 fixture，解包检查 `styles.xml`、`numbering.xml`、`document.xml` 的关键 token。
- [x] 每个 header pattern 至少有一个 smoke test，确认标题、metadata、header/footer、section properties 写入正确。
- [x] alias test：输入 alias 后应映射到正确 base preset 和 overrides。
- [x] Google Docs preset test：不应出现复杂 first-page furniture 或 title underline/border。
- [x] render smoke test：生成的文档能通过 render，不出现空白页或明显溢出 warning。

### 验收标准

- [x] 模型可以基于文档类型选择不同 preset/header pattern。
- [x] 生成的 `.docx` 不是单一模板感。
- [x] preset token 有可测试、可审计的落地结果。
- [x] header pattern 不影响已有编辑文档的最小改动原则。

## P2：direct helper fallback

### 目标

在 native tool 无法覆盖边角 Word 操作时，提供受控的 helper script fallback，接近 Codex “必要时可跑 bundled helper script” 的灵活性，同时保持 VS Code 扩展安全边界。

### 当前差距

ChipMate 当前已经把 Codex helper catalog 映射到了 native tools 和 backlog，但 manifest 默认 `directExecution: false`。这比 Codex 更安全，但遇到尚未产品化的边角能力时，灵活性较弱。

### 设计原则

不要开放任意脚本执行。只允许：

- 位于 active skill 目录内的脚本。
- manifest 明确 `directExecution: true` 的脚本。
- manifest 明确 entrypoint、输入 schema、输出 schema、允许文件类型、超时和最大输出大小。
- 默认禁止网络访问。
- 输出只能写到 workspace 下受控 artifact 目录或临时目录。
- 不允许读取 SecretStorage、环境私密值、私有 provider 默认值。

### 实施步骤

- [x] 定义 manifest v2 字段：`directExecution`、`entrypoint`、`inputSchema`、`outputArtifacts`、`timeoutMs`、`maxOutputBytes`、`allowedExtensions`、`networkPolicy`。
- [x] 增强 `chipmate_run_skill_script`：严格校验 active skill、manifest、entrypoint、参数和输出路径。
- [x] 默认保持 documents helper catalog 不直接执行，只挑低风险 helper 逐个 opt in。
- [x] 第一批候选建议选择诊断/只读类 helper，而不是会改文档的 helper。
- [x] 对已有 native tool 覆盖良好的能力，不优先启用 direct fallback，避免双路径行为不一致。
- [x] 所有 fallback 结果必须回填到工具返回的 evidence/warnings，而不是让模型自行解释裸 stdout。

### 测试计划

- [x] 未在 manifest opt in 的脚本必须拒绝执行。
- [x] 路径穿越、非 active skill、非允许扩展、超时、超大输出都必须拒绝。
- [x] 只读 helper 输出 artifact 能被正常登记。
- [x] 修改型 helper 在没有明确 output path 时必须拒绝。
- [x] 回归 `test/skills-permissions.test.ts` 和 `test/manifest.test.ts`。

### 验收标准

- [x] direct helper fallback 不破坏现有 native Word tools。
- [x] 默认安全，逐项 opt in。
- [x] 出错时 fail closed，并给出可解释 warning。
- [x] 不把本地私有配置或 provider 信息写入源码、日志或 artifact。

## 分阶段排期

### Phase 0：基线确认

- [x] 运行当前 Word 相关测试，记录基线。
- [x] 确认本地 `soffice`、`pdftoppm`、canvas 依赖状态。
- [x] 确认当前 provider 是否支持图像输入；若不支持，P0 只能做到自动视觉摘要和用户可见 PNG 预览，不能声称完整 Codex 视觉 parity。（实现为运行时探测：支持则附 page PNG，不支持则 text-only retry 并披露限制。）

### Phase 1：P0 视觉 QA 闭环

- [x] 实现 QA verdict schema。
- [x] 接通 Word render artifact 到 agent 后续判断。
- [x] 增加 bounded repair loop。
- [x] 增加不支持图像输入时的降级披露。
- [x] 补测试和文档。

### Phase 2：P1 preset/header

- [x] Token map 化 preset。
- [x] 加 alias。
- [x] 加 header patterns。
- [x] Builder 落地。
- [x] Preset audit 和测试。

### Phase 3：P2 direct helper fallback

- [x] Manifest v2。
- [x] `chipmate_run_skill_script` 安全执行边界。
- [x] 只读 helper opt in 试点。
- [x] 权限和安全测试。

### Phase 4：整体验证

- [x] `bun run compile`
- [x] `bun test test/doc-agent.test.ts test/direct-agent-client.test.ts test/chat-html.test.ts test/manifest.test.ts test/skills-permissions.test.ts`
- [x] `bun run package`
- [x] 如需 VS Code 实测，执行 `bun run vsix`。（本轮未要求手装 VS Code 实测，判定不适用；未 bump VSIX。）
- [x] VSIX 后执行私有 provider/RAG 字符串扫描，确认源码无泄漏。（本轮未产出 VSIX，已执行源码扫描：无匹配。）

## 风险和限制

- 如果当前 chat provider 不支持图像输入，就不能实现完全等同 Codex 的“模型逐页看 PNG”体验，只能先做自动视觉摘要、规则风险识别和用户可见预览。
- LibreOffice 或 `pdftoppm` 不可用时，不能完成真实渲染 QA，必须在最终结果中说明。
- preset/header 的丰富度会提升文档观感，但也会增加测试矩阵，需要优先做高价值 pattern，不要一次性追求所有边角。
- direct helper fallback 有安全风险，必须放在最后，并采用 manifest opt-in。

## 完成定义

当以下条件满足时，可以认为“本地离线 Word 可用版”达到下一阶段目标：

- [x] 普通新建 Word 文档能完成：规划 -> 生成 `.docx` -> 渲染 PDF/PNG -> QA verdict -> 必要时修复 -> 最终交付。
- [x] 普通编辑 Word 文档能完成：inspect -> locator edit -> 渲染 -> QA verdict -> 必要时二次编辑 -> 最终交付。
- [x] 文档视觉风格能根据文档类型选择不同 preset/header，不再只有单一报告模板感。
- [x] 边角 helper fallback 有安全边界，不影响普通用户的稳定路径。
- [x] 所有未完成或不可用的 QA 能力都会显式披露，不会把结构检查说成视觉通过。
