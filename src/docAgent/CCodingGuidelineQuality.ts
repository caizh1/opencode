import type {
  CandidateRule,
  GeneratedExampleSpec,
  QualityIssue,
  ReferenceDocRole,
  RuleCardSpec,
  SourceBackedBlock,
  SourceContentKind,
} from "./types"
import {
  generatedExampleContractMismatch,
  inferSemanticKindFromText,
} from "./CCodingGuidelineSemanticRegistry"

export type CRuleSemanticKind =
  | "file-layout"
  | "naming"
  | "comment"
  | "function-design"
  | "error-handling"
  | "pointer-memory"
  | "pointer-null-comparison"
  | "pointer-operator-spacing"
  | "pointer-initialization"
  | "trailing-whitespace"
  | "assignment-operator-spacing"
  | "unary-operator-spacing"
  | "binary-operator-spacing"
  | "postfix-operator-spacing"
  | "pragma-pack-pairing"
  | "variable-scope"
  | "global-state"
  | "type-definition"
  | "literal-constant"
  | "operator-precedence"
  | "sizeof-usage"
  | "expression-complexity"
  | "reentrancy"
  | "external-state-mutability"
  | "brace-style"
  | "const-correctness"
  | "integer-type"
  | "macro-constant"
  | "constant-left-comparison"
  | "parameter-passing"
  | "volatile-register"
  | "isr"
  | "bounded-loop"
  | "recursion"
  | "static-analysis"
  | "formatting"
  | "dynamic-memory"
  | "undefined-behavior"
  | "determinism"
  | "memory-consistency"
  | "governance"
  | "checklist"
  | "generic"

type PlacementLike = {
  blockId: string
  targetRuleId: string
  placement: string
  confidence?: number
  reason?: string
  label?: string
}

const PLACEHOLDER_RULE_TEXT_RE = /(?:该规则来自本地参考资料|具体表述需结合来源依据在评审中确认|已纳入团队规则草案|本地参考资料.*团队规则草案)/i
const TEMPLATE_RECOMMENDED_RE = /(?:按本规则要求实现|推荐按团队约定执行|按团队规范要求实现|避免保留来源中的模糊或未团队化表述|在\s*Code Review\s*中检查命名、边界、错误路径和可维护性)/i
const TEMPLATE_DISCOURAGED_RE = /(?:避免无边界、无依据或不可维护的实现|不要保留来源中的模糊或未团队化表述)/i
const GOVERNANCE_RE = /(?:版权边界|版权|行业合规|合规|项目裁剪|专属版本|生成专属规范|风险、?限制|后续完善|治理|文档版本|落地路线图)/i
const EXAMPLE_SECTION_RE = /(?:推荐\s*\/\s*不推荐代码示例|代码示例|示例章节|实例如下|example)/i
const IMPLEMENTATION_GUIDANCE_RE = /(?:静态检查和落地建议|静态检查落地|落地建议|执行落地|CI\s*集成|流水线|检查集|工具配置|高风险模块引入安全规则集)/i
const RISK_LIMIT_RE = /(?:风险、?限制|后续完善|版权边界|行业合规|项目裁剪|专属版本|合规说明|适用边界)/i
const APPENDIX_RE = /(?:附录|速查表|索引|规则分类速查表|appendix)/i
const REFERENCE_RE = /(?:参考资料|References?|引用来源|资料来源)/i
const GENERIC_RULE_NAME_RE = /^(?:外部参考规则|通用规则|参考规则|未命名规则|规则\s*\d*|候选规则)$/i

export class CandidateRuleQualityGate {
  filter(rules: CandidateRule[]): { rules: CandidateRule[]; rejected: CandidateRule[]; warnings: string[] } {
    const accepted: CandidateRule[] = []
    const rejected: CandidateRule[] = []
    const warnings: string[] = []
    for (const rule of rules) {
      const withKind = {
        ...rule,
        sourceContentKind: rule.sourceContentKind ?? classifyCSourceContent({
          headingPath: rule.sourceLocation.headingPath ?? [rule.sourceSection],
          text: candidateRuleText(rule),
        }),
      }
      const reason = candidateRejectReason(withKind)
      if (reason) {
        rejected.push(withKind)
        warnings.push(`候选规则已排除：${rule.title}（${rule.sourceDocument} / ${rule.sourceSection}）：${reason}`)
        continue
      }
      accepted.push(withKind)
    }
    return { rules: accepted, rejected, warnings: [...new Set(warnings)] }
  }
}

export function classifyCSourceContent(input: { headingPath?: string[]; text?: string; kind?: SourceBackedBlock["kind"] }): SourceContentKind {
  const heading = normalizeText((input.headingPath ?? []).join(" > "))
  const leafHeading = normalizeText((input.headingPath ?? []).at(-1) ?? "")
  const text = normalizeText(input.text ?? "")
  const combined = `${heading} ${text}`
  if (/快速规则矩阵|核心规则矩阵/i.test(combined)) return "rule-matrix"
  if (/核心规则卡片|C-RULE-\d+|【规则[\d.-]+】/i.test(combined)) return "core-rule"
  if (APPENDIX_RE.test(leafHeading)) return "appendix-index"
  if (REFERENCE_RE.test(leafHeading)) return "reference"
  if (RISK_LIMIT_RE.test(combined)) return "risk-limit"
  if (IMPLEMENTATION_GUIDANCE_RE.test(combined)) return "implementation-guidance"
  if (input.kind === "code" || input.kind === "example" || EXAMPLE_SECTION_RE.test(combined)) return "example"
  if (/(?:必须|不得|禁止|应该|建议|shall|must|should|required|【建议[\d.-]+】)/i.test(combined)) return "core-rule"
  if (combined.trim().length === 0) return "unknown"
  return "narrative"
}

export function sanitizeCGuidelineRuleCards(rules: RuleCardSpec[]): { rules: RuleCardSpec[]; warnings: string[] } {
  const sanitized: RuleCardSpec[] = []
  const warnings: string[] = []
  for (const rule of rules) {
    if (isGovernanceRule(rule)) {
      warnings.push(`非编码规则内容已从核心规则正文移除：${rule.ruleId}「${rule.name}」。`)
      continue
    }
    const repaired = repairRuleCard(rule)
    const placeholders = placeholderIssuesForRule(repaired)
    if (placeholders.length > 0) {
      warnings.push(`规则 ${rule.ruleId}「${rule.name}」仍包含占位或模板表述，已从核心规则正文移除：${placeholders.join("、")}。`)
      continue
    }
    sanitized.push(repaired)
  }
  return { rules: sanitized, warnings: [...new Set(warnings)] }
}

export function collectCGuidelineRuleQualityIssues(rules: RuleCardSpec[]): QualityIssue[] {
  const issues: QualityIssue[] = []
  for (const rule of rules) {
    const placeholderFields = placeholderIssuesForRule(rule)
    if (placeholderFields.length > 0) {
      issues.push(error("rule-placeholder-content", `规则 ${rule.ruleId}「${rule.name}」存在占位或模板表述：${placeholderFields.join("、")}`))
    }
    if (isGovernanceRule(rule)) {
      issues.push(error("non-rule-card-content", `规则 ${rule.ruleId}「${rule.name}」属于流程、版权、合规或文档治理内容，不应进入核心编码规则正文。`))
    }
    if (isGenericRuleName(rule.name)) {
      issues.push(error("generic-rule-card", `规则 ${rule.ruleId}「${rule.name}」尚未具体化为可执行编码规则，不应进入正式 RuleCard。`))
    }
    for (const example of rule.generatedExamples ?? []) {
      const mismatch = generatedExampleMismatchReason(rule, example)
      if (mismatch) {
        issues.push(error("rule-example-mismatch", `规则 ${rule.ruleId}「${rule.name}」的生成示例与规则语义不匹配：${mismatch}`))
      }
    }
  }
  return issues
}

export function validateCCodingGuidelineSourcePlacement(input: { rule: RuleCardSpec; block: SourceBackedBlock; placement: PlacementLike }): { ok: boolean; warning?: string } {
  const ruleKind = inferCCodingGuidelineRuleKind(input.rule)
  const blockKind = inferCSourceBlockSemanticKind(input.block)
  const ruleText = normalizeText(`${input.rule.name} ${input.rule.scope} ${input.rule.description} ${input.rule.recommended ?? ""} ${input.rule.discouraged ?? ""}`)
  const blockText = normalizeText(`${input.block.title ?? ""} ${input.block.source.headingPath.join(" ")} ${sourceBlockText(input.block)}`)
  if (/(?:volatile|寄存器|临界区|register|critical section)/i.test(blockText) && /(?:错误|返回值|错误码|return value|status|errno)/i.test(ruleText) && !/(?:volatile|寄存器|临界区|register)/i.test(ruleText)) {
    return {
      ok: false,
      warning: `来源块与目标规则语义不匹配，已跳过归位：${sourceBlockLabel(input.block)} -> ${input.rule.ruleId}「${input.rule.name}」。`,
    }
  }
  if (input.placement.placement === "checklist" && ruleKind === "static-analysis") return { ok: true }
  if (ruleKind === "generic" || blockKind === "generic" || blockKind === "checklist") return { ok: true }
  if (ruleKind === blockKind) return { ok: true }
  if (compatibleSemanticKinds(ruleKind, blockKind)) return { ok: true }
  if (isObviousSemanticMismatch(ruleKind, blockKind)) {
    return {
      ok: false,
      warning: `来源块与目标规则语义不匹配，已跳过归位：${sourceBlockLabel(input.block)} -> ${input.rule.ruleId}「${input.rule.name}」。`,
    }
  }
  return { ok: true }
}

export function inferCCodingGuidelineRuleKind(rule: RuleCardSpec | CandidateRule): CRuleSemanticKind {
  return inferCCodingGuidelineRuleKindFromText("name" in rule
    ? `${rule.name} ${rule.scope} ${rule.description} ${rule.recommended ?? ""} ${rule.discouraged ?? ""} ${rule.rationale ?? ""} ${rule.exceptions ?? ""}`
    : candidateRuleText(rule))
}

export function inferCCodingGuidelineRuleKindFromText(rawText: string): CRuleSemanticKind {
  return inferSemanticKindFromText(rawText)
}

export function isGeneratedExampleSemanticallyCompatible(rule: RuleCardSpec, example: GeneratedExampleSpec) {
  const kind = inferCCodingGuidelineRuleKindForExample(rule, example)
  return !generatedExampleContractMismatch(kind, example)
}

export function generatedExampleMismatchReason(rule: RuleCardSpec, example: GeneratedExampleSpec) {
  const kind = inferCCodingGuidelineRuleKindForExample(rule, example)
  const mismatch = generatedExampleContractMismatch(kind, example)
  if (!mismatch) return undefined
  const title = example.title || "未命名示例"
  return `规则语义=${kind}，exampleFormat=${example.exampleFormat ?? "未设置"}，exampleType=${example.exampleType ?? "未设置"}，示例标题=${title}，${mismatch}`
}

function candidateRejectReason(rule: CandidateRule) {
  if (hasPlaceholderRuleText(candidateRuleText(rule))) return "规则说明是占位文本，不是可执行编码规则"
  if (TEMPLATE_RECOMMENDED_RE.test(rule.recommended ?? "") || TEMPLATE_DISCOURAGED_RE.test(rule.discouraged ?? "")) return "推荐/不推荐写法是模板句"
  if (isGovernanceCandidate(rule)) return "属于流程、版权、合规或文档治理内容"
  if (rule.sourceContentKind && !contentKindCanBecomeRule(rule.sourceContentKind, rule.sourceRole)) return sourceContentKindReason(rule.sourceContentKind)
  return undefined
}

function contentKindCanBecomeRule(kind: SourceContentKind, role: ReferenceDocRole) {
  if (kind === "core-rule" || kind === "rule-matrix") return true
  if (kind === "unknown" || kind === "narrative") return role === "internal"
  return false
}

function sourceContentKindReason(kind: SourceContentKind) {
  if (kind === "example") return "来源章节是示例内容，只能挂到已有规则"
  if (kind === "implementation-guidance") return "来源章节是落地建议，默认进入执行落地章节"
  if (kind === "risk-limit") return "来源章节是风险、限制或合规说明"
  if (kind === "reference") return "来源章节是参考资料"
  if (kind === "appendix-index") return "来源章节是附录索引或速查表"
  return "来源内容类型不适合生成正式规则"
}

function repairRuleCard(rule: RuleCardSpec): RuleCardSpec {
  const kind = inferCCodingGuidelineRuleKind(rule)
  const next = { ...rule }
  if (hasPlaceholderRuleText(next.description)) next.description = descriptionForKind(kind, next)
  if (!next.recommended?.trim() || TEMPLATE_RECOMMENDED_RE.test(next.recommended)) next.recommended = recommendedForKind(kind)
  if (!next.discouraged?.trim() || TEMPLATE_DISCOURAGED_RE.test(next.discouraged)) next.discouraged = discouragedForKind(kind)
  if (!next.rationale?.trim() || hasPlaceholderRuleText(next.rationale)) next.rationale = rationaleForKind(kind)
  if (!next.exceptions?.trim()) next.exceptions = "确需例外时，应记录原因、影响范围和替代风险控制措施，并经过代码评审确认。"
  return next
}

function descriptionForKind(kind: CRuleSemanticKind, rule: RuleCardSpec) {
  if (kind === "static-analysis") return "编译告警、静态分析和 CI 检查应形成闭环：新增告警必须修复或记录偏差，不能把工具结果作为无人处理的噪声。"
  if (kind === "file-layout") return "公开接口应通过头文件声明，实现文件应包含对应头文件，确保模块边界、依赖关系和接口可追踪。"
  if (kind === "naming") return "命名应准确表达模块、对象、动作和单位，避免无语义缩写或只依赖上下文才能理解的名称。"
  if (kind === "bounded-loop") return "循环、轮询和等待逻辑应具备明确退出条件，必要时设置上界或超时，避免异常情况下永久阻塞。"
  if (kind === "isr") return "中断服务函数应保持短小、确定，只完成必要状态记录或事件通知，将复杂处理延后到任务上下文。"
  if (kind === "recursion") return "受限资源或嵌入式场景应避免无界递归，优先使用迭代或显式栈，并明确资源上界。"
  if (kind === "error-handling") return "可能失败的函数调用必须检查返回值，并沿调用链传递或处理错误，不能静默忽略失败。"
  if (kind === "pointer-null-comparison") return "指针与零值比较时应显式使用 NULL 判断，避免依赖隐式真假值转换表达指针有效性。"
  if (kind === "pointer-operator-spacing") return "指针声明、解引用和取地址表达式应按团队约定放置空格，避免操作符与变量名之间出现歧义。"
  if (kind === "pointer-initialization") return "指针变量声明时必须初始化为 NULL 或有效对象地址，避免未初始化指针被误用。"
  if (kind === "trailing-whitespace") return "源文件中不应保留行尾空格或制表符，避免产生无意义 diff 和格式检查噪声。"
  if (kind === "assignment-operator-spacing") return "赋值和复合赋值运算符两侧应保留空格，使写入目标和值来源清晰可读。"
  if (kind === "unary-operator-spacing") return "一元操作符应紧邻操作数，不应在操作符和变量之间插入空格。"
  if (kind === "binary-operator-spacing") return "二元运算符两侧应保留空格，使表达式层次和条件组合清晰。"
  if (kind === "postfix-operator-spacing") return "数组下标、成员访问和函数调用应紧邻对象，不应插入多余空格。"
  if (kind === "pragma-pack-pairing") return "修改结构体对齐方式时必须在局部范围内成对恢复，避免影响后续类型布局。"
  if (kind === "variable-scope") return "变量应在首次使用附近声明，并尽量限制在最小作用域内。"
  if (kind === "global-state") return "可变全局状态应尽量封装或通过上下文对象传递，避免扩大影响范围。"
  if (kind === "type-definition") return "与边界、协议或硬件相关的数据应使用固定宽度类型或团队定义的语义类型。"
  if (kind === "literal-constant") return "非平凡数字应抽取为具有模块前缀、含义和单位的常量，避免在表达式中直接出现裸数字。"
  if (kind === "operator-precedence") return "混合位运算、比较、逻辑和算术运算时，应使用括号明确求值分组。"
  if (kind === "sizeof-usage") return "计算对象大小时优先使用变量对象而不是类型名，降低类型变化后的维护遗漏。"
  if (kind === "expression-complexity") return "包含多重条件、副作用或嵌套三目运算的表达式应拆分为简单语句。"
  if (kind === "reentrancy") return "可重入函数应避免内部静态状态或全局状态，必要状态由调用方显式传入。"
  if (kind === "external-state-mutability") return "可能被外部上下文修改的状态不能长期假定不变，使用前应获取快照或在保护区内重新确认。"
  if (kind === "brace-style") return "大括号应按照团队风格独占一行，使程序块边界清晰。"
  if (kind === "const-correctness") return "函数不会修改的输入对象应通过 const 指针表达只读语义。"
  if (kind === "constant-left-comparison") return "相等比较中如一侧是常量、宏或其他右值，应将其放在比较运算符左侧，降低误写赋值表达式的风险。"
  if (kind === "parameter-passing") return "函数参数应明确表达按值传递、只读指针、输出指针或可选指针的语义。"
  if (kind === "pointer-memory") return "访问指针、数组和缓冲区前必须确认有效性、长度和边界，防止空指针和越界访问。"
  if (kind === "integer-type") return "涉及长度、索引、协议字段或寄存器字段时，应使用明确类型并检查溢出、截断和强制转换风险。"
  if (kind === "memory-consistency") return "多核或多主设备访问共享变量时，应按原规范要求保证缓存、同步、原子性和 ECC 对齐等存储访问一致性约束。"
  if (kind === "macro-constant") return "宏、枚举和常量应具备清晰命名、作用域和单位说明，避免魔法数和跨模块命名冲突。"
  if (kind === "comment") return "注释应解释代码意图、约束和风险，与被描述代码保持一致，并遵循团队约定的注释风格。"
  if (kind === "function-design") return "函数应保持职责单一、接口明确、输入输出可检查，避免隐藏依赖和过长实现。"
  return rule.description
}

function recommendedForKind(kind: CRuleSemanticKind) {
  if (kind === "static-analysis") return "在构建或 CI 中启用约定的告警和静态检查项；新增告警必须修复，确需保留时记录偏差理由和责任人。"
  if (kind === "file-layout") return "为模块公开接口提供对应头文件，在实现文件中包含该头文件，并保持声明与实现一致。"
  if (kind === "naming") return "使用能表达模块、对象、动作和单位的名称；公共符号增加模块前缀，计数和时间变量体现单位。"
  if (kind === "bounded-loop") return "为循环和轮询设置明确边界或超时，并在超时后返回错误或进入可诊断的处理路径。"
  if (kind === "isr") return "ISR 中只读取必要状态、清除中断或设置事件标志，复杂计算、日志和阻塞操作放到任务上下文。"
  if (kind === "recursion") return "优先使用迭代实现；如确需递归，必须证明最大深度并记录资源占用上界。"
  if (kind === "error-handling") return "检查每个可能失败调用的返回值，按团队错误码约定处理、转换或向上传递。"
  if (kind === "pointer-null-comparison") return "指针有效性判断使用 `ptr == NULL` 或 `ptr != NULL`，不要依赖 `if (ptr)` 或 `if (!ptr)` 表达指针状态。"
  if (kind === "pointer-operator-spacing") return "指针声明使用 `int *ptr`，取地址和解引用使用 `&value`、`*ptr`，不要在操作符后插入多余空格。"
  if (kind === "pointer-initialization") return "声明指针时立即初始化为 `NULL` 或有效对象地址，并在解引用前确认指针有效。"
  if (kind === "trailing-whitespace") return "保存前自动删除行尾空白，并在格式检查中拦截新增行尾留白。"
  if (kind === "assignment-operator-spacing") return "赋值表达式写成 `status = read_status();`，复合赋值写成 `count += 1U;`。"
  if (kind === "unary-operator-spacing") return "一元操作符紧邻操作数，例如 `!ready`、`*ptr`、`&value`、`++count`。"
  if (kind === "binary-operator-spacing") return "二元运算符两侧保留一个空格，例如 `(count + offset) >= limit && ready`。"
  if (kind === "postfix-operator-spacing") return "数组下标、成员访问和函数调用紧邻对象，例如 `buffer[index]`、`config.timeout_ms`、`handler()`。"
  if (kind === "pragma-pack-pairing") return "使用 `#pragma pack(push, 1)` 和 `#pragma pack(pop)` 包裹受影响结构体。"
  if (kind === "variable-scope") return "变量在首次使用附近声明，循环计数器优先限制在 for 语句作用域内。"
  if (kind === "global-state") return "使用模块上下文结构体、访问器或局部状态传递，减少可变全局状态。"
  if (kind === "type-definition") return "使用 `uint32_t`、`size_t` 或 typedef 语义类型表达边界敏感值。"
  if (kind === "literal-constant") return "将非平凡数字定义为带模块前缀和单位的常量，例如 `SENSOR_MAX_SAMPLE_COUNT`。"
  if (kind === "operator-precedence") return "对混合运算使用括号明确分组，例如 `(flags & READY_MASK) == 0U`。"
  if (kind === "sizeof-usage") return "计算对象大小写成 `sizeof(buffer)`，让长度表达式随变量类型变化自动保持一致。"
  if (kind === "expression-complexity") return "使用临时变量和明确分支拆分复杂表达式。"
  if (kind === "reentrancy") return "可重入函数使用局部变量或调用方传入的上下文保存状态。"
  if (kind === "external-state-mutability") return "读取状态快照，并在临界区、锁或重新读取后确认关键条件。"
  if (kind === "brace-style") return "将 `{` 和 `}` 放在独立行并保持缩进一致。"
  if (kind === "const-correctness") return "只读输入参数使用 `const sensor_config_t *config` 这类 const 指针。"
  if (kind === "constant-left-comparison") return "常量、宏或 NULL 参与相等比较时写在左侧，例如 `NULL == ptr` 或 `0 == flag`。"
  if (kind === "parameter-passing") return "简单标量参数使用传值；结构体、可选对象或输出参数使用指针，并用 `const` 标明只读输入。"
  if (kind === "pointer-memory") return "在拷贝、索引和解引用前检查指针非空、长度合法和目标缓冲区容量。"
  if (kind === "integer-type") return "使用固定宽度类型或 size_t 表示边界敏感值，并在运算、转换前检查范围。"
  if (kind === "memory-consistency") return "在共享变量跨核或跨主设备传递前使用原规范要求的存储同步、锁或对齐机制，确保读者看到一致数据。"
  if (kind === "macro-constant") return "常量使用模块前缀、单位后缀和括号保护；枚举值表达状态含义，避免裸数字。"
  if (kind === "comment") return "对接口、复杂逻辑和关键约束补充说明，注释与代码同步更新。"
  if (kind === "function-design") return "函数保持单一职责，参数和返回值表达完整契约，失败路径可被调用方判断。"
  return "将规则改写为可检查的团队约束，并在代码评审中确认满足情况。"
}

function discouragedForKind(kind: CRuleSemanticKind) {
  if (kind === "static-analysis") return "不要忽略新增告警，也不要对整个工程无差别开启检查导致大量无关噪声无人处理。"
  if (kind === "file-layout") return "不要让公开接口只存在于实现文件中，也不要让头文件声明和实现长期不一致。"
  if (kind === "naming") return "不要使用无语义缩写、单字母全局名称或无法体现单位和用途的名称。"
  if (kind === "bounded-loop") return "不要编写没有退出条件、没有超时或依赖外部状态永久变化的空轮询。"
  if (kind === "isr") return "不要在 ISR 中执行阻塞等待、复杂计算、动态内存分配或耗时日志输出。"
  if (kind === "recursion") return "不要在栈空间受限或最大深度无法证明的路径中使用递归。"
  if (kind === "error-handling") return "不要忽略返回值后继续执行，也不要把失败路径统一伪装成成功。"
  if (kind === "pointer-null-comparison") return "不要使用 `if (ptr)` 或 `if (!ptr)` 这类隐式指针真假判断。"
  if (kind === "pointer-operator-spacing") return "不要写成 `int * ptr`、`& value` 或 `* ptr`。"
  if (kind === "pointer-initialization") return "不要声明未初始化指针，也不要在赋值前解引用或传递该指针。"
  if (kind === "trailing-whitespace") return "不要提交只包含行尾空白变化的代码。"
  if (kind === "assignment-operator-spacing") return "不要写成 `status=read_status();` 或 `count+=1U;`。"
  if (kind === "unary-operator-spacing") return "不要写成 `! ready`、`* ptr`、`& value` 或 `++ count`。"
  if (kind === "binary-operator-spacing") return "不要写成 `(count+offset)>=limit&&ready`。"
  if (kind === "postfix-operator-spacing") return "不要写成 `buffer [index]`、`config .timeout_ms` 或 `handler ()`。"
  if (kind === "pragma-pack-pairing") return "不要只写 `#pragma pack(1)` 而不恢复默认对齐。"
  if (kind === "variable-scope") return "不要在函数开头集中声明所有变量并让临时变量长期暴露。"
  if (kind === "global-state") return "不要让多个文件直接读写同一个可变全局变量。"
  if (kind === "type-definition") return "不要依赖平台相关的 `int` 或 `long` 表达边界敏感数据。"
  if (kind === "literal-constant") return "不要在条件、数组长度或超时逻辑中直接写入无法解释含义的裸数字。"
  if (kind === "operator-precedence") return "不要依赖读者记忆复杂运算符优先级。"
  if (kind === "sizeof-usage") return "不要在变量类型可能变化时写成 `sizeof(buffer_t)`。"
  if (kind === "expression-complexity") return "不要把多个副作用和条件判断压缩到一行表达式中。"
  if (kind === "reentrancy") return "不要在可重入函数中使用内部 static 变量保存进度。"
  if (kind === "external-state-mutability") return "不要在检查状态后假定它不会被中断或其它任务修改。"
  if (kind === "brace-style") return "不要在条件或 else 同一行放置大括号。"
  if (kind === "const-correctness") return "不要让只读输入使用可写指针类型。"
  if (kind === "constant-left-comparison") return "不要在要求左置右值的场景中写 `ptr == NULL` 或 `flag == 0`，更不要误写成赋值表达式。"
  if (kind === "parameter-passing") return "不要对简单标量无故使用指针，也不要让结构体大对象隐式按值复制。"
  if (kind === "pointer-memory") return "不要在未检查指针、长度和容量时执行解引用、索引或 memcpy。"
  if (kind === "integer-type") return "不要依赖隐式转换、未检查乘加运算或有符号/无符号混用来处理边界值。"
  if (kind === "memory-consistency") return "不要只依赖 cache、volatile 或编译器调度来保证共享变量对其它核或主设备立即可见。"
  if (kind === "macro-constant") return "不要使用无前缀宏、魔法数或没有单位说明的常量。"
  if (kind === "comment") return "不要写只重复代码动作、与实现不一致或长期失效的注释。"
  if (kind === "function-design") return "不要把多项职责、隐藏全局依赖和不可观察失败路径塞进同一个函数。"
  return "不要使用无法被评审者直接检查、没有边界说明或没有来源依据的模糊实现。"
}

function rationaleForKind(kind: CRuleSemanticKind) {
  if (kind === "static-analysis") return "检查闭环能把工具信号转化为实际缺陷修复，避免告警噪声掩盖高风险问题。"
  if (kind === "file-layout") return "清晰的接口与实现边界能降低耦合，方便复用、审查和依赖管理。"
  if (kind === "naming") return "可读命名能降低理解成本，减少误用和维护风险。"
  if (kind === "bounded-loop") return "有界等待能保证异常场景可退出、可诊断，符合嵌入式确定性要求。"
  if (kind === "isr") return "短小确定的 ISR 能降低中断延迟和竞态风险。"
  if (kind === "recursion") return "递归深度难以控制，容易造成栈溢出和实时性风险。"
  if (kind === "error-handling") return "明确处理失败路径能防止缺陷被掩盖，并提升系统可恢复性。"
  if (kind === "pointer-null-comparison") return "显式 NULL 比较能让评审者直接识别指针有效性检查，减少跨平台和多人维护时的误读。"
  if (kind === "pointer-operator-spacing") return "一致的指针和地址操作符空格能降低阅读歧义，并减少格式化和评审争议。"
  if (kind === "pointer-initialization") return "初始化指针能降低野指针和未定义行为风险，让错误路径更容易被检查和定位。"
  if (kind === "trailing-whitespace") return "清理行尾留白能让变更聚焦真实语义，降低无效 diff 和格式检查噪声。"
  if (kind === "assignment-operator-spacing") return "一致的赋值空格能提升表达式可读性，也减少格式评审争议。"
  if (kind === "unary-operator-spacing") return "一元操作符紧邻操作数能保持表达式视觉边界清晰。"
  if (kind === "binary-operator-spacing") return "二元运算符空格能降低复杂条件的阅读成本。"
  if (kind === "postfix-operator-spacing") return "后缀运算符紧邻对象符合 C 代码阅读习惯，能减少格式歧义。"
  if (kind === "pragma-pack-pairing") return "成对恢复能防止对齐设置泄漏到后续结构体，降低 ABI 和协议布局风险。"
  if (kind === "variable-scope") return "较小作用域能减少误用和误改，也便于评审确认变量生命周期。"
  if (kind === "global-state") return "减少全局状态能降低并发风险、测试成本和隐藏依赖。"
  if (kind === "type-definition") return "明确类型能降低跨平台宽度差异、截断和协议解析风险。"
  if (kind === "literal-constant") return "有意义常量能让评审者直接理解阈值含义，也便于统一修改和跨模块复用。"
  if (kind === "operator-precedence") return "显式括号能降低误读和非预期求值风险。"
  if (kind === "sizeof-usage") return "sizeof 作用于变量能在类型变化时自动保持一致，减少维护遗漏。"
  if (kind === "expression-complexity") return "拆分表达式能让评审者清楚确认求值顺序和错误路径。"
  if (kind === "reentrancy") return "避免共享状态能降低并发调用和重复调用时的状态污染风险。"
  if (kind === "external-state-mutability") return "外部状态可变会让检查与使用之间产生竞态，重新确认能降低过期判断风险。"
  if (kind === "brace-style") return "统一的大括号风格能提高嵌套代码的扫描效率。"
  if (kind === "const-correctness") return "const 能把接口契约交给编译器检查，并让调用方明确对象不会被修改。"
  if (kind === "constant-left-comparison") return "右值左置能让误写赋值在编译阶段更容易暴露，降低条件表达式错误风险。"
  if (kind === "parameter-passing") return "明确参数传递方式能减少复制成本、空指针风险和接口误用。"
  if (kind === "pointer-memory") return "边界检查能降低空指针、越界和内存破坏风险。"
  if (kind === "integer-type") return "显式类型和范围检查能降低溢出、截断和协议解析错误。"
  if (kind === "memory-consistency") return "共享变量的可见性、原子性和对齐问题会直接影响多核或多主设备场景下的数据一致性。"
  if (kind === "macro-constant") return "清晰常量和枚举能降低冲突、误解和维护成本。"
  if (kind === "comment") return "准确注释能补足代码无法表达的意图、约束和风险。"
  if (kind === "function-design") return "单一职责和明确契约能提升可测试性、可复用性和可维护性。"
  return "明确、可执行的规则有助于团队在评审和落地时保持一致。"
}

function placeholderIssuesForRule(rule: RuleCardSpec) {
  const issues: string[] = []
  if (hasPlaceholderRuleText(rule.description)) issues.push("规则说明")
  if (hasPlaceholderRuleText(rule.rationale)) issues.push("理由")
  if (TEMPLATE_RECOMMENDED_RE.test(rule.recommended ?? "")) issues.push("推荐写法")
  if (TEMPLATE_DISCOURAGED_RE.test(rule.discouraged ?? "")) issues.push("不推荐写法")
  return issues
}

function hasPlaceholderRuleText(value: string | undefined) {
  return Boolean(value && PLACEHOLDER_RULE_TEXT_RE.test(value))
}

function isGovernanceCandidate(rule: CandidateRule) {
  return GOVERNANCE_RE.test(candidateRuleText(rule))
}

function isGovernanceRule(rule: RuleCardSpec) {
  return inferCCodingGuidelineRuleKind(rule) === "governance" || GOVERNANCE_RE.test(`${rule.name} ${rule.scope} ${rule.description}`)
}

function isGenericRuleName(name: string) {
  return GENERIC_RULE_NAME_RE.test(name.replace(/\s+/g, " ").trim())
}

function compatibleSemanticKinds(ruleKind: CRuleSemanticKind, blockKind: CRuleSemanticKind) {
  const groups: CRuleSemanticKind[][] = [
    ["pointer-memory", "dynamic-memory", "undefined-behavior"],
    ["pointer-memory", "pointer-initialization", "undefined-behavior"],
    ["integer-type", "undefined-behavior"],
    ["integer-type", "type-definition", "sizeof-usage", "literal-constant", "operator-precedence"],
    ["static-analysis", "formatting", "checklist"],
    ["formatting", "pointer-operator-spacing", "trailing-whitespace", "assignment-operator-spacing", "unary-operator-spacing", "binary-operator-spacing", "postfix-operator-spacing", "brace-style"],
    ["macro-constant", "literal-constant", "naming"],
    ["volatile-register", "bounded-loop", "determinism", "memory-consistency"],
    ["function-design", "parameter-passing", "error-handling", "reentrancy", "const-correctness"],
    ["global-state", "external-state-mutability", "reentrancy", "memory-consistency"],
  ]
  return groups.some((group) => group.includes(ruleKind) && group.includes(blockKind))
}

function isObviousSemanticMismatch(ruleKind: CRuleSemanticKind, blockKind: CRuleSemanticKind) {
  if (ruleKind === "static-analysis" && blockKind === "file-layout") return true
  if ((ruleKind === "error-handling" || ruleKind === "macro-constant") && (blockKind === "volatile-register" || blockKind === "isr")) return true
  if (ruleKind === "naming" && ["integer-type", "pointer-memory", "error-handling", "volatile-register", "bounded-loop"].includes(blockKind)) return true
  if (ruleKind === "isr" && ["pointer-memory", "error-handling", "file-layout"].includes(blockKind)) return true
  if (ruleKind === "file-layout" && ["integer-type", "pointer-memory", "volatile-register", "isr"].includes(blockKind)) return true
  if (ruleKind === "memory-consistency" && ["error-handling", "pointer-memory", "file-layout", "naming"].includes(blockKind)) return true
  if (ruleKind === "bounded-loop" && ["file-layout", "naming", "macro-constant"].includes(blockKind)) return true
  if (ruleKind === "literal-constant" && ["bounded-loop", "naming", "volatile-register", "file-layout"].includes(blockKind)) return true
  if (ruleKind === "pragma-pack-pairing" && ["file-layout", "static-analysis", "bounded-loop", "naming"].includes(blockKind)) return true
  if (["assignment-operator-spacing", "unary-operator-spacing", "binary-operator-spacing", "postfix-operator-spacing", "trailing-whitespace", "brace-style"].includes(ruleKind)
    && ["pointer-memory", "macro-constant", "file-layout", "bounded-loop", "volatile-register"].includes(blockKind)) return true
  if (ruleKind === "variable-scope" && ["global-state", "file-layout", "macro-constant"].includes(blockKind)) return true
  if (ruleKind === "global-state" && ["variable-scope", "macro-constant", "file-layout"].includes(blockKind)) return true
  if (ruleKind === "type-definition" && ["sizeof-usage", "literal-constant", "file-layout", "naming"].includes(blockKind)) return true
  if (ruleKind === "operator-precedence" && ["assignment-operator-spacing", "binary-operator-spacing", "literal-constant"].includes(blockKind)) return true
  if (ruleKind === "sizeof-usage" && ["type-definition", "literal-constant", "pointer-memory"].includes(blockKind)) return true
  if (ruleKind === "expression-complexity" && ["operator-precedence", "bounded-loop", "naming"].includes(blockKind)) return true
  if (ruleKind === "reentrancy" && ["comment", "macro-constant", "file-layout", "naming"].includes(blockKind)) return true
  if (ruleKind === "external-state-mutability" && ["naming", "file-layout", "macro-constant"].includes(blockKind)) return true
  if (ruleKind === "const-correctness" && ["volatile-register", "file-layout", "macro-constant"].includes(blockKind)) return true
  if (ruleKind === "pointer-null-comparison" && ["pointer-memory", "macro-constant", "file-layout", "naming"].includes(blockKind)) return true
  if (ruleKind === "pointer-operator-spacing" && ["pointer-memory", "macro-constant", "file-layout", "naming", "bounded-loop"].includes(blockKind)) return true
  if (ruleKind === "pointer-initialization" && ["pointer-operator-spacing", "macro-constant", "file-layout", "naming", "bounded-loop"].includes(blockKind)) return true
  if (ruleKind === "constant-left-comparison" && ["macro-constant", "pointer-memory", "file-layout", "naming"].includes(blockKind)) return true
  if (ruleKind === "parameter-passing" && ["comment", "macro-constant", "file-layout", "naming", "bounded-loop"].includes(blockKind)) return true
  return false
}

function inferCSourceBlockSemanticKind(block: SourceBackedBlock) {
  return inferCCodingGuidelineRuleKindFromText(`${block.title ?? ""} ${block.source.headingPath.join(" ")} ${sourceBlockText(block)} ${block.source.neighborTextPreview?.previous ?? ""} ${block.source.neighborTextPreview?.next ?? ""}`)
}

function candidateRuleText(rule: CandidateRule) {
  return `${rule.title} ${rule.category} ${rule.description} ${rule.recommended ?? ""} ${rule.discouraged ?? ""} ${rule.rationale ?? ""} ${rule.exceptions ?? ""} ${rule.sourceSection}`
}

function sourceBlockText(block: SourceBackedBlock) {
  return [
    block.title ?? "",
    block.text ?? "",
    block.items?.join("\n") ?? "",
    block.table ? [block.table.caption ?? "", block.table.headers.join(" | "), ...block.table.rows.map((row) => row.join(" | "))].join("\n") : "",
    block.codeBlock?.code ?? "",
  ].filter(Boolean).join("\n")
}

function sourceBlockLabel(block: SourceBackedBlock) {
  return `${block.source.sourceName ?? block.source.sourcePath} / ${block.source.headingPath.join(" > ") || "未命名章节"}`
}

function normalizeText(input: string) {
  return input.replace(/\s+/g, " ").trim()
}

function semanticIntentMismatch(example: GeneratedExampleSpec) {
  const intent = example.semanticIntent
  if (!intent) return undefined
  const text = normalizeText(`${example.title} ${example.exampleFormat ?? ""} ${example.badExample ?? ""} ${example.goodExample ?? ""} ${example.explanation} ${example.badExampleReason ?? ""}`)
  for (const avoid of intent.mustAvoid ?? []) {
    if (intentAvoidMatched(text, avoid)) return `命中 mustAvoid：${avoid}`
  }
  for (const include of intent.mustInclude ?? []) {
    if (!recognizedIntentNeed(include)) continue
    if (!intentNeedMatched(text, include)) return `缺少 mustInclude：${include}`
  }
  return undefined
}

function recognizedIntentNeed(input: string) {
  return /(?:NULL|零值|空值|显式|隐式|ptr|指针|常量|右值|左置|左侧|==|flag|比较|地址操作符|指针声明|操作符空格|常量名称|宏命名|有意义的常量|传值|传址|值传递|指针传递|参数传递|静态检查|循环有明确上界|初始化|未初始化|野指针)/i.test(input)
}

function intentNeedMatched(text: string, rawNeed: string) {
  const need = rawNeed.toLowerCase()
  if (/(?:指针声明|地址操作符|指针操作符|操作符空格)/i.test(need)) return hasPointerOperatorSpacingExample(text)
  if (/(?:指针初始化|未初始化指针|野指针|初始化为\s*NULL)/i.test(need)) return hasPointerInitializationExample(text)
  if (/(?:常量名称|有意义的常量|宏命名|常量命名|枚举命名)/i.test(need)) return /(?:#define|enum|宏|枚举|常量|SENSOR_[A-Z0-9_]+|MODULE_[A-Z0-9_]+|\b[A-Z][A-Z0-9_]{2,}\b)/i.test(text)
  if (/(?:传值|传址|值传递|指针传递|参数传递)/i.test(need)) return hasParameterPassingExample(text)
  if (/(?:静态检查|扫描|告警|warning|CI|lint|analyzer)/i.test(need)) return /(?:静态|扫描|告警|warning|-Wall|-Wextra|CI|lint|analyzer|偏差记录)/i.test(text)
  if (/(?:循环有明确上界|循环|上界|超时|重试)/i.test(need)) return /(?:while|for|retry|timeout|MAX_|上界|超时|重试|计数)/i.test(text)
  if (/(?:null|零值|空值|指针|ptr|显式)/i.test(need) && /(?:隐式|if\s*\(\s*!?\s*ptr\s*\))/i.test(need)) {
    return hasExplicitNullPointerComparison(text) && hasImplicitPointerCondition(text)
  }
  if (/(?:null|零值|空值|指针|ptr|显式)/i.test(need)) return hasExplicitNullPointerComparison(text)
  if (/(?:隐式|if\s*\(\s*!?\s*ptr\s*\))/i.test(need)) return hasImplicitPointerCondition(text)
  if (/(?:常量|右值|左置|左侧|0\s*==|NULL\s*==|flag|比较)/i.test(need)) return hasConstantLeftComparison(text)
  return text.toLowerCase().includes(need)
}

function intentAvoidMatched(text: string, rawAvoid: string) {
  const avoid = rawAvoid.toLowerCase()
  if (/(?:memcpy|buffer|缓冲)/i.test(avoid)) return /(?:memcpy|buffer|buffer_size)/i.test(text)
  if (/(?:宏命名|宏模板|SENSOR_TIMEOUT|enum|枚举)/i.test(avoid)) return /(?:#define\s+SENSOR_TIMEOUT|typedef\s+enum|SENSOR_STATE)/i.test(text)
  if (/(?:文件布局|\.c|\.h)/i.test(avoid)) return /(?:motor\.c|motor\.h|#include\s+"motor\.h")/i.test(text)
  return text.toLowerCase().includes(avoid)
}

function hasExplicitNullPointerComparison(text: string) {
  return /(?:\bptr\b|\binput\b|\bconfig\b|\bp\b|\w+_ptr)\s*(?:==|!=)\s*NULL|NULL\s*(?:==|!=)\s*(?:\bptr\b|\binput\b|\bconfig\b|\bp\b|\w+_ptr)/i.test(text)
}

function hasImplicitPointerCondition(text: string) {
  return /if\s*\(\s*!?\s*(?:ptr|input|config|p|\w+_ptr)\s*\)/i.test(text)
}

function hasConstantLeftComparison(text: string) {
  return /(?:NULL|0|[A-Z][A-Z0-9_]{1,})\s*==\s*(?:ptr|flag|status|state|result|[a-z_][a-z0-9_]*)/i.test(text)
}

function hasRightSideOrAssignmentComparison(text: string) {
  return /(?:ptr|flag|status|state|result|[a-z_][a-z0-9_]*)\s*==\s*(?:NULL|0|[A-Z][A-Z0-9_]{1,})|if\s*\(\s*(?:ptr|flag|status|state|result|[a-z_][a-z0-9_]*)\s*=\s*(?:NULL|0|[A-Z][A-Z0-9_]{1,})\s*\)/i.test(text)
}

function inferCCodingGuidelineRuleKindForExample(rule: RuleCardSpec, example: GeneratedExampleSpec): CRuleSemanticKind {
  const ruleKind = inferCCodingGuidelineRuleKind(rule)
  const intent = example.semanticIntent
  if (!intent || intent.confidence < 0.65) return ruleKind
  const intentKind = inferCCodingGuidelineRuleKindFromText(`${intent.summary} ${intent.objective} ${intent.mustInclude.join(" ")} ${intent.softHints?.join(" ") ?? ""}`)
  if (intentKind === "generic" || intentKind === "governance" || intentKind === ruleKind) return ruleKind
  if (/^(?:外部参考规则|通用规则|参考规则|未命名规则|规则\s*\d*|候选规则)$/i.test(rule.name.replace(/\s+/g, " ").trim())) return intentKind
  if (ruleKind === "formatting" && FORMAT_DETAIL_KINDS.has(intentKind)) return intentKind
  if (ruleKind === "naming" && (intentKind === "literal-constant" || intentKind === "macro-constant")) return intentKind
  if (ruleKind === "integer-type" && (intentKind === "type-definition" || intentKind === "sizeof-usage" || intentKind === "literal-constant")) return intentKind
  if (ruleKind === "function-design" && (intentKind === "parameter-passing" || intentKind === "reentrancy" || intentKind === "const-correctness")) return intentKind
  if ((ruleKind === "undefined-behavior" || ruleKind === "pointer-memory") && intentKind === "pointer-initialization") return intentKind
  if (ruleKind === "comment" && intentKind === "parameter-passing") return intentKind
  return ruleKind
}

const FORMAT_DETAIL_KINDS = new Set<CRuleSemanticKind>([
  "trailing-whitespace",
  "assignment-operator-spacing",
  "unary-operator-spacing",
  "binary-operator-spacing",
  "postfix-operator-spacing",
  "pointer-operator-spacing",
  "pragma-pack-pairing",
  "brace-style",
])

function hasPointerOperatorSpacingExample(text: string) {
  return /(?:int\s+\*\s*ptr|\*\s*ptr|&\s*value|&\s*[a-z_][a-z0-9_]*)/i.test(text)
    && /(?:int\s+\*\s+ptr|\*\s+ptr|&\s+value|&\s+[a-z_][a-z0-9_]*)/i.test(text)
}

function hasPointerInitializationExample(text: string) {
  return /(?:\w+\s*\*\s*\w+\s*;|\w+\s*\*\s*\w+\s*=\s*(?:NULL|nullptr|&\w+)|\w+\s*\*\s*\w+\s*=\s*\w+)/i.test(text)
    && /(?:\w+\s*\*\s*\w+\s*=\s*(?:NULL|nullptr|&\w+)|\bNULL\b|未初始化|uninitialized)/i.test(text)
    && /(?:if\s*\(\s*\w+\s*(?:!=|==)\s*NULL\s*\)|解引用|use_value|read_value|\*\s*\w+)/i.test(text)
}

function hasParameterPassingExample(text: string) {
  return /(?:uint32_t\s+\w+|bool\s+\w+|int\s+\w+)/i.test(text)
    && /(?:const\s+\w+_t\s*\*|const\s+struct\s+\w+\s*\*|\w+_t\s*\*\s*\w+)/i.test(text)
}

function error(code: string, message: string): QualityIssue {
  return { severity: "error", code, message }
}
