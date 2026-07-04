# 04 Control Flow Evidence Schema

控制流证据表是画图前置门禁。未生成真实行，不得生成 Mermaid。

## 1. function inventory

`01-function-inventory.csv`：

```csv
function,file,line_start,line_end,storage_class,declared_in,role,submodule,reads_state,writes_state,calls_count,needs_branch_analysis,notes
```

## 2. entry points

`02-entry-points.csv`：

```csv
entry_function,entry_type,file,line_start,line_end,called_by_external,reason,first_level_callees,notes
```

entry_type 包括 exported_api/init/load/run/process/handler/fsm/callback/timer/task/interrupt/table_dispatch。

## 3. call edges

`03-call-edges.csv`：

```csv
edge_id,caller,callee,call_type,condition,enclosing_branch,state_before,state_after,data_before,data_after,file,line,evidence
```

condition 不能为空；无条件必须写 always；函数指针必须记录 candidate targets；动态 dispatch 必须记录 selector/index/table。

## 4. function branches

`04-function-branches.csv`：

```csv
branch_id,function,branch_type,condition,true_path,false_or_next_path,calls,state_reads,state_writes,data_reads,data_writes,return_value,file,line_start,line_end,evidence
```

branch_type 包括 if/else_if/else/switch/case/default/loop/return_check/status_check/macro_condition/goto_cleanup。

## 5. state transitions

`05-state-transitions.csv`：

```csv
transition_id,state_machine,state_variable,current_state,handler,trigger_or_event,guard_condition,actions,next_state,terminal_type,file,line_start,line_end,evidence
```

terminal_type 包括 continue/wait/retry/complete/error/abort/reset/return/unknown。

## 6. entry-to-leaf paths

`06-entry-to-leaf-paths.md` 必须追到 complete/error/wait/retry/abort/return，并列出条件序列、调用序列、状态序列、数据序列、证据行。

## 7. edge coverage

`08-diagram-edge-coverage.csv` 必须将每条关键 Mermaid 边映射到 CE/BR/ST/SRC 证据。

## 8. business flow evidence

业务抽象证据由 `15-business-flow-abstraction-rules.md` 定义。业务图使用 BF 证据和 SRC/CE/BR/ST 证据联合支撑。

业务流程相关输出包括：

- `09-business-capability-map.csv`
- `10-business-flow-steps.csv`
- `11-business-flow-edges.csv`
- `12-business-flow-edge-coverage.csv`
- `13-business-text-coverage.csv`

这些文件必须在 high-level 业务流程图前生成。业务图 edge coverage 不得复用代码级 `08-diagram-edge-coverage.csv` 冒充完成。


## 9. business capability map

`09-business-capability-map.csv`：

```csv
business_capability_id,capability_name,capability_description,business_value,scope_boundary,submodule,source_functions,source_states,source_data_objects,trigger,key_steps,output_or_side_effect,confidence,evidence_ids
```

要求：

- `capability_name` 只写能力名称，不得把说明塞进名称；
- `capability_description` 必须用适中篇幅说明该能力具体做什么，建议 60-160 个中文字符；
- `business_value` 说明该能力对模块业务结果的价值，例如接入校验、状态推进、数据落盘、资源回收、异常收敛；
- `scope_boundary` 说明该能力负责什么、不负责什么；
- `key_steps` 用业务语言概括 2-5 个关键步骤；
- `source_functions` 和 `evidence_ids` 不能为空；
- 低置信或源码未确认的能力不得写入确定性能力纵览，只能进入待确认事项。

## 10. business flow text coverage

`13-business-text-coverage.csv`：

```csv
item_type,item_name,section_file,has_description,description_chars,has_evidence,diagram_refs,quality_status,notes
```

item_type 包括 capability/submodule/parent_flow。quality_status 包括 pass/weak/missing。每个业务能力和每个重要子模块都必须有一行覆盖记录。
