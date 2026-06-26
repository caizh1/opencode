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
  for (const message of unusedBoundaryMessages({
    boundaries: [...regions, ...containers, ...groups, ...lanes],
    nodes: [...nodes, ...ports, ...arrays],
    edges: [...edges, ...buses],
  })) {
    warnings.push(message)
    if (complexDiagram) gaps.push(message)
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
  addLegend(input.diagramIr.legend, nodes, containers)

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

function addLegend(legend: unknown, nodes: DrawioNodeSpec[], containers: DrawioContainerSpec[]) {
  const record = asRecord(legend)
  const items = arrayRecords(record?.items)
  if (!record && !items.length) return
  const id = stringValue(record?.id) || "legend"
  containers.push({
    id,
    label: stringValue(record?.title) || "Legend",
    x: numberValue(record?.x) ?? 880,
    y: numberValue(record?.y) ?? 40,
    width: numberValue(record?.width) ?? 220,
    height: numberValue(record?.height) ?? Math.max(90, items.length * 36 + 48),
    drawioStyle: "fillColor=#ffffff;strokeColor=#94a3b8;dashed=1;",
  })
  items.slice(0, 12).forEach((item, index) => {
    nodes.push({
      id: stringValue(item.id) || `legend-${index + 1}`,
      label: stringValue(item.label) || stringValue(item.text) || `Item ${index + 1}`,
      parent: id,
      shape: stringValue(item.shape) || "rectangle",
      x: 20,
      y: 42 + index * 32,
      width: 180,
      height: 24,
      drawioStyle: item.drawioStyle as DrawioNodeSpec["drawioStyle"],
    })
  })
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
  const label = normalizeKey(stringValue(item.label) || stringValue(item.title) || stringValue(item.text) || stringValue(item.id))
  return role.includes("state") ||
    role.includes("fsm") ||
    /(?:^|[-_])(idle|wait|dispatch|complete|done|busy|error|ready|reclaim|flush|scan|folding)(?:$|[-_])/.test(label)
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

function unusedBoundaryMessages(input: {
  boundaries: Record<string, unknown>[]
  nodes: Record<string, unknown>[]
  edges: Record<string, unknown>[]
}) {
  const messages: string[] = []
  const boundaryIds = new Set(input.boundaries.map((boundary) => stringValue(boundary.id)).filter(Boolean))
  if (!boundaryIds.size) return messages
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
  for (const boundary of input.boundaries) {
    const id = stringValue(boundary.id)
    if (!id || assigned.has(id) || incident.has(id) || booleanHint(boundary.placeholder) || booleanHint(boundary.allowEmpty)) continue
    const label = elementLabel(boundary)
    messages.push(`DiagramIR container "${label}" has no assigned nodes or incident edges; assign nodes with parent/container/lane/region/group, remove the empty container, or mark allowEmpty/placeholder if it is intentional.`)
  }
  return unique(messages)
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
