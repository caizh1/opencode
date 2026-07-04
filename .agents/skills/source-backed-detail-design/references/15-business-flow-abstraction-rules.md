# 15 Business Flow Abstraction Rules

## 1. 目的

业务流程图用于从源码证据中抽象出模块的业务处理逻辑，面向架构评审、详细设计阅读和业务流程理解。

业务流程图不是函数调用图，也不是状态机展开图。它必须回答：

- 模块被什么业务事件触发；
- 进入模块后先做什么业务判断；
- 分为哪些业务阶段或业务子模块；
- 每个子模块处理什么业务对象；
- 哪些条件导致继续、等待、重试、失败、终止或完成；
- 子模块之间如何交接数据、状态或结果；
- 总模块如何从入口走到完整业务结果。

业务流程图必须 high level，但不能脱离源码。每个业务节点和关键边都必须能映射到 SRC/CE/BR/ST/BF 证据。

## 2. 业务抽象原则

### 2.1 允许抽象

允许把多个函数、多个分支或多个状态处理抽象成一个业务动作，例如：

| 源码事实 | 可抽象为 |
|---|---|
| 参数校验、ctx 初始化、资源申请 | 请求接入与上下文准备 |
| switch state + handler 调用 | 按当前业务状态分派处理 |
| 队列入队、等待回调、状态置 WAIT | 等待异步处理结果 |
| retry counter + timeout branch | 超时重试控制 |
| error code + cleanup + state error | 失败收敛与资源清理 |

### 2.2 禁止抽象

禁止出现无源码依据的业务节点。禁止把旧文档中的流程直接搬进业务流程图。禁止把函数 A -> 函数 B -> 函数 C 改个中文名字就当业务流程图。

### 2.3 图中命名规则

业务流程图中的节点优先使用业务语义命名：

- 请求接入
- 参数与上下文校验
- 业务对象装载
- 状态判定
- 策略选择
- 下游请求发起
- 等待异步结果
- 结果合并
- 状态提交
- 异常收敛
- 成功完成

函数名、结构体名、字段名、宏名不得作为主节点名称，除非该符号本身就是业务概念。源码符号放到证据表，不放到业务图主标签。

## 3. 业务证据输出

必须在 `03-control-flow-evidence/` 下新增业务抽象证据文件。

### 3.1 09-business-capability-map.csv

```csv
business_capability_id,capability_name,capability_description,business_value,scope_boundary,submodule,source_functions,source_states,source_data_objects,trigger,key_steps,output_or_side_effect,confidence,evidence_ids
```

要求：

- 每个重要子模块至少 1 条 capability；
- capability_description 必须说明该能力具体做什么，建议 60-160 个中文字符；
- business_value 必须说明该能力对模块业务结果的价值；
- scope_boundary 必须说明该能力的负责范围和不负责范围；
- key_steps 必须用业务语言概括 2-5 个关键步骤；
- source_functions 不能为空；
- evidence_ids 必须引用 SRC/CE/BR/ST；
- confidence 只能是 source_confirmed/high_confidence/medium_confidence；
- medium_confidence 只能进待确认或图注说明，不能作为确定业务主路径。

### 3.2 10-business-flow-steps.csv

```csv
business_step_id,step_name,step_type,submodule,input_business_object,business_action,decision_condition,output_business_object,state_effect,next_possible_steps,source_basis,evidence_ids
```

step_type 包括：

- trigger
- validation
- preparation
- business_action
- decision
- dispatch
- wait
- retry
- error
- cleanup
- complete
- abort
- external_dependency
- data_commit

要求：

- step_name 必须是业务语义，不得只是函数名；
- decision_condition 必须能追溯到源码条件；
- state_effect 需要说明业务状态影响；
- next_possible_steps 至少覆盖正常路径和异常/等待/重试路径之一。

### 3.3 11-business-flow-edges.csv

```csv
business_edge_id,from_step,to_step,edge_condition,business_meaning,submodule,cross_submodule,source_condition,evidence_ids
```

要求：

- edge_condition 不能为空，无条件写 always；
- 跨子模块边必须标记 cross_submodule=true；
- source_condition 记录源码条件或状态迁移条件；
- business_meaning 使用业务语言说明为什么流转。

### 3.4 12-business-flow-edge-coverage.csv

```csv
diagram_name,mermaid_edge,from_node,to_node,business_edge_id,evidence_ids,coverage_status,notes
```

coverage_status 包括 covered/partial/unverified。unverified 不能进入最终 PASS。

### 3.5 13-business-text-coverage.csv

```csv
item_type,item_name,section_file,has_description,description_chars,has_evidence,diagram_refs,quality_status,notes
```

item_type 包括 capability/submodule/parent_flow。quality_status 包括 pass/weak/missing。每个业务能力和每个重要子模块都必须有一行覆盖记录。

## 4. 子模块业务流程图规则

每个重要业务子模块必须先生成一张 high-level 子模块业务流程图。

输出位置：

```text
04-diagrams/mmd/business/submodules/
04-diagrams/png/business/submodules/
```

命名建议：

```text
business-submodule-<submodule-name>.mmd
business-submodule-<submodule-name>.png
```

每张子模块业务流程图必须包含：

1. 业务触发入口；
2. 输入业务对象；
3. 至少 3 个业务处理步骤；
4. 至少 2 条源码确认的业务条件边，源码确实没有时必须说明；
5. 数据或状态影响；
6. 正常完成路径；
7. 错误、等待、重试、终止路径中的至少一种；
8. 与其他子模块的交接点；
9. BF edge coverage。

子模块业务图不展开函数内部细节。函数内部细节应放到 code-level 子模块图或 function-detail-flow 图。增加文字简介时不得把大段说明塞入 Mermaid 节点，避免影响当前图片质量。

## 5. 总模块业务流程图规则

总模块业务流程图必须在所有子模块业务图完成后生成。

输出位置：

```text
04-diagrams/mmd/business/parent/
04-diagrams/png/business/parent/
```

命名建议：

```text
business-parent-module-master-flow.mmd
business-parent-module-master-flow.png
```

总模块业务图必须包含：

1. 外部业务触发；
2. 模块级输入；
3. 子模块边界；
4. 子模块之间的主流转；
5. 关键业务判断；
6. 核心业务状态变化；
7. 主要业务对象流转；
8. 下游依赖或外部系统；
9. 等待、重试、错误、终止、成功完成出口；
10. 每个子模块节点必须能回链到对应子模块业务图。

总模块业务图禁止展开所有函数细节。它只能聚合已通过的子模块业务流程图、核心状态机概览和关键异常路径。

## 6. Mermaid 表达规则

业务流程图默认使用：

```mmd
flowchart TD
```

推荐使用 subgraph 表达子模块边界：

```mmd
flowchart TD
    Start([业务触发])
    subgraph SM1[子模块：请求接入]
        A[接收业务请求]
        B{请求是否有效}
        C[准备业务上下文]
    end
    subgraph SM2[子模块：核心处理]
        D[选择处理策略]
        E[执行核心业务动作]
    end
    Done([完成])
    Error([失败收敛])

    Start --> A
    A --> B
    B -- "有效" --> C
    B -- "无效" --> Error
    C --> D
    D --> E
    E --> Done
```

节点 ID 必须 ASCII。节点 label 使用中文业务语义。边 label 必须体现业务条件，不得只写 yes/no。

## 7. 图粒度控制

子模块业务图建议：

- 8 到 25 个节点；
- 10 到 35 条边；
- 一个图只表达一个业务子模块；
- 超过 25 个节点优先拆成场景图。

总模块业务图建议：

- 12 到 45 个节点；
- 使用 subgraph 表达子模块；
- 只展示关键业务条件，不展示所有代码分支；
- 如果总图超过 45 个节点，应拆为：
  - business-parent-main-flow；
  - business-parent-error-retry-flow；
  - business-parent-async-wait-flow；
  - business-parent-data-state-flow。

## 8. 无效业务图判定

以下业务图必须 REJECTED：

- 只有函数调用，没有业务动作；
- 只有目录或组件拓扑，没有业务流转；
- 只有 happy path，没有错误/等待/重试/终止；
- 关键节点无源码证据；
- 边没有业务条件；
- 子模块图未完成就生成总图；
- 总图没有引用子模块图；
- 图中大量使用函数名、文件名、结构体名作为主流程节点。

## 9. 正文绑定

必须新增或补强以下正文：

```text
05-enhanced-detail-design/02-business-flow-overview.md
05-enhanced-detail-design/08-submodule-business-flows.md
```

`02-business-flow-overview.md` 必须引用总模块业务流程 PNG。

`08-submodule-business-flows.md` 必须逐个引用子模块业务流程 PNG，并包含：

- 子模块简介；
- 子模块业务职责；
- 业务触发条件；
- 输入/输出业务对象；
- 业务步骤表；
- 业务条件表；
- 图后流程解读；
- 状态/数据影响；
- 异常、等待、重试、终止路径；
- 源码证据表。

## 10. 业务能力说明要求

业务能力纵览表不能只列能力名称。每个能力必须配套一段适中篇幅说明，建议 60-160 个中文字符，内容包括：

- 能力处理的业务对象；
- 被什么入口、事件、状态或条件触发；
- 主要业务动作；
- 输出结果、状态变化、数据变化或下游副作用；
- 与所属子模块的关系。

禁止把函数名列表当成能力说明。源码细节应放在证据列，能力说明应使用业务语言。

## 11. 子模块简介要求

每个重要子模块在正文中必须有图前简介，建议 120-260 个中文字符。简介必须覆盖：

- 子模块在整个模块中的业务定位；
- 上游触发和进入条件；
- 核心处理对象和关键状态；
- 正常完成后的业务结果；
- 典型异常、等待、重试或终止路径；
- 与其他子模块的交接关系。

图后必须有 1-3 段流程解读，解释主路径、关键分支和异常路径。不要逐个复述 Mermaid 节点，而要说明业务含义。

## 12. 与代码级图的关系

high-level 业务流程图先生成，用于说明“业务上发生了什么”。代码级子模块图、函数详情图和状态机图后生成，用于说明“源码如何实现这些业务流程”。

业务图中的每个关键节点和关键边都必须能映射到业务证据和源码/控制流证据。代码图不能替代业务图；业务图也不能替代代码图。

## 13. PASS 条件

业务流程层 PASS 必须同时满足：

- 09-business-capability-map.csv 非空；
- 10-business-flow-steps.csv 非空；
- 11-business-flow-edges.csv 非空；
- 12-business-flow-edge-coverage.csv 非空；
- 13-business-text-coverage.csv 非空；
- 每个重要子模块存在 high-level 业务流程 mmd/png；
- 总模块业务流程 mmd/png 存在；
- mmd/png 一一对应；
- 业务图 edge coverage 无 unverified；
- 正文引用业务总图和子模块业务图；
- 业务能力纵览表包含 capability_description；
- 每个重要子模块正文包含图前简介和图后流程解读；
- 业务图没有被判定为函数调用图或拓扑图。
