# draw.io VisualPlan Rendering Repair Plan

## Summary

This plan fixes the current draw.io readability failures in SoC, architecture, and complex flow diagrams:

- empty or detached weak containers;
- main graph shifted far away from the visible center;
- unclear thick bus lines whose source and destination are hard to read;
- non-self edges that visually look like self-loops;
- overlapping or crooked edge routes;
- text/line collisions;
- low-value legends that repeat truncated node names.

The fix must preserve the agreed boundary: the model or active skill decides business meaning and emits structured `DiagramIR` / `VisualPlan`; the plugin validates structure and performs generic geometric rendering. The plugin must not infer main flow, exception flow, bus semantics, state roles, or legend content from labels, IDs, function names, state names, project words, or domain words.

## Root Causes

### 1. Empty Weak Containers

Some generated XML contains containers such as `main_flow`, `exception_flow`, or visual regions whose coordinates are far from the actual nodes. The nodes remain under the root parent instead of being assigned to those regions, so the containers become empty visual blocks and stretch the canvas.

This is not a draw.io runtime error. It is a structure/ownership problem:

- the model declared containers;
- the model did not assign nodes or incident edges to those containers;
- the renderer allowed the containers to remain visible anyway.

### 2. Main Graph Bounds Are Polluted

The renderer may compute final bounds using empty containers, layout-only hints, or side legends. This can push the actual main graph to the right or create large blank areas.

The main graph should be normalized from real diagram nodes first. Background bands and legends should be placed after the main graph bounds are known.

### 3. Bus Edges Lack Explicit Visual Structure

In complex SoC diagrams, several thick bus-like edges can converge into a shared target or continue from one module to another region. If the renderer draws them as ordinary point-to-point edges, users cannot tell:

- which module starts the bus;
- which module receives it;
- whether several edges are branches of one trunk;
- whether a module is an intermediate junction or an endpoint.

This also creates pseudo self-loop visuals, such as an edge that appears to leave `L1 D-Cache` and return to `L1 D-Cache`, even when `source !== target`.

### 4. Edge Routes Are Too Generic

When edges lack explicit bend points, draw.io auto-routes them. In dense diagrams this can produce:

- stacked vertical or horizontal spines;
- short unnecessary jogs;
- crooked lines where straight lines are possible;
- route segments crossing labels or node text;
- very short arrows that look unbalanced;
- container-to-container lines that fail to align with the containers.

### 5. Legend Content Is Not Always Model Meaning

A legend is only useful if it contains explanatory content from the model or skill. A renderer-generated legend that repeats truncated node names is noise and should not be treated as business understanding.

## Non-Negotiable Boundary

### Model / Skill Must Decide

The model or active skill must provide these semantic decisions as structured data:

- public diagram type: `business-flow`, `code-flow`, `state-machine`, `architecture`, `soc-block`, etc.;
- main backbone nodes/edges;
- edge presentation: `line`, `rail`, `bus`, `legend`, or equivalent explicit modes;
- bus groups, trunk direction, branch membership, junctions, and port hints;
- container/region/lane ownership;
- legend/evidence content;
- whether an empty container is intentional.

### Plugin Must Only Execute

The plugin may:

- validate whether the provided structure is complete and renderable;
- draw background bands around assigned nodes;
- generate orthogonal routes and bend points;
- align endpoints to node/container/port boundaries;
- fan out parallel lines;
- draw trunks, branches, rails, junction markers, and legends from explicit `VisualPlan`;
- compute generic geometry metrics;
- fail with gaps when complex diagrams lack required structure.

The plugin must not:

- identify business main flow from text;
- decide which state is important from a name;
- infer exception paths from labels;
- move edges into legend because their text “looks secondary”;
- group buses by domain words;
- special-case fixtures such as `GC`, `MP`, `SSD`, `FDS`, `START`, `ERROR`, `IDLE`, specific function names, or specific Chinese labels.

## Key Changes

### 1. Container Ownership Validation

Enhance `chipmate_validate_diagram_ir` and the draw.io create tool preflight:

- For complex diagrams, if a container/region/lane has no assigned nodes, no incident edges, and no `allowEmpty` / `placeholder`, return a blocking gap.
- The gap must ask the model to choose one of three fixes:
  - assign nodes or incident edges to the container;
  - explicitly mark it as an intentional empty placeholder;
  - delete it.
- `chipmate_create_drawio_diagram` must repeat this validation before XML generation.
- If unresolved empty containers remain, fail the tool result and do not insert a misleading diagram part.

### 2. Weak Band Rendering

For `business-flow`, `code-flow`, and embedded-FSM-like profiles:

- Treat containers as weak visual bands by default, not strong compound parents.
- Layout actual nodes at the graph root so edges do not cross compound-parent boundaries unnecessarily.
- After layout, compute each weak band from the bounding box of its assigned nodes.
- Do not use stale model-provided container coordinates when drawing weak bands.
- Do not emit empty weak bands unless `allowEmpty` or `placeholder` is explicitly set.

For `architecture` and `soc-block`:

- Strong containers remain allowed when explicitly requested or structurally required.
- Even then, empty containers still need explicit intent.

### 3. Main Graph Bounds Normalization

Before final XML generation:

- Compute main bounds from real graph nodes and visible structural containers that own nodes.
- Exclude layout-only containers, unresolved empty containers, and legend/sidebar regions.
- Normalize the main graph near a fixed margin.
- Place legend/sidebar after main graph normalization.
- Ensure legends and decorative bands cannot push the main graph far away from the canvas center.

### 4. VisualPlan Bus Contract

Add or standardize a VisualPlan bus structure:

```ts
interface VisualPlanBus {
  id: string
  label?: string
  edges: string[]
  direction?: "left" | "right" | "up" | "down"
  trunk?: VisualPlanBusTrunk
  junctions?: VisualPlanJunction[]
  portHints?: Record<string, VisualPlanPortHint>
}

interface VisualPlanBusTrunk {
  orientation?: "horizontal" | "vertical"
  side?: "left" | "right" | "top" | "bottom" | "middle"
  lane?: number
  label?: string
}

interface VisualPlanJunction {
  id: string
  edges: string[]
  label?: string
  visible?: boolean
}

interface VisualPlanPortHint {
  nodeId?: string
  containerId?: string
  side?: "left" | "right" | "top" | "bottom"
  order?: number
}
```

These fields are model/skill decisions. The renderer only executes them.

### 5. Bus Trunk / Junction Rendering

When `visualPlan.buses[]` is present:

- Render one trunk per bus.
- Convert grouped point-to-point bus edges into short branches plus a shared trunk.
- Add a visible junction marker only when requested or needed by the bus contract.
- Keep branch lines short and orthogonal.
- Align branch endpoints to explicit port hints.
- Fan out parallel trunks so they do not overlap.
- Ensure a bus edge with grouped structure does not also render as a duplicate ordinary edge.

For multi-source same-target buses:

- Draw source branches into a junction or trunk.
- Draw one clear trunk into the target.

For same-source multi-target buses:

- Draw one clear trunk from the source.
- Draw target branches from the trunk.

### 6. No Contract, No Guessing

For complex `soc-block` and `architecture` diagrams:

- If multiple bus-like edges share a source or target and no `visualPlan.buses` groups them, return a validation gap or high-severity warning.
- If thick visible edges share the same node side and cannot be read, require port hints or bus grouping.
- Do not auto-group buses based on node names, text, edge labels, or domain words.

### 7. Edge Presentation Execution

Use `visualPlan.edgePresentation[edgeId].mode` as the only source of edge display class.

Expected execution:

- `line`: ordinary orthogonal route, direct if unobstructed.
- `rail`: route outside the main graph through explicit bend points.
- `bus`: trunk/branch rendering through `visualPlan.buses`.
- `legend`: do not draw the edge as a graph line; render it only in explicit legend/evidence.

For `rail` and `bus`:

- Generate explicit `<Array as="points">` bend points.
- Missing points for non-trivial rail/bus edges is a renderer bug.
- Same-side rails and trunks must fan out with spacing.

### 8. Straight-Line and Short-Jog Cleanup

Add generic geometry cleanup after route generation:

- If source and target ports align and no obstacle intersects the segment, draw a straight line.
- Remove tiny jogs that do not avoid any obstacle.
- Avoid routes that pass through node labels, container titles, or rotated side labels.
- Ensure container-to-container and port-to-port lines are visually aligned when the model/skill requests corresponding port sides.
- Avoid arrows so short that the arrowhead dominates the segment.

This cleanup is geometry-only. It must not change edge meaning.

### 9. Text / Line Collision Guard

Add a generic collision pass:

- Check whether edge segments intersect node text boxes or container title zones.
- Check whether labels sit on top of lines or nodes.
- If collision is detected:
  - move the label along the route;
  - shorten or externalize label text when the model supplied a legend item;
  - adjust bend points by a neutral offset;
  - otherwise return a warning/gap for complex diagrams.

### 10. Legend Rules

Visible `Legend` / `Evidence` blocks may only come from explicit model/skill data:

- `visualPlan.legend.items`;
- contract/evidence fields explicitly requested for visible output.

The renderer must not create a visible business legend by automatically copying long node names or edge labels.

If model-provided legend items are just truncated node IDs or duplicate visible labels:

- keep the renderer faithful;
- return a non-blocking validation warning that the legend has low information value;
- do not replace it with plugin-generated business text.

### 11. PNG Export

Do not treat current VS Code PNG export as the primary bug. The user has not reproduced export timeout in the real VS Code environment.

Keep existing export behavior, but record diagnostics:

- graph bounds;
- node/edge/container counts;
- export scale;
- XML byte size;
- render duration where available.

## Metrics

Add or refine deterministic visual metrics:

- `emptyContainerCount`
- `unassignedContainerCount`
- `mainGraphOffsetRiskCount`
- `busFanInAmbiguityCount`
- `busFanOutAmbiguityCount`
- `pseudoSelfLoopRiskCount`
- `sharedPortOverlapCount`
- `busTrunkAlignmentRiskCount`
- `shortJogCount`
- `textLineCollisionCount`
- `containerTitleCollisionCount`
- `labelOverlapCount`
- `legendLowValueCount`
- `legendOverwideCount`

Metrics must be label-agnostic. They should inspect geometry, ownership, explicit VisualPlan references, and route structure.

## Test Matrix

### Case 1: Cortex-R8 Style SoC

Purpose:

- multiple core pipeline sources converge into cache/memory;
- memory/cache continues to interconnect;
- one diagram section can visually resemble a self-loop.

Expected:

- grouped buses render as trunk plus branches;
- source and destination are readable;
- no non-self edge looks like a self-loop;
- `L1 D-Cache` style modules do not show unexplained half-loop double arrows.

### Case 2: GPU Slice / Unslice / GTI

Purpose:

- sidebars, vertical labels, fixed-function blocks, ports, cross-region bus paths.

Expected:

- side interface text and arrows do not overlap;
- container-to-container edges are straight when unobstructed;
- no short unnecessary jogs;
- modules use available horizontal space instead of bunching into one side.

### Case 3: SSD Embedded FSM Flow

Purpose:

- business flow with modules, FSM states, events, guards, and feedback edges.

Expected:

- containers are weak bands unless explicit strong structure is provided;
- no empty bands float away from nodes;
- feedback/exception routes use explicit `edgePresentation` and bend points;
- long state/function labels do not drive visible legend noise.

### Case 4: Cortex-A Cluster / Multi-Core Fabric

Purpose:

- several cores converge into shared L2/cache/coherent interconnect and branch to peripherals.

Expected:

- dense core-to-memory/fabric lines are grouped by explicit buses;
- no unclear thick red/brown line whose endpoints cannot be read;
- shared trunks and branches remain visually separated.

### Case 5: Neutral Canary

Purpose:

- replace all business words, labels, and IDs with neutral generated names.

Expected:

- same VisualPlan structure produces equivalent layout;
- no production behavior depends on domain terms or fixture strings.

## Iteration Workflow

1. Generate the five representative DiagramIR/VisualPlan cases.
2. Render draw.io XML.
3. Export PNG through the offline draw.io runtime.
4. Post preview PNGs into chat before review.
5. Run deterministic metrics.
6. Review visually against this plan.
7. If failed:
   - missing model/skill fields: update prompt/schema/validation/fixture VisualPlan;
   - renderer execution failure: fix generic geometry or XML generation.
8. Re-run all five cases plus neutral canaries.
9. Reject any patch that uses fixture text, IDs, module names, state names, or business terms in production logic.

## Acceptance Criteria

- Empty or detached containers do not appear unless explicitly intentional.
- Main graph is centered around real diagram content, not pushed by empty containers or legends.
- Bus source, trunk, branch, junction, and destination are readable.
- Non-self edges do not visually look like self-loops.
- Container-to-container and port-to-port lines are straight when unobstructed.
- No visible line crosses important text or container titles.
- Edge labels and node text do not overlap lines or borders.
- Legends contain model/skill-provided explanatory content, not renderer-generated truncated node names.
- Missing complex VisualPlan fields produce clear gaps instead of low-quality diagrams.
- Neutral canary cases pass with the same structure.

## Out Of Scope

- Full draw.io editor behavior.
- Business-semantic inference in plugin code.
- Hardcoded repairs for one screenshot or one project.
- Changing Mermaid behavior.
- Replacing model/skill planning with renderer-side scene recognition.
