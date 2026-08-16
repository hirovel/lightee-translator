# Lightee Electron 应用

主进程、preload 与 renderer 都在这个包里。renderer 用 Vite 构建。

## 命令

- `npm run dev` — 启动 Vite 与 Electron，指向同一个 renderer URL
- `npm run build` — 产出 `dist/`（renderer）与 `dist-main/`（主进程）
- `npm start` — 先构建再以生产模式启动 Electron
- `npm run typecheck` — 检查 renderer 与主进程两份 TypeScript 配置
- `npm test` — renderer 与主进程单元测试
- `npm run package:win` — 打包 Windows 安装版与免安装版，产物在 `release/`
- `npm run clean` — 删除构建产物与临时 profile，不碰工作区与配置文件

## 界面外壳

`renderer/shell/ui-shell.html` 是界面外壳的源文件，包含 DOM 骨架、CSS 与运行时脚本。
`npm run sync:ui-shell` 从中切出三个产物：

```
renderer/public/ui-shell-runtime.js
renderer/styles/ui-shell.css
renderer/index.html
```

这三个是生成产物，不要直接编辑；`build` 与 `dev` 都会先跑一次同步。
CSS 加载顺序为 `ui-shell.css` → `renderer.css` → `agent-console.css`。

外壳运行时自带的演示数据结构一律为空。真实数据由 `renderer/src/workspace/workspace-bridge.ts`
经 IPC 写入；外壳里任何由演示数据推导的写入都带 `!lighteeReal()` 守卫，让位于真实值。

## 接线图

`wiring/electron-wiring.json` 记录 renderer、preload、主进程、服务层、engine 与文件系统之间的连接。

- `npm run wiring:generate` — 生成可交互的 HTML 视图
- `npm run wiring:check` — 校验来源 JSON 与跨层引用

改动跨层连接时先更新 JSON，再跑校验。
