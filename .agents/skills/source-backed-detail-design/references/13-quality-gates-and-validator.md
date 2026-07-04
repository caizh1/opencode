# 13 Quality Gates and Validator

最终门禁：references verified、module-scope、source evidence、control flow、business flow evidence、business submodule diagrams、business parent diagram、submodule evidence、mmd/png 成对、edge coverage、父图、全部正文、差异报告、word input、docx。

ChipMate validator helper：优先通过 `chipmate_run_skill_script` 调用 `scripts/manifest.json` 中的 `validate_artifacts`。如果 helper 不可用，按本文件逐项人工检查，并在 `quality-gate-report.md` 中写明 `validator not executed`、原因和人工检查结果。

业务流程门禁：

- `03-control-flow-evidence/09-business-capability-map.csv` 存在且非空，并包含 `capability_description`、`business_value`、`scope_boundary`、`key_steps` 字段；
- `03-control-flow-evidence/10-business-flow-steps.csv` 存在且非空；
- `03-control-flow-evidence/11-business-flow-edges.csv` 存在且非空；
- `03-control-flow-evidence/12-business-flow-edge-coverage.csv` 存在且非空；
- `04-diagrams/mmd/business/submodules/` 至少包含每个重要子模块一张业务图；
- `04-diagrams/png/business/submodules/` 与 mmd 一一对应；
- `04-diagrams/mmd/business/parent/business-parent-module-master-flow.mmd` 存在；
- `04-diagrams/png/business/parent/business-parent-module-master-flow.png` 存在；
- 业务图 edge coverage 不允许 unverified；
- 业务图不得被判定为函数调用图、目录拓扑图或状态机展开图；
- 正文必须引用业务总图和子模块业务图；
- 业务能力纵览表不得只有能力名称，必须包含能力说明；
- 每个重要子模块小节必须有图前简介和图后流程解读。


正文文字充足度门禁：

- `05-enhanced-detail-design/02-business-flow-overview.md` 必须包含业务能力纵览表；
- 业务能力纵览表必须至少包含：能力ID、能力名称、能力说明、所属子模块、触发条件、业务结果/副作用、源码证据；
- 每条能力说明建议 60-160 个中文字符；
- `05-enhanced-detail-design/08-submodule-business-flows.md` 中每个重要子模块必须包含“子模块简介”；
- 每个子模块简介建议 120-260 个中文字符；
- 每个子模块图后必须有流程解读，说明主路径、关键分支和异常/等待/重试路径；
- `03-control-flow-evidence/13-business-text-coverage.csv` 必须存在，且 capability/submodule 的 quality_status 不得为 missing；
- 如果正文只有图、表格或证据列表，没有子模块简介和能力说明，必须判定为 INCOMPLETE。


Word 导出门禁：

- `08-word-export-input.md` 必须存在且非空；
- `08-word-export-input.md` 中禁止出现 `../04-diagrams/`；
- `08-word-export-input.md` 中所有图片路径必须存在；
- 导出前必须运行图片路径检查；
- 最终 Word 必须由 `create_word_document` 生成；
- `06-quality-gates/word-export-log.md` 或 `quality-gate-report.md` 必须记录 `create_word_document`、`render_word_document` 的执行状态和产物路径；
- docx 文件存在且非空，且无图片缺失 warning，才能判定 Word 导出 PASS。

拓扑图拒绝：如果图只有函数名和直接箭头，没有条件、状态、数据、异常路径，则 REJECTED。

high-level 业务流程图拒绝：如果图只有函数名、文件名、目录名、组件名或状态枚举展开，没有业务触发、业务动作、业务条件、业务对象、状态/数据影响和异常/等待/重试/完成出口，则 REJECTED。

INCOMPLETE 判定：出现“由于篇幅限制”后直接生成 Word，word input 写着部分完成，章节缺失，PNG 缺失，mmd/png 不成对，Word 未由 create_word_document 生成，create_word_document 未成功且无明确失败记录，quality gate 文件不存在，CSV 只有表头，业务能力纵览表缺少能力说明，子模块章节只有图没有简介，`08-word-export-input.md` 中仍包含 `../04-diagrams/`。

如果只生成代码级函数调用图，没有 high-level 子模块业务流程图和总模块业务流程图，必须判定为 INCOMPLETE。
