# Journey Skill Agent

旅行风格 Skill 分享平台与多 Agent 行程规划工作台。

## 技术栈

- TypeScript monorepo
- React + Vite + Tailwind
- shadcn 风格本地组件
- Node.js + Express
- SQLite via `node:sqlite`
- Zod
- OpenAI Agents SDK 方向预留
- 高德 API 方向预留，默认 mock fallback

## 本地运行

```bash
npm install
npm run dev
```

默认地址：

- Web：`http://localhost:5173`
- API：`http://localhost:4317/api/health`

也可以分别启动：

```bash
npm run dev:api
npm run dev:web
```

## 验证命令

```bash
npm test
npm run typecheck
npm run build
```

## 交付文档

- `docs/requirements-analysis.md`
- `docs/detailed-design.md`
- `docs/meeting-records.md`
- `docs/agent-optimization.md`
- `data/evaluation/agent-optimization-dataset.json`
- `docs/ppt/defense-outline.md`
- `docs/ppt/journey-skill-agent-defense.pptx`

## 演示路径

1. 打开首页。
2. 进入工作台。
3. 手动添加活动。
4. 在右侧导入“慢节奏街区漫步” Skill。
5. 输入 Agent 请求并发送。
6. 查看中间画布新增活动和“本轮改动” diff。
7. 打开 Skill 广场和评估后台。

## 外部服务说明

当前版本为了稳定答辩演示，OpenAI/Amap 都以可替换适配点和 mock fallback 形式实现。没有 API Key 时仍可完整运行、测试和演示。
