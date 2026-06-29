import type { DrawioContainerSpec, DrawioDiagramSpec, DrawioEdgeSpec, DrawioNodeSpec } from "./drawio-diagram-generator"

export type DiagramIrCoverage = "complete" | "partial" | "inferred" | "unknown"
export type DiagramIrCompositionMode = "single" | "multi"

export type DiagramIrComposition = {
  mode: DiagramIrCompositionMode
  reason?: string
}

export type DiagramIrEvidenceRef = string | {
  refId?: string
  path?: string
  lines?: string
  source?: string
}

export type DiagramIrElement = Record<string, unknown> & {
  id?: string
  label?: string
  title?: string
  text?: string
  placeholder?: boolean
  allowEmpty?: boolean
  containerMode?: string
  layoutMode?: string
  visualRole?: string
  edgeKind?: string
  pathRole?: string
  labelPriority?: string
  evidenceRefs?: DiagramIrEvidenceRef[]
  confidence?: number
  coverage?: DiagramIrCoverage
  sourceKind?: string
}

export type DiagramIrVisualProfileSuggestion = {
  profile: string
  reason: string
  signals: string[]
}

export type DiagramIrIssueSeverity = "warning" | "blocking"

export type DiagramIrIssue = {
  code: string
  severity: DiagramIrIssueSeverity
  message: string
  refs?: Array<{ kind?: string; id?: string; label?: string }>
}

export type DiagramIrVisualPlanMainBackbone = {
  nodes?: string[]
  edges?: string[]
  direction?: "down" | "right" | "left" | "up" | string
}

export type DiagramIrVisualPlanEdgePresentation = {
  mode?: "line" | "rail" | "legend" | string
  rail?: "left" | "right" | "top" | "bottom" | string
  marker?: string
  label?: string
  detail?: string
  style?: Record<string, unknown> | string
  drawioStyle?: Record<string, unknown> | string
}

export type DiagramIrVisualPlanLegendItem = {
  id?: string
  marker?: string
  label?: string
  text?: string
  detail?: string
  nodeId?: string
  edgeId?: string
}

export type DiagramIrVisualPlanLegend = {
  position?: "right" | "bottom" | string
  title?: string
  items?: DiagramIrVisualPlanLegendItem[]
}

export type DiagramIrVisualPlanPortHint = {
  nodeId?: string
  containerId?: string
  side?: "left" | "right" | "top" | "bottom" | string
  order?: number
}

export type DiagramIrVisualPlanBusTrunk = {
  orientation?: "horizontal" | "vertical" | string
  side?: "left" | "right" | "top" | "bottom" | "middle" | string
  lane?: number
  label?: string
}

export type DiagramIrVisualPlanJunction = {
  id?: string
  edges?: string[]
  label?: string
  visible?: boolean
}

export type DiagramIrVisualPlanBus = {
  id?: string
  label?: string
  edges?: string[]
  direction?: "left" | "right" | "up" | "down" | string
  trunk?: DiagramIrVisualPlanBusTrunk
  junctions?: DiagramIrVisualPlanJunction[]
  portHints?: Record<string, DiagramIrVisualPlanPortHint>
}

export type DiagramIrVisualPlan = {
  layoutProfile?: string
  mainBackbone?: DiagramIrVisualPlanMainBackbone
  edgePresentation?: Record<string, DiagramIrVisualPlanEdgePresentation>
  legend?: DiagramIrVisualPlanLegend
  buses?: DiagramIrVisualPlanBus[]
  regions?: unknown
  styleHints?: Record<string, unknown>
}

export type DiagramIr = {
  version?: string
  title?: string
  diagramType?: string
  intent?: string
  scope?: string
  composition?: DiagramIrComposition
  nodes?: DiagramIrElement[]
  edges?: DiagramIrElement[]
  regions?: DiagramIrElement[]
  containers?: DiagramIrElement[]
  groups?: DiagramIrElement[]
  lanes?: DiagramIrElement[]
  swimlanes?: DiagramIrElement[]
  buses?: DiagramIrElement[]
  ports?: DiagramIrElement[]
  arrays?: DiagramIrElement[]
  subdiagrams?: DiagramIrElement[]
  legend?: unknown
  layoutHints?: Record<string, unknown>
  styleHints?: Record<string, unknown>
  semanticHints?: Record<string, unknown>
  sourceArtifacts?: unknown[]
  referenceDiagrams?: unknown[]
  evidenceSummary?: unknown
  visualPlan?: DiagramIrVisualPlan
}

export type DiagramIrCoverageReport = {
  totalElements: number
  elementsWithEvidence: number
  elementsMissingEvidence: number
  coverage: DiagramIrCoverage
  complexDiagram: boolean
}

export type DiagramIrValidationResult = {
  ok: boolean
  diagramIr: DiagramIr
  drawioSpec: DrawioDiagramSpec
  issues: DiagramIrIssue[]
  warnings: string[]
  gaps: string[]
  nextEvidenceSuggestions: Array<{ tool: string; reason: string; args: Record<string, string> }>
  coverageReport: DiagramIrCoverageReport
  visualProfileSuggestion: DiagramIrVisualProfileSuggestion
}

const COMPLEX_DIAGRAM_TYPES = new Set([
  "architecture",
  "business-flow",
  "call-flow",
  "code-flow",
  "soc-block",
  "state-machine",
])

const DIAGRAM_TYPE_ALIASES: Record<string, string> = {
  arch: "architecture",
  architecturemap: "architecture",
  businessflow: "business-flow",
  callflow: "call-flow",
  chip: "soc-block",
  chipdiagram: "soc-block",
  codeflow: "code-flow",
  flow: "flowchart",
  flowchart: "flowchart",
  sequence: "sequence",
  soc: "soc-block",
  socblock: "soc-block",
  socdiagram: "soc-block",
  statemachine: "state-machine",
  swimlane: "swimlane",
}

const DEFAULT_LAYOUT_BY_TYPE: Record<string, string> = {
  architecture: "architecture",
  "business-flow": "flow",
  "call-flow": "flow",
  "code-flow": "flow",
  flowchart: "flow",
  sequence: "sequence",
  "soc-block": "soc-block",
  "state-machine": "flow",
  swimlane: "swimlane",
}

export function findDiagramIrInput(input: unknown): unknown | undefined {
  const record = asRecord(input)
  if (!record) return undefined
  if (asRecord(record.diagramIr)) return record.diagramIr
  if (asRecord(record.ir)) return record.ir
  if (asRecord(record.diagramIR)) return record.diagramIR
  const diagramType = normalizeDiagramType(stringValue(record.diagramType))
  if (
    typeof record.version === "string" ||
    COMPLEX_DIAGRAM_TYPES.has(diagramType) ||
    Array.isArray(record.regions) ||
    Array.isArray(record.buses) ||
    Array.isArray(record.ports) ||
    Array.isArray(record.arrays) ||
    record.composition !== undefined ||
    asRecord(record.layoutHints) ||
    asRecord(record.styleHints) ||
    asRecord(record.semanticHints) ||
    asRecord(record.visualPlan) ||
    Array.isArray(record.referenceDiagrams) ||
    Array.isArray(record.sourceArtifacts)
  ) {
    return record
  }
  return undefined
}

export function validateDiagramIr(input: unknown): DiagramIrValidationResult {
  const root = asRecord(input) ?? {}
  const irRecord = asRecord(findDiagramIrInput(input)) ?? root
  const warnings: string[] = []
  const gaps: string[] = []
  const issues: DiagramIrIssue[] = []
  const title = compactText(stringValue(root.title) || stringValue(irRecord.title) || "Diagram", 120)
  const diagramType = normalizeDiagramType(stringValue(root.diagramType) || stringValue(irRecord.diagramType) || inferDiagramType(irRecord))
  const layout = normalizeLayout(root.layout ?? irRecord.layoutHints ?? irRecord.layout, diagramType)
  const themeHint = stringValue(asRecord(irRecord.styleHints)?.theme)
  const theme = root.theme ?? (themeHint || undefined)
  const nodes = arrayRecords(irRecord.nodes)
  const edges = arrayRecords(irRecord.edges)
  const regions = arrayRecords(irRecord.regions)
  const containers = arrayRecords(irRecord.containers)
  const groups = arrayRecords(irRecord.groups)
  const lanes = [...arrayRecords(irRecord.lanes), ...arrayRecords(irRecord.swimlanes)]
  const buses = arrayRecords(irRecord.buses)
  const ports = arrayRecords(irRecord.ports)
  const arrays = arrayRecords(irRecord.arrays)
  const sourceArtifacts = arrayValues(irRecord.sourceArtifacts)
  const referenceDiagrams = arrayValues(irRecord.referenceDiagrams)
  const composition = normalizeComposition(root.composition ?? irRecord.composition, warnings)
  const visualPlan = normalizeVisualPlan(root.visualPlan ?? irRecord.visualPlan, warnings) ?? normalizeLegendOnlyVisualPlan(irRecord.legend)

  const allEvidenceElements = [...nodes, ...edges, ...regions, ...containers, ...groups, ...lanes, ...buses, ...ports]
  const elementsWithEvidence = allEvidenceElements.filter(hasEvidence).length
  const complexDiagram = COMPLEX_DIAGRAM_TYPES.has(diagramType)
  if (!nodes.length && !arrays.length && !regions.length && !containers.length) {
    gaps.push("DiagramIR has no nodes, arrays, regions, or containers to render.")
  }
  if (complexDiagram && elementsWithEvidence === 0 && sourceArtifacts.length === 0 && referenceDiagrams.length === 0) {
    gaps.push("Complex diagram has no evidenceRefs, sourceArtifacts, or referenceDiagrams; collect code/document/reference evidence before claiming completeness.")
  }
  for (const element of allEvidenceElements) {
    const coverage = stringValue(element.coverage)
    if (coverage && !["complete", "partial", "inferred", "unknown"].includes(coverage)) {
      warnings.push(`Unknown coverage "${coverage}" on "${elementLabel(element)}"; using unknown semantics.`)
    }
    const confidence = element.confidence
    if (confidence !== undefined && (typeof confidence !== "number" || confidence < 0 || confidence > 1)) {
      warnings.push(`Confidence on "${elementLabel(element)}" should be between 0 and 1.`)
    }
  }
  for (const issue of unusedBoundaryIssues({
    boundaries: [...regions, ...containers, ...groups, ...lanes],
    nodes: [...nodes, ...ports, ...arrays],
    edges: [...edges, ...buses],
    severity: complexDiagram ? "blocking" : "warning",
  })) {
    addValidationIssue({ issue, issues, warnings, gaps })
  }
  for (const message of visualPlanReferenceMessages({
    visualPlan,
    nodes: [...nodes, ...ports, ...arrays],
    edges: [...edges, ...buses],
  })) {
    addValidationIssue({
      issue: {
        code: "diagram.visualPlan.invalid_reference",
        severity: "blocking",
        message,
      },
      issues,
      warnings,
      gaps,
    })
  }
  for (const issue of visualPlanBusAmbiguityIssues({
    diagramType,
    visualPlan,
    edges: [...edges, ...buses],
  })) {
    addValidationIssue({ issue, issues, warnings, gaps })
  }
  const requiresVisualPlan = requiresPathVisualPlan(diagramType) && structurallyDenseDiagram(nodes, edges, [...regions, ...containers, ...groups, ...lanes])
  if (complexDiagram && requiresVisualPlan && !visualPlan) {
    const message = "Complex DiagramIR is structurally dense but has no visualPlan; ask the model/active skill to provide mainBackbone, edgePresentation, and legend decisions instead of letting the renderer infer semantics."
    addValidationIssue({
      issue: {
        code: "diagram.visualPlan.missing",
        severity: "blocking",
        message,
      },
      issues,
      warnings,
      gaps,
    })
  } else if (complexDiagram && requiresVisualPlan && visualPlan) {
    if (!visualPlan.mainBackbone?.nodes?.length && !visualPlan.mainBackbone?.edges?.length) {
      const message = "Complex DiagramIR visualPlan is missing mainBackbone; the model/active skill must identify the primary reading path."
      addValidationIssue({
        issue: {
          code: "diagram.visualPlan.missing_mainBackbone",
          severity: "blocking",
          message,
        },
        issues,
        warnings,
        gaps,
      })
    }
    if (!visualPlan.edgePresentation || Object.keys(visualPlan.edgePresentation).length === 0) {
      const message = "Complex DiagramIR visualPlan is missing edgePresentation; the model/active skill must decide which edges render as line, rail, or legend."
      addValidationIssue({
        issue: {
          code: "diagram.visualPlan.missing_edgePresentation",
          severity: "blocking",
          message,
        },
        issues,
        warnings,
        gaps,
      })
    }
  }
  for (const issue of legendLowInformationIssues(visualPlan)) {
    addValidationIssue({ issue, issues, warnings, gaps })
  }

  const diagramIr: DiagramIr = {
    version: stringValue(irRecord.version) || "diagram-ir/v1",
    title,
    diagramType,
    intent: stringValue(irRecord.intent),
    scope: stringValue(irRecord.scope),
    composition,
    nodes: copyElements(nodes),
    edges: copyElements(edges),
    regions: copyElements(regions),
    containers: copyElements(containers),
    groups: copyElements(groups),
    lanes: copyElements(lanes),
    swimlanes: copyElements(lanes),
    buses: copyElements(buses),
    ports: copyElements(ports),
    arrays: copyElements(arrays),
    subdiagrams: copyElements(arrayRecords(irRecord.subdiagrams)),
    legend: copyJsonValue(irRecord.legend),
    layoutHints: copyRecord(irRecord.layoutHints),
    styleHints: copyRecord(irRecord.styleHints),
    semanticHints: copyRecord(irRecord.semanticHints),
    sourceArtifacts,
    referenceDiagrams,
    evidenceSummary: copyJsonValue(irRecord.evidenceSummary),
    visualPlan,
  }

  if (diagramIr.subdiagrams?.length && composition.mode === "single") {
    warnings.push("DiagramIR includes subdiagrams but composition.mode is single; render as one primary diagram unless the model or active skill explicitly sets composition.mode to multi.")
  }

  const drawioSpec = diagramIrToDrawioSpec({
    root,
    diagramIr,
    title,
    diagramType,
    layout,
    theme,
    warnings,
  })
  const totalElements = allEvidenceElements.length
  const coverageReport: DiagramIrCoverageReport = {
    totalElements,
    elementsWithEvidence,
    elementsMissingEvidence: Math.max(0, totalElements - elementsWithEvidence),
    coverage: gaps.length ? (elementsWithEvidence ? "partial" : "unknown") : "complete",
    complexDiagram,
  }
  return {
    ok: gaps.length === 0,
    diagramIr,
    drawioSpec,
    issues: uniqueIssues(issues).slice(0, 80),
    warnings: unique(warnings).slice(0, 80),
    gaps: unique(gaps).slice(0, 40),
    nextEvidenceSuggestions: nextEvidenceSuggestions(diagramType, diagramIr, gaps),
    coverageReport,
    visualProfileSuggestion: visualProfileSuggestion(diagramType, diagramIr, drawioSpec),
  }
}

function visualProfileSuggestion(diagramType: string, diagramIr: DiagramIr, drawioSpec: DrawioDiagramSpec): DiagramIrVisualProfileSuggestion {
  const signals = embeddedFsmSignals(diagramIr, drawioSpec)
  if ((diagramType === "business-flow" || diagramType === "code-flow") && signals.length >= 3) {
    return {
      profile: "embedded-fsm-flow",
      reason: "DiagramIR combines process/code flow intent with module boundaries, state nodes, and event/transition edges.",
      signals,
    }
  }
  return {
    profile: diagramType === "call-flow" ? "code-flow" : diagramType,
    reason: "DiagramIR does not require a specialized embedded FSM visual profile.",
    signals,
  }
}

function embeddedFsmSignals(diagramIr: DiagramIr, drawioSpec: DrawioDiagramSpec) {
  const signals: string[] = []
  const nodes = [...(diagramIr.nodes ?? []), ...(diagramIr.ports ?? [])]
  const edges = [...(diagramIr.edges ?? []), ...(diagramIr.buses ?? [])]
  const semanticHints = diagramIr.semanticHints ?? {}
  if (diagramIr.lanes?.length || diagramIr.swimlanes?.length || diagramIr.containers?.length || diagramIr.regions?.length || drawioSpec.swimlanes?.length || drawioSpec.containers?.length) {
    signals.push("module-or-lane-boundaries")
  }
  if (booleanHint(semanticHints.containsStateMachines) || numberHint(semanticHints.stateMachineCount) > 0) {
    signals.push("state-machine-semantic-hint")
  }
  if (arrayHint(semanticHints.processPhases).length > 0) {
    signals.push("process-phase-hints")
  }
  if (nodes.some((node) => isStateLike(node))) {
    signals.push("state-nodes")
  }
  if (edges.some((edge) => isTransitionLike(edge))) {
    signals.push("transition-or-event-edges")
  }
  if (nodes.some((node) => isModuleLike(node))) {
    signals.push("module-role-nodes")
  }
  return Array.from(new Set(signals))
}

function diagramIrToDrawioSpec(input: {
  root: Record<string, unknown>
  diagramIr: DiagramIr
  title: string
  diagramType: string
  layout: string
  theme: unknown
  warnings: string[]
}): DrawioDiagramSpec {
  const nodes: DrawioNodeSpec[] = []
  const edges: DrawioEdgeSpec[] = []
  const containers: DrawioContainerSpec[] = []
  const groups: DrawioContainerSpec[] = []
  const swimlanes: DrawioContainerSpec[] = []

  const regionContainers = [...(input.diagramIr.regions ?? []), ...(input.diagramIr.containers ?? [])]
  for (const region of regionContainers) containers.push(containerFromIr(region, "container"))
  for (const group of input.diagramIr.groups ?? []) groups.push(containerFromIr(group, "group"))
  for (const lane of input.diagramIr.lanes ?? input.diagramIr.swimlanes ?? []) swimlanes.push(containerFromIr(lane, "swimlane"))
  for (const node of input.diagramIr.nodes ?? []) nodes.push(nodeFromIr(node))
  for (const port of input.diagramIr.ports ?? []) nodes.push(portNodeFromIr(port))
  for (const array of input.diagramIr.arrays ?? []) {
    const generated = arrayFromIr(array, input.warnings)
    if (generated.container) containers.push(generated.container)
    nodes.push(...generated.nodes)
  }
  for (const edge of input.diagramIr.edges ?? []) edges.push(edgeFromIr(edge))
  for (const bus of input.diagramIr.buses ?? []) edges.push(busFromIr(bus))

  return {
    title: input.title,
    diagramType: input.diagramType,
    nodes,
    edges,
    groups,
    containers,
    swimlanes,
    sequence: asRecord(input.root.sequence) as DrawioDiagramSpec["sequence"],
    layout: input.layout,
    theme: input.theme as DrawioDiagramSpec["theme"],
    style: input.root.style as DrawioDiagramSpec["style"],
    composition: input.diagramIr.composition,
    visualPlan: input.diagramIr.visualPlan,
  }
}

function nodeFromIr(item: DiagramIrElement): DrawioNodeSpec {
  return {
    ...safePassThrough(item),
    id: stringValue(item.id),
    label: stringValue(item.label) || stringValue(item.title) || stringValue(item.text),
    text: stringValue(item.text),
    shape: stringValue(item.shape) || stringValue(item.type),
    type: stringValue(item.type),
    parent: stringValue(item.parent) || stringValue(item.region) || stringValue(item.container) || stringValue(item.group) || stringValue(item.lane),
    group: stringValue(item.group),
    container: stringValue(item.container) || stringValue(item.region),
    lane: stringValue(item.lane),
    geometry: asRecord(item.geometry) as DrawioNodeSpec["geometry"],
    x: numberValue(item.x),
    y: numberValue(item.y),
    width: numberValue(item.width),
    height: numberValue(item.height),
    style: item.style as DrawioNodeSpec["style"],
    drawioStyle: item.drawioStyle as DrawioNodeSpec["drawioStyle"],
  }
}

function portNodeFromIr(item: DiagramIrElement): DrawioNodeSpec {
  return {
    ...nodeFromIr(item),
    shape: stringValue(item.shape) || "port",
    width: numberValue(item.width) ?? 48,
    height: numberValue(item.height) ?? 22,
    drawioStyle: mergeStyle(item.drawioStyle, "rounded=1;fillColor=#fff7ed;strokeColor=#f97316;fontSize=10;"),
  }
}

function edgeFromIr(item: DiagramIrElement): DrawioEdgeSpec {
  return {
    ...safePassThrough(item),
    id: stringValue(item.id),
    label: stringValue(item.label) || stringValue(item.title) || stringValue(item.text),
    text: stringValue(item.text),
    source: stringValue(item.source) || stringValue(item.from),
    from: stringValue(item.from),
    target: stringValue(item.target) || stringValue(item.to),
    to: stringValue(item.to),
    parent: stringValue(item.parent) || stringValue(item.layer),
    points: arrayRecords(item.points) as DrawioEdgeSpec["points"],
    style: item.style as DrawioEdgeSpec["style"],
    drawioStyle: item.drawioStyle as DrawioEdgeSpec["drawioStyle"],
  }
}

function busFromIr(item: DiagramIrElement): DrawioEdgeSpec {
  return {
    ...edgeFromIr(item),
    label: stringValue(item.label) || stringValue(item.title) || "bus",
    drawioStyle: mergeStyle(item.drawioStyle, "strokeWidth=4;endArrow=block;rounded=1;"),
  }
}

function containerFromIr(item: DiagramIrElement, kind: "container" | "group" | "swimlane"): DrawioContainerSpec {
  return {
    ...safePassThrough(item),
    id: stringValue(item.id),
    label: stringValue(item.label) || stringValue(item.title) || stringValue(item.text) || kind,
    title: stringValue(item.title),
    parent: stringValue(item.parent) || stringValue(item.region) || stringValue(item.container) || stringValue(item.group),
    placeholder: booleanHint(item.placeholder),
    allowEmpty: booleanHint(item.allowEmpty),
    containerMode: stringValue(item.containerMode),
    layoutMode: stringValue(item.layoutMode),
    geometry: asRecord(item.geometry) as DrawioContainerSpec["geometry"],
    x: numberValue(item.x),
    y: numberValue(item.y),
    width: numberValue(item.width),
    height: numberValue(item.height),
    style: item.style as DrawioContainerSpec["style"],
    drawioStyle: item.drawioStyle as DrawioContainerSpec["drawioStyle"],
  }
}

function arrayFromIr(item: DiagramIrElement, warnings: string[]) {
  const id = stringValue(item.id) || normalizeKey(stringValue(item.label) || "array")
  const label = stringValue(item.label) || stringValue(item.title) || id
  const rows = clampInteger(item.rows, 1, 16, 2)
  const columns = clampInteger(item.columns ?? item.cols, 1, 16, 4)
  const parent = stringValue(item.parent) || stringValue(item.region) || stringValue(item.container)
  const cellWidth = clampInteger(item.cellWidth, 36, 180, 56)
  const cellHeight = clampInteger(item.cellHeight, 24, 120, 40)
  const gap = clampInteger(item.gap, 4, 32, 8)
  const container: DrawioContainerSpec = {
    id,
    label,
    parent,
    x: numberValue(item.x),
    y: numberValue(item.y),
    width: numberValue(item.width) ?? columns * cellWidth + Math.max(0, columns - 1) * gap + 48,
    height: numberValue(item.height) ?? rows * cellHeight + Math.max(0, rows - 1) * gap + 64,
    drawioStyle: mergeStyle(item.drawioStyle, "fillColor=#eef2ff;strokeColor=#6366f1;"),
  }
  const nodes: DrawioNodeSpec[] = []
  const itemLabel = stringValue(item.itemLabel) || stringValue(item.cellLabel) || "EU"
  const prefix = stringValue(item.prefix) || id
  if (rows * columns > 96) warnings.push(`Array "${label}" was capped to 96 rendered cells.`)
  const total = Math.min(rows * columns, 96)
  for (let index = 0; index < total; index += 1) {
    const row = Math.floor(index / columns)
    const column = index % columns
    nodes.push({
      id: `${prefix}-${index + 1}`,
      label: itemLabel.includes("{n}") ? itemLabel.replace(/\{n\}/g, String(index + 1)) : itemLabel,
      parent: id,
      shape: "rectangle",
      x: 24 + column * (cellWidth + gap),
      y: 44 + row * (cellHeight + gap),
      width: cellWidth,
      height: cellHeight,
      drawioStyle: "fillColor=#e0f2fe;strokeColor=#0369a1;fontSize=11;",
    })
  }
  return { container, nodes }
}

function nextEvidenceSuggestions(diagramType: string, diagramIr: DiagramIr, gaps: string[]) {
  if (!gaps.length) return []
  if (diagramType === "state-machine") {
    return [{ tool: "chipmate_graph_find_state_machines", reason: "Collect state transition evidence before rendering a complete state-machine diagram.", args: { query: diagramIr.scope || diagramIr.title || "" } }]
  }
  if (diagramType === "code-flow" || diagramType === "call-flow") {
    return [{ tool: "chipmate_graph_expand_flow_slice", reason: "Collect entry-to-exit call and branch evidence before rendering a complete code flow.", args: { entry: diagramIr.scope || diagramIr.title || "" } }]
  }
  if (diagramType === "architecture" || diagramType === "soc-block") {
    return [{ tool: "chipmate_graph_map_module", reason: "Collect module boundaries and interface evidence before rendering a complete architecture diagram.", args: { query: diagramIr.scope || diagramIr.title || "" } }]
  }
  return [{ tool: "chipmate_search_code", reason: "Collect missing local evidence before claiming this diagram is complete.", args: { query: diagramIr.scope || diagramIr.title || "" } }]
}

function isStateLike(item: Record<string, unknown>) {
  const role = normalizeKey(stringValue(item.visualRole) || stringValue(item.role) || stringValue(item.type) || stringValue(item.shape))
  return role.includes("state") || role.includes("fsm")
}

function isModuleLike(item: Record<string, unknown>) {
  const role = normalizeKey(stringValue(item.visualRole) || stringValue(item.role) || stringValue(item.type) || stringValue(item.shape))
  return role.includes("module") ||
    role.includes("submodule") ||
    role.includes("lane") ||
    role.includes("container") ||
    role.includes("region")
}

function isTransitionLike(item: Record<string, unknown>) {
  const edgeKind = normalizeKey(stringValue(item.edgeKind) || stringValue(item.kind) || stringValue(item.type))
  const pathRole = normalizeKey(stringValue(item.pathRole) || stringValue(item.role))
  return edgeKind.includes("transition") ||
    edgeKind.includes("event") ||
    edgeKind.includes("guard") ||
    edgeKind.includes("condition") ||
    pathRole.includes("localtransition") ||
    pathRole.includes("feedback") ||
    pathRole.includes("crossmodule") ||
    pathRole.includes("cross-module")
}

function normalizeVisualPlan(input: unknown, warnings: string[]): DiagramIrVisualPlan | undefined {
  const record = asRecord(input)
  if (!record) return undefined
  const mainBackboneRecord = asRecord(record.mainBackbone)
  const legendRecord = asRecord(record.legend)
  const visualPlan: DiagramIrVisualPlan = {
    layoutProfile: stringValue(record.layoutProfile),
    mainBackbone: mainBackboneRecord
      ? {
        nodes: stringArray(mainBackboneRecord.nodes),
        edges: stringArray(mainBackboneRecord.edges),
        direction: stringValue(mainBackboneRecord.direction),
      }
      : undefined,
    edgePresentation: normalizeEdgePresentation(record.edgePresentation, warnings),
    legend: legendRecord
      ? {
        position: stringValue(legendRecord.position),
        title: stringValue(legendRecord.title),
        items: arrayRecords(legendRecord.items).map((item) => ({
          id: stringValue(item.id),
          marker: stringValue(item.marker),
          label: stringValue(item.label),
          text: stringValue(item.text),
          detail: stringValue(item.detail),
          nodeId: stringValue(item.nodeId),
          edgeId: stringValue(item.edgeId),
        })),
      }
      : undefined,
    buses: normalizeVisualPlanBuses(record.buses, warnings),
    regions: copyJsonValue(record.regions),
    styleHints: copyRecord(record.styleHints),
  }
  if (visualPlan.edgePresentation) {
    for (const [edgeId, presentation] of Object.entries(visualPlan.edgePresentation)) {
      const mode = normalizeKey(stringValue(presentation.mode))
      if (mode && !["line", "rail", "legend"].includes(mode)) {
        warnings.push(`VisualPlan edgePresentation for "${edgeId}" has unknown mode "${presentation.mode}"; use line, rail, or legend.`)
      }
      const rail = normalizeKey(stringValue(presentation.rail))
      if (rail && !["left", "right", "top", "bottom"].includes(rail)) {
        warnings.push(`VisualPlan edgePresentation for "${edgeId}" has unknown rail "${presentation.rail}"; use left, right, top, or bottom.`)
      }
    }
  }
  return visualPlan
}

function normalizeVisualPlanBuses(input: unknown, warnings: string[]) {
  const buses = arrayRecords(input)
  if (!buses.length) return undefined
  return buses.map((bus, index): DiagramIrVisualPlanBus => {
    const id = stringValue(bus.id) || `bus-${index + 1}`
    const trunk = asRecord(bus.trunk)
    const portHintsRecord = asRecord(bus.portHints)
    const portHints: Record<string, DiagramIrVisualPlanPortHint> = {}
    if (portHintsRecord) {
      for (const [key, value] of Object.entries(portHintsRecord)) {
        const record = asRecord(value)
        if (!record) {
          warnings.push(`VisualPlan bus "${id}" portHint "${key}" should be an object.`)
          continue
        }
        portHints[key] = {
          nodeId: stringValue(record.nodeId),
          containerId: stringValue(record.containerId),
          side: stringValue(record.side),
          order: numberHint(record.order),
        }
      }
    }
    return {
      id,
      label: stringValue(bus.label),
      edges: stringArray(bus.edges),
      direction: stringValue(bus.direction),
      trunk: trunk
        ? {
          orientation: stringValue(trunk.orientation),
          side: stringValue(trunk.side),
          lane: numberHint(trunk.lane),
          label: stringValue(trunk.label),
        }
        : undefined,
      junctions: arrayRecords(bus.junctions).map((junction, junctionIndex) => ({
        id: stringValue(junction.id) || `${id}-junction-${junctionIndex + 1}`,
        edges: stringArray(junction.edges),
        label: stringValue(junction.label),
        visible: booleanHint(junction.visible),
      })),
      portHints: Object.keys(portHints).length ? portHints : undefined,
    }
  })
}

function normalizeLegendOnlyVisualPlan(input: unknown): DiagramIrVisualPlan | undefined {
  const record = asRecord(input)
  const items = arrayRecords(record?.items)
  if (!record && !items.length) return undefined
  return {
    legend: {
      position: stringValue(record?.position) || "right",
      title: stringValue(record?.title) || "Legend / Evidence",
      items: items.map((item, index) => ({
        id: stringValue(item.id) || `legend-${index + 1}`,
        marker: stringValue(item.marker),
        label: stringValue(item.label),
        text: stringValue(item.text),
        detail: stringValue(item.detail),
        nodeId: stringValue(item.nodeId),
        edgeId: stringValue(item.edgeId),
      })),
    },
  }
}

function normalizeEdgePresentation(input: unknown, warnings: string[]) {
  const record = asRecord(input)
  if (!record) return undefined
  const result: Record<string, DiagramIrVisualPlanEdgePresentation> = {}
  for (const [edgeId, value] of Object.entries(record)) {
    const item = asRecord(value)
    if (!item) {
      warnings.push(`VisualPlan edgePresentation for "${edgeId}" should be an object.`)
      continue
    }
    result[edgeId] = {
      mode: stringValue(item.mode),
      rail: stringValue(item.rail),
      marker: stringValue(item.marker),
      label: stringValue(item.label),
      detail: stringValue(item.detail),
      style: item.style as DiagramIrVisualPlanEdgePresentation["style"],
      drawioStyle: item.drawioStyle as DiagramIrVisualPlanEdgePresentation["drawioStyle"],
    }
  }
  return result
}

function visualPlanReferenceMessages(input: {
  visualPlan: DiagramIrVisualPlan | undefined
  nodes: Record<string, unknown>[]
  edges: Record<string, unknown>[]
}) {
  const messages: string[] = []
  const plan = input.visualPlan
  if (!plan) return messages
  const nodeIds = new Set(input.nodes.map((node) => stringValue(node.id)).filter(Boolean))
  const edgeIds = new Set(input.edges.map((edge) => stringValue(edge.id)).filter(Boolean))
  for (const nodeId of plan.mainBackbone?.nodes ?? []) {
    if (!nodeIds.has(nodeId)) messages.push(`VisualPlan mainBackbone references unknown node "${nodeId}".`)
  }
  for (const edgeId of plan.mainBackbone?.edges ?? []) {
    if (!edgeIds.has(edgeId)) messages.push(`VisualPlan mainBackbone references unknown edge "${edgeId}".`)
  }
  for (const edgeId of Object.keys(plan.edgePresentation ?? {})) {
    if (!edgeIds.has(edgeId)) messages.push(`VisualPlan edgePresentation references unknown edge "${edgeId}".`)
  }
  for (const bus of plan.buses ?? []) {
    for (const edgeId of bus.edges ?? []) {
      if (!edgeIds.has(edgeId)) messages.push(`VisualPlan bus "${bus.id || "<unnamed>"}" references unknown edge "${edgeId}".`)
    }
    for (const junction of bus.junctions ?? []) {
      for (const edgeId of junction.edges ?? []) {
        if (!edgeIds.has(edgeId)) messages.push(`VisualPlan bus junction "${junction.id || "<unnamed>"}" references unknown edge "${edgeId}".`)
      }
    }
  }
  for (const item of plan.legend?.items ?? []) {
    if (item.nodeId && !nodeIds.has(item.nodeId)) messages.push(`VisualPlan legend item references unknown node "${item.nodeId}".`)
    if (item.edgeId && !edgeIds.has(item.edgeId)) messages.push(`VisualPlan legend item references unknown edge "${item.edgeId}".`)
  }
  return unique(messages)
}

function visualPlanBusAmbiguityIssues(input: {
  diagramType: string
  visualPlan: DiagramIrVisualPlan | undefined
  edges: Record<string, unknown>[]
}) {
  if (input.diagramType !== "soc-block" && input.diagramType !== "architecture") return []
  const visibleBusEdges = input.edges.filter((edge) => {
    const id = stringValue(edge.id)
    if (!id) return false
    const presentation = input.visualPlan?.edgePresentation?.[id]
    if (presentation && normalizeKey(stringValue(presentation.mode)) === "legend") return false
    const edgeKind = normalizeKey(stringValue(edge.edgeKind))
    const pathRole = normalizeKey(stringValue(edge.pathRole))
    return edgeKind === "bus" || pathRole === "bus"
  })
  if (visibleBusEdges.length < 2) return []
  const groupedEdges = new Set<string>()
  for (const bus of input.visualPlan?.buses ?? []) {
    for (const edgeId of bus.edges ?? []) groupedEdges.add(edgeId)
  }
  const byEndpoint = new Map<string, string[]>()
  for (const edge of visibleBusEdges) {
    const id = stringValue(edge.id)
    const source = stringValue(edge.source) || stringValue(edge.from)
    const target = stringValue(edge.target) || stringValue(edge.to)
    for (const endpoint of [source, target]) {
      if (!endpoint) continue
      const list = byEndpoint.get(endpoint) ?? []
      list.push(id)
      byEndpoint.set(endpoint, list)
    }
  }
  const refs: Array<{ kind?: string; id?: string; label?: string }> = []
  for (const [endpoint, edgeIds] of byEndpoint.entries()) {
    const ungrouped = edgeIds.filter((edgeId) => !groupedEdges.has(edgeId))
    if (ungrouped.length >= 2) {
      refs.push({ kind: "node", id: endpoint, label: ungrouped.slice(0, 4).join(", ") })
    }
  }
  if (!refs.length) return []
  return [{
    code: "diagram.visualPlan.bus_ambiguity",
    severity: "warning" as const,
    message: "Complex SoC/architecture DiagramIR has multiple visible bus edges sharing endpoints without visualPlan.buses grouping; ask the model/active skill to provide bus trunk, junction, or port hints instead of letting the renderer infer semantics.",
    refs: refs.slice(0, 6),
  }]
}

function structurallyDenseDiagram(nodes: Record<string, unknown>[], edges: Record<string, unknown>[], boundaries: Record<string, unknown>[]) {
  return nodes.length >= 6 || edges.length >= 8 || boundaries.length >= 2
}

function requiresPathVisualPlan(diagramType: string) {
  return diagramType === "business-flow" ||
    diagramType === "code-flow" ||
    diagramType === "call-flow" ||
    diagramType === "state-machine" ||
    diagramType === "flowchart"
}

function addValidationIssue(input: {
  issue: DiagramIrIssue
  issues: DiagramIrIssue[]
  warnings: string[]
  gaps: string[]
}) {
  input.issues.push(input.issue)
  input.warnings.push(input.issue.message)
  if (input.issue.severity === "blocking") input.gaps.push(input.issue.message)
}

function uniqueIssues(issues: DiagramIrIssue[]) {
  const seen = new Set<string>()
  const result: DiagramIrIssue[] = []
  for (const issue of issues) {
    const key = `${issue.code}:${issue.severity}:${issue.message}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(issue)
  }
  return result
}

function unusedBoundaryIssues(input: {
  boundaries: Record<string, unknown>[]
  nodes: Record<string, unknown>[]
  edges: Record<string, unknown>[]
  severity: DiagramIrIssueSeverity
}) {
  const issues: DiagramIrIssue[] = []
  const boundaryIds = new Set(input.boundaries.map((boundary) => stringValue(boundary.id)).filter(Boolean))
  if (!boundaryIds.size) return issues
  const assigned = new Set<string>()
  for (const node of input.nodes) {
    for (const key of ["parent", "region", "container", "group", "lane", "layer"]) {
      const value = stringValue(node[key])
      if (boundaryIds.has(value)) assigned.add(value)
    }
  }
  const incident = new Set<string>()
  for (const edge of input.edges) {
    for (const key of ["source", "from", "target", "to"]) {
      const value = stringValue(edge[key])
      if (boundaryIds.has(value)) incident.add(value)
    }
  }
  const childBoundaryParents = new Set<string>()
  for (const boundary of input.boundaries) {
    for (const key of ["parent", "region", "container", "group", "lane", "layer"]) {
      const value = stringValue(boundary[key])
      if (boundaryIds.has(value)) childBoundaryParents.add(value)
    }
  }
  for (const boundary of input.boundaries) {
    const id = stringValue(boundary.id)
    if (
      !id
      || assigned.has(id)
      || incident.has(id)
      || childBoundaryParents.has(id)
      || booleanHint(boundary.placeholder)
      || booleanHint(boundary.allowEmpty)
    ) continue
    const label = elementLabel(boundary)
    issues.push({
      code: "diagram.container.unresolved_ownership",
      severity: input.severity,
      message: `DiagramIR container "${label}" has no assigned nodes or incident edges; assign nodes with parent/container/lane/region/group, remove the empty container, or mark allowEmpty/placeholder if it is intentional.`,
      refs: [{ kind: "container", id, label }],
    })
  }
  return uniqueIssues(issues)
}

function legendLowInformationIssues(visualPlan: DiagramIrVisualPlan | undefined) {
  const issues: DiagramIrIssue[] = []
  for (const item of visualPlan?.legend?.items ?? []) {
    const label = [item.label, item.text, item.detail].map(stringValue).filter(Boolean).join(" ")
    const normalized = label.replace(/\s+/g, " ").trim()
    if (!normalized) continue
    const markerOnly = Boolean(item.marker) && normalized === item.marker
    const repeatsTruncatedIdentifier = /(?:\.\.\.|…)/.test(normalized) && /[A-Za-z_][A-Za-z0-9_.$:/-]{12,}/.test(normalized)
    const looksLikeBareIdentifier = normalized.length > 24 && /^[A-Za-z0-9_.$:/\-[\]\s]+$/.test(normalized) && !/\s(?:means|represents|indicates|because|when|说明|表示|代表|原因|条件|触发|进入)\s?/i.test(normalized)
    if (!markerOnly && !repeatsTruncatedIdentifier && !looksLikeBareIdentifier) continue
    issues.push({
      code: "diagram.legend.low_information",
      severity: "warning",
      message: `VisualPlan legend item "${item.id || item.marker || normalized.slice(0, 32)}" looks like a repeated/truncated identifier; provide explanatory legend content if the item should be visible.`,
      refs: [{ kind: "legend", id: item.id || item.marker, label: normalized.slice(0, 80) }],
    })
  }
  return issues
}

function booleanHint(input: unknown) {
  return input === true || (typeof input === "string" && /^(true|yes|1)$/i.test(input.trim()))
}

function numberHint(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : 0
}

function arrayHint(input: unknown) {
  return Array.isArray(input) ? input : []
}

function stringArray(input: unknown) {
  return Array.isArray(input) ? input.map((item) => stringValue(item)).filter(Boolean) : []
}

function normalizeLayout(input: unknown, diagramType: string) {
  if (typeof input === "string" && input.trim()) return input.trim()
  const record = asRecord(input)
  const value = stringValue(record?.kind) || stringValue(record?.type) || stringValue(record?.layout)
  return value || DEFAULT_LAYOUT_BY_TYPE[diagramType] || "flow"
}

function inferDiagramType(record: Record<string, unknown>) {
  if (arrayRecords(record.buses).length || arrayRecords(record.ports).length || arrayRecords(record.regions).length) return "soc-block"
  if (arrayRecords(record.lanes).length || arrayRecords(record.swimlanes).length) return "swimlane"
  return "flowchart"
}

function normalizeDiagramType(input: string) {
  const raw = normalizeKey(input || "flowchart")
  return DIAGRAM_TYPE_ALIASES[raw] || raw || "flowchart"
}

function hasEvidence(item: Record<string, unknown>) {
  return arrayValues(item.evidenceRefs).length > 0 || Boolean(stringValue(item.sourceKind))
}

function elementLabel(item: Record<string, unknown>) {
  return stringValue(item.id) || stringValue(item.label) || stringValue(item.title) || "element"
}

function safePassThrough(item: Record<string, unknown>) {
  const result: Record<string, unknown> = {}
  for (const key of [
    "role",
    "layer",
    "visualRole",
    "importance",
    "textParts",
    "edgeKind",
    "pathRole",
    "labelPriority",
    "sourceKind",
    "coverage",
    "placeholder",
    "allowEmpty",
    "containerMode",
    "layoutMode",
    "drawioStyle",
    "style",
  ]) {
    if (item[key] !== undefined) result[key] = copyJsonValue(item[key])
  }
  return result
}

function mergeStyle(input: unknown, extra: string) {
  return [typeof input === "string" ? input : "", extra].filter(Boolean).join(";")
}

function normalizeComposition(input: unknown, warnings: string[]): DiagramIrComposition {
  const record = asRecord(input)
  const raw = typeof input === "string"
    ? input
    : stringValue(record?.mode) || stringValue(record?.kind) || stringValue(record?.type)
  if (!raw) return { mode: "single" }
  const mode = normalizeCompositionMode(raw)
  if (!mode) {
    warnings.push(`Unknown DiagramIR composition "${raw}"; using single diagram mode.`)
    return { mode: "single" }
  }
  return {
    mode,
    reason: stringValue(record?.reason),
  }
}

function normalizeCompositionMode(input: string): DiagramIrCompositionMode | undefined {
  const key = normalizeKey(input)
  if (key === "single" || key === "one" || key === "primary") return "single"
  if (key === "multi" || key === "multiple" || key === "many" || key === "subdiagrams") return "multi"
  return undefined
}

function copyElements(items: Record<string, unknown>[]) {
  return items.map((item) => copyJsonValue(item)).filter((item): item is DiagramIrElement => Boolean(asRecord(item)))
}

function copyRecord(input: unknown) {
  return asRecord(copyJsonValue(input))
}

function copyJsonValue<T = unknown>(input: T): T {
  if (input === undefined) return undefined as T
  try {
    return JSON.parse(JSON.stringify(input)) as T
  } catch {
    return input
  }
}

function arrayRecords(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : []
}

function arrayValues(value: unknown) {
  return Array.isArray(value) ? value : []
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

function numberValue(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function clampInteger(value: unknown, min: number, max: number, fallback: number) {
  const number = typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback
  return Math.max(min, Math.min(max, number))
}

function compactText(input: string, maxLength: number) {
  const text = input.replace(/\s+/g, " ").trim()
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`
}

function normalizeKey(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9_-]+/g, "")
}

function unique(items: string[]) {
  return Array.from(new Set(items.filter(Boolean)))
}
