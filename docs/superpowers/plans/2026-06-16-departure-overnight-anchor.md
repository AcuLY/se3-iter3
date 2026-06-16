# Departure Overnight Anchor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Replace the single main-destination workflow with a departure-point workflow and make each next day start from the previous day's editable overnight anchor.

**Architecture:** Keep the existing `destination` and `destinationPlace` storage fields as a compatibility layer, but change user-facing copy and search defaults so they behave as a departure point, not a region constraint. Add derived overnight start rows from each previous day's last lodging activity, so Day N+1 can route from the same place while the editable source remains Day N's final lodging activity.

**Tech Stack:** React 18, TypeScript, Vitest, Testing Library, Express route completion, existing `@journey/shared` itinerary helpers.

---

### Task 1: Departure Point Copy And Search Scope

**Files:**
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/App.test.tsx`

- [x] **Step 1: Write the failing tests**

Add frontend tests that create a new trip with a departure point label and assert map POI search sends `city=全国`.

- [x] **Step 2: Run the focused frontend tests to verify red**

Run: `npm run test -w @journey/app-web -- --runInBand apps/web/src/App.test.tsx`

Expected: tests fail because UI still says destination and map search still uses the itinerary destination as city.

- [x] **Step 3: Implement minimal UI and request changes**

Change create/edit labels and placeholders from main destination to departure point. Keep saved data compatible through `destination`, but make `PoiSearchField` support an explicit `searchCity` and pass `全国` for map/workbench activity searches unless the current activity already has a city.

- [x] **Step 4: Run focused frontend tests**

Run: `npm run test -w @journey/app-web -- --runInBand apps/web/src/App.test.tsx`

Expected: new tests pass and existing frontend tests remain green.

### Task 2: Overnight Anchor Derived Start Row

**Files:**
- Modify: `apps/web/src/App.tsx`
- Test: `apps/web/src/App.test.tsx`

- [x] **Step 1: Write the failing tests**

Add a frontend test with a two-day itinerary whose Day 1 final lodging is a hotel. Assert Day 2 shows a read-only starting row for that hotel, Day 2 route search includes hotel-to-first-activity, and editing is available only through the Day 1 hotel activity.

- [x] **Step 2: Run the focused frontend tests to verify red**

Run: `npm run test -w @journey/app-web -- --runInBand apps/web/src/App.test.tsx`

Expected: test fails because Day 2 has no derived overnight start row and routes only consider same-day activity pairs.

- [x] **Step 3: Implement derived overnight helpers**

Add helpers to find the previous day's last lodging activity, build visible route pairs, and count/get route legs using the derived anchor for the next day without duplicating an editable activity.

- [x] **Step 4: Wire helpers into auto-route, map summaries, and timeline display**

Use the helper in route auto-completion and local fallback. Render a read-only Day start row before the first real Day activity when an overnight anchor exists.

- [x] **Step 5: Run focused frontend tests**

Run: `npm run test -w @journey/app-web -- --runInBand apps/web/src/App.test.tsx`

Expected: overnight anchor behavior passes.

### Task 3: Server Route Completion Parity

**Files:**
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/src/server.test.ts`

- [x] **Step 1: Write the failing API test**

Add an API test where Day 1 ends at a lodging activity and Day 2 starts with an attraction. Calling complete transport legs should create Day 2's hotel-to-attraction route, not a Day 1-to-Day 2 direct cross-day route.

- [x] **Step 2: Run focused API tests to verify red**

Run: `npm run test -w @journey/app-api -- apps/api/src/server.test.ts`

Expected: test fails because server route completion only scans same-day adjacent pairs.

- [x] **Step 3: Implement server overnight pair completion**

In `/api/itineraries/:id/transport-legs/complete`, prepend the previous day's last lodging as the route origin for a day's first activity, storing the resulting leg on the destination day.

- [x] **Step 4: Run focused API tests**

Run: `npm run test -w @journey/app-api -- apps/api/src/server.test.ts`

Expected: API route completion tests pass.

### Task 4: Final Verification

**Files:**
- Modify: `docs/planning/decision-record.md`

- [x] **Step 1: Update decision record**

Add a concise 2026-06-16 note describing departure-point semantics and overnight anchor synchronization.

- [x] **Step 2: Run final checks**

Run: `npm run test -w @journey/app-web`, `npm run test -w @journey/app-api`, and `npm run typecheck`.

Expected: all checks pass.
