# Carbon Coder

Analyze, budget, and refactor your code's carbon footprint at fleet scale with intelligent, variable-aware quick fixes.

Carbon Coder is a VS Code extension for Green Software Engineering. It helps developers spot energy hotspots, estimate carbon impact using grid-aware heuristics, and apply practical refactors that scale from a local script to a cloud fleet.

## Why Carbon Coder

Most developer tooling stops at runtime performance. Carbon Coder focuses on the next layer: energy efficiency, cloud cost, and carbon-aware engineering decisions.

It is designed for teams building:

- SaaS backends and cloud workers
- Enterprise data pipelines and migrations
- Mobile and edge workloads where battery and network energy matter
- High-scale internal tools that run across hundreds or thousands of nodes

## What It Detects

- Deep loops such as `O(n^2)` and `O(n^3)` patterns
- Unbuffered network I/O inside bounded loops
- Zombie polling loops that keep compute and network awake
- Heavy imports that increase startup and memory overhead
- Demand-shifting opportunities for expensive jobs
- Payload reduction opportunities for network-heavy code

## What It Does

- Surfaces carbon-aware CodeLens above hotspots
- Shows subtle right-edge energy metadata in the editor
- Calculates a project-wide carbon score and modeled cloud cost
- Offers variable-aware quick fixes for batching, polling, import slimming, and scheduling
- Simulates grid carbon intensity and low-carbon windows with a mock Electricity Maps service
- Provides an Impact Dashboard with budgeting, benchmarking, and fleet-scale modeling

## Example Use Cases

- Replace `requests.post(...)` inside a loop with streamed chunked batching
- Add backoff to a `while True` polling worker
- Swap expensive import patterns for lighter alternatives
- Show how a tiny per-run inefficiency becomes significant at `10,000` nodes

## Extension Surface

- Status bar: current modeled carbon score in `gCO2e/run`
- CodeLens: hotspot-level impact with one-click optimization entry points
- Hover cards: educational explanations of why a pattern matters
- Metadata hints: lightweight Joules and CO2e context at the line edge
- Impact Dashboard: budget, benchmark, annualized savings, and fleet multiplier controls

## Demo Files

The repo includes realistic sample workloads for testing the extension:

- `carbon_test.py`
- `enterprise_worker.py`
- `data_migrator.py`

Open one of those files in the Extension Development Host to see the analyzer, dashboard, and refactors in action.

## Local Development

```bash
npm install
npm run compile
```

Then press `F5` in VS Code and choose the extension debug launch.

## Packaging

```bash
npx @vscode/vsce package
```

This generates a `.vsix` package that can be installed locally or uploaded to the VS Code Marketplace.

## Updating After Publish

1. Update the version in `package.json`.
2. Rebuild the extension with `npm run compile`.
3. Repackage it with `npx @vscode/vsce package`.
4. Upload the new `.vsix` in the Marketplace publisher dashboard, or publish with `vsce publish` if you use a token locally.

## Architecture

```text
src/
  analyzer.ts               AST + heuristic hotspot detection
  carbon.ts                 Energy-to-carbon conversion logic
  electricityMapsMock.ts    Mock carbon-intensity service and low-carbon windows
  extension.ts              VS Code UI wiring, dashboard, CodeLens, and status bar
  greenFixes.ts             Quick Fix recipes and code actions
  types.ts                  Shared types and analysis contracts
media/
  hot-low.svg               Activity and editor visual assets
  hot-medium.svg
  hot-high.svg
```

## Notes

The cost and carbon model is intentionally heuristic so the extension stays fast and explanatory inside the editor. The goal is not perfect hardware telemetry. The goal is to make sustainable engineering decisions visible, actionable, and meaningful at scale.
