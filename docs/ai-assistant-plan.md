# AI Assistant Integration Plan

This document captures a comprehensive plan for adding an AI assistant to the PlayCanvas Editor so it can reason over, and (with user approval) modify, assets, scenes, scripts, and related project settings while relying solely on the OpenAI Responses API.

## 1. Current Editor Architecture (what matters for the assistant)

- **Editor bootstrapping** – the main editor instance wires up the `editor.api` globals for history, selection, realtime, messenger, assets, entities, jobs, etc., and exposes helper methods for status/pickers (`src/editor/editor.ts:63-124`). All assistant tooling must reuse these globals so operations flow through the same undo/redo/history channels.
- **Layout & UI primitives** – `pcui` panels compose the hierarchy, viewport, inspector, asset panel, etc. (`src/editor/layout/layout.ts:7-200`). Existing floating widgets such as chat (`src/editor/chat/chat-widget.ts:5-100`) show how to add collapsible panels that respect permissions and viewport state. The assistant should live in a similar panel so it inherits resizing, theming, and storage behaviors.
- **Assets pipeline** – assets are observable via `editor.api.globals.assets` and re-broadcast through helper methods (`src/editor/assets/assets.ts:17-115`). Asset manipulation (create, move, upload, parse scripts) already happens through methods under `src/editor/assets`. The assistant can call the same methods to stay compatible with asset history, watchers, and uploads.
- **Entities & scenes** – entities mirror assets via `editor.api.globals.entities` (`src/editor/entities/entities.ts:3-52`). Scene CRUD flows through REST helpers (`src/editor/scenes/scenes.ts:1-72`) and live edits go through ShareDB operations submitted via `editor.call('realtime:scene:op', …)` (`src/editor/realtime/realtime.ts:1-124`). Any AI-generated scene change must translate to the same op structure to reach all collaborators.
- **Script/code editing** – the code editor is a separate entry point but still boots from `Editor` with realtime document loading/persistence (`src/code-editor/documents/documents-load.ts:49-176`). Assets representing scripts are opened as ShareDB docs; assistants editing code need to reuse this loader so Monaco stays in sync and linting, dirty flags, and dependency preloads keep working.
- **Selections, permissions & settings** – selectors mirror the API selection globals and broadcast entity/asset selections (`src/editor/selector/selector.ts:4-180`). Permissions are cached locally and updated via messenger (`src/editor/permissions/permissions.ts:1-110`). Project/user settings sync through `ObserverSync` and ShareDB (`src/editor/settings/settings.ts:5-145`). The assistant must respect permissions (read/write/admin) and update selection/history when acting.
- **Workers & persistence** – background work commonly runs in Workers (e.g., console history stores logs with Dexie and streams progress back, `src/workers/console.worker.ts:1-170`). Long-running assistant tasks (summaries, texture conversions) should follow this pattern to avoid blocking the UI and to reuse the existing status/progress UX.

## 2. Target Goals & Guardrails

1. **Conversational guidance** – users describe desired changes, get contextual answers, and receive previews before applying edits.
2. **Actionable tooling** – assistant can create/update assets, spawn or edit entities/components, and edit scripts/materials directly in the editor.
3. **User control** – every mutation requires explicit approval, integrates with existing history/undo, and is gated by `permissions:write`.
4. **Single LLM backend** – all reasoning uses the OpenAI Responses API (`POST /v1/responses`) with structured tool calls; no other LLM vendors.
5. **Auditability** – conversations, prompts, tool outputs, and applied changes are logged (locally at minimum) so users can review what happened.

## 3. User Journeys

- **Scene editing** – “Add a spinning fan above the generator” ⇒ assistant inspects the entity hierarchy, drafts entity/component ops, shows a diff summary, and applies via realtime ops.
- **Asset authoring** – “Generate a new material with emissive stripes and apply it to the ceiling” ⇒ assistant creates a material asset, tweaks JSON parameters, and rebinds selected entities.
- **Code changes** – “Update `GameController.mjs` to award double XP on Nightmare difficulty” ⇒ assistant pulls the ShareDB doc, edits via Monaco APIs, runs lint/tests if available, and opens a diff preview.
- **Project knowledge** – “Why is my lightmapper disabled?” ⇒ assistant reads project settings/console logs and replies with direct steps, optionally toggling settings if permitted.

## 4. Proposed Architecture

### 4.1 Client surfaces

1. **Editor panel** – a new `Panel` anchored near the chat widget, offering chat, task queue, and change previews. This panel should be toggleable via toolbar button + hotkey and respect layout persistence just like `layout.assets`.
2. **Contextual entry points** – right-click menus in the hierarchy/assets/code tabs get an “Ask AI” action that seeds the assistant with the relevant selection (using `editor.call('selector:set', …)` from `src/editor/selector/selector.ts:145-179`).
3. **Code editor integration** – add a Monaco action + side drawer in the code editor entry point so script authors can stay inside their workflow (`src/code-editor/editor.ts` shares the same global patterns).

### 4.2 Assistant runtime service

1. **Frontend client** – encapsulate all OpenAI requests in `src/common/ai/assistant-client.ts` (new) that streams responses via `fetch` + ReadableStream. It should support SSE-style incremental tokens so the UI can render partial replies.
2. **Backend proxy** – for API key safety, introduce a new editor backend endpoint (outside this repo) or reuse an existing proxy to call OpenAI. The frontend sends conversation state + requested tools, the proxy populates `Authorization: Bearer` and `OpenAI-Beta: responses-staging` headers before forwarding to `/v1/responses`.
3. **Protocol** – use the Responses API’s tool-calling format. Define a JSON schema for each editor tool (e.g., `{"type":"function","function":{"name":"apply_entity_ops","parameters":{…}}}`). Responses come back as either text chunks or tool calls that the client enqueues.

### 4.3 Context builders

Create composable providers that snapshot the editor state before each call:

- **Project metadata** – id, branch, engine version (`config` + `ENGINE_VERSION`), write permissions (`src/editor/permissions/permissions.ts:1-110`).
- **Selection** – entity tree paths, component summaries, asset metadata via `editor.call('selector:history')` and `assets:get`/`entities:get`.
- **Scene state** – bag of observable state from `editor.api.globals.entities` plus relevant component data (limited to keep prompts small).
- **Code context** – current document text via `editor.call('documents:isDirty')` / `editor.call('monaco:getModelValue')`.
- **Console + settings** – sample recent log lines (borrowing from the Dexie worker pattern) and project/scene settings via `settings:create` observers (`src/editor/settings/settings.ts:18-109`).

These providers feed a lightweight “context broker” so prompts stay deterministic and we can prune/weight sections based on user queries.

### 4.4 Tooling & execution layer

Define a catalogue of assistant tools. Each tool has:

1. **Schema** – name, description, parameters, permission requirements.
2. **Dry-run function** – validates inputs against current state (e.g., confirm entity ids exist) and emits a structured preview for the UI.
3. **Executor** – performs the actual change using existing editor APIs:
   - Assets: call methods from `src/editor/assets` (upload, reimport, rename), or use `editor.api.globals.assets.update` pathways.
   - Scene ops: build ShareDB ops against `realtime.scenes.current` (`src/editor/realtime/realtime.ts:80-124`) to edit components safely.
   - Scripts: open docs via `load:asset` and push edits through ShareDB operations so Monaco stays updated (`src/code-editor/documents/documents-load.ts:49-176`).
4. **History integration** – wrap executors with `editor.api.globals.history.begin/commit` so actions show up in undo.
5. **Result payload** – what changed, diff text, errors (fed back into the chat).

### 4.5 Safety, approvals & observability

- **Permission gating** – every tool checks `editor.call('permissions:write')` before executing; read-only users only get explanatory answers.
- **User approval surface** – the assistant panel renders proposed changes with diffs (e.g., highlight tree insertions, asset metadata changes, code diffs) and offers Approve/Reject. Nothing mutates until approved.
- **Audit logging** – store conversations + tool outputs locally via Dexie (like console logs in `src/workers/console.worker.ts:1-170`). Provide “Export conversation” to share with teammates.
- **Status & notifications** – reuse `status:text` / `console:log` to broadcast assistant activity, and optional desktop notifications for long tasks using `notify` helpers.
- **Rate limiting & quotas** – track token usage per project to avoid runaway costs; display the quota in the UI.

## 5. Capability Workstreams

### 5.1 Assets

1. **Context gatherer** – summarize selected assets (type, path, tags, referenced entities) using `assets:get`, `assets:virtualPath`, etc. (`src/editor/assets/assets.ts:94-114`).
2. **Creation tools** – wrappers for the existing `assets:create-*` methods to spawn folders, materials, sprites, shaders. Provide optional prompt → template conversions (e.g., auto-fill shader chunks).
3. **File edits** – for text-based assets (`assets:edit`, `src/editor/assets/assets-edit.ts`), pipe assistant-generated content into Monaco or the legacy preview overlay, preserving parse callbacks.
4. **Bulk operations** – rename/move/categorize assets by scripting `editor.api.globals.assets.raw` and `assets:panel` selection.
5. **Validation** – confirm asset types, folder paths, and reference counts before applying (use `assets:used` utilities).

### 5.2 Scenes & Entities

1. **Hierarchy insights** – walk `editor.api.globals.entities.raw` to build concise descriptions (entity name, tags, key components). Limit scope via selection or user prompt keywords.
2. **Entity create/update/delete tools** – translate assistant suggestions into ShareDB ops submitted via `editor.call('realtime:scene:op')` (`src/editor/realtime/realtime.ts:88-124`). Include helpers for component schema validation using `config.schema`.
3. **Component templates** – maintain a library of common component presets (lights, cameras) the assistant can reference.
4. **Scene settings** – use the settings observers to toggle render/physics settings and log the change for undo.
5. **Spatial reasoning** – query `ViewportApplication` camera state (`src/editor/viewport/viewport.ts:1-60`) to align suggestions with current view (e.g., “place object where I’m looking”).

### 5.3 Code & Script Assets

1. **Document access** – rely on `loadDocument` (`src/code-editor/documents/documents-load.ts:49-150`) so we edit the same ShareDB doc Monaco uses. Provide fallback to fetch asset files when the code editor isn’t open.
2. **Edit strategy** – prefer structured transforms (AST diff via SWC, already in dev dependencies) to minimize merge conflicts. Return a diff for review before calling `doc.submitOp`.
3. **Testing hooks** – optionally run lint/tests (`npm run lint`, `npm test`) through a worker or cloud job and summarize results in the chat.
4. **Dependency reasoning** – use `assets:getByVirtualPath` & `utils:deps-from-string` to understand module graphs and warn before breaking exports.

### 5.4 Project & “other relevant things”

1. **Project settings** – read/write via `settings:create` observers (`src/editor/settings/settings.ts:5-145`) so changes broadcast to collaborators instantly.
2. **Version control / branches** – integrate with existing VC pickers so assistant can prepare merge summaries or explain conflicts.
3. **Console/log insights** – tap into the Dexie-backed log worker to let the assistant diagnose engine/runtime issues from recent log output.
4. **Third-party stores** – surface store/sketchfab search (`src/editor/store/store.ts`) so users can ask the assistant to recommend/import assets.

## 6. Delivery Plan & Milestones

1. **Phase 0 – Foundations (1 sprint)**
   - Add assistant feature flag + metrics plumbing.
   - Build OpenAI Responses API client + backend proxy.
   - Ship read-only chat panel seeded with project info (no actions yet).
2. **Phase 1 – Contextual QA (1–2 sprints)**
   - Implement context builders (selection, assets, settings, logs).
   - Support plain Q&A + code explanations (no mutations).
3. **Phase 2 – Asset & scene drafts (2 sprints)**
   - Deliver asset creation/rename tools with previews.
   - Implement entity/component add/edit with ShareDB ops + undo integration.
4. **Phase 3 – Script editing (2 sprints)**
   - Add Monaco diff previews, apply code edits via ShareDB, optional lint/test hooks.
5. **Phase 4 – Safety & rollout (ongoing)**
   - Harden approvals, add audit log exports, enforce rate limits, gather UX feedback.
6. **Phase 5 – Advanced automation**
   - Multi-step plans, background jobs through workers, team collaboration features (share assistant suggestions via messenger/relay).

Each milestone should end with usability testing inside a staging project before rolling out widely.

## 7. Risks & Open Questions

1. **API cost & latency** – Responses API with tool calls can be slow; we may need request batching, caching, and UI affordances for long waits.
2. **Prompt grounding limits** – Scenes with thousands of entities will exceed token budgets. Need heuristics to limit scope (selection-based summaries, targeted queries).
3. **Conflict resolution** – ShareDB edits generated by the assistant may conflict with concurrent human edits; we should detect/retry gracefully and show conflicts in the UI.
4. **Security** – ensure prompts never leak private API keys, and restrict assistant tool access to the current project context.
5. **Testing coverage** – automated verification for assistant-generated code/assets is limited today. Consider sandbox builds or headless engine runs to validate changes.
6. **Backend dependencies** – this repo is frontend-only; we must coordinate with backend owners to expose the AI proxy endpoint and, if needed, server-side helpers for large operations.

With the above plan, we can add an AI assistant that feels native to the PlayCanvas Editor, leverages existing realtime/state management infrastructure, and safely performs meaningful edits using the OpenAI Responses API.
