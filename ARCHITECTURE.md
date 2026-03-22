# Architecture Notes

## Goal

Zotsidian now supports four overlapping workflows:

1. inline citation insertion with `@`
2. source-note inspection in the sidebar
3. discourse-graphs canvas parsing, highlighting, and locate
4. lightweight native canvas / base compatibility

The code should stay maintainable for both humans and future AI agents. That means:

- keep `main.ts` as an orchestrator, not a dumping ground for pure logic
- move store parsing, geometry, and other pure computations into focused modules
- prefer modules with clear inputs / outputs over methods that directly touch plugin state
- document which areas are stable and which are compatibility layers

## Module Map

### Entry and coordination

- `main.ts`
  - plugin lifecycle
  - settings
  - workspace event wiring
  - top-level caches
  - cross-module coordination

### Sidebar UI

- `ReferencesView.ts`
  - all sidebar rendering
  - sidebar-local UI state
  - annotation actions
  - section toggles, filters, sort UI

### Citation and source processing

- `ReferenceProcessing.ts`
  - citation parsing and collection extraction
- `EditorExtensions.ts`
  - editor hover extensions
- `ZoteroFunctions.ts`
  - Zotero resolution and attachment lookup
- `SemanticScholar.ts`
  - related-paper provider integration

### Discourse canvas support

- `DiscourseCanvasModel.ts`
  - converts discourse store records into a normalized model
  - no Obsidian plugin state access
- `DiscourseStore.ts`
  - reads discourse runtime store state from a leaf
  - isolates store shape assumptions
- `DiscourseCanvasGeometry.ts`
  - viewport, visible-page detection, rendered-shape lookup, and hit testing
  - takes model + DOM + callbacks, returns plain results
- `DiscourseCanvasSelection.ts`
  - maps current discourse selection / hover state into sidebar-friendly citekeys
  - keeps selection semantics out of `main.ts`
- `DiscourseCanvasSync.ts`
  - owns discourse selection / hover sync decision rules
  - keeps sidebar update policy separate from plugin wiring

## Stability Tiers

### Tier 1: stable core

These files should stay predictable and are good first targets for AI edits:

- `ReferenceProcessing.ts`
- `DiscourseCanvasModel.ts`
- `DiscourseStore.ts`
- `DiscourseCanvasGeometry.ts`

They mostly contain pure logic or thin data adapters.

### Tier 2: coordinated behavior

- `ReferencesView.ts`
- selected portions of `main.ts`

These files combine UI and state, so changes should stay narrow and deliberate.

### Tier 3: compatibility layer

- native canvas support
- base support
- discourse runtime fallbacks

These areas are best-effort and more fragile. Prefer minimal, targeted changes.

## Change Rules

When extending or fixing the plugin, use this order:

1. Check whether the bug is pure parsing, store access, geometry, or UI.
2. Modify the dedicated module first.
3. Only touch `main.ts` if the problem is orchestration or shared state flow.
4. Avoid mixing runtime store logic with DOM guessing in the same new function.
5. If a helper only transforms data, move it out of `main.ts`.

## Current Refactor Strategy

The ongoing safe refactor is intentionally incremental:

1. extract pure discourse record parsing
2. extract discourse store access helpers
3. extract discourse geometry / hit testing
4. extract discourse selection mapping
5. extract discourse sync flows
6. later, extract reference locate logic

This order keeps behavior stable while shrinking `main.ts`.

## Known Hotspots

- `main.ts` is still the largest file and the main long-term maintenance target.
- `ReferencesView.ts` is also large, but it is already a good boundary because it owns sidebar rendering.
- native canvas and base support remain intentionally limited and should not absorb complex discourse-only logic.

## Testing Priority After Refactors

Every structural change should manually verify:

1. markdown page references and cited counts
2. source page annotations, related data, and discourse graph panel
3. discourse canvas sidebar population, selection highlight, and locate
4. native canvas references list
5. base references list
