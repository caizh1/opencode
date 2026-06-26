import type { CRuleSemanticKind } from "./CCodingGuidelineQuality"
import type { GeneratedExampleSpec } from "./types"

type RuleExamplePayload = Pick<GeneratedExampleSpec, "language" | "exampleType" | "exampleFormat" | "badExample" | "badExampleReason" | "goodExample">

type SemanticContract = {
  kind: CRuleSemanticKind
  positive: Array<[RegExp, number]>
  negative?: RegExp[]
  allowedFormats?: Array<NonNullable<GeneratedExampleSpec["exampleFormat"]>>
  defaultFormat?: NonNullable<GeneratedExampleSpec["exampleFormat"]>
  exampleType?: string
  normalizeNeed?: (need: string) => string | undefined
  validate?: (text: string, example: GeneratedExampleSpec) => string | undefined
  fallback?: RuleExamplePayload
}

const CONTRACTS: SemanticContract[] = [
  {
    kind: "governance",
    positive: [[/(?:版权边界|版权|行业合规|合规|项目裁剪|专属版本|生成专属规范|风险、?限制|后续完善|治理|文档版本|落地路线图)/i, 8]],
  },
  {
    kind: "static-analysis",
    positive: [[/(?:静态检查|静态分析|编译警告|告警|warning|analyzer|lint|cppcheck|clang-tidy|CI|流水线|检查集|高风险模块)/i, 7]],
    allowedFormats: ["checklist", "text"],
    defaultFormat: "checklist",
    exampleType: "checklist",
    normalizeNeed: (need) => /(?:静态|扫描|告警|warning|CI|lint|analyzer)/i.test(need) ? "静态检查闭环" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "checklist" && example.exampleFormat !== "text") return "静态检查规则应使用 checklist 或 text 示例"
      if (!/(?:静态|扫描|scan|检查|告警|编译器警告|warning(?:\s*level)?|-Wall|-Wextra|CI|lint|analyzer|工具|配置|闭环|偏差记录)/i.test(text)) return "缺少静态扫描、告警解释或 CI 闭环语义"
      if (/(?:motor\.h|motor\.c|#include\s+"motor\.h")/i.test(text)) return "静态检查规则不应使用文件布局示例"
      return undefined
    },
    fallback: {
      exampleType: "checklist",
      exampleFormat: "checklist",
      badExample: "- 只在本地偶尔运行扫描\n- 编译器警告只看数量，不解释告警原因\n- 新增 warning 不记录、不修复",
      badExampleReason: "扫描和警告没有进入闭环，告警原因无人解释，工具信号无法转化为缺陷修复。",
      goodExample: "- CI 开启 -Wall/-Wextra 或团队约定 warning level\n- 新增告警必须解释原因并修复\n- 不能立即修复的告警记录偏差理由、责任人和关闭时间",
    },
  },
  {
    kind: "pointer-initialization",
    positive: [
      [/(?:(?:声明.*指针|指针.*声明|指针).*(?:初始化|初始值)|未初始化指针|野指针|悬空指针|uninitialized\s+pointer|dangling\s+pointer)/i, 12],
      [/(?:初始化|未初始化|野指针|悬空指针|uninitialized|dangling)/i, 4],
    ],
    negative: [/(?:操作符|运算符|空格|int\s+\*\s+ptr|&\s+value)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:初始化|未初始化|野指针|悬空指针|uninitialized|dangling)/i.test(need) ? "指针初始化" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "指针初始化规则应使用 code 示例"
      if (!hasPointerInitializationExample(text)) return "缺少未初始化指针反例和 NULL 或有效地址初始化正例"
      if (hasPointerOperatorSpacingExample(text)) return "指针初始化规则不应使用操作符空格对比示例"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "sensor_state_t *state;\n\nif (sensor_is_ready()) {\n    update_state(state);\n}",
      badExampleReason: "指针声明后未初始化，后续一旦被传递或解引用，就可能访问随机地址并触发未定义行为。",
      goodExample: "sensor_state_t *state = NULL;\n\nif (sensor_is_ready()) {\n    state = sensor_get_state();\n}\nif (state != NULL) {\n    update_state(state);\n}",
    },
  },
  {
    kind: "pointer-operator-spacing",
    positive: [[/(?:指针|地址).*(?:操作符|运算符|空格)|(?:地址操作符|指针操作符)|(?:\*|&).*(?:空格|space)/i, 12]],
    negative: [/(?:初始化|未初始化|野指针|NULL|零值|空值|memcpy|buffer|数组下标|成员运算符|函数调用)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:地址操作符|指针操作符|操作符空格|运算符空格|\*\s*ptr|&\s*value|指针声明.*(?:空格|操作符|运算符)|(?:空格|操作符|运算符).*指针声明)/i.test(need) ? "指针或地址操作符空格对比" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "指针或地址操作符空格规则应使用 code 示例"
      if (!hasPointerOperatorSpacingExample(text)) return "缺少指针或地址操作符空格对比"
      if (/(?:memcpy|buffer_size|SENSOR_TIMEOUT|typedef\s+enum)/i.test(text)) return "指针操作符空格规则不应使用缓冲区或宏命名模板"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "int * ptr;\nuint32_t value = * ptr;\nstatus = read_register(& value);",
      badExampleReason: "指针或地址操作符后插入多余空格，容易让声明、解引用和取地址表达式的视觉边界变得不一致。",
      goodExample: "int *ptr;\nuint32_t value = *ptr;\nstatus = read_register(&value);",
    },
  },
  {
    kind: "trailing-whitespace",
    positive: [[/(?:行尾|尾部).*(?:空白|空格|留白)|(?:无意义留白|多余空白|trailing whitespace|horizontal whitespace|水平留白)/i, 12]],
    allowedFormats: ["text", "checklist"],
    defaultFormat: "text",
    exampleType: "bad-good-pair",
    normalizeNeed: (need) => /(?:行尾|尾部|水平留白|无意义留白|trailing)/i.test(need) ? "行尾无意义留白" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "text" && example.exampleFormat !== "checklist") return "行尾留白规则应使用 text 或 checklist 示例"
      if (!/(?:行尾|尾部|留白|空白|空格|trailing|␠|可见标记)/i.test(text)) return "缺少行尾无意义留白语义"
      if (/(?:memcpy|buffer|motor\.h|#define\s+SENSOR_TIMEOUT)/i.test(text)) return "行尾留白规则不应使用无关代码模板"
      return undefined
    },
    fallback: {
      exampleType: "bad-good-pair",
      exampleFormat: "text",
      badExample: "不推荐：语句末尾保留看不见的空格，例如 `return status;␠␠`。",
      badExampleReason: "行尾无意义留白会制造无效 diff，也会让格式检查和代码评审关注到非语义变更。",
      goodExample: "推荐：保存前删除行尾空白，让提交只包含真实代码或注释变更。",
    },
  },
  {
    kind: "assignment-operator-spacing",
    positive: [[/(?:赋值运算符|赋值操作符|=).*(?:前后|两侧).*(?:空格|space)|(?:空格|space).*(?:赋值运算符|赋值操作符)/i, 12]],
    negative: [/(?:==|相等比较|左置|指针|地址|一元|二元|数组下标|成员运算符|函数调用)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:赋值|=|前后空格|两侧空格)/i.test(need) ? "赋值运算符前后空格" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "赋值空格规则应使用 code 示例"
      if (!hasAssignmentSpacingExample(text)) return "缺少赋值运算符前后空格对比"
      if (/(?:memcpy|buffer|motor\.h|#pragma)/i.test(text)) return "赋值空格规则不应使用无关模板"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "status=read_status();\nretry_count+=1U;",
      badExampleReason: "赋值类运算符两侧没有空格，连续表达式中不易快速识别写入目标和值来源。",
      goodExample: "status = read_status();\nretry_count += 1U;",
    },
  },
  {
    kind: "unary-operator-spacing",
    positive: [[/(?:一元|单目).*(?:操作符|运算符).*(?:空格|space)|(?:!|~|\+\+|--|\*|&).*(?:变量|操作数).*(?:不加空格|紧邻)/i, 12]],
    negative: [/(?:赋值|二元|多目|数组下标|成员运算符|函数调用|NULL|初始化)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:一元|单目|!|~|\+\+|--|不加空格|紧邻)/i.test(need) ? "一元操作符与操作数紧邻" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "一元操作符空格规则应使用 code 示例"
      if (!hasUnaryOperatorSpacingExample(text)) return "缺少一元操作符与操作数空格对比"
      if (/(?:SENSOR_TIMEOUT|typedef\s+enum|motor\.h)/i.test(text)) return "一元操作符规则不应使用常量命名或文件布局模板"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "if (! ready) {\n    value = * ptr;\n    ++ count;\n}",
      badExampleReason: "一元操作符和操作数之间插入空格，会让逻辑非、解引用和自增表达式的视觉边界不一致。",
      goodExample: "if (!ready) {\n    value = *ptr;\n    ++count;\n}",
    },
  },
  {
    kind: "binary-operator-spacing",
    positive: [[/(?:二元|多目|双目).*(?:操作符|运算符).*(?:前后|两侧).*(?:空格|space)|(?:\+|-|\*|\/|>=|<=|&&|\|\|).*(?:前后|两侧).*(?:空格|space)/i, 12]],
    negative: [/(?:一元|单目|赋值运算符|数组下标|成员运算符|函数调用|优先级|括号)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:二元|多目|双目|前后空格|两侧空格|\+|>=|&&|\|\|)/i.test(need) ? "二元运算符前后空格" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "二元运算符空格规则应使用 code 示例"
      if (!hasBinaryOperatorSpacingExample(text)) return "缺少二元运算符前后空格对比"
      if (/(?:memcpy|motor\.h|#pragma|typedef\s+enum)/i.test(text)) return "二元运算符规则不应使用无关模板"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "if ((count+offset)>=limit&&ready) {\n    total=total+count;\n}",
      badExampleReason: "二元运算符两侧缺少空格，会降低表达式层次和条件组合的可读性。",
      goodExample: "if ((count + offset) >= limit && ready) {\n    total = total + count;\n}",
    },
  },
  {
    kind: "postfix-operator-spacing",
    positive: [[/(?:数组下标|成员运算符|函数调用|后缀操作符|后缀运算符|\[\s*\]|->|\.).*(?:紧邻|不加空格|空格)/i, 12]],
    negative: [/(?:一元|二元|赋值|指针声明|NULL|初始化)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:数组下标|成员运算符|函数调用|后缀|紧邻|\[\]|->|\.)/i.test(need) ? "后缀运算符紧邻对象" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "后缀运算符空格规则应使用 code 示例"
      if (!hasPostfixOperatorSpacingExample(text)) return "缺少数组下标、成员运算符或函数调用空格对比"
      if (/(?:memcpy|SENSOR_TIMEOUT|#pragma)/i.test(text)) return "后缀运算符规则不应使用无关模板"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "value = buffer [index];\nconfig .timeout_ms = timeout_ms;\nhandler ();",
      badExampleReason: "数组下标、成员访问和函数调用与对象之间出现多余空格，会破坏常见 C 表达式的阅读习惯。",
      goodExample: "value = buffer[index];\nconfig.timeout_ms = timeout_ms;\nhandler();",
    },
  },
  {
    kind: "pragma-pack-pairing",
    positive: [[/(?:#pragma\s+pack|pragma\s+pack|结构体对齐|字节对齐|pack\s*\(|pack\s+成对|成对恢复)/i, 13]],
    negative: [/(?:文件布局|源文件|头文件|静态检查|循环|命名)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:pragma|pack|成对|恢复|对齐)/i.test(need) ? "#pragma pack 成对恢复" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "#pragma pack 规则应使用 code 示例"
      if (!hasPragmaPackPairingExample(text)) return "缺少 #pragma pack 成对设置和恢复示例"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "#pragma pack(1)\ntypedef struct {\n    uint8_t type;\n    uint32_t value;\n} frame_t;",
      badExampleReason: "#pragma pack 修改了后续结构体对齐方式却没有恢复，可能影响同文件后续类型布局。",
      goodExample: "#pragma pack(push, 1)\ntypedef struct {\n    uint8_t type;\n    uint32_t value;\n} frame_t;\n#pragma pack(pop)",
    },
  },
  {
    kind: "formatting",
    positive: [[/(?:格式化|排版|缩进|空格|对齐|format|formatter|clang-format)/i, 4]],
    negative: [/(?:行尾|尾部|赋值运算符|一元|单目|二元|多目|数组下标|成员运算符|函数调用|#pragma|pack|大括号|程序块)/i],
    allowedFormats: ["checklist", "text"],
    defaultFormat: "checklist",
    exampleType: "checklist",
    validate: (text) => /(?:格式|缩进|空格|对齐|format|clang-format)/i.test(text) ? undefined : "缺少格式化或排版语义",
    fallback: {
      exampleType: "checklist",
      exampleFormat: "checklist",
      badExample: "- 不同文件手工排版风格不一致\n- 评审中反复讨论缩进、空格和换行",
      badExampleReason: "格式问题占用评审注意力，且不同风格会降低代码扫描和维护效率。",
      goodExample: "- 使用团队统一格式化配置\n- 提交前自动运行格式检查\n- Code Review 只讨论规则例外和可读性问题",
    },
  },
  {
    kind: "isr",
    positive: [[/(?:ISR|中断服务|中断处理|interrupt service|irq)/i, 12]],
    negative: [/(?:memcpy|buffer|malloc|头文件|命名)/i],
    allowedFormats: ["code", "checklist"],
    defaultFormat: "code",
    validate: (text) => /(?:ISR|中断|irq|interrupt|defer|标志|延后)/i.test(text) && !/(?:memcpy|buffer|malloc)/i.test(text) ? undefined : "缺少 ISR 短小延后处理语义或包含无关模板",
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "void UART_IRQHandler(void)\n{\n    parse_packet();\n    write_log();\n}",
      badExampleReason: "中断服务函数中执行复杂解析和日志输出，会拉长中断占用时间并增加竞态风险。",
      goodExample: "volatile bool uart_rx_pending;\n\nvoid UART_IRQHandler(void)\n{\n    clear_uart_irq();\n    uart_rx_pending = true;\n}\n\nvoid uart_task(void)\n{\n    if (uart_rx_pending) {\n        uart_rx_pending = false;\n        parse_packet();\n    }\n}",
    },
  },
  {
    kind: "constant-left-comparison",
    positive: [[/(?:相等|==|比较).*(?:左置|左侧|右值|常量|宏)|(?:左置右值|右值左置|常量左置|宏左置|Yoda condition)/i, 9]],
    negative: [/(?:宏命名|常量名称|枚举命名|SENSOR_TIMEOUT_MS|typedef\s+enum|memcpy|buffer)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:常量|右值|左置|左侧|0\s*==|NULL\s*==|flag|比较)/i.test(need) ? "常量左置比较" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "常量左置比较规则应使用 code 示例"
      if (!hasConstantLeftComparison(text) || !hasRightSideOrAssignmentComparison(text)) return "缺少常量左置正例和右置或误赋值反例"
      if (/(?:#define\s+SENSOR_TIMEOUT|typedef\s+enum|SENSOR_STATE|memcpy|buffer_size)/i.test(text)) return "常量左置比较规则不应使用宏命名或缓冲区模板"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "if (ptr == NULL) {\n    return -EINVAL;\n}\nif (flag = 0) {\n    reset_state();\n}",
      badExampleReason: "右值放在右侧时，条件表达式更容易被误写成赋值；`flag = 0` 会改变变量并造成判断语义错误。",
      goodExample: "if (NULL == ptr) {\n    return -EINVAL;\n}\nif (0 == flag) {\n    reset_state();\n}",
    },
  },
  {
    kind: "macro-constant",
    positive: [
      [/(?:宏|枚举|常量|魔法数|macro|enum|constant|define|magic number|模块前缀)/i, 6],
      [/(?:常量名称|有意义的常量|宏命名|常量命名|枚举命名)/i, 6],
    ],
    negative: [/(?:循环|轮询|上界|有界|超时退出|retry_count|MAX_RETRY_COUNT|volatile|寄存器|非平凡数字|字面量|魔法数规范)/i],
    allowedFormats: ["code", "naming-pair"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:常量名称|有意义的常量|宏命名|常量命名|枚举命名|模块前缀|单位)/i.test(need) ? "定义有意义的常量名称" : undefined,
    validate: (text) => {
      if (!/(?:#define|enum|宏|枚举|常量|magic|MODULE_[A-Z0-9_]+|SENSOR_[A-Z0-9_]+|\b[A-Z][A-Z0-9_]{2,}\b)/i.test(text)) return "缺少宏、枚举或常量命名示例"
      if (/(?:volatile|寄存器|interrupt|MAX_RETRY_COUNT|ETIMEDOUT)/i.test(text)) return "宏常量规则不应使用 volatile 或循环上界模板"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "#define TIMEOUT 1000\n#define FLAG 1",
      badExampleReason: "宏名缺少模块前缀、单位和取值语义，容易与其他模块冲突，也无法从名称判断数值含义。",
      goodExample: "#define SENSOR_TIMEOUT_MS (1000U)\n\ntypedef enum {\n    SENSOR_STATE_IDLE = 0,\n    SENSOR_STATE_ACTIVE = 1,\n} sensor_state_t;",
    },
  },
  {
    kind: "literal-constant",
    positive: [
      [/(?:字面量|非平凡数字|魔法数|裸数字|literal|magic number|有意义的常量名称|定义有意义的常量名称)/i, 14],
      [/(?:define|enum|常量).*(?:意义|单位|名称)/i, 8],
    ],
    negative: [/(?:循环|轮询|上界|retry|volatile|寄存器|一元|二元|赋值空格)/i],
    allowedFormats: ["code", "naming-pair"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:非平凡数字|魔法数|字面量|裸数字|有意义的常量名称|定义有意义的常量名称|单位)/i.test(need) ? "非平凡数字使用有意义常量" : undefined,
    validate: (text) => {
      if (!hasLiteralConstantExample(text)) return "缺少魔法数反例和有意义常量正例"
      if (/(?:MAX_RETRY_COUNT|while|ETIMEDOUT|volatile|status_reg)/i.test(text)) return "字面量规则不应使用循环上界或 volatile 模板"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "if (sample_count > 128U) {\n    return -ERANGE;\n}",
      badExampleReason: "非平凡数字直接写在表达式里，读者无法从上下文判断它代表缓冲区容量、协议限制还是经验阈值。",
      goodExample: "#define SENSOR_MAX_SAMPLE_COUNT (128U)\n\nif (sample_count > SENSOR_MAX_SAMPLE_COUNT) {\n    return -ERANGE;\n}",
    },
  },
  {
    kind: "variable-scope",
    positive: [[/(?:变量).*(?:最小作用域|作用域最小|就近声明|声明位置)|(?:最小作用域|就近声明|scope).*(?:变量|variable)/i, 12]],
    negative: [/(?:全局|静态全局|跨文件|extern|可重入)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:最小作用域|就近声明|作用域)/i.test(need) ? "变量最小作用域" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "变量作用域规则应使用 code 示例"
      if (!hasVariableScopeExample(text)) return "缺少变量就近声明或最小作用域对比"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "int status;\nuint32_t index;\n\nstatus = sensor_prepare();\nfor (index = 0U; index < count; index++) {\n    process(buffer[index]);\n}",
      badExampleReason: "变量过早声明，作用域大于实际使用范围，容易被后续代码误用或修改。",
      goodExample: "int status = sensor_prepare();\nfor (uint32_t index = 0U; index < count; index++) {\n    process(buffer[index]);\n}",
    },
  },
  {
    kind: "global-state",
    positive: [[/(?:静态全局|全局变量|跨文件全局|extern\s+\w+|global state|global variable|全局状态)/i, 12]],
    negative: [/(?:可重入|reentrant|不变量|外部修改|const|volatile|寄存器)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:全局|静态全局|跨文件|extern|全局状态)/i.test(need) ? "减少可变全局状态" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "全局状态规则应使用 code 示例"
      if (!hasGlobalStateExample(text)) return "缺少全局状态反例和封装或上下文传递正例"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "int g_sensor_state;\n\nvoid sensor_update(void)\n{\n    g_sensor_state++;\n}",
      badExampleReason: "可变全局状态扩大了影响范围，调用者难以判断状态何时被修改，也增加测试和并发风险。",
      goodExample: "typedef struct {\n    int sensor_state;\n} sensor_context_t;\n\nvoid sensor_update(sensor_context_t *ctx)\n{\n    ctx->sensor_state++;\n}",
    },
  },
  {
    kind: "type-definition",
    positive: [[/(?:自定义数据类型|typedef|固定宽度类型|明确数据类型|类型大小|数据类型大小|uint\d+_t|int\d+_t)/i, 10]],
    negative: [/(?:sizeof|字面量|魔法数|强制转换|溢出)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:自定义数据类型|固定宽度类型|类型大小|typedef|uint\d+_t)/i.test(need) ? "使用明确数据类型" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "类型定义规则应使用 code 示例"
      if (!hasTypeDefinitionExample(text)) return "缺少自定义类型或固定宽度类型示例"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "int timeout;\nlong counter;",
      badExampleReason: "基础类型宽度可能随平台变化，协议字段、计数和超时值的边界不明确。",
      goodExample: "typedef uint32_t timeout_ms_t;\ntimeout_ms_t timeout_ms;\nuint32_t sample_counter;",
    },
  },
  {
    kind: "operator-precedence",
    positive: [[/(?:运算符优先级|优先级|括号|operator precedence|\(\)).*(?:表达式|运算|比较)|(?:不确定优先级|必须使用括号)/i, 12]],
    negative: [/(?:常量左置|赋值|空格|格式)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:优先级|括号|precedence)/i.test(need) ? "运算符优先级使用括号" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "运算符优先级规则应使用 code 示例"
      if (!hasOperatorPrecedenceExample(text)) return "缺少优先级歧义反例和括号正例"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "if (flags & READY_MASK == 0U) {\n    return -EBUSY;\n}",
      badExampleReason: "混合位运算和比较运算时不加括号，读者需要回忆优先级，且容易得到非预期判断。",
      goodExample: "if ((flags & READY_MASK) == 0U) {\n    return -EBUSY;\n}",
    },
  },
  {
    kind: "sizeof-usage",
    positive: [[/(?:sizeof\s*\(|sizeof).*(?:变量|varname|对象|type)|(?:使用\s*sizeof\(varname\)|sizeof\(varname\))/i, 12]],
    negative: [/(?:类型大小|固定宽度类型|typedef)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:sizeof|变量|varname|对象)/i.test(need) ? "使用 sizeof 变量对象" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "sizeof 规则应使用 code 示例"
      if (!hasSizeofUsageExample(text)) return "缺少 sizeof(type) 反例和 sizeof(variable) 正例"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "memset(buffer, 0, sizeof(sensor_buffer_t));",
      badExampleReason: "sizeof 使用类型名时，变量类型变化后容易忘记同步修改长度表达式。",
      goodExample: "memset(buffer, 0, sizeof(buffer));",
    },
  },
  {
    kind: "expression-complexity",
    positive: [[/(?:复杂表达式|表达式复杂|语句简单|简单语句|复杂技巧|comma operator|三目嵌套|逗号表达式)/i, 11]],
    negative: [/(?:优先级|括号|sizeof|循环)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:复杂表达式|简单语句|复杂技巧|逗号|三目)/i.test(need) ? "拆分复杂表达式" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "表达式复杂度规则应使用 code 示例"
      if (!hasExpressionComplexityExample(text)) return "缺少复杂表达式拆分示例"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "status = ready ? update(a++, b ? c : d) : reset();",
      badExampleReason: "多个副作用和条件嵌套在一条语句里，评审者难以确认执行顺序和错误路径。",
      goodExample: "if (ready) {\n    uint32_t next_a = a + 1U;\n    status = update(next_a, b ? c : d);\n    a = next_a;\n} else {\n    status = reset();\n}",
    },
  },
  {
    kind: "reentrancy",
    positive: [[/(?:可重入|reentrant|reentrancy|重入).*(?:局部变量|全局变量|静态变量|状态)/i, 13]],
    negative: [/(?:中断|ISR|volatile|外部修改|不变量)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:可重入|重入|局部变量|静态变量)/i.test(need) ? "可重入函数避免共享状态" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "可重入规则应使用 code 示例"
      if (!hasReentrancyExample(text)) return "缺少静态/全局状态反例和局部状态正例"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "int next_sample(void)\n{\n    static int index;\n    return sample_table[index++];\n}",
      badExampleReason: "函数内部静态状态会在多次调用或并发调用之间共享，函数不再可重入。",
      goodExample: "int next_sample(sample_cursor_t *cursor)\n{\n    int value = sample_table[cursor->index];\n    cursor->index++;\n    return value;\n}",
    },
  },
  {
    kind: "external-state-mutability",
    positive: [[/(?:不变量|外部修改|外部状态|异步修改|被中断修改|状态可变|mutability|mutable state)/i, 12]],
    negative: [/(?:命名|文件布局|宏|字面量)/i],
    allowedFormats: ["code", "checklist"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:不变量|外部修改|异步|状态可变|快照|重新读取)/i.test(need) ? "外部可变状态需重新确认" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code" && example.exampleFormat !== "checklist") return "外部状态可变性规则应使用 code 或 checklist 示例"
      if (!hasExternalStateMutabilityExample(text)) return "缺少外部状态可变或快照确认语义"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "if (device_ready) {\n    start_transfer();\n}",
      badExampleReason: "device_ready 可能被中断或其它任务异步修改，检查后直接使用会形成过期判断。",
      goodExample: "bool ready_snapshot = read_device_ready();\nif (ready_snapshot) {\n    lock_device_state();\n    if (read_device_ready()) {\n        start_transfer();\n    }\n    unlock_device_state();\n}",
    },
  },
  {
    kind: "const-correctness",
    positive: [[/(?:const|只读|不可修改|输入参数).*(?:指针|参数|对象)|(?:指针|参数|对象).*(?:const|只读|不可修改)/i, 11]],
    negative: [/(?:volatile|寄存器|pragma|pack|sizeof|传值|传址|值传递|指针传递|参数传递|按值|按地址)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:const|只读|不可修改|输入参数)/i.test(need) ? "只读输入使用 const" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "const 规则应使用 code 示例"
      if (!hasConstCorrectnessExample(text)) return "缺少只读指针使用 const 的对比"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "int sensor_configure(sensor_config_t *config);",
      badExampleReason: "只读输入参数没有使用 const，调用者无法确认函数是否会修改传入对象。",
      goodExample: "int sensor_configure(const sensor_config_t *config);",
    },
  },
  {
    kind: "brace-style",
    positive: [[/(?:大括号|程序块分界符|花括号|brace).*(?:独占一行|单独一行|换行|另起一行)|(?:独占一行|单独一行).*(?:大括号|程序块|花括号)/i, 13]],
    negative: [/(?:数组下标|成员运算符|赋值|一元|二元)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:大括号|花括号|程序块|独占一行|单独一行|brace)/i.test(need) ? "大括号独占一行" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "大括号风格规则应使用 code 示例"
      if (!hasBraceStyleExample(text)) return "缺少大括号独占一行对比"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "if (ready) {\n    start();\n} else {\n    stop();\n}",
      badExampleReason: "程序块边界没有独占一行，复杂条件或嵌套增多时不利于快速定位块范围。",
      goodExample: "if (ready)\n{\n    start();\n}\nelse\n{\n    stop();\n}",
    },
  },
  {
    kind: "bounded-loop",
    positive: [[/(?:循环|轮询|超时|上界|有界|bounded|timeout|poll|retry|重试)/i, 6]],
    negative: [/(?:宏命名|常量名称|枚举命名|命名对照|typedef\s+enum|SENSOR_STATE)/i],
    allowedFormats: ["code", "checklist"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:循环|上界|超时|重试|bounded|timeout|retry)/i.test(need) ? "循环有明确上界" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat === "file-layout" || example.exampleFormat === "naming-pair") return "循环上界规则不应使用文件布局或命名对照示例"
      if (!/(?:timeout|超时|循环|while|for|轮询|上界|有界|max(?:imum)?|retry|重试|break|计数|counter|count)/i.test(text)) return "缺少循环上界、超时或最大重试语义"
      if (/(?:sensor_start_sampling|命名对照|memcpy|buffer\s*==\s*NULL|typedef\s+enum|SENSOR_STATE)/i.test(text)) return "循环上界规则不应使用命名、缓冲区或枚举模板"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "while ((status_reg & READY_FLAG) == 0U) {\n}",
      badExampleReason: "轮询没有上界或超时退出条件，硬件异常时会导致任务永久阻塞。",
      goodExample: "uint32_t retry_count = MAX_RETRY_COUNT;\nwhile (((status_reg & READY_FLAG) == 0U) && (retry_count > 0U)) {\n    retry_count--;\n}\nif (retry_count == 0U) {\n    return -ETIMEDOUT;\n}",
    },
  },
  {
    kind: "recursion",
    positive: [[/(?:递归|recursion|recursive)/i, 7]],
    allowedFormats: ["code"],
    defaultFormat: "code",
    validate: (text) => /(?:递归|迭代|栈|recursion|recursive|iterative)/i.test(text) ? undefined : "缺少递归与迭代或栈上界对比",
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "uint32_t sum_node(const node_t *node)\n{\n    return node == NULL ? 0U : node->value + sum_node(node->next);\n}",
      badExampleReason: "链表长度不可控时递归深度也不可控，可能造成栈溢出。",
      goodExample: "uint32_t sum_node(const node_t *node)\n{\n    uint32_t total = 0U;\n    while (node != NULL) {\n        total += node->value;\n        node = node->next;\n    }\n    return total;\n}",
    },
  },
  {
    kind: "pointer-null-comparison",
    positive: [[/(?:指针|pointer|\bptr\b).*(?:NULL|零值|空值|隐式转换|隐式判断|显式比较)|(?:NULL|零值|空值).*(?:指针|pointer|\bptr\b)|(?:==\s*NULL|!=\s*NULL|if\s*\(\s*!?\s*ptr\s*\))/i, 8]],
    negative: [/(?:memcpy|buffer|常量名称|宏命名|typedef\s+enum|SENSOR_TIMEOUT|操作符空格|初始化)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:NULL|零值|空值|显式|隐式|ptr|指针)/i.test(need) ? "显式 NULL 指针比较" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "指针 NULL 比较规则应使用 code 示例"
      if (!hasExplicitNullPointerComparison(text) || !hasImplicitPointerCondition(text)) return "缺少显式 NULL 判断正例和隐式指针判断反例"
      if (/(?:memcpy|buffer_size|count\s*>|SENSOR_TIMEOUT|typedef\s+enum|#define\s+TIMEOUT)/i.test(text)) return "指针 NULL 比较规则不应使用缓冲区或宏命名模板"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "if (ptr) {\n    use_value(ptr);\n}\nif (!ptr) {\n    return -EINVAL;\n}",
      badExampleReason: "隐式真假判断没有直接表达这是指针有效性检查，评审者需要结合上下文判断 ptr 的类型和意图。",
      goodExample: "if (ptr != NULL) {\n    use_value(ptr);\n}\nif (ptr == NULL) {\n    return -EINVAL;\n}",
    },
  },
  {
    kind: "naming",
    positive: [[/(?:命名|名称|前缀|缩写|name|naming|prefix|abbreviation|identifier)/i, 7]],
    negative: [/(?:overflow|溢出|memcpy|buffer|volatile|寄存器|常量名称|有意义的常量|宏命名|常量命名|枚举命名|非平凡数字|魔法数|字面量|#define|typedef\s+enum)/i],
    allowedFormats: ["naming-pair"],
    defaultFormat: "naming-pair",
    validate: (text, example) => {
      if (example.exampleFormat !== "naming-pair") return "命名规则应使用 naming-pair 示例"
      if (!/(?:命名|名称|prefix|retry_count|sensor_|module_|命名对照)/i.test(text)) return "缺少命名对照语义"
      if (/(?:overflow|溢出|memcpy|buffer)/i.test(text)) return "命名规则不应使用整数溢出或缓冲区模板"
      return undefined
    },
    fallback: {
      exampleType: "bad-good-pair",
      exampleFormat: "naming-pair",
      badExample: "int run(int a);\nuint32_t cnt;",
      badExampleReason: "名称过短且缺少业务语义，无法表达动作、对象和单位，后续维护者需要反复回读上下文才能理解用途。",
      goodExample: "int sensor_start_sampling(uint32_t sample_count);\nuint32_t retry_count;",
    },
  },
  {
    kind: "parameter-passing",
    positive: [[/(?:传值|传址|值传递|指针传递|参数传递|按值|按地址|输入参数|输出参数)/i, 8]],
    negative: [/(?:注释|\/\/\/|\/\*|宏命名|SENSOR_TIMEOUT|memcpy|文件布局)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    normalizeNeed: (need) => /(?:传值|传址|值传递|指针传递|参数传递|按值|按地址)/i.test(need) ? "值传递与指针传递的对比" : undefined,
    validate: (text, example) => {
      if (example.exampleFormat !== "code") return "参数传递规则应使用 code 示例"
      if (!hasParameterPassingExample(text)) return "缺少值传递与指针传递的对比"
      if (/(?:\/\/\/|\/\*|SENSOR_TIMEOUT|typedef\s+enum|memcpy\(buffer)/i.test(text)) return "参数传递规则不应使用注释、宏命名或缓冲区模板"
      return undefined
    },
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "void sensor_set_timeout(uint32_t *timeout_ms);\nint sensor_configure(sensor_config_t config);",
      badExampleReason: "简单标量被无故设计成指针参数，而较大的配置结构体又被按值复制，调用者难以判断接口语义和资源成本。",
      goodExample: "void sensor_set_timeout(uint32_t timeout_ms);\nint sensor_configure(const sensor_config_t *config);",
    },
  },
  {
    kind: "file-layout",
    positive: [[/(?:源文件|头文件|实现文件|公开接口|接口声明|文件结构|文件组织|目录组织|include\s*guard|\.c\b|\.h\b|配对|header|source file|implementation file)/i, 5]],
    negative: [/(?:静态检查|告警|volatile|memcpy|integer|overflow|中断)/i],
    allowedFormats: ["file-layout"],
    defaultFormat: "file-layout",
    validate: (text, example) => example.exampleFormat === "file-layout" && /(?:\.c\b|\.h\b|#include|头文件|源文件|接口声明)/i.test(text) ? undefined : "缺少 .c/.h 文件布局或接口声明示例",
    fallback: {
      exampleType: "bad-good-pair",
      exampleFormat: "file-layout",
      badExample: "// motor.c\nint motor_init(const motor_config_t *config)\n{\n    return 0;\n}",
      badExampleReason: "公开接口只出现在实现文件中，调用方和评审者无法通过头文件确认模块边界、依赖关系和可复用接口。",
      goodExample: "// motor.h\n#ifndef MOTOR_H\n#define MOTOR_H\n\nint motor_init(const motor_config_t *config);\n\n#endif\n\n// motor.c\n#include \"motor.h\"\n\nint motor_init(const motor_config_t *config)\n{\n    return 0;\n}",
    },
  },
  {
    kind: "comment",
    positive: [[/(?:注释|comment|documentation|\/\/\/|\/\*)/i, 5]],
    negative: [/(?:传值|传址|参数传递|宏命名|循环上界|静态检查)/i],
    allowedFormats: ["code", "text"],
    defaultFormat: "code",
    validate: (text) => /(?:\/\/|\/\*|comment|注释|说明)/i.test(text) ? undefined : "缺少注释风格或注释内容示例",
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "/* handle */\nstatus = sensor_configure(&config);",
      badExampleReason: "注释只重复模糊动作，没有解释配置目标、失败影响或关键约束，不能帮助评审者理解代码意图。",
      goodExample: "/* 配置采样周期和阈值，失败时返回底层错误码。 */\nstatus = sensor_configure(&config);",
    },
  },
  {
    kind: "dynamic-memory",
    positive: [[/(?:动态内存|堆内存|malloc|calloc|realloc|free)/i, 7]],
    allowedFormats: ["code"],
    defaultFormat: "code",
    validate: (text) => /(?:malloc|free|动态内存|堆|分配)/i.test(text) ? undefined : "缺少动态内存分配或替代策略示例",
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "uint8_t *buffer = malloc(size);\nprocess(buffer);",
      badExampleReason: "运行期动态分配缺少失败检查和释放路径，容易引入碎片、泄漏和不可预测延迟。",
      goodExample: "static uint8_t buffer[SENSOR_BUFFER_SIZE];\nif (size > sizeof(buffer)) {\n    return -EINVAL;\n}\nprocess(buffer, size);",
    },
  },
  {
    kind: "undefined-behavior",
    positive: [[/(?:未定义行为|undefined behavior|\bUB\b|除零|移位|signed overflow)/i, 6]],
    negative: [/(?:声明.*指针|指针.*初始化|野指针|指针参数|空指针|指针.*(?:NULL|为空|非空)|buffer|memcpy)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    validate: (text) => /(?:未定义|UB|除零|移位|越界|undefined)/i.test(text) ? undefined : "缺少未定义行为风险示例",
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "uint32_t mask = 1U << bit;",
      badExampleReason: "未检查移位位数，bit 超过类型宽度时会触发未定义或非预期行为。",
      goodExample: "if (bit >= 32U) {\n    return -ERANGE;\n}\nuint32_t mask = 1UL << bit;",
    },
  },
  {
    kind: "determinism",
    positive: [[/(?:确定性|实时性|可预测|deterministic|determinism|real-time)/i, 5]],
    allowedFormats: ["checklist", "text"],
    defaultFormat: "checklist",
    exampleType: "checklist",
    validate: (text) => /(?:确定性|实时|超时|有界|动态内存|determin)/i.test(text) ? undefined : "缺少确定性或实时性约束示例",
    fallback: {
      exampleType: "checklist",
      exampleFormat: "checklist",
      badExample: "- 关键路径存在无界循环\n- 运行期动态分配内存\n- 超时和错误路径未定义",
      badExampleReason: "这些做法会让最坏执行时间和资源占用不可预测，影响嵌入式系统确定性。",
      goodExample: "- 关键循环设置上界或超时\n- 关键路径使用静态资源\n- 错误路径返回明确错误码并可诊断",
    },
  },
  {
    kind: "memory-consistency",
    positive: [[/(?:存储访问一致性|存储同步|多主设备|多核访问|共享变量|cache访问|cache方式|缓存一致性|ECC|原子性|barrier|synchronization barrier|DMAC|NFC|内存屏障|同步屏障)/i, 8]],
    negative: [/(?:memcpy|buffer|返回值|错误码|文件布局|命名)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    validate: (text) => /(?:存储同步|共享变量|多主设备|多核访问|cache|缓存|ECC|原子|barrier|InsertDataSynchronizationBarrier|锁|同步屏障|DMAC|NFC)/i.test(text) && !/(?:memcpy\(buffer|buffer\s*==\s*NULL|EINVAL|返回值|错误码)/i.test(text) ? undefined : "缺少存储一致性同步语义或包含无关模板",
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "shared_desc = desc;\nnotify_dma();",
      badExampleReason: "写入共享数据后直接通知其它主设备读取，缺少存储同步，读者可能看到尚未写入存储空间的旧数据。",
      goodExample: "shared_desc = desc;\nhalCpu_InsertDataSynchronizationBarrier();\nnotify_dma();",
    },
  },
  {
    kind: "error-handling",
    positive: [[/(?:错误|返回值|错误码|失败路径|error|return value|status|errno)/i, 5]],
    negative: [/(?:volatile|寄存器|interrupt|宏命名|文件布局)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    validate: (text) => /(?:return|status|error|errno|错误|返回)/i.test(text) && !/(?:volatile|寄存器|interrupt)/i.test(text) ? undefined : "缺少返回值或错误路径处理语义",
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "device_init(config);\nreturn 0;",
      badExampleReason: "忽略初始化函数返回值会掩盖失败状态，调用方会误以为设备已成功初始化。",
      goodExample: "int status = device_init(config);\nif (status != 0) {\n    return status;\n}\nreturn 0;",
    },
  },
  {
    kind: "pointer-memory",
    positive: [
      [/(?:指针参数|可空指针|空指针|解引用|未验证的指针)/i, 9],
      [/(?:指针|内存|缓冲区|数组|pointer|memory|buffer|array|memcpy|null)/i, 5],
    ],
    negative: [/(?:NULL.*比较|显式.*NULL|隐式.*指针|操作符空格|指针初始化|初始化|未初始化|野指针|悬空指针|操作符|运算符|空格|int\s+\*\s+ptr|&\s+value|常量左置|volatile|寄存器|interrupt)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    validate: (text) => /(?:pointer|buffer|null|memcpy|数组|指针|内存|边界|长度)/i.test(text) && !/(?:volatile|寄存器|interrupt)/i.test(text) ? undefined : "缺少指针、缓冲区或边界检查语义",
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "memcpy(buffer, input, count);",
      badExampleReason: "未检查指针有效性和目标缓冲区容量，可能导致空指针访问或越界写入。",
      goodExample: "if (input == NULL || count > buffer_size) {\n    return -EINVAL;\n}\nmemcpy(buffer, input, count);",
    },
  },
  {
    kind: "integer-type",
    positive: [[/(?:整数|类型|强制转换|溢出|越界|integer|overflow|cast|size_t|uint\d+_t|count|index)/i, 4]],
    negative: [/(?:自定义数据类型|固定宽度类型|类型大小|typedef|sizeof|非平凡数字|魔法数|字面量)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    validate: (text) => /(?:uint|size_t|count|index|overflow|integer|整数|溢出|转换)/i.test(text) ? undefined : "缺少整数类型、索引或溢出检查语义",
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "uint32_t bytes = count * item_size;",
      badExampleReason: "乘法结果未做溢出检查，计算出的长度可能回绕为较小值，后续内存访问会使用错误边界。",
      goodExample: "if (item_size != 0U && count > UINT32_MAX / item_size) {\n    return -ERANGE;\n}\nuint32_t bytes = count * item_size;",
    },
  },
  {
    kind: "volatile-register",
    positive: [[/(?:寄存器|volatile|临界区|register|critical section|WOC|READ\/WRITE|RSVD)/i, 5]],
    negative: [/(?:命名|宏命名|memcpy|错误返回)/i],
    allowedFormats: ["code"],
    defaultFormat: "code",
    validate: (text) => /(?:volatile|寄存器|status_reg|READY_FLAG|临界区|register)/i.test(text) && !/(?:memcpy|buffer|malloc)/i.test(text) ? undefined : "缺少寄存器、volatile 或临界区语义",
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "while ((status_reg & READY_FLAG) == 0U) {\n}",
      badExampleReason: "volatile 只能保证访问不会被优化掉，不能替代同步、临界区或超时控制。",
      goodExample: "uint32_t timeout = MAX_POLL_COUNT;\nwhile (((status_reg & READY_FLAG) == 0U) && (timeout > 0U)) {\n    timeout--;\n}\nif (timeout == 0U) {\n    return -ETIMEDOUT;\n}",
    },
  },
  {
    kind: "function-design",
    positive: [
      [/(?:函数|职责|function|single responsibility)/i, 7],
      [/(?:参数|接口|parameter|api)/i, 2],
    ],
    negative: [/(?:传值|传址|值传递|指针传递|注释|宏命名|源文件|头文件|\.c\b|\.h\b|循环|轮询|上界|超时|ISR|中断服务|中断处理|指针参数|可空指针|空指针|解引用)/i],
    allowedFormats: ["code", "checklist"],
    defaultFormat: "code",
    validate: (text) => /(?:function|parameter|config|参数|函数|接口|职责)/i.test(text) ? undefined : "缺少函数接口或职责设计语义",
    fallback: {
      language: "c",
      exampleType: "bad-good-pair",
      exampleFormat: "code",
      badExample: "void sensor_configure(void);\n/* 函数内部读取全局配置并静默失败。 */",
      badExampleReason: "接口没有显式输入和返回状态，调用方无法判断配置来源或失败结果，错误也无法向上传递。",
      goodExample: "int sensor_configure(const sensor_config_t *config)\n{\n    if (config == NULL) {\n        return -EINVAL;\n    }\n    return sensor_apply_config(config);\n}",
    },
  },
  {
    kind: "checklist",
    positive: [[/(?:checklist|code review|评审|检查项|落地)/i, 2]],
    allowedFormats: ["checklist", "text"],
    defaultFormat: "checklist",
    exampleType: "checklist",
    fallback: {
      exampleType: "checklist",
      exampleFormat: "checklist",
      badExample: "- 只确认代码能编译\n- 未检查规则例外和风险记录",
      badExampleReason: "检查项只覆盖编译结果，缺少对必须级规则、例外记录和高风险项的确认，无法支撑规则落地。",
      goodExample: "- 确认必须级规则全部满足\n- 例外项有评审记录\n- 静态检查或人工检查项已覆盖高风险规则",
    },
  },
]

export function inferSemanticKindFromText(rawText: string): CRuleSemanticKind {
  const text = normalizeText(rawText)
  if (!text) return "generic"
  const scored = CONTRACTS.map((contract, index) => ({
    kind: contract.kind,
    index,
    score: scoreContract(contract, text),
  })).sort((left, right) => right.score - left.score || left.index - right.index)
  const top = scored[0]
  const next = scored[1]
  if (!top || top.score < 2) return "generic"
  if (top.score < 6 && next && top.score - next.score < 2) return "generic"
  return top.kind
}

export function semanticContractFor(kind: CRuleSemanticKind) {
  return CONTRACTS.find((contract) => contract.kind === kind)
}

export function normalizeIntentNeedForSemanticKind(input: string, kind: CRuleSemanticKind) {
  const need = normalizeText(input)
  if (!need) return undefined
  const contract = semanticContractFor(kind)
  return contract?.normalizeNeed?.(need)
}

export function normalizedExampleFormatForSemanticKind(
  format: GeneratedExampleSpec["exampleFormat"],
  kind: CRuleSemanticKind,
): GeneratedExampleSpec["exampleFormat"] {
  return semanticContractFor(kind)?.defaultFormat ?? format
}

export function exampleFormatForSemanticKind(kind: CRuleSemanticKind): NonNullable<GeneratedExampleSpec["exampleFormat"]> {
  return semanticContractFor(kind)?.defaultFormat ?? "code"
}

export function languageForSemanticKind(kind: CRuleSemanticKind) {
  return exampleFormatForSemanticKind(kind) === "code" ? "c" : undefined
}

export function exampleForSemanticKind(kind: CRuleSemanticKind): RuleExamplePayload | undefined {
  const fallback = semanticContractFor(kind)?.fallback
  return fallback ? { ...fallback } : undefined
}

export function generatedExampleContractMismatch(kind: CRuleSemanticKind, example: GeneratedExampleSpec) {
  if (kind === "governance") return "流程、版权、合规或文档治理内容不应生成核心编码规则示例"
  const intentMismatch = generatedExampleIntentMismatch(example)
  if (intentMismatch) return intentMismatch
  const text = generatedExampleText(example)
  const contract = semanticContractFor(kind)
  if (!contract) return undefined
  if (contract.allowedFormats?.length && example.exampleFormat && !contract.allowedFormats.includes(example.exampleFormat)) {
    return `示例格式 ${example.exampleFormat} 不适用于规则语义 ${kind}`
  }
  return contract.validate?.(text, example)
}

export function generatedExampleIntentMismatch(example: GeneratedExampleSpec) {
  const intent = example.semanticIntent
  if (!intent) return undefined
  const text = generatedExampleText(example)
  for (const avoid of intent.mustAvoid ?? []) {
    if (intentAvoidMatched(text, avoid)) return `命中 mustAvoid：${avoid}`
  }
  for (const include of intent.mustInclude ?? []) {
    if (!intentNeedMatched(text, include)) return `缺少 mustInclude：${include}`
  }
  return undefined
}

function scoreContract(contract: SemanticContract, text: string) {
  let score = 0
  for (const [pattern, weight] of contract.positive) {
    if (pattern.test(text)) score += weight
  }
  for (const pattern of contract.negative ?? []) {
    if (pattern.test(text)) score -= 5
  }
  return score
}

function generatedExampleText(example: GeneratedExampleSpec) {
  return normalizeText([
    example.title,
    example.exampleType ?? "",
    example.exampleFormat ?? "",
    example.badExample ?? "",
    example.goodExample ?? "",
    example.explanation,
    example.badExampleReason ?? "",
  ].join(" "))
}

function intentNeedMatched(text: string, rawNeed: string) {
  const need = rawNeed.toLowerCase()
  if (/(?:行尾无意义留白|行尾|尾部|trailing|水平留白)/i.test(need)) return /(?:行尾|尾部|留白|空白|空格|trailing|␠)/i.test(text)
  if (/(?:赋值运算符前后空格|赋值|=\s*前后|两侧空格)/i.test(need)) return hasAssignmentSpacingExample(text)
  if (/(?:一元操作符|单目|一元|!|~|\+\+|--|紧邻)/i.test(need)) return hasUnaryOperatorSpacingExample(text)
  if (/(?:二元运算符|多目|双目|二元|前后空格|\+|>=|&&|\|\|)/i.test(need)) return hasBinaryOperatorSpacingExample(text)
  if (/(?:后缀运算符|数组下标|成员运算符|函数调用|\[\]|->|\.)/i.test(need)) return hasPostfixOperatorSpacingExample(text)
  if (/(?:#pragma pack|pragma pack|pack 成对|成对恢复|结构体对齐)/i.test(need)) return hasPragmaPackPairingExample(text)
  if (/(?:非平凡数字|魔法数|字面量|有意义常量|有意义的常量|裸数字)/i.test(need)) return hasLiteralConstantExample(text)
  if (/(?:变量最小作用域|最小作用域|就近声明)/i.test(need)) return hasVariableScopeExample(text)
  if (/(?:全局状态|全局变量|静态全局|跨文件全局)/i.test(need)) return hasGlobalStateExample(text)
  if (/(?:使用明确数据类型|固定宽度类型|自定义数据类型|typedef)/i.test(need)) return hasTypeDefinitionExample(text)
  if (/(?:运算符优先级|优先级|括号)/i.test(need)) return hasOperatorPrecedenceExample(text)
  if (/(?:sizeof|sizeof 变量|sizeof\(varname\))/i.test(need)) return hasSizeofUsageExample(text)
  if (/(?:拆分复杂表达式|复杂表达式|简单语句)/i.test(need)) return hasExpressionComplexityExample(text)
  if (/(?:可重入|重入|局部变量|共享状态)/i.test(need)) return hasReentrancyExample(text)
  if (/(?:外部可变状态|外部修改|不变量|状态可变|快照)/i.test(need)) return hasExternalStateMutabilityExample(text)
  if (/(?:只读输入使用 const|const|只读输入)/i.test(need)) return hasConstCorrectnessExample(text)
  if (/(?:大括号独占一行|大括号|程序块分界符|brace)/i.test(need)) return hasBraceStyleExample(text)
  if (/(?:指针或地址操作符空格对比|地址操作符|指针操作符|操作符空格|运算符空格|\*\s*ptr|&\s*value|指针声明.*(?:空格|操作符|运算符)|(?:空格|操作符|运算符).*指针声明)/i.test(need)) return hasPointerOperatorSpacingExample(text)
  if (/(?:指针初始化|未初始化指针|野指针|初始化为\s*NULL)/i.test(need)) return hasPointerInitializationExample(text)
  if (/(?:常量名称|有意义的常量|宏命名|常量命名|枚举命名|定义有意义的常量名称)/i.test(need)) return /(?:#define|enum|宏|枚举|常量|SENSOR_[A-Z0-9_]+|MODULE_[A-Z0-9_]+|\b[A-Z][A-Z0-9_]{2,}\b)/i.test(text)
  if (/(?:传值|传址|值传递|指针传递|参数传递)/i.test(need)) return hasParameterPassingExample(text)
  if (/(?:静态检查|扫描|告警|warning|CI|lint|analyzer)/i.test(need)) return /(?:静态|扫描|告警|warning|-Wall|-Wextra|CI|lint|analyzer|偏差记录)/i.test(text)
  if (/(?:循环有明确上界|循环|上界|超时|重试)/i.test(need)) return /(?:while|for|retry|timeout|MAX_|上界|超时|重试|计数)/i.test(text)
  if (/(?:显式 NULL 指针比较|null|零值|空值|指针|ptr|显式)/i.test(need) && /(?:隐式|if\s*\(\s*!?\s*ptr\s*\))/i.test(need)) {
    return hasExplicitNullPointerComparison(text) && hasImplicitPointerCondition(text)
  }
  if (/(?:显式 NULL 指针比较|null|零值|空值|指针|ptr|显式)/i.test(need)) return hasExplicitNullPointerComparison(text)
  if (/(?:隐式|if\s*\(\s*!?\s*ptr\s*\))/i.test(need)) return hasImplicitPointerCondition(text)
  if (/(?:常量左置比较|常量|右值|左置|左侧|0\s*==|NULL\s*==|flag|比较)/i.test(need)) return hasConstantLeftComparison(text)
  return false
}

function intentAvoidMatched(text: string, rawAvoid: string) {
  const avoid = rawAvoid.toLowerCase()
  if (/(?:memcpy|buffer|缓冲)/i.test(avoid)) return /(?:memcpy|buffer|buffer_size)/i.test(text)
  if (/(?:宏命名|宏模板|SENSOR_TIMEOUT|enum|枚举)/i.test(avoid)) return /(?:#define\s+SENSOR_TIMEOUT|typedef\s+enum|SENSOR_STATE)/i.test(text)
  if (/(?:文件布局|\.c|\.h)/i.test(avoid)) return /(?:motor\.c|motor\.h|#include\s+"motor\.h")/i.test(text)
  if (/(?:指针或地址操作符空格|操作符空格)/i.test(avoid)) return hasPointerOperatorSpacingExample(text)
  if (/(?:循环|timeout|retry|ETIMEDOUT|MAX_RETRY_COUNT)/i.test(avoid)) return /(?:while|for|retry|timeout|ETIMEDOUT|MAX_RETRY_COUNT)/i.test(text)
  if (/(?:volatile|寄存器|register)/i.test(avoid)) return /(?:volatile|寄存器|status_reg|register)/i.test(text)
  if (/(?:文件布局|头文件|源文件)/i.test(avoid)) return /(?:motor\.h|motor\.c|#include\s+"motor\.h")/i.test(text)
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

function hasAssignmentSpacingExample(text: string) {
  return /(?:\w+|\])\s*=\s*[^=]|(?:\+=|-=|\*=|\/=)/.test(text)
    && /(?:\w+|\])=[^=]|\+=|-=|\*=|\/=/.test(text)
    && /(?:\w+|\])\s=\s[^=]|\s\+=\s|\s-=\s|\s\*=\s|\s\/=\s/.test(text)
}

function hasUnaryOperatorSpacingExample(text: string) {
  return /(?:!\s+\w+|\*\s+\w+|&\s+\w+|\+\+\s+\w+|--\s+\w+)/.test(text)
    && /(?:!\w+|\*\w+|&\w+|\+\+\w+|--\w+)/.test(text)
}

function hasBinaryOperatorSpacingExample(text: string) {
  return /(?:\w\+\w|\w>=\w|\w&&\w|\w\|\|\w|\w-\w)/.test(text)
    && /(?:\w \+ \w|\w >= \w|\w && \w|\w \|\| \w|\w - \w)/.test(text)
}

function hasPostfixOperatorSpacingExample(text: string) {
  return /(?:\w+\s+\[|\w+\s+\.\s*\w+|\w+\s+\(\s*\))/.test(text)
    && /(?:\w+\[|\w+\.\w+|\w+\(\s*\))/.test(text)
}

function hasPragmaPackPairingExample(text: string) {
  return /#pragma\s+pack\s*\(/i.test(text)
    && /(?:#pragma\s+pack\s*\(\s*pop\s*\)|#pragma\s+pack\s*\(\s*\)|pack\s*\(\s*push\s*,)/i.test(text)
}

function hasLiteralConstantExample(text: string) {
  return /(?:\b\d{2,}U?\b|魔法数|非平凡数字|裸数字)/i.test(text)
    && /(?:#define\s+[A-Z][A-Z0-9_]+|enum|SENSOR_[A-Z0-9_]+|MODULE_[A-Z0-9_]+)/i.test(text)
}

function hasVariableScopeExample(text: string) {
  return /(?:for\s*\(\s*(?:uint32_t|size_t|int)\s+\w+|就近声明|最小作用域)/i.test(text)
    && /(?:int\s+\w+;\s*(?:uint32_t|size_t)\s+\w+;|过早声明|作用域过大)/i.test(text)
}

function hasGlobalStateExample(text: string) {
  return /(?:\bg_|global|extern|全局|static\s+\w+)/i.test(text)
    && /(?:context|ctx|封装|传递|sensor_context_t|访问器)/i.test(text)
}

function hasTypeDefinitionExample(text: string) {
  return /(?:typedef\s+uint\d+_t|uint\d+_t|int\d+_t|timeout_ms_t|固定宽度)/i.test(text)
    && /(?:\bint\s+\w+;|\blong\s+\w+;|类型宽度|基础类型)/i.test(text)
}

function hasOperatorPrecedenceExample(text: string) {
  return /(?:flags\s*&\s*\w+\s*==|[a-z_][a-z0-9_]*\s*&\s*[A-Z][A-Z0-9_]+\s*==)/i.test(text)
    && /\(\s*[a-z_][a-z0-9_]*\s*&\s*[A-Z][A-Z0-9_]+\s*\)\s*==/i.test(text)
}

function hasSizeofUsageExample(text: string) {
  return /sizeof\s*\(\s*\w+_t\s*\)/i.test(text)
    && /sizeof\s*\(\s*(?:buffer|[a-z_][a-z0-9_]*)\s*\)/i.test(text)
}

function hasExpressionComplexityExample(text: string) {
  return /(?:\?.*:|,\s*\w+\+\+|复杂表达式|三目|副作用)/i.test(text)
    && /(?:if\s*\(|next_|拆分|临时变量|else)/i.test(text)
}

function hasReentrancyExample(text: string) {
  return /(?:static\s+\w+|全局|共享状态|不可重入)/i.test(text)
    && /(?:cursor|context|ctx|局部|可重入|传入状态)/i.test(text)
}

function hasExternalStateMutabilityExample(text: string) {
  return /(?:device_ready|外部修改|异步|不变量|snapshot|快照|重新读取|lock_)/i.test(text)
    && /(?:read_|lock|unlock|重新确认|snapshot|快照)/i.test(text)
}

function hasConstCorrectnessExample(text: string) {
  return /(?:const\s+\w+_t\s*\*|只读|const\s+struct\s+\w+\s*\*)/i.test(text)
    && /(?:\w+_t\s*\*\s*\w+|未使用\s*const|没有使用\s*const|int\s+\w+\([^)]*\w+_t\s*\*)/i.test(text)
}

function hasBraceStyleExample(text: string) {
  return /(?:大括号|程序块|独占一行|单独一行|brace)/i.test(text)
    && /(?:if\s*\([^)]*\)|else|\{|\})/i.test(text)
}

function normalizeText(input: string) {
  return input.replace(/\s+/g, " ").trim()
}
