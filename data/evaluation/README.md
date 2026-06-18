# Agent 优化评估数据集说明

数据集文件：`agent-optimization-dataset.json`
用途：归档迭代三 Agent 优化过程中使用的问题样例、优化前表现和优化后预期。

## 1. 数据集定位

该数据集用于支撑 `docs/agent-optimization.md` 中的优化复盘。它不是运行时 API 数据表，也不依赖后端评估服务。

数据集关注的问题是：Agent 是否能把用户的自然语言请求正确落到旅行规划工作台中的结构化对象上，包括行程信息、活动、地点、路线、时间冲突、Skill 和跨轮上下文。

## 2. 覆盖范围

当前文件共 29 条用例，类别分布如下：

| 类别 | 数量 | 说明 |
| --- | ---: | --- |
| `normal_planning` | 1 | 普通行程生成 |
| `skill_fusion` | 1 | 导入旅行风格 Skill 后的融合规划 |
| `manual_replan` | 1 | 用户手动编辑后的重规划保护 |
| `skill_extraction_internal` | 1 | 从系统内行程提取 Skill |
| `skill_extraction_external` | 1 | 从外部游记提取 Skill |
| `skill_script_success` | 1 | Skill 脚本成功执行 |
| `skill_script_failure` | 1 | Skill 脚本失败时的可解释处理 |
| `intent_routing` | 21 | 活动、地点、路线、时间冲突和行程详情等意图分流 |
| `tool_orchestration` | 1 | 在线模型工具编排和服务端兜底 |

## 3. 关键用例索引

- `normal-hangzhou`：普通杭州行程规划。
- `skill-fusion-citywalk`：慢节奏 citywalk 风格融合。
- `manual-replan-protection`：保护用户手动编辑后的重规划。
- `extract-internal-skill`：从当前系统行程沉淀旅行风格。
- `extract-external-skill`：从外部攻略文本提取旅行风格。
- `skill-script-success`：Skill 脚本成功返回可用建议。
- `skill-script-fallback`：Skill 脚本失败后的可解释处理。
- `intent-route-only`：纯路线请求不新增活动。
- `intent-details-only`：纯行程详情更新不新增活动。
- `intent-natural-date-details`：中文月日表达更新日期范围。
- `intent-profile-details`：更新目的地、同行人和偏好。
- `intent-activity-update`：更新已有活动字段。
- `intent-place-replace`：替换已有活动地点并写入 POI。
- `intent-place-add`：新增用户点名地点并补全路线。
- `intent-specific-transport-mode`：更新指定路段交通方式。
- `intent-transport-compare-fastest`：比较多种交通方式并选最快。
- `intent-route-conflict-faster-mode`：路线晚到时改用更快交通方式。
- `intent-transport-remove`：取消指定交通段但保留活动。
- `intent-route-conflict-delay-next`：路线晚到后顺延下一项。
- `intent-route-conflict-shorten-previous`：路线晚到后缩短上一站停留。
- `intent-route-conflict-shift-downstream`：路线晚到后整体顺延后续安排。
- `intent-route-conflict-options`：只返回调整方案，不修改画布。
- `intent-activity-move`：移动已有活动到指定日期和位置。
- `intent-activity-remove`：删除已有活动且不新增替代活动。
- `deepseek-add-place-route-closure`：在线模型新增地点后补齐相邻路线。
- `deepseek-transport-compare-tool`：在线模型调用交通比较工具。
- `deepseek-place-replace-tool`：在线模型调用地点替换工具。
- `deepseek-transport-remove-tool`：在线模型调用交通取消工具。
- `deepseek-route-conflict-delay-next-tool`：在线模型调用路线晚到时间修复工具。

## 4. 字段说明

每条用例是一个 JSON 对象，顶层字段保持一致：

- `id`：稳定用例编号，用于文档和测试引用。
- `title`：用例标题。
- `category`：用例类别。
- `input`：用户输入或任务描述。
- `expected`：优化后应满足的约束，包括关键词、风格词、最小天数、需保留活动和所需工具名。
- `badCaseOutput`：优化前输出，用于记录问题表现。
- `optimizedOutput`：优化后输出，用于记录目标效果。

`badCaseOutput` 和 `optimizedOutput` 使用相同结构，便于对比：

- `itineraryText`：行程文本或 Agent 回复摘要。
- `days`：输出行程天数。
- `preservedActivityIds`：被保留的活动编号。
- `toolCalls`：本轮涉及的工具调用名。
- `scriptErrors`：脚本或工具错误记录。

后续新增用例时应保持顶层字段一致，并保持 `id` 稳定，避免已写入文档或测试的引用失效。

## 5. 使用方式

推荐使用方式：

1. 先根据 `category` 选择要验证的优化方向。
2. 阅读 `before`，确认该用例记录的问题是什么。
3. 使用 `input` 在当前工作台或 API 层复现。
4. 对照 `expected` 判断 Agent 是否只修改了目标对象，并检查 `optimizedOutput` 中的工具、天数和保留活动是否符合预期。
5. 将新增 bad case 追加到 JSON，并在 `docs/agent-optimization.md` 中补充优化说明。

JSON 格式校验命令：

```bash
python3 -m json.tool data/evaluation/agent-optimization-dataset.json
```

## 6. 维护约定

- 数据集只保存评估样例，不保存真实用户隐私数据。
- 新增用例优先使用可复现的行程、活动名、地点名和明确预期。
- 每个新增用例都应能对应到一个问题发现或优化实现。
- 不把数据集描述为线上评估接口；它是优化过程归档和复盘材料。
