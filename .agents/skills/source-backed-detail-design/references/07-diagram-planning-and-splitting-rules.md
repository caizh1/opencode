# 07 Diagram Planning and Splitting Rules

## 1. 先计划后画图

必须先生成 `04-diagrams/diagram-plan.md`。表格列：Diagram、Type、Evidence inputs、Functions covered、Branches covered、State transitions covered、Split reason、Output。

业务流程图必须额外生成 `04-diagrams/business-flow-plan.md`。表格列：Diagram、Business level、Evidence inputs、Business capabilities covered、Business steps covered、Business edges covered、Submodules covered、Split reason、Output。

## 2. 图层级

业务流程图层级必须先于代码级详细图规划。业务图和代码图不得混用同一张图表达。

业务图层级：

- B0 business-parent-module-master-flow：总模块 high-level 业务流程图；
- B1 business-submodule-flow：子模块 high-level 业务流程图；
- B2 business-scenario-flow：复杂场景、异常场景、异步等待场景；
- B3 business-data-state-flow：业务对象和业务状态流转图。

代码图层级：

- C0 parent-module-code-flow；
- C1 entry-to-main-code-flow；
- C2 submodule-code-detail-flow；
- C3 function-detail-flow；
- C4 fsm-state-overview；
- C5 fsm-transition-conditions；
- C6 error-retry-timeout-code-flow；
- C7 dependency-data-code-flow。

兼容旧命名时，可将以下层级视为代码图层级：L0 parent-module-master-flow，L1 entry-to-main-flow，L2 submodule-business-flow，L3 function-detail-flow，L4 fsm-state-overview，L5 fsm-transition-conditions，L6 error-retry-timeout-flow，L7 dependency-data-flow。

## 3. 拆图阈值

节点 >35、边 >45、subgraph >6、状态 >8 且展开 handler、嵌套分支 >2 层、混合模块架构和函数内部时必须拆图。

high-level 业务总图如果超过 45 个节点，应拆为：business-parent-main-flow、business-parent-error-retry-flow、business-parent-async-wait-flow、business-parent-data-state-flow。

## 4. 有效业务流程图

必须包含至少 5 项：decision node、branch label、switch/case label、loop condition、condition 下调用、state read/write、data read/write、return condition、error path、wait/retry path、complete path、evidence mapping。

本条主要适用于代码级详细业务/逻辑图。high-level 业务流程图的有效性以第 5 节为准。

## 5. high-level 业务流程图有效性

high-level 业务流程图必须包含至少 6 项：

- 外部业务触发；
- 业务输入对象；
- 子模块业务动作；
- 业务条件边；
- 业务状态或数据影响；
- 下游依赖或异步等待；
- 错误/重试/终止路径；
- 成功完成路径；
- BF edge coverage。

high-level 业务流程图不得以函数名作为主流程节点，不得只有组件拓扑，不得只画 happy path。
