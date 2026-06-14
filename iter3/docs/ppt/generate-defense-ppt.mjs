import { mkdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const artifactToolPath =
  process.env.ARTIFACT_TOOL_MJS ??
  "file:///C:/Users/26552/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/@oai/artifact-tool/dist/artifact_tool.mjs";

const { Presentation, PresentationFile } = await import(artifactToolPath);

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const outputPath = `${root}/docs/ppt/journey-skill-agent-defense.pptx`;

const deck = Presentation.create();

const colors = {
  red: "#E60023",
  ink: "#211922",
  muted: "#5F5A5F",
  paper: "#FBFBF9",
  card: "#FFFFFF",
  soft: "#F3F1ED",
  line: "#D8D4CC",
  green: "#CDEFD8",
  sand: "#F4E7CE"
};

const slides = [
  {
    kicker: "TITLE",
    title: "Journey Skill Agent",
    subtitle: "旅行风格 Skill 分享平台与多 Agent 行程规划工作台",
    bullets: ["迭代三完整产物", "TypeScript 全栈", "结构化行程画布 + Agent 协作"]
  },
  {
    kicker: "REQUIREMENTS",
    title: "从 Agent Demo 到可运行产品",
    subtitle: "对齐任务 PDF 的代码、文档、优化和答辩要求",
    bullets: ["完整可运行代码", "需求分析、详细设计、会议记录", "Agent 优化过程与评估数据集", "答辩 PPT 与演示路径"]
  },
  {
    kicker: "PROBLEM",
    title: "旅行规划不是一段 Markdown",
    subtitle: "它包含日期、地点、路线、预算、交通和风格约束",
    bullets: ["用户需要继续手动调整", "Agent 结果需要落到可编辑画布", "风格偏好需要沉淀、分享和复用"]
  },
  {
    kicker: "LOOP",
    title: "产品闭环围绕 Skill 沉淀",
    subtitle: "规划 -> 提取 -> 发布 -> 导入 -> 再规划",
    bullets: ["用户创建或修改行程", "系统从行程/对话/游记提取 Skill 草稿", "用户确认后发布到 Skill 广场", "其他用户导入后生成个性化行程"]
  },
  {
    kicker: "WORKBENCH",
    title: "核心界面是行程工作台",
    subtitle: "三栏布局：导航、画布、Agent 协作",
    bullets: ["左侧：功能入口和会话记录", "中间：地图、日期导航、活动编辑器", "右侧：Agent 对话和 Skill 导入", "普通用户默认不暴露复杂 trace"]
  },
  {
    kicker: "ARCHITECTURE",
    title: "TypeScript 全栈 monorepo",
    subtitle: "共享领域模型让前后端一致处理行程和 Skill",
    bullets: ["packages/shared：类型、行程、Skill、评估", "apps/api：Express + SQLite + Agent/Map 服务", "apps/web：React + Vite + Tailwind + shadcn 风格组件", "外部 API 有 mock fallback，保证答辩稳定"]
  },
  {
    kicker: "AGENTS",
    title: "主 Agent 调度子 Agent",
    subtitle: "按天气、交通、景点、风格和规划隔离上下文",
    bullets: ["MainAgent：理解目标并调度", "StyleAgent：融合 Skill", "Weather/Transport/Attraction：工具型子 Agent", "PlannerAgent：生成结构化 patch", "CriticAgent：检查需求和手动保护"]
  },
  {
    kicker: "SKILL",
    title: "Skill 使用标准 SKILL.md",
    subtitle: "遵循 skill-creator 格式，支持导入和提取",
    bullets: ["frontmatter 至少包含 name 和 description", "支持 references、assets、scripts 扩展", "提取结果默认 draft，必须用户确认", "Skill 广场支持推荐、收藏、导入和发布"]
  },
  {
    kicker: "OPTIMIZATION",
    title: "关键优化：从回答文本到协作产物",
    subtitle: "Agent 输出必须能被用户继续编辑和验证",
    bullets: ["结构化 patch 直接更新画布", "diffItineraries 生成回复末尾改动清单", "lockedByUser 防止覆盖手动成果", "trace 记录子 Agent 和工具调用", "工具失败降级为可解释 fallback"]
  },
  {
    kicker: "EVALUATION",
    title: "评估数据集覆盖 7 类场景",
    subtitle: "Bad Case 与优化后结果可以量化对比",
    bullets: ["普通行程生成", "Skill 融合", "系统行程/外部游记提取 Skill", "手动修改后重规划", "Skill 脚本成功与失败 fallback"]
  },
  {
    kicker: "VERIFICATION",
    title: "代码可运行、可测试、可复现",
    subtitle: "自动化测试覆盖共享层、API 和前端核心路径",
    bullets: ["npm test：18 个测试", "npm run typecheck：类型检查", "npm run build：生产构建", "浏览器验证：进入工作台 -> 添加活动 -> 导入 Skill -> Agent 更新 -> 右侧回复末尾 diff"]
  },
  {
    kicker: "SUMMARY",
    title: "Agent 产品化闭环落地",
    subtitle: "用户可手动规划，也可让 Agent 在画布上协作",
    bullets: ["手动规划能力完整可用", "Agent 能将 Skill 与真实需求融合", "Skill 可沉淀、分享、导入和复用", "优化过程有数据集、指标和 trace 支撑"]
  }
];

slides.forEach((slideData, index) => {
  const slide = deck.slides.add();
  addBackground(slide, index);
  addKicker(slide, slideData.kicker, index);
  addText(slide, slideData.title, 60, 58, 610, 56, colors.paper, colors.paper);
  addText(slide, slideData.subtitle, 62, 124, 620, 38, colors.paper, colors.paper);
  addAccentPanel(slide, index);
  addBullets(slide, slideData.bullets, 74, 194);
  addFooter(slide, index + 1);
});

mkdirSync(dirname(outputPath), { recursive: true });
const exported = await PresentationFile.exportPptx(deck);
await writeFile(outputPath, exported.data);
console.log(outputPath);

function addBackground(slide, index) {
  const bg = slide.shapes.add({ geometry: "rect" });
  bg.position.set({ left: 0, top: 0, width: 960, height: 540 });
  bg.fill.color = colors.paper;
  bg.line.color = colors.paper;

  const ribbon = slide.shapes.add({ geometry: "rect" });
  ribbon.position.set({ left: 0, top: 0, width: 18, height: 540 });
  ribbon.fill.color = index % 3 === 0 ? colors.red : index % 3 === 1 ? colors.green : colors.sand;
  ribbon.line.color = ribbon.fill.color;
}

function addKicker(slide, kicker, index) {
  const marker = slide.shapes.add({ geometry: "rect" });
  marker.position.set({ left: 60, top: 34, width: 52, height: 7 });
  marker.fill.color = index % 2 === 0 ? colors.red : colors.ink;
  marker.line.color = marker.fill.color;
  addText(slide, kicker, 124, 24, 180, 24, colors.paper, colors.paper);
}

function addAccentPanel(slide, index) {
  const panel = slide.shapes.add({ geometry: "roundRect" });
  panel.position.set({ left: 708, top: 62, width: 178, height: 178 });
  panel.fill.color = index % 2 === 0 ? colors.red : colors.green;
  panel.line.color = panel.fill.color;
  panel.text.set(index === 0 ? "Skill\nAgent" : `0${(index % 9) + 1}`);

  const label = slide.shapes.add({ geometry: "roundRect" });
  label.position.set({ left: 722, top: 266, width: 166, height: 40 });
  label.fill.color = colors.card;
  label.line.color = colors.line;
  label.text.set("结构化行程画布");
}

function addBullets(slide, bullets, x, y) {
  bullets.forEach((bullet, i) => {
    const dot = slide.shapes.add({ geometry: "ellipse" });
    dot.position.set({ left: x, top: y + i * 55 + 9, width: 10, height: 10 });
    dot.fill.color = colors.red;
    dot.line.color = colors.red;
    addText(slide, bullet, x + 26, y + i * 55, 570, 36, colors.card, colors.line);
  });
}

function addFooter(slide, page) {
  const line = slide.shapes.add({ geometry: "rect" });
  line.position.set({ left: 60, top: 494, width: 840, height: 1 });
  line.fill.color = colors.line;
  line.line.color = colors.line;
  addText(slide, `Journey Skill Agent / Iteration 3 / ${page}/${slides.length}`, 60, 505, 420, 18, colors.paper, colors.paper);
}

function addText(slide, text, left, top, width, height, fill, line) {
  const shape = slide.shapes.add({ geometry: "roundRect" });
  shape.position.set({ left, top, width, height });
  shape.fill.color = fill;
  shape.line.color = line;
  shape.text.set(text);
  return shape;
}
