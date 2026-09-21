# 已采纳规则清单契约（LC-01 冻结记录）

冻结时间：2026-09-20。依据 [design.md 第 31 节](../design.md)。本文件是**契约与数值的记录处**：schema 定义在 `src/domain/rules.ts`，数值定义在 `src/domain/limits.ts`，`tests/unit/domain/rules.test.ts` 的最后一组用例把本文件的 schema id、错误码、CLI 子命令、文件名和数值逐条对回代码——改代码不改本文件，测试即失败。

本期只冻结契约，不写清单：`src/store/rules.ts`、`src/store/acceptance.ts` 属 LC-02，生命周期服务属 LC-03，复查装配属 LC-04，`sca rules` 接线属 LC-05。上表命令在 LC-05 之前不可运行。

## 1. Schema id 与升级契约

| schema id | 载体 | 未知 schema 时的行为 |
|---|---|---|
| `session-correction-analysis/v1` | 会话记录：`analyze.md` + `learning_candidates.md` | `read_only_refuse_write` |
| `session-correction-analysis/accepted-rules/v1` | 根级清单：`accepted_rules.md` | `read_only_refuse_write` |
| `session-correction-analysis/rule-review-snapshot/v1` | 冻结复查快照（`rules review-prepare` 产物） | `review_unavailable` |
| `session-correction-analysis/rules-migration/v1` | `rules migrate --dry-run` 报告 | `refuse_apply` |

代码事实源是 `RULES_SCHEMA_COMPAT`。规则：**读得懂才写**——不认识的 schema id 一律拒绝写入并转只读，不做静默降级、不做双写，因此旧二进制不可能把新状态"半个升级"回去。版本升级只加字段不改语义；需要语义变更时开新 schema id，并在本表补一行处置。

清单**缺失**与**损坏**是两件事：存在会话记录却没有 `accepted_rules.md` 表示"未初始化/待迁移"（`rules_registry_missing` → `migration_required`），绝不解释为"用户没有规则"；无法解析的清单视为损坏——会话分析继续跑，复查标记 `unavailable`，并禁止 review/publish 写入。

## 2. 文件与锁

- 清单：`<data-root>/accepted_rules.md`（`ACCEPTED_RULES_FILE_NAME`）。权威业务数据，与两个会话 Markdown 同级；**不进 `runtime/`**——那里只放锁和可重建缓存。
- 锁：`<data-root>/runtime/locks/rules-registry`（`REGISTRY_LOCK_NAME`）。
- 全局锁获取顺序固定为 `registry → session → target`（`LOCK_ORDER`），同层按键/规范路径排序。持有 session 锁的代码**不得回头**再取 registry 锁。采纳是跨文件事务，短事务内完成，不跨模型推理。
- 会话文件只保留原始候选、审计轨迹和 `rule_ref`；`analyze.md` 只保留最小 `used_rules` 正文快照与观察。规则正文的当前权威只有一份：根级清单。

## 3. 数值（LC-01 冻结）

| 常量 | 值 | 含义 |
|---|---|---|
| `RULE_CONTENT_MAX_BYTES` | 4000 | 单条规则正文上限，按 **UTF-8 字节**计，超出即拒收、绝不截断 |
| `RULE_SCOPE_NOTE_MAX_BYTES` | 500 | scope 的自由文本备注上限（字节） |
| `RULE_HISTORY_MAX_ENTRIES` | 200 | 每条规则保留的操作历史 |
| `ACCEPTED_RULES_MAX_RULES` | 5000 | 清单规则条数硬上限，超出按损坏处理而不是分页 |
| `ACCEPTED_RULES_READ_MAX_BYTES` | 16777216 | 清单安全读取预算（16MiB），超限在读前拒绝 |
| `RULES_REQUEST_LOG_MAX` | 500 | 清单幂等请求窗口 |
| `RULES_MIGRATE_BATCH_MAX` | 50 | `rules migrate --apply` 单次提交条数 |
| `RULE_REVIEW_SNAPSHOT_MAX_BYTES` | 196608 | 单个冻结复查快照的序列化字节预算（192KiB） |
| `RULE_REVIEW_SNAPSHOT_MAX_RULES` | 40 | 快照规则条数**上限**，不是装箱目标 |
| `RULE_REVIEW_SNAPSHOT_MAX_EPISODES` | 200 | 快照冻结的 episode 条数 |
| `RULE_OBSERVATION_EXPLANATION_MAX_BYTES` | 1000 | 单条观察解释上限（字节） |

正文与解释按字节而非字符封顶：本产品的规则文本常见中文，字符上限会让 3 字节/字符的正文越过所有字节预算，而字节预算才是"清单读得回来、快照装得下"的依据。256KiB（`PENDING_COMMIT_MAX_BYTES`）仍是**单次操作**预算，不是清单总大小上限。

## 4. 体积与解析实测

复现：`npm run build && node packaging/measure-rules-budget.mjs`。条件：macOS 14.2.0 (darwin arm64)、Node v24.19.0、zod 3.25.76；合成规则=最大正文 + 一条 project scope + 交替的 delivery，经与业务文件同一个 frontmatter 渲染器序列化，再用同一个解析器读回（`reparsed_rules` 全部回读成功）。文件里的正文出现两次（YAML + 人类可读投影），故平均约 2.3× 正文大小。

| 场景 | 字节 | YAML 段 | 解析耗时 |
|---|---|---|---|
| 100 条 × 1024B ascii | 318671 | 212152 | 约 37–40 ms |
| 1000 条 × 1024B ascii | 3187064 | 2121144 | 约 234–253 ms |
| 1000 条 × 4000B ascii（上限正文） | 9139064 | 5097144 | 约 242–265 ms |
| 1000 条 × 3998B 中文正文（上限字节、另一脚本） | 9225064 | 5140144 | 约 195–240 ms |

结论：正文按字节封顶后，1000 条满载清单稳定在 9.2MB 上下，16777216 预算留约 1.8 倍余量且**不会拒读合法清单**；单次全量解析在数百毫秒量级，属显式 CLI 操作可接受范围（清单不做每请求全量热路径）。5000 条上限对应约 46MB，已超过读取预算，因此达到上限的文件按"损坏/异常"处理而不是继续分页。

| 复查快照 | 序列化字节 | 是否在 196608 预算内 |
|---|---|---|
| 10 条 × 1024B ascii | 19247 | 是 |
| 40 条 × 1024B ascii | 74692 | 是 |
| 40 条 × 4000B ascii | 193732 | 是（仅剩 2876 余量） |
| 40 条 × 3998B 中文正文 + 满载备注 + 中文标题 | 215852 | **否** |
| 30 条同上 | 162082 | 是 |
| 1 条同上（快照信封 526B + 单条） | 6027 | 是 |

因此 40 只是条数天花板：`rules review-prepare` **按字节装箱**，装入 `RULE_REVIEW_SNAPSHOT_MAX_BYTES` 为止，装不下的规则进入 `partial` coverage 并列出，绝不静默丢弃；单条最大 CJK 规则约 6027 字节，装箱永远至少能装下 1 条，不存在"打包即失败"的状态。

## 5. 采纳、幂等与恢复（跨文件事务的可判定部分）

- `rule_id` 由采纳来源确定性派生：`rule-<sha256(record_id + candidate_id) 前 16 位>`（`computeRuleId`）。同来源重复批准回放同一 id，不产生第二条规则；内容编辑与迁移都不重编号。
- 每条规则携带 `version` / `content_hash`（绑定正文+scope）/ `accepted_at` / `version_effective_at` / `source`（record_id、candidate_id、候选路径、候选内容 hash、`accepted_request_id`）/ `delivery`（当前版本回执或 null）/ `history`。首条历史必须是 v1 的 `accepted`，版本单调不降，且当前 `version` 必须有一条用户操作记录——历史不丢用户操作。
- 沉淀是三个独立事实：采纳（清单）≠ Harness 投递（`not_persisted→prepared→writing→verified/failed/needs_reconciliation`）≠ Memory 内容（`not_exported→exported→`可选 `user_confirmed_saved`）。没有投递 sink，也没有"宿主已加载"的证明。编辑规则会重置当前版本的 delivery，旧回执留在历史；撤销从不自动回滚用户随后编辑的外部文件。
- 采纳事务在清单里持久化 `pending_acceptance`（request_id、payload_hash、钉住的 rule_id、两侧 expected revision/hash、有界的单条 delta）。判定顺序固定：**先幂等后 revision**——同请求同 payload 返回原回执；同请求不同 payload 以 `request_conflict` 拒绝；外部编辑破坏了 expected hash 时停止回放、保留冲突并上报 `registry_changed`，绝不覆盖用户改动。恢复失败 → `rule_acceptance_recovery_failed`，此时禁止采纳/发布写入。
- delta 只装一条规则，因此仍受 256KiB 单次预算约束；不存在"把整份清单塞进 pending"的路径。

## 6. 迁移契约（显式，永不自动）

`rules migrate --dry-run` 输出 `session-correction-analysis/rules-migration/v1` 计划，每条一个处置：`import` / `skip_unapproved` / `skip_approval_stale` / `skip_already_migrated` / `needs_review_missing_scope` / `needs_review_missing_time` / `needs_review_source_missing`。

- 只导入"当前批准仍与当前内容版本一致"的候选；`import` 行必须携带确定的 `rule_id`、要写入的 `proposed_scope` 和**真实**批准时间——迁移永不伪造时间，也绝不把自由文本 scope 提升为用户显式范围（对应 `rule_scope_unknown`）。
- `needs_review_*` 行按 schema 规定**不得**携带 `rule_id`/`proposed_scope`，即单列待用户确认，不隐式批准。
- apply 必须显式 `backup_dir`，按 `RULES_MIGRATE_BATCH_MAX`=50 分批；保留旧候选 id、证据 id 与旧发布回执，只在候选上追加 `rule_ref`。第二次跑同一迁移得到零新增（`skip_already_migrated`）。
- 计划 schema 未知（`refuse_apply`）时拒绝 apply；没有迁移授权不写旧记录。

## 7. 错误码（每条都有可执行下一步）

| code | retryable | 下一步（`ERROR_CODES[*].nextStep`） |
|---|---|---|
| `rules_registry_missing` | 否 | 报告清单未初始化并运行 `sca rules migrate --dry-run`；缺文件从不等于零规则 |
| `migration_required` | 否 | 把 dry-run 报告给用户；应用迁移是显式且带备份的，从不自动 |
| `rule_not_found` | 否 | 先 `rules list`；只有已存在的规则能更新、撤销或重投递 |
| `rule_scope_unknown` | 否 | 让用户明确说 scope；不从路径改名、worktree 或自由文本猜 |
| `rule_version_mismatch` | 否 | 留作历史观察，重取快照前不下当前规则结论 |
| `rule_acceptance_recovery_failed` | 否 | 显示维护状态并拒绝采纳/发布写入；保留冲突，不覆盖用户编辑 |
| `registry_changed` | 是 | 停止自动回放、重新加载，让用户处理外部编辑后重试 |
| `request_conflict` | 否 | 拒写并换新 request_id；原回执不动 |

错误载荷沿用既有约定：走 stdout，消息里**从不**嵌入 transcript 原文。

## 8. CLI 参数表（冻结契约，LC-05 接线）

全局：`--data-root <path>`（或 `SCA_DATA_ROOT`）、`--json`；成功退出 0，业务错误 1，usage/解析错误 3，目录/权限不可用 2（沿用 `src/cli.ts` 既有码表）。所有变更入口都要求 `--request <request_id>` 与 `--expected-revision <n>`；针对单条规则的操作还必须带 `--expected-version` 与 `--expected-content-hash`，服务端按"先幂等、后 revision"判定。

| 命令 | 必需参数 | 可选 | 输出 / 失败 |
|---|---|---|---|
| `sca rules list` | — | `--workspace <path>`（按 scope 过滤）、`--all`（含 revoked/superseded） | 活动规则条数、rule_id/version/scope/title/delivery 摘要；`rules_registry_missing` 时明确报"未初始化"而不是空列表 |
| `sca rules show` | `<rule_id>` | — | 正文、版本历史、来源候选、两侧 delivery；`rule_not_found` |
| `sca rules update` | `<rule_id>`、`--request`、`--expected-revision`、`--expected-version`、`--expected-content-hash`、`--confirm` | `--title`、`--content <file|->`、`--scope <project\|user>`、`--note` | 新版本的 `content_hash` 与重置后的 delivery；无 `--confirm` 或无变更内容即拒收（未确认草稿不覆盖生效规则）；`rule_version_mismatch`、`registry_changed` |
| `sca rules revoke` | `<rule_id>`、`--request`、`--expected-revision`、`--expected-version`、`--expected-content-hash`、`--confirm` | `--reason` | 状态 `revoked` + 历史条目；**从不**回滚外部文件，也不接受任何 `rollback_target` 参数 |
| `sca rules migrate` | `--dry-run` 或 `--apply`、`--expected-revision` | `--record-id`（可重复）、`--batch-size`、`--backup-dir`（apply 必需） | dry-run 计划（第 6 节处置枚举）；apply 逐批结果 + 备份路径；缺 `--backup-dir` 或超出 `RULES_MIGRATE_BATCH_MAX` 即 usage 错误 |
| `sca rules review-prepare` | `<record_id>`、`--analysis <analysis_id>` | `--out <file>` | 冻结快照 + `input_digest`（scope 过滤后的活动规则正文/版本/hash/时间/delivery + 已提交 episode；按第 4 节字节装箱）；`RULE_REVIEW_SNAPSHOT_MAX_RULES`/`..._BYTES`；清单损坏时 `coverage: unavailable` |
| `sca rules review-ingest` | `<record_id>`、`--analysis <analysis_id>`、`--file <submission.json\|->`、`--request`、`--expected-revision` | — | 写入 `analyze.md` 的 `rule_review`：`used_rules`、观察、coverage；提交必须回显同一 `snapshot_digest`，`(rule_id, version, episode_id)` 幂等去重；陈旧 rule_id/version 归 `historical_relation`，不产出"遵守率""学习成功"之类的指标 |

已采纳候选的旧入口（`review decide --action approve`、`publish preview/commit --candidate`）在 LC-03 后**只转发**到 `src/review/rules.ts` 的同一服务，或明确拒绝并指向 `rule_ref`；不存在第二条状态写入路径，也不在候选里另存一份当前规则正文。

## 9. 与代码的联动

- `tests/unit/domain/rules.test.ts` 末节把本文件的 schema id、错误码、`sca rules <子命令>`、`accepted_rules.md`、`rules-registry` 和上表数值对回代码；数值改动必须同步本文件与实测。
- `src/domain/rules.ts` 的 schema 与第 5、6 节一一对应；`src/store/paths.ts` 对应第 2 节；`packaging/measure-rules-budget.mjs` 对应第 4 节。
- 迁移与写入实现落地时（LC-02/03）若与本文件冲突，以更新后的本文件为准并留评审记录——契约先改、代码后改，禁止用代码现状反向"解释"契约。
