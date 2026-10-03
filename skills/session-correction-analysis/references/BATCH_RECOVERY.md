# 实验性批次恢复手册

使用本地build的CLI，所有命令显式指定同一个私有data-root。不使用旧ingest补批次结果，不修改既有record，不自动审核或发布。完整输入格式见[批次协议](<BATCH_PROTOCOL.md>)。

## 先确认结果再重试

| 现象 | 操作 | 不可做 |
|---|---|---|
| claim成功回执丢失 | 未过期时以同request_id和完整相同参数重试，返回原任务/代次 | 换编号盲领第二任务 |
| claim过期/终态 | 查询queue和status，用新claim request_id重新领取尚需处理范围 | 复活旧代次或复用旧编号 |
| task-submit成功回执丢失 | 同任务owner/generation重放完整相同submission；已成功且未被接管时可在过期/终态取回duplicate | 改payload沿用request_id |
| submit回执丢失且已被接管 | 查询有效账本覆盖；不要重新提交旧expected_version，重新领取最新任务 | 用手工submit绕过托管fence |
| runBatchWorker返回partial | 已入账revision保留，任务仍running；当前owner可显式finish failed再新领取剩余目标，或等待过期接管 | 把partial当提交失败换request重复写入，或自称全任务完成 |
| runBatchWorker非法结果 | 固定schema_invalid，未写入此结果且保持running；核对私有结果协议与queue后显式分类失败/恢复 | 公开模型原文错误日志，或反复盲重跑模型 |
| 部分判断已提交，其余失败 | finish分类failed；重新领取，充分已提交项会跳过，不确定项保留 | 假称全任务submitted |
| 阅读中断 | 过期前heartbeat保存合法游标并续租；恢复时核对manifest_hash和任务版本 | 把游标当证据已读证明 |
| 人工或另一worker已修订 | revision_conflict后核对最新有效判断及expected_version，再实际审阅 | 强改版本覆盖他人判断 |
| budget exceeded | 暂停新分配；取消当前任务需当前owner/generation和分类原因 | 自动删除判断或强制解锁 |
| budget indeterminate | 补齐全部代理及final回执；未知不是零 | 宣称剩余预算充分 |
| queue/ledger/manifest损坏 | 停止写入，保留现场，由人工核验私有备份 | 删除锁、删queue后重跑或重算哈希假装修复 |
| 来源文件增长 | append至新batch id，保留旧冻结字节，不继承语义 | 修改旧manifest或无凭据继承标签 |

## 无副作用检查

```bash
node dist/src/cli.js batch --action status --batch sample --data-root ./private-batch-data
node dist/src/cli.js batch --action queue --batch sample --offset 0 --limit 20 --data-root ./private-batch-data
node dist/src/cli.js batch --action identity --batch sample --offset 0 --limit 20 --data-root ./private-batch-data
```

queue分页状态读取不回收租约。status的full只检查声明结构，不证明模型确实读过证据。恢复不更改人工审批；批次协议尚无旧候选桥接。

## 取消后的恢复约束

失败/取消保留可重试状态，读取游标只在相同task身份重领时保留；部分提交会改变任务规划及task id，不能假定旧导航游标适用于新任务。新任务使用新的expected_version，逐项确认实际已读范围。机器身份未核验和来源partial继续报告未决，不因恢复而升级为充分。

## 未完成验收

合成并发1/2/4、租约过期/代次接管、取消重领、成功回执丢失、损坏状态拒绝均有工程回归；尚未完成真实模型调度、进程崩溃各写入时点注入、真实usage采集和人工质量对照。不要将本手册视为生产放行或50%效率收益证据。真实批次应用须质量对照放行后另行执行。

## 有界串行循环

runBatchLoop 可以恢复同一 owner 的有效领取、处理已入账但完成回执丢失的任务，并在 partial_result 后规划剩余目标。checkpoint 显式保存限定游标和完整正文交付声明；task-context 扩展在同任务接管时保留。新 task_id 不继承旧游标。具体接口与停止条件见 [执行指南](BATCH_EXECUTION.md)。
