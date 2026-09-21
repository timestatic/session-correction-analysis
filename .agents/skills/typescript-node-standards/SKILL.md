---
name: typescript-node-standards
description: 本项目 TypeScript/Node.js 开发规范（工具链、类型、模块、错误处理、测试、发布门禁）。在 session-correction-analysis 仓库编写、修改或评审任何 .ts/.mts/.mjs 代码时使用；适用于 Claude Code、Codex 等所有在此仓库工作的 Agent。
---

# TypeScript / Node 开发规范

## 总则

在本仓库写任何 TypeScript/Node 代码前遵循本规范。规范与配置文件（`tsconfig.json`、`eslint.config.mjs`、`package.json`）冲突时，以配置文件为准，并报告差异。

## 运行时与工具链

- Node.js 24（`engines: >=24 <25`，见 `.nvmrc`）。只用 Node 24 稳定 API，不引入需实验开关的特性。
- ESM 项目（`"type": "module"`），不用 CommonJS（`require`/`module.exports`）。
- 运行时依赖刻意精简：目前仅 `zod`、`yaml`、`diff`、`proper-lockfile`。新增依赖需向用户说明理由并获确认。
- 构建用 `tsc -p tsconfig.build.json` 输出到 `dist/`；`esbuild` 仅用于打包 skill 发布物（`packaging/`）。

## 类型规范

- 保持 `tsc --noEmit`（`npm run typecheck`）零错误，禁止提交带类型错误的代码。
- 不放宽 tsconfig 严格项：`strict`、`noUncheckedIndexedAccess`、`exactOptionalPropertyTypes`、`noImplicitReturns` 全部生效，代码必须适配它们：
  - 索引访问（数组/Record）结果按 `T | undefined` 处理，先判空再用；
  - 可选属性不写 `x: undefined` 显式赋值（`exactOptionalPropertyTypes` 会拒绝）。
- 禁止 `any`；不确定类型用 `unknown` + 收窄。类型断言只用于收窄已验证的数据，优先用 zod 解析替代断言。
- 导出的函数、类公共方法必须有显式返回类型；局部变量靠推断。
- `import type` 强制（ESLint `consistent-type-imports` + `verbatimModuleSyntax`）：仅用于类型的导入必须写成 `import type`。

## 模块与文件

- `module`/`moduleResolution` 为 NodeNext：相对导入必须带 `.js` 扩展名（指向编译产物名，不是 `.ts` 源文件名）。
- 未从模块导出的内部符号不导出；一个模块聚焦一个职责。
- 命名：文件/目录 kebab-case；类 PascalCase；函数与变量 camelCase；常量 SCREAMING_SNAKE_CASE 仅用于真正的全局常量。
- 未使用参数/变量以 `_` 前缀豁免（ESLint 已配置 `^_`），其他情况不留死代码。

## 错误处理与数据校验

- 解析外部输入（transcript JSON、YAML 配置、CLI 参数、文件内容）必须过 zod schema，校验后再进业务逻辑；不在业务层到处 `if (!x)` 补洞。
- 面向 CLI 的错误路径输出结构化、可行动的信息（参考本仓库 `schema_invalid`/`evidence_not_found` 式错误码风格），错误信息不带敏感原文。
- 不吞异常：`catch` 后要么处理并明确记录，要么转换后重新抛出。禁止空 catch。
- 顶层入口（`src/cli.ts`）统一捕获并映射为退出码；库层抛错，不 `process.exit`。

## 并发与文件系统

- 状态文件写入用 `proper-lockfile`（本仓库既有模式），不自己实现锁。
- 文件路径全部基于显式 data-root/参数，不猜路径、不扫描用户目录。
- 写文件用"写临时文件 + rename"保证原子性。

## 测试

- 测试用原生 `node:test`，不引入 Jest/Vitest。
- 单元测试放 `tests/unit/`，集成测试放 `tests/integration/`，文件名 `*.test.ts`。
- 运行：`npm test`（单测）/ `npm run test:integration`。测试脚本会先 build。
- `tests/**` 中 ESLint 关闭了 `no-floating-promises`（runner 自行跟踪 promise），除此之外测试代码同样受完整 type-checked lint 约束。
- 修 bug 先补能复现的测试；测试不依赖 `test-data/` 之外的用户真实会话数据。

## 提交前门禁

改完代码必须依次全绿后才算完成：

```bash
npm run lint && npm run typecheck && npm test
```

涉及集成路径或 CLI 行为时追加 `npm run test:integration`。任何一步失败先修复，禁止用 `// eslint-disable`、`@ts-ignore`/`@ts-expect-error` 绕过（确有必要时逐条向用户说明）。

## 注释与代码风格

- 默认不写注释；只在约束/坑/反直觉设计处写一行说明 WHY。
- 不写任务性注释（"用于 X 流程""修复 #123"）。
- 语法目标 ES2023，可用现代特性（`structuredClone`、`Object.groupBy`、top-level await 视模块位置而定）。
