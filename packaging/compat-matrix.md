# 宿主兼容矩阵（T07a 冻结记录）

探测时间：2026-09-19，机器：macOS 14.2.0 (darwin arm64)。数据仅为**本机真实发现**，不是对外宣称的最低支持版本；正式发行矩阵在 T20 干净环境复验后更新（design 25.1 / 30）。

## 已冻结事实

| 项 | Codex | Claude Code |
|---|---|---|
| 探测命令 | `codex --version` | `claude --version` |
| 实测版本 | `codex-cli 0.146.0` | `2.1.220 (Claude Code)` |
| npm 包 | `@openai/codex`（`bin/codex.js`） | `@anthropic-ai/claude-code` |
| 本机安装位置 | `~/.hermes/node/bin/codex` → hermes 管理的 node 全局包 | `~/.hermes/node/bin/claude`（另有 `~/.nvm/versions/node/v25.6.1/bin/claude`） |
| 安装/升级命令（候选，未在本期真实执行） | `npm i -g @openai/codex@0.146.0` | `npm i -g @anthropic-ai/claude-code@2.1.220` 或宿主自更新 |
| 会话目录 | `~/.codex/`（sessions、config、AGENTS.md 存在） | `~/.claude/`（projects/settings 结构存在） |
| 本插件 Skill 可用性 | 待 T20 双插件包验证（disabled until proven） | 待 T20 验证 |
| Hook（SessionEnd 等） | **未验证 → 关闭**；无 Hook 时走显式 register + 定时 drain（design 27） | **未验证 → 关闭**；真实 SessionEnd/重复事件/异常 payload 测试属 T17 |
| 定时任务 | 宿主内 Skill drain prompt 属 T17；未注册前报告 `runner_unavailable` 保留 pending | 同左 |

## 非交互 PATH 实测（design 25.4 的动因）

- 非交互 shell（本仓库 Bash 工具环境）中 `codex`、`claude` **均不可解析**；只有登录交互 zsh（profile 注入 `~/.hermes/node/bin`）才可解析。
- 默认 `node` 为 Homebrew v26.7.0 且 PATH 优先于 nvm；工程验收固定使用 `~/.nvm/versions/node/v24.19.0/bin`。
- 结论：安装器与 Hook 配置不能假设交互 PATH；CLI/Hook 命令必须写显式绝对路径，或由用户在配置中提供 Node 路径，`sca doctor` 的 `node_on_path` 项负责诊断失效（NVM/hermes 版本目录变化同理）。

## 与代码的联动

- `src/domain/limits.ts` 的 `HOST_PROBE` 固化上表版本字符串；`tests/unit/domain/limits.test.ts` 断言二者一致，改版本必须同步本文件。
- 本机 OpenHarness 2.2.9 仅证明其自身适配，不作为本插件结论（design 25.1）。
