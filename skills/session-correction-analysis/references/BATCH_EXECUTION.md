# 批次连续执行与检查点

本指南说明批次任务的连续执行、上下文规划与分页检查点。命令入口为 `npx -y session-correction-analysis`；源码开发可先 build，使用下文的 `node dist/src/cli.js`。模型由宿主提供，候选保留待审核状态，来源范围由用户明确授权。分页返回原文，须在私有宿主中处理，不提供自动脱敏。

## 按轮次规划

```bash
node dist/src/cli.js batch --action tasks --batch sample --context-mode turn --context-events 1 --max-targets 20 --max-bytes 32768 --data-root ./private-batch-data
```

原有 tasks/claim 不传 context_mode 时保持 adjacent 行为。turn 加入包含目标的连续轮次与上一连续轮次，覆盖中间工具调用/结果；无 turn_id 时仍使用 context_events 窗口。单目标上下文超预算时 requires_paging=true，必须沿游标完整读取。不会因为上下文中出现其他用户消息而自动提交它们。

## 连续执行库接口

宿主从 `dist/src/batch/worker.js` 导入 `runBatchLoop`，提供真实的 worker 回调。

```javascript
const result = await runBatchLoop(dataRoot, batchId, {
  claim: {
    owner: 'analysis-host', worker_ready: true, ttl_ms: 60000, max_concurrency: 1,
    plan: { evidence_budget_bytes: 32768, max_targets: 20, context_events: 1 },
  },
  max_tasks: 100,
}, analyzeTask, abortSignal, optionalBudgetProvider);
```

analyzeTask 必须实际阅读、判断并返回现有 batch-submission/v1 或 v2。回调只有任务及其限定证据读取接口；不把 dataRoot 或完整 manifest 传给模型。循环默认 turn，显式传 adjacent 可保留相邻事件策略。

每次领取重新核对最新账本，充分目标跳过，uncertain 仍待处理。部分成功保留已写入判断，原任务以 partial_result 分类释放，再规划剩余目标。一次没有新增充分目标时返回 no_progress，不反复调用模型。其他返回为 task_limit、idle、cancelled、budget_blocked、complete 或 parsed_complete。parsed_complete 只表示解析出的目标全部充分提交，来源仍 partial；complete 仍是提交一致性声明，不证明模型阅读或真人身份。

预算 provider 在每次派发前返回现有 budget-input；缺 usage 的 indeterminate 不派发。无 provider 不推测预算。结果中的 read_context_loads 只计循环共用的正文读取上下文；租约与写入操作仍重新读取快照/队列/账本，并不表示全流程只有一次磁盘读取。

## 保存阅读位置

回调保留 page 的同步接口。每次有必要保存恢复位置时显式调用 checkpoint：

```javascript
let page = context.cursor
  ? context.page({ max_bytes: 32768, cursor: context.cursor })
  : context.page({ max_bytes: 32768, evidence_id });
await context.checkpoint();
while (page.next_cursor) {
  page = context.page({ max_bytes: 32768, cursor: page.next_cursor });
  await context.checkpoint();
}
```

checkpoint 保存当前限定游标、已连续交付完整正文的 completed_evidence_ids，并按原 TTL 续租。正文读取并非自动持久化；中断前未 checkpoint 的片段可能需要重读。completed_evidence_ids 是交付/声明记录，不是阅读或语义认证，旧提交接口也没有新增强制模型阅读证明。

回调开始时的 context.completed_evidence_ids 是恢复快照，可用于安排阅读。调用 checkpoint 后以持久化队列为准。legacy heartbeat 游标仍可作全局导航；带 completed_evidence_ids 的检查点游标必须 expand=true 且属于当前任务。clear_cursor=true 清除已结束的导航，不能同时提供 cursor。

同一 owner 在重新启动循环时可重放仍有效的领取 request_id，恢复当前任务和检查点。参数改变会拒绝重放。若判断已提交而完成回执丢失，循环检查目标版本并补发完成/部分结果回执，不再次调用模型。过期代次不能恢复；重新领取增加 generation。新 task_id 不继承旧游标。页接口在本地租约到期、取消或回调结束后关闭，队列写入另有 owner/generation/expiry 校验。

## 补充同来源上下文

```javascript
const evidenceIds = await context.requestContext({
  target_id, before: 8, after: 4,
});
```

target_id 必须是当前领取任务的目标。before/after 是原始事件数量，各为 0..32。控制层在批次锁内核对租约，只增加该目标同来源的邻接证据，持久化后才允许读取。合并证据最多 512 条、预计 16 MiB；超限拒绝，不截断正文。扩展列表在同任务接管时保留。

CLI 等价动作：`batch --action task-context --batch sample --input context-request.json --data-root ./private-batch-data`。输入为 `{task_id, owner, generation, target_id, before, after}`，输出只有 evidence_ids。这不授予跳过审阅、跨来源读取或语义复用。

## 复用只读快照

`loadBatchReadContext(root,id)` 只加载并完整验证一次原始快照，冻结其对象，缓存 manifest_hash、证据位置、目标映射与证据字节成本。`createEvidencePager(context)`、`planTasks(context,ledger,options)` 和 `batchStatusFromContext(context,ledger)` 可以复用这个上下文。每次 readLedger 仍校验最新账本；写入路径仍读取当前持久化状态并核对版本。

没有跨进程缓存，没有跳过校验的公共开关，没有修改 manifest 存储格式。临时回调得到的是任务副本；不能修改只读快照。输出页也是副本。
