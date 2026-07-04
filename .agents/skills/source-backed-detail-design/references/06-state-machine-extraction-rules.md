# 06 State Machine Extraction Rules

## 1. 搜索关键词

必须搜索 fsm/state/phase/step/status/event/next/handler/dispatch/switch/case/enum/define/idle/init/ready/running/wait/retry/error/abort/complete/done/finish/timeout。

## 2. 状态变量

状态变量可能是 ctx->state、mp->state、flush_state、cur_state、next_state、phase、step、status。必须记录定义位置、可能取值、读取位置、写入位置、handler、状态改变条件。

## 3. dispatch 分析

必须记录 dispatch 函数、switch expression 或 table index、state value/case、handler function、default behavior、invalid state behavior。

## 4. handler 深挖

每个状态 handler 必须提取参数校验、分支、状态读写、下游调用、等待/重试/错误/完成路径、返回值。

## 5. 必需状态机图

每个重要 FSM 至少生成 dispatch、state-overview、transition-conditions、error-retry-timeout、handler-<state> 图。状态边必须包含 trigger/event、guard condition、action、next state、evidence ID。
