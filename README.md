# session-correction-analysis (sca)

AI 编码助手会在同一个坑里反复跌倒——你纠正过它，下次它照犯。sca 把这些口头纠错变成**带证据、经你人工批准**的规则候选，让它们沉淀回项目的 harness 文档（AGENTS.md / CLAUDE.md 等）或 Agent 长期记忆，形成"纠错一次、处处生效"的闭环：CLI 在本机读取、校验和保存数据，不自行发起模型网络请求；语义分析由宿主 Agent 执行，是否联网取决于宿主配置。**没有任何文本会在你批准前离开或生效**——批准之后才复制或导出为 Markdown，由你决定放进 harness 文档还是记忆。

## 效果示例

在 Claude Code / Codex 里说「分析这个会话的纠错」，Agent 会按技能引导跑完登记 → 冻结分析 → 提交，然后你逐个审核候选（`sca review <record_id>` 列出候选与可执行操作，`sca review <record_id> --candidate learning-001` 查看某条候选的证据详情）。

approve 一条候选后 `copy_content` 导出，得到的 Markdown：

```markdown
# 接口校验统一用 zod schema，不手写散落的 if 校验

## 规则正文

新增或修改请求/响应校验时，统一用 zod schema 定义并复用 `src/domain/` 下的
校验模式；错误经 ScaError 分类后以 JSON 输出。

## 适用范围

src/domain、src/analysis 的入参校验

## 触发条件

需要为 CLI 命令或 submission 增加字段校验时

## 来源摘要

类别 code_convention · 证据 3 条 · 来源 episode 2 个（明细见 learning_candidates.md）
```

每条候选都锚定会话里的具体纠错证据，可追溯、可撤销（revoke / supersede），不是模型的一面之词。批准后把这段 Markdown 放进对应章节的 AGENTS.md 或 Agent 记忆——下次会话中同类问题，AI 就不需要你再纠正第三遍。

## 工作原理

一次分析在 CLI（确定性的记账与校验）和宿主 Agent（语义判断）之间分工。手动调用 Skill、命令行、定时任务走的都是同一条链路、同一套 Markdown schema：

```text
触发：人在会话里调用 Skill  /  你在宿主里自建的定时任务
        │
        ▼
sca register  ────►  records/<record_id>/{analyze.md, learning_candidates.md}   analysis_status: pending
        │
sca prepare   ────►  runtime/packets/<...>   冻结输入范围与摘要、领取运行租约
        │
   宿主 Agent 读 packet 产出 submission JSON   ← 全链路唯一可能联网的一步
        │
sca ingest    ────►  校验引文逐字命中、用户消息全覆盖、返工有成功回执，通过后提交   analysis_status: completed
        │
sca review    ────►  人工 approve / reject / edit_content / revoke / supersede
        │
copy_content / export_content ─►  由你把文本放进 harness 文档（AGENTS.md / CLAUDE.md）或 Agent 记忆
        │
sca adopt / sca rules ────────►  <data-root>/accepted_rules.md   跨会话采纳落账清单（记账，非发布）
```

贯穿全链路的约束：

- **Markdown 是唯一事实源**：没有数据库；`analyze.md` 与 `learning_candidates.md` 本身就是状态，跨会话采纳清单 `accepted_rules.md` 同样是带 frontmatter 的 Markdown 单一文件（独立 schema、注册表锁下单文件事务）。锁、租约、两文件提交只服务于记录文件的一致性。
- **CLI 从不发起模型请求**：register / prepare / ingest / review 全是本地读写与校验，模型只出现在"Agent 分析 packet"那一步，是否联网取决于宿主配置。
- **校验发生在提交时**：prepare 冻结字节前缀并把摘要绑定到记录，ingest 同时核对重算值与绑定值；引文必须逐字命中证据、每条用户消息必须有处理回执、返工结论必须有编辑成功回执佐证，任一不满足即拒收且不改写既有记录。
- **判断逻辑只有一份**：定时任务、Hook 都只是"另一种触发方式"，必须调用同一个 Skill 和同一套 schema，不得各自实现一套纠错判断。

## 特性

- **本地优先、零副作用**：数据只存在你选定的本地目录，CLI 不发起模型网络请求，无自动发布、无外部 sink——导出是唯一出口，且必须先经你批准
- **面向 harness 与记忆两条沉淀路径**：每条候选标注归属目标（`harness`：AGENTS.md / CLAUDE.md 等项目规范文档，可精确到文件与章节；`memory`：项目级或用户级 Agent 记忆），分析产出即知道该去往何处
- **双主机适配**：读取并规范化 Codex / Claude Code 的会话 transcript（JSONL）
- **返工佐证边界**：Codex 的直接 `apply_patch` 与可解析的顺序 `exec` 包装 `tools.apply_patch(...)` 可形成编辑信号；无法解析的混合或并发工具调用、缺失成功结果或文件路径时，返工维度报告 `unknown`，不据此宣称“没有返工”
- **可复现的分析管线**：`prepare` 冻结输入范围并生成 analysis packet（含证据、覆盖率、租约），分析结果通过 `ingest` 按 schema 校验后提交
- **人工评审**：对候选执行 `approve / reject / revoke / edit_content / supersede`，基于 `--request + --expected-revision` 幂等，防止并发覆盖
- **纯本地 Markdown 存储**：所有记录为带 frontmatter 的 Markdown 文件，可直接阅读；`validate` 提供只读一致性检查
- **内容导出**：仅已批准候选可 `copy_content / export_content`，无自动写入外部 sink
- **采纳落账清单**：`sca adopt` 把批准版本登记进根级 `accepted_rules.md`（派生 rule_id、请求账本幂等、改稿重批原地修订版本+1），`sca rules` 列表/详情/撤销；仅记账，仍无自动发布

## 环境要求

- Node.js `>=22`（不设上界；22 / 24 / 26 三条版本线均已通过全部测试。开发基线钉在 `.nvmrc` 的 24.19.0）

## 安装

全局安装（提供 `sca` 命令）：

```bash
npm install -g session-correction-analysis
```

无需安装也可直接运行：`npx -y session-correction-analysis`。

从源码安装：

```bash
git clone https://github.com/timestatic/session-correction-analysis
cd session-correction-analysis
npm install
npm run build
```

构建产物在 `dist/`，CLI 入口为 `dist/src/cli.js`（bin 名 `sca`）。可 `npm link` 后将 `sca` 作为全局命令使用，或直接 `node dist/src/cli.js`。

## 快速开始

```bash
# 0. 默认数据目录为 ~/.session-correction-analysis，一般无需配置
#    如需隔离测试可另行指定：
# export SCA_DATA_ROOT="$HOME/.session-correction-analysis"

# 1. 环境自检（Node 版本、PATH、数据目录可写性）
sca doctor

# 2. 为一个会话登记记录（校验 transcript 与 host/session/workspace 的一致性）
#    会话内不知道自己的 session ID / transcript 路径时，先用 marker 探针定位：
#      先执行 `uuidgen | tr 'A-Z' 'a-z'` 取值，替换下面的 <uuidv4>
sca discover --host codex --marker sca-probe-<uuidv4> --workspace <项目路径>
#    只在有界范围内匹配命令文本（codex 按最近 24h 写入时间剪枝，恢复的旧会话也能定位）；
#    零命中/多命中即失败，
#    降级方案：在宿主（Claude Code / Codex）输入 /status，粘贴 session ID 与 transcript 路径
sca register --host codex \
  --session <session_id> \
  --workspace <项目路径> \
  --transcript <transcript.jsonl 路径>

# 3. 冻结输入、领取运行租约，生成分析 packet
sca prepare <record_id>
#    → 输出 packet_path / run_id；由 AI 主机按技能包分析 packet 产出 submission JSON

# 4. 校验并提交分析结果
sca ingest <record_id> --run <run_id> --submission submission.json

# 5. 人工评审
sca review <record_id>                                  # 列出候选与允许的操作
sca review <record_id> --candidate <id>                 # 查看候选判断、限长引文与证据 ID（默认不输出完整原文）
sca review <record_id> --candidate <id> --full          # 显式查看完整来源证据原文
sca review <record_id> --action approve \
  --candidate <id> --request <uuid> --expected-revision <n>
sca review <record_id> --action export_content \
  --candidate <id> --out ./note.md                      # 导出已批准文本

# 6. 采纳落账（可选）：把批准版本登记进根级 accepted_rules.md，跨会话可查
sca adopt <record_id> --candidate <id> \
  --request <uuid> --expected-revision <n>              # 幂等；同版本重复采纳只记回执，不修改规则
sca rules                                               # 列表（--workspace 过滤、--all 含撤销、--rule 看全文）
sca rules --revoke <rule_id> --request <uuid> --expected-revision <registry revision>
```

采纳和撤销的每次新操作都使用全局唯一的 `--request`（建议 UUID），在首次调用前生成并保留；同一次操作重试必须沿用原编号和全部参数。撤销后主动重新采纳属于新操作，应使用新编号。时间戳可作编号前缀，但不用于比较或覆盖操作；并发仍由锁和 `--expected-revision` 检查控制。同编号对应不同记录、操作或参数时返回 `receipt.result: rejected`，不修改规则。

同版本重复采纳也保存回执：规则内容、版本和历史不变，注册表修订号增加；同编号重试只回放原回执，不增加修订号，也不会恢复随后撤销的规则。根级采纳/撤销账本保留全部回执，不按数量截断；候选审核账本保持原有策略。旧回执通过规则历史校验来源，无需迁移；旧版未保存的重复采纳请求无法补回。

各命令的完整参数见 `sca`（无参数时输出 USAGE）。

## 作为 Agent Skill 使用（Claude Code / Codex）

技能是纯指令文件（薄 Skill），不自带任何打包代码；CLI 通过 `npx -y session-correction-analysis` 按需获取（首次需能访问 npm registry，之后走缓存），要求 Node.js 22+。

**安装技能**（二选一）：

```bash
# 方式一：skills.sh 一键安装
npx skills add timestatic/session-correction-analysis

# 方式二：手动复制本仓库 skills/session-correction-analysis/ 到
#   ~/.claude/skills/（Claude Code 全局）或项目 .agents/skills/、~/.codex/skills/（Codex）
```

**使用**：安装后在 Claude Code / Codex 中说「分析这个会话的纠错」或调用 `/session-correction-analysis`，Agent 会按技能引导通过 npx 依次执行 `doctor →（discover 定位当前会话）→ register → prepare →（分析 packet 产出 submission）→ ingest → review`；宿主未暴露 session ID 时 Agent 会自动用 marker 探针定位，失败才请你输入 `/status` 粘贴。你只需在 review 阶段对每个候选做 approve / reject / 编辑后批准，已批准文本可复制或导出为 Markdown，明确要求时再 `sca adopt` 落账到跨会话采纳清单（见快速开始第 6 步）。分析记录全部保存在本地数据目录（见下节）。

## 数据目录

默认根目录 `~/.session-correction-analysis/`，用 `--data-root <path>` 或环境变量 `SCA_DATA_ROOT` 覆盖：

```text
~/.session-correction-analysis/
├── accepted_rules.md                # 跨会话采纳落账清单（独立 schema 的 v1 注册表，业务数据）
├── records/
│   └── <record_id>/                 # 一个会话一个目录，平铺存放，不再分宿主 / 项目 / 月份层级
│       ├── analyze.md               # 会话元数据、analysis_status、租约、本轮事实（episode 与证据片段）
│       └── learning_candidates.md   # 候选正文、来源存档、审核历史与 revision
└── runtime/
    ├── packets/                     # prepare 生成的冻结分析包，可重建，不属于业务数据
    └── locks/                       # 协作式文件锁（rules-registry、session-<record_id> 等）
```

- **记录目录名是稳定 ID，不是标题**：`record_id = sha256([host, 规范化 workspace, 源会话 ID])` 的 64 位十六进制串。同一会话跨月续聊、改标题、重跑分析都落回同一目录，候选的审核记录不会断档；宿主、项目、日期只用于展示和筛选，不决定层级。
- **Markdown 可以直接读，但请只经 CLI 写**：`sca validate <record_id>` / `sca validate --all` 提供只读一致性检查（schema、身份、计数、未提交事务），不修改任何文件。
- 不同 data-root 之间不自动合并；删除某个记录目录即删除该会话的全部分析与候选，工具不提供历史列表或搜索界面。
- 根级 `accepted_rules.md` 现在是一期业务数据：能按 v1 注册表 schema 解析就直接共存，无法解析（旧版事务残留、外来 schema、损坏）则与 `rule_ref` / `rule_review`、非空发布状态一样触发拒绝，不迁移、不修改旧数据。此时建议换用全新的 data-root。

## 定时批量分析

sca 不自带调度器，也没有 `drain` 命令——语义分析必须由具备模型上下文的宿主 Agent 完成，纯 cron 直跑 CLI 只能记账。批量方式因此是：**你在宿主里自建定时任务，让它按固定 prompt 扫描自己的记录目录、复用同一套 Skill 与 CLI**。

待办队列来自记录本身（`records/*/analyze.md` 的 frontmatter）：

```text
扫描 records/*/analyze.md 的 analysis_status
  → pending（已登记未分析）按 created_at 升序取前 N 个（建议 ≤3）
  → 每条独立 prepare 领取租约 → 分析 packet → ingest
  → running / 留有 pending_commit 的记录跳过，交给 validate 人工判断，不抢租约
  → 某条失败即跳过并继续下一条，不中止整批
  → 只在新增候选或队列变化时通知；绝不自动批准、绝不自动写 harness 或记忆
```

由于没有 Hook 自动登记，"从未被 sca 见过的历史会话"不会自己出现在 `records/` 里。要覆盖它们，定时任务需先做一次**有界**发现：只枚举宿主会话目录的一个明确时间窗，从每个 transcript 的 `session_meta` 行取 session ID 与工作目录，再与 `records/*/analyze.md` 里已有的 `session_id` 比对，只补登记缺的那部分。注意 `sca discover` 是定位**当前**会话的 marker 探针（一次一条、必须有探针标记命中），不承担批量发现。不要在任务里全量扫描宿主历史、按"最近在用"猜会话、或读取无关正文。

### Codex 定时任务示例

Codex 的定时任务（App 内 Automations，或直接写 `~/.codex/automations/<id>/automation.toml`）大致长这样：

```toml
version = 1
id = "nightly-session-correction-drain"
kind = "cron"
name = "Nightly session correction drain"
prompt = """<下方提示词>"""
status = "ACTIVE"
rrule = "FREQ=DAILY;BYHOUR=22;BYMINUTE=30;BYSECOND=0"
model = "gpt-5.4-mini"          # 换成你 Codex 里做分析常用的模型；分析质量取决于它
reasoning_effort = "high"
execution_environment = "local"
cwds = ["/绝对路径/要被分析的项目"]
```

`cwds` / `target` 决定任务在哪个项目里跑，也决定 `.agents/skills/` 能否被发现。非交互 shell 的 PATH 常缺 `node`，先确认 `command -v sca`，取不到就在提示词里写绝对路径（如 `~/.nvm/versions/<node>/bin/sca`）；`sca doctor` 的 `node_on_path` 项就是干这个的。

提示词（按你的实际路径与窗口微调）：

```text
用 session-correction-analysis 技能做批量会话纠错分析。本轮只登记与分析，绝不批准任何候选。

1. 前置检查：执行 sca doctor（PATH 无 sca 时改用绝对路径）。node_version、node_on_path、
   data_root 任一为 fail 即停止并只报告原因，不要自行安装或升级任何工具。
2. 待办队列：读取 ~/.session-correction-analysis/records/*/analyze.md 的 frontmatter，取 analysis_status 为
   pending（登记了但尚未分析）的记录，按 created_at 升序取前 3 个。
   running 或 frontmatter 里 pending_commit 非 null 的记录本轮跳过，只记录 record_id——那说明租约被别的运行持有，
   或上次中断留下了未提交结果；不要试图续跑或清理，留给人工用 sca validate <record_id> 判断。
   completed 的记录也跳过，不要反复重跑同一会话。
3. 补充发现未登记的会话，范围严格限制在下面这几步：
   - 只枚举 ~/.codex/sessions/<最近 3 天的 YYYY/MM/DD 目录>/rollout-*.jsonl；
   - 跳过 mtime 距今不足 30 分钟的文件（会话可能仍在写入）；
   - 每个文件只读取其中的 session_meta 行（通常在首行），取 payload.id 作 session_id、payload.cwd 作 workspace；
     没有 cwd 就跳过该文件并在报告里说明，不要凭项目名猜 workspace；
   - 该 session_id 已出现在任一 records/*/analyze.md 中则跳过；
   - 剩余按文件修改时间升序最多补 3 个，逐个执行
     sca register --host codex --session <session_id> --workspace <cwd> --transcript <绝对路径> --trigger scheduled_drain
   - 除此之外不读 transcript 正文，不猜会话标题，不按"最近使用"挑选。
4. 逐条分析（本轮总处理量 ≤6）：sca prepare <record_id> → 完整阅读 packet（含 user_coverage
   与全部 evidence），按技能要求产出 submission JSON → sca ingest <record_id> --run <run_id> --submission <路径>。
   ingest 拒收时按返回的 code 修正一次再提交；仍失败就保留该记录原状态并继续下一条。
5. 收尾：对每条本轮完成的记录执行 sca review <record_id>，统计候选数与 revision。
6. 输出：仅当新增了记录或产生了新候选时才总结，列出 record_id、候选标题、
   以及复核命令 sca review <record_id> --candidate <id>；没有新增只回一句"无新增"。
   不要生成报告文件、不要把 transcript 原文粘进回复。
7. 禁止：approve / reject / edit_content / revoke / supersede；写入 AGENTS.md、CLAUDE.md
   或任何记忆；修改技能文件或本提示词。候选一律留给你人工审核。
```

Claude Code 或纯 cron 同理：把上面第 1～7 步作为 `claude -p "<提示词>"`（或 `codex exec "<提示词>"`）的入参，交给系统的 crontab / launchd 定时触发；分析质量取决于该次运行所用模型，sca 只保证记账与校验的确定性。

## 退出码

| 码 | 含义 |
|----|------|
| 0  | 成功 |
| 1  | 诊断/校验发现问题（doctor、validate 报告） |
| 2  | 命令抛出已分类错误（JSON 输出到 stdout） |
| 3  | 用法/参数解析错误 |

## 开发

```bash
npm run lint          # ESLint
npm run typecheck     # tsc 类型检查
npm test              # 单元测试
npm run test:integration   # 集成测试
npm run smoke:pkg     # 真实 npm pack 产物装进临时目录并跑全链路（需联网，发布前手动验证）
```

目录结构：`src/hosts`（主机 transcript 适配）、`src/domain`（规范化模型与约束）、`src/analysis`（prepare/ingest/rework）、`src/store`（Markdown 存储、锁、原子提交）、`src/review`（评审决策、候选详情、文本输出）、`src/cli.ts`（命令行入口）、`tests/`（含合成 fixtures）。

## License

[MIT](LICENSE)
