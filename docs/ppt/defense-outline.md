# 答辩 PPT 大纲

## 1. 标题页

Journey Skill Agent：旅行风格 Skill 分享平台与多 Agent 行程规划工作台

## 2. 任务要求对齐

- Agent 产品化。
- 多轮对话和工具管理。
- 用户自定义 Skill。
- Agent 优化与评估数据集。
- 完整代码、文档、会议记录和答辩材料。

## 3. 问题定义

- 旅行规划结果是复杂结构化产物。
- 普通聊天难以编辑、复用和沉淀风格。
- 用户需要在 Agent 协作和手动编辑之间自由切换。

## 4. 产品闭环

规划行程 -> 提取 Skill -> 用户确认 -> 发布 Skill -> 他人导入 -> 生成个性化行程 -> 再沉淀新 Skill。

## 5. 核心界面

- 首页：产品介绍和入口。
- 左侧导航：功能入口和会话记录。
- 中间画布：地图、日期导航、活动编辑。
- 右侧旅行助手：对话、选择旅行风格、回复末尾 diff 摘要。
- 普通用户界面不暴露 trace、工具名或主/子 Agent 名称。

## 6. 手动规划闭环

- 新建行程时录入目的地、日期、预算、同行人和备注。
- 活动支持新增、删除、拖拽排序、跨天移动和详细编辑。
- 地图搜索结果可直接填入当前活动或新增为活动。
- 路线支持规划、移除、手动校准和失败修复。

## 7. 高德地图能力

- POI 搜索用于补全地点、地址、行政区和坐标。
- 天气用于补充出行风险。
- 步行、驾车、骑行、公交/地铁路线用于交通规划。
- 地图画布支持路线段查看和路径步骤高亮。

## 8. 技术架构

- TypeScript monorepo。
- React + Vite + Tailwind + shadcn 风格组件。
- Node.js + Express + SQLite。
- 共享领域模型。
- DeepSeek Chat Completions 工具调用。
- 高德 Web Service + JS API。
- 本机 SQLite 和本地存储，localhost 可运行。

## 9. DeepSeek 工具调用

- `add_place_activity`：搜索真实 POI 后新增活动。
- `update_activity_place`：替换地点并保留活动槽位。
- `compare_transport_modes`：比较多种交通方式。
- `remove_transport_leg`：只取消交通段，不删除活动。
- `adjust_timing_conflict`：修复路线晚到问题。
- 工具调用失败时进入确定性降级路径。

## 10. 多 Agent 编排证据

- MainAgent：任务理解和调度。
- StyleAgent：Skill 融合。
- WeatherAgent：天气约束。
- TransportAgent：路线可行性。
- AttractionAgent：景点候选。
- PlannerAgent：结构化 patch。
- CriticAgent：检查与修正。
- 这些证据只在评估后台和文档/PPT 中展示。

## 11. Skill 机制

- 标准 `SKILL.md` frontmatter。
- 支持上传、提取、编辑、发布、导入。
- 提取结果必须用户确认。
- Skill 广场支持推荐和收藏。
- Skill 资产有版本历史，导入后会持续影响后续规划。

## 12. 关键优化

- 结构化 patch 直接更新画布。
- 行程 diff 作为 Agent 回复末尾的最后输出展示本轮修改。
- `lockedByUser` 保护手动编辑。
- trace 记录多 Agent 和工具调用。
- 工具失败降级为可解释恢复路径。
- 手动编辑不生成 Agent diff。

## 13. 评估数据集

- 29 个 Bad Case。
- 覆盖 9 类场景：普通规划、Skill 融合、手动保护、工具编排等。
- 记录优化前错误输出和优化后结果。
- 支撑 Agent 优化文档和评估后台。

## 14. 测试与验证

- 188 个自动化测试覆盖共享层、API、前端。
- `npm run typecheck`：类型检查。
- `npm run build`：生产构建。
- 浏览器验证核心路径。

## 15. 演示路径

1. 打开首页。
2. 进入工作台。
3. 手动补全一个地点和路线。
4. 导入或创作旅行风格。
5. 发送 Agent 请求新增地点并补全路线。
6. 查看画布更新和右侧对话末尾的本轮 diff。
7. 打开 Skill 广场和评估后台证据。

## 16. 总结

本迭代把 Agent 从“回答问题”推进到“协作生产可编辑旅行规划产物”，并形成了 Skill 沉淀、分享、导入和评估优化闭环。
