import { findDiagramIrInput, validateDiagramIr, type DiagramIr, type DiagramIrComposition, type DiagramIrCoverageReport } from "./diagram-ir"
import { compileDiagramDesign, type VisualPlan } from "./diagram-design-compiler"
import { applyElkLayoutToDrawio } from "./drawio-layout-engine"

export type DrawioStyleInput = string | Record<string, unknown>

export type DrawioGeometrySpec = {
  x?: number
  y?: number
  width?: number
  height?: number
}

export type DrawioPointSpec = {
  x?: number
  y?: number
}

export type DrawioNodeSpec = {
  id?: string
  label?: string
  text?: string
  shape?: string
  type?: string
  geometry?: DrawioGeometrySpec
  x?: number
  y?: number
  width?: number
  height?: number
  parent?: string
  group?: string
  container?: string
  lane?: string
  layer?: string
  style?: DrawioStyleInput
  drawioStyle?: DrawioStyleInput
  visualRole?: string
  importance?: number
  textParts?: Record<string, unknown>
}

export type DrawioEdgeSpec = {
  id?: string
  label?: string
  text?: string
  source?: string
  from?: string
  target?: string
  to?: string
  parent?: string
  layer?: string
  style?: DrawioStyleInput
  drawioStyle?: DrawioStyleInput
  points?: DrawioPointSpec[]
  edgeKind?: string
  pathRole?: string
  labelPriority?: string
}

export type DrawioContainerSpec = {
  id?: string
  label?: string
  title?: string
  parent?: string
  containerMode?: string
  layoutMode?: string
  placeholder?: boolean
  allowEmpty?: boolean
  geometry?: DrawioGeometrySpec
  x?: number
  y?: number
  width?: number
  height?: number
  style?: DrawioStyleInput
  drawioStyle?: DrawioStyleInput
}

export type DrawioSwimlaneSpec = DrawioContainerSpec

export type DrawioSequenceMessageSpec = {
  id?: string
  label?: string
  text?: string
  from?: string
  source?: string
  to?: string
  target?: string
  style?: DrawioStyleInput
  drawioStyle?: DrawioStyleInput
}

export type DrawioSequenceSpec = {
  participants?: DrawioNodeSpec[]
  messages?: DrawioSequenceMessageSpec[]
}

export type DrawioDiagramSpec = {
  title?: string
  diagramType?: string
  nodes?: DrawioNodeSpec[]
  edges?: DrawioEdgeSpec[]
  groups?: DrawioContainerSpec[]
  containers?: DrawioContainerSpec[]
  swimlanes?: DrawioSwimlaneSpec[]
  sequence?: DrawioSequenceSpec
  layout?: string | Record<string, unknown>
  theme?: string | Record<string, unknown>
  style?: DrawioStyleInput
  composition?: DiagramIrComposition
}

export type DrawioGeneratedDiagram = {
  kind: "drawio"
  diagramId: string
  title: string
  mxGraphModelXml: string
  warnings: string[]
  additionalDiagrams?: DrawioGeneratedDiagramPart[]
  normalizedSpec: {
    title: string
    diagramType: string
    layout: string
    layoutEngine: "elk"
    theme: string
    nodes: NormalizedNode[]
    edges: NormalizedEdge[]
    containers: NormalizedContainer[]
    composition?: DiagramIrComposition
    diagramIr?: DiagramIr
    coverageReport?: DiagramIrCoverageReport
    visualPlan?: VisualPlan
  }
  gaps?: string[]
  nextEvidenceSuggestions?: Array<{ tool: string; reason: string; args: Record<string, string> }>
  coverageReport?: DiagramIrCoverageReport
}

export type DrawioGeneratedDiagramPart = {
  kind: "drawio"
  diagramId: string
  title: string
  mxGraphModelXml: string
  warnings: string[]
}

export type Geometry = Required<DrawioGeometrySpec>

export type DrawioContainerLayoutMode = "strong-container" | "weak-band" | "layout-only"

export type NormalizedContainer = {
  id: string
  label: string
  kind: "group" | "container" | "swimlane"
  parent: string
  layoutMode: DrawioContainerLayoutMode
  explicitLayoutMode: boolean
  allowEmpty: boolean
  geometry: Geometry
  style: string
}

export type NormalizedNode = {
  id: string
  label: string
  sourceId?: string
  shape: string
  parent: string
  ownerContainer?: string
  geometry: Geometry
  style: string
  explicitGeometry: boolean
  visualRole?: string
  importance?: number
}

export type NormalizedEdge = {
  id: string
  label: string
  source?: string
  target?: string
  parent: string
  style: string
  points: DrawioPointSpec[]
  labelOffset?: DrawioPointSpec
  edgeKind?: string
  pathRole?: string
  labelPriority?: string
}

type NormalizationContext = {
  warnings: string[]
  usedIds: Set<string>
  rawToId: Map<string, string>
}

const MAX_NODES = 120
const MAX_EDGES = 220
const MAX_CONTAINERS = 48
const MAX_WARNINGS = 80
const DEFAULT_NODE_WIDTH = 168
const DEFAULT_NODE_HEIGHT = 64
const DEFAULT_CONTAINER_WIDTH = 720
const DEFAULT_CONTAINER_HEIGHT = 220

const KNOWN_LAYOUTS = new Set([
  "layered",
  "flow",
  "grid",
  "swimlane",
  "architecture",
  "embedded-fsm-flow",
  "sequence",
  "soc-block",
  "freeform",
])

const SHAPE_STYLES: Record<string, string> = {
  actor: "shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=0;",
  cloud: "ellipse;shape=cloud;whiteSpace=wrap;html=0;",
  container: "rounded=1;whiteSpace=wrap;html=0;container=1;collapsible=0;",
  database: "shape=cylinder3d;whiteSpace=wrap;html=0;boundedLbl=1;backgroundOutline=1;size=15;",
  decision: "rhombus;whiteSpace=wrap;html=0;",
  document: "shape=document;whiteSpace=wrap;html=0;boundedLbl=1;",
  group: "group;html=0;",
  hexagon: "shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=0;",
  note: "shape=note;whiteSpace=wrap;html=0;size=16;",
  process: "rounded=1;whiteSpace=wrap;html=0;",
  port: "rounded=1;whiteSpace=wrap;html=0;fontSize=10;",
  queue: "shape=partialRectangle;whiteSpace=wrap;html=0;right=0;",
  rectangle: "rounded=0;whiteSpace=wrap;html=0;",
  roundedrect: "rounded=1;whiteSpace=wrap;html=0;",
  swimlane: "swimlane;html=0;startSize=32;horizontal=1;collapsible=0;",
}

const SHAPE_ALIASES: Record<string, string> = {
  app: "roundedrect",
  box: "roundedrect",
  cylinder: "database",
  db: "database",
  diamond: "decision",
  end: "roundedrect",
  external: "cloud",
  file: "document",
  lane: "swimlane",
  person: "actor",
  pin: "port",
  port: "port",
  service: "roundedrect",
  start: "roundedrect",
  startend: "roundedrect",
  store: "database",
  terminal: "roundedrect",
  terminator: "roundedrect",
  user: "actor",
}

const EDGE_STYLE = "edgeStyle=orthogonalEdgeStyle;orthogonalLoop=1;jettySize=auto;endArrow=block;html=0;rounded=1;strokeWidth=2;labelBackgroundColor=#ffffff;fontSize=11;spacing=2;"

const THEMES: Record<string, { fill: string; stroke: string; font: string; accent: string; edge: string }> = {
  default: { fill: "#ffffff", stroke: "#6b7280", font: "#111827", accent: "#dbeafe", edge: "#4b5563" },
  light: { fill: "#ffffff", stroke: "#64748b", font: "#0f172a", accent: "#e0f2fe", edge: "#475569" },
  dark: { fill: "#1f2937", stroke: "#94a3b8", font: "#f8fafc", accent: "#334155", edge: "#cbd5e1" },
  colorful: { fill: "#f8fafc", stroke: "#2563eb", font: "#111827", accent: "#dcfce7", edge: "#2563eb" },
}

export async function generateDrawioDiagram(input: unknown): Promise<DrawioGeneratedDiagram> {
  const irValidation = findDiagramIrInput(input) ? validateDiagramIr(input) : undefined
  const rawSpec = irValidation?.drawioSpec ?? normalizeSpecInput(input)
  const warnings: string[] = [...(irValidation?.warnings ?? [])]
  const design = compileDiagramDesign({
    spec: rawSpec,
    diagramIr: irValidation?.diagramIr,
    warnings,
  })
  const spec = design.spec
  const context: NormalizationContext = {
    warnings: design.warnings,
    usedIds: new Set(["0", "1"]),
    rawToId: new Map(),
  }
  const title = compactText(stringField(spec, "title") || "Draw.io Diagram", 120)
  const diagramType = compactKey(stringField(spec, "diagramType") || inferDiagramType(spec), "flowchart")
  const layout = normalizeLayout(spec, diagramType, warnings)
  const themeName = normalizeTheme(spec.theme)
  const theme = THEMES[themeName] ?? THEMES.default
  const globalStyle = sanitizeStyle(spec.style, warnings, "diagram style")
  const composition = normalizeCompositionForSpec(spec.composition, warnings)
  let containers = normalizeContainers(spec, context, theme, globalStyle, layout)
  const nodes = normalizeNodes(spec, context, theme, globalStyle, layout, containers)
  const edges = normalizeEdges(spec, context, theme, globalStyle)
  const containerLayout = prepareContainersForLayout(containers, nodes, edges, warnings, design.visualPlan)

  if (nodes.length === 0) {
    warn(warnings, "Diagram had no nodes; inserted a placeholder node.")
    const id = nextId(context, "n", title, 1)
    nodes.push({
      id,
      label: title,
      shape: "roundedrect",
      parent: "1",
      geometry: { x: 40, y: 40, width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT },
      style: vertexStyle("roundedrect", theme, globalStyle, "", warnings),
      explicitGeometry: false,
    })
  }

  await applyElkLayoutToDrawio({ title, diagramType, layout, nodes, edges, containers: containerLayout.layoutContainers })
  containers = materializeRenderedContainers(containerLayout.renderedContainers, nodes, warnings, design.visualPlan)
  repairDrawioLayout(nodes, edges, warnings, design.visualPlan)
  applyDrawioQualityGate(nodes, edges, warnings, design.visualPlan)
  const xml = drawioXml(containers, nodes, edges)
  const diagramId = `drawio-${hashText(`${title}\n${xml}`).slice(0, 12)}`
  const generated: DrawioGeneratedDiagram = {
    kind: "drawio",
    diagramId,
    title,
    mxGraphModelXml: xml,
    warnings,
    normalizedSpec: {
      title,
      diagramType,
      layout,
      layoutEngine: "elk",
      theme: themeName,
      nodes,
      edges,
      containers,
      composition,
      diagramIr: irValidation?.diagramIr,
      coverageReport: irValidation?.coverageReport,
      visualPlan: design.visualPlan,
    },
    gaps: irValidation?.gaps,
    nextEvidenceSuggestions: irValidation?.nextEvidenceSuggestions,
    coverageReport: irValidation?.coverageReport,
  }
  const additionalDiagrams = await additionalDiagramsFromIr(irValidation?.diagramIr, warnings)
  if (additionalDiagrams.length) generated.additionalDiagrams = additionalDiagrams
  return generated
}

function normalizeSpecInput(input: unknown): DrawioDiagramSpec {
  const record = asRecord(input)
  const nested = asRecord(record?.spec)
  return (nested ?? record) as DrawioDiagramSpec
}

async function additionalDiagramsFromIr(diagramIr: DiagramIr | undefined, warnings: string[]): Promise<DrawioGeneratedDiagramPart[]> {
  if (!diagramIr || diagramIr.composition?.mode !== "multi") return []
  const subdiagrams = arrayRecords(diagramIr.subdiagrams)
  if (!subdiagrams.length) {
    warn(warnings, "DiagramIR composition.mode is multi but no subdiagrams were provided; rendered only the primary diagram.")
    return []
  }
  if (subdiagrams.length > 8) {
    warn(warnings, `Rendered the first 8 subdiagrams out of ${subdiagrams.length}; ask for a narrower scope to render the rest.`)
  }
  const result: DrawioGeneratedDiagramPart[] = []
  for (const [index, item] of subdiagrams.slice(0, 8).entries()) {
    const nested = asRecord(item.diagramIr) ?? item
    const childIr = {
      ...nested,
      version: stringField(nested, "version") || "diagram-ir/v1",
      title: stringField(nested, "title") || stringField(nested, "label") || `${diagramIr.title || "Diagram"} ${index + 1}`,
      diagramType: stringField(nested, "diagramType") || diagramIr.diagramType || "flowchart",
      composition: { mode: "single" as const, reason: "Rendered from an explicit multi-diagram DiagramIR subdiagram." },
    }
    const child = await generateDrawioDiagram({ diagramIr: childIr })
    result.push({
      kind: "drawio" as const,
      diagramId: child.diagramId,
      title: child.title,
      mxGraphModelXml: child.mxGraphModelXml,
      warnings: child.warnings,
    })
  }
  return result
}

function inferDiagramType(spec: DrawioDiagramSpec) {
  if (spec.sequence) return "sequence"
  if (arrayRecords(spec.swimlanes).length > 0) return "swimlane"
  if (stringField(asRecord(spec.layout), "kind") === "soc-block" || stringField(asRecord(spec.layout), "type") === "soc-block") return "soc-block"
  if (arrayRecords(spec.containers).length > 0) return "architecture"
  return "flowchart"
}

function normalizeLayout(spec: DrawioDiagramSpec, diagramType: string, warnings: string[]) {
  const value = typeof spec.layout === "string"
    ? spec.layout
    : stringField(asRecord(spec.layout), "kind") || stringField(asRecord(spec.layout), "type")
  const layout = compactKey(value || diagramType || "layered", "layered")
  if (KNOWN_LAYOUTS.has(layout)) return layout
  warn(warnings, `Unknown layout "${layout}"; using layered layout.`)
  return "layered"
}

function normalizeTheme(input: unknown) {
  const key = compactKey(typeof input === "string" ? input : "", "default")
  return Object.prototype.hasOwnProperty.call(THEMES, key) ? key : "default"
}

function containerLayoutMode(item: Record<string, unknown>, layout: string): { mode: DrawioContainerLayoutMode; explicit: boolean } {
  const raw = stringField(item, "containerMode") || stringField(item, "layoutMode")
  const key = compactKey(raw, "")
  if (key) {
    if (["strong", "strongcontainer", "compound", "parent"].includes(key)) return { mode: "strong-container", explicit: true }
    if (["weak", "weakband", "band", "background", "ownership"].includes(key)) return { mode: "weak-band", explicit: true }
    if (["layoutonly", "scaffold", "hint"].includes(key)) return { mode: "layout-only", explicit: true }
  }
  return { mode: layout === "embedded-fsm-flow" ? "weak-band" : "strong-container", explicit: false }
}

function normalizeCompositionForSpec(input: unknown, warnings: string[]): DiagramIrComposition {
  const record = asRecord(input)
  const raw = typeof input === "string"
    ? input
    : stringField(record, "mode") || stringField(record, "kind") || stringField(record, "type")
  if (!raw) return { mode: "single" }
  const key = compactKey(raw, "single")
  if (key === "single" || key === "one" || key === "primary") {
    return { mode: "single", reason: stringField(record, "reason") }
  }
  if (key === "multi" || key === "multiple" || key === "many" || key === "subdiagrams") {
    return { mode: "multi", reason: stringField(record, "reason") }
  }
  warn(warnings, `Unknown DiagramIR composition "${raw}"; using single diagram mode.`)
  return { mode: "single" }
}

function normalizeContainers(spec: DrawioDiagramSpec, context: NormalizationContext, theme: NonNullable<typeof THEMES.default>, globalStyle: string, layout: string) {
  const source = [
    ...limited(arrayRecords(spec.groups), MAX_CONTAINERS, context.warnings, "groups").map((item) => ({ item, kind: "group" as const })),
    ...limited(arrayRecords(spec.containers), MAX_CONTAINERS, context.warnings, "containers").map((item) => ({ item, kind: "container" as const })),
    ...limited(arrayRecords(spec.swimlanes), MAX_CONTAINERS, context.warnings, "swimlanes").map((item) => ({ item, kind: "swimlane" as const })),
  ].slice(0, MAX_CONTAINERS)
  const containers: NormalizedContainer[] = []
  source.forEach(({ item, kind }, index) => {
    const label = diagramLabel(stringField(item, "label") || stringField(item, "title") || `${kind} ${index + 1}`, 180, 28, 3)
    const rawId = stringField(item, "id") || label
    const id = nextId(context, kind === "swimlane" ? "lane" : "g", rawId, index + 1)
    context.rawToId.set(rawId, id)
    if (stringField(item, "id")) context.rawToId.set(stringField(item, "id"), id)
    const parent = parentId(item, context, "1")
    const mode = containerLayoutMode(item, layout)
    containers.push({
      id,
      label,
      kind,
      parent,
      layoutMode: mode.mode,
      explicitLayoutMode: mode.explicit,
      allowEmpty: booleanField(item, "allowEmpty") || booleanField(item, "placeholder"),
      geometry: geometryFromSpec(item, {
        x: 40,
        y: 40 + index * (layout === "swimlane" ? 210 : 250),
        width: DEFAULT_CONTAINER_WIDTH,
        height: kind === "swimlane" ? 180 : DEFAULT_CONTAINER_HEIGHT,
      }),
      style: containerStyle(kind, theme, globalStyle, sanitizeStyle(item.drawioStyle ?? item.style, context.warnings, `${kind} style`), mode.mode),
    })
  })
  return containers
}

function prepareContainersForLayout(
  containers: NormalizedContainer[],
  nodes: NormalizedNode[],
  edges: NormalizedEdge[],
  warnings: string[],
  visualPlan: VisualPlan,
) {
  if (visualPlan.profile !== "embedded-fsm-flow") {
    return {
      layoutContainers: containers.filter((container) => container.layoutMode !== "layout-only"),
      renderedContainers: containers.filter((container) => container.layoutMode !== "layout-only"),
    }
  }
  let current = containers.map((container) => ({ ...container }))
  let changed = true
  while (changed) {
    changed = false
    const childCounts = containerChildCounts(current, nodes)
    const incidentCounts = containerIncidentCounts(current, edges)
    const next: NormalizedContainer[] = []
    for (const container of current) {
      const childCount = childCounts.get(container.id) ?? 0
      const incidentCount = incidentCounts.get(container.id) ?? 0
      if (container.layoutMode === "layout-only" && incidentCount > 0) {
        warn(warnings, `Container "${container.label}" was marked layout-only but has incident edges; kept it as a visible endpoint so edges can route to a real cell.`)
        next.push({ ...container, layoutMode: "strong-container" })
        continue
      }
      if (container.explicitLayoutMode && container.layoutMode === "strong-container") {
        next.push(container)
        continue
      }
      if (incidentCount > 0) {
        next.push({ ...container, layoutMode: "strong-container" })
        continue
      }
      if (childCount > 0) {
        next.push({ ...container, layoutMode: "weak-band" })
        continue
      }
      if (container.allowEmpty) {
        warn(warnings, `Allowed empty container "${container.label}" because it is marked allowEmpty/placeholder.`)
        next.push({ ...container, layoutMode: "weak-band" })
        continue
      }
      warn(warnings, `Converted empty container "${container.label}" to layout-only scaffold in embedded-fsm-flow; it will not be rendered as an isolated flow block. Assign nodes with parent/container/lane/region/group or mark allowEmpty/placeholder to keep an intentional visible region.`)
      changed = true
    }
    current = next
  }
  const renderedContainers = current.filter((container) => container.layoutMode !== "layout-only")
  const layoutContainers = renderedContainers.filter((container) => container.layoutMode === "strong-container")
  return { layoutContainers, renderedContainers }
}

function materializeRenderedContainers(
  containers: NormalizedContainer[],
  nodes: NormalizedNode[],
  warnings: string[],
  visualPlan: VisualPlan,
) {
  if (visualPlan.profile !== "embedded-fsm-flow") return containers
  return containers.flatMap((container) => {
    if (container.layoutMode !== "weak-band") return container
    const ownedNodes = nodes.filter((node) => node.ownerContainer === container.id)
    if (ownedNodes.length === 1 && !container.allowEmpty) {
      warn(warnings, `Skipped singleton weak-band "${container.label}" in embedded-fsm-flow; single-node ownership is kept as metadata instead of drawing a large background region.`)
      return []
    }
    if (!ownedNodes.length) return {
      ...container,
      parent: "1",
    }
    const geometry = boundingBandGeometry(ownedNodes)
    warn(warnings, `Rendered embedded-fsm-flow container "${container.label}" as a weak background band so flow edges stay on the root layout plane.`)
    return {
      ...container,
      parent: "1",
      geometry,
    }
  })
}

function boundingBandGeometry(nodes: NormalizedNode[]): Geometry {
  const minX = Math.min(...nodes.map((node) => node.geometry.x))
  const minY = Math.min(...nodes.map((node) => node.geometry.y))
  const maxX = Math.max(...nodes.map((node) => node.geometry.x + node.geometry.width))
  const maxY = Math.max(...nodes.map((node) => node.geometry.y + node.geometry.height))
  const horizontalPadding = 48
  const topPadding = 56
  const bottomPadding = 36
  return {
    x: Math.max(0, minX - horizontalPadding),
    y: Math.max(0, minY - topPadding),
    width: Math.max(220, maxX - minX + horizontalPadding * 2),
    height: Math.max(120, maxY - minY + topPadding + bottomPadding),
  }
}

function repairDrawioLayout(nodes: NormalizedNode[], edges: NormalizedEdge[], warnings: string[], visualPlan: VisualPlan) {
  if (visualPlan.profile !== "embedded-fsm-flow") return
  visualPlan.qualityGate.repairPasses += 1
  const overlapRepairs = fanOutOverlappingEdgeSegments(edges)
  if (overlapRepairs > 0) {
    visualPlan.qualityGate.edgeOverlapRepairs += overlapRepairs
    warn(warnings, `Design compiler repaired ${overlapRepairs} overlapping embedded-FSM edge segment(s) by fanning out parallel rails.`)
  }
  const passThroughRepairs = rerouteEdgesPassingThroughNodes(nodes, edges)
  if (passThroughRepairs > 0) {
    visualPlan.qualityGate.edgePassThroughRepairs += passThroughRepairs
    warn(warnings, `Design compiler repaired ${passThroughRepairs} embedded-FSM edge segment(s) that passed through nodes.`)
  }
}

function fanOutOverlappingEdgeSegments(edges: NormalizedEdge[]) {
  let repairs = 0
  const groups = new Map<string, Array<{ edge: NormalizedEdge; pointIndex: number; orientation: "vertical" | "horizontal" }>>()
  for (const edge of edges) {
    for (let index = 0; index < edge.points.length - 1; index += 1) {
      const start = edge.points[index]
      const end = edge.points[index + 1]
      if (!isFinitePoint(start) || !isFinitePoint(end)) continue
      if (Math.abs((start.x ?? 0) - (end.x ?? 0)) <= 1) {
        const x = Math.round(start.x ?? 0)
        const minY = Math.round(Math.min(start.y ?? 0, end.y ?? 0) / 40)
        const maxY = Math.round(Math.max(start.y ?? 0, end.y ?? 0) / 40)
        const key = `v:${x}:${minY}:${maxY}`
        const list = groups.get(key) ?? []
        list.push({ edge, pointIndex: index, orientation: "vertical" })
        groups.set(key, list)
      } else if (Math.abs((start.y ?? 0) - (end.y ?? 0)) <= 1) {
        const y = Math.round(start.y ?? 0)
        const minX = Math.round(Math.min(start.x ?? 0, end.x ?? 0) / 40)
        const maxX = Math.round(Math.max(start.x ?? 0, end.x ?? 0) / 40)
        const key = `h:${y}:${minX}:${maxX}`
        const list = groups.get(key) ?? []
        list.push({ edge, pointIndex: index, orientation: "horizontal" })
        groups.set(key, list)
      }
    }
  }
  for (const list of groups.values()) {
    const uniqueEdges = Array.from(new Map(list.map((item) => [item.edge.id, item])).values())
    if (uniqueEdges.length < 2) continue
    const spacing = 18
    const center = (uniqueEdges.length - 1) / 2
    uniqueEdges.forEach((item, index) => {
      const offset = (index - center) * spacing
      const start = item.edge.points[item.pointIndex]
      const end = item.edge.points[item.pointIndex + 1]
      if (!isFinitePoint(start) || !isFinitePoint(end)) return
      if (item.orientation === "vertical") {
        start.x = (start.x ?? 0) + offset
        end.x = (end.x ?? 0) + offset
      } else {
        start.y = (start.y ?? 0) + offset
        end.y = (end.y ?? 0) + offset
      }
      repairs += 1
    })
  }
  return repairs
}

function rerouteEdgesPassingThroughNodes(nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  let repairs = 0
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  for (const edge of edges) {
    if (!edge.source || !edge.target) continue
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (!source || !target) continue
    if (!edge.points.length) {
      edge.points = [centerPoint(source.geometry), centerPoint(target.geometry)]
    }
    for (let index = 0; index < edge.points.length - 1; index += 1) {
      const start = edge.points[index]
      const end = edge.points[index + 1]
      if (!isFinitePoint(start) || !isFinitePoint(end)) continue
      for (const node of nodes) {
        if (node.id === edge.source || node.id === edge.target) continue
        if (!segmentIntersectsBox({ x: start.x ?? 0, y: start.y ?? 0 }, { x: end.x ?? 0, y: end.y ?? 0 }, node.geometry)) continue
        const detour = detourAroundBox(start, end, node.geometry)
        if (!detour.length) continue
        edge.points.splice(index + 1, 0, ...detour)
        repairs += 1
        index += detour.length
        break
      }
    }
  }
  return repairs
}

function detourAroundBox(start: DrawioPointSpec, end: DrawioPointSpec, box: Geometry): DrawioPointSpec[] {
  if (!isFinitePoint(start) || !isFinitePoint(end)) return []
  const sx = start.x ?? 0
  const sy = start.y ?? 0
  const ex = end.x ?? 0
  const ey = end.y ?? 0
  const margin = 28
  if (Math.abs(sx - ex) <= 1) {
    const sideX = sx < box.x + box.width / 2 ? box.x - margin : box.x + box.width + margin
    return [{ x: sideX, y: sy }, { x: sideX, y: ey }]
  }
  if (Math.abs(sy - ey) <= 1) {
    const sideY = sy < box.y + box.height / 2 ? box.y - margin : box.y + box.height + margin
    return [{ x: sx, y: sideY }, { x: ex, y: sideY }]
  }
  const sideX = sx < box.x + box.width / 2 ? box.x - margin : box.x + box.width + margin
  return [{ x: sideX, y: sy }, { x: sideX, y: ey }]
}

function isFinitePoint(point: DrawioPointSpec | undefined): point is Required<DrawioPointSpec> {
  return Boolean(point && Number.isFinite(point.x) && Number.isFinite(point.y))
}

function containerChildCounts(containers: NormalizedContainer[], nodes: NormalizedNode[]) {
  const counts = new Map<string, number>()
  for (const container of containers) counts.set(container.id, 0)
  for (const node of nodes) {
    if (node.ownerContainer && counts.has(node.ownerContainer)) {
      counts.set(node.ownerContainer, (counts.get(node.ownerContainer) ?? 0) + 1)
      continue
    }
    if (counts.has(node.parent)) counts.set(node.parent, (counts.get(node.parent) ?? 0) + 1)
  }
  for (const container of containers) {
    if (counts.has(container.parent)) counts.set(container.parent, (counts.get(container.parent) ?? 0) + 1)
  }
  return counts
}

function containerIncidentCounts(containers: NormalizedContainer[], edges: NormalizedEdge[]) {
  const counts = new Map<string, number>()
  for (const container of containers) counts.set(container.id, 0)
  for (const edge of edges) {
    if (edge.source && counts.has(edge.source)) counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1)
    if (edge.target && counts.has(edge.target)) counts.set(edge.target, (counts.get(edge.target) ?? 0) + 1)
  }
  return counts
}

function normalizeNodes(
  spec: DrawioDiagramSpec,
  context: NormalizationContext,
  theme: NonNullable<typeof THEMES.default>,
  globalStyle: string,
  layout: string,
  containers: NormalizedContainer[],
) {
  const rawNodes = limited(arrayRecords(spec.nodes), MAX_NODES, context.warnings, "nodes")
  const sequence = asRecord(spec.sequence)
  const sequenceParticipants = limited(arrayRecords(sequence?.participants), MAX_NODES, context.warnings, "sequence participants")
  const participantsFromMessages = sequenceParticipantRecords(sequence)
  const nodes: NormalizedNode[] = []
  const addNode = (item: Record<string, unknown>, index: number, source: "node" | "participant") => {
    const label = diagramLabel(stringField(item, "label") || stringField(item, "text") || stringField(item, "id") || `${source} ${index + 1}`, 260, source === "participant" ? 24 : 30, 5)
    const rawId = stringField(item, "id") || label
    const id = nextId(context, source === "participant" ? "p" : "n", rawId, index + 1)
    context.rawToId.set(rawId, id)
    if (stringField(item, "id")) context.rawToId.set(stringField(item, "id"), id)
    context.rawToId.set(label, id)
    const rawShape = stringField(item, "shape") || stringField(item, "type") || (source === "participant" ? "actor" : "roundedrect")
    const shape = safeShape(rawShape, context.warnings)
    const explicitGeometry = hasGeometry(item)
    const parentAssignment = nodeParentAssignment(item, context, containers)
    const parent = parentAssignment.parent
    const indexInParent = nodes.filter((candidate) => candidate.parent === parent).length
    const fallbackGeometry = autoSizeGeometry(defaultNodeGeometry(indexInParent, layout, source === "participant"), label, shape, layout)
    nodes.push({
      id,
      sourceId: rawId,
      label,
      shape,
      parent,
      ownerContainer: parentAssignment.ownerContainer,
      geometry: geometryFromSpec(item, fallbackGeometry),
      style: vertexStyle(shape, theme, globalStyle, sanitizeStyle(item.drawioStyle ?? item.style, context.warnings, `node "${label}" style`), context.warnings),
      explicitGeometry,
      visualRole: stringField(item, "visualRole") || stringField(item, "role"),
      importance: numberField(item, "importance"),
    })
  }
  rawNodes.forEach((item, index) => addNode(item, index, "node"))
  if (sequence) {
    const participants = sequenceParticipants.length ? sequenceParticipants : participantsFromMessages
    participants.forEach((item, index) => addNode(item, rawNodes.length + index, "participant"))
  }
  return nodes
}

function normalizeEdges(
  spec: DrawioDiagramSpec,
  context: NormalizationContext,
  theme: NonNullable<typeof THEMES.default>,
  globalStyle: string,
) {
  const rawEdges = limited(arrayRecords(spec.edges), MAX_EDGES, context.warnings, "edges")
  const sequence = asRecord(spec.sequence)
  const sequenceMessages = limited(arrayRecords(sequence?.messages), MAX_EDGES, context.warnings, "sequence messages")
  const combined = [
    ...rawEdges.map((item) => ({ item, kind: "edge" })),
    ...sequenceMessages.map((item) => ({ item, kind: "message" })),
  ].slice(0, MAX_EDGES)
  return combined.map(({ item, kind }, index): NormalizedEdge => {
    const label = diagramLabel(stringField(item, "label") || stringField(item, "text") || "", 120, 22, 3)
    const rawId = stringField(item, "id") || label || `${kind}-${index + 1}`
    const id = nextId(context, kind === "message" ? "m" : "e", rawId, index + 1)
    const sourceRaw = stringField(item, "source") || stringField(item, "from")
    const targetRaw = stringField(item, "target") || stringField(item, "to")
    const source = sourceRaw ? context.rawToId.get(sourceRaw) : undefined
    const target = targetRaw ? context.rawToId.get(targetRaw) : undefined
    if (sourceRaw && !source) warn(context.warnings, `Edge "${label || id}" references unknown source "${sourceRaw}".`)
    if (targetRaw && !target) warn(context.warnings, `Edge "${label || id}" references unknown target "${targetRaw}".`)
    if (!sourceRaw && !targetRaw) warn(context.warnings, `Edge "${label || id}" has no source or target.`)
    return {
      id,
      label,
      source,
      target,
      parent: parentId(item, context, "1"),
      style: edgeStyle(theme, globalStyle, sanitizeStyle(item.drawioStyle ?? item.style, context.warnings, `edge "${label || id}" style`)),
      points: arrayRecords(item.points).map((point) => ({
        x: numberField(point, "x"),
        y: numberField(point, "y"),
      })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)),
      edgeKind: stringField(item, "edgeKind"),
      pathRole: stringField(item, "pathRole"),
      labelPriority: stringField(item, "labelPriority"),
    }
  })
}

function sequenceParticipantRecords(sequence: Record<string, unknown> | undefined) {
  const seen = new Set<string>()
  const result: Record<string, unknown>[] = []
  for (const message of arrayRecords(sequence?.messages)) {
    for (const key of ["from", "source", "to", "target"]) {
      const value = stringField(message, key)
      if (!value || seen.has(value)) continue
      seen.add(value)
      result.push({ id: value, label: value, shape: "actor" })
    }
  }
  return result
}

function autoSizeGeometry(fallback: Geometry, label: string, shape: string, layout: string): Geometry {
  if (!label) return fallback
  const labelLines = label.split(/\r\n|\r|\n/).filter(Boolean)
  const weighted = Math.max(...(labelLines.length ? labelLines : [label]).map(weightedTextLength))
  const compactLayout = layout === "architecture" || layout === "soc-block"
  const minWidth = compactLayout ? fallback.width : Math.max(fallback.width, 210)
  const maxWidth = compactLayout ? 300 : 380
  const targetWidth = Math.max(minWidth, Math.min(maxWidth, 120 + weighted * (compactLayout ? 3.2 : 4.2)))
  const charsPerLine = Math.max(8, Math.floor(targetWidth / 8.6))
  const lines = Math.max(labelLines.length || 1, Math.ceil(weighted / charsPerLine))
  const baseHeight = shape === "decision" ? 82 : fallback.height
  const targetHeight = Math.max(baseHeight, Math.min(220, 30 + lines * 22))
  return { ...fallback, width: Math.round(targetWidth), height: Math.round(targetHeight) }
}

function weightedTextLength(label: string) {
  let total = 0
  for (const char of label) {
    if (/\s/.test(char)) total += 0.45
    else if (/[\u3400-\u9fff\uff00-\uffef]/.test(char)) total += 1.9
    else if (/[A-Z0-9_/().:-]/.test(char)) total += 1.15
    else total += 1
  }
  return total
}

function defaultNodeGeometry(index: number, layout: string, participant: boolean): Geometry {
  if (participant) return { x: 60 + index * 210, y: 40, width: 132, height: 56 }
  if (layout === "architecture" || layout === "soc-block") return { x: 60 + (index % 3) * 230, y: 60 + Math.floor(index / 3) * 130, width: 172, height: 72 }
  return { x: 60 + (index % 3) * 220, y: 60 + Math.floor(index / 3) * 120, width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT }
}

function drawioXml(containers: NormalizedContainer[], nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  const cells = [
    "<mxCell id=\"0\"/>",
    "<mxCell id=\"1\" parent=\"0\"/>",
    ...containers.map(containerCellXml),
    ...nodes.map(nodeCellXml),
    ...edges.map(edgeCellXml),
  ]
  return [
    "<mxGraphModel dx=\"1200\" dy=\"800\" grid=\"1\" gridSize=\"10\" guides=\"1\" tooltips=\"1\" connect=\"1\" arrows=\"1\" fold=\"1\" page=\"1\" pageScale=\"1\" pageWidth=\"1169\" pageHeight=\"827\" math=\"0\" shadow=\"0\">",
    "  <root>",
    ...cells.map((cell) => `    ${cell}`),
    "  </root>",
    "</mxGraphModel>",
  ].join("\n")
}

function containerCellXml(container: NormalizedContainer) {
  return `<mxCell id="${xmlAttr(container.id)}" value="${xmlAttr(container.label)}" style="${xmlAttr(container.style)}" parent="${xmlAttr(container.parent)}" vertex="1"><mxGeometry x="${num(container.geometry.x)}" y="${num(container.geometry.y)}" width="${num(container.geometry.width)}" height="${num(container.geometry.height)}" as="geometry"/></mxCell>`
}

function nodeCellXml(node: NormalizedNode) {
  return `<mxCell id="${xmlAttr(node.id)}" value="${xmlAttr(node.label)}" style="${xmlAttr(node.style)}" parent="${xmlAttr(node.parent)}" vertex="1"><mxGeometry x="${num(node.geometry.x)}" y="${num(node.geometry.y)}" width="${num(node.geometry.width)}" height="${num(node.geometry.height)}" as="geometry"/></mxCell>`
}

function edgeCellXml(edge: NormalizedEdge) {
  const source = edge.source ? ` source="${xmlAttr(edge.source)}"` : ""
  const target = edge.target ? ` target="${xmlAttr(edge.target)}"` : ""
  const labelOffset = edge.labelOffset && Number.isFinite(edge.labelOffset.x) && Number.isFinite(edge.labelOffset.y)
    ? `<mxPoint x="${num(edge.labelOffset.x ?? 0)}" y="${num(edge.labelOffset.y ?? 0)}" as="offset"/>`
    : ""
  if (!edge.points.length) {
    return `<mxCell id="${xmlAttr(edge.id)}" value="${xmlAttr(edge.label)}" style="${xmlAttr(edge.style)}" parent="${xmlAttr(edge.parent)}"${source}${target} edge="1"><mxGeometry relative="1" as="geometry">${labelOffset}</mxGeometry></mxCell>`
  }
  const points = edge.points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => `<mxPoint x="${num(point.x ?? 0)}" y="${num(point.y ?? 0)}"/>`)
    .join("")
  return `<mxCell id="${xmlAttr(edge.id)}" value="${xmlAttr(edge.label)}" style="${xmlAttr(edge.style)}" parent="${xmlAttr(edge.parent)}"${source}${target} edge="1"><mxGeometry relative="1" as="geometry"><Array as="points">${points}</Array>${labelOffset}</mxGeometry></mxCell>`
}

function applyDrawioQualityGate(nodes: NormalizedNode[], edges: NormalizedEdge[], warnings: string[], visualPlan: VisualPlan) {
  const qualityWarnings: string[] = []
  const overlaps = nodeOverlapWarnings(nodes)
  qualityWarnings.push(...overlaps.slice(0, 6))
  const passThrough = edgePassThroughWarnings(nodes, edges)
  qualityWarnings.push(...passThrough.slice(0, 6))
  if (visualPlan.profile === "embedded-fsm-flow") {
    qualityWarnings.push(...embeddedFsmFlowWarnings(nodes, edges))
  }
  for (const message of qualityWarnings.slice(0, 10)) {
    warn(warnings, message)
    if (!visualPlan.qualityGate.warnings.includes(message)) visualPlan.qualityGate.warnings.push(message)
  }
}

function embeddedFsmFlowWarnings(nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  const warnings: string[] = []
  const crossModuleEdges = edges.filter((edge) => /cross-module|feedback|backtrack|bus|data/i.test(`${edge.pathRole ?? ""} ${edge.edgeKind ?? ""}`))
  const stateNodes = nodes.filter((node) => /state/i.test(node.visualRole ?? ""))
  if (crossModuleEdges.length > Math.max(4, Math.ceil(nodes.length / 3))) {
    warnings.push(`Design compiler quality gate detected ${crossModuleEdges.length} cross-module/feedback edge(s) in embedded-fsm-flow; consider stronger lane ownership, bus grouping, or an explicit user-approved split diagram.`)
  }
  if (stateNodes.length > 0 && stateNodes.length < 3 && edges.some((edge) => /transition/i.test(`${edge.edgeKind ?? ""} ${edge.pathRole ?? ""}`))) {
    warnings.push("Design compiler quality gate detected transition edges but too few explicit state nodes; provide visualRole='state' nodes to improve embedded FSM clustering.")
  }
  return warnings
}

function nodeOverlapWarnings(nodes: NormalizedNode[]) {
  const warnings: string[] = []
  for (let outer = 0; outer < nodes.length; outer += 1) {
    for (let inner = outer + 1; inner < nodes.length; inner += 1) {
      const a = nodes[outer]
      const b = nodes[inner]
      if (!a || !b || a.parent !== b.parent) continue
      const area = intersectionArea(a.geometry, b.geometry)
      if (area <= 24) continue
      warnings.push(`Design compiler quality gate detected overlapping nodes "${a.label.replace(/\n/g, " ")}" and "${b.label.replace(/\n/g, " ")}"; consider adding stronger grouping, ports, or allowing a split diagram.`)
      if (warnings.length >= 6) return warnings
    }
  }
  return warnings
}

function edgePassThroughWarnings(nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  const warnings: string[] = []
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  for (const edge of edges) {
    if (!edge.source || !edge.target) continue
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (!source || !target) continue
    const points = [
      centerPoint(source.geometry),
      ...edge.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)).map((point) => ({ x: point.x ?? 0, y: point.y ?? 0 })),
      centerPoint(target.geometry),
    ]
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index]
      const end = points[index + 1]
      if (!start || !end) continue
      for (const node of nodes) {
        if (node.id === edge.source || node.id === edge.target) continue
        if (segmentIntersectsBox(start, end, node.geometry)) {
          warnings.push(`Design compiler quality gate detected edge "${edge.label || edge.id}" passing through node "${node.label.replace(/\n/g, " ")}"; consider adding port hints, bus grouping, or lowering that edge priority.`)
          if (warnings.length >= 6) return warnings
        }
      }
    }
  }
  return warnings
}

function intersectionArea(a: Geometry, b: Geometry) {
  const x = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const y = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return x * y
}

function centerPoint(geometry: Geometry) {
  return {
    x: geometry.x + geometry.width / 2,
    y: geometry.y + geometry.height / 2,
  }
}

function segmentIntersectsBox(start: { x: number; y: number }, end: { x: number; y: number }, box: Geometry) {
  const padding = 6
  const left = box.x - padding
  const right = box.x + box.width + padding
  const top = box.y - padding
  const bottom = box.y + box.height + padding
  if (start.x === end.x) {
    const x = start.x
    if (x < left || x > right) return false
    const minY = Math.min(start.y, end.y)
    const maxY = Math.max(start.y, end.y)
    return maxY > top && minY < bottom
  }
  if (start.y === end.y) {
    const y = start.y
    if (y < top || y > bottom) return false
    const minX = Math.min(start.x, end.x)
    const maxX = Math.max(start.x, end.x)
    return maxX > left && minX < right
  }
  return lineIntersectsBox(start, end, { left, right, top, bottom })
}

function lineIntersectsBox(start: { x: number; y: number }, end: { x: number; y: number }, box: { left: number; right: number; top: number; bottom: number }) {
  return lineSegmentsIntersect(start, end, { x: box.left, y: box.top }, { x: box.right, y: box.top }) ||
    lineSegmentsIntersect(start, end, { x: box.right, y: box.top }, { x: box.right, y: box.bottom }) ||
    lineSegmentsIntersect(start, end, { x: box.right, y: box.bottom }, { x: box.left, y: box.bottom }) ||
    lineSegmentsIntersect(start, end, { x: box.left, y: box.bottom }, { x: box.left, y: box.top })
}

function lineSegmentsIntersect(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }) {
  const ccw = (p1: { x: number; y: number }, p2: { x: number; y: number }, p3: { x: number; y: number }) => (p3.y - p1.y) * (p2.x - p1.x) > (p2.y - p1.y) * (p3.x - p1.x)
  return ccw(a, c, d) !== ccw(b, c, d) && ccw(a, b, c) !== ccw(a, b, d)
}

function vertexStyle(shape: string, theme: NonNullable<typeof THEMES.default>, globalStyle: string, localStyle: string, warnings: string[]) {
  const shapeStyle = SHAPE_STYLES[shape] ?? SHAPE_STYLES.roundedrect
  if (!SHAPE_STYLES[shape]) warn(warnings, `Unknown shape "${shape}"; using rounded rectangle.`)
  return joinStyle([
    shapeStyle,
    `fillColor=${theme.fill};strokeColor=${theme.stroke};fontColor=${theme.font};strokeWidth=2;`,
    globalStyle,
    localStyle,
  ])
}

function containerStyle(
  kind: NormalizedContainer["kind"],
  theme: NonNullable<typeof THEMES.default>,
  globalStyle: string,
  localStyle: string,
  layoutMode: DrawioContainerLayoutMode,
) {
  const weakBand = layoutMode === "weak-band" || layoutMode === "layout-only"
  const shape = weakBand
    ? "rounded=1;whiteSpace=wrap;html=0;container=0;collapsible=0;dashed=1;arcSize=8;verticalAlign=top;align=center;spacingTop=8;"
    : kind === "swimlane" ? SHAPE_STYLES.swimlane : SHAPE_STYLES.container
  return joinStyle([
    shape,
    weakBand
      ? `fillColor=${theme.accent};fillOpacity=14;strokeColor=${theme.stroke};strokeOpacity=35;fontColor=${theme.font};fontStyle=1;strokeWidth=1;`
      : `fillColor=${kind === "swimlane" ? theme.accent : "#ffffff"};strokeColor=${theme.stroke};fontColor=${theme.font};strokeWidth=2;`,
    globalStyle,
    localStyle,
  ])
}

function edgeStyle(theme: NonNullable<typeof THEMES.default>, globalStyle: string, localStyle: string) {
  return joinStyle([
    EDGE_STYLE,
    `strokeColor=${theme.edge};fontColor=${theme.font};`,
    globalStyle,
    localStyle,
  ])
}

function safeShape(input: string, warnings: string[]) {
  const raw = compactKey(input, "roundedrect")
  const aliased = SHAPE_ALIASES[raw] ?? raw
  if (SHAPE_STYLES[aliased]) return aliased
  warn(warnings, `Unknown shape "${input}"; using rounded rectangle.`)
  return "roundedrect"
}

function sanitizeStyle(input: unknown, warnings: string[], label: string) {
  if (!input) return ""
  const pairs = styleEntries(input)
  const safe: string[] = []
  for (const [rawKey, rawValue] of pairs) {
    const key = String(rawKey || "").trim()
    const value = String(rawValue ?? "").trim()
    if (!/^[A-Za-z0-9_.:-]{1,64}$/.test(key)) {
      warn(warnings, `Dropped unsafe draw.io style key in ${label}: ${key || "<empty>"}.`)
      continue
    }
    if (/^(?:image|link|script|url)$/i.test(key)) {
      warn(warnings, `Dropped external-resource draw.io style key in ${label}: ${key}.`)
      continue
    }
    if (isUnsafeStyleValue(value)) {
      warn(warnings, `Dropped unsafe draw.io style value for ${key} in ${label}.`)
      continue
    }
    safe.push(`${key}=${value}`)
  }
  return safe.length ? `${safe.join(";")};` : ""
}

function styleEntries(input: unknown): Array<[string, string]> {
  if (typeof input === "string") {
    return input.split(";")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .map((entry) => {
        const index = entry.indexOf("=")
        return index === -1 ? [entry, "1"] : [entry.slice(0, index), entry.slice(index + 1)]
      })
  }
  const record = asRecord(input)
  if (!record) return []
  return Object.entries(record).map(([key, value]) => [key, String(value ?? "")])
}

function isUnsafeStyleValue(value: string) {
  return value.length > 240 ||
    /(?:https?:\/\/|\/\/|javascript:|data:|url\s*\(|<|>|["'`])/i.test(value) ||
    /[\r\n;]/.test(value)
}

function joinStyle(parts: string[]) {
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .join("")
}

function nodeParentAssignment(item: Record<string, unknown>, context: NormalizationContext, containers: NormalizedContainer[]) {
  const requested = stringField(item, "parent") || stringField(item, "group") || stringField(item, "container") || stringField(item, "lane") || stringField(item, "layer")
  if (!requested) {
    const firstLane = containers.find((container) => container.kind === "swimlane")
    if (firstLane && containers.length === 1) {
      return firstLane.layoutMode === "weak-band" || firstLane.layoutMode === "layout-only"
        ? { parent: "1", ownerContainer: firstLane.id }
        : { parent: firstLane.id }
    }
    return { parent: "1" }
  }
  const mapped = context.rawToId.get(requested)
  if (mapped) {
    const container = containers.find((candidate) => candidate.id === mapped)
    if (container && (container.layoutMode === "weak-band" || container.layoutMode === "layout-only")) {
      return { parent: "1", ownerContainer: mapped }
    }
    return { parent: mapped }
  }
  warn(context.warnings, `Unknown parent "${requested}"; placed item on the root layer.`)
  return { parent: "1" }
}

function parentId(item: Record<string, unknown>, context: NormalizationContext, fallback: string) {
  const requested = stringField(item, "parent") || stringField(item, "layer")
  if (!requested) return fallback
  const mapped = context.rawToId.get(requested)
  if (mapped) return mapped
  warn(context.warnings, `Unknown parent "${requested}"; placed item on the root layer.`)
  return fallback
}

function nextId(context: NormalizationContext, prefix: string, raw: string, index: number) {
  const base = normalizeId(`${prefix}-${raw || index}`)
  let id = base || `${prefix}-${index}`
  let suffix = 2
  while (context.usedIds.has(id)) {
    if (suffix === 2) warn(context.warnings, `Duplicate id "${id}" was renamed.`)
    id = `${base}-${suffix}`
    suffix += 1
  }
  context.usedIds.add(id)
  return id
}

function normalizeId(input: string) {
  const value = input
    .normalize("NFKD")
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
  return /^[A-Za-z_]/.test(value) ? value : `id-${value || "cell"}`
}

function geometryFromSpec(item: Record<string, unknown>, fallback: Geometry): Geometry {
  const geometry = asRecord(item.geometry)
  return {
    x: finiteNumber(geometry?.x ?? item.x, fallback.x),
    y: finiteNumber(geometry?.y ?? item.y, fallback.y),
    width: finiteNumber(geometry?.width ?? item.width, fallback.width),
    height: finiteNumber(geometry?.height ?? item.height, fallback.height),
  }
}

function hasGeometry(item: Record<string, unknown>) {
  const geometry = asRecord(item.geometry)
  return Boolean(
    geometry && (
      Number.isFinite(geometry.x) ||
      Number.isFinite(geometry.y) ||
      Number.isFinite(geometry.width) ||
      Number.isFinite(geometry.height)
    ) ||
    Number.isFinite(item.x) ||
    Number.isFinite(item.y) ||
    Number.isFinite(item.width) ||
    Number.isFinite(item.height),
  )
}

function limited<T>(items: T[], limit: number, warnings: string[], label: string) {
  if (items.length <= limit) return items
  warn(warnings, `Truncated ${label} from ${items.length} to ${limit} item(s).`)
  return items.slice(0, limit)
}

function arrayRecords(value: unknown) {
  return Array.isArray(value)
    ? value.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object" && !Array.isArray(item)))
    : []
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}

function stringField(record: Record<string, unknown> | undefined, key: string) {
  const value = record?.[key]
  return typeof value === "string" ? value.trim() : ""
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function booleanField(record: Record<string, unknown>, key: string) {
  const value = record[key]
  return value === true || (typeof value === "string" && /^(true|yes|1)$/i.test(value.trim()))
}

function finiteNumber(input: unknown, fallback: number) {
  return typeof input === "number" && Number.isFinite(input) ? input : fallback
}

function compactText(input: string, maxLength: number) {
  const text = sanitizeVisibleLabel(input).replace(/\s+/g, " ").trim()
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`
}

function diagramLabel(input: string, maxLength: number, maxLineWeight: number, maxLines: number) {
  const text = compactLabelText(input, maxLength)
  if (!text) return ""
  const lines: string[] = []
  for (const sourceLine of text.split(/\r\n|\r|\n/).map((line) => line.trim()).filter(Boolean)) {
    const tokens = sourceLine.split(/\s+/).flatMap((token) => splitLongLabelToken(token, maxLineWeight))
    let current = ""
    for (const token of tokens) {
      const candidate = current ? `${current} ${token}` : token
      if (current && weightedTextLength(candidate) > maxLineWeight) {
        lines.push(current)
        current = token
      } else {
        current = candidate
      }
    }
    if (current) lines.push(current)
  }
  if (lines.length <= maxLines) return lines.join("\n")
  const visible = lines.slice(0, Math.max(1, maxLines))
  visible[visible.length - 1] = compactText(visible[visible.length - 1], Math.max(8, visible[visible.length - 1].length - 3))
  return visible.join("\n")
}

function compactLabelText(input: string, maxLength: number) {
  const text = sanitizeVisibleLabel(input).replace(/\r\n|\r/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n")
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 3)}...`
}

function sanitizeVisibleLabel(input: string) {
  return input
    .replace(/&lt;br\s*\/?&gt;/gi, "\n")
    .replace(/&lt;\/br\s*&gt;/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/br\s*>/gi, "\n")
    .replace(/&#10;|&#x0a;|&#xa;/gi, "\n")
}

function splitLongLabelToken(token: string, maxLineWeight: number) {
  if (weightedTextLength(token) <= maxLineWeight) return [token]
  const pieces: string[] = []
  let current = ""
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index]
    const next = token[index + 1] || ""
    current += char
    const canBreak = /[_./:()-]/.test(char) ||
      (char === ">" && token[index - 1] === "-") ||
      (/[a-z0-9]/.test(char) && /[A-Z]/.test(next))
    if (current && (weightedTextLength(current) >= maxLineWeight || (canBreak && weightedTextLength(current) >= maxLineWeight * 0.55))) {
      pieces.push(current)
      current = ""
    }
  }
  if (current) pieces.push(current)
  return pieces.length ? pieces : [token]
}

function compactKey(input: string, fallback: string) {
  const key = input.toLowerCase().replace(/[^a-z0-9_-]+/g, "")
  return key || fallback
}

function warn(warnings: string[], message: string) {
  if (warnings.length >= MAX_WARNINGS) return
  if (!warnings.includes(message)) warnings.push(message)
}

function xmlAttr(input: string) {
  return String(input)
    .replace(/\r\n|\r|\n/g, "&#xa;")
    .replace(/&/g, "&amp;")
    .replace(/&amp;#xa;/g, "&#xa;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/'/g, "&apos;")
}

function num(input: number) {
  return Number.isFinite(input) ? String(Math.round(input * 100) / 100) : "0"
}

function hashText(input: string) {
  let hash = 2166136261
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}
