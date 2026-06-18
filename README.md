# Journey Skill Agent

旅行风格 Skill 分享平台与多 Agent 行程规划工作台。项目是一个 TypeScript monorepo，包含共享领域模型、Express API 和 React 前端。

## 技术栈

- TypeScript workspaces
- React 18 + Vite + Tailwind CSS
- shadcn 风格本地 UI 组件
- Node.js + Express
- SQLite via `node:sqlite`
- Zod schema 校验
- OpenAI-compatible Chat Completions 工具调用
- 高德 Web Service + 高德 JS API

## 运行要求

需要 Node.js 24 或更新版本。后端使用 `node:sqlite`，Node 20 运行时不支持该内置模块。

安装依赖：

```bash
npm install
```

本地同时启动 API 和 Web：

```bash
npm run dev
```

默认地址：

- Web: `http://localhost:5173`
- API health: `http://localhost:4317/api/health`

也可以分别启动：

```bash
npm run dev:api
npm run dev:web
```

## 环境变量

可以复制 `.env.example` 为 `.env` 后按需填写：

```bash
cp .env.example .env
```

常用配置：

- `API_PORT`: API 端口，默认 `4317`
- `WEB_PORT`: Vite 端口，默认 `5173`
- `DATABASE_PATH`: SQLite 文件路径，默认 `./data/journey.sqlite`
- `VITE_API_BASE_URL`: 前端访问 API 的基础地址，默认指向本地 API
- `AGENT_MODEL_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY`: Chat Completions 兼容模型 Key
- `AGENT_MODEL_BASE_URL` / `OPENAI_BASE_URL` / `DEEPSEEK_BASE_URL`: 模型服务地址
- `AGENT_MODEL` / `OPENAI_MODEL` / `DEEPSEEK_MODEL`: 模型名称
- `AMAP_WEB_SERVICE_KEY`: 后端调用高德 POI、路线、天气接口
- `VITE_AMAP_JS_API_KEY`: 前端加载高德 JS 地图
- `VITE_AMAP_SECURITY_JS_CODE`: 高德 JS API 安全密钥

缺少模型或高德配置时，对应 Agent、地点、路线、天气、地图功能会返回错误或不可用；代码不会自动使用本地 mock 结果替代真实服务。

## 项目结构

```text
.
├── apps/
│   ├── api/        # Express API, SQLite, Agent/Skill/Map services
│   └── web/        # React + Vite frontend
├── packages/
│   └── shared/     # Shared schemas, itinerary logic, Skill logic
├── scripts/        # Development orchestration scripts
├── package.json    # Root workspace scripts
└── tsconfig.base.json
```

## 代码模块

### `packages/shared`

共享领域层，不依赖 Express 或 React。

- `types.ts`: 行程、活动、路线、天气、Skill、Agent trace、记忆等 Zod schema 和类型
- `itinerary.ts`: 行程创建、日期调整、活动增删改移、交通段、天气、导出 Markdown、diff 和 Agent patch
- `skill.ts`: `SKILL.md` 解析、校验、构建、推荐、版本历史和从行程提取 Skill 草稿
- `skillCreator.ts`: Skill Creator 会话状态、问题轮次、答案校验和草稿 patch
- `fixtures.ts`: 种子行程和种子 Skill

### `apps/api`

后端服务层。

- `db.ts`: SQLite JSON 文档存储封装
- `server.ts`: REST API 和 SSE 路由
- `services/agentService.ts`: Chat Completions 工具调用循环、SSE 事件、Agent trace、记忆沉淀和结构化行程写入
- `services/conversationContextService.ts`: 多轮对话历史拼接、历史压缩和缓存摘要
- `services/historyService.ts`: 历史行程与对话检索
- `services/itineraryService.ts`: 行程 CRUD 和活动/日期/交通/天气写入
- `services/mapService.ts`: 高德 POI、路线和天气封装
- `services/memoryService.ts`: 全局保存记忆 CRUD
- `services/skillService.ts`: Skill 列表、导入、提取、发布、收藏、版本更新
- `services/skillCreatorAgentService.ts`: 基于模型的 Skill Creator 访谈流程

### `apps/web`

前端应用层。

- `src/App.tsx`: 页面路由、工作台、地图面板、活动编辑、路线编辑、Agent 面板、Skill 广场、Skill Creator 和记忆设置
- `src/api/client.ts`: JSON API、文本 API 和 SSE 客户端
- `src/components/ui/*`: 本地 UI 基础组件
- `src/index.css`: Tailwind tokens、地图 marker 样式和 Skill 视觉样式

## API 概览

核心路由按功能分组：

- `/api/health`
- `/api/itineraries`
- `/api/itineraries/:id/...`
- `/api/skills`
- `/api/skills/creator/...`
- `/api/memories`
- `/api/agent/run`
- `/api/agent/run-stream`
- `/api/agent/history/...`
- `/api/maps/poi`
- `/api/maps/route`
- `/api/maps/weather`

`/api/agent/run-stream` 使用 Server-Sent Events 返回 Agent 执行事件和最终结果。前端停止请求时会 abort 当前连接，后端在模型调用、工具执行和写入前检查取消状态。

## 数据存储

SQLite 表以 JSON 文档方式保存主要对象：

- `itineraries`
- `skills`
- `sessions`
- `traces`
- `skill_creator_sessions`
- `memories`

默认数据库路径由 `DATABASE_PATH` 控制。使用文件数据库时，代码会自动创建父目录。

## 脚本

```bash
npm run dev        # 同时启动 API 和 Web
npm run dev:api    # 只启动 API
npm run dev:web    # 只启动 Web
npm test           # 运行 shared、api、web 测试
npm run typecheck  # 构建 shared 后执行各 workspace 类型检查
npm run build      # 构建 shared、api、web
```

各 workspace 也可以单独运行：

```bash
npm run test -w @journey/shared
npm run test -w @journey/app-api
npm run test -w @journey/app-web
```
