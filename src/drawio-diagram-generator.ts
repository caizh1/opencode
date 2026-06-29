import { findDiagramIrInput, validateDiagramIr, type DiagramIr, type DiagramIrComposition, type DiagramIrCoverageReport, type DiagramIrValidationResult, type DiagramIrVisualPlan } from "./diagram-ir"
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
  presentationMode?: "line" | "rail" | "legend" | string
  rail?: "left" | "right" | "top" | "bottom" | string
  marker?: string
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
  visualPlan?: DiagramIrVisualPlan
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
  sourceId?: string
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
  fullLabel?: string
  sourceId?: string
  source?: string
  target?: string
  parent: string
  style: string
  points: DrawioPointSpec[]
  labelOffset?: DrawioPointSpec
  edgeKind?: string
  pathRole?: string
  labelPriority?: string
  presentationMode?: "line" | "rail" | "legend"
  rail?: "left" | "right" | "top" | "bottom"
  marker?: string
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
  if (irValidation) assertRenderableDiagramIr(irValidation)
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
  const appliedSocLayout = applySocBlockVisualLayout(containers, nodes, edges, warnings, design.visualPlan)
  if (!appliedSocLayout) applyVisualPlanDrivenLayout(nodes, edges, containers, warnings, design.visualPlan)
  containers = materializeRenderedContainers(containerLayout.renderedContainers, nodes, warnings, design.visualPlan)
  repairDrawioLayout(nodes, edges, containers, warnings, design.visualPlan)
  applyDrawioQualityGate(nodes, edges, containers, warnings, design.visualPlan)
  const legend = materializeVisualPlanLegend(nodes, containers, design.visualPlan)
  containers = [...containers, ...legend.containers]
  nodes.push(...legend.nodes)
  normalizeRootCoordinates(containers, nodes, edges, warnings, design.visualPlan)
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

function assertRenderableDiagramIr(validation: DiagramIrValidationResult) {
  const blockingIssues = validation.issues.filter((issue) => issue.severity === "blocking")
  if (!blockingIssues.length) return
  const summary = blockingIssues
    .slice(0, 6)
    .map((issue) => `${issue.code}: ${issue.message}`)
    .join(" | ")
  throw new Error(`stage=diagramir.validation blockingIssues=${blockingIssues.length} ${summary}`)
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
      sourceId: rawId,
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

function applySocBlockVisualLayout(
  containers: NormalizedContainer[],
  nodes: NormalizedNode[],
  edges: NormalizedEdge[],
  warnings: string[],
  visualPlan: VisualPlan,
) {
  if (visualPlan.profile !== "soc-block") return false
  const hints = asRecord(asRecord(visualPlan.styleHints)?.socLayout) ?? asRecord(asRecord(visualPlan.styleHints)?.soc)
  if (!hints) return false
  const regionHints = arrayRecords(hints.regions)
  const nodeHints = arrayRecords(hints.nodes)
  if (!regionHints.length && !nodeHints.length) return false

  const containerByKey = socContainerLookup(containers)
  const nodeByKey = socNodeLookup(nodes)
  const placedRegions = new Set<string>()
  const placedNodes = new Set<string>()

  for (const hint of regionHints) {
    const id = stringField(hint, "id") || stringField(hint, "region") || stringField(hint, "container")
    const container = id ? containerByKey.get(id) : undefined
    if (!container) {
      warn(warnings, `SoC layout hint referenced unknown region/container "${id || "<empty>"}"; ignored.`)
      continue
    }
    const geometry = geometryFromSocHint(hint, container.geometry)
    container.parent = "1"
    container.layoutMode = "strong-container"
    container.geometry = geometry
    placedRegions.add(container.id)
  }

  for (const hint of nodeHints) {
    const id = stringField(hint, "id") || stringField(hint, "node")
    const node = id ? nodeByKey.get(id) : undefined
    if (!node) {
      warn(warnings, `SoC layout hint referenced unknown node "${id || "<empty>"}"; ignored.`)
      continue
    }
    const parentKey = stringField(hint, "region") || stringField(hint, "container") || stringField(hint, "parent")
    const parent = parentKey ? containerByKey.get(parentKey) : undefined
    if (parent) {
      node.parent = parent.id
      node.ownerContainer = parent.id
    } else if (parentKey) {
      warn(warnings, `SoC layout hint for node "${id}" referenced unknown region/container "${parentKey}"; placed node on root.`)
      node.parent = "1"
      node.ownerContainer = undefined
    }
    node.geometry = fitSocNodeGeometry(node, geometryFromSocHint(hint, node.geometry))
    node.explicitGeometry = true
    placedNodes.add(node.id)
  }

  arrangeUnplacedSocNodes(containers, nodes, placedRegions, placedNodes)
  expandSocContainersToFitChildren(containers, nodes, warnings)
  const spreadContainers = spreadSocContainerModuleColumns(containers, nodes)
  if (spreadContainers > 0) {
    warn(warnings, `Spread module columns in ${spreadContainers} SoC container(s) across available width using only explicit node/container geometry.`)
  }
  materializeSocVisualPlanBuses(containers, nodes, edges, warnings, visualPlan)
  routeSocBlockEdges(containers, nodes, edges, visualPlan)
  styleSocBlockCells(containers, nodes, edges)
  warnings.push(`Applied model-authored SoC layout hints to ${placedRegions.size} region(s) and ${placedNodes.size} node(s); renderer did not infer chip semantics from labels.`)
  return true
}

function socContainerLookup(containers: NormalizedContainer[]) {
  const result = new Map<string, NormalizedContainer>()
  for (const container of containers) {
    for (const key of [
      container.id,
      container.sourceId,
      container.sourceId ? normalizeId(`g-${container.sourceId}`) : undefined,
      normalizeId(container.label),
    ]) {
      if (key) result.set(key, container)
    }
  }
  return result
}

function socNodeLookup(nodes: NormalizedNode[]) {
  const result = new Map<string, NormalizedNode>()
  for (const node of nodes) {
    for (const key of [
      node.id,
      node.sourceId,
      node.sourceId ? normalizeId(`n-${node.sourceId}`) : undefined,
      normalizeId(node.label),
    ]) {
      if (key) result.set(key, node)
    }
  }
  return result
}

function geometryFromSocHint(hint: Record<string, unknown>, fallback: Geometry): Geometry {
  return {
    x: finiteNumber(hint.x, fallback.x),
    y: finiteNumber(hint.y, fallback.y),
    width: finiteNumber(hint.width, fallback.width),
    height: finiteNumber(hint.height, fallback.height),
  }
}

function arrangeUnplacedSocNodes(
  containers: NormalizedContainer[],
  nodes: NormalizedNode[],
  placedRegions: Set<string>,
  placedNodes: Set<string>,
) {
  for (const container of containers) {
    if (!placedRegions.has(container.id)) continue
    const owned = nodes.filter((node) => !placedNodes.has(node.id) && (node.parent === container.id || node.ownerContainer === container.id))
    if (!owned.length) continue
    const padding = 22
    const header = 42
    const gap = 10
    const cellWidth = Math.max(72, Math.min(128, (container.geometry.width - padding * 2) / Math.min(4, Math.max(1, owned.length)) - gap))
    const columns = Math.max(1, Math.floor((container.geometry.width - padding * 2 + gap) / (cellWidth + gap)))
    owned.forEach((node, index) => {
      const column = index % columns
      const row = Math.floor(index / columns)
      const width = Math.min(Math.max(72, node.geometry.width), cellWidth)
      const height = Math.min(Math.max(34, node.geometry.height), 56)
      node.parent = container.id
      node.ownerContainer = container.id
      node.geometry = {
        x: padding + column * (cellWidth + gap),
        y: header + row * (height + gap),
        width,
        height,
      }
    })
  }
}

function routeSocBlockEdges(containers: NormalizedContainer[], nodes: NormalizedNode[], edges: NormalizedEdge[], visualPlan: VisualPlan) {
  const rootView = rootGeometryView(containers, nodes)
  const rootNodesById = new Map(rootView.nodes.map((node) => [node.id, node]))
  const rootContainersById = new Map(rootView.containers.map((container) => [container.id, container]))
  const graphBounds = nodeAndContainerBounds(rootView.nodes, rootView.containers)
  const routeHints = socEdgeRouteHints(visualPlan)
  const railOffsets = new Map<string, number>()
  const routedSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }> = []
  for (const edge of edges) {
    if (!edge.source || !edge.target) continue
    const source = rootNodesById.get(edge.source)
    const target = rootNodesById.get(edge.target)
    if (!source || !target) continue
    if (edge.points.length && isVisualBusRenderEdge(edge)) {
      rememberSocRouteSegments(edge, rootNodesById, routedSegments)
      continue
    }
    if (edge.presentationMode === "rail") {
      const side = edge.rail ?? "right"
      const offset = railOffsets.get(side) ?? 0
      railOffsets.set(side, offset + 56)
      edge.points = socLocalRailRoute(source, target, edge, rootContainersById, rootView.nodes, routedSegments, side, offset)
      rememberSocRouteSegments(edge, rootNodesById, routedSegments)
      continue
    }
    const alignedRoute = unobstructedAlignedSocRoute(source, target, edge, rootView.nodes)
    if (alignedRoute) {
      edge.points = alignedRoute
      rememberSocRouteSegments(edge, rootNodesById, routedSegments)
      continue
    }
    const routeHint = routeHints.get(edge.sourceId ?? edge.id) ?? routeHints.get(edge.id)
    if (routeHint?.length) {
      edge.points = routeHint
      if (!socRouteTouchesNodes(source, target, edge, routeHint, rootView.nodes) && !socRouteOverlapsPrevious(source, target, edge, routeHint, routedSegments)) {
        rememberSocRouteSegments(edge, rootNodesById, routedSegments)
        continue
      }
    }
    const containerBoundaryRoute = socContainerBoundaryBusRoute(source, target, edge, rootContainersById, graphBounds, rootView.nodes, routedSegments)
    if (containerBoundaryRoute) {
      edge.points = containerBoundaryRoute
      rememberSocRouteSegments(edge, rootNodesById, routedSegments)
      continue
    }
    if (routeHint?.length) {
      const repairedRoute = socObstacleRoute(source, target, edge, rootView.nodes, graphBounds, routedSegments)
      edge.points = repairedRoute.length ? repairedRoute : socLineRoute(source, target, edge, rootView.nodes, graphBounds, routedSegments)
      rememberSocRouteSegments(edge, rootNodesById, routedSegments)
      continue
    }
    edge.points = socLineRoute(source, target, edge, rootView.nodes, graphBounds, routedSegments)
    rememberSocRouteSegments(edge, rootNodesById, routedSegments)
  }
}

function materializeSocVisualPlanBuses(
  containers: NormalizedContainer[],
  nodes: NormalizedNode[],
  edges: NormalizedEdge[],
  warnings: string[],
  visualPlan: VisualPlan,
) {
  const buses = visualPlan.buses ?? []
  if (visualPlan.profile !== "soc-block" || !buses.length) return
  const edgeByKey = new Map<string, NormalizedEdge>()
  for (const edge of edges) {
    edgeByKey.set(edge.id, edge)
    if (edge.sourceId) edgeByKey.set(edge.sourceId, edge)
  }
  const existingNodeIds = new Set(nodes.map((node) => node.id))
  let rendered = 0
  for (const bus of buses) {
    const busId = stringField(bus, "id") || `bus-${rendered + 1}`
    const busEdges = (bus.edges ?? [])
      .map((edgeId) => edgeByKey.get(edgeId))
      .filter((edge): edge is NormalizedEdge => Boolean(edge?.source && edge.target && edge.presentationMode !== "legend"))
    if (busEdges.length < 2) continue
    const commonTarget = commonValue(busEdges.map((edge) => edge.target))
    const commonSource = commonValue(busEdges.map((edge) => edge.source))
    if (commonTarget) {
      if (materializeCommonTargetBus(busId, bus.label, commonTarget, busEdges, containers, nodes, edges, existingNodeIds)) rendered += 1
      continue
    }
    if (commonSource) {
      if (materializeCommonSourceBus(busId, bus.label, commonSource, busEdges, containers, nodes, edges, existingNodeIds)) rendered += 1
    }
  }
  if (rendered > 0) {
    warn(warnings, `Rendered ${rendered} model-authored SoC bus group(s) as visual junction/trunk structures; bus semantics came from VisualPlan.buses.`)
  }
}

function materializeCommonTargetBus(
  busId: string,
  label: string | undefined,
  targetId: string,
  busEdges: NormalizedEdge[],
  containers: NormalizedContainer[],
  nodes: NormalizedNode[],
  edges: NormalizedEdge[],
  existingNodeIds: Set<string>,
) {
  const rootView = rootGeometryView(containers, nodes)
  const rootNodesById = new Map(rootView.nodes.map((node) => [node.id, node]))
  const target = rootNodesById.get(targetId)
  const sources = busEdges.map((edge) => edge.source ? rootNodesById.get(edge.source) : undefined).filter((node): node is NormalizedNode => Boolean(node))
  if (!target || sources.length < 2) return false
  const junction = createSocBusJunction(busId, label, target.geometry, sources.map((node) => node.geometry), "target", existingNodeIds)
  nodes.push(junction)
  for (const [index, edge] of busEdges.entries()) {
    const source = edge.source ? rootNodesById.get(edge.source) : undefined
    if (!source) continue
    const sourceCenter = centerPoint(source.geometry)
    const junctionCenter = centerPoint(junction.geometry)
    edge.target = junction.id
    edge.label = ""
    edge.pathRole = "bus-branch"
    edge.style = joinStyle([edge.style, "endArrow=none;startArrow=none;"])
    edge.points = removeRedundantRoutePoints([{ x: junctionCenter.x, y: sourceCenter.y + index * 3 }])
  }
  edges.push(createSocBusTrunkEdge(busId, label, junction, target, "target", edges.length + 1))
  return true
}

function materializeCommonSourceBus(
  busId: string,
  label: string | undefined,
  sourceId: string,
  busEdges: NormalizedEdge[],
  containers: NormalizedContainer[],
  nodes: NormalizedNode[],
  edges: NormalizedEdge[],
  existingNodeIds: Set<string>,
) {
  const rootView = rootGeometryView(containers, nodes)
  const rootNodesById = new Map(rootView.nodes.map((node) => [node.id, node]))
  const source = rootNodesById.get(sourceId)
  const targets = busEdges.map((edge) => edge.target ? rootNodesById.get(edge.target) : undefined).filter((node): node is NormalizedNode => Boolean(node))
  if (!source || targets.length < 2) return false
  const junction = createSocBusJunction(busId, label, source.geometry, targets.map((node) => node.geometry), "source", existingNodeIds)
  nodes.push(junction)
  for (const [index, edge] of busEdges.entries()) {
    const target = edge.target ? rootNodesById.get(edge.target) : undefined
    if (!target) continue
    const targetCenter = centerPoint(target.geometry)
    const junctionCenter = centerPoint(junction.geometry)
    edge.source = junction.id
    edge.label = ""
    edge.pathRole = "bus-branch"
    edge.style = joinStyle([edge.style, "startArrow=none;"])
    edge.points = removeRedundantRoutePoints([{ x: junctionCenter.x, y: targetCenter.y + index * 3 }])
  }
  edges.push(createSocBusTrunkEdge(busId, label, source, junction, "source", edges.length + 1))
  return true
}

function createSocBusJunction(
  busId: string,
  _label: string | undefined,
  anchor: Geometry,
  peers: Geometry[],
  mode: "source" | "target",
  existingNodeIds: Set<string>,
): NormalizedNode {
  const anchorCenter = centerPoint(anchor)
  const peerCenter = averagePoint(peers.map(centerPoint))
  const horizontal = Math.abs(anchorCenter.x - peerCenter.x) >= Math.abs(anchorCenter.y - peerCenter.y)
  const size = 12
  const margin = 34
  let x = anchorCenter.x - size / 2
  let y = anchorCenter.y - size / 2
  if (horizontal) {
    const peersLeft = peerCenter.x <= anchorCenter.x
    x = (peersLeft ? anchor.x - margin : anchor.x + anchor.width + margin) - size / 2
  } else {
    const peersAbove = peerCenter.y <= anchorCenter.y
    y = (peersAbove ? anchor.y - margin : anchor.y + anchor.height + margin) - size / 2
  }
  return {
    id: uniqueSyntheticId(existingNodeIds, `n-bus-${normalizeId(busId)}-${mode}-junction`),
    sourceId: `visual-bus:${busId}:junction`,
    label: "",
    shape: "ellipse",
    parent: "1",
    geometry: { x, y, width: size, height: size },
    style: "ellipse;whiteSpace=wrap;html=0;fillColor=#92400e;strokeColor=#92400e;strokeWidth=1;opacity=92;",
    explicitGeometry: true,
    visualRole: "bus-junction",
    importance: 0.25,
  }
}

function createSocBusTrunkEdge(
  busId: string,
  label: string | undefined,
  source: NormalizedNode,
  target: NormalizedNode,
  mode: "source" | "target",
  index: number,
): NormalizedEdge {
  const sourceCenter = centerPoint(source.geometry)
  const targetCenter = centerPoint(target.geometry)
  const horizontal = Math.abs(sourceCenter.x - targetCenter.x) >= Math.abs(sourceCenter.y - targetCenter.y)
  const axisPoint = horizontal
    ? { x: (sourceCenter.x + targetCenter.x) / 2, y: targetCenter.y }
    : { x: targetCenter.x, y: (sourceCenter.y + targetCenter.y) / 2 }
  return {
    id: `e-bus-${normalizeId(busId)}-${mode}-trunk-${index}`,
    sourceId: `visual-bus:${busId}:trunk`,
    label: label ? diagramLabel(label, 80, 18, 2) : "",
    fullLabel: label,
    source: source.id,
    target: target.id,
    parent: "1",
    style: joinStyle([EDGE_STYLE, "strokeColor=#92400e;strokeWidth=6;endArrow=block;fontSize=9;fontColor=#64748b;labelBackgroundColor=#ffffff;", fixedAlignedPortStyle(source.geometry, target.geometry, axisPoint, horizontal ? "horizontal" : "vertical")]),
    points: removeRedundantRoutePoints([axisPoint]),
    edgeKind: "bus",
    pathRole: "bus-trunk",
    labelPriority: "low",
    presentationMode: "line",
  }
}

function commonValue(values: Array<string | undefined>) {
  const filtered = values.filter((value): value is string => Boolean(value))
  if (!filtered.length) return undefined
  const first = filtered[0]
  return filtered.every((value) => value === first) ? first : undefined
}

function averagePoint(points: Array<{ x: number; y: number }>) {
  if (!points.length) return { x: 0, y: 0 }
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  }
}

function uniqueSyntheticId(existing: Set<string>, base: string) {
  let id = base
  let index = 2
  while (existing.has(id)) {
    id = `${base}-${index}`
    index += 1
  }
  existing.add(id)
  return id
}

function isVisualBusRenderEdge(edge: NormalizedEdge) {
  return edge.pathRole === "bus-trunk" || edge.pathRole === "bus-branch" || String(edge.sourceId || "").startsWith("visual-bus:")
}

function socContainerBoundaryBusRoute(
  source: NormalizedNode,
  target: NormalizedNode,
  edge: NormalizedEdge,
  containersById: Map<string, NormalizedContainer>,
  bounds: Geometry,
  nodes: NormalizedNode[],
  routedSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>,
) {
  if (!isHeavyBusLikeEdge(edge) || source.parent === target.parent) return undefined
  const sourceContainer = containersById.get(source.parent)
  const targetContainer = containersById.get(target.parent)
  if (!sourceContainer || !targetContainer || sourceContainer.id === targetContainer.id) return undefined
  const sourceCenter = centerPoint(source.geometry)
  const targetCenter = centerPoint(target.geometry)
  const dx = Math.abs(sourceCenter.x - targetCenter.x)
  const dy = Math.abs(sourceCenter.y - targetCenter.y)
  if (dx + dy < 420) return undefined
  const candidates = dx >= dy
    ? horizontalContainerBusRouteCandidates(source.geometry, target.geometry, sourceContainer.geometry, targetContainer.geometry, bounds)
    : verticalContainerBusRouteCandidates(source.geometry, target.geometry, sourceContainer.geometry, targetContainer.geometry, bounds)
  const obstacles = nodes
    .filter((node) => node.id !== edge.source && node.id !== edge.target && node.visualRole !== "legend-note")
    .map((node) => inflateGeometry(node.geometry, 8))
  const route = chooseLowestCostSocRoute(source.geometry, target.geometry, candidates, obstacles, routedSegments)
  if (!route.length || socRouteTouchesNodes(source, target, edge, route, nodes)) return undefined
  return removeRedundantRoutePoints(route)
}

function horizontalContainerBusRouteCandidates(
  source: Geometry,
  target: Geometry,
  sourceContainer: Geometry,
  targetContainer: Geometry,
  bounds: Geometry,
) {
  const sourceCenter = centerPoint(source)
  const targetCenter = centerPoint(target)
  const targetRight = targetCenter.x >= sourceCenter.x
  const margin = 28
  const sourceOuterX = targetRight ? sourceContainer.x + sourceContainer.width + margin : sourceContainer.x - margin
  const targetOuterX = targetRight ? targetContainer.x - margin : targetContainer.x + targetContainer.width + margin
  const sourceTopY = sourceContainer.y - margin
  const sourceBottomY = sourceContainer.y + sourceContainer.height + margin
  const sourceOuterTopY = sourceContainer.y - margin - 56
  const sourceOuterBottomY = sourceContainer.y + sourceContainer.height + margin + 56
  const preferredSourceY = targetCenter.y < sourceCenter.y ? sourceTopY : sourceBottomY
  const alternateSourceY = targetCenter.y < sourceCenter.y ? sourceBottomY : sourceTopY
  const outerPreferredSourceY = targetCenter.y < sourceCenter.y ? sourceOuterTopY : sourceOuterBottomY
  const outerAlternateSourceY = targetCenter.y < sourceCenter.y ? sourceOuterBottomY : sourceOuterTopY
  const outerTopY = Math.min(sourceContainer.y, targetContainer.y, bounds.y) - 54
  const outerBottomY = Math.max(sourceContainer.y + sourceContainer.height, targetContainer.y + targetContainer.height, bounds.y + bounds.height) + 54
  const preferredY = targetCenter.y < sourceCenter.y ? outerTopY : outerBottomY
  const alternateY = targetCenter.y < sourceCenter.y ? outerBottomY : outerTopY
  const candidates: DrawioPointSpec[][] = []
  for (const sourceSideY of [preferredSourceY, alternateSourceY, outerPreferredSourceY, outerAlternateSourceY]) {
    for (const corridorY of [preferredY, alternateY]) {
      const laneY = Math.abs(sourceSideY - corridorY) <= 32 ? sourceSideY : corridorY
      candidates.push([
        { x: sourceCenter.x, y: sourceSideY },
        { x: sourceOuterX, y: sourceSideY },
        { x: sourceOuterX, y: laneY },
        { x: targetOuterX, y: laneY },
        { x: targetOuterX, y: targetCenter.y },
      ])
    }
  }
  return candidates
}

function verticalContainerBusRouteCandidates(
  source: Geometry,
  target: Geometry,
  sourceContainer: Geometry,
  targetContainer: Geometry,
  bounds: Geometry,
) {
  const sourceCenter = centerPoint(source)
  const targetCenter = centerPoint(target)
  const targetBelow = targetCenter.y >= sourceCenter.y
  const margin = 28
  const sourceOuterY = targetBelow ? sourceContainer.y + sourceContainer.height + margin : sourceContainer.y - margin
  const targetOuterY = targetBelow ? targetContainer.y - margin : targetContainer.y + targetContainer.height + margin
  const sourceLeftX = sourceContainer.x - margin
  const sourceRightX = sourceContainer.x + sourceContainer.width + margin
  const sourceOuterLeftX = sourceContainer.x - margin - 56
  const sourceOuterRightX = sourceContainer.x + sourceContainer.width + margin + 56
  const preferredSourceX = targetCenter.x < sourceCenter.x ? sourceLeftX : sourceRightX
  const alternateSourceX = targetCenter.x < sourceCenter.x ? sourceRightX : sourceLeftX
  const outerPreferredSourceX = targetCenter.x < sourceCenter.x ? sourceOuterLeftX : sourceOuterRightX
  const outerAlternateSourceX = targetCenter.x < sourceCenter.x ? sourceOuterRightX : sourceOuterLeftX
  const outerLeftX = Math.min(sourceContainer.x, targetContainer.x, bounds.x) - 54
  const outerRightX = Math.max(sourceContainer.x + sourceContainer.width, targetContainer.x + targetContainer.width, bounds.x + bounds.width) + 54
  const preferredX = targetCenter.x < sourceCenter.x ? outerLeftX : outerRightX
  const alternateX = targetCenter.x < sourceCenter.x ? outerRightX : outerLeftX
  const candidates: DrawioPointSpec[][] = []
  for (const sourceSideX of [preferredSourceX, alternateSourceX, outerPreferredSourceX, outerAlternateSourceX]) {
    for (const corridorX of [preferredX, alternateX]) {
      const laneX = Math.abs(sourceSideX - corridorX) <= 32 ? sourceSideX : corridorX
      candidates.push([
        { x: sourceSideX, y: sourceCenter.y },
        { x: sourceSideX, y: sourceOuterY },
        { x: laneX, y: sourceOuterY },
        { x: laneX, y: targetOuterY },
        { x: targetCenter.x, y: targetOuterY },
      ])
    }
  }
  return candidates
}

function removeRedundantRoutePoints(points: DrawioPointSpec[]) {
  const finite = points.filter(isFinitePoint).map((point) => ({ x: point.x, y: point.y }))
  const result: DrawioPointSpec[] = []
  for (const point of finite) {
    const previous = result[result.length - 1]
    if (previous && Math.abs((previous.x ?? 0) - point.x) <= 1 && Math.abs((previous.y ?? 0) - point.y) <= 1) continue
    result.push(point)
  }
  let changed = true
  while (changed) {
    changed = false
    for (let index = 1; index < result.length - 1; index += 1) {
      const previous = result[index - 1]
      const current = result[index]
      const next = result[index + 1]
      if (!previous || !current || !next) continue
      const sameX = Math.abs((previous.x ?? 0) - (current.x ?? 0)) <= 1 && Math.abs((current.x ?? 0) - (next.x ?? 0)) <= 1
      const sameY = Math.abs((previous.y ?? 0) - (current.y ?? 0)) <= 1 && Math.abs((current.y ?? 0) - (next.y ?? 0)) <= 1
      if (!sameX && !sameY) continue
      result.splice(index, 1)
      changed = true
      break
    }
  }
  return result
}

function unobstructedAlignedSocRoute(source: NormalizedNode, target: NormalizedNode, edge: NormalizedEdge, nodes: NormalizedNode[]) {
  if (edge.presentationMode !== "line") return undefined
  const sourceCenter = centerPoint(source.geometry)
  const targetCenter = centerPoint(target.geometry)
  const vertical = Math.abs(sourceCenter.x - targetCenter.x) <= 24
  const horizontal = Math.abs(sourceCenter.y - targetCenter.y) <= 24
  if (!vertical && !horizontal) return undefined
  const axisPoint = vertical
    ? { x: alignedAxisBetweenRanges(source.geometry.x, source.geometry.x + source.geometry.width, target.geometry.x, target.geometry.x + target.geometry.width, (sourceCenter.x + targetCenter.x) / 2), y: (sourceCenter.y + targetCenter.y) / 2 }
    : { x: (sourceCenter.x + targetCenter.x) / 2, y: alignedAxisBetweenRanges(source.geometry.y, source.geometry.y + source.geometry.height, target.geometry.y, target.geometry.y + target.geometry.height, (sourceCenter.y + targetCenter.y) / 2) }
  const route = [axisPoint]
  if (socRouteTouchesNodes(source, target, edge, route, nodes)) return undefined
  edge.style = joinStyle([edge.style, fixedAlignedPortStyle(source.geometry, target.geometry, axisPoint, vertical ? "vertical" : "horizontal")])
  return route
}

function alignedAxisBetweenRanges(sourceMin: number, sourceMax: number, targetMin: number, targetMax: number, preferred: number) {
  const padding = 4
  const min = Math.max(sourceMin + padding, targetMin + padding)
  const max = Math.min(sourceMax - padding, targetMax - padding)
  if (min <= max) return clampNumber(preferred, min, max)
  return preferred
}

function fixedAlignedPortStyle(source: Geometry, target: Geometry, axisPoint: DrawioPointSpec, orientation: "vertical" | "horizontal") {
  if (!isFinitePoint(axisPoint)) return ""
  if (orientation === "vertical") {
    const sourceExitX = clampNumber((axisPoint.x - source.x) / Math.max(1, source.width), 0, 1)
    const targetEntryX = clampNumber((axisPoint.x - target.x) / Math.max(1, target.width), 0, 1)
    const targetBelow = centerPoint(target).y >= centerPoint(source).y
    return `exitX=${formatStyleNumber(sourceExitX)};exitY=${targetBelow ? 1 : 0};exitPerimeter=0;entryX=${formatStyleNumber(targetEntryX)};entryY=${targetBelow ? 0 : 1};entryPerimeter=0;`
  }
  const sourceExitY = clampNumber((axisPoint.y - source.y) / Math.max(1, source.height), 0, 1)
  const targetEntryY = clampNumber((axisPoint.y - target.y) / Math.max(1, target.height), 0, 1)
  const targetRight = centerPoint(target).x >= centerPoint(source).x
  return `exitX=${targetRight ? 1 : 0};exitY=${formatStyleNumber(sourceExitY)};exitPerimeter=0;entryX=${targetRight ? 0 : 1};entryY=${formatStyleNumber(targetEntryY)};entryPerimeter=0;`
}

function clampNumber(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

function formatStyleNumber(value: number) {
  return Number(value.toFixed(3))
}

function socObstacleRoute(
  source: NormalizedNode,
  target: NormalizedNode,
  edge: NormalizedEdge,
  nodes: NormalizedNode[],
  bounds: Geometry,
  routedSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>,
) {
  const targetCenter = centerPoint(target.geometry)
  const sourceCenter = centerPoint(source.geometry)
  const start = boundaryPointToward(source.geometry, targetCenter)
  const end = boundaryPointToward(target.geometry, sourceCenter)
  const obstacles = socNodeObstacles(nodes, edge).map((geometry) => inflateGeometry(geometry, 10))
  const route = gridRoute(start, end, obstacles, routedSegments, bounds)
  if (route.length < 2) return []
  const innerPoints = route.slice(1, -1)
  if (innerPoints.length && !socRouteTouchesNodes(source, target, edge, innerPoints, nodes)) return innerPoints
  return []
}

function socNodeObstacles(nodes: NormalizedNode[], edge: NormalizedEdge) {
  return nodes
    .filter((node) => node.id !== edge.source && node.id !== edge.target && node.visualRole !== "legend-note")
    .map((node) => node.geometry)
}

function socRouteTouchesNodes(source: NormalizedNode, target: NormalizedNode, edge: NormalizedEdge, points: DrawioPointSpec[], nodes: NormalizedNode[]) {
  const route = edgeRoutePoints({ ...edge, points } as NormalizedEdge, source.geometry, target.geometry)
  const obstacles = socNodeObstacles(nodes, edge).map((geometry) => inflateGeometry(geometry, 4))
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index]
    const end = route[index + 1]
    if (!isFinitePoint(start) || !isFinitePoint(end)) continue
    if (obstacles.some((obstacle) => segmentIntersectsBox(start, end, obstacle))) return true
  }
  return false
}

function socRouteOverlapsPrevious(
  source: NormalizedNode,
  target: NormalizedNode,
  edge: NormalizedEdge,
  points: DrawioPointSpec[],
  routedSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>,
) {
  const route = edgeRoutePoints({ ...edge, points } as NormalizedEdge, source.geometry, target.geometry)
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index]
    const end = route[index + 1]
    if (!isFinitePoint(start) || !isFinitePoint(end)) continue
    if (routedSegments.some((segment) => collinearOverlap(start, end, segment.start, segment.end))) return true
  }
  return false
}

function expandSocContainersToFitChildren(containers: NormalizedContainer[], nodes: NormalizedNode[], warnings: string[]) {
  let expanded = 0
  for (const container of containers) {
    const owned = nodes.filter((node) => node.parent === container.id || node.ownerContainer === container.id)
    if (!owned.length) continue
    const narrowVertical = container.geometry.width <= 120 && container.geometry.height >= container.geometry.width * 2.2
    const horizontalPadding = narrowVertical ? 2 : 14
    const topPadding = narrowVertical ? 2 : 58
    const bottomPadding = narrowVertical ? 2 : 14
    const minX = Math.min(...owned.map((node) => node.geometry.x))
    const minY = Math.min(...owned.map((node) => node.geometry.y))
    const maxX = Math.max(...owned.map((node) => node.geometry.x + node.geometry.width))
    const maxY = Math.max(...owned.map((node) => node.geometry.y + node.geometry.height))
    const dx = minX < horizontalPadding ? horizontalPadding - minX : 0
    const dy = minY < topPadding ? topPadding - minY : 0
    if (dx || dy) {
      for (const node of owned) {
        node.geometry = shiftGeometry(node.geometry, dx, dy)
      }
    }
    const neededWidth = maxX + dx + horizontalPadding
    const neededHeight = maxY + dy + bottomPadding
    const nextWidth = Math.max(container.geometry.width, neededWidth)
    const nextHeight = Math.max(container.geometry.height, neededHeight)
    if (nextWidth > container.geometry.width || nextHeight > container.geometry.height) {
      container.geometry = {
        ...container.geometry,
        width: nextWidth,
        height: nextHeight,
      }
      expanded += 1
    }
  }
  if (expanded > 0) {
    warn(warnings, `Expanded ${expanded} SoC container(s) after text fitting so child modules keep visible padding.`)
  }
  const nestedExpanded = expandSocContainersToFitNestedContainers(containers, nodes)
  if (nestedExpanded > 0) {
    warn(warnings, `Expanded ${nestedExpanded} SoC container(s) to keep visually nested regions fully inside their enclosing region.`)
  }
}

function spreadSocContainerModuleColumns(containers: NormalizedContainer[], nodes: NormalizedNode[]) {
  let spreadContainers = 0
  for (const container of containers) {
    if (isNarrowSocContainer(container.geometry)) continue
    const owned = nodes.filter((node) => node.parent === container.id && node.visualRole !== "legend-note")
    if (owned.length < 3) continue
    const columns = clusterSocModuleColumns(owned)
    if (columns.length < 3) continue
    const padding = socContainerModulePadding(container.geometry)
    const availableWidth = container.geometry.width - padding * 2
    if (availableWidth <= 260) continue
    const ownedBounds = nodeBounds(owned)
    const rightUnused = container.geometry.width - padding - (ownedBounds.x + ownedBounds.width)
    if (ownedBounds.width >= availableWidth * 0.78 || rightUnused < 76) continue
    const columnWidths = columns.map((column) => Math.max(...column.nodes.map((node) => node.geometry.width)))
    const minGap = 22
    const totalColumnWidth = columnWidths.reduce((sum, width) => sum + width, 0)
    if (totalColumnWidth + minGap * (columns.length - 1) > availableWidth) continue
    const gap = (availableWidth - totalColumnWidth) / Math.max(1, columns.length - 1)
    if (!Number.isFinite(gap) || gap < minGap) continue
    let cursor = padding
    columns.forEach((column, index) => {
      const columnWidth = columnWidths[index] ?? 0
      for (const node of column.nodes) {
        node.geometry = {
          ...node.geometry,
          x: cursor + (columnWidth - node.geometry.width) / 2,
        }
      }
      cursor += columnWidth + gap
    })
    spreadContainers += 1
  }
  return spreadContainers
}

function isNarrowSocContainer(geometry: Geometry) {
  return geometry.width <= 120 && geometry.height >= geometry.width * 2.2
}

function socContainerModulePadding(geometry: Geometry) {
  return Math.max(28, Math.min(54, geometry.width * 0.055))
}

function clusterSocModuleColumns(nodes: NormalizedNode[]) {
  const sorted = nodes
    .map((node) => ({ node, centerX: centerPoint(node.geometry).x }))
    .sort((left, right) => left.centerX - right.centerX)
  const widthMedian = median(nodes.map((node) => node.geometry.width))
  const threshold = Math.max(42, Math.min(76, widthMedian * 0.72))
  const columns: Array<{ centerX: number; nodes: NormalizedNode[] }> = []
  for (const item of sorted) {
    const column = columns.find((candidate) => Math.abs(candidate.centerX - item.centerX) <= threshold)
    if (column) {
      column.nodes.push(item.node)
      column.centerX = column.nodes.reduce((sum, node) => sum + centerPoint(node.geometry).x, 0) / column.nodes.length
    } else {
      columns.push({ centerX: item.centerX, nodes: [item.node] })
    }
  }
  return columns
}

function expandSocContainersToFitNestedContainers(containers: NormalizedContainer[], nodes: NormalizedNode[]) {
  let expanded = 0
  const padding = 16
  for (const outer of containers) {
    for (const inner of containers) {
      if (outer.id === inner.id || outer.parent !== inner.parent) continue
      const outerArea = Math.max(1, outer.geometry.width * outer.geometry.height)
      const innerArea = Math.max(1, inner.geometry.width * inner.geometry.height)
      if (outerArea <= innerArea * 1.15) continue
      if (!pointInsideGeometry(centerPoint(inner.geometry), outer.geometry)) continue
      const siblingShift = shiftNestedSocContainerBelowSiblingNodes(outer, inner, containers, nodes, padding)
      if (siblingShift > 0) {
        inner.geometry = shiftGeometry(inner.geometry, 0, siblingShift)
        expanded += 1
      }
      const neededRight = inner.geometry.x + inner.geometry.width + padding
      const neededBottom = inner.geometry.y + inner.geometry.height + padding
      const nextWidth = Math.max(outer.geometry.width, neededRight - outer.geometry.x)
      const nextHeight = Math.max(outer.geometry.height, neededBottom - outer.geometry.y)
      if (nextWidth > outer.geometry.width || nextHeight > outer.geometry.height) {
        outer.geometry = { ...outer.geometry, width: nextWidth, height: nextHeight }
        expanded += 1
      }
    }
  }
  return expanded
}

function shiftNestedSocContainerBelowSiblingNodes(
  outer: NormalizedContainer,
  inner: NormalizedContainer,
  containers: NormalizedContainer[],
  nodes: NormalizedNode[],
  gap: number,
) {
  const rootView = rootGeometryView(containers, nodes)
  const rootNodesById = new Map(rootView.nodes.map((node) => [node.id, node]))
  let shiftDown = 0
  for (const node of nodes) {
    if (node.parent !== outer.id && node.ownerContainer !== outer.id) continue
    const rootNode = rootNodesById.get(node.id)
    if (!rootNode) continue
    const area = intersectionArea(rootNode.geometry, inner.geometry)
    if (area <= 80) continue
    const neededY = rootNode.geometry.y + rootNode.geometry.height + gap
    shiftDown = Math.max(shiftDown, neededY - inner.geometry.y)
  }
  return Math.max(0, shiftDown)
}

function socEdgeRouteHints(visualPlan: VisualPlan) {
  const hints = asRecord(asRecord(visualPlan.styleHints)?.socLayout) ?? asRecord(asRecord(visualPlan.styleHints)?.soc)
  const result = new Map<string, DrawioPointSpec[]>()
  for (const item of arrayRecords(hints?.edges)) {
    const id = stringField(item, "id") || stringField(item, "edge")
    if (!id) continue
    const points = arrayRecords(item.points).map((point) => ({
      x: numberField(point, "x"),
      y: numberField(point, "y"),
    })).filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    if (points.length) result.set(id, points)
  }
  return result
}

function fitSocNodeGeometry(node: NormalizedNode, geometry: Geometry): Geometry {
  if (geometry.width <= 74 && geometry.height >= geometry.width * 1.8) {
    node.style = joinStyle([node.style, "horizontal=0;align=center;verticalAlign=middle;spacing=4;fontSize=10;"])
    return geometry
  }
  const wrappedLabel = wrapSocNodeLabelForWidth(node.label, geometry.width)
  if (wrappedLabel !== node.label) node.label = wrappedLabel
  const lines = String(node.label || "").split(/\n/).filter(Boolean)
  const maxLineWeight = Math.max(...(lines.length ? lines : [node.label]).map(weightedTextLength), 0)
  const minWidth = Math.min(180, Math.max(geometry.width, Math.ceil(maxLineWeight * 7.4)))
  const lineCapacity = Math.max(1, Math.floor((geometry.height - 18) / 18))
  const minHeight = lines.length > lineCapacity ? geometry.height + (lines.length - lineCapacity) * 18 : geometry.height
  return {
    ...geometry,
    width: Math.max(geometry.width, minWidth),
    height: Math.max(geometry.height, minHeight),
  }
}

function wrapSocNodeLabelForWidth(label: string, width: number) {
  const value = String(label || "")
  if (value.includes("\n") || width >= 92) return value
  const parts = value.split(/(\s+|\/)/).filter((part) => part.length > 0)
  if (parts.length < 3) return value
  const lines: string[] = []
  let current = ""
  const capacity = Math.max(6, width / 7.4)
  for (const part of parts) {
    const next = `${current}${part}`
    if (current && weightedTextLength(next) > capacity) {
      lines.push(current.trim())
      current = part.trimStart()
    } else {
      current = next
    }
  }
  if (current.trim()) lines.push(current.trim())
  return lines.length > 1 && lines.length <= 3 ? lines.join("\n") : value
}

function socLineRoute(
  sourceNode: NormalizedNode,
  targetNode: NormalizedNode,
  edge: NormalizedEdge,
  nodes: NormalizedNode[],
  bounds: Geometry,
  routedSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>,
): DrawioPointSpec[] {
  const source = sourceNode.geometry
  const target = targetNode.geometry
  const sourceCenter = centerPoint(source)
  const targetCenter = centerPoint(target)
  const dx = Math.abs(sourceCenter.x - targetCenter.x)
  const dy = Math.abs(sourceCenter.y - targetCenter.y)
  const midX = (sourceCenter.x + targetCenter.x) / 2
  const midY = (sourceCenter.y + targetCenter.y) / 2
  const topY = bounds.y - 72
  const bottomY = bounds.y + bounds.height + 72
  const leftX = bounds.x - 72
  const rightX = bounds.x + bounds.width + 72
  const candidates: DrawioPointSpec[][] = []
  if (dx <= 16 || dy <= 16) {
    candidates.push([{ x: midX, y: midY }])
  }
  candidates.push(
    [{ x: midX, y: sourceCenter.y }, { x: midX, y: targetCenter.y }],
    [{ x: sourceCenter.x, y: midY }, { x: targetCenter.x, y: midY }],
    [{ x: targetCenter.x, y: sourceCenter.y }],
    [{ x: sourceCenter.x, y: targetCenter.y }],
    [{ x: sourceCenter.x, y: topY }, { x: targetCenter.x, y: topY }],
    [{ x: sourceCenter.x, y: bottomY }, { x: targetCenter.x, y: bottomY }],
    [{ x: leftX, y: sourceCenter.y }, { x: leftX, y: targetCenter.y }],
    [{ x: rightX, y: sourceCenter.y }, { x: rightX, y: targetCenter.y }],
  )
  const sameParent = sourceNode.parent === targetNode.parent ? sourceNode.parent : ""
  const obstacles = nodes
    .filter((node) => node.id !== edge.source && node.id !== edge.target && node.visualRole !== "legend-note")
    .filter((node) => !sameParent || node.parent === sameParent)
    .map((node) => inflateGeometry(node.geometry, 8))
  return chooseLowestCostSocRoute(source, target, candidates, obstacles, routedSegments)
}

function socLocalRailRoute(
  sourceNode: NormalizedNode,
  targetNode: NormalizedNode,
  edge: NormalizedEdge,
  containersById: Map<string, NormalizedContainer>,
  nodes: NormalizedNode[],
  routedSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>,
  side: NonNullable<NormalizedEdge["rail"]>,
  offset: number,
): DrawioPointSpec[] {
  const source = sourceNode.geometry
  const target = targetNode.geometry
  const routeBounds = socRailLocalBounds(sourceNode, targetNode, containersById)
  const sourceContainer = containersById.get(sourceNode.parent)?.geometry
  const targetContainer = containersById.get(targetNode.parent)?.geometry
  const sourceCenter = centerPoint(source)
  const targetCenter = centerPoint(target)
  const baseMargin = 58
  const sideMargin = 28 + offset
  const sameParent = sourceNode.parent === targetNode.parent
  const candidates: DrawioPointSpec[][] = []
  if (side === "left" || side === "right") {
    const direction = side === "left" ? -1 : 1
    const baseX = side === "left" ? routeBounds.x - baseMargin : routeBounds.x + routeBounds.width + baseMargin
    const xLanes = uniqueNumbers([
      baseX,
      baseX + direction * offset,
      baseX + direction * (offset + 56),
      baseX + direction * (offset + 112),
    ])
    for (const x of xLanes) {
      candidates.push([{ x, y: sourceCenter.y }, { x, y: targetCenter.y }])
      if (sameParent) {
        const sourceExitYs = uniqueNumbers([source.y - sideMargin, source.y + source.height + sideMargin])
        const targetEntryYs = uniqueNumbers([target.y - sideMargin, target.y + target.height + sideMargin])
        for (const sourceExitY of sourceExitYs) {
          for (const targetEntryY of targetEntryYs) {
            candidates.push([
              { x: sourceCenter.x, y: sourceExitY },
              { x, y: sourceExitY },
              { x, y: targetEntryY },
              { x: targetCenter.x, y: targetEntryY },
            ])
          }
        }
        continue
      }
      const sourceExitY = sourceCenter.y <= targetCenter.y
        ? (sourceContainer ? sourceContainer.y + sourceContainer.height + sideMargin : source.y + source.height + sideMargin)
        : (sourceContainer ? sourceContainer.y - sideMargin : source.y - sideMargin)
      const targetEntryY = sourceCenter.y <= targetCenter.y
        ? (targetContainer ? targetContainer.y - sideMargin : target.y - sideMargin)
        : (targetContainer ? targetContainer.y + targetContainer.height + sideMargin : target.y + target.height + sideMargin)
      candidates.push(
        [{ x, y: sourceExitY }, { x, y: targetEntryY }, { x: targetCenter.x, y: targetEntryY }],
        [{ x: sourceCenter.x, y: sourceExitY }, { x, y: sourceExitY }, { x, y: targetEntryY }, { x: targetCenter.x, y: targetEntryY }],
      )
    }
  } else {
    const direction = side === "top" ? -1 : 1
    const baseY = side === "top" ? routeBounds.y - baseMargin : routeBounds.y + routeBounds.height + baseMargin
    const yLanes = uniqueNumbers([
      baseY,
      baseY + direction * offset,
      baseY + direction * (offset + 56),
      baseY + direction * (offset + 112),
    ])
    for (const y of yLanes) {
      candidates.push([{ x: sourceCenter.x, y }, { x: targetCenter.x, y }])
      if (sameParent) {
        const sourceExitXs = uniqueNumbers([source.x - sideMargin, source.x + source.width + sideMargin])
        const targetEntryXs = uniqueNumbers([target.x - sideMargin, target.x + target.width + sideMargin])
        for (const sourceExitX of sourceExitXs) {
          for (const targetEntryX of targetEntryXs) {
            candidates.push([
              { x: sourceExitX, y: sourceCenter.y },
              { x: sourceExitX, y },
              { x: targetEntryX, y },
              { x: targetEntryX, y: targetCenter.y },
            ])
          }
        }
        continue
      }
      const sourceExitX = sourceCenter.x <= targetCenter.x
        ? (sourceContainer ? sourceContainer.x + sourceContainer.width + sideMargin : source.x + source.width + sideMargin)
        : (sourceContainer ? sourceContainer.x - sideMargin : source.x - sideMargin)
      const targetEntryX = sourceCenter.x <= targetCenter.x
        ? (targetContainer ? targetContainer.x - sideMargin : target.x - sideMargin)
        : (targetContainer ? targetContainer.x + targetContainer.width + sideMargin : target.x + target.width + sideMargin)
      candidates.push(
        [{ x: sourceExitX, y }, { x: targetEntryX, y }, { x: targetEntryX, y: targetCenter.y }],
        [{ x: sourceExitX, y: sourceCenter.y }, { x: sourceExitX, y }, { x: targetEntryX, y }, { x: targetEntryX, y: targetCenter.y }],
      )
    }
  }
  const obstacles = nodes
    .filter((node) => node.id !== edge.source && node.id !== edge.target && node.visualRole !== "legend-note")
    .map((node) => inflateGeometry(node.geometry, 8))
  const cleanCandidates = candidates.filter((candidate) => !socRouteCandidateTouchesObstacles(source, target, candidate, obstacles))
  const candidatePool = cleanCandidates.length ? cleanCandidates : candidates
  return removeRedundantRoutePoints(chooseLowestCostSocRoute(source, target, candidatePool, obstacles, routedSegments))
}

function uniqueNumbers(values: number[]) {
  const result: number[] = []
  for (const value of values) {
    if (!Number.isFinite(value)) continue
    if (result.some((existing) => Math.abs(existing - value) < 1)) continue
    result.push(value)
  }
  return result
}

function socRouteCandidateTouchesObstacles(source: Geometry, target: Geometry, points: DrawioPointSpec[], obstacles: Geometry[]) {
  const route = edgeRoutePoints({ points } as NormalizedEdge, source, target).filter(isFinitePoint)
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index]
    const end = route[index + 1]
    if (!start || !end) continue
    if (obstacles.some((obstacle) => segmentIntersectsBox(start, end, obstacle))) return true
  }
  return false
}

function socRailLocalBounds(sourceNode: NormalizedNode, targetNode: NormalizedNode, containersById: Map<string, NormalizedContainer>) {
  const geometries = [sourceNode.geometry, targetNode.geometry]
  const sourceContainer = containersById.get(sourceNode.parent)
  const targetContainer = containersById.get(targetNode.parent)
  if (sourceContainer) geometries.push(sourceContainer.geometry)
  if (targetContainer && targetContainer.id !== sourceContainer?.id) geometries.push(targetContainer.geometry)
  return geometryBounds(geometries)
}

function geometryBounds(geometries: Geometry[]): Geometry {
  if (!geometries.length) return { x: 0, y: 0, width: 0, height: 0 }
  const minX = Math.min(...geometries.map((geometry) => geometry.x))
  const minY = Math.min(...geometries.map((geometry) => geometry.y))
  const maxX = Math.max(...geometries.map((geometry) => geometry.x + geometry.width))
  const maxY = Math.max(...geometries.map((geometry) => geometry.y + geometry.height))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function chooseLowestCostSocRoute(
  source: Geometry,
  target: Geometry,
  candidates: DrawioPointSpec[][],
  obstacles: Geometry[],
  routedSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>,
) {
  let best = candidates[0] ?? []
  let bestCost = Number.POSITIVE_INFINITY
  for (const candidate of candidates) {
    const cost = socRouteCost(source, target, candidate, obstacles, routedSegments)
    if (cost >= bestCost) continue
    best = candidate
    bestCost = cost
  }
  return best
}

function socRouteCost(
  source: Geometry,
  target: Geometry,
  points: DrawioPointSpec[],
  obstacles: Geometry[],
  routedSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>,
) {
  const route = edgeRoutePoints({ points } as NormalizedEdge, source, target).filter(isFinitePoint)
  let cost = points.length * 28
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index]
    const end = route[index + 1]
    if (!start || !end) continue
    cost += Math.abs(start.x - end.x) * 0.015 + Math.abs(start.y - end.y) * 0.015
    for (const obstacle of obstacles) {
      if (segmentIntersectsBox(start, end, obstacle)) cost += 100000
    }
    for (const segment of routedSegments.slice(-120)) {
      if (lineSegmentsIntersect(start, end, segment.start, segment.end)) cost += 12000
      if (collinearOverlap(start, end, segment.start, segment.end)) cost += 8000
    }
  }
  return cost
}

function rememberSocRouteSegments(
  edge: NormalizedEdge,
  nodesById: Map<string, NormalizedNode>,
  routedSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>,
) {
  if (!edge.source || !edge.target) return
  const source = nodesById.get(edge.source)
  const target = nodesById.get(edge.target)
  if (!source || !target) return
  const route = edgeRoutePoints(edge, source.geometry, target.geometry)
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index]
    const end = route[index + 1]
    if (!isFinitePoint(start) || !isFinitePoint(end)) continue
    routedSegments.push({ start, end })
  }
}

function styleSocBlockCells(containers: NormalizedContainer[], nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  const palette = [
    { fill: "#eff6ff", stroke: "#60a5fa" },
    { fill: "#fce7f3", stroke: "#f472b6" },
    { fill: "#dcfce7", stroke: "#84cc16" },
    { fill: "#e0f2fe", stroke: "#38bdf8" },
    { fill: "#fef9c3", stroke: "#a3a3a3" },
    { fill: "#ede9fe", stroke: "#8b5cf6" },
  ]
  const rootView = rootGeometryView(containers, nodes)
  const rootContainersById = new Map(rootView.containers.map((container) => [container.id, container]))
  const graphBounds = nodeAndContainerBounds(rootView.nodes, rootView.containers)
  const graphCenterX = graphBounds.x + graphBounds.width / 2
  containers.forEach((container, index) => {
    const color = palette[index % palette.length] ?? palette[0]
    const narrowVertical = container.geometry.width <= 120 && container.geometry.height >= container.geometry.width * 2.2
    const ownsNodes = nodes.some((node) => node.parent === container.id || node.ownerContainer === container.id)
    const rootContainer = rootContainersById.get(container.id) ?? container
    const labelSide = rootContainer.geometry.x + rootContainer.geometry.width / 2 < graphCenterX ? "left" : "right"
    const externalVerticalLabel = narrowVertical && ownsNodes
      ? `horizontal=0;labelPosition=${labelSide};align=${labelSide === "left" ? "right" : "left"};verticalLabelPosition=middle;verticalAlign=middle;spacing=8;fontSize=16;labelBackgroundColor=#ffffff;`
      : ""
    const containerTitlePlacement = externalVerticalLabel || (narrowVertical
      ? "horizontal=0;align=center;verticalAlign=middle;spacing=8;fontSize=16;labelBackgroundColor=#ffffff;"
      : "verticalAlign=top;align=center;spacingTop=10;fontSize=15;labelBackgroundColor=#ffffff;")
    container.style = joinStyle([
      container.style,
      `fillColor=${color.fill};fillOpacity=68;strokeColor=${color.stroke};strokeWidth=2;fontStyle=1;fontSize=13;`,
      containerTitlePlacement,
    ])
  })
  for (const node of nodes) {
    if (node.visualRole === "bus-junction") continue
    const port = compactKey(node.visualRole ?? "", "") === "port"
    node.style = joinStyle([
      node.style,
      port
        ? "fillColor=#fff7ed;strokeColor=#f97316;strokeWidth=2;fontSize=10;"
        : "fillColor=#f8fafc;strokeColor=#2563eb;strokeWidth=2;fontSize=10;",
    ])
  }
  for (const edge of edges) {
    if (edge.presentationMode === "rail") {
      edge.style = joinStyle([edge.style, "strokeColor=#64748b;dashed=1;strokeWidth=2;fontSize=9;"])
    } else if (compactKey(edge.edgeKind ?? "", "") === "bus" || compactKey(edge.pathRole ?? "", "") === "bus") {
      edge.style = joinStyle([edge.style, "strokeColor=#92400e;strokeWidth=5;fontSize=9;"])
    }
  }
}

function applySocReadableEdgePresentation(
  containers: NormalizedContainer[],
  nodes: NormalizedNode[],
  edges: NormalizedEdge[],
  warnings: string[],
) {
  const rootView = rootGeometryView(containers, nodes)
  const nodesById = new Map(rootView.nodes.map((node) => [node.id, node]))
  let suppressedLabels = 0
  let softenedShortArrows = 0
  for (const edge of edges) {
    edge.fullLabel = edge.fullLabel || edge.label
    const priority = compactKey(edge.labelPriority ?? "", "")
    const visibleLowValueLabel = edge.label && priority !== "high" && edge.presentationMode !== "legend"
    if (visibleLowValueLabel) {
      edge.label = ""
      suppressedLabels += 1
    }

    if (!edge.source || !edge.target) continue
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (!source || !target) continue
    const route = edgeRoutePoints(edge, source.geometry, target.geometry)
    const routeLengthValue = polylineLength(route)
    if (routeLengthValue <= 0 || routeLengthValue >= 132) continue
    if (!isHeavyBusLikeEdge(edge)) continue
    edge.style = joinStyle([edge.style, "strokeWidth=3;endSize=7;startSize=7;"])
    softenedShortArrows += 1
  }
  if (suppressedLabels > 0) {
    warn(warnings, `Suppressed ${suppressedLabels} non-high-priority SoC edge label(s) from the visible canvas to avoid text-line overlap; full labels remain in normalizedSpec edge.fullLabel.`)
  }
  if (softenedShortArrows > 0) {
    warn(warnings, `Softened ${softenedShortArrows} short heavy SoC connector(s) so local arrows keep visual proportion.`)
  }
}

function isHeavyBusLikeEdge(edge: NormalizedEdge) {
  const kind = compactKey(edge.edgeKind ?? "", "")
  const role = compactKey(edge.pathRole ?? "", "")
  return kind === "bus" || role === "bus" || parsedStyleNumber(edge.style, "strokeWidth") >= 5
}

function parsedStyleNumber(style: string, key: string) {
  const match = new RegExp(`(?:^|;)${key}=(-?\\d+(?:\\.\\d+)?)(?:;|$)`).exec(style)
  return match?.[1] ? Number(match[1]) : 0
}

function polylineLength(points: Array<{ x?: number; y?: number }>) {
  let total = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]
    const end = points[index + 1]
    if (!isFinitePoint(start) || !isFinitePoint(end)) continue
    total += Math.abs(end.x - start.x) + Math.abs(end.y - start.y)
  }
  return total
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
  const materialized = containers.flatMap((container) => {
    if (container.layoutMode !== "weak-band") return container
    const ownedNodes = nodes.filter((node) => node.ownerContainer === container.id)
    if (ownedNodes.length === 1 && !container.allowEmpty) {
      warn(warnings, `Skipped singleton weak-band "${container.label}" in embedded-fsm-flow; single-node ownership is kept as metadata instead of drawing a large background region.`)
      return []
    }
    if (!ownedNodes.length) {
      if (container.allowEmpty) return {
        ...container,
        parent: "1",
      }
      warn(warnings, `Skipped empty weak-band "${container.label}" because no node ownership was provided by the model/active skill.`)
      return []
    }
    const clusters = clusterWeakBandNodes(ownedNodes)
    const renderableClusters = clusters.filter((cluster) => cluster.length > 1 || container.allowEmpty)
    if (!renderableClusters.length) {
      warn(warnings, `Skipped weak-band "${container.label}" because its ownership split into singleton segment(s); ownership is kept as metadata instead of drawing sparse background regions.`)
      return []
    }
    warn(warnings, `Rendered embedded-fsm-flow container "${container.label}" as a weak background band so flow edges stay on the root layout plane.`)
    return renderableClusters.map((cluster, index) => ({
      ...container,
      id: renderableClusters.length === 1 ? container.id : `${container.id}-segment-${index + 1}`,
      parent: "1",
      geometry: boundingBandGeometry(cluster),
    }))
  })
  return separateWeakBandContainerOverlaps(materialized, warnings)
}

function clusterWeakBandNodes(nodes: NormalizedNode[]) {
  if (nodes.length <= 1) return [nodes]
  const bounds = boundingBandGeometry(nodes)
  const verticalSpread = bounds.height
  const horizontalSpread = bounds.width
  const vertical = verticalSpread >= horizontalSpread
  const sorted = [...nodes].sort((a, b) => {
    const primary = vertical ? a.geometry.y - b.geometry.y : a.geometry.x - b.geometry.x
    if (Math.abs(primary) > 1) return primary
    return vertical ? a.geometry.x - b.geometry.x : a.geometry.y - b.geometry.y
  })
  const sizes = sorted.map((node) => vertical ? node.geometry.height : node.geometry.width).sort((a, b) => a - b)
  const medianSize = sizes[Math.floor(sizes.length / 2)] ?? 72
  const gapThreshold = Math.max(240, medianSize * 3.2)
  const clusters: NormalizedNode[][] = []
  let current: NormalizedNode[] = []
  let currentMax = Number.NEGATIVE_INFINITY
  for (const node of sorted) {
    const start = vertical ? node.geometry.y : node.geometry.x
    const end = start + (vertical ? node.geometry.height : node.geometry.width)
    if (current.length && start - currentMax > gapThreshold) {
      clusters.push(current)
      current = []
    }
    current.push(node)
    currentMax = Math.max(currentMax, end)
  }
  if (current.length) clusters.push(current)
  return clusters
}

function separateWeakBandContainerOverlaps(containers: NormalizedContainer[], warnings: string[]) {
  let repairs = 0
  const result = containers.map((container) => ({ ...container, geometry: { ...container.geometry } }))
  for (let outer = 0; outer < result.length; outer += 1) {
    for (let inner = outer + 1; inner < result.length; inner += 1) {
      const a = result[outer]
      const b = result[inner]
      if (!a || !b || a.parent !== b.parent) continue
      if (a.layoutMode !== "weak-band" || b.layoutMode !== "weak-band") continue
      const overlapWidth = Math.max(0, Math.min(a.geometry.x + a.geometry.width, b.geometry.x + b.geometry.width) - Math.max(a.geometry.x, b.geometry.x))
      const overlapHeight = Math.max(0, Math.min(a.geometry.y + a.geometry.height, b.geometry.y + b.geometry.height) - Math.max(a.geometry.y, b.geometry.y))
      if (overlapWidth <= 6 || overlapHeight <= 6 || overlapHeight > 48) continue
      const first = a.geometry.y <= b.geometry.y ? a : b
      const second = first === a ? b : a
      const nextHeight = second.geometry.y - first.geometry.y - 8
      if (nextHeight < 96 || nextHeight >= first.geometry.height) continue
      first.geometry = {
        ...first.geometry,
        height: nextHeight,
      }
      repairs += 1
    }
  }
  if (repairs > 0) {
    warn(warnings, `Trimmed ${repairs} adjacent weak-band boundary overlap(s) using generic sibling geometry separation.`)
  }
  return result
}

function applyVisualPlanDrivenLayout(nodes: NormalizedNode[], edges: NormalizedEdge[], containers: NormalizedContainer[], warnings: string[], visualPlan: VisualPlan) {
  const backbone = visualPlan.mainBackbone
  const structuralProfile = visualPlan.profile === "architecture" || visualPlan.profile === "soc-block"
  if (backbone?.nodes?.length) {
    const nodesByInputId = nodeLookup(nodes)
    const ordered = backbone.nodes
      .map((id) => nodesByInputId.get(id))
      .filter((node): node is NormalizedNode => Boolean(node))
    const direction = `${backbone.direction ?? ""}`.toLowerCase()
    const verticalBackbone = direction !== "right" && direction !== "horizontal" && !structuralProfile
    if (ordered.length >= 2 && verticalBackbone) {
      const minY = Math.min(...nodes.map((node) => node.geometry.y))
      const backboneX = median(ordered.map((node) => node.geometry.x))
      const gap = ordered.length >= 16 ? 88 : ordered.length >= 12 ? 104 : 128
      let nextY = Math.max(40, minY)
      for (const node of ordered) {
        node.geometry = {
          ...node.geometry,
          x: Math.max(40, backboneX),
          y: nextY,
        }
        nextY += node.geometry.height + gap
      }
      arrangeNonBackboneNodesAroundBackbone(nodes, edges, ordered, visualPlan)
      warnings.push(`Applied VisualPlan mainBackbone layout to ${ordered.length} node(s); semantic ordering came from the model/active skill.`)
    } else if (ordered.length >= 2 && structuralProfile) {
      warnings.push(`Preserved ELK structural layout for ${visualPlan.profile}; VisualPlan mainBackbone is used for review and metrics, not semantic reordering in compound diagrams.`)
    }
  }

  if (structuralProfile) {
    routeStructuralVisualPlanEdges(containers, nodes, edges)
    return
  }

  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const bounds = nodeBounds(nodes)
  let leftRail = bounds.x - 96
  let rightRail = bounds.x + bounds.width + 96
  let topRail = bounds.y - 72
  let bottomRail = bounds.y + bounds.height + 72
  for (const edge of edges) {
    if (edge.presentationMode !== "rail" || !edge.source || !edge.target) continue
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (!source || !target) continue
    const sourceCenter = centerPoint(source.geometry)
    const targetCenter = centerPoint(target.geometry)
    if (edge.rail === "left") {
      edge.points = [{ x: leftRail, y: sourceCenter.y }, { x: leftRail, y: targetCenter.y }]
      leftRail -= 28
    } else if (edge.rail === "top") {
      edge.points = [{ x: sourceCenter.x, y: topRail }, { x: targetCenter.x, y: topRail }]
      topRail -= 28
    } else if (edge.rail === "bottom") {
      edge.points = [{ x: sourceCenter.x, y: bottomRail }, { x: targetCenter.x, y: bottomRail }]
      bottomRail += 28
    } else {
      edge.points = [{ x: rightRail, y: sourceCenter.y }, { x: rightRail, y: targetCenter.y }]
      rightRail += 28
    }
  }
}

function routeStructuralVisualPlanEdges(containers: NormalizedContainer[], nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  const rootView = rootGeometryView(containers, nodes)
  const rootNodesById = new Map(rootView.nodes.map((node) => [node.id, node]))
  const rootContainersById = new Map(rootView.containers.map((container) => [container.id, container]))
  const railOffsets = new Map<string, number>()
  const routedSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }> = []
  for (const edge of edges) {
    if (!edge.source || !edge.target) continue
    const source = rootNodesById.get(edge.source)
    const target = rootNodesById.get(edge.target)
    if (!source || !target) continue
    if (edge.presentationMode === "rail") {
      const side = edge.rail ?? "right"
      const offset = railOffsets.get(side) ?? 0
      railOffsets.set(side, offset + 56)
      edge.points = socLocalRailRoute(source, target, edge, rootContainersById, rootView.nodes, routedSegments, side, offset)
      rememberSocRouteSegments(edge, rootNodesById, routedSegments)
      continue
    }
    const alignedRoute = unobstructedAlignedSocRoute(source, target, edge, rootView.nodes)
    if (alignedRoute) edge.points = alignedRoute
    rememberSocRouteSegments(edge, rootNodesById, routedSegments)
  }
}

function arrangeNonBackboneNodesAroundBackbone(
  nodes: NormalizedNode[],
  edges: NormalizedEdge[],
  backboneNodes: NormalizedNode[],
  visualPlan: VisualPlan,
) {
  const backboneIds = new Set(backboneNodes.map((node) => node.id))
  const backboneSourceIds = new Set(backboneNodes.map((node) => node.sourceId ?? node.id))
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const anchorByNodeId = new Map<string, number>()
  for (const node of backboneNodes) anchorByNodeId.set(node.id, centerPoint(node.geometry).y)
  for (let pass = 0; pass < 4; pass += 1) {
    let changed = false
    for (const node of nodes) {
      if (node.parent !== "1" || backboneIds.has(node.id) || anchorByNodeId.has(node.id) || node.visualRole === "legend-note") continue
      const anchors = edges.flatMap((edge) => {
        const otherId = edge.source === node.id ? edge.target : edge.target === node.id ? edge.source : undefined
        if (!otherId) return []
        const other = byId.get(otherId)
        if (!other) return []
        if (backboneIds.has(other.id) || backboneSourceIds.has(other.sourceId ?? other.id)) return [centerPoint(other.geometry).y]
        const propagated = anchorByNodeId.get(other.id)
        return propagated === undefined ? [] : [propagated]
      })
      if (!anchors.length) continue
      anchorByNodeId.set(node.id, median(anchors))
      changed = true
    }
    if (!changed) break
  }
  const backboneBounds = nodeBounds(backboneNodes)
  const left: Array<{ node: NormalizedNode; anchorY: number }> = []
  const right: Array<{ node: NormalizedNode; anchorY: number }> = []
  const sideGap = visualPlan.profile === "code-flow" ? 260 : 280
  for (const node of nodes) {
    if (node.parent !== "1" || backboneIds.has(node.id) || node.visualRole === "legend-note") continue
    const incident = edges.filter((edge) => edge.source === node.id || edge.target === node.id)
    const anchorY = anchorByNodeId.get(node.id)
    if (anchorY === undefined) continue
    const rail = incident.map((edge) => edge.rail).find((value) => value === "left" || value === "right")
    const branchLineCount = incident.filter((edge) => edge.presentationMode === "line").length
    const side = rail === "left" ? "left" : rail === "right" ? "right" : branchLineCount > 1 ? (left.length <= right.length ? "left" : "right") : (centerPoint(node.geometry).x < centerPoint(backboneBounds).x ? "left" : "right")
    ;(side === "left" ? left : right).push({ node, anchorY })
  }
  stackSideColumn(left, backboneBounds.x - sideGap - maxNodeWidth(left.map((item) => item.node)))
  stackSideColumn(right, backboneBounds.x + backboneBounds.width + sideGap)
}

function stackSideColumn(items: Array<{ node: NormalizedNode; anchorY: number }>, x: number) {
  items.sort((left, right) => left.anchorY - right.anchorY)
  let previousBottom = Number.NEGATIVE_INFINITY
  for (const item of items) {
    const y = Math.max(item.anchorY - item.node.geometry.height / 2, previousBottom + 36)
    item.node.geometry = {
      ...item.node.geometry,
      x,
      y,
    }
    previousBottom = y + item.node.geometry.height
  }
}

function maxNodeWidth(nodes: NormalizedNode[]) {
  return Math.max(0, ...nodes.map((node) => node.geometry.width))
}

function nodeAndContainerBounds(nodes: NormalizedNode[], containers: NormalizedContainer[]) {
  const geometries = [
    ...nodes.filter((node) => node.visualRole !== "legend-note").map((node) => node.geometry),
    ...containers.filter((container) => container.id !== "g-visual-plan-legend").map((container) => container.geometry),
  ]
  if (!geometries.length) return { x: 0, y: 0, width: 0, height: 0 }
  const minX = Math.min(...geometries.map((geometry) => geometry.x))
  const minY = Math.min(...geometries.map((geometry) => geometry.y))
  const maxX = Math.max(...geometries.map((geometry) => geometry.x + geometry.width))
  const maxY = Math.max(...geometries.map((geometry) => geometry.y + geometry.height))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function materializeVisualPlanLegend(nodes: NormalizedNode[], containers: NormalizedContainer[], visualPlan: VisualPlan) {
  const legend = visualPlan.legend
  if (!legend?.items.length) return { containers: [] as NormalizedContainer[], nodes: [] as NormalizedNode[] }
  const renderedItems = legend.items.slice(0, 12)
  const overflow = Math.max(0, legend.items.length - renderedItems.length)
  if (overflow > 0) {
    renderedItems.push({
      id: "visual-plan-legend-overflow",
      label: `+${overflow} more item(s) in warnings / normalizedSpec visualPlan`,
    })
  }
  const rootView = rootGeometryView(containers, nodes)
  const bounds = nodeAndContainerBounds(rootView.nodes, rootView.containers)
  const width = legend.position === "bottom" ? Math.max(420, Math.min(760, bounds.width)) : 420
  const rowHeight = 40
  const height = Math.max(120, 64 + renderedItems.length * rowHeight)
  const x = legend.position === "bottom" ? bounds.x : bounds.x + bounds.width + 80
  const y = legend.position === "bottom" ? bounds.y + bounds.height + 80 : bounds.y
  const container: NormalizedContainer = {
    id: "g-visual-plan-legend",
    label: diagramLabel(legend.title || "Legend / Evidence", 120, 28, 2),
    kind: "container",
    parent: "1",
    layoutMode: "weak-band",
    explicitLayoutMode: true,
    allowEmpty: true,
    geometry: { x, y, width, height },
    style: "rounded=1;whiteSpace=wrap;html=0;container=0;collapsible=0;fillColor=#ffffff;strokeColor=#cbd5e1;strokeWidth=1;fontColor=#0f172a;fontStyle=1;verticalAlign=top;spacingTop=10;",
  }
  const legendNodes: NormalizedNode[] = renderedItems.map((item, index) => {
    const marker = item.marker || (item.edgeId ? item.edgeId : item.nodeId) || item.id || `L${index + 1}`
    const label = diagramLabel([marker, item.label || item.text || item.detail].filter(Boolean).join(" - "), 180, 34, 2)
    return {
      id: normalizeId(`n-visual-plan-legend-${index + 1}-${item.id || "item"}`),
      label,
      shape: "roundedrect",
      parent: container.id,
      geometry: {
        x: 20,
        y: 44 + index * rowHeight,
        width: Math.max(160, width - 40),
        height: 30,
      },
      style: "rounded=1;whiteSpace=wrap;html=0;fillColor=#f8fafc;strokeColor=#e2e8f0;fontColor=#0f172a;fontSize=10;spacing=5;",
      explicitGeometry: true,
      visualRole: "legend-note",
      importance: 0.2,
    }
  })
  return { containers: [container], nodes: legendNodes }
}

function normalizeRootCoordinates(
  containers: NormalizedContainer[],
  nodes: NormalizedNode[],
  edges: NormalizedEdge[],
  warnings: string[],
  visualPlan: VisualPlan,
) {
  const primaryRootNodes = nodes.filter((node) => node.parent === "1" && node.visualRole !== "legend-note" && !node.id.startsWith("n-visual-plan-legend-"))
  if (!primaryRootNodes.length) return
  const bounds = nodeBounds(primaryRootNodes)
  const targetX = visualPlan.profile === "soc-block" ? 120 : 48
  const targetY = visualPlan.profile === "soc-block" ? 64 : 48
  const dx = targetX - bounds.x
  const dy = targetY - bounds.y
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return
  const shiftedContainers = new Set<string>()
  for (const container of containers) {
    if (container.parent !== "1") continue
    if (!shouldShiftRootContainer(container, nodes)) continue
    container.geometry = shiftGeometry(container.geometry, dx, dy)
    shiftedContainers.add(container.id)
  }
  for (const node of nodes) {
    if (node.parent !== "1") continue
    node.geometry = shiftGeometry(node.geometry, dx, dy)
  }
  for (const edge of edges) {
    edge.points = edge.points.map((point) => shiftPoint(point, dx, dy))
  }
  warn(warnings, `Normalized ${visualPlan.profile} root diagram coordinates to keep the model-authored main graph near the page margin; shifted ${primaryRootNodes.length} root node(s) and ${shiftedContainers.size} root container(s).`)
}

function shouldShiftRootContainer(container: NormalizedContainer, nodes: NormalizedNode[]) {
  if (container.id === "g-visual-plan-legend") return true
  const ownsNodes = nodes.some((node) => node.ownerContainer === container.id || node.parent === container.id)
  if (ownsNodes) return true
  return !container.allowEmpty
}

function shiftGeometry(geometry: Geometry, dx: number, dy: number): Geometry {
  return {
    ...geometry,
    x: geometry.x + dx,
    y: geometry.y + dy,
  }
}

function shiftPoint(point: DrawioPointSpec, dx: number, dy: number): DrawioPointSpec {
  return {
    x: Number.isFinite(point.x) ? (point.x ?? 0) + dx : point.x,
    y: Number.isFinite(point.y) ? (point.y ?? 0) + dy : point.y,
  }
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

function repairDrawioLayout(nodes: NormalizedNode[], edges: NormalizedEdge[], containers: NormalizedContainer[], warnings: string[], visualPlan: VisualPlan) {
  visualPlan.qualityGate.repairPasses += 1
  const nodeRepairs = separateOverlappingNodes(nodes)
  if (nodeRepairs > 0) {
    warn(warnings, `Design compiler repaired ${nodeRepairs} overlapping node placement(s) using generic same-parent geometry separation.`)
  }
  if (visualPlan.profile === "soc-block") {
    expandSocContainersToFitChildren(containers, nodes, warnings)
  }
  const rootView = rootGeometryView(containers, nodes)
  const outlierRepairs = discardOutlierLineEdgePoints(rootView.nodes, edges)
  if (outlierRepairs > 0) {
    warn(warnings, `Design compiler discarded ${outlierRepairs} outlier line edge route(s) whose bend points were far outside the rendered node bounds.`)
  }
  const explicitPointRepairs = ensureExplicitEdgePoints(rootView.nodes, edges)
  if (explicitPointRepairs > 0) {
    warn(warnings, `Design compiler generated explicit bend point(s) for ${explicitPointRepairs} visible edge(s) so routes are stable and inspectable.`)
  }
  const obstacleRouteRepairs = routeEdgesAroundNodeObstacles(rootView.nodes, rootView.containers, edges)
  if (obstacleRouteRepairs > 0) {
    visualPlan.qualityGate.edgePassThroughRepairs += obstacleRouteRepairs
    warn(warnings, `Design compiler rerouted ${obstacleRouteRepairs} visible edge(s) through a generic orthogonal obstacle-avoidance router.`)
  }
  const containerPassRepairs = visualPlan.profile === "soc-block" ? 0 : rerouteEdgesPassingThroughContainers(rootView.nodes, rootView.containers, edges)
  if (containerPassRepairs > 0) {
    visualPlan.qualityGate.edgePassThroughRepairs += containerPassRepairs
    warn(warnings, `Design compiler repaired ${containerPassRepairs} edge segment(s) that passed through unrelated container regions.`)
  }
  const passThroughRepairs = visualPlan.profile === "soc-block" ? 0 : rerouteEdgesPassingThroughNodes(rootView.nodes, edges)
  if (passThroughRepairs > 0) {
    visualPlan.qualityGate.edgePassThroughRepairs += passThroughRepairs
    warn(warnings, `Design compiler repaired ${passThroughRepairs} edge segment(s) that passed through nodes.`)
  }
  const straightRepairs = straightenUnobstructedAlignedLineEdges(rootView.nodes, rootView.containers, edges)
  if (straightRepairs > 0) {
    warn(warnings, `Design compiler straightened ${straightRepairs} aligned line edge(s) that had unnecessary bend points.`)
  }
  const overlapRepairs = fanOutOverlappingEdgeSegments(edges)
  if (overlapRepairs > 0) {
    visualPlan.qualityGate.edgeOverlapRepairs += overlapRepairs
    warn(warnings, `Design compiler repaired ${overlapRepairs} overlapping edge segment(s) by fanning out parallel routes.`)
  }
  if (visualPlan.profile === "soc-block") {
    applySocReadableEdgePresentation(containers, nodes, edges, warnings)
  }
}

function rootGeometryView(containers: NormalizedContainer[], nodes: NormalizedNode[]) {
  const containerById = new Map(containers.map((container) => [container.id, container]))
  const resolving = new Set<string>()
  const resolvedContainers = new Map<string, Geometry>()
  const resolveContainer = (container: NormalizedContainer): Geometry => {
    const cached = resolvedContainers.get(container.id)
    if (cached) return cached
    if (resolving.has(container.id)) return container.geometry
    resolving.add(container.id)
    const parent = containerById.get(container.parent)
    const parentGeometry = parent ? resolveContainer(parent) : undefined
    const geometry = parentGeometry ? offsetGeometry(container.geometry, parentGeometry.x, parentGeometry.y) : { ...container.geometry }
    resolvedContainers.set(container.id, geometry)
    resolving.delete(container.id)
    return geometry
  }
  const rootContainers = containers.map((container) => ({
    ...container,
    geometry: resolveContainer(container),
  }))
  const rootNodes = nodes.map((node) => {
    const parentContainer = containerById.get(node.parent)
    const parentGeometry = parentContainer ? resolveContainer(parentContainer) : undefined
    return {
      ...node,
      geometry: parentGeometry ? offsetGeometry(node.geometry, parentGeometry.x, parentGeometry.y) : { ...node.geometry },
    }
  })
  return { containers: rootContainers, nodes: rootNodes }
}

function offsetGeometry(geometry: Geometry, dx: number, dy: number): Geometry {
  return {
    ...geometry,
    x: geometry.x + dx,
    y: geometry.y + dy,
  }
}

function discardOutlierLineEdgePoints(nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  if (!nodes.length) return 0
  const bounds = nodeBounds(nodes.filter((node) => node.visualRole !== "legend-note"))
  const margin = Math.max(600, Math.min(1400, Math.max(bounds.width, bounds.height) * 0.35))
  const left = bounds.x - margin
  const right = bounds.x + bounds.width + margin
  const top = bounds.y - margin
  const bottom = bounds.y + bounds.height + margin
  let repairs = 0
  for (const edge of edges) {
    if (edge.presentationMode !== "line" || edge.points.length === 0) continue
    if (edge.points.some((point) => !Number.isFinite(point.x) || !Number.isFinite(point.y) || (point.x ?? 0) < left || (point.x ?? 0) > right || (point.y ?? 0) < top || (point.y ?? 0) > bottom)) {
      edge.points = []
      repairs += 1
    }
  }
  return repairs
}

function separateOverlappingNodes(nodes: NormalizedNode[]) {
  let repairs = 0
  const byParent = new Map<string, NormalizedNode[]>()
  for (const node of nodes) {
    if (node.visualRole === "legend-note") continue
    const list = byParent.get(node.parent) ?? []
    list.push(node)
    byParent.set(node.parent, list)
  }
  for (const group of byParent.values()) {
    let changed = true
    let pass = 0
    while (changed && pass < 4) {
      changed = false
      pass += 1
      for (let outer = 0; outer < group.length; outer += 1) {
        for (let inner = outer + 1; inner < group.length; inner += 1) {
          const a = group[outer]
          const b = group[inner]
          if (!a || !b || intersectionArea(a.geometry, b.geometry) <= 24) continue
          const aCenter = centerPoint(a.geometry)
          const bCenter = centerPoint(b.geometry)
          const moveRight = bCenter.x >= aCenter.x
          const nextX = moveRight
            ? a.geometry.x + a.geometry.width + 48
            : Math.max(24, a.geometry.x - b.geometry.width - 48)
          const nextY = b.geometry.y + Math.max(0, Math.min(72, (a.geometry.y + a.geometry.height + 36) - b.geometry.y))
          b.geometry = {
            ...b.geometry,
            x: nextX,
            y: Math.max(24, nextY),
          }
          changed = true
          repairs += 1
        }
      }
    }
  }
  return repairs
}

function orthogonalBendPoints(source: Geometry, target: Geometry, index: number): DrawioPointSpec[] {
  const start = centerPoint(source)
  const end = centerPoint(target)
  const dx = Math.abs(start.x - end.x)
  const dy = Math.abs(start.y - end.y)
  if (dx <= 8 || dy <= 8) return [{ x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 }]
  if (dy >= dx) {
    const midY = (start.y + end.y) / 2 + laneOffset(index)
    return [{ x: start.x, y: midY }, { x: end.x, y: midY }]
  }
  const midX = (start.x + end.x) / 2 + laneOffset(index)
  return [{ x: midX, y: start.y }, { x: midX, y: end.y }]
}

function laneOffset(index: number) {
  return ((index % 5) - 2) * 10
}

function indexSeed(input: string) {
  let hash = 0
  for (const char of input) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return Math.abs(hash)
}

function railLaneOffsetsByEdge(nodesById: Map<string, NormalizedNode>, edges: NormalizedEdge[]) {
  const groups = new Map<string, Array<{ edge: NormalizedEdge; span: number }>>()
  for (const edge of edges) {
    if (edge.presentationMode !== "rail" || !edge.source || !edge.target) continue
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (!source || !target) continue
    const sourceCenter = centerPoint(source.geometry)
    const targetCenter = centerPoint(target.geometry)
    const side = edge.rail ?? "right"
    const span = side === "left" || side === "right"
      ? Math.abs(sourceCenter.y - targetCenter.y)
      : Math.abs(sourceCenter.x - targetCenter.x)
    const list = groups.get(side) ?? []
    list.push({ edge, span })
    groups.set(side, list)
  }
  const offsets = new Map<string, number>()
  for (const list of groups.values()) {
    list
      .sort((left, right) => left.span - right.span || left.edge.id.localeCompare(right.edge.id))
      .forEach((item, index) => offsets.set(item.edge.id, index * 64))
  }
  return offsets
}

function ensureExplicitEdgePoints(nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  let repairs = 0
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  for (const edge of edges) {
    if (edge.points.length > 0 || !edge.source || !edge.target) continue
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (!source || !target) continue
    edge.points = orthogonalBendPoints(source.geometry, target.geometry, indexSeed(edge.id))
    if (edge.points.length > 0) repairs += 1
  }
  return repairs
}

function routeEdgesAroundNodeObstacles(nodes: NormalizedNode[], containers: NormalizedContainer[], edges: NormalizedEdge[]) {
  let repairs = 0
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const railLaneOffsets = railLaneOffsetsByEdge(nodesById, edges)
  const routedSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }> = []
  const graphBounds = nodeBounds(nodes.filter((node) => node.visualRole !== "legend-note"))
  const obstacleContainers = containers.filter((container) => container.parent === "1" && container.id !== "g-visual-plan-legend")
  const orderedEdges = [...edges].sort((left, right) => {
    const leftMode = left.presentationMode === "line" ? 0 : left.presentationMode === "rail" ? 1 : 2
    const rightMode = right.presentationMode === "line" ? 0 : right.presentationMode === "rail" ? 1 : 2
    return leftMode - rightMode
  })
  for (const edge of orderedEdges) {
    if (!edge.source || !edge.target) continue
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (!source || !target) continue
    const obstacles = nodes
      .filter((node) => node.visualRole !== "legend-note" && node.id !== edge.source && node.id !== edge.target)
      .map((node) => inflateGeometry(node.geometry, 18))
    const containerObstacles = obstacleContainers
      .filter((container) => !nodeBelongsToContainer(source, container) && !nodeBelongsToContainer(target, container))
      .map((container) => inflateGeometry(container.geometry, 18))
    const currentRoute = edgeRoutePoints(edge, source.geometry, target.geometry)
    if (!routeSegmentsTouchObstacles(currentRoute, [...obstacles, ...containerObstacles])) {
      for (let index = 0; index < currentRoute.length - 1; index += 1) {
        const start = currentRoute[index]
        const end = currentRoute[index + 1]
        if (start && end) routedSegments.push({ start, end })
      }
      continue
    }
    const route = orthogonalObstacleRoute({
      source: source.geometry,
      target: target.geometry,
      edge,
      obstacles: [...obstacles, ...containerObstacles],
      graphBounds,
      railLaneOffset: railLaneOffsets.get(edge.id) ?? 0,
      routedSegments,
    })
    if (route.length >= 2) {
      const nextPoints = route.slice(1, -1)
      if (nextPoints.length > 0 && !samePointList(edge.points, nextPoints)) {
        edge.points = nextPoints
        repairs += 1
      }
      const fullRoute = edgeRoutePoints(edge, source.geometry, target.geometry)
      for (let index = 0; index < fullRoute.length - 1; index += 1) {
        const start = fullRoute[index]
        const end = fullRoute[index + 1]
        if (start && end) routedSegments.push({ start, end })
      }
    }
  }
  return repairs
}

function routeSegmentsTouchObstacles(route: DrawioPointSpec[], obstacles: Geometry[]) {
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index]
    const end = route[index + 1]
    if (!isFinitePoint(start) || !isFinitePoint(end)) continue
    if (obstacles.some((obstacle) => segmentIntersectsBox(start, end, obstacle))) return true
  }
  return false
}

function orthogonalObstacleRoute(input: {
  source: Geometry
  target: Geometry
  edge: NormalizedEdge
  obstacles: Geometry[]
  graphBounds: Geometry
  railLaneOffset: number
  routedSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>
}) {
  const sourceCenter = centerPoint(input.source)
  const targetCenter = centerPoint(input.target)
  if (input.edge.presentationMode === "rail") {
    const margin = 220
    if (input.edge.rail === "left" || input.edge.rail === "right") {
      const railX = input.edge.rail === "left"
        ? input.graphBounds.x - margin - input.railLaneOffset
        : input.graphBounds.x + input.graphBounds.width + margin + input.railLaneOffset
      const start = boundaryPointToward(input.source, { x: railX, y: sourceCenter.y })
      const end = boundaryPointToward(input.target, { x: railX, y: targetCenter.y })
      return stitchRoutes([
        gridRoute(start, { x: railX, y: sourceCenter.y }, input.obstacles, input.routedSegments, input.graphBounds),
        [{ x: railX, y: sourceCenter.y }, { x: railX, y: targetCenter.y }],
        gridRoute({ x: railX, y: targetCenter.y }, end, input.obstacles, input.routedSegments, input.graphBounds),
      ])
    }
    const railY = input.edge.rail === "top"
      ? input.graphBounds.y - margin - input.railLaneOffset
      : input.graphBounds.y + input.graphBounds.height + margin + input.railLaneOffset
    const start = boundaryPointToward(input.source, { x: sourceCenter.x, y: railY })
    const end = boundaryPointToward(input.target, { x: targetCenter.x, y: railY })
    return stitchRoutes([
      gridRoute(start, { x: sourceCenter.x, y: railY }, input.obstacles, input.routedSegments, input.graphBounds),
      [{ x: sourceCenter.x, y: railY }, { x: targetCenter.x, y: railY }],
      gridRoute({ x: targetCenter.x, y: railY }, end, input.obstacles, input.routedSegments, input.graphBounds),
    ])
  }
  const start = boundaryPointToward(input.source, targetCenter)
  const end = boundaryPointToward(input.target, sourceCenter)
  return gridRoute(start, end, input.obstacles, input.routedSegments)
}

function gridRoute(
  start: { x: number; y: number },
  end: { x: number; y: number },
  obstacles: Geometry[],
  routedSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>,
  graphBounds?: Geometry,
) {
  const xs = new Set<number>([roundCoord(start.x), roundCoord(end.x)])
  const ys = new Set<number>([roundCoord(start.y), roundCoord(end.y)])
  if (graphBounds) {
    const margin = 160
    xs.add(roundCoord(graphBounds.x - margin))
    xs.add(roundCoord(graphBounds.x + graphBounds.width + margin))
    ys.add(roundCoord(graphBounds.y - margin))
    ys.add(roundCoord(graphBounds.y + graphBounds.height + margin))
  }
  for (const obstacle of obstacles) {
    xs.add(roundCoord(obstacle.x))
    xs.add(roundCoord(obstacle.x + obstacle.width))
    ys.add(roundCoord(obstacle.y))
    ys.add(roundCoord(obstacle.y + obstacle.height))
  }
  for (const segment of routedSegments.slice(-80)) {
    xs.add(roundCoord(segment.start.x))
    xs.add(roundCoord(segment.end.x))
    ys.add(roundCoord(segment.start.y))
    ys.add(roundCoord(segment.end.y))
  }
  const xList = Array.from(xs).sort((left, right) => left - right)
  const yList = Array.from(ys).sort((left, right) => left - right)
  const startKey = gridKey(roundCoord(start.x), roundCoord(start.y))
  const endKey = gridKey(roundCoord(end.x), roundCoord(end.y))
  const best = new Map<string, { cost: number; previous?: string; direction?: "h" | "v" }>()
  const open = [{ key: startKey, cost: 0, direction: undefined as "h" | "v" | undefined }]
  best.set(startKey, { cost: 0 })
  while (open.length) {
    open.sort((left, right) => left.cost - right.cost)
    const current = open.shift()
    if (!current) break
    if (current.key === endKey) break
    const currentPoint = parseGridKey(current.key)
    const xi = xList.indexOf(currentPoint.x)
    const yi = yList.indexOf(currentPoint.y)
    const neighbors = [
      xi > 0 ? { x: xList[xi - 1] ?? currentPoint.x, y: currentPoint.y, direction: "h" as const } : undefined,
      xi < xList.length - 1 ? { x: xList[xi + 1] ?? currentPoint.x, y: currentPoint.y, direction: "h" as const } : undefined,
      yi > 0 ? { x: currentPoint.x, y: yList[yi - 1] ?? currentPoint.y, direction: "v" as const } : undefined,
      yi < yList.length - 1 ? { x: currentPoint.x, y: yList[yi + 1] ?? currentPoint.y, direction: "v" as const } : undefined,
    ].filter((item): item is { x: number; y: number; direction: "h" | "v" } => Boolean(item))
    for (const neighbor of neighbors) {
      const nextPoint = { x: neighbor.x, y: neighbor.y }
      if (segmentBlocked(currentPoint, nextPoint, obstacles)) continue
      const key = gridKey(nextPoint.x, nextPoint.y)
      const turnCost = current.direction && current.direction !== neighbor.direction ? 80 : 0
      const crossingCost = segmentCrossingCost(currentPoint, nextPoint, routedSegments)
      const distance = Math.abs(nextPoint.x - currentPoint.x) + Math.abs(nextPoint.y - currentPoint.y)
      const nextCost = current.cost + distance + turnCost + crossingCost
      const previousBest = best.get(key)
      if (previousBest && previousBest.cost <= nextCost) continue
      best.set(key, { cost: nextCost, previous: current.key, direction: neighbor.direction })
      open.push({ key, cost: nextCost, direction: neighbor.direction })
    }
  }
  if (!best.has(endKey)) return [start, end]
  const keys: string[] = []
  let cursor: string | undefined = endKey
  while (cursor) {
    keys.push(cursor)
    cursor = best.get(cursor)?.previous
  }
  const route = keys.reverse().map(parseGridKey)
  return simplifyRoute(route.length ? route : [start, end])
}

function segmentBlocked(start: { x: number; y: number }, end: { x: number; y: number }, obstacles: Geometry[]) {
  return obstacles.some((obstacle) => segmentIntersectsBox(start, end, obstacle))
}

function segmentCrossingCost(start: { x: number; y: number }, end: { x: number; y: number }, routedSegments: Array<{ start: { x: number; y: number }; end: { x: number; y: number } }>) {
  let cost = 0
  for (const segment of routedSegments.slice(-120)) {
    if (lineSegmentsIntersect(start, end, segment.start, segment.end)) cost += 12000
    else if (collinearOverlap(start, end, segment.start, segment.end)) cost += 8000
  }
  return cost
}

function collinearOverlap(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }) {
  if (Math.abs(a.x - b.x) <= 1 && Math.abs(c.x - d.x) <= 1 && Math.abs(a.x - c.x) <= 2) {
    return Math.min(Math.max(a.y, b.y), Math.max(c.y, d.y)) - Math.max(Math.min(a.y, b.y), Math.min(c.y, d.y)) > 24
  }
  if (Math.abs(a.y - b.y) <= 1 && Math.abs(c.y - d.y) <= 1 && Math.abs(a.y - c.y) <= 2) {
    return Math.min(Math.max(a.x, b.x), Math.max(c.x, d.x)) - Math.max(Math.min(a.x, b.x), Math.min(c.x, d.x)) > 24
  }
  return false
}

function simplifyRoute(route: Array<{ x: number; y: number }>) {
  const simplified: Array<{ x: number; y: number }> = []
  for (const point of route) {
    const previous = simplified[simplified.length - 1]
    if (previous && Math.abs(previous.x - point.x) <= 1 && Math.abs(previous.y - point.y) <= 1) continue
    simplified.push(point)
  }
  let changed = true
  while (changed) {
    changed = false
    for (let index = 1; index < simplified.length - 1; index += 1) {
      const before = simplified[index - 1]
      const current = simplified[index]
      const after = simplified[index + 1]
      if (!before || !current || !after) continue
      if ((Math.abs(before.x - current.x) <= 1 && Math.abs(current.x - after.x) <= 1) ||
        (Math.abs(before.y - current.y) <= 1 && Math.abs(current.y - after.y) <= 1)) {
        simplified.splice(index, 1)
        changed = true
        break
      }
    }
  }
  let loopChanged = true
  while (loopChanged) {
    loopChanged = false
    const seen = new Map<string, number>()
    for (let index = 0; index < simplified.length; index += 1) {
      const point = simplified[index]
      if (!point) continue
      const key = gridKey(roundCoord(point.x), roundCoord(point.y))
      const previous = seen.get(key)
      if (previous !== undefined && index - previous > 1) {
        simplified.splice(previous + 1, index - previous - 1)
        loopChanged = true
        break
      }
      seen.set(key, index)
    }
  }
  return simplified
}

function stitchRoutes(routes: Array<Array<{ x: number; y: number }>>) {
  const result: Array<{ x: number; y: number }> = []
  for (const route of routes) {
    for (const point of route) {
      const previous = result[result.length - 1]
      if (previous && Math.abs(previous.x - point.x) <= 1 && Math.abs(previous.y - point.y) <= 1) continue
      result.push(point)
    }
  }
  return simplifyRoute(result)
}

function roundCoord(value: number) {
  return Math.round(value)
}

function gridKey(x: number, y: number) {
  return `${x},${y}`
}

function parseGridKey(key: string) {
  const [x, y] = key.split(",").map(Number)
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 }
}

function samePointList(left: DrawioPointSpec[], right: DrawioPointSpec[]) {
  if (left.length !== right.length) return false
  return left.every((point, index) => {
    const other = right[index]
    return other && Math.abs((point.x ?? 0) - (other.x ?? 0)) <= 1 && Math.abs((point.y ?? 0) - (other.y ?? 0)) <= 1
  })
}

function inflateGeometry(geometry: Geometry, amount: number): Geometry {
  return {
    x: geometry.x - amount,
    y: geometry.y - amount,
    width: geometry.width + amount * 2,
    height: geometry.height + amount * 2,
  }
}

function fanOutOverlappingEdgeSegments(edges: NormalizedEdge[]) {
  let repairs = 0
  for (let pass = 0; pass < 10; pass += 1) {
    const segments = explicitOrthogonalEdgeSegments(edges)
    let changed = false
    for (let outer = 0; outer < segments.length; outer += 1) {
      for (let inner = outer + 1; inner < segments.length; inner += 1) {
        const a = segments[outer]
        const b = segments[inner]
        if (!a || !b || a.edge.id === b.edge.id || a.orientation !== b.orientation) continue
        if (Math.abs(a.fixed - b.fixed) > 4) continue
        if (Math.min(a.max, b.max) - Math.max(a.min, b.min) <= 36) continue
        const offset = (repairs % 2 === 0 ? 1 : -1) * (18 + Math.floor(repairs / 2) * 8)
        if (b.orientation === "vertical") {
          b.start.x = (b.start.x ?? 0) + offset
          b.end.x = (b.end.x ?? 0) + offset
        } else {
          b.start.y = (b.start.y ?? 0) + offset
          b.end.y = (b.end.y ?? 0) + offset
        }
        repairs += 1
        changed = true
        break
      }
      if (changed) break
    }
    if (!changed) break
  }
  return repairs
}

function explicitOrthogonalEdgeSegments(edges: NormalizedEdge[]) {
  const segments: Array<{
    edge: NormalizedEdge
    start: DrawioPointSpec
    end: DrawioPointSpec
    orientation: "vertical" | "horizontal"
    fixed: number
    min: number
    max: number
  }> = []
  for (const edge of edges) {
    for (let index = 0; index < edge.points.length - 1; index += 1) {
      const start = edge.points[index]
      const end = edge.points[index + 1]
      if (!isFinitePoint(start) || !isFinitePoint(end)) continue
      if (Math.abs((start.x ?? 0) - (end.x ?? 0)) <= 1) {
        segments.push({
          edge,
          start,
          end,
          orientation: "vertical",
          fixed: Math.round(start.x ?? 0),
          min: Math.min(start.y ?? 0, end.y ?? 0),
          max: Math.max(start.y ?? 0, end.y ?? 0),
        })
      } else if (Math.abs((start.y ?? 0) - (end.y ?? 0)) <= 1) {
        segments.push({
          edge,
          start,
          end,
          orientation: "horizontal",
          fixed: Math.round(start.y ?? 0),
          min: Math.min(start.x ?? 0, end.x ?? 0),
          max: Math.max(start.x ?? 0, end.x ?? 0),
        })
      }
    }
  }
  return segments
}

function straightenUnobstructedAlignedLineEdges(nodes: NormalizedNode[], containers: NormalizedContainer[], edges: NormalizedEdge[]) {
  let repairs = 0
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const unrelatedContainers = containers.filter((container) => container.parent === "1" && container.id !== "g-visual-plan-legend")
  for (const edge of edges) {
    if (edge.presentationMode !== "line" || !edge.source || !edge.target) continue
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (!source || !target) continue
    const sourceCenter = centerPoint(source.geometry)
    const targetCenter = centerPoint(target.geometry)
    const vertical = Math.abs(sourceCenter.x - targetCenter.x) <= 18
    const horizontal = Math.abs(sourceCenter.y - targetCenter.y) <= 18
    if (!vertical && !horizontal) continue

    const axisPoint = { x: (sourceCenter.x + targetCenter.x) / 2, y: (sourceCenter.y + targetCenter.y) / 2 }
    const straightRoute = edgeRoutePoints({ ...edge, points: [axisPoint] }, source.geometry, target.geometry)
    if (routeTouchesObstacles(straightRoute, nodes, unrelatedContainers, edge.source, edge.target, source, target)) continue
    if (!routeHasOffAxisBend(edgeRoutePoints(edge, source.geometry, target.geometry), vertical ? "vertical" : "horizontal", axisPoint)) continue
    edge.points = [axisPoint]
    repairs += 1
  }
  return repairs
}

function routeTouchesObstacles(
  route: DrawioPointSpec[],
  nodes: NormalizedNode[],
  containers: NormalizedContainer[],
  sourceId: string,
  targetId: string,
  source: NormalizedNode,
  target: NormalizedNode,
) {
  for (let index = 0; index < route.length - 1; index += 1) {
    const start = route[index]
    const end = route[index + 1]
    if (!isFinitePoint(start) || !isFinitePoint(end)) continue
    for (const node of nodes) {
      if (node.id === sourceId || node.id === targetId || node.visualRole === "legend-note") continue
      if (segmentIntersectsBox(start, end, inflateGeometry(node.geometry, 4))) return true
    }
    for (const container of containers) {
      if (nodeBelongsToContainer(source, container) || nodeBelongsToContainer(target, container)) continue
      if (segmentIntersectsBox(start, end, inflateGeometry(container.geometry, 4))) return true
    }
  }
  return false
}

function routeHasOffAxisBend(route: DrawioPointSpec[], orientation: "vertical" | "horizontal", axisPoint: DrawioPointSpec) {
  if (!isFinitePoint(axisPoint)) return false
  return route.some((point) => {
    if (!isFinitePoint(point)) return false
    return orientation === "vertical"
      ? Math.abs(point.x - axisPoint.x) > 12
      : Math.abs(point.y - axisPoint.y) > 12
  })
}

function rerouteEdgesPassingThroughNodes(nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  let repairs = 0
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  for (const edge of edges) {
    if (!edge.source || !edge.target) continue
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (!source || !target) continue
    if (!edge.points.length) edge.points = orthogonalBendPoints(source.geometry, target.geometry, indexSeed(edge.id))
    for (let attempt = 0; attempt < 6; attempt += 1) {
      let changed = false
      const route = edgeRoutePoints(edge, source.geometry, target.geometry)
      for (let index = 0; index < route.length - 1; index += 1) {
        const start = route[index]
        const end = route[index + 1]
        if (!start || !end) continue
        for (const node of nodes) {
          if (node.id === edge.source || node.id === edge.target) continue
          if (!segmentIntersectsBox(start, end, node.geometry)) continue
          const detour = detourAroundBox(start, end, node.geometry)
          if (!detour.length) continue
          edge.points.splice(index, 0, ...detour)
          repairs += 1
          changed = true
          break
        }
        if (changed) break
      }
      if (!changed) break
    }
  }
  return repairs
}

function rerouteEdgesPassingThroughContainers(nodes: NormalizedNode[], containers: NormalizedContainer[], edges: NormalizedEdge[]) {
  let repairs = 0
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const relevantContainers = containers.filter((container) => container.parent === "1" && container.id !== "g-visual-plan-legend")
  if (!relevantContainers.length) return 0
  for (const edge of edges) {
    if (!edge.source || !edge.target) continue
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (!source || !target) continue
    if (!edge.points.length) edge.points = orthogonalBendPoints(source.geometry, target.geometry, indexSeed(edge.id))
    for (let attempt = 0; attempt < 6; attempt += 1) {
      let changed = false
      const route = edgeRoutePoints(edge, source.geometry, target.geometry)
      for (let index = 0; index < route.length - 1; index += 1) {
        const start = route[index]
        const end = route[index + 1]
        if (!start || !end) continue
        for (const container of relevantContainers) {
          if (nodeBelongsToContainer(source, container) || nodeBelongsToContainer(target, container)) continue
          if (!segmentIntersectsBox(start, end, container.geometry)) continue
          const detour = detourAroundBox(start, end, container.geometry)
          if (!detour.length) continue
          edge.points.splice(index, 0, ...detour)
          repairs += 1
          changed = true
          break
        }
        if (changed) break
      }
      if (!changed) break
    }
  }
  return repairs
}

function edgeRoutePoints(edge: NormalizedEdge, source: Geometry, target: Geometry) {
  const innerPoints = edge.points.filter(isFinitePoint).map((point) => ({ x: point.x, y: point.y }))
  const firstToward = innerPoints[0] ?? centerPoint(target)
  const lastToward = innerPoints[innerPoints.length - 1] ?? centerPoint(source)
  return [
    boundaryPointToward(source, firstToward),
    ...innerPoints,
    boundaryPointToward(target, lastToward),
  ]
}

function boundaryPointToward(box: Geometry, target: { x: number; y: number }) {
  const center = centerPoint(box)
  const dx = target.x - center.x
  const dy = target.y - center.y
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return center
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : (box.width / 2) / Math.abs(dx)
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : (box.height / 2) / Math.abs(dy)
  const scale = Math.min(scaleX, scaleY)
  return {
    x: center.x + dx * scale,
    y: center.y + dy * scale,
  }
}

function nodeBelongsToContainer(node: NormalizedNode, container: NormalizedContainer) {
  return node.parent === container.id ||
    node.ownerContainer === container.id ||
    pointInsideGeometry(centerPoint(node.geometry), container.geometry)
}

function pointInsideGeometry(point: { x: number; y: number }, geometry: Geometry) {
  return point.x >= geometry.x &&
    point.x <= geometry.x + geometry.width &&
    point.y >= geometry.y &&
    point.y <= geometry.y + geometry.height
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
    const rawLabel = stringField(item, "label") || stringField(item, "text") || ""
    const label = diagramLabel(rawLabel, 120, 22, 3)
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
      fullLabel: rawLabel || label,
      sourceId: rawId,
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
      presentationMode: normalizePresentationMode(stringField(item, "presentationMode")),
      rail: normalizeRail(stringField(item, "rail")),
      marker: stringField(item, "marker"),
    }
  })
}

function normalizePresentationMode(input: string): NormalizedEdge["presentationMode"] {
  const key = compactKey(input, "")
  if (key === "rail" || key === "legend" || key === "line") return key
  return undefined
}

function normalizeRail(input: string): NormalizedEdge["rail"] {
  const key = compactKey(input, "")
  if (key === "left" || key === "right" || key === "top" || key === "bottom") return key
  return undefined
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
  return `<mxCell id="${xmlAttr(container.id)}" value="${plainLabelAttr(container.label)}" style="${xmlAttr(container.style)}" parent="${xmlAttr(container.parent)}" vertex="1"><mxGeometry x="${num(container.geometry.x)}" y="${num(container.geometry.y)}" width="${num(container.geometry.width)}" height="${num(container.geometry.height)}" as="geometry"/></mxCell>`
}

function nodeCellXml(node: NormalizedNode) {
  return `<mxCell id="${xmlAttr(node.id)}" value="${plainLabelAttr(node.label)}" style="${xmlAttr(node.style)}" parent="${xmlAttr(node.parent)}" vertex="1"><mxGeometry x="${num(node.geometry.x)}" y="${num(node.geometry.y)}" width="${num(node.geometry.width)}" height="${num(node.geometry.height)}" as="geometry"/></mxCell>`
}

function edgeCellXml(edge: NormalizedEdge) {
  const source = edge.source ? ` source="${xmlAttr(edge.source)}"` : ""
  const target = edge.target ? ` target="${xmlAttr(edge.target)}"` : ""
  const labelOffset = edge.labelOffset && Number.isFinite(edge.labelOffset.x) && Number.isFinite(edge.labelOffset.y)
    ? `<mxPoint x="${num(edge.labelOffset.x ?? 0)}" y="${num(edge.labelOffset.y ?? 0)}" as="offset"/>`
    : ""
  const value = plainLabelAttr(edge.label)
  const style = xmlAttr(edge.style)
  if (!edge.points.length) {
    return `<mxCell id="${xmlAttr(edge.id)}" value="${value}" style="${style}" parent="${xmlAttr(edge.parent)}"${source}${target} edge="1"><mxGeometry relative="1" as="geometry">${labelOffset}</mxGeometry></mxCell>`
  }
  const points = edge.points
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y))
    .map((point) => `<mxPoint x="${num(point.x ?? 0)}" y="${num(point.y ?? 0)}"/>`)
    .join("")
  return `<mxCell id="${xmlAttr(edge.id)}" value="${value}" style="${style}" parent="${xmlAttr(edge.parent)}"${source}${target} edge="1"><mxGeometry relative="1" as="geometry"><Array as="points">${points}</Array>${labelOffset}</mxGeometry></mxCell>`
}

function applyDrawioQualityGate(nodes: NormalizedNode[], edges: NormalizedEdge[], containers: NormalizedContainer[], warnings: string[], visualPlan: VisualPlan) {
  const rootView = rootGeometryView(containers, nodes)
  const qualityWarnings: string[] = []
  const overlaps = nodeOverlapWarnings(rootView.nodes)
  qualityWarnings.push(...overlaps.slice(0, 6))
  const passThrough = edgePassThroughWarnings(rootView.nodes, edges)
  qualityWarnings.push(...passThrough.slice(0, 6))
  if (visualPlan.profile !== "soc-block") {
    qualityWarnings.push(...edgeContainerPassThroughWarnings(rootView.nodes, rootView.containers, edges).slice(0, 6))
  }
  if (visualPlan.profile === "embedded-fsm-flow") {
    qualityWarnings.push(...embeddedFsmFlowWarnings(rootView.nodes, edges))
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

function edgeContainerPassThroughWarnings(nodes: NormalizedNode[], containers: NormalizedContainer[], edges: NormalizedEdge[]) {
  const warnings: string[] = []
  const nodesById = new Map(nodes.map((node) => [node.id, node]))
  const relevantContainers = containers.filter((container) => container.parent === "1" && container.id !== "g-visual-plan-legend")
  for (const edge of edges) {
    if (!edge.source || !edge.target) continue
    const source = nodesById.get(edge.source)
    const target = nodesById.get(edge.target)
    if (!source || !target) continue
    const points = edgeRoutePoints(edge, source.geometry, target.geometry)
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index]
      const end = points[index + 1]
      if (!start || !end) continue
      for (const container of relevantContainers) {
        if (nodeBelongsToContainer(source, container) || nodeBelongsToContainer(target, container)) continue
        if (!segmentIntersectsBox(start, end, container.geometry)) continue
        warnings.push(`Design compiler quality gate detected edge "${edge.label || edge.id}" passing through container "${container.label.replace(/\n/g, " ")}"; consider a model-authored rail path or explicit SoC edge route.`)
        if (warnings.length >= 6) return warnings
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

function nodeLookup(nodes: NormalizedNode[]) {
  const result = new Map<string, NormalizedNode>()
  for (const node of nodes) {
    result.set(node.id, node)
    if (node.sourceId) result.set(node.sourceId, node)
  }
  return result
}

function nodeBounds(nodes: NormalizedNode[]): Geometry {
  const minX = Math.min(...nodes.map((node) => node.geometry.x))
  const minY = Math.min(...nodes.map((node) => node.geometry.y))
  const maxX = Math.max(...nodes.map((node) => node.geometry.x + node.geometry.width))
  const maxY = Math.max(...nodes.map((node) => node.geometry.y + node.geometry.height))
  return {
    x: Number.isFinite(minX) ? minX : 0,
    y: Number.isFinite(minY) ? minY : 0,
    width: Number.isFinite(maxX - minX) ? Math.max(1, maxX - minX) : 1,
    height: Number.isFinite(maxY - minY) ? Math.max(1, maxY - minY) : 1,
  }
}

function median(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return 40
  return sorted[Math.floor(sorted.length / 2)] ?? 40
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

function plainLabelAttr(input: string) {
  return xmlAttr(String(input).replace(/\s*(?:\r\n|\r|\n)\s*/g, " "))
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
