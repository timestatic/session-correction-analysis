# 批次分析协议

恢复步骤见[批次恢复手册](<BATCH_RECOVERY.md>)，涉及回执丢失、租约过期、部分提交与损坏状态的安全处理。

存储隔离、旧接口兼容及停用回退见[兼容与降级说明](<BATCH_COMPATIBILITY.md>)。

## 可注入worker库适配

runBatchWorker(root,id,claimInput,worker,signal?,budgetInput?)执行单次领取→回调→租约提交→完成；任务为空不调用worker。回调仅获得任务模板、恢复cursor、限定task.evidence_ids的page(evidence_id)和显式heartbeat，不提供主代理对话或data-root。page续页允许任务内证据的expand=true游标，拒绝全局/其他证据游标；heartbeat checkpoint同样校验任务范围。回调返回或失败后读取/续租接口关闭，残留调用拒绝；已读取的正文不可能由此撤回。此接口是应用层缩减上下文，不是进程/文件系统安全沙箱；受信适配器仍须遵循显式数据根。结果经严格submission及owner/generation/expiry校验。回调异常标记worker_error并输出无原文错误；结果schema校验失败转换为固定schema_invalid，不附原始Zod问题值/模型正文。结果校验/提交失败不自动重试或吞掉错误，保持running留待现有恢复流程，不标submitted。合法结果已入账但领取目标尚未全部有充分且非uncertain判断时返回outcome=partial和revision，保留running；这不是提交失败，也不宣称任务完成。回调接口仍关闭，剩余目标须显式恢复或过期接管；入账结果不撤回，request_id重放沿用旧载荷。可选AbortSignal协作取消：预先取消不领取；回调获得signal，取消后拒绝新page/heartbeat，回调返回或拒绝时以cancelled结束且不开始提交。不会与worker抢跑Promise后声称终止工作，忽略signal的worker仍须等待返回；已进入submitTask的提交不可撤回。租约过期/被接管时取消回执仍受fence拒绝，不能改新owner任务。无自动计时续租、模型调用、进程终止、usage采集或预算取消；模型适配与真实会话质量评估由调用方完成。

可选budgetInput沿用batch-budget-input/v1：领取前checkBudget；exceeded或indeterminate返回budget_blocked及报告，不领取/不创建队列/不调用worker。warning和within可继续；省略参数保持原行为。输入由调用者提供，不认证来源、时效或完整请求集合，不预留并发额度，不预测此次调用费用；多个worker用同一旧快照可能仍超预算。此门禁仅分配前快照检查，不是实时usage采集或运行中费用硬限/强制取消，不能据此宣称成本闭环。

库createEvidencePager(manifest)一次完整校验并持有schema克隆私有快照及预计算hash，单页只处理请求和局部事件；页输出独立克隆，调用者修改输入/输出不能篡改后续页。runBatchWorker复用此分页器，避免每页重新扫描冻结字节。兼容evidencePage单次入口仍逐次parse/hash，独立CLI进程也仍每次加载；heartbeat仍有存储加载开销，尚非端到端吞吐实测。损坏manifest/ledger/queue JSON与schema加载错误在存储边界固定脱敏，原文件不自动修复。

## 状态与范围

批次分析冻结用户明确指定的多个来源，按目标增量提交语义判断，并保留修订历史、租约与覆盖状态。支持 Codex、Claude Code 和 DSH v4 来源。

1. 单会话 register/prepare/ingest/review 保持独立；不能把分段结果反复送进单会话 ingest。
2. batch/v1 使用独立存储契约，无单会话候选审核桥接，不自动批准或写规则。
3. 来源由用户显式列出，时间模式仅 created。created_at 和 role 是声明；父来源始终 unverified，不按相同 ID 自动认证父子身份。活动模式及自动历史扫描未实现。
4. 内容相同只减少正文传递，不合并目标或自动复用语义。reuse_candidate_of 是审阅提示，reused_exact 提交当前拒绝。
5. full 表示提交声明的结构一致性，不证明模型实际读过；uncertain、待展开或来源解析缺口均阻止 full。

## 本地开发入口

正式安装使用 `npx -y session-correction-analysis`；本地未发布改动先 `npm run build`，使用 `node dist/src/cli.js` 或用户指定的测试包。

```bash
node dist/src/cli.js batch --action create --input batch-input.json --data-root ./private-batch-data
node dist/src/cli.js batch --action page --batch sample --max-bytes 32768 --data-root ./private-batch-data
node dist/src/cli.js batch --action page --batch sample --cursor '<next_cursor JSON>' --max-bytes 32768 --data-root ./private-batch-data
node dist/src/cli.js batch --action page --batch sample --evidence '<evidence_id>' --data-root ./private-batch-data
node dist/src/cli.js batch --action submit --batch sample --input submission.json --data-root ./private-batch-data
node dist/src/cli.js batch --action status --batch sample --data-root ./private-batch-data
```

batch 强制显式 data-root，不读取环境变量或默认根。建议专用私有目录；仅创建 batches 和锁，不调用旧记录读取/恢复。

## 输入

```json
{
  "schema": "session-correction-analysis/batch-input/v1",
  "batch_id": "sample",
  "scope": {
    "time_zone": "Asia/Shanghai",
    "start": "2026-09-01T00:00:00+08:00",
    "end": "2026-10-01T00:00:00+08:00",
    "time_mode": "created",
    "inclusion_rule": "用户指定的来源清单"
  },
  "sources": [{
    "path": "/explicit/source.jsonl",
    "host": "codex",
    "session_id": "verified-session-id",
    "created_at": "2026-09-02T00:00:00+08:00",
    "role": "direct",
    "role_basis": "user_declared"
  }]
}
```

来源 role：direct / automation / subagent / guardian / unknown；role_basis：native_metadata / user_declared / unavailable。可附 parent_session_id，但不认证关系。元数据身份不匹配会拒绝，不替换 session ID。同一逻辑 ID 可有不同路径、正文及来源角色。

## 冻结、复用与阅读

- 新 DSH 快照的 native_metadata.intervention_targets=true 将原生 interrupt/approval 纳入独立分析目标；不伪装成 user_message，不自动判阳性，origin 为来源声明。原生阳性只能标 intervention，不能标文字 correction。旧快照未声明该能力时保留原有用户消息目标集合，不悄悄补目标或改账本。父取消/系统错误不转换为用户中断。
- 批次单来源读取上限 64 MiB，超限明确拒绝；尚非流式大规模存储。保存原始字节 base64、字节哈希、路径、解析版本、完整 normalized events、目标用户项和来源角色。读取前后字节不同则拒绝，原文件不修改。
- 当前复用既有 host adapters；Claude sidechain 与压缩记录尚未完整展开，相关数量显式保留并将来源降为 partial，不能声称这些内容已覆盖。来源/证据 ID 带快照身份，所有已解析 user_message 均保留为目标（包括机器或未知来源）。不同分支前缀也各保留目标，不能把目标总数解释为去重真人事件数。
- 同批次正文逐字相等时 page 只给 reading_reuse_of；这是内容阅读复用提示，不是已读证明。通过 evidence 展开恢复全文，展开游标保留模式。
- page 的整体 JSON（含指导、元数据、目标和游标）受 UTF-8 字节预算约束。Unicode 不切断代理对，长单行按 text_offset 续读，可重建全文；预算连元数据都容不下则明确报错。
- 默认按来源顺序分页，含 actor、role_basis、origin 和 timestamp。审阅者需要邻接或前后证据时继续读取相邻 page；跨段问题通过 unresolved_evidence_ids 持久化。没有自动语义摘要或关键词筛除。
- batch id 不可变；重建相同内容幂等。显式 append 基于父批次的已冻结来源建立新 batch id，不重新读取旧路径；来源增长作为新来源快照追加，旧证据与账本不替换。跨批次语义覆盖不会自动继承。

### 显式追加来源

```bash
node dist/src/cli.js batch --action append --batch sample --input append-input.json --data-root ./private-batch-data
```

输入为 `{"schema":"session-correction-analysis/batch-append/v1","batch_id":"sample-next","sources":[<与create相同的source声明>]}`。父 scope 不变；新來源仍须落在已冻结的期间创建范围。相同快照不重复追加，没有新来源则拒绝。新批次继承旧快照及目标 ID，并保存私有 lineage.json，列出父快照哈希、保留/新增来源和新增目标 ID。

创建及 lineage 写入可用相同输入重试；同新 batch id 不同内容拒绝。父账本保持不变，新批次所有目标待判断；这是保守的快照关联，不是自动语义增量续跑。跨批次可信判断继承仍待实现。

### 精确来源差异

```bash
node dist/src/cli.js batch --action diff --batch sample-next --offset 0 --limit 20 --data-root ./private-batch-data
```

比较同 host/session 的精确 normalized event 序列，输出共享前缀/后缀数、双方差异区间 `[start,end)` 和区间内目标 ID。事件 ID、类型、主体线索、时间、工具关联和正文均参与比较，不把只差否定词的反馈合并。source_ref 位置不参与内容序列比较；声明相同 session 仍不证明主体身份。relation 为 exact_events / right_extends / left_extends / divergent，仅导航，不授权语义复用。append 的新 lineage 可携带 source_differences；旧 lineage 不含该字段仍可读取。diff 按条分页，但单条可能包含很多目标，后续需进一步字节预算化。

## 提交与恢复

```json
{
  "schema": "session-correction-analysis/batch-submission/v1",
  "manifest_hash": "sha256:<64 hex>",
  "request_id": "unique-request",
  "judgments": [{
    "target_id": "target-<hash>",
    "expected_version": 0,
    "reading": "inspected",
    "judgment": "negative",
    "classification": "ordinary_task",
    "evidence_status": "sufficient",
    "inspected_evidence_ids": ["ev-<hash>"],
    "unresolved_evidence_ids": [],
    "citations": []
  }]
}
```

classification：ordinary_task / refinement / correction / intervention / machine / unresolved。positive 只能 correction/intervention，并须引用目标原文；uncertain 须 unresolved。证据不足或展开未决不得提交确定负例/正例。不提供因果已认证的返工事实，完整episode及旧审核桥接后置。库函数reworkEvidencePairs提供同来源反馈前后file_edit与唯一call_id配对成功tool_result的候选索引，要求结果出现在编辑后、前一结果在反馈前、后一编辑在反馈后且路径有交集；失败/未知结果不入选。成功关键词仅机械信号不是返工因果认证，semantic_verified始终false；`batch --action rework --batch <id> --offset 0 --limit 20 --data-root <root>`分页只读输出候选证据引用和shared_path_hashes，不输出正文或实际路径；哈希不等于匿名化。重复编辑call_id、重复结果call_id的歧义均排除。不跨来源推断时序。

v2正例judgment可附加 `rework:{"causal_status":"unverified","earlier_edit":"<evidence>","earlier_result":"<evidence>","later_edit":"<evidence>","later_result":"<evidence>"}`，四个引用须不同且均在inspected_evidence_ids。提交及加载账本共同验证同源顺序edit/result < feedback < edit/result、唯一call_id成功配对、编辑路径交集。只持久化待因果复核的机械证据声明，不允许声明verified或审批；旧v1拒绝rework。尚无旧审核桥接。

v2正例judgment可附加candidates数组（最多10项），每项严格为 `{"kind":"memory|harness","content":"待审核规则建议","evidence_ids":["<evidence>"]}`。content最多16384字符；引用须唯一、均已审阅且有judgment引文，同判断完全重复候选拒绝。未知字段如status/approved/published全部拒绝。候选保存于当前判断及历史，不审批、不发布、不写旧records或accepted_rules；判断修订后以最新候选为当前，旧候选保留审计历史。正文仍可能含敏感信息，留私有数据根不自动导出。

`batch --action candidates --batch <id> --offset 0 --limit 20 --data-root <root>`只读列出最新有效候选的稳定candidate_id、target_version、kind、content_hash、证据引用及unreviewed。默认不输出content；哈希不是匿名化。判断版本变化导致候选ID变化，候选移除后历史仍保留，不自动继承审核决定。无批准/发布命令或旧记录桥接。

`batch --action candidate-detail --batch <id> --input <request.json> --data-root <root>` 输入严格为 `{"candidate_id":"<当前候选ID>","expected_content_hash":"sha256:<hash>"}`，匹配当前版本和哈希后显式返回content。过期/移除候选或错哈希拒绝。此动作会输出敏感建议正文，只有实际审阅需要时调用，避免日志公开；查询不记录审批，不授权复制/发布。

显式双标签使用batch-submission/v2，每条judgment额外必填 `labels:{"correction":true,"intervention":true}`。至少一项true须positive，主classification仍选correction/intervention且对应label必须true；negative/uncertain两项均false。两项可同时true，独立目标只计一次。v1继续严格拒绝labels，原账本保持兼容，v2事务保存版本以恢复请求哈希；旧客户端不支持v2时停止读取新账本，不抹掉标签降级。此字段只是分析者提交声明，不证明因果或真人认证。

加载快照时验证冻结字节/长度/哈希、来源及证据身份、精确阅读引用、目标清单完整且不重复；加载账本时验证请求载荷哈希、唯一请求、连续目标版本、引用及判断一致性，损坏数据阻止统计和后续写入。这些校验识别意外损坏，不是签名认证，不能证明归因或模型阅读。

单次batch-submission/v1或v2完整规范JSON（含信封、目标、引文）最多1 MiB UTF-8字节，手工submit及托管task-submit统一校验；超限不截断、拒绝且不写账本。须将实际审阅目标拆为不同request_id提交；单目标引文选择充分必要片段，不提交整段巨型原文。

单目标初始 expected_version=0，每次有效修订加一。可只提交部分目标，历史累积，统计用最新有效判断。同 request_id 相同 payload 幂等，不同 payload 拒绝；不同 request_id 旧版本提交拒绝。锁使用既有 proper-lockfile；原子账本替换，不强制解锁。

status附加labels统计correction/intervention/intersection/positive_targets，使用有效最新判断：v2按显式labels，旧v1按主分类映射；交集目标只计一次positive_targets/semantic_complete，标签计数不能相加当目标分母。这不是独立episode数或可信真人统计。

status附加actor_coverage，按direct/automation/subagent/guardian/unknown分别计targets/submitted/sufficient/pending/uncertain及partial_sources；submitted_coverage=sufficient/targets，空分母为null。相同正文不同主体仍为独立目标，不能累进直接用户分母。角色来自声明不是可信真人认证，覆盖比例是提交声明而非模型已读证明；partial来源即使已解析目标全提交也不代表来源全覆盖。

取消后保留游标和相同请求即可续跑；机械任务租约及回执已提供，尚无自动模型执行器、模型限流或 usage 调度。

## 最小上下文任务规划

```bash
node dist/src/cli.js batch --action tasks --batch sample --max-bytes 32768 --max-targets 20 --context-events 1 --offset 0 --limit 20 --data-root ./private-batch-data
```

只读冻结清单及有效账本，按完整证据预计字节量/目标数合批，不固定会话数。每目标仅归一个任务，附邻接事件（默认前后各1，可设0..4）、未决展开引用、expected_version、manifest_hash 和稳定 task_id。语义充分的有效目标跳过；不确定目标重新排队。相同状态和参数生成相同规划，版本变化会改变相关任务身份。

超预算的单目标不能被丢弃或裁剪：独立任务标 requires_paging，worker 沿 page/证据展开无损读取。estimated_evidence_bytes 是导航成本估算，不是实际 Token 或整体任务 JSON 的硬字节上限；任务只带引用和短规范，不包含证据正文。命令按条分页，尚无自动worker调用；可通过下述持久化机械租约调度。worker必须核对当前版本，旧任务提交会被CAS拒绝；任务完成与语义覆盖仍以提交账本为准。

## 任务租约与失败恢复

```bash
node dist/src/cli.js batch --action claim --batch sample --input claim.json --data-root ./private-batch-data
node dist/src/cli.js batch --action task-submit --batch sample --input task-submit.json --data-root ./private-batch-data
node dist/src/cli.js batch --action finish --batch sample --input receipt.json --data-root ./private-batch-data
```

claim输入：`{"request_id":"unique-claim-one","owner":"worker-one","worker_ready":true,"ttl_ms":600000,"max_concurrency":2,"plan":{"evidence_budget_bytes":32768,"max_targets":20,"context_events":1}}`。只有已就绪worker可领取，ttl 1秒至1小时；并发配置1..4，运行目标重叠时不重复分配。返回task、generation、expires_at；没有可领取任务返回task:null，不代表全覆盖。request_id为可选兼容字段，推荐托管worker必填：成功领取后丢回执，沿用相同编号和参数重试会返回同任务/代次，不额外分配。不同参数拒绝，过期或终态编号不能复用，接管/重领使用新编号；旧编号关联持久保留。未分配task:null不记录成功领取，可沿用原编号稍后再试。

task-submit输入：`{"task_id":"task-...","owner":"worker-one","generation":1,"submission":<batch-submission/v1>}`，只允许当前未过期代次提交其领取目标。托管worker不得调用无租约的手工submit绕过fence；手工submit仍保留给显式人工分析路径。模型语义结果必须先实际审阅，再提交。成功写入账本后回执丢失，可在同任务owner/generation仍匹配时重放完整相同request_id/payload；即使租约已过期或任务已终态，也只读返回duplicate，不再写入。旧代次被接管后拒绝该托管回执重放，须查询账本确认结果；任何未成功的新请求仍执行有效租约检查。

finish输入：`{"task_id":"task-...","owner":"worker-one","generation":1,"outcome":"submitted"}`。完成必须所有领取目标在有效账本中已有充分确定判断；uncertain任务不能完成。失败/取消用outcome failed/cancelled并带failure worker_error/budget_exceeded/cancelled，保留可重试状态。重复同结果回执幂等，过期或旧代次拒绝；超时后由新worker领取并增加代次，不强制解锁。长任务可在过期前用heartbeat续租，过期后不能复活旧代次。

`batch --action heartbeat --batch <id> --input <heartbeat.json> --data-root <root>` 输入为 `{"task_id":"task-...","owner":"worker-one","generation":1,"ttl_ms":600000,"cursor":<可选page游标>}`。游标须属于当前快照且定位合法；续租不缩短现有期限。相同task重新领取时保留游标，仅作导航，不能证明证据已读或完成。

`batch --action queue --batch <id> --offset 0 --limit 20 --data-root <root>` 只读返回运行、过期、提交、失败、取消计数及分页任务详情。读取状态不自动回收租约，也不修改覆盖判断。

queue.json权限0600，以proper-lockfile和原子替换持久化。加载时验证目标属于快照、模板目标/证据引用一致、游标合法及领取历史代次关联；损坏拒绝，不自动删除状态或解锁。旧队列缺少新可选模板/claim字段仍可读，但现有引用必须有效。并发参数应由同一调度器统一配置；接口不自动启动worker、不预测最佳并发、不认证owner身份。并发1/2/4的合成分配测试已验证上限和不重复目标领取，托管提交越界/过期拒绝后账本不变。领取时刻在取得锁并完成任务规划、快照及队列校验后采样，准备耗时不占用新租约；已有租约的有效性也按该时刻判断。真实模型吞吐和故障注入全矩阵仍待测，不能用合成并发测试宣称性能收益。

## 隐私和存储

证据文件权限 0600，从临时文件创建时生效；批次目录创建权限 0700。冻结文件包含原始资料和可能的凭据，base64 不是脱敏或加密，不可作为交付附件或上传 CI。父目录权限及本机访问控制由用户负责。尚无自动保留期/删除命令，不删除旧数据。

## 离线用量口径

```bash
node dist/src/cli.js batch --action usage --input usage.json --data-root ./private-batch-data
```

只处理显式文件，不扫描宿主历史、不写批次数据。输入schema为session-correction-analysis/batch-usage-input/v1，expected_agents声明主代理与全部子代理；entries每条包含agent_id、model、request_id、mode cumulative/final、sequence、noncached_input_tokens、cache_read_tokens、output_tokens及可选active_ms。

计数必须先由导出方转换为**逐请求累计口径**：不接受增量delta、会话总计或不明确的缓存定义。相同代理/模型/请求只选择一致final一次；缺final选最高sequence累计值并标provisional。相同sequence不同计数、下降累计值、final低于累计值或冲突final均拒绝。报告分代理并标missing_agents、provisional_requests及缺时间请求；缺失不能填零后声称完整。所有Token类别分别列出，不换算费用；active_ms求和是代理活跃时间累计，不是并发墙钟耗时。当前未自动采集真实usage，不能用该工具存在替代实际成本对照验收。

## 离线预算告警

`batch --action budget --input budget.json --data-root <root>` 接收 `{"schema":"session-correction-analysis/batch-budget-input/v1","usage":<上述usage输入>,"limits":{"noncached_input_tokens":100000,"output_tokens":20000},"warning_fraction":0.8}`。limits至少一项，可选cache_read_tokens和active_ms，均为正安全整数。达到上限为exceeded；数据完整且达到预警比例为warning；低于预警为within。缺代理/缺final或时间限额缺活跃时间为indeterminate，除非已知累计已达到上限，此时仍是exceeded。报告只读提供建议，不自动取消、不启动worker、不修改账本。未知不能当零，不是未来成本预测；active_ms依然不是墙钟时间。

## 独立复核工作清单

```bash
node dist/src/cli.js batch --action audit --batch sample --input audit-options.json --offset 0 --limit 20 --data-root ./private-batch-data
```

输入 `{"seed":"predeclared-seed","negative_fraction":0.2}`，seed在观察结果前冻结；fraction不得低于20%。全部正例和全部不确定项进入清单，负例按seed+target_id的哈希排序取ceil(N*fraction)，可重复且不依赖输入遍历顺序。全部项目均是unreviewed，带manifest_hash、目标版本和judgment_hash；判断修订后对应复核失效。待处理目标单列，不能用抽查代替全覆盖。

工具不产生human gold、不写人工审核、不计算总体质量收益。人工须实际独立审阅；发现漏报扩大相应类别复核。完整对照试验仍须人工全量标注及争议裁决、先冻结precision/recall容忍阈值、同模型同快照比较，并报告样本不确定性。CLI 只提供未标注的工作清单，不代表人工复核或质量评估已完成。

## 身份异常清单

`batch --action identity --batch <id> --offset 0 --limit 20 --data-root <root>` 仅读取已冻结manifest，列出unknown_actor、unverified_actor_basis、unverified_parent、partial_source、same_session_divergence、same_session_actor_conflict。只输出来源引用及受影响目标计数，不带正文或路径。affected_sources/affected_targets跨原因去重，单条target_count不能直接累加。清单为待核验提示，不是身份认证或自动隔离决策；native_metadata/user_declared也不等于可信授权。不自动归并来源、不批准语义复用、不修改已提交判断。

## 连续执行与上下文扩展补充

按轮次规划、runBatchLoop、task-context 和阅读检查点的完整接口见 [执行指南](BATCH_EXECUTION.md)。旧任务策略默认 adjacent，循环默认 turn。队列扩展字段 completed_evidence_ids 与 failure=partial_result 可选；新代码可读取旧队列，旧二进制不保证读取新扩展字段。扩展证据在同一任务身份下经 fence 持久化，不能据此改变目标或复用语义。只读 BatchReadContext 复用一次验证后的快照与索引；写入仍读取最新状态。

## 验证范围与后续工作

工程回归覆盖来源分歧、不同主体的相同正文、Unicode 分页和整体预算、重复提交、旧修订拒绝、未决目标、快照追加、租约与恢复状态。真实 npm 包冒烟测试核验发布文件、安装后的命令入口和单会话流程。

仍需分别核验以下事项，不能由工程测试替代：

- 来源主体、父子关系与转发身份；当前 identity 只提供待核验清单，不自动隔离、认证或归并。
- 返工因果和候选质量；双标签、成功编辑配对与待审候选已提供，仍需实际阅读证据和人工审核。批次候选尚未桥接到单会话审核流程。
- 宿主模型适配、实时 usage 采集、模型限流和运行中预算控制；现有 worker 回调、循环、租约及显式 usage/budget 不能替代这些能力。
- 人工金标与同模型、同快照的质量、成本和时间对照；audit 只生成版本绑定的待复核清单，不产生人工金标，也不证明收益。
