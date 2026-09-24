# Project instructions for AI agents

## Skills

本项目的 Agent 技能包遵循开放标准 SKILL.md 格式（frontmatter：name/description），按发现路径分两处：

- **`.agents/skills/`（多 Agent 中立路径，Codex/Claude 等可自动发现）**：`typescript-node-standards` — 本仓库 TS/Node 开发规范（工具链、类型严格性、模块导入、错误处理、测试、提交前门禁）。**写、改、评审任何 TypeScript / Node.js / .mjs 代码前必须遵循该 skill。**
- `skills/`（对外发布的薄 Skill 源，随仓库分发）：`session-correction-analysis` — 纯指令 SKILL.md，命令入口用 `npx -y session-correction-analysis`，不自带打包代码。分析会话纠错时参考其 `SKILL.md`。

## 快速门禁

TS 变更完成后必须全绿：`npm run lint && npm run typecheck && npm test`。

## 发布（单一 npm 包 + 仓库内薄 Skill）

采用"薄 Skill + npx"模式，**只有一条 npm 发布线**；Skill 是仓库里的纯 markdown，随 git tag 一起发布，无独立产物：

```bash
npm login                       # 仅首次
npm version patch               # 或 minor/major，自动创建 git tag
npm publish                     # package.json 已设 publishConfig.access=public
git push && git push --tags
```

发布后用户获取方式（写入口在 README）：

- CLI：`npm install -g session-correction-analysis` 或 `npx -y session-correction-analysis`
- Skill：`npx skills add timestatic/session-correction-analysis`，或手动复制 `skills/session-correction-analysis/` 到 `~/.claude/skills/` / 项目 `.agents/skills/`；技能运行时经 npx 调 CLI

约束：

- `prepublishOnly` 钩子会自动跑 lint/typecheck/test/build 并 `chmod +x dist/src/cli.js`，**不要跳过或手动改版本号绕过**；钩子失败即发布失败，先修问题再重发（此时版本号已 bump，下一次 `npm version patch` 即可）
- 发布内容仅含 `files` 白名单：`dist/src`、`README.md`、`LICENSE`；新增运行时代码若发布依赖，需同步确认 `files` 覆盖
- SKILL.md 中的命令入口必须保持 `npx -y session-correction-analysis` 写法，版本兼容由 CLI 的 packet schema / strict 校验兜底；改 CLI 命令或参数时同步更新 SKILL.md 与 README
- `npm publish` 是对外不可逆操作：Agent 执行前必须先获得用户明确确认
- 验证发布产物用 `npm run smoke:pkg`（`packaging/smoke-package.mjs`：真实 `npm pack` → 装进临时 prefix → 用装出来的 `sca` bin 跑 doctor→register→prepare→ingest→review→edit/approve→copy/export→adopt/rules/revoke→validate 全链路，临时目录用完即删）。它需要联网装依赖，属手动/CI 命令，不进本地提交门禁。只想看打包清单用 `npm pack --dry-run`，不需要真实发布
- 厚 Skill（自包含 tar.gz + esbuild bundle）路线已废弃并删除 `packaging/build-skill.mjs`；其全链路冒烟价值已转移到上面的 `smoke:pkg`，不要再引入独立发布产物
