# 10 Detail Design Output Templates

正文目录必须包含 README、模块概述、业务流程总览、架构依赖、核心数据结构、接口设计、主流程、状态机异常、子模块业务流程、代码级子模块详细流程、资源性能、构建集成、源码证据附录。

每章必须包含：本节结论摘要、源码证据表、详细设计说明、图与流程、待确认事项。

业务流程总览章节必须包含：

- 模块业务职责；
- 业务能力纵览表，且每个能力必须包含能力说明；
- 外部业务触发；
- 输入/输出业务对象；
- 总模块 high-level 业务流程图；
- 主业务路径；
- 错误/等待/重试/终止路径；
- 子模块交接关系；
- 源码证据表。

主流程章节必须先引用总模块 high-level 业务流程图，再引用父模块主流程图、入口到主流程图、entry-to-leaf 路径图、异常路径图。状态机章节必须引用状态机 overview、transition conditions、handler details。子模块业务流程章节必须每个子模块独占小节，包含子模块简介、职责、边界、业务触发条件、输入业务对象、输出业务对象、high-level 子模块业务流程图、关键业务步骤、条件流转、状态/数据影响、异常/等待/重试路径、源码证据表。

代码级子模块详细流程章节必须每个子模块独占小节，包含实现视角简介、职责、参与函数、代码级业务/逻辑流程图、关键步骤、数据流、异常/等待/重试路径、源码证据表。

正文建议输出文件：

```text
05-enhanced-detail-design/README.md
05-enhanced-detail-design/01-module-overview.md
05-enhanced-detail-design/02-business-flow-overview.md
05-enhanced-detail-design/03-architecture-and-dependencies.md
05-enhanced-detail-design/04-core-data-structures.md
05-enhanced-detail-design/05-interface-design.md
05-enhanced-detail-design/06-main-flow.md
05-enhanced-detail-design/07-state-machine-and-exceptions.md
05-enhanced-detail-design/08-submodule-business-flows.md
05-enhanced-detail-design/09-code-level-submodule-flows.md
05-enhanced-detail-design/10-resources-and-performance.md
05-enhanced-detail-design/11-build-and-integration.md
05-enhanced-detail-design/12-source-evidence-appendix.md
```


## 1. 业务能力纵览表模板

业务能力纵览不能只有能力名称。必须使用如下表格或等价字段：

```md
| 能力ID | 能力名称 | 能力说明 | 所属子模块 | 触发条件 | 业务结果/副作用 | 源码证据 |
|---|---|---|---|---|---|---|
```

字段要求：

- 能力说明建议 60-160 个中文字符，说明该能力具体处理什么对象、执行什么业务动作、产生什么结果；
- 触发条件必须来自源码入口、状态判断、事件、回调、定时器或调度条件；
- 业务结果/副作用必须说明状态变化、数据写入、下游调用、资源变化、错误收敛等；
- 源码证据必须引用 SRC/CE/BR/ST/BF，不得只写“见源码”。

## 2. 子模块章节模板

每个子模块小节必须按以下结构输出，禁止只放图：

```md
### <子模块名称>

#### 子模块简介
用 120-260 个中文字符说明该子模块的业务定位、触发来源、核心处理对象、输出结果、异常/等待/重试路径，以及与上下游子模块的衔接。

#### 职责与边界
| 项目 | 说明 |
|---|---|
| 主要职责 | |
| 不负责内容 | |
| 上游来源 | |
| 下游去向 | |

#### 输入与输出
| 类型 | 对象/状态 | 说明 | 源码证据 |
|---|---|---|---|

#### 业务流程图
![图 x-x 子模块业务流程](../04-diagrams/png/business/submodules/<name>.png){ width=6.5in }

#### 图后流程解读
用 1-3 段解释图中主路径、关键分支和异常路径。不要复述所有节点，要说明业务含义和源码依据。

#### 关键业务步骤
| 步骤 | 业务动作 | 条件/状态 | 结果 | 证据 |
|---|---|---|---|---|

#### 异常、等待与重试路径
| 路径 | 触发条件 | 处理方式 | 终态 | 证据 |
|---|---|---|---|---|
```

## 3. 文字质量要求

- 图前必须有简介，图后必须有流程解读；
- 简介不能只写“该模块负责初始化/处理/清理”，必须说明处理对象、触发条件和业务结果；
- 文字说明必须与源码证据一致；
- 不得为了补文字而降低现有 Mermaid 图质量，不得把大段文字塞入图节点。
