# Agent 优化文档

项目名称：Journey Skill Agent 旅行风格智能体工作台  
日期：2026-06-14  
评估数据集：`data/evaluation/agent-optimization-dataset.json`

## 1. 优化目标

迭代三的 Agent 优化目标不是单纯提升一句回答的质量，而是提升“结构化旅行规划产物”的可用性。

目标包括：

- 让 Agent 的结果直接更新可编辑行程画布。
- 让用户导入 Skill 后能看到风格融合结果。
- 让用户手动修改后的内容不会被 Agent 随意覆盖。
- 让天气、交通、景点、风格、规划等上下文由不同子 Agent 分工处理。
- 让工具或 Skill 脚本失败时有可解释降级，而不是中断规划。
- 让优化过程有数据集、指标和 trace，可用于答辩复盘。

## 2. 优化前问题发现

### Bad Case 1：只输出 Markdown，不更新画布

现象：Agent 生成一段自然语言行程，前端无法继续编辑活动块。  
影响：用户仍然需要复制、整理、拆分内容，产品不像工作台。

### Bad Case 2：旅行风格无法沉淀和复用

现象：风格只存在于提示词里，无法上传、分享、导入和复用。  
影响：业务亮点不足，难以体现“用户自定义风格”的闭环。

### Bad Case 3：单 Agent 上下文混杂

现象：天气、交通、景点、风格和规划逻辑混在一个上下文里。  
影响：输出原因不清晰，工具失败难定位，也不利于答辩展示多 Agent 编排。

### Bad Case 4：覆盖用户手动修改

现象：用户锁定的活动可能被 Agent 重规划覆盖。  
影响：用户不信任 Agent 协作，手动编辑价值被削弱。

### Bad Case 5：缺少评估证据

现象：无法说明优化前后效果，只能主观描述“更好”。  
影响：答辩缺少量化证据和可复盘材料。

## 3. 优化具体实现

### 3.1 结构化行程模型和 Patch

相关文件：

- `packages/shared/src/types.ts`
- `packages/shared/src/itinerary.ts`

实现方式：

- 定义 `TravelItinerary`、`ItineraryDay`、`Activity`。
- Agent 不直接输出 Markdown，而是生成结构化 patch。
- 支持 `addActivity`、`updateActivity`、`removeActivity`、`moveActivity`。
- 前端画布直接渲染更新后的结构化行程。

效果：

- Agent 结果可以继续编辑。
- 行程产物不再依赖用户复制粘贴。

### 3.2 行程 diff

相关文件：`packages/shared/src/itinerary.ts`

实现方式：

- `diffItineraries(before, after)` 对比 Agent 更新前后的行程。
- 每次 Agent 更新后，在右侧对话的最后一条助手回复末尾展示本轮新增、删除、更新的活动。
- 用户直接在画布中的手动编辑只更新行程状态，不生成对话 diff。

效果：

- 用户可以看到 Agent 改了什么。
- 答辩时可以清楚展示“Agent 回复末尾的 diff”。

### 3.3 手动编辑保护

相关文件：`packages/shared/src/itinerary.ts`

实现方式：

- 活动支持 `lockedByUser`。
- `applyItineraryPatch` 在 Agent 修改锁定活动时保留用户字段。
- 冲突字段写入 `conflicts`，进入后续 diff/trace。

效果：

- 用户手动成果不会被覆盖。
- Agent 从“替用户改一切”变成“基于用户画布协作”。

### 3.4 Skill 标准化

相关文件：

- `packages/shared/src/skill.ts`
- `apps/api/src/services/skillService.ts`

实现方式：

- 按 `skill-creator` 标准解析和生成 `SKILL.md`。
- frontmatter 至少包含 `name` 和 `description`。
- 支持 `parseSkillMarkdown`、`buildSkillMarkdown`、`recommendSkills`、`summarizeItineraryAsSkill`。
- 从行程或外部文本提取的 Skill 默认是 `draft`，必须用户确认后发布。

效果：

- 业务闭环从“规划一次行程”扩展为“沉淀风格 -> 分享 -> 导入 -> 再规划”。
- Skill 广场推荐成为可展示亮点。

### 3.5 多 Agent 编排

相关文件：`apps/api/src/services/agentService.ts`

实现方式：

- `MainAgent` 理解用户目标并调度子 Agent。
- `StyleAgent` 融合 Skill。
- `WeatherAgent` 检查天气约束。
- `TransportAgent` 检查路线可行性。
- `AttractionAgent` 补充景点和活动候选。
- `PlannerAgent` 生成结构化 patch。
- `CriticAgent` 检查需求覆盖和手动保护。

效果：

- 不同专业上下文隔离。
- trace 可用于开发后台和答辩说明。
- 普通用户界面只展示摘要，避免过度暴露内部细节。

### 3.6 工具降级

相关文件：

- `apps/api/src/services/mapService.ts`
- `apps/api/src/services/evaluationService.ts`

实现方式：

- 高德方向能力统一封装为 POI、路线、天气服务。
- 无 Key 或演示环境使用 mock fallback。
- Skill 脚本失败作为评估用例进入数据集，要求返回可用降级结果。

效果：

- 本地无外部 Key 也可稳定运行。
- 工具失败不会中断完整规划流程。

## 4. 评估数据集

数据集位置：

```text
data/evaluation/agent-optimization-dataset.json
packages/shared/src/fixtures.ts
```

覆盖场景：

- 普通行程生成。
- Skill 融合。
- 手动编辑后重规划。
- 从系统行程提取 Skill。
- 从外部游记提取 Skill。
- Skill 脚本成功执行。
- Skill 脚本失败 fallback。

每条评估样例包含：

- 用户输入。
- 预期关键词、风格关键词、最小天数、需保留活动、所需工具/Agent。
- 优化前 Bad Case 输出。
- 优化后输出。

## 5. 评估指标

| 指标 | 含义 |
| --- | --- |
| `taskSuccess` | 综合任务成功率 |
| `requirementCoverage` | 需求关键词覆盖率 |
| `styleConsistency` | 风格关键词覆盖率 |
| `structureCompleteness` | 行程天数和结构完整度 |
| `manualPreservation` | 用户手动锁定内容保留率 |
| `toolSuccess` | 子 Agent/工具调用覆盖和脚本健康度 |

## 6. 优化后效果

当前自动化测试和评估后台证明：

- Agent 更新的是结构化行程画布。
- 导入 Skill 后可影响 Agent 行程补全。
- 本轮 diff 可以作为右侧对话的最后输出展示给用户。
- 手动锁定保护有单元测试覆盖。
- API、前端和评估后台均可离线运行。
- 评估数据集能够支撑优化前后对比。

验证命令：

```bash
npm test
npm run typecheck
npm run build
```

浏览器验证路径：

```text
进入工作台 -> 添加活动 -> 导入慢节奏 Skill -> 发送 Agent 请求 -> 画布新增活动 -> 右侧对话末尾显示本轮 diff
```

## 7. 后续可优化方向

- 接入真实 OpenAI Agents SDK 在线调用，把当前确定性编排替换为真实模型决策。
- 接入真实高德 Key，补全 POI 搜索、路线规划、天气查询等能力。
- 补充 Skill 脚本沙箱、超时控制、依赖隔离和日志查看。
- 扩展评估数据集规模，加入更多城市、同行人、预算和出行约束。
