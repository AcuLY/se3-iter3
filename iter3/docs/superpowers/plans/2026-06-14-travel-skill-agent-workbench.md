# Travel Skill Agent Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable TypeScript full-stack iteration-3 product for a travel style Skill sharing platform and multi-Agent itinerary planning workbench.

**Architecture:** Use an npm workspace under `iter3/` with a shared package, an Express API, and a React/Vite web app. The backend owns persistence, Skill package parsing, Agent orchestration, Amap-compatible service wrappers, trace logging, and evaluation data; the frontend owns a Pinterest-inspired landing page plus the three-column itinerary editor, Skill Plaza, Skill creator, and evaluation backend views.

**Tech Stack:** TypeScript, React, Vite, Tailwind CSS, shadcn-style local UI primitives, Express, Node `node:sqlite`, Zod, Vitest, React Testing Library, lucide-react.

---

## File Structure

- `package.json`: root workspace scripts for install, test, typecheck, and dev.
- `tsconfig.base.json`: shared TypeScript compiler options.
- `packages/shared/src/types.ts`: canonical itinerary, Skill, Agent trace, map, and evaluation schemas.
- `packages/shared/src/fixtures.ts`: deterministic seed data for offline demos and tests.
- `packages/shared/src/itinerary.ts`: pure itinerary editing helpers and diff logic.
- `packages/shared/src/skill.ts`: skill package parsing and recommendation helpers.
- `packages/shared/src/evaluation.ts`: scoring helpers for optimization evidence.
- `apps/api/src/db.ts`: SQLite schema, seed, and typed persistence helpers.
- `apps/api/src/services/*.ts`: Agent orchestration, Skill, Amap, evaluation, and itinerary services.
- `apps/api/src/routes/*.ts`: REST endpoints consumed by the frontend.
- `apps/api/src/server.ts`: Express app factory and dev server entry.
- `apps/web/src/components/ui/*.tsx`: shadcn-style reusable UI primitives.
- `apps/web/src/components/layout/*.tsx`: app shell, sidebar, and right Agent panel.
- `apps/web/src/features/*`: itinerary workbench, Skill Plaza, Skill creator, home, and evaluation UI.
- `apps/web/src/api/client.ts`: typed frontend API client with offline fallback.
- `apps/web/src/App.tsx`: route state and page composition.
- `docs/*.md`, `data/evaluation/*.json`, `docs/ppt/defense-outline.md`: non-code deliverables updated after the runnable product exists.

## Tasks

### Task 1: Workspace, Shared Domain, and Tests

- [ ] Create npm workspace manifests and TypeScript configs.
- [ ] Write Vitest tests for itinerary editing, diff generation, Skill parsing, Skill recommendation, and evaluation scoring.
- [ ] Implement shared Zod schemas and pure helpers until tests pass.

### Task 2: API Persistence and Services

- [ ] Create SQLite schema using `node:sqlite` with seeded itineraries, Skills, sessions, traces, and evaluation cases.
- [ ] Write API service tests for creating/editing itineraries, importing/publishing Skills, extracting Skills, Agent updates, and evaluation summaries.
- [ ] Implement Express routes with deterministic offline behavior and optional environment hooks for OpenAI/Amap.

### Task 3: Frontend Workbench

- [ ] Build the Pinterest-inspired landing page and app shell.
- [ ] Implement manual itinerary planning: create trip, add/rename/delete days, add/edit/delete/reorder/move activities, edit typed fields, and save drafts.
- [ ] Implement map display placeholder with Amap data bindings and backend-driven route/weather summaries.
- [ ] Implement right Agent chat panel that can import Skills, request generation/rewrite/check, update the itinerary canvas, show live diff, and support undo.

### Task 4: Skill Plaza and Skill Creator

- [ ] Implement Skill Plaza browse/detail/import/favorite/publish/unpublish/edit/delete/recommendation flow.
- [ ] Implement Skill creator using standard `SKILL.md` frontmatter/body fields plus optional script/reference metadata.
- [ ] Implement extraction flow from current itinerary/dialogue or pasted travel notes, requiring user edit/confirmation before publishing.

### Task 5: Evaluation and Optimization Evidence

- [ ] Add evaluation dataset covering normal planning, Skill fusion, Skill extraction, manual edit protection, and Skill script fallback.
- [ ] Build evaluation backend page for task cases, metrics, before/after comparison, and trace inspection.
- [ ] Ensure generated traces include main Agent and sub-Agent tool calls without overexposing them in the core user UI.

### Task 6: Verification and Deliverables

- [ ] Run `npm install`, `npm test`, `npm run typecheck`, and production build scripts.
- [ ] Start the dev server and verify the core workflow in browser.
- [ ] Update requirements, detailed design, meeting records, Agent optimization document, evaluation dataset, and PPT outline after code behavior is stable.
