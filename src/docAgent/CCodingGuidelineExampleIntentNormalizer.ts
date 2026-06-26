import { inferCCodingGuidelineRuleKind, type CRuleSemanticKind } from "./CCodingGuidelineQuality"
import {
  inferSemanticKindFromText,
  normalizeIntentNeedForSemanticKind,
  normalizedExampleFormatForSemanticKind,
} from "./CCodingGuidelineSemanticRegistry"
import type { RuleExampleIntent } from "./CCodingGuidelineExampleIntentPlanner"
import type { RuleCardSpec } from "./types"

export type NormalizedRuleExampleIntent = RuleExampleIntent & {
  softHints?: string[]
}

export type RuleExampleIntentNormalization = {
  rule: RuleCardSpec
  intent?: NormalizedRuleExampleIntent
  warnings: string[]
}

const GENERIC_RULE_NAME_RE = /^(?:外部参考规则|通用规则|参考规则|未命名规则|规则\s*\d*|候选规则)$/i

export function normalizeRuleExampleIntentForRule(rule: RuleCardSpec, intent: RuleExampleIntent | undefined): RuleExampleIntentNormalization {
  if (!intent) return { rule, warnings: [] }
  const warnings: string[] = []
  const ruleKind = inferCCodingGuidelineRuleKind(rule)
  const intentKind = inferIntentKind(intent)
  const effectiveKind = effectiveIntentKind(rule, ruleKind, intentKind, intent.confidence)
  const mustInclude: string[] = []
  const softHints: string[] = []

  for (const need of intent.mustInclude) {
    const normalizedNeed = normalizeHardIntentNeed(need, effectiveKind)
    if (normalizedNeed) {
      mustInclude.push(normalizedNeed)
    } else {
      softHints.push(need)
    }
  }

  const repairedRule = repairGenericRuleFromIntent(rule, effectiveKind, intent, warnings)
  return {
    rule: repairedRule,
    intent: {
      ...intent,
      exampleFormat: normalizedExampleFormat(intent.exampleFormat, effectiveKind),
      mustInclude: [...new Set(mustInclude)],
      softHints: [...new Set(softHints)],
    },
    warnings,
  }
}

function effectiveIntentKind(rule: RuleCardSpec, ruleKind: CRuleSemanticKind, intentKind: CRuleSemanticKind, confidence: number): CRuleSemanticKind {
  if (intentKind === "generic" || intentKind === "governance") return ruleKind
  if (ruleKind === intentKind) return ruleKind
  if (isGenericRuleName(rule.name) && confidence >= 0.7) return intentKind
  if ((ruleKind === "undefined-behavior" || ruleKind === "pointer-memory") && intentKind === "pointer-initialization") return intentKind
  if (ruleKind === "formatting" && FORMAT_DETAIL_KINDS.has(intentKind)) return intentKind
  if (ruleKind === "naming" && (intentKind === "literal-constant" || intentKind === "macro-constant")) return intentKind
  if (ruleKind === "integer-type" && (intentKind === "type-definition" || intentKind === "sizeof-usage" || intentKind === "literal-constant")) return intentKind
  if (ruleKind === "function-design" && (intentKind === "parameter-passing" || intentKind === "reentrancy")) return intentKind
  if (ruleKind === "determinism" && (intentKind === "bounded-loop" || intentKind === "external-state-mutability")) return intentKind
  if (ruleKind === "comment" && intentKind === "parameter-passing") return intentKind
  if (ruleKind === "generic" && confidence >= 0.6) return intentKind
  return ruleKind
}

function normalizeHardIntentNeed(input: string, kind: CRuleSemanticKind) {
  return normalizeIntentNeedForSemanticKind(input, kind)
}

function normalizedExampleFormat(format: RuleExampleIntent["exampleFormat"], kind: CRuleSemanticKind): RuleExampleIntent["exampleFormat"] {
  return normalizedExampleFormatForSemanticKind(format, kind) ?? format ?? "code"
}

function repairGenericRuleFromIntent(rule: RuleCardSpec, kind: CRuleSemanticKind, intent: RuleExampleIntent, warnings: string[]): RuleCardSpec {
  if (!isGenericRuleName(rule.name) || intent.confidence < 0.7) return rule
  const repair = genericRuleRepair(kind)
  if (!repair) return rule
  warnings.push(`规则 ${rule.ruleId}「${rule.name}」名称过于泛化，已根据模型示例意图修正为「${repair.name}」。`)
  return {
    ...rule,
    ...repair,
  }
}

function genericRuleRepair(kind: CRuleSemanticKind): Partial<RuleCardSpec> | undefined {
  if (kind === "literal-constant") {
    return {
      name: "非平凡数字必须定义为有意义常量",
      scope: "字面量、宏和枚举常量",
      description: "非平凡数字应抽取为具有模块前缀、含义和单位的常量，避免在表达式中直接出现裸数字。",
      recommended: "使用模块前缀和单位后缀定义常量，例如 `SENSOR_MAX_SAMPLE_COUNT`。",
      discouraged: "不要在条件、数组长度或超时逻辑中直接写入无法解释含义的裸数字。",
      rationale: "有意义常量能让评审者直接理解阈值含义，也便于统一修改和跨模块复用。",
    }
  }
  if (kind === "trailing-whitespace") {
    return {
      name: "禁止行尾无意义留白",
      scope: "代码、注释和空白行",
      description: "源文件中不应保留行尾空格或制表符，避免产生无意义 diff 和格式检查噪声。",
      recommended: "保存前自动删除行尾空白，并在格式检查中拦截新增行尾留白。",
      discouraged: "不要提交只包含行尾空白变化的代码。",
      rationale: "清理行尾留白能让变更聚焦真实语义，降低评审噪声。",
    }
  }
  if (kind === "assignment-operator-spacing") {
    return {
      name: "赋值运算符前后必须保留空格",
      scope: "赋值表达式",
      description: "赋值和复合赋值运算符两侧应保留一个空格，便于识别写入目标和值来源。",
      recommended: "写成 `status = read_status();` 和 `count += 1U;`。",
      discouraged: "不要写成 `status=read_status();` 或 `count+=1U;`。",
      rationale: "一致的赋值空格能提升表达式可读性，也减少格式评审争议。",
    }
  }
  if (kind === "unary-operator-spacing") {
    return {
      name: "一元操作符必须紧邻操作数",
      scope: "逻辑非、解引用、取地址和自增自减表达式",
      description: "一元操作符和操作数之间不应插入空格。",
      recommended: "写成 `!ready`、`*ptr`、`&value`、`++count`。",
      discouraged: "不要写成 `! ready`、`* ptr`、`& value`、`++ count`。",
      rationale: "一元操作符紧邻操作数能保持表达式视觉边界清晰。",
    }
  }
  if (kind === "binary-operator-spacing") {
    return {
      name: "二元运算符前后必须保留空格",
      scope: "算术、关系和逻辑表达式",
      description: "二元运算符两侧应保留一个空格，使表达式层次清晰。",
      recommended: "写成 `(count + offset) >= limit && ready`。",
      discouraged: "不要写成 `(count+offset)>=limit&&ready`。",
      rationale: "统一的二元运算符空格能降低复杂条件的阅读成本。",
    }
  }
  if (kind === "postfix-operator-spacing") {
    return {
      name: "后缀运算符必须紧邻对象",
      scope: "数组下标、成员访问和函数调用",
      description: "数组下标、成员访问和函数调用与对象之间不应插入空格。",
      recommended: "写成 `buffer[index]`、`config.timeout_ms`、`handler()`。",
      discouraged: "不要写成 `buffer [index]`、`config .timeout_ms`、`handler ()`。",
      rationale: "后缀运算符紧邻对象符合 C 代码阅读习惯，能减少格式歧义。",
    }
  }
  if (kind === "pragma-pack-pairing") {
    return {
      name: "#pragma pack 必须成对恢复",
      scope: "结构体对齐控制",
      description: "修改结构体对齐方式时必须在局部范围内成对恢复，避免影响后续类型布局。",
      recommended: "使用 `#pragma pack(push, 1)` 和 `#pragma pack(pop)` 包裹受影响结构体。",
      discouraged: "不要只写 `#pragma pack(1)` 而不恢复默认对齐。",
      rationale: "成对恢复能防止对齐设置泄漏到后续结构体，降低 ABI 和协议布局风险。",
    }
  }
  if (kind === "variable-scope") {
    return {
      name: "变量作用域必须尽量小",
      scope: "局部变量声明和循环变量",
      description: "变量应在首次使用附近声明，并尽量限制在最小作用域内。",
      recommended: "循环计数器在 `for` 语句内声明，临时变量靠近使用点。",
      discouraged: "不要在函数开头集中声明所有变量并长期暴露在整个函数作用域。",
      rationale: "较小作用域能减少误用和误改，也便于评审确认变量生命周期。",
    }
  }
  if (kind === "global-state") {
    return {
      name: "应减少可变全局状态",
      scope: "全局变量、静态全局变量和跨文件状态",
      description: "可变全局状态应尽量封装或通过上下文对象传递，避免扩大影响范围。",
      recommended: "使用模块上下文结构体、访问器或局部状态传递。",
      discouraged: "不要让多个文件直接读写同一个可变全局变量。",
      rationale: "减少全局状态能降低并发风险、测试成本和隐藏依赖。",
    }
  }
  if (kind === "type-definition") {
    return {
      name: "边界敏感数据必须使用明确类型",
      scope: "协议字段、计数、索引和超时值",
      description: "与边界、协议或硬件相关的数据应使用固定宽度类型或团队定义的语义类型。",
      recommended: "使用 `uint32_t`、`size_t` 或 `typedef` 语义类型表达字段含义。",
      discouraged: "不要依赖平台相关的 `int`、`long` 表达边界敏感数据。",
      rationale: "明确类型能降低跨平台宽度差异、截断和协议解析风险。",
    }
  }
  if (kind === "operator-precedence") {
    return {
      name: "不确定优先级时必须使用括号",
      scope: "混合运算表达式",
      description: "混合位运算、比较、逻辑和算术运算时，应使用括号明确求值分组。",
      recommended: "写成 `(flags & READY_MASK) == 0U`。",
      discouraged: "不要依赖读者记忆复杂运算符优先级。",
      rationale: "显式括号能降低误读和非预期求值风险。",
    }
  }
  if (kind === "sizeof-usage") {
    return {
      name: "sizeof 应优先作用于变量对象",
      scope: "内存初始化、拷贝和数组长度计算",
      description: "计算对象大小时优先使用变量对象而不是类型名。",
      recommended: "写成 `sizeof(buffer)`。",
      discouraged: "不要在变量类型可能变化时写成 `sizeof(buffer_t)`。",
      rationale: "sizeof 作用于变量能在类型变化时自动保持一致，减少维护遗漏。",
    }
  }
  if (kind === "expression-complexity") {
    return {
      name: "复杂表达式必须拆分为简单语句",
      scope: "条件、赋值和带副作用表达式",
      description: "包含多重条件、副作用或嵌套三目运算的表达式应拆分为简单语句。",
      recommended: "使用临时变量和明确分支表达执行顺序。",
      discouraged: "不要把多个副作用和条件判断压缩到一行表达式中。",
      rationale: "拆分表达式能让评审者清楚确认求值顺序和错误路径。",
    }
  }
  if (kind === "reentrancy") {
    return {
      name: "可重入函数不得依赖共享可变状态",
      scope: "可重入函数和公共工具函数",
      description: "可重入函数应避免内部静态状态或全局状态，必要状态由调用方显式传入。",
      recommended: "使用局部变量或上下文对象保存调用状态。",
      discouraged: "不要在可重入函数中使用内部 static 变量保存进度。",
      rationale: "避免共享状态能降低并发调用和重复调用时的状态污染风险。",
    }
  }
  if (kind === "external-state-mutability") {
    return {
      name: "外部可变状态使用前必须重新确认",
      scope: "异步状态、中断更新状态和共享状态",
      description: "可能被外部上下文修改的状态不能长期假定不变，使用前应获取快照或在保护区内重新确认。",
      recommended: "读取状态快照，并在临界区或锁保护下再次确认关键条件。",
      discouraged: "不要在检查状态后假定它不会被中断或其它任务修改。",
      rationale: "外部状态可变会让检查与使用之间产生竞态，重新确认能降低过期判断风险。",
    }
  }
  if (kind === "const-correctness") {
    return {
      name: "只读输入参数必须使用 const",
      scope: "函数接口参数",
      description: "函数不会修改的输入对象应通过 const 指针表达只读语义。",
      recommended: "使用 `const sensor_config_t *config` 表示只读输入。",
      discouraged: "不要让只读输入使用可写指针类型。",
      rationale: "const 能把接口契约交给编译器检查，并让调用方明确对象不会被修改。",
    }
  }
  if (kind === "brace-style") {
    return {
      name: "程序块分界符必须独占一行",
      scope: "条件、循环和函数程序块",
      description: "大括号应按照团队风格独占一行，使程序块边界清晰。",
      recommended: "将 `{` 和 `}` 放在独立行并保持缩进一致。",
      discouraged: "不要在条件或 else 同一行放置大括号。",
      rationale: "统一的大括号风格能提高嵌套代码的扫描效率。",
    }
  }
  if (kind === "macro-constant") {
    return {
      name: "常量名称必须表达业务含义",
      scope: "宏、枚举和常量命名",
      description: "宏、枚举和常量名称应体现模块、含义和单位，避免使用缺少上下文的通用名称。",
      recommended: "使用模块前缀、语义名和单位后缀定义常量，例如 `SENSOR_TIMEOUT_MS`。",
      discouraged: "不要使用 `TIMEOUT`、`FLAG` 这类缺少模块和单位信息的常量名。",
      rationale: "有语义的常量名称能减少跨模块冲突和误用，也能让评审者直接理解取值含义。",
    }
  }
  if (kind === "pointer-operator-spacing") {
    return {
      name: "指针和地址操作符周围空格必须一致",
      scope: "指针声明和地址操作表达式",
      description: "指针声明、解引用和取地址表达式应按团队约定放置空格，避免操作符与变量名之间出现歧义。",
      recommended: "指针声明使用 `int *ptr`，取地址和解引用使用 `&value`、`*ptr`，不要在操作符后插入多余空格。",
      discouraged: "不要写成 `int * ptr`、`& value` 或 `* ptr`。",
      rationale: "一致的指针和地址操作符空格能降低阅读歧义，并减少格式化和评审争议。",
    }
  }
  if (kind === "pointer-initialization") {
    return {
      name: "声明指针时必须初始化",
      scope: "指针声明和使用",
      description: "指针变量声明时必须初始化为 NULL 或有效对象地址，避免未初始化指针被误用。",
      recommended: "声明指针时立即初始化为 `NULL` 或有效对象地址，并在解引用前确认指针有效。",
      discouraged: "不要声明未初始化指针，也不要在赋值前解引用或传递该指针。",
      rationale: "初始化指针能降低野指针和未定义行为风险，让错误路径更容易被检查和定位。",
    }
  }
  if (kind === "parameter-passing") {
    return {
      name: "函数接口必须明确传值还是传址",
      scope: "函数接口参数设计",
      description: "函数参数应明确表达按值传递、只读指针、输出指针或可选指针的语义。",
      recommended: "简单标量参数使用传值；结构体、可选对象或输出参数使用指针，并用 `const` 标明只读输入。",
      discouraged: "不要对简单标量无故使用指针，也不要让结构体大对象隐式按值复制。",
      rationale: "明确参数传递方式能减少复制成本、空指针风险和接口误用。",
    }
  }
  return undefined
}

function isGenericRuleName(name: string) {
  return GENERIC_RULE_NAME_RE.test(name.replace(/\s+/g, " ").trim())
}

function intentText(intent: RuleExampleIntent) {
  return [
    intent.semanticSummary,
    intent.exampleObjective,
    intent.badExampleFocus,
    intent.goodExampleFocus,
    intent.mustInclude.join(" "),
  ].join(" ")
}

function inferIntentKind(intent: RuleExampleIntent): CRuleSemanticKind {
  return inferSemanticKindFromText(intentText(intent))
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
