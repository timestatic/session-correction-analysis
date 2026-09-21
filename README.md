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

## 特性

- **本地优先、零副作用**：数据只存在你选定的本地目录，CLI 不发起模型网络请求，无自动发布、无外部 sink——导出是唯一出口，且必须先经你批准
- **面向 harness 与记忆两条沉淀路径**：每条候选标注归属目标（`harness`：AGENTS.md / CLAUDE.md 等项目规范文档，可精确到文件与章节；`memory`：项目级或用户级 Agent 记忆），分析产出即知道该去往何处
- **双主机适配**：读取并规范化 Codex / Claude Code 的会话 transcript（JSONL）
- **可复现的分析管线**：`prepare` 冻结输入范围并生成 analysis packet（含证据、覆盖率、租约），分析结果通过 `ingest` 按 schema 校验后提交
- **人工评审**：对候选执行 `approve / reject / revoke / edit_content / supersede`，基于 `--request + --expected-revision` 幂等，防止并发覆盖
- **纯本地 Markdown 存储**：所有记录为带 frontmatter 的 Markdown 文件，可直接阅读；`validate` 提供只读一致性检查
- **内容导出**：仅已批准候选可 `copy_content / export_content`，无自动写入外部 sink

## 环境要求

- Node.js `>=24 <25`（见 `.nvmrc`）

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
sca review <record_id> --candidate <id>                 # 查看候选详情与证据
sca review <record_id> --action approve \
  --candidate <id> --request <uuid> --expected-revision <n>
sca review <record_id> --action export_content \
  --candidate <id> --out ./note.md                      # 导出已批准文本
```

各命令的完整参数见 `sca`（无参数时输出 USAGE）。

## 作为 Agent Skill 使用（Claude Code / Codex）

技能是纯指令文件（薄 Skill），不自带任何打包代码；CLI 通过 `npx -y session-correction-analysis` 按需获取（首次需能访问 npm registry，之后走缓存），要求 Node.js 24。

**安装技能**（二选一）：

```bash
# 方式一：skills.sh 一键安装
npx skills add timestatic/session-correction-analysis

# 方式二：手动复制本仓库 skills/session-correction-analysis/ 到
#   ~/.claude/skills/（Claude Code 全局）或项目 .agents/skills/、~/.codex/skills/（Codex）
```

**使用**：安装后在 Claude Code / Codex 中说「分析这个会话的纠错」或调用 `/session-correction-analysis`，Agent 会按技能引导通过 npx 依次执行 `doctor → register → prepare →（分析 packet 产出 submission）→ ingest → review`；你只需在 review 阶段对每个候选做 approve / reject / 编辑后批准，已批准文本可复制或导出为 Markdown。分析记录全部保存在本地数据目录（见下节）。

## 数据目录

记录默认存放在 `~/.session-correction-analysis/`（`records/` 记录、`runtime/` packet 与租约）。用 `--data-root <path>` 或环境变量 `SCA_DATA_ROOT` 覆盖。旧版 rule_ref/rule_review 或发布状态记录不受支持，遇到会被拒绝且不自动迁移。

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
```

目录结构：`src/hosts`（主机 transcript 适配）、`src/domain`（规范化模型与约束）、`src/analysis`（prepare/ingest/rework）、`src/store`（Markdown 存储、锁、原子提交）、`src/review`（评审决策、候选详情、文本输出）、`src/cli.ts`（命令行入口）、`tests/`（含合成 fixtures）。

## License

[MIT](LICENSE)
