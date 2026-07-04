# 14 Continuation Checkpoint Protocol

本 skill 默认支持多 session。任务状态必须写入文件系统，不能依赖聊天上下文。

每轮结束必须更新 resume-state.md、continue-prompt.md、quality-gate-report.md。

续跑时：先读取 continue-prompt.md，再读取 resume-state.md，再读取 quality-gate-report.md，优先运行 `chipmate_run_skill_script` 调用 `validate_artifacts` helper；如果 helper 不可用，按 `references/13-quality-gates-and-validator.md` 手工检查并在报告中说明 validator 未执行。找到第一个未完成 work package，从那里继续。

禁止因为 checkbox、已完成、✅ 等字样跳过仍有失败项的阶段。当“已完成”和“待补事项”冲突时，以待补事项为准。
