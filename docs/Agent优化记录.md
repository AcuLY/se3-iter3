# Agent 优化文档

## 1. 优化目标

本项目的 Agent 优化目标不是让模型“回答得更像人”，而是让 Agent 稳定参与旅行规划工作台中的结构化协作：

- 能把自然语言请求转成可编辑行程画布的结构化修改。
- 能区分新增、更新、删除、移动、路线、天气、偏好、Skill 等不同意图。
- 能把用户手动画布编辑视为约束，不擅自覆盖或夹带无关改动。
- 能读取历史对话、保存的偏好记忆和已导入 Skill，实现跨对话连续规划。
- 能把地点、路线、天气和时间风险等工具能力封装成用户可理解的规划结果。
- 能用评估数据集记录问题发现、优化实现和优化后效果。

## 2. 问题发现

### 2.1 文本行程难以继续编辑

早期 Agent 更容易输出一段 Markdown 行程。用户看得到建议，但无法在画布上继续移动活动、补地点、改路线或导出检查。

影响：

- 用户需要手工复制整理。
- 前端无法定位 Agent 改了哪一天、哪项活动或哪段路线。
- 后续导出、路线检查和 Skill 沉淀无法复用结构化数据。

### 2.2 意图分流不精确

早期确定性 Agent 容易把所有请求都压成“新增一个活动”。典型 bad case：

- 用户只要求“补全景点之间的交通路线”，结果额外新增活动。
- 用户只要求“把返回日期改到 7 月 5 日，预算 2600”，结果 Day 2 多出无关活动。
- 用户要求“取消 A 到 B 这段交通，活动本身保留”，系统可能忽略，或把取消误判成删除活动。
- 用户要求“把湖滨咖啡移到 Day 2 上午第一项”，系统可能新增一项，而不是移动原活动。

影响：

- 用户无法信任 Agent 会按指令精确操作画布。
- 手动规划成果容易被污染。
- 多轮对话越多，结构化行程越容易偏离用户真实意图。

### 2.3 地点和路线工具链不闭合

旅行规划中的地点和路线是联动关系。早期问题包括：

- 替换地点后旧路线仍保留，地图坐标和交通段不一致。
- 模型新增 POI 后漏掉“补全路线”工具调用，画布出现有地点但无线段。
- 多交通方式比较缺少统一工具，在线模型只能猜测一个路线结果。
- 路线晚到只能提示风险，不能根据用户选择执行顺延、缩短上一站或换更快交通方式。

影响：

- 地图、路线和时间表之间无法形成闭环。
- 用户需要手动修补 Agent 未完成的路线状态。

### 2.4 Skill 只是提示词，缺少产品闭环

早期旅行风格只存在于 prompt 中，用户无法把风格作为资产导入、创建、发布和复用。

影响：

- Skill 难以沉淀为可分享的产物。
- 用户无法判断当前 Agent 是否真的读取了某个旅行风格。
- 对话中的风格经验无法进入后续规划。

### 2.5 对话记忆和偏好管理不清晰

Agent 会使用历史上下文，但如果不提供用户侧管理入口，会出现两个问题：

- 用户不知道旧对话是否会影响当前规划。
- 用户无法清除不想继续使用的会话记忆。

同时，直接把内部上下文摘要展示在聊天区，又会让普通用户看到过多工程实现细节。

### 2.6 流式停止和错误处理不完整

如果前端只中断浏览器请求，服务端仍继续执行 Agent，就会出现“用户以为已停止，刷新后画布被后台修改”的隐藏副作用。

如果 SSE 错误事件被前端误当成普通失败再走本地改写，也会造成服务端明确失败但画布仍被修改。

## 3. 优化具体实现

### 3.1 结构化行程模型和 patch

相关模块：

- `packages/shared/src/types.ts`
- `packages/shared/src/itinerary.ts`
- `apps/api/src/services/itineraryService.ts`
- `apps/api/src/services/agentService.ts`

实现方式：

- 用 `TravelItinerary`、`ItineraryDay`、`Activity`、`TransportLeg` 表示行程画布。
- Agent 输出经过服务端工具或确定性分流转成结构化操作。
- 支持新增活动、更新活动、删除活动、移动活动、跨天移动、交通段添加和交通段删除。
- 前端只根据结构化结果更新画布，不从自然语言中猜测修改。

优化效果：

- Agent 结果可以继续手动编辑。
- diff 可以定位到具体 Day、活动或路线。
- 导出检查、路线风险和 Skill 提取复用同一份行程数据。

### 3.2 本轮 diff 和手动编辑边界

相关模块：

- `packages/shared/src/itinerary.ts`
- `apps/web/src/App.tsx`

实现方式：

- Agent 运行前后比较行程结构，生成“本轮改动”。
- 右侧助手把 diff 渲染为独立区域，并提供定位入口。
- 用户手动编辑、地图填入地点、手动记录路线、导入 Skill 不生成 Agent diff。
- 地点变化会清理相邻旧路线，避免旧路线继续绑定新地点。

优化效果：

- 用户能清楚知道 Agent 改了什么。
- 手动操作和 Agent 操作边界清晰。
- 同一画布可在人工编辑和 Agent 协作之间来回切换。

### 3.3 确定性意图分流优化

相关模块：

- `apps/api/src/services/agentService.ts`
- `packages/shared/src/fixtures.ts`
- `data/evaluation/agent-optimization-dataset.json`

实现方式：

- 先解析纯行程信息更新，再判断是否需要活动或路线操作。
- 纯路线请求只补全相邻活动交通，不新增活动。
- 纯详情请求只更新日期、预算、备注、目的地、同行人和偏好。
- 已有活动更新请求只修改目标活动的时间、预算、备注或地点。
- 地点替换请求调用 POI 搜索并保留原活动 id。
- 活动移动请求生成 `moveActivity`，不新增替代活动。
- 活动删除请求生成 `removeActivity`，并保护“取消交通段”不误删活动。

优化效果：

- `intent-route-only`：只补路线，不新增活动。
- `intent-details-only` 和 `intent-natural-date-details`：只更新行程信息，不污染日程。
- `intent-activity-update`：修改已有活动字段，活动数量不变。
- `intent-place-replace`：保留活动槽位，替换为新 POI 和坐标。
- `intent-activity-move`、`intent-activity-remove`：对已有活动做精确移动和删除。

### 3.4 地点、路线和时间风险工具优化

相关模块：

- `apps/api/src/services/mapService.ts`
- `apps/api/src/services/agentService.ts`
- `packages/shared/src/itinerary.ts`
- `apps/web/src/App.tsx`

实现方式：

- POI 搜索结果写入活动的地点名、地址、行政区、坐标和其他可展示信息。
- 指定路段交通请求只更新用户点名的两个活动之间的路线。
- 交通比较工具按候选方式逐个查询，并按最快或最短选择结果。
- 交通段取消只删除路线，不删除端点活动。
- 路线晚到复用共享层时间风险计算，支持 `delay_next`、`shorten_previous` 和 `shift_downstream`。
- 当用户要求更快路线且不改活动时间时，优先比较交通方式，而不是顺延活动。
- 在线模型新增地点但漏调路线工具时，服务端根据用户明确路线意图补齐相邻交通。

优化效果：

- `intent-specific-transport-mode`：只改指定路段交通方式。
- `intent-transport-compare-fastest`：比较多个交通方式并选择最快路线。
- `intent-transport-remove`：取消路线但保留活动。
- `intent-route-conflict-delay-next`：晚到后顺延下一项。
- `intent-route-conflict-shorten-previous`：晚到后缩短上一站停留。
- `intent-route-conflict-shift-downstream`：整体顺延后续安排。
- `intent-route-conflict-faster-mode`：改用更快交通方式，不改活动时间。
- `deepseek-add-place-route-closure`：在线模型漏调路线工具时仍能闭合路线。

### 3.5 在线模型工具能力补齐

相关模块：

- `apps/api/src/services/agentService.ts`
- `apps/api/src/services/chatCompletionClient.ts`

实现方式：

- 模型通过 Chat Completions 风格 tool calls 调用服务端工具。
- 新增或补齐在线模型工具：新增地点、更新活动地点、比较交通方式、取消交通段、调整路线时间冲突。
- 服务端不完全信任模型参数：候选交通方式不足时补齐默认候选；工具漏调时根据明确用户意图兜底；工具执行前后都进行结构化校验。

优化效果：

- `deepseek-transport-compare-tool`：在线模型可触发交通比较，而不是只写文字说明。
- `deepseek-place-replace-tool`：在线模型可保留活动 id 并替换 POI 坐标。
- `deepseek-transport-remove-tool`：在线模型可只删除交通段。
- `deepseek-route-conflict-delay-next-tool`：在线模型可复用服务端路线晚到修复。

### 3.6 Skill 添加和风格影响反馈

相关模块：

- `packages/shared/src/skill.ts`
- `packages/shared/src/skillCreator.ts`
- `apps/api/src/services/skillService.ts`
- `apps/api/src/services/skillCreatorAgentService.ts`
- `apps/api/src/services/skillCreatorAgentPrompt.ts`
- `apps/web/src/App.tsx`

实现方式：

- Skill 广场支持浏览、推荐、收藏、发布、更新、下架、删除和添加到当前行程。
- `skill.ts` 负责解析和生成 `SKILL.md` 风格内容，并维护版本历史。
- Skill Creator 支持从当前行程、最近对话或外部攻略提取草稿，再通过引导式对话补齐规则。
- 已导入 Skill 被写入当前行程，Agent 运行时读取 Skill 规则。
- 助手展示当前风格和本轮风格影响，但不把导入动作本身写成画布 diff。

优化效果：

- 用户可以把旅行经验沉淀为资产，而不是一次性 prompt。
- Agent 后续规划能持续读取 Skill。
- 用户可以看到风格如何影响本轮安排。

### 3.7 对话记忆和跨对话知识共享

相关模块：

- `apps/api/src/services/historyService.ts`
- `apps/api/src/services/conversationContextService.ts`
- `apps/api/src/services/memoryService.ts`
- `apps/api/src/db.ts`
- `apps/api/src/server.ts`

实现方式：

- `sessions` 保存 Agent 会话结果、上下文摘要和偏好摘要。
- `traces` 保存工具调用和执行证据。
- `HistoryService` 支持历史行程、conversation 搜索和按行程恢复对话。
- `ConversationContextService` 把历史对话压缩成后续 Agent 可用的上下文。
- `MemoryService` 通过 `/api/memories` 管理跨对话保存的偏好知识。
- `DELETE /api/agent/sessions?itineraryId=...` 清除当前行程 session 和 trace。

优化效果：

- 用户可以管理对话，而不是只能在当前页面临时聊天。
- 偏好、禁忌和旅行习惯能跨对话复用。
- 用户可以清除不想继续影响规划的旧记忆。
- 内部摘要不干扰普通聊天体验。

### 3.8 流式运行、停止和错误闭环

相关模块：

- `apps/api/src/server.ts`
- `apps/api/src/services/agentService.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/api/client.ts`

实现方式：

- `POST /api/agent/run-stream` 使用 SSE 输出 progress、final 和 error。
- 前端停止运行或连接关闭后，后端通过 `AbortSignal` 中断 Agent 流程。
- 被取消的运行不保存 session、trace，也不写入行程。
- SSE `event:error` 会显示服务端失败原因，并保持“行程没有改动”。

优化效果：

- 用户点击停止后，刷新页面不会出现隐藏后台改动。
- 服务端明确失败时，前端不会误套用本地画布修改。

## 4. 优化后效果评估

评估数据集位于：

```text
data/evaluation/agent-optimization-dataset.json
```

当前归档 29 条用例，覆盖类别如下：

| 类别 | 数量 | 覆盖重点 |
| --- | ---: | --- |
| `normal_planning` | 1 | 普通行程生成 |
| `skill_fusion` | 1 | Skill 融合规划 |
| `manual_replan` | 1 | 手动编辑保护后重规划 |
| `skill_extraction_internal` | 1 | 从系统行程提取 Skill |
| `skill_extraction_external` | 1 | 从外部游记提取 Skill |
| `skill_script_success` | 1 | Skill 脚本成功执行 |
| `skill_script_failure` | 1 | Skill 脚本失败时的可解释处理 |
| `intent_routing` | 21 | 行程详情、活动、地点、路线、时间冲突等意图分流 |
| `tool_orchestration` | 1 | 在线模型工具编排兜底 |

### 4.1 代表性优化效果

| 问题 | 代表用例 | 优化后效果 |
| --- | --- | --- |
| 纯路线请求夹带新增活动 | `intent-route-only` | 保留原活动，只补全相邻路线 |
| 详情更新污染日程 | `intent-details-only`、`intent-natural-date-details` | 只更新日期、预算、备注，不新增活动 |
| 旅行档案无法更新 | `intent-profile-details` | 更新目的地、同行人和偏好，并刷新偏好摘要 |
| 已有活动编辑失败 | `intent-activity-update` | 修改目标活动时间、预算和备注 |
| 地点替换缺少 POI | `intent-place-replace`、`deepseek-place-replace-tool` | 保留活动 id，写入新地点和坐标 |
| 点名新增地点退化成泛化活动 | `intent-place-add` | 新增用户点名 POI，并补齐路线 |
| 交通取消误删活动 | `intent-transport-remove`、`deepseek-transport-remove-tool` | 删除交通段，保留端点活动 |
| 多交通方式无法比较 | `intent-transport-compare-fastest`、`deepseek-transport-compare-tool` | 查询多个候选方式并选择最快或最短路线 |
| 路线晚到只能提示 | `intent-route-conflict-delay-next`、`intent-route-conflict-shorten-previous`、`intent-route-conflict-shift-downstream` | 根据用户选择执行不同时间修复策略 |
| 用户只想先看方案 | `intent-route-conflict-options` | 返回可选方案，不改画布 |
| 在线模型漏调路线工具 | `deepseek-add-place-route-closure` | 服务端根据明确路线意图补齐相邻交通 |

### 4.2 效果评估口径

本项目用数据集字段记录优化前后差异，重点观察：

- 是否命中正确意图。
- 是否只修改用户要求的结构化对象。
- 是否保留已有活动和用户手动编辑。
- 是否调用必要工具，例如 POI、路线、交通比较、时间冲突修复和 Skill 处理。
- 是否把 Agent 结果落到画布，而不是停留在文本说明。
- 是否生成用户可理解的 diff 或只读方案。

该评估数据集用于归档和复盘，不依赖当前运行时代码中的评估 API。

## 5. 局限与后续优化

- 当前评估数据集规模有限，主要覆盖杭州样例和高频规划意图，后续可加入更多城市、同行人、预算和季节约束。
- Skill 脚本能力仍以产品闭环和数据结构为主，后续可补充脚本沙箱、依赖隔离、超时控制和日志查看。
- 地图能力依赖外部服务 Key，后续可补充配额提示、缓存策略和更细的失败恢复建议。
- 在线模型工具选择仍可能波动，服务端已做关键兜底，但后续可继续扩展工具参数校验和自动修复策略。
- 目前评估数据以 JSON 归档，后续可以单独开发评估查看器，但不作为本次代码运行时必要模块。
