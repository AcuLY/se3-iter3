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
- 右侧 Agent：对话、导入 Skill、回复末尾 diff 摘要。

## 6. 技术架构

- TypeScript monorepo。
- React + Vite + Tailwind + shadcn 风格组件。
- Node.js + Express + SQLite。
- 共享领域模型。
- OpenAI Agents SDK 方向，多 Agent 编排。
- 高德 API 方向，mock fallback。

## 7. 多 Agent 编排

- MainAgent：任务理解和调度。
- StyleAgent：Skill 融合。
- WeatherAgent：天气约束。
- TransportAgent：路线可行性。
- AttractionAgent：景点候选。
- PlannerAgent：结构化 patch。
- CriticAgent：检查与修正。

## 8. Skill 机制

- 标准 `SKILL.md` frontmatter。
- 支持上传、提取、编辑、发布、导入。
- 提取结果必须用户确认。
- Skill 广场支持推荐和收藏。

## 9. 关键优化

- 结构化 patch 直接更新画布。
- 行程 diff 作为 Agent 回复末尾的最后输出展示本轮修改。
- `lockedByUser` 保护手动编辑。
- trace 记录多 Agent 和工具调用。
- 工具失败降级为可解释 fallback。

## 10. 评估数据集

- 普通行程生成。
- Skill 融合。
- 系统行程提取 Skill。
- 外部游记提取 Skill。
- 手动修改后重规划。
- Skill 脚本成功与失败 fallback。

## 11. 测试与验证

- `npm test`：共享层、API、前端测试。
- `npm run typecheck`：类型检查。
- `npm run build`：生产构建。
- 浏览器验证核心路径。

## 12. 演示路径

1. 打开首页。
2. 进入工作台。
3. 手动添加活动。
4. 导入慢节奏 Skill。
5. 发送 Agent 请求。
6. 查看画布更新和右侧对话末尾的本轮 diff。
7. 打开 Skill 广场和评估后台。

## 13. 总结

本迭代把 Agent 从“回答问题”推进到“协作生产可编辑旅行规划产物”，并形成了 Skill 沉淀、分享、导入和评估优化闭环。
