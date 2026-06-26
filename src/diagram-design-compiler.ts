import type { DrawioContainerSpec, DrawioDiagramSpec, DrawioEdgeSpec, DrawioNodeSpec, DrawioStyleInput } from "./drawio-diagram-generator"
import type { DiagramIr } from "./diagram-ir"

export type DiagramDesignProfile =
  | "flow"
  | "code-flow"
  | "business-flow"
  | "architecture"
  | "embedded-fsm-flow"
  | "soc-block"
  | "state-machine"
  | "sequence"

export type VisualTextParts = {
  title: string
  subtitle?: string
  meta?: string
  detail?: string
}

export type VisualPlanNode = {
  id: string
  label: string
  visualRole: string
  importance: number
  textParts: VisualTextParts
}

export type VisualPlanEdge = {
  id: string
  label: string
  edgeKind: string
  pathRole: string
  labelPriority: "high" | "medium" | "low"
}

export type VisualQualityGate = {
  textOverflowRepairs: number
  edgeLabelRepairs: number
  legendItems: number
  labelSanitizationRepairs: number
  edgeOverlapRepairs: number
  edgePassThroughRepairs: number
  repairPasses: number
  warnings: string[]
}

export type VisualPlan = {
  compilerVersion: "diagram-design-compiler/v1"
  profile: DiagramDesignProfile
  nodes: VisualPlanNode[]
  edges: VisualPlanEdge[]
  qualityGate: VisualQualityGate
}

export type DiagramDesignCompilerResult = {
  spec: DrawioDiagramSpec
  visualPlan: VisualPlan
  warnings: string[]
}

type MutableSpec = DrawioDiagramSpec & {
  regions?: DrawioContainerSpec[]
  buses?: DrawioEdgeSpec[]
  ports?: DrawioNodeSpec[]
  arrays?: unknown[]
}

type DesignContext = {
  profile: DiagramDesignProfile
  warnings: string[]
  notes: Array<{ id: string; label: string }>
  textOverflowRepairs: number
  edgeLabelRepairs: number
  labelSanitizationRepairs: number
  nodeSerial: number
  edgeSerial: number
}

const PROFILE_LAYOUTS: Record<DiagramDesignProfile, string> = {
  architecture: "architecture",
  "business-flow": "flow",
  "code-flow": "flow",
  "embedded-fsm-flow": "embedded-fsm-flow",
  flow: "flow",
  sequence: "sequence",
  "soc-block": "soc-block",
  "state-machine": "flow",
}

const PROFILE_NODE_STYLES: Record<DiagramDesignProfile, string> = {
  architecture: "fillColor=#f8fafc;strokeColor=#475569;fontColor=#0f172a;spacing=10;",
  "business-flow": "fillColor=#fefce8;strokeColor=#ca8a04;fontColor=#111827;spacing=10;",
  "code-flow": "fillColor=#f8fafc;strokeColor=#2563eb;fontColor=#111827;spacing=10;",
  "embedded-fsm-flow": "fillColor=#ffffff;strokeColor=#2563eb;fontColor=#111827;spacing=10;spacingLeft=10;spacingRight=10;",
  flow: "fillColor=#ffffff;strokeColor=#64748b;fontColor=#111827;spacing=10;",
  sequence: "fillColor=#f8fafc;strokeColor=#64748b;fontColor=#111827;spacing=10;",
  "soc-block": "fillColor=#eef6ff;strokeColor=#2563eb;fontColor=#111827;spacing=9;",
  "state-machine": "fillColor=#f0fdf4;strokeColor=#16a34a;fontColor=#111827;spacing=10;",
}

const PROFILE_CONTAINER_STYLES: Record<DiagramDesignProfile, string> = {
  architecture: "fillColor=#f8fafc;strokeColor=#94a3b8;fontColor=#0f172a;rounded=1;arcSize=8;spacing=10;",
  "business-flow": "fillColor=#fff7ed;strokeColor=#fb923c;fontColor=#111827;rounded=1;arcSize=8;spacing=10;",
  "code-flow": "fillColor=#eff6ff;strokeColor=#93c5fd;fontColor=#111827;rounded=1;arcSize=8;spacing=10;",
  "embedded-fsm-flow": "fillColor=#f8fafc;strokeColor=#60a5fa;fontColor=#0f172a;rounded=1;arcSize=8;spacing=12;fontStyle=1;",
  flow: "fillColor=#f8fafc;strokeColor=#cbd5e1;fontColor=#111827;rounded=1;arcSize=8;spacing=10;",
  sequence: "fillColor=#f8fafc;strokeColor=#cbd5e1;fontColor=#111827;rounded=1;arcSize=8;spacing=10;",
  "soc-block": "fillColor=#e0f2fe;strokeColor=#0284c7;fontColor=#0f172a;rounded=1;arcSize=6;spacing=10;",
  "state-machine": "fillColor=#ecfdf5;strokeColor=#86efac;fontColor=#111827;rounded=1;arcSize=8;spacing=10;",
}

export function compileDiagramDesign(input: {
  spec: DrawioDiagramSpec
  diagramIr?: DiagramIr
  warnings?: string[]
}): DiagramDesignCompilerResult {
  const warnings = input.warnings ?? []
  const spec = cloneSpec(input.spec) as MutableSpec
  const profile = profileFor(spec, input.diagramIr)
  const context: DesignContext = {
    profile,
    warnings,
    notes: [],
    textOverflowRepairs: 0,
    edgeLabelRepairs: 0,
    labelSanitizationRepairs: 0,
    nodeSerial: 0,
    edgeSerial: 0,
  }

  spec.diagramType = spec.diagramType || input.diagramIr?.diagramType || profile
  spec.layout = ensureLayout(spec.layout, profile)
  if (profile === "embedded-fsm-flow") {
    promoteModuleNodesToContainers(spec, context)
    warn(context, "Design compiler selected embedded-fsm-flow because the DiagramIR combines process/code flow intent with module boundaries, FSM states, and transition/event edges.")
  }
  spec.nodes = compileNodes(spec.nodes ?? [], context)
  spec.edges = compileEdges(spec.edges ?? [], context)
  spec.containers = compileContainers(spec.containers ?? [], context)
  spec.groups = compileContainers(spec.groups ?? [], context)
  spec.swimlanes = compileContainers(spec.swimlanes ?? [], context)
  attachDesignNotes(spec, context)

  const visualPlan: VisualPlan = {
    compilerVersion: "diagram-design-compiler/v1",
    profile,
    nodes: (spec.nodes ?? []).map((node) => ({
      id: stringValue(node.id) || stringValue(node.label) || "node",
      label: stringValue(node.label) || stringValue(node.text),
      visualRole: stringValue((node as Record<string, unknown>).visualRole) || "step",
      importance: numberValue((node as Record<string, unknown>).importance) ?? 0.5,
      textParts: (asRecord((node as Record<string, unknown>).textParts) as VisualTextParts | undefined) ?? textPartsFor(stringValue(node.label) || stringValue(node.text), node),
    })),
    edges: (spec.edges ?? []).map((edge) => ({
      id: stringValue(edge.id) || stringValue(edge.label) || "edge",
      label: stringValue(edge.label) || stringValue(edge.text),
      edgeKind: stringValue((edge as Record<string, unknown>).edgeKind) || "control",
      pathRole: stringValue((edge as Record<string, unknown>).pathRole) || "primary",
      labelPriority: labelPriorityFor(edge, "medium"),
    })),
    qualityGate: {
      textOverflowRepairs: context.textOverflowRepairs,
      edgeLabelRepairs: context.edgeLabelRepairs,
      legendItems: context.notes.length,
      labelSanitizationRepairs: context.labelSanitizationRepairs,
      edgeOverlapRepairs: 0,
      edgePassThroughRepairs: 0,
      repairPasses: 0,
      warnings: warnings.filter((warning) => warning.startsWith("Design compiler")).slice(0, 20),
    },
  }

  return { spec, visualPlan, warnings }
}

function profileFor(spec: DrawioDiagramSpec, diagramIr: DiagramIr | undefined): DiagramDesignProfile {
  const raw = normalizeKey(spec.diagramType || diagramIr?.diagramType || "")
  if (raw === "architecture" || raw === "arch") return "architecture"
  if (raw === "businessflow" || raw === "business-flow") return shouldUseEmbeddedFsmProfile(spec, diagramIr) ? "embedded-fsm-flow" : "business-flow"
  if (raw === "callflow" || raw === "codeflow" || raw === "code-flow") return shouldUseEmbeddedFsmProfile(spec, diagramIr) ? "embedded-fsm-flow" : "code-flow"
  if (raw === "sequence") return "sequence"
  if (raw === "soc" || raw === "socblock" || raw === "soc-block" || raw === "chip" || raw === "chipdiagram") return "soc-block"
  if (raw === "statemachine" || raw === "state-machine") return "state-machine"
  if ((spec.containers?.length ?? 0) > 0 || (spec.groups?.length ?? 0) > 0) return "architecture"
  if ((spec.swimlanes?.length ?? 0) > 0) return "business-flow"
  return "flow"
}

function ensureLayout(layout: DrawioDiagramSpec["layout"], profile: DiagramDesignProfile): DrawioDiagramSpec["layout"] {
  if (typeof layout === "string" && layout.trim()) {
    const normalized = normalizeKey(layout)
    if (profile === "embedded-fsm-flow" && (normalized === "flow" || normalized === "layered")) return "embedded-fsm-flow"
    return layout
  }
  const record = asRecord(layout)
  if (record && (typeof record.kind === "string" || typeof record.type === "string" || typeof record.layout === "string")) return layout
  return PROFILE_LAYOUTS[profile]
}

function shouldUseEmbeddedFsmProfile(spec: DrawioDiagramSpec, diagramIr: DiagramIr | undefined) {
  const nodes = [...(spec.nodes ?? []), ...(diagramIr?.nodes ?? [])]
  const edges = [...(spec.edges ?? []), ...(diagramIr?.edges ?? []), ...(diagramIr?.buses ?? [])]
  const semanticHints = diagramIr?.semanticHints ?? {}
  const signals = new Set<string>()
  if ((spec.containers?.length ?? 0) > 0 || (spec.swimlanes?.length ?? 0) > 0 || (diagramIr?.containers?.length ?? 0) > 0 || (diagramIr?.regions?.length ?? 0) > 0 || (diagramIr?.lanes?.length ?? 0) > 0 || (diagramIr?.swimlanes?.length ?? 0) > 0) {
    signals.add("module-boundaries")
  }
  if (nodes.some(isStateLikeNode)) signals.add("state-nodes")
  if (edges.some(isTransitionLikeEdge)) signals.add("transition-edges")
  if (nodes.some(isModuleLikeNode)) signals.add("module-nodes")
  if (truthyHint(semanticHints.containsStateMachines) || numericHint(semanticHints.stateMachineCount) > 0) signals.add("state-machine-hint")
  if (Array.isArray(semanticHints.processPhases) && semanticHints.processPhases.length > 0) signals.add("phase-hints")
  return signals.has("state-nodes") &&
    signals.has("transition-edges") &&
    (signals.has("module-boundaries") || signals.has("module-nodes") || signals.has("state-machine-hint")) &&
    signals.size >= 3
}

function promoteModuleNodesToContainers(spec: MutableSpec, context: DesignContext) {
  const nodes = spec.nodes ?? []
  const moduleNodes = nodes.filter((node) => isModuleLikeNode(node))
  if (!moduleNodes.length) return
  const existingContainers = spec.containers ?? []
  const existingIds = new Set(existingContainers.map((container) => stringValue(container.id)).filter(Boolean))
  const promoted: DrawioContainerSpec[] = []
  for (const node of moduleNodes) {
    const id = stringValue(node.id)
    if (!id || existingIds.has(id)) continue
    promoted.push({
      id,
      label: stringValue(node.label) || stringValue(node.text) || id,
      parent: stringValue(node.parent) || stringValue(node.container) || stringValue(node.group) || stringValue(node.lane),
      geometry: node.geometry,
      x: node.x,
      y: node.y,
      width: node.width,
      height: node.height,
      drawioStyle: node.drawioStyle ?? node.style,
    })
  }
  if (!promoted.length) return
  const promotedIds = new Set(promoted.map((container) => stringValue(container.id)))
  spec.containers = [...existingContainers, ...promoted]
  spec.nodes = nodes.filter((node) => !promotedIds.has(stringValue(node.id)))
  warn(context, `Design compiler promoted ${promoted.length} module/lane node(s) into containers for embedded FSM readability.`)
}

function compileNodes(nodes: DrawioNodeSpec[], context: DesignContext): DrawioNodeSpec[] {
  return nodes.map((node, index) => {
    const rawLabel = stringValue(node.label) || stringValue(node.text) || stringValue(node.id) || `Node ${index + 1}`
    const inputLabel = sanitizeVisibleLabel(rawLabel, context)
    const visualRole = visualRoleFor(node, context.profile)
    const importance = importanceFor(node, visualRole)
    const textParts = textPartsFor(inputLabel, node)
    const shaped = shapeNodeLabel(textParts, context)
    const geometry = suggestedGeometry(node, shaped.label, context.profile, visualRole)
    const drawioStyle = mergeStyle(PROFILE_NODE_STYLES[context.profile], roleNodeStyle(visualRole, context.profile), node.drawioStyle ?? node.style)
    return {
      ...node,
      label: shaped.label,
      width: geometry.width,
      height: geometry.height,
      drawioStyle,
      shape: node.shape || shapeForVisualRole(visualRole, context.profile, node.type),
      textParts,
      visualRole,
      importance,
    } as DrawioNodeSpec
  })
}

function compileContainers(containers: DrawioContainerSpec[], context: DesignContext): DrawioContainerSpec[] {
  return containers.map((container, index) => {
    const width = numberValue(container.width) ?? numberValue(container.geometry?.width) ?? (context.profile === "soc-block" ? 360 : context.profile === "embedded-fsm-flow" ? 520 : 420)
    const height = numberValue(container.height) ?? numberValue(container.geometry?.height) ?? (context.profile === "soc-block" ? 240 : context.profile === "embedded-fsm-flow" ? 260 : 220)
    const rawLabel = stringValue(container.label) || stringValue(container.title) || `Region ${index + 1}`
    return {
      ...container,
      id: container.id || `region-${index + 1}`,
      label: shapeCompactLabel(sanitizeVisibleLabel(rawLabel, context), 90, 24, 3),
      width: Math.max(context.profile === "soc-block" ? 300 : context.profile === "embedded-fsm-flow" ? 360 : 260, width),
      height: Math.max(context.profile === "soc-block" ? 180 : context.profile === "embedded-fsm-flow" ? 200 : 160, height),
      drawioStyle: mergeStyle(PROFILE_CONTAINER_STYLES[context.profile], container.drawioStyle ?? container.style),
    }
  })
}

function compileEdges(edges: DrawioEdgeSpec[], context: DesignContext): DrawioEdgeSpec[] {
  return edges.map((edge, index) => {
    const label = sanitizeVisibleLabel(stringValue(edge.label) || stringValue(edge.text), context)
    const edgeKind = edgeKindFor(edge)
    const pathRole = pathRoleFor(edge, edgeKind, index)
    const labelPriority = labelPriorityFor(edge, defaultLabelPriority(pathRole, edgeKind, context.profile))
    const shaped = shapeEdgeLabel(label, edge, labelPriority, context)
    return {
      ...edge,
      label: shaped.label,
      drawioStyle: mergeStyle(edgeStyle(edgeKind, pathRole, labelPriority, context.profile), edge.drawioStyle ?? edge.style),
      edgeKind,
      pathRole,
      labelPriority,
    } as DrawioEdgeSpec
  })
}

function attachDesignNotes(spec: MutableSpec, context: DesignContext) {
  if (!context.notes.length) return
  const containerId = "visual-notes"
  const existingContainers = spec.containers ?? []
  spec.containers = [
    ...existingContainers,
    {
      id: containerId,
      label: "Legend / Details",
      width: 300,
      height: Math.max(100, 48 + context.notes.length * 42),
      drawioStyle: "fillColor=#ffffff;strokeColor=#94a3b8;dashed=1;rounded=1;fontSize=12;",
    },
  ]
  spec.nodes = [
    ...(spec.nodes ?? []),
    ...context.notes.slice(0, 12).map((note, index) => ({
      id: note.id,
      label: shapeCompactLabel(note.label, 180, 30, 4),
      shape: "note",
      parent: containerId,
      x: 20,
      y: 44 + index * 42,
      width: 250,
      height: 34,
      drawioStyle: "fillColor=#fefce8;strokeColor=#d97706;fontSize=10;spacing=6;",
      visualRole: "legend-note",
      importance: 0.2,
      textParts: { title: note.label },
    } as DrawioNodeSpec)),
  ]
  warn(context, `Design compiler moved ${context.notes.length} long label/detail item(s) into a legend to protect diagram readability.`)
}

function shapeNodeLabel(parts: VisualTextParts, context: DesignContext) {
  const title = shapeCompactLabel(parts.title, 96, maxNodeLineWeight(context.profile), 2)
  const subtitle = parts.subtitle ? shapeCompactLabel(parts.subtitle, 96, maxNodeLineWeight(context.profile) - 4, 2) : ""
  const meta = parts.meta ? shapeCompactLabel(parts.meta, 64, maxNodeLineWeight(context.profile) - 6, 1) : ""
  const label = [title, subtitle, meta].filter(Boolean).join("\n")
  if (parts.detail || weightedTextLength(parts.title) > 54 || weightedTextLength(parts.subtitle ?? "") > 44) {
    context.textOverflowRepairs += 1
    if (context.notes.length < 12) {
      const noteId = `visual-note-node-${++context.nodeSerial}`
      context.notes.push({ id: noteId, label: `[N${context.nodeSerial}] ${[parts.title, parts.subtitle, parts.meta, parts.detail].filter(Boolean).join(" | ")}` })
    }
    return { label: `${label}\n[N${context.nodeSerial}]` }
  }
  return { label }
}

function shapeEdgeLabel(label: string, edge: DrawioEdgeSpec, priority: VisualPlanEdge["labelPriority"], context: DesignContext) {
  const clean = sanitizeVisibleLabel(label, context).replace(/\s+/g, " ").trim()
  if (!clean) return { label: "" }
  const maxWeight = priority === "high" ? 22 : priority === "medium" ? 16 : 10
  if (weightedTextLength(clean) <= maxWeight) return { label: shapeCompactLabel(clean, 52, maxWeight, 1) }
  context.edgeLabelRepairs += 1
  const marker = `[E${++context.edgeSerial}]`
  if (context.notes.length < 12) {
    const source = stringValue(edge.source) || stringValue(edge.from)
    const target = stringValue(edge.target) || stringValue(edge.to)
    context.notes.push({ id: `visual-note-edge-${context.edgeSerial}`, label: `${marker} ${source}->${target}: ${clean}` })
  }
  return { label: marker }
}

function textPartsFor(label: string, node: Record<string, unknown>): VisualTextParts {
  const explicit = asRecord(node.textParts)
  if (explicit) {
    return {
      title: sanitizeVisibleLabel(stringValue(explicit.title) || label),
      subtitle: sanitizeVisibleLabel(stringValue(explicit.subtitle)),
      meta: sanitizeVisibleLabel(stringValue(explicit.meta)),
      detail: sanitizeVisibleLabel(stringValue(explicit.detail)),
    }
  }
  const normalized = sanitizeVisibleLabel(label).replace(/\r\n|\r/g, "\n").trim()
  const lines = normalized.split("\n").map((line) => line.trim()).filter(Boolean)
  const title = lines[0] || normalized
  const rest = lines.slice(1).join(" | ")
  const sourceKind = stringValue(node.sourceKind)
  const coverage = stringValue(node.coverage)
  const meta = [sourceKind, coverage].filter(Boolean).join(" / ")
  const detail = rest || longCodeDetail(title)
  return {
    title: title.replace(/\s+/g, " "),
    subtitle: rest ? "" : shortCodeSubtitle(title),
    meta,
    detail: detail && detail !== title ? detail : undefined,
  }
}

function sanitizeVisibleLabel(input: string, context?: DesignContext) {
  if (!input) return ""
  const decoded = input
    .replace(/&lt;br\s*\/?&gt;/gi, "\n")
    .replace(/&lt;\/br\s*&gt;/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/br\s*>/gi, "\n")
    .replace(/&#10;|&#x0a;|&#xa;/gi, "\n")
  const normalized = decoded.replace(/\r\n|\r/g, "\n")
  if (context && normalized !== input) context.labelSanitizationRepairs += 1
  return normalized
}

function shortCodeSubtitle(label: string) {
  const match = /([A-Za-z_][A-Za-z0-9_.$:/-]*\([^)]*\)|[A-Za-z_][A-Za-z0-9_.$:/-]{18,})/.exec(label)
  return match?.[1]
}

function longCodeDetail(label: string) {
  return weightedTextLength(label) > 58 ? label : undefined
}

function suggestedGeometry(node: DrawioNodeSpec, label: string, profile: DiagramDesignProfile, role: string) {
  const explicitWidth = numberValue(node.width) ?? numberValue(node.geometry?.width)
  const explicitHeight = numberValue(node.height) ?? numberValue(node.geometry?.height)
  const lines = label.split("\n").filter(Boolean)
  const maxLine = Math.max(...(lines.length ? lines : [label]).map(weightedTextLength))
  const profileMaxWidth = profile === "soc-block" || profile === "architecture" ? 360 : profile === "embedded-fsm-flow" ? 320 : 440
  const minWidth = role === "port" ? 52 : role === "state" && profile === "embedded-fsm-flow" ? 150 : profile === "state-machine" ? 180 : 210
  const width = Math.max(explicitWidth ?? 0, Math.min(profileMaxWidth, Math.max(minWidth, 96 + maxLine * 5.8)))
  const minHeight = role === "port" ? 28 : role === "state" && profile === "embedded-fsm-flow" ? 58 : profile === "state-machine" ? 70 : 72
  const height = Math.max(explicitHeight ?? 0, Math.min(220, Math.max(minHeight, 32 + lines.length * 24)))
  return { width: Math.round(width), height: Math.round(height) }
}

function visualRoleFor(node: DrawioNodeSpec, profile: DiagramDesignProfile) {
  const raw = normalizeKey(stringValue((node as Record<string, unknown>).visualRole) || stringValue((node as Record<string, unknown>).role) || stringValue(node.type) || stringValue(node.shape))
  if (raw.includes("port")) return "port"
  if (raw.includes("state")) return "state"
  if (raw.includes("event")) return "event"
  if (raw.includes("action")) return "action"
  if (raw.includes("decision") || raw.includes("branch") || raw.includes("condition")) return "decision"
  if (raw.includes("bus")) return "bus"
  if (profile === "state-machine") return "state"
  if (profile === "embedded-fsm-flow" && isStateLikeNode(node)) return "state"
  if (profile === "soc-block" && raw.includes("array")) return "module-array"
  return "step"
}

function importanceFor(node: DrawioNodeSpec, role: string) {
  const explicit = numberValue((node as Record<string, unknown>).importance)
  if (explicit !== undefined) return Math.max(0, Math.min(1, explicit))
  if (role === "decision" || role === "state") return 0.8
  if (role === "port" || role === "legend-note") return 0.25
  return 0.6
}

function shapeForVisualRole(role: string, profile: DiagramDesignProfile, type: unknown) {
  const existing = stringValue(type)
  if (existing) return existing
  if (role === "decision") return "decision"
  if (role === "port") return "port"
  if (role === "event") return "hexagon"
  if (profile === "state-machine") return "roundedrect"
  return "roundedrect"
}

function edgeKindFor(edge: DrawioEdgeSpec) {
  const raw = normalizeKey(stringValue((edge as Record<string, unknown>).edgeKind) || stringValue((edge as Record<string, unknown>).kind) || stringValue((edge as Record<string, unknown>).type))
  if (raw.includes("data")) return "data"
  if (raw.includes("bus")) return "bus"
  if (raw.includes("transition")) return "transition"
  if (raw.includes("guard") || raw.includes("condition")) return "event"
  if (raw.includes("event")) return "event"
  if (raw.includes("error") || raw.includes("exception") || raw.includes("failure")) return "error"
  return "control"
}

function pathRoleFor(edge: DrawioEdgeSpec, edgeKind: string, index: number) {
  const raw = normalizeKey(stringValue((edge as Record<string, unknown>).pathRole) || stringValue((edge as Record<string, unknown>).role))
  if (raw.includes("localtransition") || raw.includes("local")) return "local-transition"
  if (raw.includes("crossmodule") || raw.includes("cross-module") || raw.includes("crosslane") || raw.includes("cross-lane") || raw.includes("rail")) return "cross-module"
  if (raw.includes("feedback")) return "feedback"
  if (raw.includes("error") || raw.includes("exception") || raw.includes("failure")) return "error"
  if (raw.includes("back") || raw.includes("loop") || raw.includes("retry")) return "backtrack"
  if (raw.includes("secondary") || raw.includes("optional")) return "secondary"
  if (edgeKind === "error") return "error"
  if (edgeKind === "bus" || edgeKind === "data") return edgeKind
  return index === 0 ? "primary" : "primary"
}

function defaultLabelPriority(pathRole: string, edgeKind: string, profile: DiagramDesignProfile): VisualPlanEdge["labelPriority"] {
  if (profile === "embedded-fsm-flow" && (pathRole === "local-transition" || pathRole === "cross-module" || pathRole === "feedback" || edgeKind === "transition" || edgeKind === "event")) return "low"
  return pathRole === "primary" ? "medium" : "low"
}

function labelPriorityFor(edge: DrawioEdgeSpec, fallback: VisualPlanEdge["labelPriority"]) {
  const raw = normalizeKey(stringValue((edge as Record<string, unknown>).labelPriority))
  if (raw === "high" || raw === "medium" || raw === "low") return raw
  return fallback
}

function roleNodeStyle(role: string, profile: DiagramDesignProfile) {
  if (role === "decision") return "shape=rhombus;fillColor=#fef9c3;strokeColor=#ca8a04;"
  if (role === "port") return "fillColor=#fff7ed;strokeColor=#f97316;fontSize=10;"
  if (role === "event") return "fillColor=#eff6ff;strokeColor=#2563eb;"
  if (role === "state" && profile === "embedded-fsm-flow") return "fillColor=#ecfdf5;strokeColor=#059669;rounded=1;fontStyle=1;"
  if (role === "state") return "fillColor=#ecfdf5;strokeColor=#16a34a;"
  if (profile === "soc-block") return "rounded=1;"
  return ""
}

function edgeStyle(edgeKind: string, pathRole: string, priority: VisualPlanEdge["labelPriority"], profile: DiagramDesignProfile) {
  const parts = ["edgeStyle=orthogonalEdgeStyle;orthogonalLoop=1;jettySize=auto;rounded=1;html=0;labelBackgroundColor=#ffffff;spacing=3;"]
  if (edgeKind === "bus" || pathRole === "bus") parts.push("strokeWidth=5;strokeColor=#92400e;endArrow=block;")
  else if (edgeKind === "data" || pathRole === "data") parts.push("strokeWidth=3;strokeColor=#0f766e;endArrow=block;")
  else if (pathRole === "error") parts.push("strokeWidth=2;strokeColor=#dc2626;dashed=1;endArrow=block;")
  else if (pathRole === "feedback" || pathRole === "backtrack") parts.push("strokeWidth=2;strokeColor=#64748b;dashed=1;endArrow=open;")
  else if (pathRole === "local-transition" || edgeKind === "transition") parts.push("strokeWidth=1.5;strokeColor=#059669;endArrow=block;")
  else if (pathRole === "cross-module") parts.push("strokeWidth=2;strokeColor=#92400e;endArrow=block;")
  else if (edgeKind === "event") parts.push("strokeWidth=2;strokeColor=#7c3aed;dashed=1;endArrow=block;")
  else if (pathRole === "secondary") parts.push("strokeWidth=2;strokeColor=#94a3b8;endArrow=block;")
  else parts.push(`strokeWidth=${profile === "soc-block" ? 3 : 2};strokeColor=#2563eb;endArrow=block;`)
  if (priority === "low") parts.push("fontSize=10;fontColor=#64748b;")
  else parts.push("fontSize=11;fontColor=#111827;")
  return parts.join("")
}

function maxNodeLineWeight(profile: DiagramDesignProfile) {
  if (profile === "soc-block" || profile === "architecture") return 24
  if (profile === "embedded-fsm-flow") return 22
  if (profile === "state-machine") return 26
  return 28
}

function shapeCompactLabel(input: string, maxLength: number, maxLineWeight: number, maxLines: number) {
  const text = compactLabelText(input, maxLength)
  const sourceLines = text.split(/\r\n|\r|\n/).map((line) => line.trim()).filter(Boolean)
  const lines: string[] = []
  for (const sourceLine of sourceLines.length ? sourceLines : [text]) {
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
  visible[visible.length - 1] = `${visible[visible.length - 1].replace(/\.\.\.$/, "")}...`
  return visible.join("\n")
}

function splitLongLabelToken(token: string, maxLineWeight: number) {
  if (weightedTextLength(token) <= maxLineWeight) return [token]
  const pieces: string[] = []
  let current = ""
  for (let index = 0; index < token.length; index += 1) {
    const char = token[index]
    const next = token[index + 1] || ""
    current += char
    const canBreak = /[_./:|,;()[\]{}-]/.test(char) ||
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

function compactLabelText(input: string, maxLength: number) {
  const text = sanitizeVisibleLabel(input).replace(/\r\n|\r/g, "\n").split("\n").map((line) => line.replace(/[ \t]+/g, " ").trim()).filter(Boolean).join("\n")
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3)}...`
}

function weightedTextLength(label: string) {
  let total = 0
  for (const char of label) {
    if (/\s/.test(char)) total += 0.45
    else if (/[\u3400-\u9fff\uff00-\uffef]/.test(char)) total += 1.9
    else if (/[A-Z0-9_/().:$-]/.test(char)) total += 1.18
    else total += 1
  }
  return total
}

function isStateLikeNode(node: Record<string, unknown>) {
  const role = normalizeKey(stringValue(node.visualRole) || stringValue(node.role) || stringValue(node.type) || stringValue(node.shape))
  const label = normalizeKey(stringValue(node.label) || stringValue(node.title) || stringValue(node.text) || stringValue(node.id))
  return role.includes("state") ||
    role.includes("fsm") ||
    /(?:^|[-_])(idle|wait|dispatch|complete|done|busy|error|ready|reclaim|flush|scan|folding|prepare|parity)(?:$|[-_])/.test(label)
}

function isModuleLikeNode(node: Record<string, unknown>) {
  const role = normalizeKey(stringValue(node.visualRole) || stringValue(node.role) || stringValue(node.type) || stringValue(node.shape))
  return role.includes("module") ||
    role.includes("submodule") ||
    role.includes("lane") ||
    role.includes("container") ||
    role.includes("region")
}

function isTransitionLikeEdge(edge: Record<string, unknown>) {
  const edgeKind = normalizeKey(stringValue(edge.edgeKind) || stringValue(edge.kind) || stringValue(edge.type))
  const pathRole = normalizeKey(stringValue(edge.pathRole) || stringValue(edge.role))
  return edgeKind.includes("transition") ||
    edgeKind.includes("event") ||
    edgeKind.includes("guard") ||
    edgeKind.includes("condition") ||
    pathRole.includes("localtransition") ||
    pathRole.includes("feedback") ||
    pathRole.includes("crossmodule") ||
    pathRole.includes("cross-module")
}

function truthyHint(input: unknown) {
  return input === true || (typeof input === "string" && /^(true|yes|1)$/i.test(input.trim()))
}

function numericHint(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : 0
}

function cloneSpec(input: DrawioDiagramSpec): DrawioDiagramSpec {
  return JSON.parse(JSON.stringify(input ?? {})) as DrawioDiagramSpec
}

function mergeStyle(...parts: Array<DrawioStyleInput | undefined>) {
  return parts
    .flatMap((part) => {
      if (!part) return []
      if (typeof part === "string") return [part]
      return Object.entries(part).map(([key, value]) => `${key}=${String(value ?? "")}`)
    })
    .map((part) => part.trim())
    .filter(Boolean)
    .join(";")
}

function warn(context: DesignContext, message: string) {
  if (!context.warnings.includes(message)) context.warnings.push(message)
}

function normalizeKey(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9_-]+/g, "")
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
