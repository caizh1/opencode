# 09 Parent Module Assembly Rules

父模块图分为两类：

1. business-parent-module-master-flow：high-level 业务总流程图；
2. parent-module-code-flow：代码/架构视角父模块图。

business-parent-module-master-flow 必须先于 parent-module-code-flow 完成。业务总图聚合子模块业务图；代码父图聚合代码级子模块图、状态机图和异常路径图。

父模块总图必须最后生成。前置条件：至少一个 entry-to-main-flow；每个重要子模块至少一张详细业务流程图；至少一个状态机 overview 或转换条件图；error/retry/wait/timeout 图存在或说明源码无相关路径；edge coverage 覆盖子图关键边。

业务总图前置条件：

- business-capability-map 非空；
- business-flow-steps 非空；
- business-flow-edges 非空；
- 每个重要子模块 high-level 业务流程图已生成；
- 子模块业务图 edge coverage 无 unverified；
- 总图只聚合业务子模块，不展开函数内部。

父图必须包含外部入口、对外 API、子模块边界、核心数据结构、关键状态机、主要状态转换、下游依赖、error/wait/retry/complete 出口、指向子图的节点说明。

父图不能展开所有函数内部细节。函数内部细节必须在子图中表达。父图每个子模块节点应在 `diagram-index.md` 对应到具体子图文件。

代码/架构视角父图不得替代 business-parent-module-master-flow。最终正文必须同时引用 high-level 业务总图和代码/架构视角父图。
