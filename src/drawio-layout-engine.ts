import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { Script } from "node:vm"
import ELK, { type ElkExtendedEdge, type ElkNode, type ElkPoint, type LayoutOptions } from "elkjs/lib/elk-api.js"
import type { DrawioPointSpec, Geometry, NormalizedContainer, NormalizedEdge, NormalizedNode } from "./drawio-diagram-generator"

export type DrawioElkLayoutInput = {
  title: string
  diagramType: string
  layout: string
  nodes: NormalizedNode[]
  edges: NormalizedEdge[]
  containers: NormalizedContainer[]
}

type DrawioLayoutStage = "elk.import" | "elk.layout" | "elk.output"

type DrawioLayoutCounts = {
  nodeCount: number
  edgeCount: number
  containerCount: number
}

type ElkLayoutRunner = (graph: ElkNode) => Promise<ElkNode>
type ElkWorkerLike = {
  onmessage?: (answer: { data: unknown }) => void
  postMessage: (message: unknown) => void
  terminate?: () => void
}
type ElkWorkerConstructor = new () => ElkWorkerLike

let elkLayoutRunnerForTest: ElkLayoutRunner | undefined
let elkWorkerConstructor: ElkWorkerConstructor | undefined
const nodeRequire = createRequire(__filename)

export function setDrawioElkLayoutRunnerForTest(runner: ElkLayoutRunner | undefined) {
  elkLayoutRunnerForTest = runner
}

export class DrawioLayoutError extends Error {
  readonly stage: DrawioLayoutStage
  readonly title: string
  readonly diagramType: string
  readonly nodeCount: number
  readonly edgeCount: number
  readonly containerCount: number

  constructor(input: DrawioElkLayoutInput, stage: DrawioLayoutStage, message: string) {
    const counts = layoutCounts(input)
    super(
      `ELK layout failed at stage=${stage} title="${input.title}" diagramType="${input.diagramType}" ` +
      `nodes=${counts.nodeCount} edges=${counts.edgeCount} containers=${counts.containerCount}: ${message}`,
    )
    this.name = "DrawioLayoutError"
    this.stage = stage
    this.title = input.title
    this.diagramType = input.diagramType
    this.nodeCount = counts.nodeCount
    this.edgeCount = counts.edgeCount
    this.containerCount = counts.containerCount
  }
}

export async function applyElkLayoutToDrawio(input: DrawioElkLayoutInput): Promise<void> {
  let layoutGraph: ElkNode
  const elkGraph = buildElkGraph(input)
  try {
    layoutGraph = await runElkLayout(elkGraph)
  } catch (error) {
    throw new DrawioLayoutError(input, "elk.layout", errorMessage(error))
  }

  try {
    applyElkOutput(input, layoutGraph)
  } catch (error) {
    if (error instanceof DrawioLayoutError) throw error
    throw new DrawioLayoutError(input, "elk.output", errorMessage(error))
  }
}

function buildElkGraph(input: DrawioElkLayoutInput): ElkNode {
  const nodesByParent = groupByParent(input.nodes)
  const containersByParent = groupByParent(input.containers)
  const knownNodeIds = new Set([...input.nodes.map((node) => node.id), ...input.containers.map((container) => container.id)])
  const validEdges: ElkExtendedEdge[] = input.edges
    .filter((edge) => edge.source && edge.target && knownNodeIds.has(edge.source) && knownNodeIds.has(edge.target))
    .map((edge) => ({
      id: edge.id,
      sources: [edge.source as string],
      targets: [edge.target as string],
      labels: edge.label ? [{
        text: edge.label,
        width: Math.min(220, Math.max(48, edge.label.length * 7)),
        height: 18,
      }] : undefined,
      layoutOptions: edgeLayoutOptions(edge, input),
    }))

  return {
    id: "chipmate-drawio-root",
    layoutOptions: rootLayoutOptions(input),
    children: [
      ...childrenForParent("1", input, containersByParent, nodesByParent),
    ],
    edges: validEdges,
  }
}

function childrenForParent(
  parent: string,
  input: DrawioElkLayoutInput,
  containersByParent: Map<string, NormalizedContainer[]>,
  nodesByParent: Map<string, NormalizedNode[]>,
): ElkNode[] {
  const containers = containersByParent.get(parent) ?? []
  const nodes = nodesByParent.get(parent) ?? []
  return [
    ...containers.map((container) => containerToElk(container, input, containersByParent, nodesByParent)),
    ...nodes.map(nodeToElk),
  ]
}

function containerToElk(
  container: NormalizedContainer,
  input: DrawioElkLayoutInput,
  containersByParent: Map<string, NormalizedContainer[]>,
  nodesByParent: Map<string, NormalizedNode[]>,
): ElkNode {
  return {
    id: container.id,
    width: Math.max(160, container.geometry.width),
    height: Math.max(120, container.geometry.height),
    layoutOptions: {
      ...compoundLayoutOptions(input),
      "elk.padding": container.kind === "swimlane"
        ? "[top=52,left=28,bottom=28,right=28]"
        : "[top=44,left=28,bottom=28,right=28]",
    },
    children: childrenForParent(container.id, input, containersByParent, nodesByParent),
  }
}

function nodeToElk(node: NormalizedNode): ElkNode {
  return {
    id: node.id,
    width: Math.max(32, node.geometry.width),
    height: Math.max(24, node.geometry.height),
  }
}

async function runElkLayout(graph: ElkNode): Promise<ElkNode> {
  if (elkLayoutRunnerForTest) return elkLayoutRunnerForTest(graph)
  const elk = new ELK({ workerFactory: createElkWorker })
  try {
    return await elk.layout(graph)
  } finally {
    try {
      elk.terminateWorker()
    } catch {
      // The bundled fake worker used by elkjs in non-browser runtimes has no
      // native thread to terminate. Keep cleanup best-effort.
    }
  }
}

function createElkWorker(): ElkWorkerLike {
  const WorkerConstructor = loadElkWorkerConstructor()
  const worker = new WorkerConstructor()
  if (typeof worker.terminate !== "function") worker.terminate = () => undefined
  return worker
}

function loadElkWorkerConstructor(): ElkWorkerConstructor {
  if (elkWorkerConstructor) return elkWorkerConstructor
  const workerPath = nodeRequire.resolve("elkjs/lib/elk-worker.min.js")
  const required = safeRequire(workerPath)
  const requiredConstructor = workerConstructorFromExport(required)
  if (requiredConstructor) {
    elkWorkerConstructor = requiredConstructor
    return elkWorkerConstructor
  }

  const moduleObject: { exports: unknown } = { exports: {} }
  const sandbox: Record<string, unknown> = {
    module: moduleObject,
    exports: moduleObject.exports,
    require: nodeRequire,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    Error,
    Math,
    JSON,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    RegExp,
    TypeError,
  }
  sandbox.global = sandbox
  sandbox.globalThis = sandbox
  new Script(readFileSync(workerPath, "utf8"), { filename: workerPath }).runInNewContext(sandbox)
  const vmConstructor = workerConstructorFromExport(moduleObject.exports)
  if (!vmConstructor) throw new Error("elkjs worker module did not export a Worker constructor.")
  elkWorkerConstructor = vmConstructor
  return elkWorkerConstructor
}

function safeRequire(path: string): unknown {
  try {
    return nodeRequire(path)
  } catch {
    return undefined
  }
}

function workerConstructorFromExport(value: unknown): ElkWorkerConstructor | undefined {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : undefined
  const candidates = [
    record?.Worker,
    record?.default,
    record?.default && typeof record.default === "object" ? (record.default as Record<string, unknown>).Worker : undefined,
    typeof value === "function" ? value : undefined,
  ]
  return candidates.find((candidate): candidate is ElkWorkerConstructor => typeof candidate === "function")
}

function applyElkOutput(input: DrawioElkLayoutInput, layoutGraph: ElkNode) {
  const layoutNodes = new Map<string, ElkNode>()
  collectLayoutNodes(layoutGraph, layoutNodes)
  const layoutEdges = new Map<string, ElkExtendedEdge>()
  collectLayoutEdges(layoutGraph, layoutEdges)

  for (const container of input.containers) {
    const laidOut = layoutNodes.get(container.id)
    if (!laidOut) throw new DrawioLayoutError(input, "elk.output", `ELK output is missing container "${container.id}".`)
    container.geometry = geometryFromElk(input, laidOut, `container "${container.id}"`, container.geometry)
  }

  for (const node of input.nodes) {
    const laidOut = layoutNodes.get(node.id)
    if (!laidOut) throw new DrawioLayoutError(input, "elk.output", `ELK output is missing node "${node.id}".`)
    node.geometry = geometryFromElk(input, laidOut, `node "${node.id}"`, node.geometry)
  }

  input.edges.forEach((edge, index) => {
    edge.parent = "1"
    if (edge.label) {
      const offsets = isEmbeddedFsm(input)
        ? embeddedFsmLabelOffsets(edge, index)
        : [-30, 30, -48, 48]
      edge.labelOffset = { x: 0, y: offsets[index % offsets.length] }
    }
    if (!edge.source || !edge.target) return
    const laidOut = layoutEdges.get(edge.id)
    if (!laidOut) throw new DrawioLayoutError(input, "elk.output", `ELK output is missing edge "${edge.id}".`)
    const bendPoints = (laidOut.sections ?? []).flatMap((section) => section.bendPoints ?? [])
    edge.points = sanitizePoints(bendPoints)
  })
}

function geometryFromElk(input: DrawioElkLayoutInput, node: ElkNode, label: string, fallback: Geometry): Geometry {
  const x = finiteElkNumber(node.x)
  const y = finiteElkNumber(node.y)
  const width = finiteElkNumber(node.width)
  const height = finiteElkNumber(node.height)
  if (x === undefined || y === undefined || width === undefined || height === undefined) {
    throw new DrawioLayoutError(input, "elk.output", `ELK output has missing coordinates for ${label}.`)
  }
  return {
    x,
    y,
    width: Math.max(1, width || fallback.width),
    height: Math.max(1, height || fallback.height),
  }
}

function collectLayoutNodes(node: ElkNode, result: Map<string, ElkNode>) {
  if (node.id) result.set(node.id, node)
  for (const child of node.children ?? []) collectLayoutNodes(child, result)
}

function collectLayoutEdges(node: ElkNode, result: Map<string, ElkExtendedEdge>) {
  for (const edge of node.edges ?? []) {
    if (edge.id) result.set(edge.id, edge as ElkExtendedEdge)
  }
  for (const child of node.children ?? []) collectLayoutEdges(child, result)
}

function sanitizePoints(points: ElkPoint[]): DrawioPointSpec[] {
  return points
    .map((point) => ({ x: finiteElkNumber(point.x), y: finiteElkNumber(point.y) }))
    .filter((point): point is Required<DrawioPointSpec> => point.x !== undefined && point.y !== undefined)
}

function rootLayoutOptions(input: DrawioElkLayoutInput): LayoutOptions {
  const direction = directionFor(input)
  const embeddedFsm = isEmbeddedFsm(input)
  const complex = embeddedFsm || /architecture|soc-block|soc|swimlane|state-machine|code-flow|business-flow/.test(`${input.diagramType} ${input.layout}`.toLowerCase())
  return {
    "elk.algorithm": "layered",
    "elk.direction": direction,
    "elk.hierarchyHandling": "INCLUDE_CHILDREN",
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.spacing.nodeNode": embeddedFsm ? "120" : complex ? "92" : "70",
    "elk.spacing.edgeNode": embeddedFsm ? "72" : complex ? "44" : "28",
    "elk.spacing.edgeEdge": embeddedFsm ? "42" : complex ? "28" : "18",
    "elk.spacing.edgeLabel": embeddedFsm ? "32" : "18",
    "elk.layered.spacing.nodeNodeBetweenLayers": embeddedFsm ? "168" : complex ? "128" : "96",
    "elk.layered.spacing.edgeNodeBetweenLayers": embeddedFsm ? "76" : complex ? "52" : "32",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
    "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
    "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
    "elk.layered.mergeEdges": "false",
    "elk.padding": embeddedFsm ? "[top=52,left=64,bottom=52,right=64]" : complex ? "[top=36,left=36,bottom=36,right=36]" : "[top=24,left=24,bottom=24,right=24]",
  }
}

function compoundLayoutOptions(input: DrawioElkLayoutInput): LayoutOptions {
  if (isEmbeddedFsm(input)) {
    return {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.edgeRouting": "ORTHOGONAL",
      "elk.spacing.nodeNode": "82",
      "elk.spacing.edgeNode": "42",
      "elk.spacing.edgeEdge": "28",
      "elk.spacing.edgeLabel": "24",
      "elk.layered.spacing.nodeNodeBetweenLayers": "104",
      "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
      "elk.layered.nodePlacement.strategy": "BRANDES_KOEPF",
      "elk.padding": "[top=56,left=36,bottom=36,right=36]",
    }
  }
  return {
    "elk.algorithm": "layered",
    "elk.direction": directionFor(input),
    "elk.edgeRouting": "ORTHOGONAL",
    "elk.spacing.nodeNode": "64",
    "elk.spacing.edgeNode": "32",
    "elk.spacing.edgeEdge": "20",
    "elk.layered.spacing.nodeNodeBetweenLayers": "84",
    "elk.layered.crossingMinimization.strategy": "LAYER_SWEEP",
  }
}

function directionFor(input: DrawioElkLayoutInput) {
  const key = `${input.diagramType} ${input.layout}`.toLowerCase()
  if (/embedded-fsm-flow/.test(key)) return "DOWN"
  if (/architecture|soc-block|soc|swimlane/.test(key)) return "RIGHT"
  if (/sequence/.test(key)) return "RIGHT"
  return "DOWN"
}

function edgeLayoutOptions(edge: NormalizedEdge, input: DrawioElkLayoutInput): LayoutOptions | undefined {
  if (!isEmbeddedFsm(input)) return undefined
  const role = `${edge.pathRole ?? ""} ${edge.edgeKind ?? ""}`.toLowerCase()
  if (/feedback|backtrack|loop/.test(role)) return { "elk.layered.priority.direction": "1" }
  if (/cross-module|bus|data/.test(role)) return { "elk.layered.priority.direction": "20" }
  if (/local-transition|transition|event/.test(role)) return { "elk.layered.priority.direction": "8" }
  return { "elk.layered.priority.direction": "12" }
}

function embeddedFsmLabelOffsets(edge: NormalizedEdge, index: number) {
  const role = `${edge.pathRole ?? ""} ${edge.edgeKind ?? ""}`.toLowerCase()
  if (/feedback|backtrack|loop/.test(role)) return [-56, 56, -72, 72]
  if (/cross-module|bus|data/.test(role)) return [-64, 64, -84, 84]
  if (/local-transition|transition|event/.test(role)) return [-28, 28, -40, 40]
  return [-42, 42, -60, 60]
}

function isEmbeddedFsm(input: DrawioElkLayoutInput) {
  return /embedded-fsm-flow/.test(`${input.diagramType} ${input.layout}`.toLowerCase())
}

function groupByParent<T extends { parent: string }>(items: T[]) {
  const result = new Map<string, T[]>()
  for (const item of items) {
    const list = result.get(item.parent) ?? []
    list.push(item)
    result.set(item.parent, list)
  }
  return result
}

function finiteElkNumber(input: unknown) {
  return typeof input === "number" && Number.isFinite(input) ? input : undefined
}

function layoutCounts(input: DrawioElkLayoutInput): DrawioLayoutCounts {
  return {
    nodeCount: input.nodes.length,
    edgeCount: input.edges.length,
    containerCount: input.containers.length,
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
