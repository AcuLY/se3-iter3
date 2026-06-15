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
- 前端会根据 Agent 前后的结构化行程生成定位目标，支持从 diff 项直接跳转到对应 Day、活动或路线。

效果：

- 用户可以看到 Agent 改了什么。
- 用户可以从“本轮改动”直接回到画布继续检查和手动调整。
- 答辩时可以清楚展示“Agent 回复末尾的 diff -> 定位到画布对象 -> 继续编辑”的闭环。

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

### 3.7 确定性 Agent 意图分流

相关文件：

- `apps/api/src/services/agentService.ts`
- `apps/api/src/server.test.ts`
- `data/evaluation/agent-optimization-dataset.json`
- `packages/shared/src/fixtures.ts`

问题发现：

- 在无在线模型或模型降级时，`runDeterministic` 会先固定生成一个 `addActivity` patch，再处理用户的具体请求。
- 当用户只说“补全所有景点之间的交通路线和时间”时，系统会额外新增一个活动，并把待补路线从 2 段错误扩大到 3 段。
- 当用户只说“把返回日期改到 2026-07-05，预算 2600，备注每天午后留出休息”时，系统会把 Day 2 从空白变成 1 个新活动。
- 当用户说“把西湖晨间散步改到 10:00-11:30，预算 30，备注改成避开早高峰”时，降级路径不会修改已有活动，导致 Agent 无法覆盖手动规划中的基础编辑流程。
- 当用户说“把湖滨咖啡换成灵隐寺，改成景点，时间 14:00-16:00”时，降级路径只能处理时间，不能搜索新地点、写入 POI 坐标或更新活动类型。
- 当用户说“把西湖晨间散步到湖滨咖啡这段交通改成公交/地铁”时，降级路径不会写入指定路段交通，或者只能按默认步行补全全程。
- 当用户说“比较西湖晨间散步到湖滨咖啡的步行、公交和骑行，选最快的路线”时，降级路径会把它压扁成第一个匹配到的交通方式，没有实际比较多个路线结果。
- 当用户说“取消西湖晨间散步到湖滨咖啡这段交通，活动本身保留”时，降级路径要么忽略这次取消，要么把“取消”误判为活动删除。
- 当交通耗时导致下一项晚到，用户说“帮我延后下一项”时，降级路径只能提示风险，不能直接把下一项时间写回画布。
- 当用户说“把湖滨咖啡移到 Day 2 上午第一项”时，降级路径容易把“移到”误判为新增安排，造成 Day 2 多出新活动，而原活动仍留在 Day 1。
- 当用户说“删掉湖滨咖啡，其他活动保持不变”时，降级路径不会删除已点名活动，用户还需要回到画布手工维护，基础协作闭环不完整。
- 这类行为会破坏用户对画布的信任：Agent 看起来不是按指令操作，而是在擅自改行程。

优化具体实现：

- 先解析 `parseDeterministicItineraryDetails`，再判断本轮是否是纯行程信息更新。
- 新增已有活动更新解析：只有当消息明确包含现有活动名称，并解析到时间、预算或备注之一时，才生成 `updateActivity` patch。
- 当本轮已命中具体活动时，裸写的“预算/备注”优先作为活动字段；只有“总预算/行程预算/行程备注”等明确全局表达才写入行程级字段，避免字段串写。
- 新增已有活动地点替换解析：当消息明确包含现有活动名称和“换成/替换成/改去/换到”等地点替换表达时，提取新地点名，调用高德 POI 搜索，并把活动标题、类型、`placeName` 和 `place` 坐标写回原活动。
- 新增指定路段交通解析：当消息中出现两个已有活动名，并包含公交/地铁、驾车、骑行或步行等方式时，生成 `TransportToolRequest`，复用 `applyTransportTool` 写入路线。
- 新增交通方式比较解析：当消息中出现两个已有活动名、多个交通方式和“比较/对比/最快/最短”等目标时，逐一调用路线工具，并按最快或最短策略选择结果写回画布。
- 新增指定交通段取消解析：当消息中出现两个已有活动名，并包含取消/删除/清除等动作和交通、路线、路段范围时，调用 `removeTransportLeg` 移除该活动对之间的路线，不删除活动。
- 新增路线时间冲突修复：复用共享层 `detectTransportTimingConflict`，当用户要求修复晚到、顺延或延后时，把受影响的下一项活动开始时间改到预计到达时间，并按延误分钟同步顺延结束时间。
- 新增活动移动解析：当消息中出现已有活动名称、移动类动词和目标 Day/位置时，生成 `moveActivity` patch，并把“移动已有活动”视为编辑行为，禁止本轮再默认新增活动。
- 新增活动删除解析：当消息中出现已有活动名称，并包含删除、删掉、去掉、移除、取消、不安排、delete/remove/cancel 等明确删除意图时，生成 `removeActivity` patch。
- 删除解析增加交通范围保护：当同一句话同时点名两个活动，并明确说的是交通、路线或路段时，不生成活动删除 patch，避免“取消 A 到 B 这段交通”误删活动。
- 新增位置解析：支持 “Day 2 上午第一项 / 第一项 / 最前 / 最后 / 第 N 项”等目标位置表达，统一交给 `moveActivity` 按目标日期和目标序号落位。
- 新增路线意图判断：包含路线、交通、距离、耗时、怎么走、公交、步行等词，并带有“所有/全部/每段/景点之间”等范围时，归类为路线补全。
- 新增活动意图判断：只有出现“安排/添加/加入/补一个/推荐一个”等动作，并指向活动、景点、咖啡、餐厅、备选等对象，或明确 Day N 的上午/下午/晚上安排时，才新增活动。
- `runDeterministic` 的 patch operations 由意图控制：纯路线和纯详情请求不再默认新增活动；已有活动更新请求先写入 `updateActivity`，必要时才叠加显式新增活动。
- 路线和地点补全只在路线请求或新增活动请求中运行；纯详情请求只更新行程信息和天气。
- 风格应用 diff 只在确实新增活动时追加，避免“导入风格”影响与本轮无关的详情修改。

优化后效果：

- 纯路线请求保留原有 4 个活动，只补全 2 段相邻交通，diff 为“已补全交通路线：2 段”。
- 纯详情请求扩展日期、更新预算和备注，但原有日期的活动数量保持不变，diff 不再包含新增活动。
- 已有活动更新请求会修改目标活动的时间、预算和备注，原有活动数量保持不变，且不会把活动预算/备注误写到行程总预算/备注。
- 已有活动地点替换请求会调用 POI 搜索，把原活动更新为新地点和坐标，同时保留原活动 id 和活动总数。
- 指定路段交通请求会只更新点名的两站交通方式，不触发全程补全，也不新增活动。
- 交通方式比较请求会真正计算多个候选路线，并把最快/最短结果写入同一段交通。
- 指定交通段取消请求会清除该段路线，两个端点活动保持不变，diff 记录为“已取消交通：A 到 B”。
- 路线晚到修复请求会把下一项活动顺延到预计到达时间，diff 记录为“已顺延活动：湖滨咖啡 到 11:45”。
- 已有活动移动请求会把目标活动移动到指定日期和位置，原有活动总数保持不变，diff 记录为“移动活动：湖滨咖啡 -> Day 2 第 1 项”。
- 已有活动删除请求会移除目标活动，并输出“删除活动：湖滨咖啡”，不会新增替代活动。
- 降级 Agent 的行为更接近正式产品：只修改用户要求的结构化对象。

### 3.8 Skill 导入反馈闭环

相关文件：
- `apps/web/src/App.tsx`
- `apps/api/src/services/agentService.ts`
- `apps/api/src/server.test.ts`
- `apps/web/src/App.test.tsx`

问题发现：
- 仅把 Skill 写入当前行程状态不足以形成闭环，用户看不到“已经使用哪个风格”和“接下来会按哪些规则规划”。
- Agent 受导入 Skill 影响补全行程时，回复正文如果只说“已更新行程”，用户无法判断风格是否真实参与。
- diff 必须继续只描述结构化行程变更，不能把“导入 Skill”这种非画布修改混入本轮改动。

优化具体实现：
- 用户在右侧助手或 Skill 广场使用旅行风格后，助手消息追加“已使用「风格名」”和可读规则摘要。
- Agent 本轮确实受导入 Skill 影响并产生行程变更时，回复正文使用“已更新行程，已按「风格名」调整。”，保留稳定成功文案，同时点明风格影响。
- 当用户只是导入 Skill 而没有触发 Agent 修改画布时，不生成“本轮改动”diff。

优化后效果：
- 用户能立即确认当前行程使用了哪个旅行风格。
- 答辩时可以展示“Skill 导入 -> Agent 应用规则 -> 行程画布更新 -> diff 输出”的闭环。
- 结构化 diff 仍只描述 Agent 对行程画布造成的变化，用户手动编辑和导入动作不会污染 diff。

### 3.9 偏好与会话记忆管理

相关文件：
- `apps/api/src/db.ts`
- `apps/api/src/server.ts`
- `apps/api/src/server.test.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`

问题发现：
- Agent 已经会基于历史会话生成 `contextSummary` 和 `userPreferenceSummary`，但这些内容如果放在右侧对话区，会把内部上下文管理暴露给普通用户。
- 用户需要能参与偏好迭代：既能显式编辑行程偏好，也能在需要时清除当前行程的助手记忆。
- 清除记忆不能只删前端状态，还要同步删除本地 SQLite 中的 session 和 trace，避免下一轮 Agent 继续读取旧上下文。

优化具体实现：
- 新增左侧“偏好设置”页面，集中管理行程偏好、最近会话摘要和助手记忆清除。
- 后端新增 `DELETE /api/agent/sessions?itineraryId=...`，按当前行程删除 Agent session，并同步删除关联 trace。
- 右侧对话区继续用于行程修改和本轮 diff，不显示“偏好记忆”面板。
- 前端清除记忆后立即把 `agentMemory` 置空，页面显示“暂无会话记忆”。

优化后效果：
- 偏好迭代由用户显式管理，符合“用户参与迭代”的产品要求。
- Agent 仍可利用会话历史生成更连续的规划建议，但内部摘要不会干扰主对话。
- 答辩时可以展示“对话产生偏好 -> 偏好设置页查看/编辑 -> 清除会话记忆 -> 下一轮不再读取旧上下文”的完整闭环。

### 3.10 流式运行与停止语义

相关文件：
- `apps/api/src/server.ts`
- `apps/api/src/services/agentService.ts`
- `apps/api/src/server.test.ts`
- `apps/web/src/App.tsx`
- `apps/web/src/App.test.tsx`

问题发现：
- 右侧助手已有“停止”按钮，但如果只中断浏览器请求，服务端 Agent 仍可能继续运行并写入 SQLite。
- 这会造成用户看到“行程没有改动”，刷新后却出现后台新增活动或 session 的不一致，属于正式产品不能接受的隐藏副作用。

优化具体实现：
- `POST /api/agent/run-stream` 为每次 SSE 连接创建 `AbortController`。
- 浏览器关闭连接或用户点击“停止”时，服务端将连接关闭转换为 abort signal。
- `AgentService.run`、DeepSeek 路径、确定性降级路径和天气/地点/交通工具写入前都会检查 abort signal。
- 被取消的运行不会发送 `final`，也不会保存 session、trace 或继续写入行程。

优化后效果：
- 用户停止本轮处理后，前端和后端状态一致，刷新后不会出现隐藏后台改动。
- API 测试覆盖“收到第一条 stream progress 后立即 abort，等待服务端处理，确认 session、trace 和 Day 2 活动数量都没有变化”。
- 这为后续更细粒度的 token/步骤级流式输出打下安全基础。

### 3.11 在线模型新增地点后的路线闭合兜底

相关文件：
- `apps/api/src/services/agentService.ts`
- `apps/api/src/server.test.ts`
- `data/evaluation/agent-optimization-dataset.json`

问题发现：
- DeepSeek 路径已经支持 `add_activity`、`add_place_activity` 和 `complete_transport_legs`，但真实模型可能只调用新增地点工具，而漏掉用户同一句话里的“补全路线”要求。
- 结果是画布新增了 POI，也能解析坐标，但相邻 `transportLegs` 仍为空；顶部地图和路线编辑区会出现“有地点、无线段”的断裂状态。
- 这类问题不能完全交给提示词，因为上线场景里模型工具选择存在波动，服务端需要对用户明确意图做兜底。

优化具体实现：
- `runDeepSeek` 在解析工具调用后记录本轮是否新增结构化活动，包括普通 `add_activity` 和 POI 型 `add_place_activity`。
- 新增 `hasRouteCompletionIntent`，识别路线、交通、距离、耗时、相邻站点等目标词，以及补全、完成、计算、串联、connect、complete 等动作词。
- 当本轮新增活动、模型没有显式调用交通工具、用户又明确要求路线闭合时，服务端在地点解析后调用 `completeMissingTransportLegs`。
- 补路线交通方式优先读取用户话里的方式，例如 walking、driving、transit、cycling；未指定时默认步行。

优化后效果：
- 即使模型只返回新增活动工具调用，服务端也会在同一轮内解析地点并补齐相邻路线。
- 新增测试覆盖 “Please add Lingyin Temple to Day 1 afternoon and complete the route between adjacent stops.”，确认 Day 1 生成 2 段相邻路线、最后一段从原末站接到新 POI。
- diff 继续作为本轮助手回复末尾的结构化结果，显示“已补全交通路线：2 段”，人工手动编辑仍不会计入 Agent diff。

### 3.12 路线晚到后的多策略时间修复

相关文件：
- `apps/api/src/services/agentService.ts`
- `apps/api/src/server.test.ts`
- `packages/shared/src/fixtures.ts`
- `data/evaluation/agent-optimization-dataset.json`

问题发现：
- 已有路线时间冲突修复只支持“延后下一项”，适合用户明确接受后移后续安排的场景。
- 当用户说“缩短上一站停留”时，旧逻辑仍会顺延下一项，违背了用户想保留下一项时间的意图。
- 这会削弱 Agent 对画布的可控性：同样是路线晚到，用户需要能选择压缩上一站、延后下一项，后续还应扩展为改交通方式或整体顺延。

优化具体实现：
- `TimingAdjustmentToolRequest` 新增 `strategy`，当前支持 `delay_next`、`shorten_previous` 和 `shift_downstream`。
- `parseDeterministicTimingAdjustmentRequests` 在识别到晚到/来不及/时间冲突后，继续判断“缩短、压缩、少待、上一站、前一项、提前结束”等表达。
- `shorten_previous` 使用下一项开始时间减去交通耗时，计算上一站新的结束时间；如果结果早于上一站开始时间，则记录失败 trace，不强行写入无效时间。
- `shift_downstream` 识别“整体、全部、一起、后续、后面、接下来”等表达，从受影响的下一项开始，按晚到分钟数顺延当天后续所有已有时间的活动。
- 默认仍保持 `delay_next`，避免破坏“帮我延后下一项”这类已有能力。

优化后效果：
- 用户输入“西湖晨间散步到湖滨咖啡这段交通会晚到，帮我缩短上一站停留。”后，Agent 将西湖晨间散步结束时间从 `11:00` 改为 `10:45`，湖滨咖啡仍保持 `11:30-12:30`。
- 用户输入“帮我整体顺延后续安排”后，Agent 会把湖滨咖啡调整到 `11:45-12:45`，并把同一天后续活动同步顺延 15 分钟。
- 本轮 diff 输出“已缩短停留：西湖晨间散步 到 10:45”，不会新增活动，也不会把人工快捷修复计入 Agent diff。
- 评估数据集新增 `intent-route-conflict-shorten-previous` 和 `intent-route-conflict-shift-downstream`，与 `intent-route-conflict-delay-next` 共同覆盖路线冲突的三种用户指定修复策略。

### 3.13 路线晚到后的更快交通方式修复

相关文件：
- `apps/api/src/services/agentService.ts`
- `apps/api/src/server.test.ts`
- `packages/shared/src/fixtures.ts`
- `data/evaluation/agent-optimization-dataset.json`

问题发现：
- 用户遇到路线晚到时，不一定想改活动时间；也可能明确要求“换个更快的交通方式，不改活动时间”。
- 旧分流会把这类请求当成默认 `delay_next` 时间修复，直接顺延下一项活动，违背“不改活动时间”的约束。
- 普通交通比较要求用户显式列出“步行、公交、骑行”等候选方式，不能覆盖“帮我换个更快方式”这种更自然的表达。

优化具体实现：
- `parseDeterministicTransportComparisonRequests` 新增对独立“更快/更近”的识别，不再只依赖“比较/对比/选最快”。
- 当用户没有显式列出候选交通方式，但表达了更快路线诉求时，默认比较 `walking`、`transit`、`driving`、`cycling` 四类高德支持的路线方式。
- 该比较请求在时间修复前执行；如果更快路线消除晚到冲突，后续 `TimingAdjustmentTool` 会判断“无需顺延活动”，因此不会改活动时间。

优化后效果：
- 用户输入“西湖晨间散步到湖滨咖啡这段交通会晚到，帮我换个更快的交通方式，不改活动时间。”后，Agent 选择骑行路线，保留西湖晨间散步 `09:00-11:00` 和湖滨咖啡 `11:30-12:30`。
- diff 输出“已比较交通方式：步行、公交/地铁、驾车、骑行，已选择骑行”，不新增活动，也不输出“已顺延活动”。
- 评估数据集新增 `intent-route-conflict-faster-mode`，用于记录“路线冲突下优先改交通方式”的优化过程。

### 3.14 在线模型交通比较工具调用

相关文件：
- `apps/api/src/services/agentService.ts`
- `apps/api/src/server.test.ts`
- `packages/shared/src/fixtures.ts`
- `data/evaluation/agent-optimization-dataset.json`

问题发现：
- 确定性降级路径已经能比较多种交通方式并选择最快/最短路线，但 DeepSeek 在线路径只有 `set_transport_leg` 和 `complete_transport_legs`。
- 如果在线模型想满足“比较交通方式，选最快路线”，只能自己猜一个单一路线工具调用，或者输出文字说明，无法让后端用同一套高德/本地路线服务做可验证比较。
- 这会造成“开了真实模型反而能力更弱”的不一致，影响上线路径的可靠性。

优化具体实现：
- `deepSeekTools()` 新增 `compare_transport_modes` 工具，参数包含 `dayId`、`fromActivityId`、`toActivityId`、候选 `modes` 和 `strategy`。
- `runDeepSeek` 解析 `compare_transport_modes` 工具调用，转换为 `TransportComparisonToolRequest`。
- 执行阶段复用已有 `applyTransportComparisonTool`，逐一调用路线服务，按最快或最短选择结果并写回 `transportLegs`。
- 工具参数中候选方式不足两个时，服务端回退为 `walking/transit/driving/cycling` 四类方式，避免模型漏传导致工具失效。

优化后效果：
- DeepSeek 返回 `compare_transport_modes` 工具调用后，服务端会写入最快路线，例如 mock 路线中选择 `cycling`，耗时 `10` 分钟。
- diff 与确定性路径保持一致，输出“已比较交通方式：步行、公交/地铁、驾车、骑行，已选择骑行”。
- 评估数据集新增 `deepseek-transport-compare-tool`，用于证明在线模型工具编排具备交通比较能力，而不是只能写单一路线。

### 3.15 在线模型指定交通取消工具调用

相关文件：
- `apps/api/src/services/agentService.ts`
- `apps/api/src/server.test.ts`
- `packages/shared/src/fixtures.ts`
- `data/evaluation/agent-optimization-dataset.json`

问题发现：
- 确定性降级路径已经能处理“取消 A 到 B 这段交通，活动本身保留”，但 DeepSeek 在线路径没有 `remove_transport_leg` 工具。
- 在线模型即使理解了用户意图，也只能输出文字说明，或误用 `remove_activity` 删除某个活动，无法稳定表达“只删交通段、不删活动”。
- 这会破坏用户对画布的手动规划信任，尤其是用户明确要求保留活动时。

优化具体实现：
- `deepSeekTools()` 新增 `remove_transport_leg`，参数包含 `dayId`、`fromActivityId` 和 `toActivityId`。
- `runDeepSeek` 解析该工具调用为 `TransportRemovalToolRequest`。
- 执行阶段复用已有 `applyTransportRemovalTool` 和共享层 `removeTransportLeg`，只移除指定相邻活动对的 `transportLeg`，不生成活动删除 patch。

优化后效果：
- DeepSeek 返回 `remove_transport_leg` 后，服务端会清空对应路段，保留“西湖晨间散步”和“湖滨咖啡”两个活动。
- diff 输出“已取消交通：西湖晨间散步 到 湖滨咖啡”，且不包含“删除活动”或“已新增活动”。
- 评估数据集新增 `deepseek-transport-remove-tool`，用于证明在线模型具备指定交通段删除能力，并能避免把交通取消误处理成活动删除。

### 3.16 在线模型已有活动 POI 替换

相关文件：
- `apps/api/src/services/agentService.ts`
- `apps/api/src/server.test.ts`
- `packages/shared/src/fixtures.ts`
- `data/evaluation/agent-optimization-dataset.json`

问题发现：
- DeepSeek 在线路径虽然有通用 `update_activity`，但它只能表达字段更新，不能稳定触发高德 POI 搜索和坐标替换。
- 如果模型只把“湖滨咖啡”改成“灵隐寺”，画布文字会变，但地图仍可能保留旧地点坐标，导致行程和地图不一致。
- 用户明确说“活动本身保留”时，正确行为是保留活动槽位和 id，替换地点、类型、POI 和坐标，而不是新增一个活动。

优化具体实现：
- `deepSeekTools()` 新增 `update_activity_place`，参数包含 `activityId`、`query`、可选 `poiName`、`type` 和 `title`。
- `runDeepSeek` 解析该工具调用为 `PlaceUpdateToolRequest`。
- 执行阶段复用已有 `applyPlaceUpdateTool`，通过高德 POI 搜索选中候选，写入 `placeName`、`place` 坐标和活动类型。
- `toolAgent` 将 `place/poi` 工具归入 `AttractionAgent`，保证开发后台 trace 能体现地点子 Agent 的职责。

优化后效果：
- DeepSeek 返回 `update_activity_place` 后，服务端会把原“湖滨咖啡”活动替换为“灵隐寺飞来峰景区”正式 POI，并保留原活动 id。
- diff 输出“已更新地点：灵隐寺飞来峰景区”，且不包含“已新增活动”。
- 评估数据集新增 `deepseek-place-replace-tool`，用于证明在线模型的地点替换具备地图可用坐标，而不是只改文本。

### 3.17 在线模型路线晚到时间修复工具调用

相关文件：
- `apps/api/src/services/agentService.ts`
- `apps/api/src/server.test.ts`
- `packages/shared/src/fixtures.ts`
- `data/evaluation/agent-optimization-dataset.json`

问题发现：
- 确定性降级路径已经能在交通段晚到后执行顺延下一项、缩短上一站、整体顺延后续安排三种策略，但 DeepSeek 在线路径没有对应工具。
- 在线模型只能输出“会晚到”的文字说明，或直接猜测 `update_activity` 字段，无法复用服务端已有的路线冲突检测和时间计算。
- 真实模型路径和降级路径能力不一致，会让用户在开启在线模型后反而失去可靠的路线冲突修复。

优化具体实现：
- `deepSeekTools()` 新增 `adjust_timing_conflict`，参数包含 `dayId`、`fromActivityId`、`toActivityId` 和 `strategy`。
- `runDeepSeek` 解析该工具调用为 `TimingAdjustmentToolRequest`。
- 执行阶段在路线写入/补全之后复用 `applyTimingAdjustmentTool`，支持 `delay_next`、`shorten_previous` 和 `shift_downstream` 三种策略。
- `toolAgent` 将 `timing/conflict` 工具归入 `PlannerAgent`，保证 trace 中能看到主 Agent 派发给规划子 Agent 的过程。

优化后效果：
- DeepSeek 返回 `adjust_timing_conflict` 后，服务端会基于已有交通段检测冲突，并把“湖滨咖啡”从 `11:30` 顺延到 `11:45`。
- diff 输出“已顺延活动：湖滨咖啡 到 11:45”，且不包含“已新增活动”。
- 评估数据集新增 `deepseek-route-conflict-delay-next-tool`，用于证明在线模型具备路线晚到后的可验证时间修复能力。

### 3.18 确定性降级路径新增点名 POI

相关文件：
- `apps/api/src/services/agentService.ts`
- `apps/api/src/server.test.ts`
- `packages/shared/src/fixtures.ts`
- `data/evaluation/agent-optimization-dataset.json`

问题发现：
- DeepSeek 不可用或调用失败时，用户说“在 Day 1 下午添加灵隐寺景点”会进入确定性降级路径。
- 原实现只能识别“补一个活动”的泛化意图，容易新增“慢节奏街区探索”这类占位活动，而不是搜索用户点名的 POI。
- 结果是画布没有真实地点坐标，地图、路线补全和后续手动调整都无法形成闭环。

优化具体实现：
- 新增 `parseDeterministicPlaceActivityRequests`，识别“添加/加入/新增/安排 + 点名地点”的明确新增地点意图。
- 解析目标日期、时间段和活动类型；例如 `Day 1`、`15:00-17:00`、`景点`。
- 复用已有 `applyPlaceActivityTool` 调用高德/本地 POI 搜索，并写入 `placeName`、`place` 坐标、活动类型和 Agent diff。
- 点名地点新增会抑制原来的泛化补位，避免同一轮同时新增真实 POI 和“慢节奏街区探索”。

优化后效果：
- 确定性降级 Agent 收到“在 Day 1 下午 15:00-17:00 添加灵隐寺景点，并补全步行路线”后，会新增“灵隐寺”地点活动，并写入可用于地图的坐标。
- 同轮会继续补全 Day 1 相邻步行路线，diff 包含“已添加地点：灵隐寺”和“已补全交通路线：2 段”。
- 评估数据集新增 `intent-place-add`，用于证明降级路径能处理用户点名 POI 新增，而不是退化为泛化活动。

### 3.19 确定性降级路径中文月日解析

相关文件：
- `apps/api/src/services/agentService.ts`
- `apps/api/src/server.test.ts`
- `packages/shared/src/fixtures.ts`
- `data/evaluation/agent-optimization-dataset.json`

问题发现：
- 纯详情更新已经支持 `2026-07-05` 这类 ISO 日期，但普通用户更常说“7 月 5 日”。
- DeepSeek 在线路径可以把“7 月 5 日”转成工具参数，但模型不可用或失败时，确定性降级路径只会更新预算和备注，日期范围保持旧值。
- 这会让行程天数、每日日期、天气和导出日期都停留在旧范围，影响完整规划闭环。

优化具体实现：
- `parseDeterministicItineraryDetails` 接收当前行程上下文，使用行程开始日期年份作为默认年份。
- 新增 `parseDetailDate`，先识别 ISO 日期，再识别“YYYY 年 M 月 D 日”和“M 月 D 日”。
- 对月份和日期做基本范围校验，避免明显无效日期进入 `resizeItineraryDateRange`。

优化后效果：
- 用户输入“把返回日期改到 7 月 5 日，预算 2600，备注每天午后留出休息”时，确定性降级路径会把返回日期扩展为 `2026-07-05`。
- 结果行程扩展到 5 天，原有活动数量保持不变，diff 仍只包含日期范围、预算和备注更新。
- 评估数据集新增 `intent-natural-date-details`，用于证明降级路径可处理自然中文月日表达。

### 3.20 确定性降级路径旅行档案信息更新

相关文件：
- `apps/api/src/services/agentService.ts`
- `apps/api/src/server.test.ts`
- `packages/shared/src/fixtures.ts`
- `data/evaluation/agent-optimization-dataset.json`

问题发现：
- 行程服务已经支持更新 `destination`、`companions` 和 `preferences`，DeepSeek 在线工具也能表达这些字段。
- 但 DeepSeek 不可用时，确定性降级路径只解析日期、预算和备注，用户说“把目的地改成苏州，同行人改成家人和孩子，偏好改成园林、慢节奏、亲子”不会真正改变画布上下文。
- 后续天气、地点搜索、偏好摘要和 Skill 融合都会继续基于旧目的地/旧偏好，导致规划上下文错误。

优化具体实现：
- `parseDeterministicItineraryDetails` 新增明确字段解析：`目的地/城市`、`同行人/同行/同伴/出行人/旅伴`、`旅行偏好/偏好/喜好/风格`。
- 列表字段支持 `、`、`,`、`和`、`与`、`及` 等常见分隔方式，并通过 `unique` 去重。
- 保存行程后重新生成 `userPreferenceSummary`，避免本轮修改偏好后 Agent session 记忆仍停留在旧偏好。

优化后效果：
- 用户输入“把目的地改成苏州，同行人改成家人和孩子，偏好改成园林、慢节奏、亲子”时，确定性降级路径会更新目的地、同行人和偏好。
- 原有活动数量保持不变，diff 包含“已更新目的地”“已更新偏好”“已更新同行人”，不会新增泛化活动。
- 评估数据集新增 `intent-profile-details`，用于证明降级路径能够维护旅行规划上下文，而不依赖在线模型。

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
- 纯路线补全意图分流。
- 纯行程信息更新意图分流。
- 中文月日行程信息更新意图分流。
- 目的地、同行人和偏好信息更新意图分流。
- 已有活动字段更新意图分流。
- 已有活动地点替换和 POI 解析意图分流。
- 新增点名地点和 POI 解析意图分流。
- 指定路段交通方式更新意图分流。
- 多交通方式比较与最快/最短路线选择。
- 路线时间冲突后的更快交通方式选择。
- 在线模型交通比较工具调用。
- 在线模型已有活动 POI 替换工具调用。
- 在线模型指定交通段取消工具调用。
- 在线模型路线晚到时间修复工具调用。
- 路线时间冲突的只读多方案取舍，不在用户选择前修改画布。
- 指定交通段取消意图分流。
- 路线时间冲突后的下一项活动顺延。
- 路线时间冲突后的上一站停留压缩。
- 路线时间冲突后的当天后续安排整体顺延。
- 已有活动跨天移动意图分流。
- 已有活动删除意图分流。
- 在线模型新增地点后的路线闭合兜底。

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
- 高德 POI、天气，以及步行、驾车、骑行、公交/地铁路线在配置 Key 后走真实接口，失败时保留可解释 fallback。
- 评估数据集能够支撑优化前后对比。
- 确定性降级 Agent 已避免纯路线/纯详情请求夹带新增活动。
- 确定性降级 Agent 已支持活动字段更新、已有活动地点替换和 POI 解析、指定路段交通方式调整、多交通方式比较、指定交通段取消、路线时间冲突修复、已有活动跨天移动和已有活动删除。
- 确定性降级 Agent 已支持用户点名地点新增，能搜索 POI、写入地图坐标，并继续补全相邻路线。
- 确定性降级 Agent 已支持中文月日详情更新，可把“7 月 5 日”按当前行程年份解析为完整日期范围。
- 确定性降级 Agent 已支持目的地、同行人和偏好详情更新，并会在保存后刷新 session 偏好摘要。
- 当用户要求“先给方案/暂时不要改画布”时，确定性降级 Agent 会返回顺延下一项、缩短上一站和改用更快交通方式三类取舍说明，并保持画布与 diff 为空；用户明确选择后再执行对应工具。
- DeepSeek 在线路径在模型漏调交通工具但用户明确要求补路线时，会在新增地点后自动补齐相邻路线。
- Agent 流式运行的停止语义已打通到服务端，用户停止后不会隐藏落库。
- 评估后台已接入真实 `/api/agent/sessions`、`/api/agent/traces` 和 `/api/skills`，可展示最近 Agent 运行的上下文摘要、偏好摘要、导入风格、主 Agent 派发和各子 Agent 工具调用证据。

验证命令：

```bash
npm test
npm run typecheck
npm run build
```

浏览器验证路径：

```text
进入工作台 -> 添加活动 -> 导入慢节奏 Skill -> 发送 Agent 请求 -> 画布新增活动 -> 右侧对话末尾显示本轮 diff
进入评估后台 -> 查看最近 Agent 运行 -> 查看子 Agent 编排、trace 时间线、上下文摘要、偏好摘要和导入风格
```

## 7. 后续可优化方向

- 接入真实 OpenAI Agents SDK 在线调用，把当前确定性编排替换为真实模型决策。
- 为高德调用增加缓存、配额提示和更细的失败修复建议。
- 补充 Skill 脚本沙箱、超时控制、依赖隔离和日志查看。
- 扩展评估数据集规模，加入更多城市、同行人、预算和出行约束。
