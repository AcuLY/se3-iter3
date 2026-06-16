# 详细设计文档

项目名称：Journey Skill Agent 旅行风格智能体工作台  
日期：2026-06-14

## 1. 总体架构

系统采用 TypeScript 全栈 monorepo：

```text
iter3/
  packages/shared/   共享类型、领域逻辑、Skill 逻辑、评估逻辑
  apps/api/          Express API、SQLite、Agent/Skill/Map/Evaluation 服务
  apps/web/          React + Vite + Tailwind + shadcn 风格组件
  data/evaluation/   Agent 优化评估数据集
  docs/              需求、设计、会议、优化和答辩材料
```

前端通过 REST API 与后端通信。为保证答辩演示稳定，前端保留离线 fallback；后端在没有 DeepSeek Key、高德 Key 或外部服务失败时使用本地确定性降级路径。

## 2. 共享领域层

位置：`packages/shared/src`

- `types.ts`：定义行程、活动、Skill、Agent trace、地图、评估数据结构。
- `itinerary.ts`：实现行程创建、活动增删改移、日期添加、diff、Agent patch 和手动锁定保护。
- `skill.ts`：解析标准 `SKILL.md`、生成 Skill Markdown、推荐 Skill、从行程提取 Skill 草稿。
- `evaluation.ts`：对单条评估用例打分，聚合优化前后指标。
- `fixtures.ts`：提供种子行程、种子 Skill 和评估样例。

共享层不依赖 Express 或 React，因此可以独立测试，并被前后端共同复用。

## 3. 后端设计

位置：`apps/api/src`

### 3.1 数据存储

使用 Node 24 的 `node:sqlite`，封装在 `db.ts`。

当前表结构采用 JSON 文档存储：

- `itineraries`：行程。
- `skills`：旅行风格 Skill。
- `sessions`：Agent 会话。
- `traces`：Agent trace。
- `evaluation_cases`：评估用例。

选择 JSON 文档的原因是迭代三演示重点在 Agent 产品闭环和结构化产物，行程本身是嵌套结构，JSON 更适合快速验证。后续可拆分成规范化关系表。

### 3.2 API 路由

- `GET /api/health`
- `GET /api/itineraries`
- `POST /api/itineraries`
- `POST /api/itineraries/:id/days/:dayId/activities`
- `PATCH /api/itineraries/:id/activities/:activityId`
- `GET /api/skills`
- `GET /api/skills/recommendations`
- `POST /api/skills/import`
- `POST /api/skills/extract`
- `POST /api/skills/:id/publish`
- `POST /api/skills/:id/unpublish`
- `POST /api/skills/:id/favorite`
- `DELETE /api/skills/:id`
- `POST /api/agent/run`
- `POST /api/agent/run-stream`
- `GET /api/agent/traces`
- `GET /api/maps/poi`
- `POST /api/maps/route`
- `GET /api/maps/weather`
- `GET /api/evaluation/cases`
- `GET /api/evaluation/summary`

### 3.3 Agent 编排

当前实现以 `AgentService` 作为主编排入口：优先走 DeepSeek Chat Completions tool calls，失败或未配置 Key 时进入确定性降级路径。服务内部记录主/子 Agent trace，用于评估后台和答辩证据，不直接暴露给普通用户。

Agent 分工：

- `MainAgent`：理解用户目标，决定调度子 Agent。
- `StyleAgent`：融合导入的 Skill。
- `WeatherAgent`：检查天气约束。
- `TransportAgent`：检查路线可行性。
- `AttractionAgent`：补充景点或活动候选。
- `PlannerAgent`：生成结构化行程 patch。
- `CriticAgent`：检查需求覆盖和手动编辑保护。

`AgentService` 生成 trace，并通过 `applyItineraryPatch` 写回结构化行程画布。

`POST /api/agent/run-stream` 使用 SSE 返回用户可理解的规划进度和最终结果。前端点击“停止”会中断请求；服务端将连接关闭转换为 `AbortSignal`，并在模型调用、工具调用和写入 SQLite 前检查取消状态，避免用户停止后仍在后台产生 session、trace 或行程变更。

### 3.4 地图服务

`MapService` 以高德能力为目标封装：

- POI 搜索。
- 路线规划。
- 天气查询。

当前配置真实高德 Key 时会调用高德 POI、天气和方向规划接口；没有 Key 或外部服务不可用时返回本地可解释 fallback。这样既能保证上线功能使用真实服务，也能保证本地演示和测试稳定。

## 4. 前端设计

位置：`apps/web/src`

### 4.1 视觉语言

参考 `docs/DESIGN-pinterest.md`：

- 使用暖白、白色、浅灰作为主界面。
- 红色只用于主 CTA。
- 使用图片型内容卡、克制边框和清晰留白。
- 首页偏产品介绍，工作台偏工具界面。
- 组件采用 shadcn 风格本地源码组件：`Button`、`Card`、`Input`、`Textarea`、`Badge`、`Separator`、`Tabs`。

### 4.2 页面结构

- `HomePage`：产品介绍首页。
- `Workbench`：行程工作台。
- `SkillPlaza`：Skill 广场。
- `SkillCreator`：Skill 提取与创作。
- `EvaluationPage`：评估后台。
- `AgentPanel`：右侧 Agent 对话栏。

### 4.3 工作台布局

- 左侧：功能导航和会话记录。
- 中间：地图、日期导航、活动编辑器。
- 右侧：Agent 对话、Skill 状态栏与浏览面板、Agent 回复末尾 diff。

用户可以纯手动完成完整行程规划；Agent 是可选协作入口，不是唯一入口。
用户直接在画布上的手动编辑不计算对话 diff，只有 Agent 一轮修改会在本轮助手回复末尾追加结构化改动清单。diff 项带有定位目标时，用户可以从右侧对话直接跳到中间画布对应的 Day、活动或路线。

## 5. 关键机制设计

### 5.1 结构化 Patch

Agent 不直接返回 Markdown，而是返回结构化 patch 操作：

- `addActivity`
- `updateActivity`
- `removeActivity`
- `moveActivity`

前端画布根据 patch 更新，用户可继续编辑。

Agent 结果在前端保存 `changeSet` 元数据，包括 diff、参考旅行风格、撤销快照和可定位目标。定位目标由 Agent 更新前后的结构化行程比较生成，不依赖内部 trace；普通用户只看到“定位”按钮，不看到子 Agent 名称或工具参数。

### 5.2 手动编辑保护

活动支持 `lockedByUser`。当 Agent 尝试修改用户锁定活动时：

- 保留用户原字段。
- 允许更新 `tags` 和 `agentReason` 等非破坏性字段。
- 记录冲突，进入 diff/trace。

### 5.3 交通时间可行性

交通路线不只保存距离和耗时，还会参与行程时间可行性判断。共享层提供 `detectTransportTimingConflict(from, to, leg)`：

- 使用上一项活动的结束时间、路线耗时和下一项活动的开始时间计算预计到达。
- 预计到达晚于下一项开始时，返回用户可读的时间提醒。
- 前端路线卡和导出 Markdown 复用同一规则，避免画布和最终行程文档口径不一致。
- 用户手动调整路线耗时后会立即看到提醒；这属于画布状态，不会生成 Agent diff。

### 5.4 Skill 标准化

Skill 采用 `skill-creator` 标准格式：

```text
skill-name/
  SKILL.md
  references/
  assets/
  scripts/
```

当前代码支持解析和生成 `SKILL.md`，并支持从行程提取 draft Skill。脚本目录作为扩展能力保留，失败时降级，不中断主流程。

### 5.5 评估指标

评估指标包括：

- `taskSuccess`：综合任务成功率。
- `requirementCoverage`：需求关键词覆盖。
- `styleConsistency`：风格关键词覆盖。
- `structureCompleteness`：行程天数和结构完整度。
- `manualPreservation`：手动锁定内容保留。
- `toolSuccess`：子 Agent/工具调用覆盖和脚本健康度。

## 6. 测试设计

- 共享层单元测试：行程编辑、Skill 解析/推荐、评估打分。
- API 集成测试：行程、Skill、Agent、地图 mock、评估接口。
- 前端交互测试：进入工作台、手动添加活动、导入 Skill、运行 Agent、Skill 广场推荐。

验证命令：

```bash
npm test
npm run typecheck
npm run build
```
