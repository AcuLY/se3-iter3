# Journey Skill Agent

旅行风格 Skill 分享平台与多 Agent 行程规划工作台。

## 技术栈

- TypeScript monorepo
- React + Vite + Tailwind
- shadcn 风格本地组件
- Node.js + Express
- SQLite via `node:sqlite`
- Zod
- OpenAI-compatible Chat Completions 工具调用（可用 `AGENT_MODEL_*`、`OPENAI_*` 或兼容的 `DEEPSEEK_*`）
- 高德 Web Service + JS API

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

配置 `AGENT_MODEL_API_KEY`/`OPENAI_API_KEY`/兼容的 `DEEPSEEK_API_KEY`、`AMAP_WEB_SERVICE_KEY`、`VITE_AMAP_JS_API_KEY` 和 `VITE_AMAP_SECURITY_JS_CODE` 后，应用会调用真实模型与高德服务。当前不会在缺少 Key 或外部服务失败时自动降级到本地 mock/fallback；错误会直接暴露到前端，演示数据需要通过 UI、API 或直接写 DB 手动创建。
