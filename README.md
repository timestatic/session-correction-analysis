# session-correction-analysis

把你在 Claude Code / Codex 会话中对 Agent 的纠正，转化为**有证据、经人工批准、可修订和可撤销**的长期工程规则。

`session-correction-analysis`（简称 `sca`）不是普通的会话总结器，也不是通用记忆插件。它面向一类更窄、但影响更高的信息：**用户纠正 Agent 后形成的工程规范和程序性记忆**。

项目的 harness 文档体系——`AGENTS.md` / `CLAUDE.md` 入口、invariants / architecture / infrastructure 等规范、linters，以及项目级或用户级 Agent 记忆——共同构成 AI 编码助手的行为底座。但这套体系会随时间腐化：会话中的纠错没有及时回流，旧规则长期无人复审，文档、约束和实际行为逐渐失去一致性。`sca` 的目标，是为这套体系补上一条有证据、经审核、可撤销的规则供应链。

模型负责理解语义，CLI 负责冻结输入、验证证据和维护权威状态。候选规则不会自动写入 harness 文档体系或 Agent 记忆，也不会自动获得批准；用户可以在审核后决定将规则回流到入口文件、专项规范、lint 约束或记忆系统中的合适位置。

## 目录

- [为什么需要它](#为什么需要它)
- [适合与不适合的场景](#适合与不适合的场景)
- [与会话总结、记忆插件的区别](#与会话总结记忆插件的区别)
- [60 秒快速开始](#60-秒快速开始)
- [示例：从一次纠错到长期规则](#示例从一次纠错到长期规则)
- [工作原理](#工作原理)
- [核心保证](#核心保证)
- [隐私与网络边界](#隐私与网络边界)
- [能力边界](#能力边界)
- [手动 CLI 工作流](#手动-cli-工作流)
- [数据目录](#数据目录)
- [常用命令](#常用命令)
- [自动化与定时分析](#自动化与定时分析)
- [License](#license)

## 为什么需要它

AI 编程会话中经常发生这样的过程：

1. Agent 误解需求、执行了不合适的操作，或者写出了需要返工的代码；
2. 用户在会话中指出问题；
3. Agent 当场调整；
4. 会话结束后，这次纠错散落在 transcript 中；
5. 后续 Agent 再次犯下同样的错误。

直接让模型总结当前会话适合一次性复盘，但当规则要长期影响项目或团队时，还需要回答更多问题：

- 分析的是哪一次会话、哪一段固定输入？
- 每条用户消息是否都被检查过？
- 候选引用的内容是否真实存在于 transcript？
- 所谓“已经返工”是否有实际编辑和成功结果佐证？
- 哪些内容只是模型建议，哪些内容已经由用户批准？
- 候选修改后，旧批准是否仍然有效？
- 已采纳规则以后如何修订或撤销？

`sca` 把这些问题组织成一条可治理的工程链路：

```text
会话 transcript
  → 冻结输入并生成证据包
  → 宿主 Agent 分析纠错、介入和返工
  → CLI 校验分析结果
  → 用户审核规则候选
  → 回流到 harness 文档体系 / Agent 记忆，或登记到规则账本
  → 后续修订或撤销
```

## 适合与不适合的场景

| 场景 | 建议 |
|---|---|
| 当前会话很短，只想即时复盘 | 直接让模型分析通常更简单 |
| 结果不会进入长期规范，分析错误代价较低 | 不一定需要 `sca` |
| 分析历史会话 | 适合使用 `sca` |
| 长会话可能经过上下文压缩或裁剪 | 适合使用 `sca` |
| 需要批量或定时分析多个会话 | 适合使用 `sca` |
| 规则将进入 harness 文档体系、lint 约束或共享记忆 | 适合使用 `sca` |
| 需要来源证据、人工审批、版本和撤销记录 | 适合使用 `sca` |
| 希望自动批准并直接修改 harness 文档体系 | 不适合；`sca` 明确保留人工审核边界 |
| 希望保存任务进度、项目事实或完整用户画像 | 不适合；`sca` 不是通用记忆系统 |

## 与会话总结、记忆插件的区别

三者都可能读取会话并提取信息，但解决的问题不同：

| 方案 | 主要目标 | 典型产物 | 治理重点 |
|---|---|---|---|
| 直接让模型总结会话 | 描述这次发生了什么 | 会话摘要、行动项、临时建议 | 快速、低成本 |
| 记忆插件 | 让项目事实、用户偏好和历史信息以后可以被召回 | 工作记忆、情景记忆、语义记忆、用户画像 | 捕获、存储和检索 |
| `sca` | 把用户纠错转化为可信的长期工程规则 | 带证据的候选、审核记录、已采纳规则 | 来源、批准、版本和撤销 |

记忆插件通常处理更广泛的信息，例如：

- 当前任务状态和未完成事项；
- 项目事实、技术决策和历史背景；
- 用户偏好与跨会话习惯；
- 值得在后续请求中召回的摘要。

`sca` 只关注其中较窄但影响较高的一类：**从用户纠错中产生的程序性记忆或工程规则**。这些规则可能影响后续所有 Agent，因此不能只依赖“模型认为值得记住”，还需要：

- 保留真实来源证据；
- 区分 transcript 中的事实与模型推断；
- 明确规则的目标和适用范围；
- 将批准绑定到具体内容版本；
- 由用户显式批准；
- 支持后续修订和撤销。

两者不是替代关系。记忆插件可以负责广泛的信息捕获与召回，`sca` 则可以作为高影响规则进入长期记忆之前的审核门禁：

```text
普通项目事实、进度和偏好
  → 由记忆插件捕获和召回

用户纠错产生的高影响规则
  → SCA 提取证据并生成候选
  → 用户审核批准
  → 回流到 harness 入口、专项规范、lint 约束或 Agent 记忆
```

与常见记忆系统概念的对应关系如下：

| `sca` 概念 | 记忆系统中的近似概念 |
|---|---|
| Transcript | 原始会话日志 |
| Event / Evidence | 带来源的记忆证据 |
| Episode | 结构化情景记忆 |
| Candidate | 长期记忆候选 |
| Approve | 人工确认记忆 |
| Adopt | 登记到长期规则账本 |
| Revoke | 让已有规则失效 |
| Rule | 程序性记忆 |

## 60 秒快速开始

环境要求：Node.js `>=22`。项目已验证 Node.js 22、24、26，开发基线见 `.nvmrc`。

### 安装 Skill

推荐把仓库中的薄 Skill 安装到 Claude Code 或 Codex：

```bash
npx skills add timestatic/session-correction-analysis
```

也可以手动复制 `skills/session-correction-analysis/`：

- Claude Code 全局：`~/.claude/skills/`
- Codex 项目级：`.agents/skills/`
- Codex 用户级：`~/.codex/skills/`

Skill 是纯指令文件，不包含 CLI 打包代码。运行时通过 `npx -y session-correction-analysis` 获取 CLI；首次运行通常需要访问 npm registry，之后可使用本地缓存。

如果只想使用 CLI，也可以全局安装：

```bash
npm install -g session-correction-analysis
```

### 发起分析

安装 Skill 后，在 Claude Code / Codex 中说：

```text
分析这个会话中的用户纠错，并生成规则候选。
```

也可以直接调用：

```text
/session-correction-analysis
```

Agent 会按照 Skill 执行：

```text
doctor
  → discover / register
  → prepare
  → 分析 packet
  → ingest
  → review
```

如果宿主没有直接暴露当前 session ID，Skill 会先尝试使用 marker 探针定位当前 transcript；定位失败时才需要用户提供 `/status` 中的会话信息。

### 审核候选

分析完成后列出候选：

```bash
sca review <record_id>
```

查看某条候选及其证据摘要：

```bash
sca review <record_id> --candidate <candidate_id>
```

显式查看完整来源证据：

```bash
sca review <record_id> --candidate <candidate_id> --full
```

批准候选：

```bash
sca review <record_id> --action approve \
  --candidate <candidate_id> \
  --request <uuid> \
  --expected-revision <revision>
```

候选还支持 `reject`、`edit_content`、`revoke` 和 `supersede`。批准绑定当前内容版本；正文、目标或适用范围被修改后，旧批准自动失效，必须重新审核。

### 导出或采纳

将已批准候选导出为 Markdown：

```bash
sca review <record_id> --action export_content \
  --candidate <candidate_id> \
  --out ./rule.md
```

也可以使用 `copy_content` 输出适合复制的内容。导出后，由用户决定规则在 harness 文档体系中的落点：可以写入 `AGENTS.md` / `CLAUDE.md` 入口，归入 invariants / architecture / infrastructure 等专项规范，转化为 lint 约束，或进入项目级、用户级 Agent 记忆。

如果要把批准版本登记到长期规则账本：

```bash
sca adopt <record_id> --candidate <candidate_id> \
  --request <uuid> \
  --expected-revision <revision>
```

请注意：

- `approve`：批准当前候选内容；
- `export_content` / `copy_content`：输出已批准内容；
- `adopt`：把已批准版本登记到 `accepted_rules.md`；
- `adopt` 只登记规则账本，不会自动修改 harness 入口、专项规范、lint 约束或 Agent 记忆，也不代表规则已经完成回流。

## 示例：从一次纠错到长期规则

假设会话中出现了下面的过程：

```text
Agent：修改完成后，我会直接执行 npm publish。
用户：不要执行发布。npm publish 是不可逆的外部操作，必须先得到我的明确确认。
Agent：明白。我只完成本地修改和验证，不执行发布。
```

`sca` 会把用户消息、此前的 Agent 行为和后续响应组织成带来源的分析证据。宿主 Agent 可以据此提出候选：

```text
标题：执行 npm publish 前必须获得用户明确确认
类别：操作安全规则
状态：proposed
来源：用户纠错消息及前后行为证据
```

用户审核后，批准并导出的规则可能是：

```markdown
# 发布前必须获得用户明确确认

执行 `npm publish` 等不可逆外部操作前，必须获得用户明确确认。
在未获得确认时，只能完成本地修改、检查和发布前验证，不得执行实际发布。
```

如果该规则需要进入跨会话账本，再显式执行 `sca adopt`。完整路径是：

```text
真实纠错 → 来源证据 → 规则候选 → 人工批准 → 导出或采纳 → 后续修订/撤销
```

## 工作原理

`sca` 在 CLI 和宿主 Agent 之间划分职责。

### 宿主 Agent：负责语义判断

Claude Code、Codex 等宿主 Agent 负责判断：

- 用户是否在纠正 Agent；
- 用户是否叫停、拒绝授权或接管执行；
- 前后的编辑是否构成撤销、替换或修复；
- 某次纠错是否值得形成长期规则；
- 规则正文、触发条件和适用范围应该如何表达。

### CLI：负责事实与权威状态

CLI 本身不发起模型请求，负责：

- 定位并验证 Codex / Claude Code transcript；
- 冻结本次分析的输入范围；
- 将不同宿主格式规范化为统一事件和 Evidence；
- 建立用户消息覆盖清单；
- 提取文件编辑信号和潜在返工提示；
- 校验 submission schema、引文、时序和返工证据；
- 管理租约、generation、锁、revision 和事务恢复；
- 管理候选审核状态和已采纳规则账本。

端到端流程如下：

```text
sca register
  → 建立稳定会话记录

sca prepare
  → 冻结 transcript 输入范围并生成 analysis packet

宿主 Agent 分析 packet
  → 产出结构化 submission JSON

sca ingest
  → 校验用户消息覆盖、引文、时序、编辑结果和运行身份

sca review
  → 人工 approve / reject / edit_content / revoke / supersede

copy_content / export_content
  → 输出已批准规则，由用户决定写入位置

sca adopt / sca rules
  → 登记、查询、修订或撤销长期规则
```

更完整的实现分析，包括输入冻结、Evidence、返工提示、租约、两文件提交和审核状态机，参见 [`TOOL_DESIGN_ANALYSIS.md`](TOOL_DESIGN_ANALYSIS.md)。

## 核心保证

- **固定输入**：`prepare` 绑定 transcript 的明确字节前缀；仅在尾部追加不会改变本轮已经冻结的输入。
- **用户消息全覆盖**：submission 必须逐项回执所有 `UserCoverage`，区分“没有发现纠错”和“根本没有检查”。
- **引文可验证**：候选引用的 Evidence ID 必须存在，引文必须逐字命中可引用正文。
- **时序可验证**：纠错前行为必须发生在用户锚点之前，纠错后行为必须发生在之后。
- **返工有事实下限**：声称已完成代码返工时，必须存在纠错前后的成功编辑及相交文件路径。
- **模型不能自我批准**：模型只提交语义分析结果，不能提交 `approved`、`published` 等权威状态。
- **批准绑定内容版本**：候选内容变化后，旧批准自动失效。
- **并发写入受控**：租约、generation fencing token、revision、文件锁和幂等请求用于防止陈旧结果覆盖新状态。
- **规则可逆**：候选可以拒绝或撤销，已采纳规则可以修订或撤销，并保留来源和历史。
- **失败不污染既有记录**：ingest 校验失败时拒绝提交，不用不完整结果覆盖已保存状态。

## 隐私与网络边界

- `sca` CLI 只负责本地读写与校验，不发起模型请求，也不主动上传 transcript；analysis packet 是否发送给远程模型，取决于 Claude Code、Codex 等宿主的配置。
- 首次通过 `npx` 获取 CLI 或安装依赖时可能访问 npm registry。SCA 不会自动写入 harness 入口、专项规范、lint 配置、Agent 记忆或其他外部系统。
- 本地数据包含会话证据和候选内容，请妥善保护 `SCA_DATA_ROOT`，避免误提交到代码仓库。

## 能力边界

- CLI 能验证引文、时序和编辑事实，但语义判断质量仍取决于宿主模型。
- 返工分析基于 transcript 中的编辑、路径和文本指纹，只提供事实下限，不是 AST 级语义证明。
- SCA 不自动批准或发布规则，也暂不提供跨会话去重、冲突检测、规则老化复审和效果评估。
- SCA 不是通用记忆系统；Markdown 存储便于审计，但不适合大规模聚合查询，不同 `data-root` 也不会自动合并。

## 手动 CLI 工作流

下面的命令与 Skill 在后台执行的是同一条链路，适合脚本化或调试：

```bash
# 0. 环境自检
sca doctor

# 1. 定位当前会话（不知道 session ID 或 transcript 路径时）
sca discover --host codex \
  --marker sca-probe-<uuidv4> \
  --workspace <workspace_path>

# 2. 登记源会话
sca register --host codex \
  --session <session_id> \
  --workspace <workspace_path> \
  --transcript <transcript.jsonl>

# 3. 冻结输入并生成 packet
sca prepare <record_id>

# 4. 宿主 Agent 按 Skill 分析 packet，产出 submission.json

# 5. 校验并提交分析结果
sca ingest <record_id> \
  --run <run_id> \
  --submission submission.json

# 6. 查看和审核候选
sca review <record_id>
sca review <record_id> --candidate <candidate_id>

# 7. 导出已批准内容
sca review <record_id> --action export_content \
  --candidate <candidate_id> \
  --out ./rule.md

# 8. 可选：登记到长期规则账本
sca adopt <record_id> --candidate <candidate_id> \
  --request <uuid> \
  --expected-revision <revision>
```

`--request` 应使用全局唯一编号，建议使用 UUID。同一次操作重试必须沿用相同编号和参数；新的操作应使用新的编号。并发更新还必须提供命令当前返回的 `--expected-revision`。

如果不知道某条命令的完整参数，直接运行：

```bash
sca
```

## 数据目录

默认数据目录为 `~/.session-correction-analysis/`。可以通过 `--data-root <path>` 或环境变量 `SCA_DATA_ROOT` 覆盖。

```text
~/.session-correction-analysis/
├── accepted_rules.md
├── records/
│   └── <record_id>/
│       ├── analyze.md
│       └── learning_candidates.md
└── runtime/
    ├── packets/
    └── locks/
```

- `accepted_rules.md`：跨会话规则账本，记录采纳、修订和撤销历史。
- `analyze.md`：源会话身份、分析状态、租约、episode 和事实摘要。
- `learning_candidates.md`：候选正文、来源、审核历史和 revision。
- `runtime/packets/`：`prepare` 生成的冻结分析包，可重建，不属于长期业务事实。
- `runtime/locks/`：会话记录和规则注册表使用的协作式文件锁。

`record_id` 由宿主、规范化 workspace 和源 session ID 共同派生。同一会话改标题、跨月续聊或重新分析，仍会落到同一稳定记录目录。

Markdown 文件可以直接阅读，但应只通过 CLI 修改。可以使用下面的命令进行只读一致性检查：

```bash
sca validate <record_id>
sca validate --all
```

## 常用命令

| 命令 | 用途 |
|---|---|
| `sca doctor` | 检查 Node.js、PATH 和数据目录可写性 |
| `sca discover` | 使用 marker 探针定位当前会话 transcript |
| `sca register` | 校验并登记一个源会话 |
| `sca prepare` | 冻结输入、领取租约并生成 analysis packet |
| `sca ingest` | 校验并提交 Agent 的结构化分析结果 |
| `sca review` | 列出候选、查看证据并执行人工审核操作 |
| `sca review ... --action copy_content` | 输出已批准候选的可复制 Markdown |
| `sca review ... --action export_content` | 将已批准候选导出到指定文件 |
| `sca adopt` | 把已批准候选登记到 `accepted_rules.md` |
| `sca rules` | 查询规则列表、详情或执行撤销 |
| `sca validate` | 只读检查记录和事务状态的一致性 |

常见审核操作：

| 操作 | 含义 |
|---|---|
| `approve` | 批准候选当前内容版本 |
| `reject` | 拒绝候选 |
| `edit_content` | 人工修改候选正文或相关内容 |
| `revoke` | 撤销已有批准 |
| `supersede` | 使用新候选替代旧候选 |
| `copy_content` | 输出已批准内容以便复制 |
| `export_content` | 将已批准内容写入指定 Markdown 文件 |

CLI 退出码：

| 退出码 | 含义 |
|---|---|
| `0` | 成功 |
| `1` | doctor 或 validate 发现诊断/一致性问题 |
| `2` | 命令抛出已分类错误，JSON 写入 stdout |
| `3` | 用法或参数解析错误 |

## 自动化与定时分析

`sca` 不自带调度器，也不会由纯 cron 独立完成语义分析。自动化任务必须运行在能够调用模型的宿主 Agent 中，并复用同一个 Skill、CLI 和 submission schema。

推荐的批处理策略是：

```text
扫描 records/*/analyze.md
  → 选择 analysis_status=pending 的记录
  → 每条独立执行 prepare
  → 宿主 Agent 分析 packet
  → 执行 ingest
  → 输出待人工审核的候选列表
```

自动化任务应遵守以下边界：

- 限制单次处理数量和 transcript 发现时间窗；
- 跳过仍在写入、持有有效租约或存在未完成提交的记录；
- 单条失败后记录原因并继续下一条，不覆盖既有状态；
- 不自动执行 `approve`、`reject`、`edit_content`、`revoke` 或 `supersede`；
- 不自动修改 harness 入口、专项规范、lint 约束或任何 Agent 记忆；
- 只在产生新记录或新候选时通知用户审核。

也就是说，定时任务可以自动完成“发现、准备、分析和提交”，但候选批准、规则导出和长期采纳仍由用户决定。

可以在 Codex Automations、Claude Code 定时任务或其他具备模型能力的宿主中使用下面的提示词，并按实际数据目录、时间窗口和单批数量调整：

```text
使用 session-correction-analysis Skill 执行一次定时会话纠错分析。本轮只负责发现、登记、
分析和提交候选，绝不替用户审核或发布规则。

1. 执行 sca doctor。若 Node.js、PATH 或数据目录检查失败，立即停止，只报告失败原因；
   不要自行安装、升级或修改环境。

2. 扫描 ~/.session-correction-analysis/records/*/analyze.md 的 frontmatter：
   - 选择 analysis_status=pending 的记录，按 created_at 升序最多取 3 条；
   - 跳过 running、completed，以及 pending_commit 非空的记录；
   - 不清理锁、不抢占有效租约，也不修改异常记录，必要时提示用户执行 sca validate。

3. 如需补充未登记会话，只在明确的最近时间窗口内枚举当前宿主的 transcript：
   - 跳过仍可能写入的文件；
   - 只读取定位会话所需的元数据，获取 session_id、workspace 和 transcript 路径；
   - 与现有 records 中的 session_id 去重；
   - 最多补登记 3 条，不全量扫描历史，也不按会话标题或“最近使用”猜测。

4. 对每条记录依次执行：
   sca prepare <record_id>
   → 完整读取生成的 packet，包括 user_coverage 和 evidence
   → 严格按 Skill schema 生成 submission JSON
   → sca ingest <record_id> --run <run_id> --submission <submission_path>

5. ingest 拒收时，根据错误信息修正 submission 一次；若仍失败，保留原状态并继续下一条，
   不绕过 schema、Evidence、coverage、租约或 input hash 校验。

6. 对成功完成的记录执行 sca review <record_id>，汇总 record_id、候选标题、候选数量、
   revision，以及复核命令 sca review <record_id> --candidate <candidate_id>。
   没有新增记录或候选时，只回复“无新增”。不要在报告中粘贴 transcript 原文。

7. 严禁执行 approve、reject、edit_content、revoke、supersede、copy_content、
   export_content、adopt 或 rules --revoke；严禁修改 AGENTS.md / CLAUDE.md 入口、
   invariants / architecture / infrastructure 等专项规范、lint 约束、Agent 记忆、Skill 文件
   或本提示词。所有候选必须留给用户人工审核。
```

纯系统 cron 本身没有语义分析能力；如使用 crontab、launchd 等调度器，应由它调用 `claude -p`、`codex exec` 或其他宿主 Agent，并把上述提示词作为任务输入。

## License

[MIT](LICENSE)
