# session-correction-analysis (sca)

显式分析 AI 编码会话（Codex / Claude Code）中的纠错内容，生成候选规则/笔记，经人工评审后导出 Markdown。CLI 在本机读取、校验和保存数据，不自行发起模型网络请求；语义分析由宿主 Agent 执行，是否联网取决于宿主配置。Phase 1 不做自动发布、不做历史搜索、无定时任务。

## 特性

- **双主机适配**：读取并规范化 Codex / Claude Code 的会话 transcript（JSONL）
- **可复现的分析管线**：`prepare` 冻结输入范围并生成 analysis packet（含证据、覆盖率、租约），分析结果通过 `ingest` 按 schema 校验后提交
- **人工评审**：对候选执行 `approve / reject / revoke / edit_content / supersede`，基于 `--request + --expected-revision` 幂等，防止并发覆盖
- **纯本地 Markdown 存储**：所有记录为带 frontmatter 的 Markdown 文件，可直接阅读；`validate` 提供只读一致性检查
- **内容导出**：仅已批准候选可 `copy_content / export_content`，无自动写入外部 sink

## 环境要求

- Node.js `>=24 <25`（见 `.nvmrc`）

## 安装

```bash
git clone https://github.com/timestatic/session-correction-analysis
cd session-correction-analysis
npm install
npm run build
```

构建产物在 `dist/`，CLI 入口为 `dist/src/cli.js`（bin 名 `sca`）。可 `npm link` 后将 `sca` 作为全局命令使用，或直接 `node dist/src/cli.js`。

## 快速开始

```bash
# 0. 首次试用选择一个尚不存在的独立目录，后续查看时继续使用同一路径
#    如果该路径已有旧版数据，请换一个新路径，不要清空旧目录
export SCA_DATA_ROOT="$HOME/.session-correction-analysis-phase1"

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

## 数据目录

记录默认存放在 `~/.session-correction-analysis/`（`records/` 记录、`runtime/` packet 与租约）。用 `--data-root <path>` 或环境变量 `SCA_DATA_ROOT` 覆盖。Phase 1 请使用全新的数据目录，旧版规则/发布记录不受支持。

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
npm run package:skill      # 构建技能发布包
```

目录结构：`src/hosts`（主机 transcript 适配）、`src/domain`（规范化模型与约束）、`src/analysis`（prepare/ingest/rework）、`src/store`（Markdown 存储、锁、原子提交）、`src/review`（评审决策、候选详情、文本输出）、`src/cli.ts`（命令行入口）、`tests/`（含合成 fixtures）。

## License

[MIT](LICENSE)
