# Skill Creator Agent Redesign

Date: 2026-06-16

## Brief

Redesign the Skill creation module from a form-like page into an Agent-led creation flow.
The user provides initial material, then answers a sequence of Agent-generated questions.
The Agent decides what to ask, whether each question is single-select or multi-select, how much progress has been made, and when the Skill is ready for final review.

This flow must not directly reuse the system `skill-creator` instructions. Instead, the project needs its own Creator Agent system prompt, written in a similar style: role, principles, process, output contract, stopping rules, and validation expectations.

## Product Positioning

In this project, a Skill is a reusable travel style package. It can be extracted from an itinerary, travel note, guide, or free-form preference, then published to the Skill Plaza and imported into future itinerary planning sessions.

The Creator Agent should understand that the final product must be useful to the itinerary planning Agent. It should produce and refine the project-level `TravelSkill` shape:

- `name`
- `displayName`
- `description`
- `body`
- `tags`
- `rules`
- `forbidden`
- final `SKILL.md` generated from those fields

The ordinary creation flow should not expose `Skill.md`, frontmatter, or field editing until the final review step. At final review, these technical details are available in a collapsed advanced section.

## User Experience

The creator screen is centered on one current question. It is not a long vertical page, not a multi-step progress list, and not a small chat window inside a larger form.

The default screen contains only:

- a short Agent label
- an Agent-generated progress percentage
- the current question
- answer options
- an optional custom input
- a submit button

The screen does not show an assistant judgment sidebar, internal prompt notes, question numbers, raw draft fields, frontmatter, or `SKILL.md`.

Progress is not a linear step counter. It is the Agent's estimate of how ready the Skill is for final review. The value may move forward or backward when later answers reveal ambiguity or contradictions.

## Question Model

Each Agent question is rendered as a choice card:

- `question`: user-facing text
- `mode`: `single` or `multiple`
- `options`: 3 to 5 choices
- `customInput`: always enabled
- `progressPercent`: integer from 0 to 100

Question wording must be domain-native. The Agent must not ask meta questions such as "When should this Skill be triggered?" because the user is already creating and using a Skill. Instead, it should translate internal needs into natural travel-style questions.

Examples:

- "这套旅行风格换到新城市时，哪些体验必须保留？"
- "如果目的地没有海边，优先用什么体验替代？"
- "生成行程时，哪些安排一出现就算跑偏？"
- "这套风格更适合短周末、三日游，还是更长时间？"

## Creator Agent System Prompt

The backend will define a dedicated Creator Agent system prompt for this project.
It should borrow the writing style of `skill-creator`: concise instructions, explicit degrees of freedom, clear stopping rules, and structured output.
It must not copy the original prompt or rely on the original skill at runtime.

The prompt should instruct the Agent to:

- act as a travel style Skill creation assistant
- infer the style domain from the user's initial material
- ask one question at a time
- prefer single-select or multi-select choices over open-ended text
- always allow custom input
- use natural product language instead of frontmatter, field, internal trigger conditions, or Skill-internal terms
- update a hidden `TravelSkill` draft after every answer
- decide when there is enough information for final review
- return structured JSON only

The prompt should also define the final Skill quality target:

- clear human-readable display name
- concise description useful for recommendation and plaza browsing
- tags that match the travel style
- planning rules that can influence itinerary generation
- forbidden patterns that prevent obvious bad outputs
- body text that explains the reusable travel style without unnecessary verbosity
- valid `SKILL.md` generated from the draft

## Agent Output Contract

Each Creator Agent turn returns one JSON object:

```json
{
  "assistantMessage": "短说明，可为空",
  "question": "这套旅行风格换到新城市时，哪些体验必须保留？",
  "mode": "multiple",
  "options": [
    { "id": "sunset", "label": "傍晚留给散步、看日落或临水发呆" },
    { "id": "small-shops", "label": "优先找小店、街区和能慢慢逛的地方" }
  ],
  "customPlaceholder": "也可以写自己的答案",
  "progressPercent": 52,
  "draftPatch": {
    "tags": ["松弛", "小店", "日落"],
    "rules": ["傍晚时段优先保留低强度体验"],
    "forbidden": []
  },
  "done": false
}
```

When `done` is true, the response returns no next question and includes enough draft data for final review and `SKILL.md` generation.

The frontend must treat malformed JSON, missing options, or invalid mode as recoverable Agent errors. It should show a concise retry state instead of silently falling back to fake deterministic questions.

## Data Flow

1. User opens the creator and provides initial material.
2. Frontend starts a creator session through the API.
3. Backend sends the project-specific Creator Agent system prompt, initial material, current draft, and conversation history to the LLM.
4. LLM returns structured JSON for the next question and draft patch.
5. Backend validates the JSON, normalizes the draft patch, persists the draft session, and returns render-ready data.
6. User selects one or more options and may add custom input.
7. Backend sends the answer and session state back to the LLM.
8. Steps 4-7 repeat until `done` is true.
9. Final review shows a human-readable summary first. `Skill.md`, frontmatter, and direct field editing are collapsed under advanced review.
10. User confirms publication or continues asking the Agent to revise.

## Error Handling

If the LLM call fails, the UI should preserve the current answer and offer retry.

If the LLM returns invalid structured output, the backend should request one repair attempt from the model using the same system prompt and a small repair instruction. If repair still fails, return an error state with no fake progress.

If the Agent marks `done` too early but required draft fields are missing, backend validation should block final review and ask the Agent for the next best question.

If later answers contradict earlier ones, the Agent may reduce `progressPercent` and ask a clarifying question.

## Testing

Backend tests should cover:

- creator session start calls the LLM with the project-specific system prompt
- valid Agent JSON is parsed and persisted
- invalid Agent JSON triggers repair or error
- draft patches update only allowed `TravelSkill` fields
- `done` is blocked when required final fields are missing
- progress can move backward

Frontend tests should cover:

- creator page shows only the current question during the interview
- no question number, sidebar status panel, frontmatter, field editor, or `SKILL.md` appears during the interview
- single-select and multi-select questions render correctly
- custom input is available for every question
- final review keeps `Skill.md`, frontmatter, and field editing collapsed by default

Browser QA should verify the creator flow in the in-app browser at `/creator` after implementation.

## Non-Goals

- Do not build a generic Skill authoring IDE.
- Do not show raw `Skill.md` throughout the creation flow.
- Do not expose internal Creator Agent prompt language to users.
- Do not use deterministic local string updates as the main conversation engine.
- Do not redesign Skill Plaza or the itinerary planning canvas as part of this work.
