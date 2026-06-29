import * as path from "node:path"
import * as vscode from "vscode"
import { DocumentEditPlanner } from "./DocumentEditPlan"
import { WordDocumentEditor } from "./WordDocumentEditor"
import { WordDocumentInspector } from "./WordDocumentInspector"
import type {
  DocAgentModelProvider,
  DocAgentTimelineEvent,
  DocumentSkillRunSummary,
  GeneratedDocumentResult,
} from "./types"

const WORD_EDIT_STAGE_TOTAL = 6

export type WordEditAgentInput = {
  question: string
  file: { path: string; bytes: Uint8Array; mentionIndex?: number }
  extraSourceCount?: number
  model?: DocAgentModelProvider
  signal?: AbortSignal
  log?: (message: string) => void
  onTimeline?: (event: DocAgentTimelineEvent) => void
  onProgress?: (progress: { message: string; current?: number; total?: number }) => void
}

export class WordEditAgentFlow {
  constructor(private readonly workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd()) {}

  async run(input: WordEditAgentInput): Promise<GeneratedDocumentResult> {
    const warnings: string[] = []
    const errors: string[] = []
    let summary: DocumentSkillRunSummary = {
      sourceDoc: input.file.path,
      appliedOperations: [],
      repairAttempted: false,
      warnings,
      errors,
    }
    const emit = (event: Omit<DocAgentTimelineEvent, "id" | "timestamp">) => {
      input.onTimeline?.({ id: `word-edit-${event.type}-${Date.now()}-${Math.random().toString(16).slice(2)}`, timestamp: Date.now(), ...event })
    }
    try {
      input.log?.(`[word-agent] started: ${input.file.path}`)
      emit({ type: "run.started", title: "Word Agent 已启动", detail: input.file.path, status: "completed", current: 0, total: WORD_EDIT_STAGE_TOTAL })

      input.signal?.throwIfAborted()
      input.onProgress?.({ message: "读取并检查 Word 文档", current: 1, total: WORD_EDIT_STAGE_TOTAL })
      emit({ type: "inspect_word_document", title: "检查 Word 文档结构", detail: input.file.path, status: "running", timelineKey: "inspect_word_document", stateLabel: "检查中", current: 1, total: WORD_EDIT_STAGE_TOTAL })
      const inspection = await new WordDocumentInspector().inspect(input.file)
      warnings.push(...inspection.warnings)
      summary = { ...summary, inspectSummary: inspection.summary }
      emit({
        type: "inspect_word_document",
        title: "检查 Word 文档结构",
        detail: `${inspection.summary.paragraphCount} 个段落 · ${inspection.summary.tableCount} 个表格 · ${inspection.summary.headingCount} 个标题 · ${inspection.summary.noteCount} 个脚注/尾注 · ${inspection.summary.imageCount} 张图片 · ${inspection.summary.sectionCount} 个节 · ${inspection.summary.fieldCount} 个字段 · ${inspection.summary.styleCount} 个样式 · ${inspection.summary.hyperlinkCount} 个链接`,
        status: "completed",
        timelineKey: "inspect_word_document",
        stateLabel: "完成",
        current: 1,
        total: WORD_EDIT_STAGE_TOTAL,
      })

      input.signal?.throwIfAborted()
      input.onProgress?.({ message: "生成受控 DocumentEditPlan", current: 2, total: WORD_EDIT_STAGE_TOTAL })
      emit({ type: "edit_plan", title: "生成受控 DocumentEditPlan", status: "running", timelineKey: "edit_plan", stateLabel: "规划中", current: 2, total: WORD_EDIT_STAGE_TOTAL })
      const planned = await new DocumentEditPlanner(input.model).plan({
        question: input.question,
        targetPath: input.file.path,
        inspection,
        signal: input.signal,
      })
      warnings.push(...planned.warnings)
      if (!planned.ok || !planned.plan) throw new Error(`DocumentEditPlan 未通过运行时校验：${planned.errors.join("；")}`)
      summary = { ...summary, editPlan: planned.plan }
      emit({
        type: "edit_plan",
        title: "生成受控 DocumentEditPlan",
        detail: `${planned.plan.operations.length} 个操作 · ${planned.warnings.length} 条 warning`,
        status: "completed",
        timelineKey: "edit_plan",
        stateLabel: "完成",
        current: 2,
        total: WORD_EDIT_STAGE_TOTAL,
      })

      input.signal?.throwIfAborted()
      input.onProgress?.({ message: "事务式应用 Word 编辑", current: 3, total: WORD_EDIT_STAGE_TOTAL })
      emit({ type: "apply_word_document_edits", title: "事务式应用 Word 编辑", status: "running", timelineKey: "apply_word_document_edits", stateLabel: "编辑中", current: 3, total: WORD_EDIT_STAGE_TOTAL })
      const applied = await new WordDocumentEditor(this.workspaceRoot).apply({
        sourcePath: input.file.path,
        bytes: input.file.bytes,
        inspection,
        plan: planned.plan,
        signal: input.signal,
        log: input.log,
      })
      warnings.push(...applied.warnings)
      summary = {
        ...summary,
        outputDoc: applied.path,
        appliedOperations: applied.appliedOperations,
        structureCheckResult: applied.structureCheckResult,
        renderCheckResult: applied.renderCheckResult,
        repairAttempted: applied.repairAttempted,
        warnings,
        errors,
      }
      emit({
        type: "apply_word_document_edits",
        title: "事务式应用 Word 编辑",
        detail: `${applied.appliedOperations.length} 个操作已应用`,
        status: "completed",
        timelineKey: "apply_word_document_edits",
        stateLabel: "完成",
        current: 3,
        total: WORD_EDIT_STAGE_TOTAL,
      })
      emit({
        type: "quality_gate",
        title: "基础结构校验",
        detail: `${applied.structureCheckResult.issues.length} 个结构检查项 · ${applied.structureCheckResult.ok ? "通过" : "失败"}`,
        status: applied.structureCheckResult.ok ? "completed" : "error",
        timelineKey: "word_edit_structure_gate",
        stateLabel: applied.structureCheckResult.ok ? "通过" : "失败",
        current: 4,
        total: WORD_EDIT_STAGE_TOTAL,
      })
      emit({
        type: "render_word_document",
        title: "LibreOffice 渲染检查",
        detail: applied.renderCheckResult.attempted
          ? `${applied.renderCheckResult.ok ? "完成" : "发现问题"} · ${applied.renderCheckResult.issues.length} 条`
          : "未执行，已降级为结构检查",
        status: applied.renderCheckResult.attempted ? (applied.renderCheckResult.ok ? "completed" : "warning") : "warning",
        timelineKey: "render_word_document",
        stateLabel: applied.renderCheckResult.attempted ? "完成" : "降级",
        current: 5,
        total: WORD_EDIT_STAGE_TOTAL,
      })
      if (applied.repairAttempted) {
        emit({
          type: "repair_word_document",
          title: "执行一次受控 repair",
          detail: "仅修复目录占位符、表格宽度或页眉页脚 fallback 等工具可控问题",
          status: "completed",
          timelineKey: "repair_word_document",
          stateLabel: "完成",
          current: 5,
          total: WORD_EDIT_STAGE_TOTAL,
        })
      }
      const summaryPath = await persistDocumentSkillRunSummary(this.workspaceRoot, summary)
      emit({
        type: "done",
        title: "Word 编辑完成",
        detail: `${applied.path}${summaryPath ? `\nRun summary：${summaryPath}` : ""}`,
        status: "completed",
        timelineKey: "done",
        stateLabel: "完成",
        current: WORD_EDIT_STAGE_TOTAL,
        total: WORD_EDIT_STAGE_TOTAL,
        path: applied.path,
      })
      input.onProgress?.({ message: `已生成：${applied.path}`, current: WORD_EDIT_STAGE_TOTAL, total: WORD_EDIT_STAGE_TOTAL })
      return {
        path: applied.path,
        absolutePath: applied.absolutePath,
        title: planned.plan.outputTitle ?? "Word 文档",
        sourceCount: 1 + (input.extraSourceCount ?? 0),
        warningCount: unique(warnings).length,
        warnings: unique(warnings),
        errors: [],
        runSummaryPath: summaryPath,
      }
    } catch (error) {
      if (input.signal?.aborted) throw error
      const message = error instanceof Error ? error.message : String(error)
      errors.push(message)
      summary = { ...summary, warnings, errors }
      const summaryPath = await persistDocumentSkillRunSummary(this.workspaceRoot, summary).catch(() => undefined)
      input.log?.(`[word-agent] failed: ${message}`)
      emit({ type: "error", title: "Word 编辑失败", detail: summaryPath ? `${message}\nRun summary：${summaryPath}` : message, status: "error", timelineKey: "error", stateLabel: "失败" })
      throw error
    }
  }
}

export function isWordEditIntent(input: { text: string; docxCount: number }) {
  if (input.docxCount < 1) return false
  const text = input.text.toLowerCase()
  if (/(?:替换|修改|更新|新增|添加|补充|追加|修订|审稿|调整|修复|删除|移除|接受|拒绝|review)/i.test(text)) return true
  return input.docxCount === 1 && /(?:改成|改为|转换成|转成|润色|校对).*(?:word|docx|文档)/i.test(input.text)
}

async function persistDocumentSkillRunSummary(workspaceRoot: string, summary: DocumentSkillRunSummary) {
  const outputDir = path.join(workspaceRoot, ".chipmate", "docs")
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(outputDir))
  const filename = `document-skill-run-${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}.json`
  const target = path.join(outputDir, filename)
  await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(JSON.stringify(summary, null, 2), "utf8"))
  return path.posix.join(".chipmate", "docs", filename)
}

function unique(input: string[]) {
  return [...new Set(input.filter(Boolean))]
}
