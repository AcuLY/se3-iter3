# Journey Skill Agent

旅行风格 Skill 分享平台与多 Agent 行程规划工作台。

## 技术栈

- TypeScript monorepo
- React + Vite + Tailwind
- shadcn 风格本地组件
- Node.js + Express
- SQLite via `node:sqlite`
- Zod
- DeepSeek Chat Completions 工具调用
- 高德 Web Service + JS API，缺少 Key 时使用本地 fallback

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

配置 `DEEPSEEK_API_KEY`、`AMAP_WEB_SERVICE_KEY`、`VITE_AMAP_JS_API_KEY` 和 `VITE_AMAP_SECURITY_JS_CODE` 后，应用会调用真实 DeepSeek 和高德服务。当前已验证高德 POI、天气，以及步行、驾车、骑行、公交/地铁路线规划；缺少 Key 或外部服务不可用时仍会降级到本地确定性 fallback，保证本地运行和答辩演示不中断。
