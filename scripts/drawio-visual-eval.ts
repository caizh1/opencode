import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { setTimeout as delay } from "node:timers/promises"
import { decodeDrawioPngDataUri } from "../src/drawio-export"
import { generateDrawioDiagram, type DrawioGeneratedDiagram, type Geometry, type NormalizedContainer, type NormalizedEdge, type NormalizedNode } from "../src/drawio-diagram-generator"
import { validateDiagramIr, type DiagramIr } from "../src/diagram-ir"

type ReviewMode = "vision" | "deterministic"

export type DrawioVisualEvalCase = {
  id: string
  title: string
  category: string
  public: boolean
  referenceImage?: string
  expectedRendererFocus: string[]
  diagramIr: DiagramIr
}

export type DrawioVisualMetrics = {
  nodeCount: number
  edgeCount: number
  containerCount: number
  railEdgeCount: number
  railEdgesWithPoints: number
  visibleEdgesWithPoints: number
  edgePointsCoverage: number
  nodeOverlapCount: number
  containerOverlapCount: number
  textOverflowRiskCount: number
  narrowContainerLabelRiskCount: number
  nodeContainerBoundaryViolationCount: number
  nodeUnownedContainerOverlapCount: number
  socVisibleLowPriorityEdgeLabelCount: number
  shortHeavyArrowCount: number
  socContainerHorizontalFillRiskCount: number
  socBusContainerAlignmentRiskCount: number
  busFanInAmbiguityCount: number
  busFanOutAmbiguityCount: number
  pseudoSelfLoopRiskCount: number
  sharedPortOverlapCount: number
  busTrunkAlignmentRiskCount: number
  unexplainedHeavyBusCount: number
  mainGraphOffsetRatio: number
  blankSpaceRatio: number
  railCollinearOverlapCount: number
  edgeCollinearOverlapCount: number
  edgeIntersectionCount: number
  unnecessaryBendCount: number
  shortJogCount: number
  edgePassThroughCount: number
  edgeContainerPassThroughCount: number
  disconnectedEdgeEndpointCount: number
  legendOverwide: boolean
  legendOverlapCount: number
  legendGenerated: boolean
  pngWidth?: number
  pngHeight?: number
  pngBoundsAbnormal: boolean
  fatalCount: number
  warnings: string[]
  classification: "pass" | "model-input" | "renderer-execution"
}

export type VisionReview = {
  readabilityScore: number
  flowClarityScore: number
  textFitScore: number
  edgeClutterScore: number
  legendUsefulnessScore: number
  deliveryReady: boolean
  topIssues: string[]
  suggestedGenericFixes: string[]
}

type EvalOptions = {
  cases: string[]
  review: ReviewMode
  outputRoot: string
  failUnder: number
}

type EvalRecord = {
  case: DrawioVisualEvalCase
  outputDir: string
  generated?: DrawioGeneratedDiagram
  metrics?: DrawioVisualMetrics
  mermaidSource?: string
  mermaidPngBytes?: Uint8Array
  review?: VisionReview
  error?: string
}

const DEFAULT_OUTPUT_ROOT = "artifacts/drawio-visual-eval"
const DEFAULT_FAIL_UNDER = 8
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
const SOC_TARGET_REFERENCE_IMAGE = "/Users/archer/.codex/attachments/02409038-0ca9-4017-8b95-1b1758f9d113/image-1.png"
const CORTEX_R8_REFERENCE_IMAGE = "/Users/archer/.codex/attachments/3efe5822-9e47-4dbd-acb7-1aa311539b50/image-1.png"

export async function runDrawioVisualEval(rawOptions: Partial<EvalOptions> = {}) {
  const options: EvalOptions = {
    cases: rawOptions.cases?.length ? rawOptions.cases : ["all"],
    review: rawOptions.review ?? "vision",
    outputRoot: rawOptions.outputRoot ?? DEFAULT_OUTPUT_ROOT,
    failUnder: rawOptions.failUnder ?? DEFAULT_FAIL_UNDER,
  }
  if (options.review === "vision") assertVisionEnv()

  const repoRoot = resolve(join(import.meta.dir, ".."))
  const runId = new Date().toISOString().replace(/[:.]/g, "-")
  const runRoot = resolve(repoRoot, options.outputRoot, runId)
  await mkdir(runRoot, { recursive: true })

  const cases = selectCases(options.cases, drawioVisualEvalCases(), drawioSocVisualEvalCases())
  const records: EvalRecord[] = []
  for (const evalCase of cases) {
    const outputDir = join(runRoot, evalCase.id)
    await mkdir(outputDir, { recursive: true })
    const record: EvalRecord = { case: evalCase, outputDir }
    records.push(record)
    try {
      await writeJson(join(outputDir, "case.json"), evalCase)
      const validation = validateDiagramIr({ diagramIr: evalCase.diagramIr })
      if (validation.issues.some((issue) => issue.severity === "blocking")) {
        throw new Error(`DiagramIR blocking gap before rendering: ${validation.issues.filter((issue) => issue.severity === "blocking").map((issue) => `${issue.code}: ${issue.message}`).join(" | ")}`)
      }

      const generated = await generateDrawioDiagram({ diagramIr: evalCase.diagramIr })
      record.generated = generated
      await writeFile(join(outputDir, "generated.xml"), generated.mxGraphModelXml)
      await writeJson(join(outputDir, "normalizedSpec.json"), generated.normalizedSpec)

      if (!isSocSuiteCase(evalCase)) {
        const mermaidSource = mermaidSourceForCase(evalCase)
        record.mermaidSource = mermaidSource
        await writeFile(join(outputDir, "mermaid.mmd"), mermaidSource)
        const mermaidDataUri = await renderMermaidToPngDataUri({
          source: mermaidSource,
          repoRoot,
        })
        const mermaidPngBytes = decodeDrawioPngDataUri(mermaidDataUri, 50 * 1024 * 1024)
        record.mermaidPngBytes = mermaidPngBytes
        await writeFile(join(outputDir, "mermaid.png"), mermaidPngBytes)
      }

      const dataUri = await renderDrawioXmlToPngDataUri({
        xml: generated.mxGraphModelXml,
        repoRoot,
        title: evalCase.title,
      })
      const pngBytes = decodeDrawioPngDataUri(dataUri, 50 * 1024 * 1024)
      const previewPath = join(outputDir, "preview.png")
      await writeFile(previewPath, pngBytes)

      const metrics = computeDrawioVisualMetrics(generated, pngBytes)
      record.metrics = metrics
      await writeJson(join(outputDir, "metrics.json"), metrics)

      if (options.review === "vision") {
        const review = await reviewDiagramWithVision({
          evalCase,
          generated,
          metrics,
          dataUri,
        })
        record.review = review
        await writeJson(join(outputDir, "review.json"), review)
      } else {
        const review = deterministicReview(metrics, options.failUnder)
        record.review = review
        await writeJson(join(outputDir, "review.json"), review)
      }
    } catch (error) {
      record.error = error instanceof Error ? error.message : String(error)
      await writeJson(join(outputDir, "error.json"), { error: record.error })
    }
  }

  await writeContactSheet(runRoot, records)
  await writeReport(runRoot, records, options)
  const failed = failedRecords(records, options.failUnder)
  console.log(`drawio-visual-eval run=${runRoot}`)
  console.log(`cases=${records.length} failed=${failed.length} review=${options.review}`)
  console.log(`report=${join(runRoot, "report.md")}`)
  if (failed.length) {
    throw new Error(`draw.io visual eval failed ${failed.length}/${records.length} case(s): ${failed.map((record) => record.case.id).join(", ")}`)
  }
  return { runRoot, records }
}

export function drawioVisualEvalCases(): DrawioVisualEvalCase[] {
  const publicCases = [
    simpleBusinessFlowCase(),
    embeddedFsmBusinessFlowCase(),
    stateMachineCase(),
    socArchitectureCase(),
    mixedCodeFlowCase(),
  ]
  return [
    ...publicCases,
    canaryCase("canary-neutral-fsm", embeddedFsmBusinessFlowCase(), {
      title: "Neutral device service process",
      replacements: [
        ["MP GC", "Service A"],
        ["Runtime FSM", "Worker Loop"],
        ["入口检查", "Input gate"],
        ["调度", "Select"],
        ["回收", "Process"],
        ["完成", "Done"],
      ],
    }),
    canaryCase("canary-neutral-code", mixedCodeFlowCase(), {
      title: "Neutral mixed-language code path",
      replacements: [
        ["handle_request", "dispatch_payload"],
        ["权限", "quota"],
        ["缓存", "snapshot"],
        ["回滚", "fallback"],
      ],
    }),
  ]
}

export function drawioSocVisualEvalCases(): DrawioVisualEvalCase[] {
  return [
    socCortexR8ReferenceCase(),
    socCortexA53ClusterCase(),
    socGpuSliceReferenceCase(),
    socCpuCoreBackendCase(),
    socSsdControllerFabricCase(),
  ]
}

export function computeDrawioVisualMetrics(generated: DrawioGeneratedDiagram, pngBytes?: Uint8Array): DrawioVisualMetrics {
  const rootView = rootGeometryView(generated.normalizedSpec.containers, generated.normalizedSpec.nodes)
  const nodes = rootView.nodes
  const edges = generated.normalizedSpec.edges
  const containers = rootView.containers
  const profile = generated.normalizedSpec.visualPlan?.profile ?? generated.normalizedSpec.diagramType
  const structuralProfile = profile === "architecture" || profile === "soc-block"
  const mainNodes = primaryGraphNodes(nodes, generated)
  const nonLegendNodes = nodes.filter((node) => !isLegendNode(node))
  const nonLegendContainers = containers.filter((container) => !isLegendContainer(container))
  const visibleBounds = boundsForGeometries([
    ...nonLegendNodes.map((node) => node.geometry),
    ...nonLegendContainers.map((container) => container.geometry),
  ])
  const mainBounds = structuralProfile
    ? visibleBounds
    : boundsForNodes(mainNodes.length ? mainNodes : nodes)
  const allBounds = boundsForGeometries([
    ...nodes.map((node) => node.geometry),
    ...containers.map((container) => container.geometry),
  ])
  const railEdges = edges.filter((edge) => edge.presentationMode === "rail")
  const railEdgesWithPoints = railEdges.filter((edge) => edge.points.length > 0).length
  const visibleEdgesWithPoints = edges.filter((edge) => edge.points.length > 0).length
  const nodeOverlapCount = countNodeOverlaps(nonLegendNodes)
  const containerOverlapCount = countContainerOverlaps(nonLegendContainers)
  const textOverflowRiskCount = nonLegendNodes.filter((node) => textOverflowRisk(node)).length
  const narrowContainerLabelRiskCount = profile === "soc-block" ? countNarrowContainerLabelRisks(nonLegendContainers) : 0
  const nodeContainerBoundaryViolationCount = profile === "soc-block" ? countNodeContainerBoundaryViolations(nonLegendNodes, nonLegendContainers) : 0
  const nodeUnownedContainerOverlapCount = profile === "soc-block" ? countNodeUnownedContainerOverlaps(nonLegendNodes, nonLegendContainers) : 0
  const socVisibleLowPriorityEdgeLabelCount = profile === "soc-block" ? countSocVisibleLowPriorityEdgeLabels(edges) : 0
  const shortHeavyArrowCount = profile === "soc-block" ? countShortHeavyArrows(nonLegendNodes, edges) : 0
  const socContainerHorizontalFillRiskCount = profile === "soc-block" ? countSocContainerHorizontalFillRisks(nonLegendNodes, nonLegendContainers) : 0
  const socBusContainerAlignmentRiskCount = profile === "soc-block" ? countSocBusContainerAlignmentRisks(nonLegendNodes, nonLegendContainers, edges) : 0
  const busFanInAmbiguityCount = profile === "soc-block" || profile === "architecture" ? countBusEndpointAmbiguities(generated, "target") : 0
  const busFanOutAmbiguityCount = profile === "soc-block" || profile === "architecture" ? countBusEndpointAmbiguities(generated, "source") : 0
  const pseudoSelfLoopRiskCount = profile === "soc-block" || profile === "architecture" ? countPseudoSelfLoopRisks(nonLegendNodes, edges) : 0
  const sharedPortOverlapCount = profile === "soc-block" || profile === "architecture" ? countSharedPortOverlaps(nonLegendNodes, edges) : 0
  const busTrunkAlignmentRiskCount = profile === "soc-block" || profile === "architecture" ? countBusTrunkAlignmentRisks(nonLegendNodes, edges) : 0
  const unexplainedHeavyBusCount = profile === "soc-block" || profile === "architecture" ? countUnexplainedHeavyBuses(generated, edges) : 0
  const mainGraphOffsetRatio = centerDistanceRatio(mainBounds, visibleBounds)
  const blankSpaceRatio = blankRatio(nonLegendNodes, visibleBounds)
  const railCollinearOverlapCount = countRailCollinearOverlaps(railEdges)
  const edgeCollinearOverlapCount = countRailCollinearOverlaps(edges)
  const edgeIntersectionCount = countEdgeIntersections(nonLegendNodes, edges)
  const unnecessaryBendCount = countUnnecessaryBends(nonLegendNodes, nonLegendContainers, edges)
  const shortJogCount = countShortJogs(nonLegendNodes, edges)
  const edgePassThroughCount = countEdgePassThroughs(nonLegendNodes, edges)
  const edgeContainerPassThroughCount = profile === "soc-block" ? 0 : countEdgeContainerPassThroughs(nonLegendNodes, nonLegendContainers, edges)
  const disconnectedEdgeEndpointCount = edges.filter((edge) => !edge.source || !edge.target || !nonLegendNodes.some((node) => node.id === edge.source) || !nonLegendNodes.some((node) => node.id === edge.target)).length
  const legend = containers.find(isLegendContainer)
  const legendOverlapCount = legend ? countLegendOverlaps(legend, nonLegendNodes, nonLegendContainers) : 0
  const legendPosition = generated.normalizedSpec.visualPlan?.legend?.position
  const legendOverwide = Boolean(legend && mainBounds.width > 0 && (
    legendPosition === "bottom"
      ? legend.geometry.width > Math.max(900, visibleBounds.width * 1.08)
      : legend.geometry.width > Math.max(560, mainBounds.width * 0.9)
  ))
  const pngSize = pngBytes ? pngSizeFromBytes(pngBytes) : undefined
  const maxPngWidth = structuralProfile ? 18000 : 12000
  const maxPngHeight = structuralProfile ? 12000 : 12000
  const pngBoundsAbnormal = Boolean(pngSize && (pngSize.width > maxPngWidth || pngSize.height > maxPngHeight || pngSize.width < 32 || pngSize.height < 32))
  const warnings: string[] = []
  if (nodeOverlapCount > 0) warnings.push(`nodeOverlapCount=${nodeOverlapCount}`)
  if (containerOverlapCount > 0) warnings.push(`containerOverlapCount=${containerOverlapCount}`)
  if (textOverflowRiskCount > 0) warnings.push(`textOverflowRiskCount=${textOverflowRiskCount}`)
  if (narrowContainerLabelRiskCount > 0) warnings.push(`narrowContainerLabelRiskCount=${narrowContainerLabelRiskCount}`)
  if (nodeContainerBoundaryViolationCount > 0) warnings.push(`nodeContainerBoundaryViolationCount=${nodeContainerBoundaryViolationCount}`)
  if (nodeUnownedContainerOverlapCount > 0) warnings.push(`nodeUnownedContainerOverlapCount=${nodeUnownedContainerOverlapCount}`)
  if (socVisibleLowPriorityEdgeLabelCount > 0) warnings.push(`socVisibleLowPriorityEdgeLabelCount=${socVisibleLowPriorityEdgeLabelCount}`)
  if (shortHeavyArrowCount > 0) warnings.push(`shortHeavyArrowCount=${shortHeavyArrowCount}`)
  if (socContainerHorizontalFillRiskCount > 0) warnings.push(`socContainerHorizontalFillRiskCount=${socContainerHorizontalFillRiskCount}`)
  if (socBusContainerAlignmentRiskCount > 0) warnings.push(`socBusContainerAlignmentRiskCount=${socBusContainerAlignmentRiskCount}`)
  if (busFanInAmbiguityCount > 0) warnings.push(`busFanInAmbiguityCount=${busFanInAmbiguityCount}`)
  if (busFanOutAmbiguityCount > 0) warnings.push(`busFanOutAmbiguityCount=${busFanOutAmbiguityCount}`)
  if (pseudoSelfLoopRiskCount > 0) warnings.push(`pseudoSelfLoopRiskCount=${pseudoSelfLoopRiskCount}`)
  if (sharedPortOverlapCount > 0) warnings.push(`sharedPortOverlapCount=${sharedPortOverlapCount}`)
  if (busTrunkAlignmentRiskCount > 0) warnings.push(`busTrunkAlignmentRiskCount=${busTrunkAlignmentRiskCount}`)
  if (unexplainedHeavyBusCount > 0) warnings.push(`unexplainedHeavyBusCount=${unexplainedHeavyBusCount}`)
  if (railEdges.length && railEdgesWithPoints < railEdges.length) warnings.push(`railEdgesMissingPoints=${railEdges.length - railEdgesWithPoints}`)
  if (visibleEdgesWithPoints < edges.length) warnings.push(`visibleEdgesMissingExplicitPoints=${edges.length - visibleEdgesWithPoints}`)
  if (railCollinearOverlapCount > 0) warnings.push(`railCollinearOverlapCount=${railCollinearOverlapCount}`)
  if (edgeCollinearOverlapCount > 0) warnings.push(`edgeCollinearOverlapCount=${edgeCollinearOverlapCount}`)
  if (edgeIntersectionCount > 0) warnings.push(`edgeIntersectionCount=${edgeIntersectionCount}`)
  if (unnecessaryBendCount > 0) warnings.push(`unnecessaryBendCount=${unnecessaryBendCount}`)
  if (shortJogCount > 0) warnings.push(`shortJogCount=${shortJogCount}`)
  if (edgePassThroughCount > 0) warnings.push(`edgePassThroughCount=${edgePassThroughCount}`)
  if (edgeContainerPassThroughCount > 0) warnings.push(`edgeContainerPassThroughCount=${edgeContainerPassThroughCount}`)
  if (disconnectedEdgeEndpointCount > 0) warnings.push(`disconnectedEdgeEndpointCount=${disconnectedEdgeEndpointCount}`)
  if (mainGraphOffsetRatio > 0.36) warnings.push(`mainGraphOffsetRatio=${mainGraphOffsetRatio.toFixed(2)}`)
  if (!structuralProfile && blankSpaceRatio > 0.94 && nonLegendNodes.length > 6) warnings.push(`blankSpaceRatio=${blankSpaceRatio.toFixed(2)}`)
  if (legendOverwide) warnings.push("legendOverwide=true")
  if (legendOverlapCount > 0) warnings.push(`legendOverlapCount=${legendOverlapCount}`)
  if (pngBoundsAbnormal) warnings.push(`pngBoundsAbnormal=${pngSize?.width}x${pngSize?.height}`)

  const fatalCount = [
    nodeOverlapCount > 0,
    containerOverlapCount > 0,
    textOverflowRiskCount > 0,
    narrowContainerLabelRiskCount > 0,
    nodeContainerBoundaryViolationCount > 0,
    nodeUnownedContainerOverlapCount > 0,
    socVisibleLowPriorityEdgeLabelCount > 0,
    shortHeavyArrowCount > 0,
    socContainerHorizontalFillRiskCount > 0,
    socBusContainerAlignmentRiskCount > 0,
    busFanInAmbiguityCount > 0,
    busFanOutAmbiguityCount > 0,
    pseudoSelfLoopRiskCount > 0,
    sharedPortOverlapCount > 0,
    busTrunkAlignmentRiskCount > 0,
    unexplainedHeavyBusCount > 0,
    railEdges.length > 0 && railEdgesWithPoints < railEdges.length,
    visibleEdgesWithPoints < edges.length,
    railCollinearOverlapCount > 0,
    edgeCollinearOverlapCount > 0,
    edgeIntersectionCount > 0,
    unnecessaryBendCount > 0,
    shortJogCount > 0,
    edgePassThroughCount > 0,
    edgeContainerPassThroughCount > 0,
    disconnectedEdgeEndpointCount > 0,
    mainGraphOffsetRatio > 0.52,
    legendOverwide,
    legendOverlapCount > 0,
    pngBoundsAbnormal,
  ].filter(Boolean).length
  const modelInputWarnings = generated.warnings.filter((warning) => /visualPlan|legend|DiagramIR|evidence|model\/active skill|blocking|ownership/i.test(warning))
  const rendererWarnings = warnings.filter((warning) => /Overlap|MissingPoints|PassThrough|Offset|Bounds|Overwide|blankSpace|FillRisk|AlignmentRisk|shortJog/i.test(warning))
  return {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    containerCount: containers.length,
    railEdgeCount: railEdges.length,
    railEdgesWithPoints,
    visibleEdgesWithPoints,
    edgePointsCoverage: edges.length ? visibleEdgesWithPoints / edges.length : 1,
    nodeOverlapCount,
    containerOverlapCount,
    textOverflowRiskCount,
    narrowContainerLabelRiskCount,
    nodeContainerBoundaryViolationCount,
    nodeUnownedContainerOverlapCount,
    socVisibleLowPriorityEdgeLabelCount,
    shortHeavyArrowCount,
    socContainerHorizontalFillRiskCount,
    socBusContainerAlignmentRiskCount,
    busFanInAmbiguityCount,
    busFanOutAmbiguityCount,
    pseudoSelfLoopRiskCount,
    sharedPortOverlapCount,
    busTrunkAlignmentRiskCount,
    unexplainedHeavyBusCount,
    mainGraphOffsetRatio,
    blankSpaceRatio,
    railCollinearOverlapCount,
    edgeCollinearOverlapCount,
    edgeIntersectionCount,
    unnecessaryBendCount,
    shortJogCount,
    edgePassThroughCount,
    edgeContainerPassThroughCount,
    disconnectedEdgeEndpointCount,
    legendOverwide,
    legendOverlapCount,
    legendGenerated: Boolean(legend),
    pngWidth: pngSize?.width,
    pngHeight: pngSize?.height,
    pngBoundsAbnormal,
    fatalCount,
    warnings,
    classification: fatalCount === 0 && warnings.length === 0
      ? "pass"
      : rendererWarnings.length >= modelInputWarnings.length ? "renderer-execution" : "model-input",
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

export async function renderDrawioXmlToPngDataUri(input: { xml: string; repoRoot?: string; title?: string }) {
  const repoRoot = input.repoRoot ?? resolve(join(import.meta.dir, ".."))
  const adapterPath = join(repoRoot, "media", "vendor", "drawio", "adapter.html")
  if (!existsSync(adapterPath)) throw new Error(`Missing vendored draw.io adapter: ${adapterPath}`)
  const chromePath = findChrome()
  if (!chromePath) throw new Error("No Chrome executable found. Set CHROME_PATH or install Chrome/Chromium to render draw.io PNG previews.")

  const tempRoot = await mkdtemp(join(tmpdir(), "chipmate-drawio-visual-"))
  try {
    const smokePath = join(tempRoot, "render.html")
    const userDataDir = join(tempRoot, "chrome-profile")
    const adapterUri = `${pathToFileURL(adapterPath).href}?offline=1&local=1`
    await writeFile(smokePath, renderHtml(adapterUri, input.xml))
    const dataUri = await runChromeDrawioRender({
      chromePath,
      userDataDir,
      pageUrl: pathToFileURL(smokePath).href,
    })
    decodeDrawioPngDataUri(dataUri, 50 * 1024 * 1024)
    return dataUri
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

export async function renderMermaidToPngDataUri(input: { source: string; repoRoot?: string }) {
  const repoRoot = input.repoRoot ?? resolve(join(import.meta.dir, ".."))
  const mermaidPath = join(repoRoot, "node_modules", "mermaid", "dist", "mermaid.esm.min.mjs")
  if (!existsSync(mermaidPath)) throw new Error(`Missing local Mermaid runtime: ${mermaidPath}`)
  const chromePath = findChrome()
  if (!chromePath) throw new Error("No Chrome executable found. Set CHROME_PATH or install Chrome/Chromium to render Mermaid PNG previews.")

  const tempRoot = await mkdtemp(join(tmpdir(), "chipmate-mermaid-visual-"))
  try {
    const pagePath = join(tempRoot, "render-mermaid.html")
    const userDataDir = join(tempRoot, "chrome-profile")
    await writeFile(pagePath, renderMermaidHtml(pathToFileURL(mermaidPath).href, input.source))
    const dataUri = await runChromeMermaidRender({
      chromePath,
      userDataDir,
      pageUrl: pathToFileURL(pagePath).href,
    })
    decodeDrawioPngDataUri(dataUri, 50 * 1024 * 1024)
    return dataUri
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}

async function runChromeMermaidRender(input: { chromePath: string; userDataDir: string; pageUrl: string }) {
  const chrome = spawn(input.chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--allow-file-access-from-files",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${input.userDataDir}`,
    "about:blank",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stderr = ""
  let stdout = ""
  chrome.stderr.setEncoding("utf8")
  chrome.stdout.setEncoding("utf8")
  chrome.stderr.on("data", (chunk) => { stderr += String(chunk) })
  chrome.stdout.on("data", (chunk) => { stdout += String(chunk) })
  try {
    const wsUrl = await waitForDevtoolsWsUrl(chrome, () => `${stderr}\n${stdout}`)
    const cdp = await ChromeCdpConnection.open(wsUrl)
    try {
      const target = await cdp.send<{ targetId: string }>("Target.createTarget", { url: input.pageUrl })
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true })
      const sessionId = attached.sessionId
      await cdp.send("Runtime.enable", {}, sessionId)
      await cdp.send("Page.enable", {}, sessionId)
      const deadline = Date.now() + 45000
      while (Date.now() < deadline) {
        const status = await evaluateString(cdp, sessionId, "document.body.getAttribute('data-status') || 'pending'")
        const text = await evaluateString(cdp, sessionId, "document.body.textContent || ''")
        if (status === "ok") {
          const width = Math.min(12000, Math.max(64, await evaluateNumber(cdp, sessionId, "Math.ceil(document.documentElement.scrollWidth || document.body.scrollWidth || 800)")))
          const height = Math.min(12000, Math.max(64, await evaluateNumber(cdp, sessionId, "Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 600)")))
          await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false }, sessionId)
          const screenshot = await cdp.send<{ data: string }>("Page.captureScreenshot", {
            format: "png",
            fromSurface: true,
            clip: { x: 0, y: 0, width, height, scale: 1 },
          }, sessionId)
          return `data:image/png;base64,${screenshot.data}`
        }
        if (status === "error" || status === "timeout") {
          throw new Error(`Chrome Mermaid render failed status=${status}: ${bounded(text)}`)
        }
        await delay(250)
      }
      throw new Error(`Chrome Mermaid render timed out.\n${bounded(stderr || stdout)}`)
    } finally {
      await cdp.close().catch(() => undefined)
    }
  } finally {
    await terminateChrome(chrome)
  }
}

async function runChromeDrawioRender(input: { chromePath: string; userDataDir: string; pageUrl: string }) {
  const chrome = spawn(input.chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--allow-file-access-from-files",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${input.userDataDir}`,
    "about:blank",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stderr = ""
  let stdout = ""
  chrome.stderr.setEncoding("utf8")
  chrome.stdout.setEncoding("utf8")
  chrome.stderr.on("data", (chunk) => { stderr += String(chunk) })
  chrome.stdout.on("data", (chunk) => { stdout += String(chunk) })
  try {
    const wsUrl = await waitForDevtoolsWsUrl(chrome, () => `${stderr}\n${stdout}`)
    const cdp = await ChromeCdpConnection.open(wsUrl)
    try {
      const target = await cdp.send<{ targetId: string }>("Target.createTarget", { url: input.pageUrl })
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true })
      const sessionId = attached.sessionId
      await cdp.send("Runtime.enable", {}, sessionId)
      const deadline = Date.now() + 45000
      while (Date.now() < deadline) {
        const status = await evaluateString(cdp, sessionId, "document.body.getAttribute('data-status') || 'pending'")
        const text = await evaluateString(cdp, sessionId, "document.body.textContent || ''")
        if (status === "ok") return dataUriFromDump(text)
        if (status === "error" || status === "timeout" || status === "bad-export") {
          throw new Error(`Chrome draw.io render failed status=${status}: ${bounded(text)}`)
        }
        await delay(250)
      }
      throw new Error(`Chrome draw.io render timed out.\n${bounded(stderr || stdout)}`)
    } finally {
      await cdp.close().catch(() => undefined)
    }
  } finally {
    await terminateChrome(chrome)
  }
}

async function waitForDevtoolsWsUrl(chrome: ChildProcessWithoutNullStreams, output: () => string) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    const text = output()
    const match = /DevTools listening on (ws:\/\/[^\s]+)/.exec(text)
    if (match?.[1]) return match[1]
    if (chrome.exitCode !== null) throw new Error(`Chrome exited before DevTools was ready.\n${bounded(text)}`)
    await delay(100)
  }
  throw new Error(`Timed out waiting for Chrome DevTools endpoint.\n${bounded(output())}`)
}

async function evaluateString(cdp: ChromeCdpConnection, sessionId: string, expression: string) {
  const result = await cdp.send<{ result?: { value?: unknown } }>("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: false,
  }, sessionId)
  return String(result.result?.value ?? "")
}

async function evaluateNumber(cdp: ChromeCdpConnection, sessionId: string, expression: string) {
  const value = Number(await evaluateString(cdp, sessionId, expression))
  return Number.isFinite(value) ? value : 0
}

async function terminateChrome(chrome: ChildProcessWithoutNullStreams) {
  const waitForClose = new Promise<void>((resolveClose) => {
    if (chrome.exitCode !== null) {
      resolveClose()
      return
    }
    chrome.once("close", () => resolveClose())
  })
  if (chrome.exitCode === null) chrome.kill("SIGTERM")
  await Promise.race([waitForClose, delay(2000)])
  if (chrome.exitCode === null) {
    chrome.kill("SIGKILL")
    await Promise.race([waitForClose, delay(1000)])
  }
  chrome.stdout.destroy()
  chrome.stderr.destroy()
}

class ChromeCdpConnection {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()

  private constructor(private readonly socket: WebSocket) {
    this.socket.addEventListener("message", (event) => this.handleMessage(String(event.data)))
    this.socket.addEventListener("error", () => this.rejectAll(new Error("Chrome DevTools websocket error.")))
    this.socket.addEventListener("close", () => this.rejectAll(new Error("Chrome DevTools websocket closed.")))
  }

  static async open(url: string) {
    const socket = new WebSocket(url)
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timeout = setTimeout(() => rejectOpen(new Error("Timed out connecting to Chrome DevTools websocket.")), 10000)
      socket.addEventListener("open", () => {
        clearTimeout(timeout)
        resolveOpen()
      }, { once: true })
      socket.addEventListener("error", () => {
        clearTimeout(timeout)
        rejectOpen(new Error("Failed to connect to Chrome DevTools websocket."))
      }, { once: true })
    })
    return new ChromeCdpConnection(socket)
  }

  send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const id = this.nextId++
    const message = sessionId ? { id, method, params, sessionId } : { id, method, params }
    return new Promise<T>((resolveSend, rejectSend) => {
      this.pending.set(id, {
        resolve: (value) => resolveSend(value as T),
        reject: rejectSend,
      })
      this.socket.send(JSON.stringify(message))
    })
  }

  async close() {
    if (this.socket.readyState === WebSocket.OPEN) {
      await this.send("Browser.close").catch(() => undefined)
    }
    if (this.socket.readyState === WebSocket.CLOSED) return
    await new Promise<void>((resolveClose) => {
      const timeout = setTimeout(resolveClose, 500)
      this.socket.addEventListener("close", () => {
        clearTimeout(timeout)
        resolveClose()
      }, { once: true })
      this.socket.close()
    })
    this.rejectAll(new Error("Chrome DevTools websocket closed."))
  }

  private handleMessage(data: string) {
    const message = JSON.parse(data) as { id?: number; result?: unknown; error?: { message?: string } }
    if (message.id === undefined) return
    const pending = this.pending.get(message.id)
    if (!pending) return
    this.pending.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message || "Chrome DevTools command failed."))
    else pending.resolve(message.result)
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
  }
}

export function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "google-chrome",
    "google-chrome-stable",
    "chromium",
    "chromium-browser",
  ].filter(Boolean) as string[]
  for (const candidate of candidates) {
    if (candidate.includes("/") && existsSync(candidate)) return candidate
    if (!candidate.includes("/")) {
      const result = spawnSync("which", [candidate], { encoding: "utf8" })
      if (result.status === 0 && result.stdout.trim()) return result.stdout.trim()
    }
  }
  return ""
}

async function reviewDiagramWithVision(input: {
  evalCase: DrawioVisualEvalCase
  generated: DrawioGeneratedDiagram
  metrics: DrawioVisualMetrics
  dataUri: string
}): Promise<VisionReview> {
  const endpoint = visionEndpoint()
  const apiKey = process.env.CHIPMATE_DIAGRAM_VISION_API_KEY || ""
  const model = process.env.CHIPMATE_DIAGRAM_VISION_MODEL || ""
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: "You are a strict engineering diagram visual QA reviewer. Return only valid JSON.",
        },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: visionPrompt(input.evalCase, input.generated, input.metrics),
            },
            {
              type: "image_url",
              image_url: { url: input.dataUri },
            },
          ],
        },
      ],
    }),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Vision review failed: HTTP ${response.status} ${bounded(text)}`)
  }
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> }
  const content = payload.choices?.[0]?.message?.content
  if (!content) throw new Error("Vision review response did not contain message content.")
  return normalizeVisionReview(JSON.parse(content) as Partial<VisionReview>)
}

function deterministicReview(metrics: DrawioVisualMetrics, failUnder = DEFAULT_FAIL_UNDER): VisionReview {
  const passThroughDensity = metrics.edgeCount ? metrics.edgePassThroughCount / metrics.edgeCount : 0
  const intersectionDensity = metrics.edgeCount ? metrics.edgeIntersectionCount / metrics.edgeCount : 0
  const containerPassDensity = metrics.edgeCount ? metrics.edgeContainerPassThroughCount / metrics.edgeCount : 0
  const overlapDensity = metrics.edgeCount ? metrics.edgeCollinearOverlapCount / metrics.edgeCount : 0
  const penalty = metrics.fatalCount * 2 +
    Math.min(2, metrics.nodeOverlapCount) +
    Math.min(2, metrics.containerOverlapCount) +
    Math.min(3, metrics.edgeCollinearOverlapCount) +
    Math.min(3, metrics.edgeIntersectionCount * 0.5) +
    Math.min(2, metrics.unnecessaryBendCount * 0.4) +
    Math.min(2, metrics.shortJogCount * 0.4) +
    Math.min(3, metrics.edgePassThroughCount * 0.35) +
    Math.min(3, metrics.edgeContainerPassThroughCount * 0.5) +
    Math.min(3, metrics.busFanInAmbiguityCount * 0.7) +
    Math.min(3, metrics.busFanOutAmbiguityCount * 0.7) +
    Math.min(3, metrics.pseudoSelfLoopRiskCount * 0.8) +
    Math.min(2, metrics.sharedPortOverlapCount * 0.5) +
    Math.min(2, metrics.busTrunkAlignmentRiskCount * 0.7) +
    Math.min(2, metrics.unexplainedHeavyBusCount * 0.35) +
    (passThroughDensity > 0 ? 2 : 0) +
    (containerPassDensity > 0 ? 2 : 0) +
    Math.min(2, metrics.textOverflowRiskCount * 0.5) +
    Math.min(2, metrics.narrowContainerLabelRiskCount * 0.6) +
    Math.min(2, metrics.nodeContainerBoundaryViolationCount * 0.5)
  const fatalGeometryCount = metrics.edgeCollinearOverlapCount +
    metrics.edgeIntersectionCount +
    metrics.unnecessaryBendCount +
    metrics.shortJogCount +
    metrics.edgePassThroughCount +
    metrics.edgeContainerPassThroughCount +
    metrics.disconnectedEdgeEndpointCount +
    metrics.legendOverlapCount +
    metrics.containerOverlapCount +
    metrics.narrowContainerLabelRiskCount +
    metrics.nodeContainerBoundaryViolationCount +
    metrics.nodeUnownedContainerOverlapCount +
    metrics.busFanInAmbiguityCount +
    metrics.busFanOutAmbiguityCount +
    metrics.pseudoSelfLoopRiskCount +
    metrics.sharedPortOverlapCount +
    metrics.busTrunkAlignmentRiskCount +
    metrics.unexplainedHeavyBusCount
  const rawScore = Math.max(1, Math.min(10, 10 - penalty))
  const score = fatalGeometryCount > 0
    ? Math.min(5.5, rawScore)
    : metrics.fatalCount > 0 ? Math.min(6, rawScore) : rawScore
  const rawEdgeClutterScore = Math.max(1, 10 - metrics.edgeCollinearOverlapCount - metrics.unnecessaryBendCount - metrics.shortJogCount - metrics.busFanInAmbiguityCount - metrics.busFanOutAmbiguityCount - metrics.pseudoSelfLoopRiskCount - Math.ceil(metrics.edgeIntersectionCount * 0.5) - Math.ceil(passThroughDensity * 10) - Math.ceil(containerPassDensity * 10) - Math.ceil(overlapDensity * 5))
  const edgeClutterScore = fatalGeometryCount > 0 ? Math.min(5.5, rawEdgeClutterScore) : rawEdgeClutterScore
  return {
    readabilityScore: score,
    flowClarityScore: Math.max(1, score - (metrics.mainGraphOffsetRatio > 0.3 ? 1 : 0)),
    textFitScore: Math.max(1, 10 - metrics.textOverflowRiskCount - metrics.narrowContainerLabelRiskCount - metrics.nodeContainerBoundaryViolationCount),
    edgeClutterScore,
    legendUsefulnessScore: metrics.legendGenerated ? (metrics.legendOverwide ? 5 : 8) : 7,
    deliveryReady: metrics.fatalCount === 0 && score >= failUnder && edgeClutterScore >= failUnder,
    topIssues: metrics.warnings.slice(0, 6),
    suggestedGenericFixes: genericFixesForMetrics(metrics),
  }
}

function visionPrompt(evalCase: DrawioVisualEvalCase, generated: DrawioGeneratedDiagram, metrics: DrawioVisualMetrics) {
  return [
    "Review this draw.io PNG as a deliverable engineering diagram.",
    "Do not judge whether the business semantics are correct; assume the model-authored DiagramIR/VisualPlan is the source of semantic truth.",
    "Judge whether the renderer executed the VisualPlan clearly: readable main path, text fits, edges do not clutter, legend is useful, bounds are centered.",
    "Return JSON with exactly these keys: readabilityScore, flowClarityScore, textFitScore, edgeClutterScore, legendUsefulnessScore, deliveryReady, topIssues, suggestedGenericFixes.",
    "Scores are 1-10. deliveryReady is true only if the PNG can be handed to an engineer without explaining visual defects.",
    `Case: ${evalCase.id} / ${evalCase.category} / ${evalCase.title}`,
    `Renderer focus: ${evalCase.expectedRendererFocus.join(", ")}`,
    `Metrics: ${JSON.stringify(metrics)}`,
    `Warnings: ${generated.warnings.slice(0, 20).join(" | ")}`,
  ].join("\n")
}

function simpleBusinessFlowCase(): DrawioVisualEvalCase {
  const main = [
    ["intake", "接收 MP 请求\nmp_request_intake()", "action"],
    ["decode", "解析请求类型\nREAD / WRITE / ERASE / RECLAIM", "decision"],
    ["resource-check", "检查资源窗口\nqueue / token / block budget", "decision"],
    ["load-context", "加载上下文\nload_task_context()", "action"],
    ["select-window", "选择处理窗口\nselect_active_window()", "decision"],
    ["prepare-plan", "生成业务计划\nbuild_operation_plan()", "action"],
    ["lock-region", "锁定目标区域\nlock_target_region()", "action"],
    ["dispatch-worker", "分派 Worker\npost_worker_job()", "action"],
    ["wait-worker", "等待 Worker 完成\nWAIT_WORKER_DONE", "state"],
    ["commit-result", "提交结果\ncommit_result()", "action"],
    ["notify-host", "通知 Host\ncomplete_request()", "action"],
    ["cleanup", "清理上下文\nrelease_context()", "action"],
  ] as const
  const side = [
    ["retry-budget", "重试预算检查", "decision"],
    ["defer", "延迟处理\nDEFER_QUEUE", "action"],
    ["rollback", "回滚部分提交\nrollback_partial()", "action"],
    ["bad-block", "坏块/不可恢复错误", "action"],
    ["telemetry", "记录遥测与覆盖表", "action"],
    ["throttle", "限流保护\nTHROTTLE", "action"],
    ["resume", "恢复挂起请求", "action"],
    ["audit", "更新审计轨迹", "action"],
  ] as const
  const primaryEdges = pairwise(main.map((item) => item[0]), "e-main", "primary", "control")
  const extraEdges = [
    edge("e-resource-defer", "resource-check", "defer", "资源不足", "exception", "event"),
    edge("e-defer-resume", "defer", "resume", "资源恢复", "feedback", "event"),
    edge("e-resume-resource", "resume", "resource-check", "重新检查", "feedback", "event"),
    edge("e-select-throttle", "select-window", "throttle", "限流触发", "exception", "event"),
    edge("e-throttle-load", "throttle", "load-context", "回到上下文加载", "feedback", "event"),
    edge("e-worker-retry", "wait-worker", "retry-budget", "worker timeout", "exception", "event"),
    edge("e-retry-dispatch", "retry-budget", "dispatch-worker", "仍可重试", "feedback", "event"),
    edge("e-retry-rollback", "retry-budget", "rollback", "重试耗尽", "exception", "event"),
    edge("e-rollback-bad", "rollback", "bad-block", "发现坏块", "exception", "event"),
    edge("e-rollback-cleanup", "rollback", "cleanup", "回滚完成", "secondary", "control"),
    edge("e-bad-telemetry", "bad-block", "telemetry", "记录错误", "secondary", "control"),
    edge("e-commit-audit", "commit-result", "audit", "记录提交证据", "secondary", "control"),
    edge("e-audit-cleanup", "audit", "cleanup", "审计完成", "secondary", "control"),
    edge("e-telemetry-cleanup", "telemetry", "cleanup", "错误收口", "secondary", "control"),
  ]
  const visualEdges: Record<string, { mode: "line" | "rail" | "legend"; rail?: "left" | "right"; marker?: string; label?: string }> = {}
  for (const edgeItem of primaryEdges) visualEdges[String(edgeItem.id)] = { mode: "line" }
  const visibleExceptionRails = new Map([
    ["e-resource-defer", "right"],
    ["e-worker-retry", "left"],
    ["e-retry-rollback", "left"],
  ])
  for (const edgeItem of extraEdges) {
    const id = String(edgeItem.id)
    const rail = visibleExceptionRails.get(id)
    visualEdges[id] = rail
      ? { mode: "rail", rail: rail as "left" | "right", marker: `[R${Object.keys(visualEdges).length}]` }
      : { mode: "legend", marker: `[${id.toUpperCase().slice(2, 5)}]`, label: String(edgeItem.label) }
  }
  const diagramIr: DiagramIr = {
    version: "diagram-ir/v1",
    title: "SSD MP 请求业务流程 - 中等密度",
    diagramType: "business-flow",
    nodes: [
      ...main.map(([id, label, role]) => node(id, label, role)),
      ...side.map(([id, label, role]) => node(id, label, role)),
    ],
    edges: [...primaryEdges, ...extraEdges],
    visualPlan: {
      layoutProfile: "business-flow",
      mainBackbone: {
        nodes: main.map((item) => item[0]),
        edges: primaryEdges.map((item) => String(item.id)),
        direction: "down",
      },
      edgePresentation: visualEdges,
      legend: {
        position: "right",
        title: "异常与证据说明",
        items: [
          { id: "retry", marker: "[R]", label: "rail 表示重试、延迟、回滚等非主链路径。" },
          { id: "evidence", marker: "[AUD]", label: "审计和遥测边进入说明区，不挤压主流程。" },
        ],
      },
    },
  }
  return caseDef("ssd-business-flow-medium", "SSD MP 请求业务流程 - 中等密度", "business-flow", diagramIr, [
    "主链居中",
    "异常 rail 不压主链",
    "右侧 legend 不撑爆画布",
  ])
}

function embeddedFsmBusinessFlowCase(): DrawioVisualEvalCase {
  const laneIds = ["entry_lane", "flush_lane", "gc_lane", "runtime_lane", "external_lane"]
  const nodes = [
    node("sys-idle", "系统空闲检测\nSYS_IDLE", "state", "entry_lane"),
    node("request-gate", "入口条件判断\nrequest_gate()", "decision", "entry_lane"),
    node("map-units", "映射 Unit 选择\nselect_map_units()", "action", "entry_lane"),
    node("flush-idle", "FLUSH_IDLE", "state", "flush_lane"),
    node("flush-prepare", "准备 Flush 参数\nflush_prepare()", "action", "flush_lane"),
    node("flush-submit", "提交 Flush 任务\nsubmit_flush_job()", "action", "flush_lane"),
    node("flush-wait", "等待 Flush 完成\nWAIT_FLUSH_DONE", "state", "flush_lane"),
    node("gc-dispatch", "GC_DISPATCH", "state", "gc_lane"),
    node("gc-select-src", "选择 Source Block\nselect_src_block()", "decision", "gc_lane"),
    node("gc-reclaim", "GC_RECLAIM", "state", "gc_lane"),
    node("gc-copy-valid", "搬移有效页\ncopy_valid_pages()", "action", "gc_lane"),
    node("gc-erase", "擦除源块\nerase_source_block()", "action", "gc_lane"),
    node("gc-update-map", "更新映射表\nupdate_mapping()", "action", "gc_lane"),
    node("runtime-idle", "RUNTIME_IDLE", "state", "runtime_lane"),
    node("runtime-run", "RUNTIME_RUN", "state", "runtime_lane"),
    node("runtime-wait-nodeq", "WAIT_NODEQ", "state", "runtime_lane"),
    node("runtime-complete", "COMPLETE", "state", "runtime_lane"),
    node("runtime-error", "ERROR_RECOVERY", "state", "runtime_lane"),
    node("folding-fsm", "外部 Folding FSM\nfolding_fsm()", "state", "external_lane"),
    node("wear-leveling", "Wear Leveling\nwear_leveling()", "action", "external_lane"),
    node("bad-block", "Bad Block 处理\nbad_block_handler()", "action", "external_lane"),
    node("notify-host", "通知 Host / Scheduler", "action", "entry_lane"),
    node("cleanup", "清理 MP 上下文", "action", "entry_lane"),
  ]
  const primary = [
    ["e-sys-gate", "sys-idle", "request-gate", "收到请求"],
    ["e-gate-map", "request-gate", "map-units", "条件满足"],
    ["e-map-flush-idle", "map-units", "flush-idle", "进入 Flush"],
    ["e-flush-prepare", "flush-idle", "flush-prepare", "准备参数"],
    ["e-flush-submit", "flush-prepare", "flush-submit", "提交"],
    ["e-flush-wait", "flush-submit", "flush-wait", "等待完成"],
    ["e-wait-dispatch", "flush-wait", "gc-dispatch", "flush done"],
    ["e-dispatch-src", "gc-dispatch", "gc-select-src", "选择源块"],
    ["e-src-reclaim", "gc-select-src", "gc-reclaim", "可回收"],
    ["e-reclaim-copy", "gc-reclaim", "gc-copy-valid", "搬移"],
    ["e-copy-erase", "gc-copy-valid", "gc-erase", "擦除"],
    ["e-erase-map", "gc-erase", "gc-update-map", "更新映射"],
    ["e-map-runtime", "gc-update-map", "runtime-idle", "唤醒运行时"],
    ["e-runtime-run", "runtime-idle", "runtime-run", "run"],
    ["e-runtime-wait", "runtime-run", "runtime-wait-nodeq", "等待队列"],
    ["e-runtime-complete", "runtime-wait-nodeq", "runtime-complete", "完成"],
    ["e-complete-notify", "runtime-complete", "notify-host", "完成通知"],
    ["e-notify-cleanup", "notify-host", "cleanup", "收口"],
  ].map(([id, source, target, label]) => edge(id, source, target, label, "primary", "control"))
  const cross = [
    edge("e-gate-defer", "request-gate", "runtime-wait-nodeq", "运行时忙", "cross-module", "event"),
    edge("e-src-folding", "gc-select-src", "folding-fsm", "需要 Folding", "cross-module", "event"),
    edge("e-folding-dispatch", "folding-fsm", "gc-dispatch", "Folding 完成", "feedback", "event"),
    edge("e-copy-error", "gc-copy-valid", "runtime-error", "搬移失败", "exception", "event"),
    edge("e-erase-bad-block", "gc-erase", "bad-block", "擦除失败", "exception", "event"),
    edge("e-bad-dispatch", "bad-block", "gc-dispatch", "标记后重选", "feedback", "event"),
    edge("e-wear-src", "wear-leveling", "gc-select-src", "磨损均衡介入", "cross-module", "event"),
    edge("e-update-wear", "gc-update-map", "wear-leveling", "更新磨损信息", "secondary", "data"),
    edge("e-runtime-error-cleanup", "runtime-error", "cleanup", "错误收口", "exception", "event"),
    edge("e-complete-dispatch", "runtime-complete", "gc-dispatch", "下一窗口", "feedback", "event"),
    edge("e-wait-flush-loop", "flush-wait", "flush-submit", "轮询重提", "feedback", "event"),
    edge("e-nodeq-map", "runtime-wait-nodeq", "map-units", "队列恢复", "feedback", "event"),
  ]
  const edgePresentation: Record<string, { mode: "line" | "rail" | "legend"; rail?: "left" | "right"; marker?: string; label?: string }> = {}
  for (const item of primary) edgePresentation[String(item.id)] = { mode: "line" }
  const visibleCrossRails = new Map([
    ["e-src-folding", "right"],
    ["e-copy-error", "left"],
    ["e-complete-dispatch", "left"],
  ])
  for (const [index, item] of cross.entries()) {
    const id = String(item.id)
    const rail = visibleCrossRails.get(id)
    edgePresentation[id] = rail
      ? { mode: "rail", rail: rail as "left" | "right", marker: `[R${index + 1}]` }
      : { mode: "legend", marker: `[E${index + 1}]`, label: String(item.label) }
  }
  const diagramIr: DiagramIr = {
    version: "diagram-ir/v1",
    title: "SSD MP/GC/Flush 嵌入式业务流程 - 高密度",
    diagramType: "business-flow",
    semanticHints: {
      primaryPerspective: "business-process",
      containsStateMachines: true,
      stateMachineCount: 2,
      processPhases: ["入口", "Flush", "GC", "Runtime", "外部协作", "完成"],
    },
    lanes: laneIds.map((id) => lane(id, id.replace(/_/g, " "))),
    nodes,
    edges: [...primary, ...cross],
    visualPlan: {
      layoutProfile: "embedded-fsm-flow",
      mainBackbone: {
        nodes: ["sys-idle", "request-gate", "map-units", "flush-idle", "flush-prepare", "flush-submit", "flush-wait", "gc-dispatch", "gc-select-src", "gc-reclaim", "gc-copy-valid", "gc-erase", "gc-update-map", "runtime-idle", "runtime-run", "runtime-wait-nodeq", "runtime-complete", "notify-host", "cleanup"],
        edges: primary.map((item) => String(item.id)),
        direction: "down",
      },
      edgePresentation,
      legend: {
        position: "right",
        title: "边说明",
        items: [
          { id: "legend-rail", marker: "[R]", label: "rail 表示模型标注的跨层/回边/异常边，必须绕开主链。" },
          { id: "legend-evidence", marker: "[E]", label: "legend 边是模型决定外置的低频解释性证据，不应重复截断节点名。" },
        ],
      },
    },
  }
  return caseDef("embedded-fsm-business-flow", "SSD MP/GC/Flush 嵌入式业务流程 - 高密度", "business-flow", diagramIr, [
    "weak-band 背景分区跟随节点",
    "模型标注 rail 生成 bend points",
    "legend 是解释性内容而非截断节点名",
  ])
}

function stateMachineCase(): DrawioVisualEvalCase {
  const states = [
    ["power-on", "POWER_ON\n上电入口"],
    ["idle", "IDLE\n等待触发"],
    ["scan-queue", "SCAN_QUEUE\n扫描任务队列"],
    ["select-job", "SELECT_JOB\n选择任务"],
    ["prepare", "PREPARE\n准备上下文"],
    ["lock", "LOCK_RESOURCE\n锁资源"],
    ["issue", "ISSUE_CMD\n下发命令"],
    ["wait-dma", "WAIT_DMA\n等待 DMA"],
    ["wait-nand", "WAIT_NAND\n等待介质"],
    ["verify", "VERIFY\n校验结果"],
    ["update-map", "UPDATE_MAP\n更新映射"],
    ["flush-meta", "FLUSH_META\n刷元数据"],
    ["notify", "NOTIFY\n完成通知"],
    ["hibernate", "HIBERNATE\n低功耗"],
    ["retry", "RETRY\n重试"],
    ["recover", "RECOVER\n错误恢复"],
    ["failed", "FAILED\n失败终态"],
    ["done", "DONE\n结束"],
  ] as const
  const primaryIds = ["power-on", "idle", "scan-queue", "select-job", "prepare", "lock", "issue", "wait-dma", "wait-nand", "verify", "update-map", "flush-meta", "notify", "done"]
  const primaryEdges = pairwise(primaryIds, "e-sm-main", "primary", "transition")
  const extraEdges = [
    edge("e-no-job", "scan-queue", "idle", "no job", "feedback", "transition"),
    edge("e-low-power", "idle", "hibernate", "idle timeout", "secondary", "transition"),
    edge("e-wakeup", "hibernate", "scan-queue", "wake event", "feedback", "transition"),
    edge("e-lock-fail", "lock", "retry", "lock busy", "exception", "transition"),
    edge("e-retry-prepare", "retry", "prepare", "retry budget ok", "feedback", "transition"),
    edge("e-retry-failed", "retry", "failed", "retry exhausted", "exception", "transition"),
    edge("e-dma-timeout", "wait-dma", "recover", "DMA timeout", "exception", "transition"),
    edge("e-nand-error", "wait-nand", "recover", "NAND status error", "exception", "transition"),
    edge("e-verify-fail", "verify", "retry", "verify mismatch", "exception", "transition"),
    edge("e-recover-issue", "recover", "issue", "re-issue command", "feedback", "transition"),
    edge("e-recover-failed", "recover", "failed", "fatal error", "exception", "transition"),
    edge("e-meta-busy", "flush-meta", "wait-dma", "metadata DMA busy", "feedback", "transition"),
  ]
  const edgePresentation: Record<string, { mode: "line" | "rail" | "legend"; rail?: "left" | "right"; marker?: string; label?: string }> = {}
  for (const item of primaryEdges) edgePresentation[String(item.id)] = { mode: "line" }
  const visibleStateRails = new Map([
    ["e-lock-fail", "left"],
    ["e-dma-timeout", "right"],
    ["e-recover-issue", "right"],
  ])
  for (const [index, item] of extraEdges.entries()) {
    const id = String(item.id)
    const rail = visibleStateRails.get(id)
    edgePresentation[id] = rail
      ? { mode: "rail", rail: rail as "left" | "right", marker: `[S${index + 1}]` }
      : { mode: "legend", marker: `[S${index + 1}]`, label: String(item.label) }
  }
  const diagramIr: DiagramIr = {
    version: "diagram-ir/v1",
    title: "SSD 控制器运行状态机 - 高密度",
    diagramType: "state-machine",
    nodes: states.map(([id, label]) => node(id, label, "state")),
    edges: [...primaryEdges, ...extraEdges],
    visualPlan: {
      layoutProfile: "state-machine",
      mainBackbone: {
        nodes: primaryIds,
        edges: primaryEdges.map((item) => String(item.id)),
        direction: "down",
      },
      edgePresentation,
      legend: {
        position: "right",
        title: "异常迁移",
        items: [
          { id: "retry", marker: "[S]", label: "非主链迁移由模型标成 rail 或 legend；渲染器只执行这些结构化决策。" },
          { id: "recover", marker: "[REC]", label: "recover/retry/hibernate 不应压住主状态链。" },
        ],
      },
    },
  }
  return caseDef("state-machine", "SSD 控制器运行状态机 - 高密度", "state-machine", diagramIr, [
    "状态节点清晰",
    "异常迁移不压主迁移链",
    "状态名和说明不溢出",
  ])
}

function socArchitectureCase(): DrawioVisualEvalCase {
  const regions = [
    region("display", "Display / Host Interface"),
    region("front_end", "Front End"),
    region("slice0", "Slice 0"),
    region("slice1", "Slice 1"),
    region("shared", "Slice Common"),
    region("unslice", "Unslice / Fixed Function"),
    region("memory", "Memory Subsystem"),
    region("fabric", "Fabric / GTI"),
  ]
  const modules = [
    node("ddi0", "DDI Port 0", "port", "display"),
    node("ddi1", "DDI Port 1", "port", "display"),
    node("host", "Host Command Queue", "module", "front_end"),
    node("parser", "Command Parser", "module", "front_end"),
    node("thread-dispatch", "Thread Dispatcher", "module", "front_end"),
    node("slice0-eu0", "EU Array 0\n8 lanes", "module", "slice0"),
    node("slice0-sampler", "3D Sampler", "module", "slice0"),
    node("slice0-dataport", "Data Port", "module", "slice0"),
    node("slice0-tex", "Texture Cache", "module", "slice0"),
    node("slice1-eu0", "EU Array 1\n8 lanes", "module", "slice1"),
    node("slice1-sampler", "Media Sampler", "module", "slice1"),
    node("slice1-dataport", "Data Port", "module", "slice1"),
    node("slice1-tex", "Texture Cache", "module", "slice1"),
    node("l3", "L3 Cache", "module", "shared"),
    node("pixel", "Pixel Ops", "module", "shared"),
    node("raster", "Rasterizer / Depth", "module", "shared"),
    node("vf", "Vertex Fetch", "module", "unslice"),
    node("vs", "Vertex Shader", "module", "unslice"),
    node("hs", "Hull Shader", "module", "unslice"),
    node("te", "Tessellator", "module", "unslice"),
    node("ds", "Domain Shader", "module", "unslice"),
    node("gs", "Geometry Shader", "module", "unslice"),
    node("clip", "Clip / Setup", "module", "unslice"),
    node("streamout", "Stream Out", "module", "unslice"),
    node("fixed-video", "Video Quality Engine", "module", "unslice"),
    node("codec", "Multi Format Codec", "module", "unslice"),
    node("l2", "L2 Cache\n512 KiB", "module", "memory"),
    node("llc", "LLC / System Cache", "module", "memory"),
    node("ddr", "DDR / NAND Interface", "port", "memory"),
    node("gti", "Graphics Technology Interface", "port", "fabric"),
    node("fabric-arb", "Fabric Arbiter", "module", "fabric"),
    node("power", "Power / Clock Island", "module", "fabric"),
  ].map((item) => ({ ...item, keepVisible: true }))
  const socEdges = [
    edge("e-host-parser", "host", "parser", "commands", "primary", "control"),
    edge("e-parser-dispatch", "parser", "thread-dispatch", "threads", "primary", "control"),
    edge("e-dispatch-s0", "thread-dispatch", "slice0-eu0", "EU work", "primary", "data"),
    edge("e-dispatch-s1", "thread-dispatch", "slice1-eu0", "EU work", "primary", "data"),
    edge("e-s0-sampler", "slice0-eu0", "slice0-sampler", "sample", "secondary", "data"),
    edge("e-s0-tex", "slice0-sampler", "slice0-tex", "tex", "secondary", "data"),
    edge("e-s0-dp", "slice0-eu0", "slice0-dataport", "load/store", "primary", "bus"),
    edge("e-s1-sampler", "slice1-eu0", "slice1-sampler", "sample", "secondary", "data"),
    edge("e-s1-tex", "slice1-sampler", "slice1-tex", "tex", "secondary", "data"),
    edge("e-s1-dp", "slice1-eu0", "slice1-dataport", "load/store", "primary", "bus"),
    edge("e-dp0-l3", "slice0-dataport", "l3", "dataport", "primary", "bus"),
    edge("e-dp1-l3", "slice1-dataport", "l3", "dataport", "primary", "bus"),
    edge("e-l3-l2", "l3", "l2", "cache miss/fill", "primary", "bus"),
    edge("e-l2-llc", "l2", "llc", "system fill", "primary", "bus"),
    edge("e-llc-ddr", "llc", "ddr", "memory channel", "primary", "bus"),
    edge("e-ddi-pixel", "ddi0", "pixel", "display pipe", "cross-module", "data"),
    edge("e-pixel-raster", "pixel", "raster", "render backend", "primary", "data"),
    edge("e-raster-l3", "raster", "l3", "depth/color", "primary", "bus"),
    edge("e-vf-vs", "vf", "vs", "vertices", "primary", "control"),
    edge("e-vs-hs", "vs", "hs", "optional stage", "secondary", "control"),
    edge("e-hs-te", "hs", "te", "patch", "secondary", "control"),
    edge("e-te-ds", "te", "ds", "domain", "secondary", "control"),
    edge("e-ds-gs", "ds", "gs", "geometry", "secondary", "control"),
    edge("e-gs-clip", "gs", "clip", "setup", "primary", "control"),
    edge("e-clip-raster", "clip", "raster", "raster input", "primary", "data"),
    edge("e-stream-l3", "streamout", "l3", "stream data", "secondary", "bus"),
    edge("e-video-l3", "fixed-video", "l3", "media reads", "secondary", "bus"),
    edge("e-codec-l3", "codec", "l3", "codec DMA", "secondary", "bus"),
    edge("e-gti-fabric", "gti", "fabric-arb", "external fabric", "primary", "bus"),
    edge("e-fabric-l2", "fabric-arb", "l2", "coherent access", "primary", "bus"),
    edge("e-power-s0", "power", "slice0-eu0", "clock gate", "secondary", "control"),
    edge("e-power-s1", "power", "slice1-eu0", "clock gate", "secondary", "control"),
  ]
  const visibleSocLines = new Set(["e-host-parser", "e-parser-dispatch", "e-dispatch-s0", "e-s0-dp", "e-dp0-l3", "e-l3-l2", "e-l2-llc", "e-llc-ddr"])
  const visibleSocRails = new Map([
    ["e-dispatch-s1", "top"],
    ["e-s1-dp", "bottom"],
    ["e-gti-fabric", "top"],
    ["e-fabric-l2", "bottom"],
  ])
  const edgePresentation = Object.fromEntries(socEdges.map((item, index) => {
    const id = String(item.id)
    const rail = visibleSocRails.get(id)
    return [
      id,
      visibleSocLines.has(id)
        ? { mode: "line" as const }
        : rail
          ? { mode: "rail" as const, rail: rail as "top" | "bottom", marker: `[B${index + 1}]` }
          : { mode: "legend" as const, marker: `[I${index + 1}]`, label: String(item.label) },
    ]
  }))
  const diagramIr: DiagramIr = {
    version: "diagram-ir/v1",
    title: "复杂 SoC / GPU Slice 数据路径框图",
    diagramType: "soc-block",
    regions,
    nodes: modules,
    edges: socEdges,
    visualPlan: {
      layoutProfile: "soc-block",
      mainBackbone: {
        nodes: ["host", "parser", "thread-dispatch", "slice0-eu0", "slice0-dataport", "l3", "l2", "llc", "ddr"],
        edges: ["e-host-parser", "e-parser-dispatch", "e-dispatch-s0", "e-s0-dp", "e-dp0-l3", "e-l3-l2", "e-l2-llc", "e-llc-ddr"],
        direction: "right",
      },
      edgePresentation,
      buses: [
        {
          id: "soc-architecture-l2-ingress-bus",
          label: "L2 ingress bus",
          edges: ["e-l3-l2", "e-fabric-l2"],
          direction: "right",
          trunk: {
            orientation: "vertical",
            side: "left",
          },
        },
      ],
      legend: {
        position: "bottom",
        title: "接口说明",
        items: [
          { id: "bus", label: "bus/data/control 的语义由模型在 edgeKind/pathRole 中给出；渲染器只画结构化连接。" },
          { id: "region", label: "region 表达芯片区域边界，不能被当成业务流程节点。" },
        ],
      },
    },
  }
  return caseDef("soc-architecture-block", "复杂 SoC / GPU Slice 数据路径框图", "soc-block", diagramIr, [
    "强容器结构不漂移",
    "模块阵列和缓存路径清晰",
    "底部 legend 不推偏主图",
  ])
}

function socGpuSliceReferenceCase(): DrawioVisualEvalCase {
  const regions = [
    region("display", "Display"),
    region("media", "Media Fixed-Function"),
    region("slice", "Slice"),
    region("slice-common", "Slice Common"),
    region("unslice", "Unslice"),
    region("fixed-pipe", "Fixed-Function Pipeline"),
    region("gtd", "Global Thread Dispatcher"),
    region("gti", "Graphics Technology Interface"),
  ]
  const modules = [
    node("ddi-a", "DDI Port A", "port", "display"),
    node("ddi-b", "DDI Port B", "port", "display"),
    node("display-pipe", "Display Pipe", "module", "display"),
    node("display-enc", "Display Encoders", "module", "display"),
    node("sfc", "Scaler Format\nConverter", "module", "media"),
    node("vqe", "Video Quality\nEngine", "module", "media"),
    node("mfx", "Multi-Format\nCodec", "module", "media"),
    ...["0", "1", "2"].flatMap((slice) => [
      node(`subs${slice}-l1`, `L1 IC$`, "module", "slice"),
      node(`subs${slice}-eu0`, "EU", "module", "slice"),
      node(`subs${slice}-eu1`, "EU", "module", "slice"),
      node(`subs${slice}-sampler`, "3D Sampler\nMedia Sampler", "module", "slice"),
      node(`subs${slice}-dataport`, "Data Port", "module", "slice"),
      node(`subs${slice}-tex`, "Tex$", "module", "slice"),
    ]),
    node("l3", "L3$", "module", "slice-common"),
    node("pixel", "Pixel Ops", "module", "slice-common"),
    node("render-depth", "Render / Depth", "module", "slice-common"),
    node("raster", "Rasterizer / Depth", "module", "slice-common"),
    node("cs", "Command Streamer", "module", "unslice"),
    node("vfe", "Video Front End", "module", "unslice"),
    node("vf", "Vertex Fetch", "module", "fixed-pipe"),
    node("vs", "Vertex Shader", "module", "fixed-pipe"),
    node("hs", "Hull Shader", "module", "fixed-pipe"),
    node("te", "Tessellator", "module", "fixed-pipe"),
    node("ds", "Domain Shader", "module", "fixed-pipe"),
    node("gs", "Geometry Shader", "module", "fixed-pipe"),
    node("so", "Stream-Out", "module", "fixed-pipe"),
    node("clip", "Clip / Setup", "module", "fixed-pipe"),
    node("dispatcher", "Thread Dispatcher", "module", "gtd"),
    node("gti-port", "GTI Port", "port", "gti"),
    node("fabric", "To Fabric", "port", "gti"),
  ].map((item) => ({ ...item, keepVisible: true }))
  const edges = [
    edge("e-cs-vfe", "cs", "vfe", "command", "primary", "control"),
    edge("e-vfe-vf", "vfe", "vf", "front-end", "primary", "control"),
    edge("e-vf-vs", "vf", "vs", "vertices", "primary", "control"),
    edge("e-vs-hs", "vs", "hs", "optional", "secondary", "control"),
    edge("e-hs-te", "hs", "te", "patch", "secondary", "control"),
    edge("e-te-ds", "te", "ds", "domain", "secondary", "control"),
    edge("e-ds-gs", "ds", "gs", "geometry", "secondary", "control"),
    edge("e-gs-so", "gs", "so", "stream", "secondary", "data"),
    edge("e-so-clip", "so", "clip", "setup", "primary", "control"),
    edge("e-clip-raster", "clip", "raster", "raster input", "primary", "data"),
    edge("e-raster-pixel", "raster", "render-depth", "fragments", "primary", "data"),
    edge("e-pixel-render", "render-depth", "pixel", "render ops", "primary", "data"),
    edge("e-render-l3", "pixel", "l3", "color/depth", "primary", "bus"),
    edge("e-cs-dispatch", "cs", "dispatcher", "dispatch", "primary", "control"),
    edge("e-dispatch-s0", "dispatcher", "subs0-eu0", "threads", "primary", "control"),
    edge("e-s0-eu", "subs0-eu0", "subs0-eu1", "SIMD lanes", "primary", "data"),
    edge("e-s0-sampler", "subs0-eu1", "subs0-sampler", "sample", "primary", "data"),
    edge("e-s0-tex", "subs0-sampler", "subs0-tex", "tex", "primary", "data"),
    edge("e-s0-dp", "subs0-eu1", "subs0-dataport", "load/store", "primary", "bus"),
    edge("e-s0-l3", "subs0-dataport", "l3", "cache", "primary", "bus"),
    edge("e-l3-gti", "l3", "gti-port", "fabric req", "primary", "bus"),
    edge("e-gti-fabric", "gti-port", "fabric", "external", "primary", "bus"),
    edge("e-display-l3", "l3", "display-pipe", "scanout", "cross-module", "data"),
    edge("e-display-ddi", "display-pipe", "ddi-a", "display", "primary", "data"),
    edge("e-ddi-enc", "ddi-a", "display-enc", "encode", "primary", "data"),
    edge("e-s1-dp", "subs1-dataport", "l3", "cache", "secondary", "bus"),
    edge("e-s2-dp", "subs2-dataport", "l3", "cache", "secondary", "bus"),
    edge("e-media-l3", "mfx", "l3", "media DMA", "secondary", "bus"),
    edge("e-sfc-display", "sfc", "display-pipe", "scaled frame", "secondary", "data"),
    edge("e-vqe-mfx", "vqe", "mfx", "video", "secondary", "data"),
  ]
  const lineIds = new Set(["e-cs-vfe", "e-vfe-vf", "e-vf-vs", "e-vs-hs", "e-hs-te", "e-te-ds", "e-ds-gs", "e-gs-so", "e-so-clip", "e-clip-raster", "e-raster-pixel", "e-pixel-render", "e-render-l3", "e-l3-gti", "e-gti-fabric", "e-display-ddi", "e-ddi-enc"])
  const rails = new Map<string, string>()
  return socCase(
    "soc-gpu-slice-reference",
    "GPU Slice / Unslice / GTI SoC 级框图",
    regions,
    modules,
    edges,
    ["cs", "vfe", "vf", "vs", "clip", "raster", "pixel", "render-depth", "l3", "gti-port", "fabric"],
    ["e-cs-vfe", "e-vfe-vf", "e-vf-vs", "e-so-clip", "e-clip-raster", "e-raster-pixel", "e-pixel-render", "e-render-l3", "e-l3-gti", "e-gti-fabric"],
    lineIds,
    rails,
    gpuSocLayout(),
  )
}

function socCortexR8ReferenceCase(): DrawioVisualEvalCase {
  const regions = [
    region("cluster", "Cortex-R8 MPCore Cluster"),
    region("core0", "Core 0 Pipeline", "cluster"),
    region("core1", "Core 1 Pipeline", "cluster"),
    region("debug", "CoreSight / Debug"),
    region("memory", "Memory System"),
    region("interconnect", "Bus Interconnect"),
    region("system", "System Control"),
  ]
  const modules = [
    node("c0-fetch", "Inst Fetch", "module", "core0"),
    node("c0-decode", "Decode", "module", "core0"),
    node("c0-exec", "Execute", "module", "core0"),
    node("c0-lsu", "LSU", "module", "core0"),
    node("c1-fetch", "Inst Fetch", "module", "core1"),
    node("c1-decode", "Decode", "module", "core1"),
    node("c1-exec", "Execute", "module", "core1"),
    node("c1-lsu", "LSU", "module", "core1"),
    node("cti", "CTI", "module", "debug"),
    node("etm", "ETM", "module", "debug"),
    node("dap", "DAP", "module", "debug"),
    node("mpu", "MPU", "module", "memory"),
    node("icache", "L1 I-Cache", "module", "memory"),
    node("dcache", "L1 D-Cache", "module", "memory"),
    node("tcm", "TCM", "module", "memory"),
    node("acp", "ACP", "module", "interconnect"),
    node("ahb", "AHB Slave", "module", "interconnect"),
    node("axi", "AXI Master\n64-bit", "module", "interconnect"),
    node("gic", "GIC", "module", "system"),
    node("timer", "Timer", "module", "system"),
    node("wdt", "WDT", "module", "system"),
  ].map((item) => ({ ...item, keepVisible: true }))
  const edges = [
    edge("e-c0-fetch-decode", "c0-fetch", "c0-decode", "fetch", "primary", "control"),
    edge("e-c0-decode-exec", "c0-decode", "c0-exec", "decode", "primary", "control"),
    edge("e-c0-exec-lsu", "c0-exec", "c0-lsu", "load/store", "primary", "control"),
    edge("e-c1-fetch-decode", "c1-fetch", "c1-decode", "fetch", "primary", "control"),
    edge("e-c1-decode-exec", "c1-decode", "c1-exec", "decode", "primary", "control"),
    edge("e-c1-exec-lsu", "c1-exec", "c1-lsu", "load/store", "primary", "control"),
    edge("e-c0-fetch-icache", "c0-fetch", "icache", "instruction", "primary", "bus"),
    edge("e-c1-fetch-icache", "c1-fetch", "icache", "instruction", "primary", "bus"),
    edge("e-c0-lsu-dcache", "c0-lsu", "dcache", "data", "primary", "bus"),
    edge("e-c1-lsu-dcache", "c1-lsu", "dcache", "data", "primary", "bus"),
    edge("e-c0-lsu-tcm", "c0-lsu", "tcm", "tcm", "primary", "bus"),
    edge("e-c1-lsu-tcm", "c1-lsu", "tcm", "tcm", "primary", "bus"),
    edge("e-icache-axi", "icache", "axi", "I-side", "primary", "bus"),
    edge("e-dcache-axi", "dcache", "axi", "D-side", "primary", "bus"),
    edge("e-tcm-axi", "tcm", "axi", "TCM", "primary", "bus"),
    edge("e-axi-gic", "axi", "gic", "IRQ", "primary", "control"),
    edge("e-axi-timer", "axi", "timer", "timer", "primary", "control"),
    edge("e-axi-wdt", "axi", "wdt", "watchdog", "primary", "control"),
    edge("e-dap-axi", "dap", "axi", "debug APB/AHB", "secondary", "bus"),
    edge("e-c0-etm", "c0-exec", "etm", "trace", "secondary", "event"),
    edge("e-c1-etm", "c1-exec", "etm", "trace", "secondary", "event"),
    edge("e-cti-gic", "cti", "gic", "trigger", "secondary", "event"),
    edge("e-gic-c0", "gic", "c0-fetch", "interrupt", "secondary", "event"),
    edge("e-gic-c1", "gic", "c1-fetch", "interrupt", "secondary", "event"),
    edge("e-acp-dcache", "acp", "dcache", "coherency", "secondary", "bus"),
    edge("e-ahb-axi", "ahb", "axi", "slave", "secondary", "bus"),
  ]
  const lineIds = new Set([
    "e-c0-fetch-decode",
    "e-c0-decode-exec",
    "e-c0-exec-lsu",
    "e-c1-fetch-decode",
    "e-c1-decode-exec",
    "e-c1-exec-lsu",
    "e-c0-lsu-dcache",
    "e-c1-lsu-dcache",
    "e-icache-axi",
    "e-dcache-axi",
    "e-tcm-axi",
    "e-axi-gic",
    "e-axi-timer",
    "e-axi-wdt",
  ])
  const rails = new Map<string, string>()
  const result = socCase(
    "soc-cortex-r8-reference",
    "Arm Cortex-R8 双核实时处理器架构图",
    regions,
    modules,
    edges,
    ["c0-fetch", "c0-decode", "c0-exec", "c0-lsu", "dcache", "axi", "gic"],
    ["e-c0-fetch-decode", "e-c0-decode-exec", "e-c0-exec-lsu", "e-c0-lsu-dcache", "e-dcache-axi", "e-axi-gic"],
    lineIds,
    rails,
    cortexR8SocLayout(),
    [
      {
        id: "r8-lsu-data-bus",
        label: "LSU data bus",
        edges: ["e-c0-lsu-dcache", "e-c1-lsu-dcache"],
        direction: "right",
        trunk: { orientation: "vertical", side: "left" },
      },
      {
        id: "r8-memory-axi-bus",
        label: "Memory AXI bus",
        edges: ["e-icache-axi", "e-dcache-axi", "e-tcm-axi"],
        direction: "right",
        trunk: { orientation: "vertical", side: "left" },
      },
    ],
  )
  return { ...result, referenceImage: CORTEX_R8_REFERENCE_IMAGE }
}

function socCortexA53ClusterCase(): DrawioVisualEvalCase {
  const regions = [
    region("cluster", "Cortex-A53 CPU Cluster"),
    region("l2", "Shared L2 / SCU"),
    region("cci-region", "CCI / System Interconnect"),
    region("memory", "Memory Subsystem"),
    region("periph", "Peripherals"),
    region("debug", "Debug / Trace"),
  ]
  const modules = [
    ...Array.from({ length: 4 }, (_, index) => node(`a53-${index}`, `A53 Core ${index}\nL1 I/D`, "module", "cluster")),
    node("cluster-ace", "Core ACE Bus", "module", "cluster"),
    node("neon", "NEON / FP", "module", "cluster"),
    node("l2cache", "Shared L2 Cache", "module", "l2"),
    node("snoop", "Snoop Control", "module", "l2"),
    node("cci-port", "ACE Port", "port", "cci-region"),
    node("cci-fabric", "CCI Fabric", "module", "cci-region"),
    node("gic", "GIC-400", "module", "periph"),
    node("timer", "Generic Timer", "module", "periph"),
    node("uart", "UART / SPI / I2C", "module", "periph"),
    node("ddr", "DDR Controller", "port", "memory"),
    node("dma", "DMA", "module", "memory"),
    node("rom", "Boot ROM", "module", "memory"),
    node("etm", "ETM Trace", "module", "debug"),
    node("dap", "Debug AP", "module", "debug"),
  ].map((item) => ({ ...item, keepVisible: true }))
  const edges = [
    ...Array.from({ length: 4 }, (_, index) => edge(`e-core${index}-l2`, `a53-${index}`, "l2cache", "L1 refill", "primary", "bus")),
    edge("e-cluster-l2", "cluster-ace", "l2cache", "ACE refill", "primary", "bus"),
    edge("e-l2-snoop", "l2cache", "snoop", "snoop", "primary", "control"),
    edge("e-snoop-ace", "snoop", "cci-port", "ACE", "primary", "bus"),
    edge("e-ace-cci", "cci-port", "cci-fabric", "coherent", "primary", "bus"),
    edge("e-cci-ddr", "cci-fabric", "ddr", "DDR", "primary", "bus"),
    edge("e-cci-dma", "cci-fabric", "dma", "DMA", "primary", "bus"),
    edge("e-cci-gic", "cci-fabric", "gic", "IRQ distributor", "primary", "control"),
    edge("e-gic-core0", "gic", "a53-0", "IRQ", "secondary", "event"),
    edge("e-gic-core1", "gic", "a53-1", "IRQ", "secondary", "event"),
    edge("e-gic-core2", "gic", "a53-2", "IRQ", "secondary", "event"),
    edge("e-gic-core3", "gic", "a53-3", "IRQ", "secondary", "event"),
    edge("e-timer-gic", "timer", "gic", "timer irq", "secondary", "event"),
    edge("e-uart-cci", "uart", "cci-fabric", "APB", "secondary", "bus"),
    edge("e-rom-cci", "rom", "cci-fabric", "boot fetch", "secondary", "bus"),
    edge("e-core0-etm", "a53-0", "etm", "trace", "secondary", "event"),
    edge("e-dap-cci", "dap", "cci-fabric", "debug", "secondary", "bus"),
  ]
  const lineIds = new Set([
    "e-cluster-l2",
    "e-l2-snoop",
    "e-snoop-ace",
    "e-ace-cci",
    "e-cci-ddr",
    "e-cci-dma",
    "e-cci-gic",
  ])
  const rails = new Map<string, string>()
  return socCase(
    "soc-cortex-a53-cluster",
    "Cortex-A53 四核应用处理器集群架构图",
    regions,
    modules,
    edges,
    ["cluster-ace", "l2cache", "snoop", "cci-port", "cci-fabric", "ddr"],
    ["e-cluster-l2", "e-l2-snoop", "e-snoop-ace", "e-ace-cci", "e-cci-ddr"],
    lineIds,
    rails,
    cortexA53SocLayout(),
    [
      {
        id: "a53-cci-memory-bus",
        label: "CCI memory bus",
        edges: ["e-cci-ddr", "e-cci-dma"],
        direction: "right",
        trunk: { orientation: "vertical", side: "right" },
      },
    ],
  )
}

function socCpuCoreBackendCase(): DrawioVisualEvalCase {
  const regions = [
    region("frontend", "Front End"),
    region("rename", "Rename / Allocate / Retirement"),
    region("scheduler", "Scheduler / Physical Registers"),
    region("execute", "Execution Engine"),
    region("lsu", "Load Store Unit"),
    region("memory", "Memory Subsystem"),
    region("control", "Prediction / Recovery"),
  ]
  const modules = [
    node("fetch", "Instruction Fetch", "module", "frontend"),
    node("bp", "Branch Predictor", "module", "frontend"),
    node("icache", "L1 I-Cache\n32 KiB", "module", "frontend"),
    node("itlb", "Instruction TLB", "module", "frontend"),
    node("decode", "Decode Buffer\n6 uOps/cycle", "module", "frontend"),
    node("uop-cache", "uOp Cache", "module", "frontend"),
    node("rename-map", "Register Alias Tables", "module", "rename"),
    node("alloc", "Allocation Queue", "module", "rename"),
    node("rob", "Reorder Buffer", "module", "rename"),
    node("retire", "Checker / Retirement", "module", "rename"),
    node("sched", "Unified Scheduler", "module", "scheduler"),
    node("int-prf", "Integer PRF", "module", "scheduler"),
    node("vec-prf", "Vector PRF", "module", "scheduler"),
    ...Array.from({ length: 8 }, (_, index) => node(`alu${index}`, `ALU Port ${index}`, "module", "execute")),
    node("branch", "Branch Unit", "module", "execute"),
    node("mul", "MUL / DIV", "module", "execute"),
    node("agu0", "LD AGU", "module", "lsu"),
    node("agu1", "ST AGU", "module", "lsu"),
    node("loadq", "Load Buffer", "module", "lsu"),
    node("storeq", "Store Buffer", "module", "lsu"),
    node("dtlb", "Data TLB", "module", "memory"),
    node("l1d", "L1 Data Cache\n48 KiB", "module", "memory"),
    node("l2", "L2 Cache\n512 KiB", "module", "memory"),
    node("l3", "To L3", "port", "memory"),
    node("rollback", "Rollback / Redirect", "module", "control"),
    node("mispredict", "Mispredict Recovery", "module", "control"),
  ].map((item) => ({ ...item, keepVisible: true }))
  const edges = [
    edge("e-fetch-icache", "fetch", "icache", "fetch addr", "primary", "control"),
    edge("e-icache-decode", "icache", "decode", "instructions", "primary", "data"),
    edge("e-decode-rename", "decode", "rename-map", "uOps", "primary", "data"),
    edge("e-rename-alloc", "rename-map", "alloc", "rename", "primary", "data"),
    edge("e-alloc-rob", "alloc", "rob", "allocate", "primary", "data"),
    edge("e-rob-sched", "rob", "sched", "ready uOps", "primary", "data"),
    edge("e-sched-alu0", "sched", "alu0", "issue", "primary", "data"),
    edge("e-alu0-retire", "alu0", "retire", "result", "primary", "data"),
    edge("e-retire-rob", "retire", "rob", "commit", "primary", "control"),
    edge("e-sched-agu0", "sched", "agu0", "load", "primary", "data"),
    edge("e-agu0-loadq", "agu0", "loadq", "addr", "primary", "data"),
    edge("e-loadq-dtlb", "loadq", "dtlb", "translate", "primary", "data"),
    edge("e-dtlb-l1d", "dtlb", "l1d", "PA", "primary", "data"),
    edge("e-l1d-l2", "l1d", "l2", "miss/fill", "primary", "bus"),
    edge("e-l2-l3", "l2", "l3", "64B/cycle", "primary", "bus"),
    edge("e-bp-fetch", "bp", "fetch", "predict", "secondary", "control"),
    edge("e-itlb-fetch", "itlb", "fetch", "translation", "secondary", "control"),
    edge("e-uop-decode", "uop-cache", "decode", "uOps", "secondary", "data"),
    edge("e-sched-alu1", "sched", "alu1", "issue", "secondary", "data"),
    edge("e-sched-alu2", "sched", "alu2", "issue", "secondary", "data"),
    edge("e-sched-branch", "sched", "branch", "branch", "secondary", "data"),
    edge("e-branch-mispredict", "branch", "mispredict", "mispredict", "exception", "event"),
    edge("e-mispredict-rollback", "mispredict", "rollback", "flush", "exception", "control"),
    edge("e-rollback-fetch", "rollback", "fetch", "redirect", "feedback", "control"),
    edge("e-store-l1d", "storeq", "l1d", "store data", "secondary", "data"),
    edge("e-sched-store", "sched", "agu1", "store", "secondary", "data"),
    edge("e-agu1-storeq", "agu1", "storeq", "addr", "secondary", "data"),
  ]
  const lineIds = new Set(["e-fetch-icache", "e-icache-decode", "e-decode-rename", "e-rename-alloc", "e-alloc-rob", "e-rob-sched", "e-sched-alu0", "e-sched-agu0", "e-agu0-loadq", "e-loadq-dtlb", "e-dtlb-l1d", "e-l1d-l2", "e-l2-l3"])
  const rails = new Map([["e-bp-fetch", "top"]])
  return socCase(
    "soc-cpu-core-backend",
    "CPU Core Frontend / Scheduler / Memory SoC 级框图",
    regions,
    modules,
    edges,
    ["fetch", "icache", "decode", "rename-map", "alloc", "rob", "sched", "agu0", "loadq", "dtlb", "l1d", "l2", "l3"],
    ["e-fetch-icache", "e-icache-decode", "e-decode-rename", "e-rename-alloc", "e-alloc-rob", "e-rob-sched", "e-sched-agu0", "e-agu0-loadq", "e-loadq-dtlb", "e-dtlb-l1d", "e-l1d-l2", "e-l2-l3"],
    lineIds,
    rails,
    cpuSocLayout(),
  )
}

function socSsdControllerFabricCase(): DrawioVisualEvalCase {
  const regions = [
    region("host", "Host Interface"),
    region("command", "Command / Queue Manager"),
    region("ftl", "FTL / Mapping"),
    region("media", "Media Pipeline"),
    region("nand", "NAND Channels"),
    region("security", "Security / Reliability"),
    region("memory", "SRAM / DRAM / DMA"),
    region("power", "Power / Telemetry"),
  ]
  const modules = [
    node("ufs", "UFS / PCIe PHY", "port", "host"),
    node("link", "Link Controller", "module", "host"),
    node("doorbell", "Doorbell / SQ/CQ", "module", "command"),
    node("arbiter", "Queue Arbiter", "module", "command"),
    node("parser", "Command Parser", "module", "command"),
    node("admin", "Admin / Feature Manager", "module", "command"),
    node("scheduler", "MP Scheduler", "module", "command"),
    node("map-cache", "Mapping Cache", "module", "ftl"),
    node("ftl-core", "FTL Core", "module", "ftl"),
    node("gc", "GC Engine", "module", "ftl"),
    node("wear", "Wear Leveling", "module", "ftl"),
    node("bbm", "Bad Block\nMgr", "module", "ftl"),
    node("dma", "DMA Engine", "module", "memory"),
    node("sram", "On-chip SRAM", "module", "memory"),
    node("dram", "External DRAM", "port", "memory"),
    node("ecc", "ECC / LDPC", "module", "media"),
    node("scramble", "Scrambler", "module", "media"),
    node("flash-seq", "Flash Sequencer", "module", "media"),
    ...Array.from({ length: 6 }, (_, index) => node(`nand${index}`, `NAND Ch ${index}`, "port", "nand")),
    node("rpmb", "RPMB / Auth", "module", "security"),
    node("crypto", "AES / Inline Crypto", "module", "security"),
    node("health", "SMART / Health", "module", "power"),
    node("thermal", "Thermal Throttle", "module", "power"),
    node("pm", "Power Manager", "module", "power"),
    node("irq", "IRQ / Completion", "module", "host"),
  ].map((item) => ({ ...item, keepVisible: true }))
  const edges = [
    edge("e-ufs-link", "ufs", "link", "UPIU/TLP", "primary", "control"),
    edge("e-link-doorbell", "link", "doorbell", "doorbell", "primary", "control"),
    edge("e-doorbell-arb", "doorbell", "arbiter", "queue", "primary", "control"),
    edge("e-arb-parser", "arbiter", "parser", "cmd", "primary", "control"),
    edge("e-admin-parser", "admin", "parser", "feature/query", "secondary", "control"),
    edge("e-parser-sched", "parser", "scheduler", "task", "primary", "control"),
    edge("e-sched-ftl", "scheduler", "ftl-core", "logical op", "primary", "control"),
    edge("e-ftl-map", "ftl-core", "map-cache", "lookup/update", "primary", "data"),
    edge("e-map-dma", "map-cache", "dma", "PRP/SG", "secondary", "bus"),
    edge("e-dma-ecc", "dma", "ecc", "data", "secondary", "data"),
    edge("e-ftl-ecc", "ftl-core", "ecc", "data path", "primary", "bus"),
    edge("e-ecc-scramble", "ecc", "scramble", "codeword", "primary", "data"),
    edge("e-scramble-flash", "scramble", "flash-seq", "page data", "primary", "data"),
    edge("e-flash-nand0", "flash-seq", "nand0", "channel", "primary", "bus"),
    edge("e-nand0-irq", "nand0", "irq", "done", "primary", "event"),
    edge("e-irq-link", "irq", "link", "completion", "primary", "control"),
    edge("e-gc-ftl", "gc", "ftl-core", "relocation", "secondary", "control"),
    edge("e-wear-ftl", "wear", "ftl-core", "wear policy", "secondary", "control"),
    edge("e-bbm-flash", "bbm", "flash-seq", "bad block table", "secondary", "control"),
    edge("e-ftl-rpmb", "ftl-core", "rpmb", "secure op", "secondary", "control"),
    edge("e-crypto-dma", "crypto", "dma", "inline crypto", "secondary", "data"),
    edge("e-dma-dram", "dma", "dram", "descriptor/data", "secondary", "bus"),
    edge("e-sram-parser", "sram", "parser", "metadata", "secondary", "data"),
    edge("e-pm-link", "pm", "link", "power state", "secondary", "control"),
    edge("e-thermal-pm", "thermal", "pm", "throttle", "secondary", "control"),
    edge("e-health-host", "health", "link", "SMART log", "secondary", "data"),
    ...Array.from({ length: 5 }, (_, index) => edge(`e-flash-nand${index + 1}`, "flash-seq", `nand${index + 1}`, `channel ${index + 1}`, "secondary", "bus")),
  ]
  const lineIds = new Set(["e-ufs-link", "e-link-doorbell", "e-doorbell-arb", "e-arb-parser", "e-parser-sched", "e-sched-ftl", "e-ftl-ecc", "e-ecc-scramble", "e-scramble-flash", "e-flash-nand0"])
  const rails = new Map<string, string>()
  return socCase(
    "soc-ssd-controller-fabric",
    "SSD Controller Host / FTL / NAND Fabric SoC 级框图",
    regions,
    modules,
    edges,
    ["ufs", "link", "doorbell", "arbiter", "parser", "scheduler", "ftl-core", "ecc", "scramble", "flash-seq", "nand0"],
    ["e-ufs-link", "e-link-doorbell", "e-doorbell-arb", "e-arb-parser", "e-parser-sched", "e-sched-ftl", "e-ftl-ecc", "e-ecc-scramble", "e-scramble-flash", "e-flash-nand0"],
    lineIds,
    rails,
    ssdSocLayout(),
  )
}

function socCase(
  id: string,
  title: string,
  regions: Array<ReturnType<typeof region>>,
  modules: Array<ReturnType<typeof node> & { keepVisible?: boolean }>,
  edges: ReturnType<typeof edge>[],
  backboneNodes: string[],
  backboneEdges: string[],
  lineIds: Set<string>,
  rails: Map<string, string>,
  socLayout: Record<string, unknown>,
  buses?: NonNullable<DiagramIr["visualPlan"]>["buses"],
) {
  const edgePresentation = Object.fromEntries(edges.map((item, index) => {
    const edgeId = String(item.id)
    const rail = rails.get(edgeId)
    return [
      edgeId,
      lineIds.has(edgeId)
        ? { mode: "line" as const }
        : rail
          ? { mode: "rail" as const, rail: rail as "top" | "bottom" | "left" | "right", marker: `[B${index + 1}]` }
          : { mode: "legend" as const, marker: `[I${index + 1}]`, label: String(item.label) },
    ]
  }))
  const diagramIr: DiagramIr = {
    version: "diagram-ir/v1",
    title,
    diagramType: "soc-block",
    regions,
    nodes: modules,
    edges,
    visualPlan: {
      layoutProfile: "soc-block",
      mainBackbone: {
        nodes: backboneNodes,
        edges: backboneEdges,
        direction: "right",
      },
      edgePresentation,
      buses,
      styleHints: {
        socLayout,
      },
    },
  }
  return caseDef(id, title, "soc-suite", diagramIr, [
    "SoC 区域边界清晰",
    "主干 bus 不被跨区 rail 穿过",
    "接口说明不遮挡主图",
  ])
}

function gpuSocLayout() {
  const nodes = [
    ...placements("display", [
      ["ddi-a", 10, 86, 64, 36],
      ["ddi-b", 10, 198, 64, 36],
      ["display-pipe", 10, 310, 64, 64],
      ["display-enc", 10, 440, 64, 54],
    ]),
    ...placements("media", [
      ["sfc", 32, 40, 130, 46],
      ["vqe", 260, 40, 130, 46],
      ["mfx", 488, 40, 130, 46],
    ]),
    ...gpuSubslicePlacements(0, 42),
    ...gpuSubslicePlacements(1, 160),
    ...gpuSubslicePlacements(2, 264),
    ...placements("slice-common", [
      ["l3", 26, 32, 96, 42],
      ["pixel", 145, 32, 112, 42],
      ["render-depth", 280, 32, 122, 42],
      ["raster", 430, 32, 116, 42],
    ]),
    ...placements("gtd", [
      ["dispatcher", 8, 36, 36, 240],
    ]),
    ...placements("unslice", [
      ["cs", 88, 38, 150, 44],
      ["vfe", 108, 105, 112, 42],
    ]),
    ...placements("fixed-pipe", [
      ["vf", 24, 38, 210, 30],
      ["vs", 24, 78, 210, 30],
      ["hs", 24, 118, 210, 30],
      ["te", 24, 158, 210, 30],
      ["ds", 24, 198, 210, 30],
      ["gs", 24, 238, 210, 30],
      ["so", 24, 278, 210, 30],
      ["clip", 24, 318, 210, 30],
    ]),
    ...placements("gti", [
      ["gti-port", 16, 190, 60, 56],
      ["fabric", 16, 370, 60, 56],
    ]),
  ]
  return {
    targetAspectRatio: 1.9,
    regions: [
      place("display", 40, 62, 84, 538),
      place("media", 142, 42, 650, 106),
      place("slice", 142, 158, 650, 478),
      place("slice-common", 182, 528, 570, 92),
      place("gtd", 818, 190, 54, 315),
      place("unslice", 890, 42, 318, 522),
      place("fixed-pipe", 920, 178, 258, 358),
      place("gti", 1228, 62, 92, 502),
    ],
    nodes,
    edges: [
      edgeRoute("e-clip-raster", [1048, 678], [676, 678]),
      edgeRoute("e-l3-gti", [256, 714], [1274, 714], [1274, 280]),
      edgeRoute("e-display-ddi", [82, 372], [82, 265]),
      edgeRoute("e-ddi-enc", [82, 265], [82, 529]),
    ],
  }
}

function gpuSubslicePlacements(index: number, y: number) {
  const suffix = String(index)
  return placements("slice", [
    [`subs${suffix}-l1`, 28, y + 12, 60, 76],
    [`subs${suffix}-eu0`, 105, y, 78, 32],
    [`subs${suffix}-eu1`, 105, y + 44, 78, 32],
    [`subs${suffix}-sampler`, 200, y, 136, 32],
    [`subs${suffix}-dataport`, 200, y + 44, 136, 32],
    [`subs${suffix}-tex`, 354, y, 112, 76],
  ])
}

function cortexR8SocLayout() {
  return {
    targetAspectRatio: 1.85,
    regions: [
      place("cluster", 42, 92, 560, 440),
      place("core0", 100, 176, 430, 120),
      place("core1", 100, 352, 430, 120),
      place("debug", 650, 32, 170, 248),
      place("memory", 650, 326, 190, 308),
      place("interconnect", 900, 245, 300, 330),
      place("system", 1260, 300, 220, 280),
    ],
    nodes: [
      ...placements("core0", [
        ["c0-fetch", 24, 42, 72, 38],
        ["c0-decode", 126, 42, 72, 38],
        ["c0-exec", 228, 42, 82, 38],
        ["c0-lsu", 342, 42, 62, 38],
      ]),
      ...placements("core1", [
        ["c1-fetch", 24, 42, 72, 38],
        ["c1-decode", 126, 42, 72, 38],
        ["c1-exec", 228, 42, 82, 38],
        ["c1-lsu", 342, 42, 62, 38],
      ]),
      ...placements("debug", [
        ["cti", 36, 34, 92, 44],
        ["etm", 36, 102, 92, 44],
        ["dap", 36, 172, 92, 44],
      ]),
      ...placements("memory", [
        ["mpu", 32, 40, 126, 42],
        ["icache", 32, 106, 126, 42],
        ["dcache", 32, 174, 126, 42],
        ["tcm", 32, 240, 126, 42],
      ]),
      ...placements("interconnect", [
        ["acp", 44, 54, 110, 50],
        ["ahb", 44, 150, 110, 50],
        ["axi", 176, 198, 98, 58],
      ]),
      ...placements("system", [
        ["gic", 50, 44, 120, 50],
        ["timer", 34, 124, 152, 52],
        ["wdt", 34, 204, 152, 52],
      ]),
    ],
    edges: [
      edgeRoute("e-c0-lsu-dcache", [610, 253], [610, 539]),
      edgeRoute("e-c1-lsu-dcache", [610, 429], [610, 539]),
      edgeRoute("e-dcache-axi", [940, 539], [940, 476]),
      edgeRoute("e-tcm-axi", [870, 605], [1000, 605], [1000, 476]),
      edgeRoute("e-axi-gic", [1190, 472], [1310, 472], [1310, 370]),
      edgeRoute("e-axi-timer", [1190, 472], [1310, 472], [1310, 450]),
      edgeRoute("e-axi-wdt", [1190, 472], [1310, 472], [1310, 530]),
    ],
  }
}

function cortexA53SocLayout() {
  return {
    targetAspectRatio: 1.9,
    regions: [
      place("cluster", 58, 82, 470, 300),
      place("l2", 580, 120, 240, 230),
      place("cci-region", 875, 155, 265, 235),
      place("memory", 1195, 120, 260, 275),
      place("periph", 875, 430, 265, 230),
      place("debug", 58, 430, 470, 160),
    ],
    nodes: [
      ...placements("cluster", [
        ["a53-0", 34, 54, 86, 70],
        ["a53-1", 144, 54, 86, 70],
        ["a53-2", 254, 54, 86, 70],
        ["a53-3", 364, 54, 86, 70],
        ["cluster-ace", 72, 142, 340, 36],
        ["neon", 170, 178, 130, 54],
      ]),
      ...placements("l2", [
        ["l2cache", 44, 48, 152, 62],
        ["snoop", 44, 142, 152, 56],
      ]),
      ...placements("cci-region", [
        ["cci-port", 34, 50, 95, 52],
        ["cci-fabric", 148, 80, 92, 78],
      ]),
      ...placements("memory", [
        ["ddr", 48, 54, 150, 58],
        ["dma", 48, 136, 150, 52],
        ["rom", 48, 208, 150, 42],
      ]),
      ...placements("periph", [
        ["gic", 46, 38, 150, 52],
        ["timer", 46, 104, 150, 44],
        ["uart", 46, 164, 150, 44],
      ]),
      ...placements("debug", [
        ["etm", 62, 50, 142, 50],
        ["dap", 262, 50, 142, 50],
      ]),
    ],
    edges: [
      edgeRoute("e-cluster-l2", [526, 242], [624, 199]),
      edgeRoute("e-snoop-ace", [700, 292], [910, 232]),
      edgeRoute("e-ace-cci", [956, 232], [1045, 275]),
      edgeRoute("e-cci-ddr", [1090, 275], [1275, 230]),
      edgeRoute("e-cci-gic", [1045, 275], [1045, 505], [950, 505]),
    ],
  }
}

function cpuSocLayout() {
  return {
    targetAspectRatio: 1.6,
    regions: [
      place("frontend", 42, 42, 620, 220),
      place("rename", 42, 285, 620, 118),
      place("scheduler", 42, 430, 620, 172),
      place("execute", 82, 622, 548, 160),
      place("lsu", 700, 492, 320, 220),
      place("memory", 700, 735, 320, 170),
      place("control", 1050, 260, 230, 330),
    ],
    nodes: [
      ...placements("frontend", [
        ["bp", 22, 72, 90, 58],
        ["fetch", 142, 38, 112, 52],
        ["icache", 280, 28, 140, 66],
        ["itlb", 445, 38, 96, 52],
        ["uop-cache", 165, 124, 120, 50],
        ["decode", 330, 118, 150, 58],
      ]),
      ...placements("rename", [
        ["rename-map", 28, 40, 140, 50],
        ["alloc", 210, 40, 150, 50],
        ["rob", 395, 40, 120, 50],
        ["retire", 535, 40, 70, 50],
      ]),
      ...placements("scheduler", [
        ["int-prf", 30, 88, 170, 46],
        ["sched", 220, 42, 170, 72],
        ["vec-prf", 410, 88, 170, 46],
      ]),
      ...placements("execute", [
        ["alu0", 18, 34, 58, 42],
        ["alu1", 86, 34, 58, 42],
        ["alu2", 154, 34, 58, 42],
        ["alu3", 222, 34, 58, 42],
        ["alu4", 290, 34, 58, 42],
        ["alu5", 358, 34, 58, 42],
        ["alu6", 426, 34, 58, 42],
        ["alu7", 494, 34, 58, 42],
        ["branch", 154, 96, 110, 42],
        ["mul", 290, 96, 110, 42],
      ]),
      ...placements("lsu", [
        ["agu0", 28, 40, 92, 46],
        ["agu1", 142, 40, 92, 46],
        ["loadq", 28, 118, 116, 52],
        ["storeq", 170, 118, 116, 52],
      ]),
      ...placements("memory", [
        ["dtlb", 24, 38, 96, 46],
        ["l1d", 145, 28, 135, 66],
        ["l2", 54, 112, 150, 46],
        ["l3", 232, 112, 64, 46],
      ]),
      ...placements("control", [
        ["mispredict", 42, 58, 145, 56],
        ["rollback", 42, 190, 145, 56],
      ]),
    ],
  }
}

function ssdSocLayout() {
  return {
    targetAspectRatio: 1.95,
    regions: [
      place("host", 42, 170, 180, 300),
      place("command", 250, 105, 255, 390),
      place("ftl", 535, 105, 260, 390),
      place("media", 825, 105, 260, 390),
      place("nand", 1115, 105, 205, 390),
      place("memory", 430, 535, 390, 150),
      place("security", 850, 535, 230, 150),
      place("power", 1110, 535, 210, 150),
    ],
    nodes: [
      ...placements("host", [
        ["ufs", 24, 50, 112, 48],
        ["link", 24, 130, 112, 56],
        ["irq", 24, 225, 112, 50],
      ]),
      ...placements("command", [
        ["doorbell", 34, 44, 156, 48],
        ["arbiter", 34, 110, 156, 48],
        ["parser", 34, 176, 156, 48],
        ["scheduler", 34, 260, 156, 54],
        ["admin", 34, 328, 156, 42],
      ]),
      ...placements("ftl", [
        ["ftl-core", 62, 88, 136, 64],
        ["map-cache", 38, 190, 112, 52],
        ["gc", 30, 298, 96, 46],
        ["wear", 142, 298, 96, 46],
        ["bbm", 158, 190, 92, 52],
      ]),
      ...placements("memory", [
        ["dma", 28, 44, 122, 54],
        ["sram", 174, 44, 108, 54],
        ["dram", 306, 44, 64, 54],
      ]),
      ...placements("media", [
        ["ecc", 40, 70, 130, 52],
        ["scramble", 40, 160, 130, 52],
        ["flash-seq", 40, 255, 130, 58],
      ]),
      ...placements("nand", Array.from({ length: 6 }, (_, index) => [`nand${index}`, 36 + (index % 2) * 78, 48 + Math.floor(index / 2) * 96, 66, 54] as const)),
      ...placements("security", [
        ["crypto", 30, 42, 126, 48],
        ["rpmb", 30, 98, 126, 48],
      ]),
      ...placements("power", [
        ["health", 30, 34, 128, 42],
        ["thermal", 30, 82, 128, 42],
        ["pm", 30, 130, 128, 42],
      ]),
    ],
    edges: [
      edgeRoute("e-ftl-ecc", [665, 250], [955, 250]),
      edgeRoute("e-flash-nand0", [1040, 360], [1185, 360], [1185, 180]),
    ],
  }
}

function place(id: string, x: number, y: number, width: number, height: number) {
  return { id, x, y, width, height }
}

function placements(regionId: string, items: ReadonlyArray<readonly [string, number, number, number, number]>) {
  return items.map(([id, x, y, width, height]) => ({ id, region: regionId, x, y, width, height }))
}

function edgeRoute(id: string, ...points: Array<readonly [number, number]>) {
  return {
    id,
    points: points.map(([x, y]) => ({ x, y })),
  }
}

function mixedCodeFlowCase(): DrawioVisualEvalCase {
  const main = [
    ["entry", "ftl_mp_gc_process(ctx, req)\n入口：解析 req / ctx / runtime flags", "action"],
    ["read-flags", "读取运行标志\nread_runtime_flags()", "action"],
    ["check-busy", "判断 busy / suspended / hibernate", "decision"],
    ["load-desc", "加载 block descriptor\nload_block_desc()", "action"],
    ["switch-op", "switch(req->op)\nREAD / WRITE / RECLAIM / FLUSH", "decision"],
    ["prepare-read", "READ: prepare_read_window()", "action"],
    ["prepare-write", "WRITE: prepare_write_window()", "action"],
    ["prepare-reclaim", "RECLAIM: prepare_reclaim_window()", "action"],
    ["prepare-flush", "FLUSH: prepare_flush_window()", "action"],
    ["merge-plan", "合并 operation plan\nmerge_mp_plan()", "action"],
    ["validate-plan", "校验 plan consistency\nvalidate_plan()", "decision"],
    ["alloc-node", "分配 node / token\nalloc_runtime_node()", "action"],
    ["submit", "提交 runtime job\nsubmit_runtime_job()", "action"],
    ["wait-done", "等待 completion IRQ\nWAIT_DONE", "state"],
    ["read-status", "读取 status / sense\nread_completion_status()", "action"],
    ["check-status", "判断 status / error_code", "decision"],
    ["update-map", "更新 mapping / counters\nupdate_mapping_and_stats()", "action"],
    ["flush-meta", "刷 metadata\nflush_metadata_if_needed()", "action"],
    ["complete", "返回完成\ncomplete_request()", "action"],
  ] as const
  const side = [
    ["busy-exit", "busy: 返回 EBUSY / defer queue", "action"],
    ["suspend-exit", "suspend: 保存上下文并退出", "action"],
    ["invalid-op", "default: unsupported op", "action"],
    ["plan-fail", "plan 校验失败", "action"],
    ["alloc-fail", "token/node 分配失败", "action"],
    ["timeout", "completion timeout", "action"],
    ["retry", "重试预算检查\nretry_budget_check()", "decision"],
    ["recover", "错误恢复\nrecover_runtime_state()", "action"],
    ["rollback", "回滚 mapping / stats\nrollback_updates()", "action"],
    ["fatal", "fatal error path", "action"],
    ["trace", "写 trace / coverage", "action"],
    ["cleanup", "释放锁和临时资源\ncleanup_context()", "action"],
  ] as const
  const primary = [
    edge("e-entry-flags", "entry", "read-flags", "enter", "primary", "control"),
    edge("e-flags-busy", "read-flags", "check-busy", "flags", "primary", "control"),
    edge("e-busy-desc", "check-busy", "load-desc", "ready", "primary", "control"),
    edge("e-desc-switch", "load-desc", "switch-op", "descriptor ok", "primary", "control"),
    edge("e-switch-read", "switch-op", "prepare-read", "READ", "primary", "control"),
    edge("e-read-merge", "prepare-read", "merge-plan", "read plan", "primary", "control"),
    edge("e-merge-validate", "merge-plan", "validate-plan", "merged", "primary", "control"),
    edge("e-validate-alloc", "validate-plan", "alloc-node", "valid", "primary", "control"),
    edge("e-alloc-submit", "alloc-node", "submit", "allocated", "primary", "control"),
    edge("e-submit-wait", "submit", "wait-done", "submitted", "primary", "event"),
    edge("e-wait-status", "wait-done", "read-status", "irq", "primary", "event"),
    edge("e-status-check", "read-status", "check-status", "status", "primary", "control"),
    edge("e-check-update", "check-status", "update-map", "ok", "primary", "control"),
    edge("e-update-flush", "update-map", "flush-meta", "dirty meta", "primary", "control"),
    edge("e-flush-complete", "flush-meta", "complete", "done", "primary", "control"),
  ]
  const branch = [
    edge("e-switch-write", "switch-op", "prepare-write", "WRITE", "secondary", "control"),
    edge("e-write-merge", "prepare-write", "merge-plan", "write plan", "secondary", "control"),
    edge("e-switch-reclaim", "switch-op", "prepare-reclaim", "RECLAIM", "secondary", "control"),
    edge("e-reclaim-merge", "prepare-reclaim", "merge-plan", "reclaim plan", "secondary", "control"),
    edge("e-switch-flush", "switch-op", "prepare-flush", "FLUSH", "secondary", "control"),
    edge("e-flush-merge", "prepare-flush", "merge-plan", "flush plan", "secondary", "control"),
    edge("e-busy-exit", "check-busy", "busy-exit", "busy", "exception", "event"),
    edge("e-suspend-exit", "check-busy", "suspend-exit", "suspended", "exception", "event"),
    edge("e-invalid-op", "switch-op", "invalid-op", "default", "exception", "event"),
    edge("e-plan-fail", "validate-plan", "plan-fail", "invalid plan", "exception", "event"),
    edge("e-alloc-fail", "alloc-node", "alloc-fail", "no token", "exception", "event"),
    edge("e-timeout", "wait-done", "timeout", "timeout", "exception", "event"),
    edge("e-timeout-retry", "timeout", "retry", "check retry", "exception", "event"),
    edge("e-retry-submit", "retry", "submit", "retry", "feedback", "event"),
    edge("e-retry-recover", "retry", "recover", "exhausted", "exception", "event"),
    edge("e-status-recover", "check-status", "recover", "status error", "exception", "event"),
    edge("e-recover-rollback", "recover", "rollback", "rollback", "exception", "control"),
    edge("e-rollback-fatal", "rollback", "fatal", "fatal", "exception", "event"),
    edge("e-rollback-trace", "rollback", "trace", "trace", "secondary", "data"),
    edge("e-fatal-trace", "fatal", "trace", "trace", "secondary", "data"),
    edge("e-trace-cleanup", "trace", "cleanup", "cleanup", "secondary", "control"),
    edge("e-busy-cleanup", "busy-exit", "cleanup", "cleanup", "secondary", "control"),
    edge("e-suspend-cleanup", "suspend-exit", "cleanup", "cleanup", "secondary", "control"),
    edge("e-invalid-cleanup", "invalid-op", "cleanup", "cleanup", "secondary", "control"),
    edge("e-plan-cleanup", "plan-fail", "cleanup", "cleanup", "secondary", "control"),
    edge("e-alloc-cleanup", "alloc-fail", "cleanup", "cleanup", "secondary", "control"),
    edge("e-complete-cleanup", "complete", "cleanup", "cleanup", "secondary", "control"),
  ]
  const edgePresentation: Record<string, { mode: "line" | "rail" | "legend"; rail?: "left" | "right"; marker?: string; label?: string }> = {}
  for (const item of primary) edgePresentation[String(item.id)] = { mode: "line" }
  const visibleBranchLines = new Set(["e-switch-write", "e-write-merge"])
  const visibleBranchRails = new Map([
    ["e-busy-exit", "left"],
    ["e-timeout", "right"],
    ["e-retry-submit", "right"],
    ["e-status-recover", "left"],
  ])
  for (const [index, item] of branch.entries()) {
    const id = String(item.id)
    const rail = visibleBranchRails.get(id)
    if (visibleBranchLines.has(id)) edgePresentation[id] = { mode: "line" }
    else if (rail) edgePresentation[id] = { mode: "rail", rail: rail as "left" | "right", marker: `[X${index + 1}]` }
    else edgePresentation[id] = { mode: "legend", marker: `[C${index + 1}]`, label: String(item.label) }
  }
  const diagramIr: DiagramIr = {
    version: "diagram-ir/v1",
    title: "SSD 嵌入式代码级流程 - 长中文英文混排高密度",
    diagramType: "code-flow",
    nodes: [...main.map(([id, label, role]) => node(id, label, role)), ...side.map(([id, label, role]) => node(id, label, role))],
    edges: [...primary, ...branch],
    visualPlan: {
      layoutProfile: "code-flow",
      mainBackbone: {
        nodes: ["entry", "read-flags", "check-busy", "load-desc", "switch-op", "prepare-read", "merge-plan", "validate-plan", "alloc-node", "submit", "wait-done", "read-status", "check-status", "update-map", "flush-meta", "complete"],
        edges: primary.map((item) => String(item.id)),
        direction: "down",
      },
      edgePresentation,
      legend: {
        position: "right",
        title: "异常说明",
        items: [
          { id: "switch", marker: "[SW]", label: "switch 分支保留为线；错误、重试、清理由模型标注为 rail/legend。" },
          { id: "cleanup", marker: "[C]", label: "清理/trace 边外置，避免把主流程画成线团。" },
        ],
      },
    },
  }
  return caseDef("mixed-code-flow", "SSD 嵌入式代码级流程 - 长中文英文混排高密度", "code-flow", diagramIr, [
    "长函数名折行",
    "异常 rail 可读",
    "节点不互相遮挡",
  ])
}

function canaryCase(id: string, base: DrawioVisualEvalCase, input: { title: string; replacements: Array<[string, string]> }): DrawioVisualEvalCase {
  const text = input.replacements.reduce((current, [from, to]) => current.split(from).join(to), JSON.stringify(base.diagramIr))
  const diagramIr = JSON.parse(text) as DiagramIr
  const remap = new Map<string, string>()
  const nodes = diagramIr.nodes ?? []
  nodes.forEach((node, index) => {
    const old = String(node.id || `node-${index}`)
    const next = `c${index + 1}`
    remap.set(old, next)
    node.id = next
  })
  const edges = diagramIr.edges ?? []
  edges.forEach((edgeItem, index) => {
    const old = String(edgeItem.id || `edge-${index}`)
    const next = `ce${index + 1}`
    remap.set(old, next)
    edgeItem.id = next
    if (typeof edgeItem.source === "string") edgeItem.source = remap.get(edgeItem.source) ?? edgeItem.source
    if (typeof edgeItem.target === "string") edgeItem.target = remap.get(edgeItem.target) ?? edgeItem.target
  })
  if (diagramIr.visualPlan?.mainBackbone) {
    diagramIr.visualPlan.mainBackbone.nodes = diagramIr.visualPlan.mainBackbone.nodes?.map((nodeId) => remap.get(nodeId) ?? nodeId)
    diagramIr.visualPlan.mainBackbone.edges = diagramIr.visualPlan.mainBackbone.edges?.map((edgeId) => remap.get(edgeId) ?? edgeId)
  }
  if (diagramIr.visualPlan?.edgePresentation) {
    diagramIr.visualPlan.edgePresentation = Object.fromEntries(
      Object.entries(diagramIr.visualPlan.edgePresentation).map(([key, value]) => [remap.get(key) ?? key, value]),
    )
  }
  if (diagramIr.visualPlan?.buses) {
    diagramIr.visualPlan.buses = diagramIr.visualPlan.buses.map((bus) => ({
      ...bus,
      edges: bus.edges?.map((edgeId) => remap.get(edgeId) ?? edgeId),
      junctions: bus.junctions?.map((junction) => ({
        ...junction,
        edges: junction.edges?.map((edgeId) => remap.get(edgeId) ?? edgeId),
      })),
    }))
  }
  diagramIr.title = input.title
  return {
    ...base,
    id,
    title: input.title,
    public: false,
    category: `${base.category} canary`,
    diagramIr,
  }
}

function caseDef(id: string, title: string, category: string, diagramIr: DiagramIr, expectedRendererFocus: string[]): DrawioVisualEvalCase {
  return {
    id,
    title,
    category,
    public: true,
    expectedRendererFocus,
    diagramIr: withEvidence(diagramIr),
  }
}

function withEvidence(diagramIr: DiagramIr): DiagramIr {
  const add = (items?: Array<Record<string, unknown>>) => {
    for (const [index, item] of (items ?? []).entries()) {
      if (!Array.isArray(item.evidenceRefs) || item.evidenceRefs.length === 0) item.evidenceRefs = [`fixture:${diagramIr.title}:${index + 1}`]
    }
  }
  add(diagramIr.nodes)
  add(diagramIr.edges)
  add(diagramIr.regions)
  add(diagramIr.lanes)
  add(diagramIr.containers)
  return diagramIr
}

function node(id: string, label: string, visualRole: string, parent?: string) {
  return { id, label, visualRole, parent, evidenceRefs: [`ref:${id}`] }
}

function edge(id: string, source: string, target: string, label: string, pathRole: string, edgeKind: string) {
  return { id, source, target, label, pathRole, edgeKind, evidenceRefs: [`ref:${id}`] }
}

function pairwise(ids: readonly string[], prefix: string, pathRole: string, edgeKind: string) {
  const edges: ReturnType<typeof edge>[] = []
  for (let index = 0; index < ids.length - 1; index += 1) {
    const source = ids[index]
    const target = ids[index + 1]
    if (!source || !target) continue
    edges.push(edge(`${prefix}-${index + 1}`, source, target, `${source} -> ${target}`, pathRole, edgeKind))
  }
  return edges
}

function lane(id: string, label: string) {
  return { id, label, evidenceRefs: [`ref:${id}`] }
}

function region(id: string, label: string, parent?: string) {
  return { id, label, parent, evidenceRefs: [`ref:${id}`] }
}

function selectCases(filters: string[], defaultCases: DrawioVisualEvalCase[], socCases: DrawioVisualEvalCase[] = []) {
  if (filters.includes("all")) return defaultCases
  if (filters.includes("soc-suite")) return socCases
  const cases = [...defaultCases, ...socCases]
  const selected = new Set(filters.flatMap((filter) => filter.split(",")).map((filter) => filter.trim()).filter(Boolean))
  const result = cases.filter((item) => selected.has(item.id) || selected.has(item.category))
  const missing = Array.from(selected).filter((filter) => !cases.some((item) => item.id === filter || item.category === filter))
  if (missing.length) throw new Error(`Unknown draw.io visual eval case(s): ${missing.join(", ")}`)
  if (!result.length) throw new Error("No draw.io visual eval cases selected.")
  return result
}

function parseArgs(argv: string[]): EvalOptions {
  const options: EvalOptions = {
    cases: ["all"],
    review: "vision",
    outputRoot: DEFAULT_OUTPUT_ROOT,
    failUnder: DEFAULT_FAIL_UNDER,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const next = argv[index + 1]
    if (arg === "--cases") {
      options.cases = String(next || "all").split(",").map((item) => item.trim()).filter(Boolean)
      index += 1
    } else if (arg === "--review") {
      const mode = String(next || "vision")
      if (mode !== "vision" && mode !== "deterministic") throw new Error("--review must be vision or deterministic")
      options.review = mode
      index += 1
    } else if (arg === "--out") {
      options.outputRoot = String(next || DEFAULT_OUTPUT_ROOT)
      index += 1
    } else if (arg === "--fail-under") {
      const value = Number(next)
      if (!Number.isFinite(value) || value < 1 || value > 10) throw new Error("--fail-under must be a number between 1 and 10")
      options.failUnder = value
      index += 1
    } else if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  return options
}

function printHelp() {
  console.log([
    "Usage: bun scripts/drawio-visual-eval.ts --cases all --review vision",
    "",
    "Options:",
    "  --cases <all|soc-suite|case-id,...> Cases to run. all includes 5 public cases plus 2 canaries; soc-suite runs 3 SoC stress cases.",
    "  --review <vision|deterministic>  Vision uses OpenAI-compatible env vars; deterministic is local only.",
    "  --out <dir>                      Output root, default artifacts/drawio-visual-eval.",
    "  --fail-under <1-10>              Required score threshold, default 8.",
    "",
    "Vision env:",
    "  CHIPMATE_DIAGRAM_VISION_ENDPOINT",
    "  CHIPMATE_DIAGRAM_VISION_MODEL",
    "  CHIPMATE_DIAGRAM_VISION_API_KEY",
  ].join("\n"))
}

function assertVisionEnv() {
  const missing = [
    "CHIPMATE_DIAGRAM_VISION_ENDPOINT",
    "CHIPMATE_DIAGRAM_VISION_MODEL",
    "CHIPMATE_DIAGRAM_VISION_API_KEY",
  ].filter((key) => !process.env[key])
  if (missing.length) {
    throw new Error(`Vision review requires env var(s): ${missing.join(", ")}. Use --review deterministic for local metrics only; deterministic mode does not replace visual review.`)
  }
}

function visionEndpoint() {
  const raw = process.env.CHIPMATE_DIAGRAM_VISION_ENDPOINT || ""
  if (/\/chat\/completions\/?$/.test(raw)) return raw
  return `${raw.replace(/\/+$/, "")}/chat/completions`
}

function normalizeVisionReview(input: Partial<VisionReview>): VisionReview {
  return {
    readabilityScore: scoreValue(input.readabilityScore),
    flowClarityScore: scoreValue(input.flowClarityScore),
    textFitScore: scoreValue(input.textFitScore),
    edgeClutterScore: scoreValue(input.edgeClutterScore),
    legendUsefulnessScore: scoreValue(input.legendUsefulnessScore),
    deliveryReady: Boolean(input.deliveryReady),
    topIssues: Array.isArray(input.topIssues) ? input.topIssues.map(String).slice(0, 8) : [],
    suggestedGenericFixes: Array.isArray(input.suggestedGenericFixes) ? input.suggestedGenericFixes.map(String).slice(0, 8) : [],
  }
}

function scoreValue(value: unknown) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.max(1, Math.min(10, number)) : 1
}

function failedRecords(records: EvalRecord[], failUnder: number) {
  return records.filter((record) => {
    if (record.error || !record.metrics || !record.review) return true
    const review = record.review
    const average = averageReviewScore(review)
    return !review.deliveryReady || average < failUnder || record.metrics.fatalCount > 0
  })
}

function averageReviewScore(review: VisionReview) {
  return (review.readabilityScore + review.flowClarityScore + review.textFitScore + review.edgeClutterScore + review.legendUsefulnessScore) / 5
}

function isSocSuiteCase(evalCase: DrawioVisualEvalCase) {
  return evalCase.category === "soc-suite"
}

async function writeReport(runRoot: string, records: EvalRecord[], options: EvalOptions) {
  const rows = records.map((record) => {
    const caseDir = basename(record.outputDir)
    const drawioImage = existsSync(join(record.outputDir, "preview.png")) ? `![${record.case.id} draw.io](./${caseDir}/preview.png)` : "_no draw.io image_"
    const referenceImage = reportReferenceImage(record)
    const referenceTitle = isSocSuiteCase(record.case) ? "Target reference" : "Mermaid baseline"
    const score = record.review ? averageReviewScore(record.review).toFixed(1) : "n/a"
    const ready = record.review?.deliveryReady ? "yes" : "no"
    const fatal = record.metrics?.fatalCount ?? "n/a"
    const classification = record.metrics?.classification ?? "n/a"
    const topIssues = record.error || record.review?.topIssues.join("; ") || record.metrics?.warnings.join("; ") || "none"
    return [
      `### ${record.case.id}`,
      "",
      `| draw.io | ${referenceTitle} |`,
      "| --- | --- |",
      `| ${drawioImage} | ${referenceImage} |`,
      "",
      `- category: ${record.case.category}`,
      `- public: ${record.case.public ? "yes" : "canary"}`,
      `- review: ${options.review}`,
      `- average score: ${score}`,
      `- delivery ready: ${ready}`,
      `- fatal metrics: ${fatal}`,
      `- classification: ${classification}`,
      `- renderer focus: ${record.case.expectedRendererFocus.join(", ")}`,
      `- top issues: ${topIssues}`,
      `- suggested generic fixes: ${record.review?.suggestedGenericFixes.join("; ") || "none"}`,
      "",
      `Artifacts: [case.json](./${caseDir}/case.json), [generated.xml](./${caseDir}/generated.xml)${existsSync(join(record.outputDir, "mermaid.mmd")) ? `, [mermaid.mmd](./${caseDir}/mermaid.mmd)` : ""}, [normalizedSpec.json](./${caseDir}/normalizedSpec.json), [metrics.json](./${caseDir}/metrics.json), [review.json](./${caseDir}/review.json)`,
      "",
    ].join("\n")
  })
  const failed = failedRecords(records, options.failUnder)
  const content = [
    "# draw.io Visual Eval Report",
    "",
    `- run: ${basename(runRoot)}`,
    `- review mode: ${options.review}`,
    `- cases: ${records.length}`,
    `- failed: ${failed.length}`,
    `- fail under: ${options.failUnder}`,
    "",
    "## Contact Sheet",
    "",
    existsSync(join(runRoot, "contact-sheet.png")) ? "![contact sheet](./contact-sheet.png)" : "_contact sheet is generated after this report body_",
    "",
    "## Cases",
    "",
    ...rows,
  ].join("\n")
  await writeFile(join(runRoot, "report.md"), content)
}

function reportReferenceImage(record: EvalRecord) {
  if (isSocSuiteCase(record.case)) {
    const referenceImage = record.case.referenceImage ?? SOC_TARGET_REFERENCE_IMAGE
    return existsSync(referenceImage)
      ? `![target SoC reference](${referenceImage})`
      : `_missing target reference: ${referenceImage}_`
  }
  return existsSync(join(record.outputDir, "mermaid.png")) ? `![${record.case.id} Mermaid](./${basename(record.outputDir)}/mermaid.png)` : "_no Mermaid image_"
}

async function writeContactSheet(runRoot: string, records: EvalRecord[]) {
  const chromePath = findChrome()
  if (!chromePath) return
  const htmlPath = join(runRoot, "contact-sheet.html")
  const imageCards = records.map((record) => {
    const pngPath = join(record.outputDir, "preview.png")
    const mermaidPath = join(record.outputDir, "mermaid.png")
    const rel = pathToFileURL(pngPath).href
    const referencePath = isSocSuiteCase(record.case) ? (record.case.referenceImage ?? SOC_TARGET_REFERENCE_IMAGE) : mermaidPath
    const referenceRel = pathToFileURL(referencePath).href
    const referenceCaption = isSocSuiteCase(record.case) ? "Target reference" : "Mermaid"
    const score = record.review ? averageReviewScore(record.review).toFixed(1) : "n/a"
    return `<section><h2>${escapeHtml(record.case.id)} <span>${escapeHtml(score)}</span></h2><div class="pair"><figure><figcaption>draw.io</figcaption>${existsSync(pngPath) ? `<img src="${rel}">` : `<p>No image</p>`}</figure><figure><figcaption>${escapeHtml(referenceCaption)}</figcaption>${existsSync(referencePath) ? `<img src="${referenceRel}">` : `<p>No reference image</p>`}</figure></div></section>`
  }).join("\n")
  await writeFile(htmlPath, `<!doctype html><meta charset="utf-8"><style>
body{margin:0;background:#fff;color:#111827;font:14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.grid{display:grid;grid-template-columns:1fr;gap:18px;padding:24px}
section{border:1px solid #d1d5db;border-radius:12px;padding:12px;background:#fff;min-height:360px}
h2{font-size:15px;margin:0 0 8px;display:flex;justify-content:space-between}
.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px;align-items:start}
figure{margin:0}
figcaption{font-size:12px;font-weight:700;color:#475569;margin:0 0 6px}
img{display:block;max-width:100%;max-height:560px;object-fit:contain;margin:auto}
</style><div class="grid">${imageCards}</div>`)
  try {
    await captureContactSheetPng({
      chromePath,
      pageUrl: pathToFileURL(htmlPath).href,
      outputPath: join(runRoot, "contact-sheet.png"),
    })
  } catch (error) {
    await writeFile(join(runRoot, "contact-sheet-error.log"), error instanceof Error ? error.message : String(error))
  }
}

async function captureContactSheetPng(input: { chromePath: string; pageUrl: string; outputPath: string }) {
  const tempRoot = await mkdtemp(join(tmpdir(), "chipmate-drawio-contact-sheet-"))
  const chrome = spawn(input.chromePath, [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${join(tempRoot, "chrome-profile")}`,
    "about:blank",
  ], {
    stdio: ["ignore", "pipe", "pipe"],
  })
  let stderr = ""
  let stdout = ""
  chrome.stderr.setEncoding("utf8")
  chrome.stdout.setEncoding("utf8")
  chrome.stderr.on("data", (chunk) => { stderr += String(chunk) })
  chrome.stdout.on("data", (chunk) => { stdout += String(chunk) })
  try {
    const wsUrl = await waitForDevtoolsWsUrl(chrome, () => `${stderr}\n${stdout}`)
    const cdp = await ChromeCdpConnection.open(wsUrl)
    try {
      const target = await cdp.send<{ targetId: string }>("Target.createTarget", { url: input.pageUrl })
      const attached = await cdp.send<{ sessionId: string }>("Target.attachToTarget", { targetId: target.targetId, flatten: true })
      const sessionId = attached.sessionId
      await cdp.send("Page.enable", {}, sessionId)
      await cdp.send("Runtime.enable", {}, sessionId)
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const ready = await evaluateString(cdp, sessionId, "document.readyState")
        const imagesReady = await evaluateString(cdp, sessionId, "String(Array.from(document.images).every((img) => img.complete))")
        if (ready === "complete" && imagesReady === "true") break
        await delay(100)
      }
      const width = 1800
      const height = Math.max(900, Math.min(6000, await evaluateNumber(cdp, sessionId, "Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 2400)")))
      await cdp.send("Emulation.setDeviceMetricsOverride", {
        width,
        height,
        deviceScaleFactor: 1,
        mobile: false,
      }, sessionId)
      const screenshot = await cdp.send<{ data?: string }>("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true,
      }, sessionId)
      if (!screenshot.data) throw new Error("Chrome did not return contact sheet screenshot data.")
      await writeFile(input.outputPath, Buffer.from(screenshot.data, "base64"))
    } finally {
      await cdp.close().catch(() => undefined)
    }
  } finally {
    await terminateChrome(chrome)
    await rm(tempRoot, { recursive: true, force: true })
  }
}

function renderHtml(adapterUri: string, xml: string) {
  return `<!doctype html>
<meta charset="utf-8">
<body data-status="pending">pending</body>
<script>
const adapterUri = ${JSON.stringify(adapterUri)};
const xml = ${JSON.stringify(xml)};
const iframe = document.createElement("iframe");
iframe.src = adapterUri;
iframe.style.cssText = "position:absolute;width:1px;height:1px;left:-10000px;top:-10000px;";
document.body.appendChild(iframe);
const events = [];
function finish(status, detail) {
  document.body.setAttribute("data-status", status);
  document.body.textContent = detail || status;
}
setTimeout(() => finish("timeout", JSON.stringify(events)), 16000);
window.addEventListener("message", (event) => {
  const message = event.data || {};
  if (message.source !== "chipmate-drawio-runtime") return;
  events.push(message.event + ":" + (message.message || message.code || ""));
  if (message.event === "init") {
    iframe.contentWindow.postMessage({ source: "chipmate-chat", requestId: "load-1", action: "load", xml }, "*");
  } else if (message.event === "load") {
    iframe.contentWindow.postMessage({ source: "chipmate-chat", requestId: "export-1", action: "export", format: "xmlpng", scale: 2, border: 16, transparent: false, size: "diagram" }, "*");
  } else if (message.event === "export") {
    const data = String(message.data || "");
    finish(/^data:image\\/png;base64,/.test(data) ? "ok" : "bad-export", data);
  } else if (message.event === "error") {
    finish("error", message.code + ":" + message.message);
  }
});
</script>`
}

function renderMermaidHtml(mermaidUri: string, source: string) {
  return `<!doctype html>
<meta charset="utf-8">
<body data-status="pending">pending</body>
<script type="module">
const source = ${JSON.stringify(source)};
function finish(status, detail) {
  document.body.setAttribute("data-status", status);
  if (status !== "ok") document.body.textContent = detail || status;
}
try {
  const mermaid = (await import(${JSON.stringify(mermaidUri)})).default;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "default",
    flowchart: { curve: "basis", htmlLabels: false, nodeSpacing: 48, rankSpacing: 68 }
  });
  const result = await mermaid.render("chipmate_mermaid_eval", source);
  const container = document.createElement("div");
  container.style.cssText = "position:absolute;left:0;top:0;background:white;padding:16px;";
  container.innerHTML = result.svg;
  document.body.innerHTML = "";
  document.body.appendChild(container);
  const svg = container.querySelector("svg");
  if (!svg) throw new Error("Mermaid did not render an SVG.");
  const box = svg.getBBox();
  const width = Math.ceil(Math.max(box.width + 48, svg.viewBox.baseVal.width || 1));
  const height = Math.ceil(Math.max(box.height + 48, svg.viewBox.baseVal.height || 1));
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  finish("ok", "Mermaid SVG ready.");
} catch (error) {
  finish("error", error && error.message ? error.message : String(error));
}
setTimeout(() => {
  if (document.body.getAttribute("data-status") === "pending") finish("timeout", "Mermaid render timed out.");
}, 16000);
</script>`
}

function mermaidSourceForCase(evalCase: DrawioVisualEvalCase) {
  const ir = evalCase.diagramIr
  const direction = `${ir.visualPlan?.mainBackbone?.direction ?? ""}`.toLowerCase()
  const graphDirection = direction === "right" || direction === "horizontal" ? "LR" : "TD"
  const nodeRecords = (ir.nodes ?? []).map((node) => asDiagramRecord(node)).filter(Boolean) as Array<Record<string, unknown>>
  const edgeRecords = (ir.edges ?? []).map((edge) => asDiagramRecord(edge)).filter(Boolean) as Array<Record<string, unknown>>
  const nodeIds = new Set(nodeRecords.map((node) => String(node.id ?? "")))
  const edgePresentation = ir.visualPlan?.edgePresentation ?? {}
  const edgeLines = edgeRecords.flatMap((edge) => {
    const id = String(edge.id ?? "")
    const source = String(edge.source ?? "")
    const target = String(edge.target ?? "")
    if (!source || !target || !nodeIds.has(source) || !nodeIds.has(target)) return []
    const presentation = edgePresentation[id]
    if (presentation?.mode === "legend") return []
    const label = mermaidEdgeLabel(String(presentation?.marker || edge.label || ""))
    const arrow = presentation?.mode === "rail" ? "-.->" : "-->"
    const labelPart = label ? `|${label}|` : ""
    return [`  ${mermaidId(source)} ${arrow}${labelPart} ${mermaidId(target)}`]
  })
  const regions = [
    ...(ir.regions ?? []),
    ...(ir.lanes ?? []),
    ...(ir.containers ?? []),
  ].map((item) => asDiagramRecord(item)).filter(Boolean) as Array<Record<string, unknown>>
  const owned = new Map<string, string[]>()
  for (const node of nodeRecords) {
    const owner = String(node.parent ?? node.container ?? node.lane ?? node.region ?? node.group ?? "")
    if (!owner) continue
    const list = owned.get(owner) ?? []
    list.push(String(node.id ?? ""))
    owned.set(owner, list)
  }
  const subgraphLines: string[] = []
  const emittedNodes = new Set<string>()
  for (const region of regions) {
    const id = String(region.id ?? "")
    const children = owned.get(id)?.filter((nodeId) => nodeIds.has(nodeId)) ?? []
    if (!children.length) continue
    subgraphLines.push(`  subgraph ${mermaidId(`region-${id}`)}[${mermaidLabel(String(region.label ?? region.title ?? id))}]`)
    for (const nodeId of children) {
      const node = nodeRecords.find((candidate) => candidate.id === nodeId)
      if (!node) continue
      emittedNodes.add(nodeId)
      subgraphLines.push(`    ${mermaidNodeLine(node, "    ")}`)
    }
    subgraphLines.push("  end")
  }
  return [
    `flowchart ${graphDirection}`,
    ...subgraphLines,
    ...nodeRecords.filter((node) => !emittedNodes.has(String(node.id ?? ""))).map((node) => mermaidNodeLine(node, "  ")),
    ...edgeLines,
  ].join("\n")
}

function mermaidNodeLine(node: Record<string, unknown>, indent: string) {
  const id = mermaidId(String(node.id ?? "node"))
  const label = mermaidLabel(String(node.label ?? node.title ?? node.id ?? "node"))
  const role = compactMermaidKey(String(node.visualRole ?? node.role ?? node.type ?? ""))
  if (role.includes("decision")) return `${indent}${id}{${label}}`
  if (role.includes("state")) return `${indent}${id}([${label}])`
  return `${indent}${id}[${label}]`
}

function asDiagramRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function mermaidId(input: string) {
  const value = input.normalize("NFKD").replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 80)
  return `m_${value || "node"}`
}

function mermaidLabel(input: string) {
  return JSON.stringify(input.replace(/<br\s*\/?>/gi, "\n").replace(/[{}[\]()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 80))
}

function mermaidEdgeLabel(input: string) {
  return input.replace(/[|<>{}[\]"]/g, " ").replace(/\s+/g, " ").trim().slice(0, 28)
}

function compactMermaidKey(input: string) {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, "")
}

function dataUriFromDump(output: string) {
  const match = /data:image\/png;base64,[A-Za-z0-9+/=]+/.exec(output)
  if (!match) throw new Error(`No PNG data URI found in Chrome output.\n${bounded(output)}`)
  return match[0]
}

function primaryGraphNodes(nodes: NormalizedNode[], generated: DrawioGeneratedDiagram) {
  const backbone = generated.normalizedSpec.visualPlan?.mainBackbone?.nodes ?? []
  if (!backbone.length) return nodes.filter((node) => !isLegendNode(node))
  const bySource = new Map(nodes.map((node) => [node.sourceId ?? node.id, node]))
  return backbone.map((id) => bySource.get(id)).filter((node): node is NormalizedNode => Boolean(node))
}

function countNodeOverlaps(nodes: NormalizedNode[]) {
  let count = 0
  for (let outer = 0; outer < nodes.length; outer += 1) {
    for (let inner = outer + 1; inner < nodes.length; inner += 1) {
      const a = nodes[outer]
      const b = nodes[inner]
      if (!a || !b || a.parent !== b.parent) continue
      if (intersectionArea(a.geometry, b.geometry) > 80) count += 1
    }
  }
  return count
}

function countContainerOverlaps(containers: NormalizedContainer[]) {
  let count = 0
  for (let outer = 0; outer < containers.length; outer += 1) {
    for (let inner = outer + 1; inner < containers.length; inner += 1) {
      const a = containers[outer]
      const b = containers[inner]
      if (!a || !b || a.parent !== b.parent) continue
      const area = intersectionArea(a.geometry, b.geometry)
      if (area <= 120) continue
      const overlapWidth = Math.max(0, Math.min(a.geometry.x + a.geometry.width, b.geometry.x + b.geometry.width) - Math.max(a.geometry.x, b.geometry.x))
      const overlapHeight = Math.max(0, Math.min(a.geometry.y + a.geometry.height, b.geometry.y + b.geometry.height) - Math.max(a.geometry.y, b.geometry.y))
      if (overlapWidth <= 6 || overlapHeight <= 6) continue
      if (mostlyContains(a.geometry, b.geometry) || mostlyContains(b.geometry, a.geometry)) continue
      count += 1
    }
  }
  return count
}

function mostlyContains(outer: Geometry, inner: Geometry) {
  const area = Math.max(1, inner.width * inner.height)
  return intersectionArea(outer, inner) / area > 0.92
}

function textOverflowRisk(node: NormalizedNode) {
  const lines = String(node.label || "").split(/\n/)
  if (/horizontal=0/i.test(node.style)) {
    const maxLine = Math.max(...lines.map(weightedTextLength), 0)
    const verticalCapacity = Math.max(8, node.geometry.height / 7.2)
    const widthLineCapacity = Math.max(1, Math.floor((node.geometry.width - 10) / 12))
    return maxLine > verticalCapacity * 1.2 || lines.length > widthLineCapacity + 1
  }
  const maxLine = Math.max(...lines.map(weightedTextLength), 0)
  const capacity = Math.max(8, node.geometry.width / 7.2)
  const heightCapacity = Math.max(1, Math.floor((node.geometry.height - 18) / 18))
  return maxLine > capacity * 1.2 || lines.length > heightCapacity + 1
}

function countNarrowContainerLabelRisks(containers: NormalizedContainer[]) {
  return containers.filter((container) => {
    if (container.geometry.width > 120 || container.geometry.height < container.geometry.width * 2.2) return false
    const style = container.style.toLowerCase()
    return !/horizontal=0/.test(style) || !/labelposition=(?:left|right)/.test(style)
  }).length
}

function countNodeContainerBoundaryViolations(nodes: NormalizedNode[], containers: NormalizedContainer[]) {
  const byId = new Map(containers.map((container) => [container.id, container]))
  let count = 0
  for (const nodeItem of nodes) {
    const container = byId.get(nodeItem.parent)
    if (!container || isLegendNode(nodeItem) || isLegendContainer(container)) continue
    const margin = container.geometry.width <= 120 ? 1 : 4
    if (nodeItem.geometry.x < container.geometry.x + margin ||
      nodeItem.geometry.y < container.geometry.y + margin ||
      nodeItem.geometry.x + nodeItem.geometry.width > container.geometry.x + container.geometry.width - margin ||
      nodeItem.geometry.y + nodeItem.geometry.height > container.geometry.y + container.geometry.height - margin) {
      count += 1
    }
  }
  return count
}

function countNodeUnownedContainerOverlaps(nodes: NormalizedNode[], containers: NormalizedContainer[]) {
  const containerById = new Map(containers.map((container) => [container.id, container]))
  let count = 0
  for (const nodeItem of nodes) {
    if (isVisualJunctionNode(nodeItem)) continue
    const nodeArea = Math.max(1, nodeItem.geometry.width * nodeItem.geometry.height)
    for (const container of containers) {
      if (isLegendContainer(container) || nodeItem.parent === container.id || nodeItem.ownerContainer === container.id) continue
      const area = intersectionArea(nodeItem.geometry, container.geometry)
      if (area <= 80) continue
      if (area / nodeArea > 0.92 && nodeIsOwnedByContainerInside(container, nodeItem, containerById)) continue
      count += 1
    }
  }
  return count
}

function nodeIsOwnedByContainerInside(container: NormalizedContainer, nodeItem: NormalizedNode, containerById: Map<string, NormalizedContainer>) {
  const owner = containerById.get(nodeItem.parent) ?? (nodeItem.ownerContainer ? containerById.get(nodeItem.ownerContainer) : undefined)
  return Boolean(owner && owner.id !== container.id && mostlyContains(container.geometry, owner.geometry))
}

function countRailCollinearOverlaps(edges: NormalizedEdge[]) {
  let count = 0
  const segments: Array<{ edgeId: string; orientation: "v" | "h"; fixed: number; min: number; max: number }> = []
  for (const edge of edges) {
    for (let index = 0; index < edge.points.length - 1; index += 1) {
      const start = finitePoint(edge.points[index])
      const end = finitePoint(edge.points[index + 1])
      if (!start || !end) continue
      if (Math.abs(start.x - end.x) <= 1) segments.push({ edgeId: edge.id, orientation: "v", fixed: Math.round(start.x), min: Math.min(start.y, end.y), max: Math.max(start.y, end.y) })
      if (Math.abs(start.y - end.y) <= 1) segments.push({ edgeId: edge.id, orientation: "h", fixed: Math.round(start.y), min: Math.min(start.x, end.x), max: Math.max(start.x, end.x) })
    }
  }
  for (let outer = 0; outer < segments.length; outer += 1) {
    for (let inner = outer + 1; inner < segments.length; inner += 1) {
      const a = segments[outer]
      const b = segments[inner]
      if (!a || !b || a.edgeId === b.edgeId || a.orientation !== b.orientation || Math.abs(a.fixed - b.fixed) > 4) continue
      if (Math.min(a.max, b.max) - Math.max(a.min, b.min) > 36) count += 1
    }
  }
  return count
}

function countEdgeIntersections(nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  const segments = edgeSegments(nodes, edges)
  let count = 0
  for (let outer = 0; outer < segments.length; outer += 1) {
    for (let inner = outer + 1; inner < segments.length; inner += 1) {
      const a = segments[outer]
      const b = segments[inner]
      if (!a || !b || a.edgeId === b.edgeId) continue
      if (a.source === b.source || a.source === b.target || a.target === b.source || a.target === b.target) continue
      if (lineSegmentsIntersect(a.start, a.end, b.start, b.end)) count += 1
    }
  }
  return count
}

function countSocVisibleLowPriorityEdgeLabels(edges: NormalizedEdge[]) {
  return edges.filter((edgeItem) => {
    if (!String(edgeItem.label || "").trim()) return false
    if (edgeItem.presentationMode === "legend") return false
    const priority = String(edgeItem.labelPriority || "").toLowerCase()
    return priority !== "high"
  }).length
}

function countShortHeavyArrows(nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let count = 0
  for (const edgeItem of edges) {
    if (!edgeItem.source || !edgeItem.target) continue
    const source = byId.get(edgeItem.source)
    const target = byId.get(edgeItem.target)
    if (!source || !target) continue
    const strokeWidth = parsedStyleNumber(edgeItem.style, "strokeWidth")
    if (strokeWidth < 5) continue
    const innerPoints = edgeItem.points.map(finitePoint).filter((point): point is { x: number; y: number } => Boolean(point))
    const length = polylineLength(edgeRoutePoints(source.geometry, target.geometry, innerPoints))
    if (length > 0 && length < 132) count += 1
  }
  return count
}

function countSocContainerHorizontalFillRisks(nodes: NormalizedNode[], containers: NormalizedContainer[]) {
  let count = 0
  for (const container of containers) {
    if (container.geometry.width <= 120 && container.geometry.height >= container.geometry.width * 2.2) continue
    const owned = nodes.filter((nodeItem) => nodeItem.parent === container.id && !isLegendNode(nodeItem))
    if (owned.length < 3) continue
    const columns = clusterHorizontalColumns(owned)
    if (columns.length < 3) continue
    const padding = Math.max(28, Math.min(54, container.geometry.width * 0.055))
    const usableWidth = container.geometry.width - padding * 2
    if (usableWidth <= 260) continue
    const bounds = boundsForNodes(owned)
    const rightUnused = container.geometry.x + container.geometry.width - padding - (bounds.x + bounds.width)
    if (bounds.width < usableWidth * 0.78 && rightUnused > 76) count += 1
  }
  return count
}

function countSocBusContainerAlignmentRisks(nodes: NormalizedNode[], containers: NormalizedContainer[], edges: NormalizedEdge[]) {
  const nodesById = new Map(nodes.map((nodeItem) => [nodeItem.id, nodeItem]))
  const containersById = new Map(containers.map((container) => [container.id, container]))
  let count = 0
  for (const edgeItem of edges) {
    if (!edgeIsBusLike(edgeItem) || !edgeItem.source || !edgeItem.target) continue
    const source = nodesById.get(edgeItem.source)
    const target = nodesById.get(edgeItem.target)
    if (!source || !target || source.parent === target.parent) continue
    const sourceContainer = containersById.get(source.parent)
    const targetContainer = containersById.get(target.parent)
    if (!sourceContainer || !targetContainer) continue
    const sourceCenter = centerOf(source.geometry)
    const targetCenter = centerOf(target.geometry)
    if (Math.abs(sourceCenter.x - targetCenter.x) + Math.abs(sourceCenter.y - targetCenter.y) < 420) continue
    const points = edgeItem.points.filter(finitePoint)
    if (points.length < 3) continue
    const horizontal = Math.abs(sourceCenter.x - targetCenter.x) >= Math.abs(sourceCenter.y - targetCenter.y)
    const sourceAligned = points.some((point) => pointAlignsWithContainerBusLane(point, sourceContainer.geometry, horizontal))
    const targetAligned = points.some((point) => pointAlignsWithContainerBusLane(point, targetContainer.geometry, horizontal))
    if (!sourceAligned || !targetAligned) count += 1
  }
  return count
}

function countBusEndpointAmbiguities(generated: DrawioGeneratedDiagram, endpoint: "source" | "target") {
  const grouped = groupedVisualPlanBusEdges(generated)
  const byEndpoint = new Map<string, string[]>()
  for (const edgeItem of generated.normalizedSpec.edges) {
    if (!isVisibleBusLikeEdge(edgeItem) || isVisualBusRenderEdge(edgeItem)) continue
    const key = endpoint === "source" ? edgeItem.source : edgeItem.target
    if (!key || grouped.has(edgeItem.sourceId || edgeItem.id)) continue
    const list = byEndpoint.get(key) ?? []
    list.push(edgeItem.id)
    byEndpoint.set(key, list)
  }
  return [...byEndpoint.values()].filter((edgeIds) => edgeIds.length >= 2).length
}

function countPseudoSelfLoopRisks(nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  const byId = new Map(nodes.map((nodeItem) => [nodeItem.id, nodeItem]))
  let count = 0
  for (const edgeItem of edges) {
    if (!isVisibleBusLikeEdge(edgeItem) || isVisualBusRenderEdge(edgeItem) || !edgeItem.source || !edgeItem.target || edgeItem.source === edgeItem.target) continue
    const source = byId.get(edgeItem.source)
    const target = byId.get(edgeItem.target)
    if (!source || !target) continue
    const points = edgeRoutePoints(source.geometry, target.geometry, edgeItem.points.map(finitePoint).filter((point): point is { x: number; y: number } => Boolean(point)))
    if (points.length < 4) continue
    const sourceBox = inflate(source.geometry, 24)
    const targetBox = inflate(target.geometry, 24)
    for (let index = 1; index < points.length - 2; index += 1) {
      const start = points[index]
      const end = points[index + 1]
      if (!start || !end) continue
      const returnsToSourceAfterLeaving = index > 1 && segmentIntersectsBox(start, end, sourceBox)
      const reachesTargetBeforeFinalApproach = index < points.length - 3 && segmentIntersectsBox(start, end, targetBox)
      if (returnsToSourceAfterLeaving || reachesTargetBeforeFinalApproach) {
        count += 1
        break
      }
    }
  }
  return count
}

function countSharedPortOverlaps(nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  const byId = new Map(nodes.map((nodeItem) => [nodeItem.id, nodeItem]))
  const endpointSegments: Array<{ endpoint: string; orientation: "h" | "v"; fixed: number; min: number; max: number; edgeId: string }> = []
  for (const edgeItem of edges) {
    if (!isVisibleBusLikeEdge(edgeItem) || isVisualBusRenderEdge(edgeItem) || !edgeItem.source || !edgeItem.target) continue
    const source = byId.get(edgeItem.source)
    const target = byId.get(edgeItem.target)
    if (!source || !target) continue
    const route = edgeRoutePoints(source.geometry, target.geometry, edgeItem.points.map(finitePoint).filter((point): point is { x: number; y: number } => Boolean(point)))
    const first = route[0]
    const second = route[1]
    const penultimate = route[route.length - 2]
    const last = route[route.length - 1]
    addEndpointSegment(endpointSegments, edgeItem.source, edgeItem.id, first, second)
    addEndpointSegment(endpointSegments, edgeItem.target, edgeItem.id, penultimate, last)
  }
  let count = 0
  for (let outer = 0; outer < endpointSegments.length; outer += 1) {
    for (let inner = outer + 1; inner < endpointSegments.length; inner += 1) {
      const a = endpointSegments[outer]
      const b = endpointSegments[inner]
      if (!a || !b || a.edgeId === b.edgeId || a.endpoint !== b.endpoint || a.orientation !== b.orientation || Math.abs(a.fixed - b.fixed) > 4) continue
      if (Math.min(a.max, b.max) - Math.max(a.min, b.min) > 24) count += 1
    }
  }
  return count
}

function addEndpointSegment(
  segments: Array<{ endpoint: string; orientation: "h" | "v"; fixed: number; min: number; max: number; edgeId: string }>,
  endpoint: string | undefined,
  edgeId: string,
  start: { x: number; y: number } | undefined,
  end: { x: number; y: number } | undefined,
) {
  if (!endpoint || !start || !end) return
  if (Math.abs(start.x - end.x) <= 1) segments.push({ endpoint, edgeId, orientation: "v", fixed: Math.round(start.x), min: Math.min(start.y, end.y), max: Math.max(start.y, end.y) })
  if (Math.abs(start.y - end.y) <= 1) segments.push({ endpoint, edgeId, orientation: "h", fixed: Math.round(start.y), min: Math.min(start.x, end.x), max: Math.max(start.x, end.x) })
}

function countBusTrunkAlignmentRisks(nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  const byId = new Map(nodes.map((nodeItem) => [nodeItem.id, nodeItem]))
  let count = 0
  for (const edgeItem of edges) {
    if (edgeItem.pathRole !== "bus-trunk" || !edgeItem.source || !edgeItem.target) continue
    const source = byId.get(edgeItem.source)
    const target = byId.get(edgeItem.target)
    if (!source || !target) continue
    const route = edgeRoutePoints(source.geometry, target.geometry, edgeItem.points.map(finitePoint).filter((point): point is { x: number; y: number } => Boolean(point)))
    const crooked = route.length > 3 || route.some((point, index) => {
      const next = route[index + 1]
      return next && Math.abs(point.x - next.x) > 1 && Math.abs(point.y - next.y) > 1
    })
    if (crooked) count += 1
  }
  return count
}

function countUnexplainedHeavyBuses(generated: DrawioGeneratedDiagram, edges: NormalizedEdge[]) {
  const grouped = groupedVisualPlanBusEdges(generated)
  return edges.filter((edgeItem) => {
    if (!isVisibleBusLikeEdge(edgeItem) || isVisualBusRenderEdge(edgeItem)) return false
    if (grouped.has(edgeItem.sourceId || edgeItem.id)) return false
    return parsedStyleNumber(edgeItem.style, "strokeWidth") >= 5
  }).length
}

function groupedVisualPlanBusEdges(generated: DrawioGeneratedDiagram) {
  const grouped = new Set<string>()
  for (const bus of generated.normalizedSpec.visualPlan?.buses ?? []) {
    for (const edgeId of bus.edges ?? []) grouped.add(edgeId)
  }
  return grouped
}

function isVisibleBusLikeEdge(edgeItem: NormalizedEdge) {
  return edgeItem.presentationMode !== "legend" && edgeIsBusLike(edgeItem)
}

function isVisualBusRenderEdge(edgeItem: NormalizedEdge) {
  return edgeItem.pathRole === "bus-trunk" || edgeItem.pathRole === "bus-branch" || String(edgeItem.sourceId || "").startsWith("visual-bus:")
}

function edgeIsBusLike(edgeItem: NormalizedEdge) {
  return String(edgeItem.edgeKind || "").toLowerCase() === "bus" || String(edgeItem.pathRole || "").toLowerCase() === "bus"
}

function pointAlignsWithContainerBusLane(point: { x: number; y: number }, container: Geometry, horizontal: boolean) {
  const nearBoundaryTolerance = 64
  const outerLaneMin = 16
  const outerLaneMax = 112
  if (horizontal) {
    const nearVerticalBoundary = nearAny(point.x, [container.x, container.x + container.width], nearBoundaryTolerance)
    const aboveOuterLane = point.y <= container.y - outerLaneMin && point.y >= container.y - outerLaneMax
    const belowOuterLane = point.y >= container.y + container.height + outerLaneMin && point.y <= container.y + container.height + outerLaneMax
    return nearVerticalBoundary || aboveOuterLane || belowOuterLane
  }
  const nearHorizontalBoundary = nearAny(point.y, [container.y, container.y + container.height], nearBoundaryTolerance)
  const leftOuterLane = point.x <= container.x - outerLaneMin && point.x >= container.x - outerLaneMax
  const rightOuterLane = point.x >= container.x + container.width + outerLaneMin && point.x <= container.x + container.width + outerLaneMax
  return nearHorizontalBoundary || leftOuterLane || rightOuterLane
}

function centerOf(geometry: Geometry) {
  return {
    x: geometry.x + geometry.width / 2,
    y: geometry.y + geometry.height / 2,
  }
}

function nearAny(value: number, candidates: number[], tolerance: number) {
  return candidates.some((candidate) => Math.abs(value - candidate) <= tolerance)
}

function clusterHorizontalColumns(nodes: NormalizedNode[]) {
  const sorted = nodes
    .map((nodeItem) => ({ node: nodeItem, centerX: nodeItem.geometry.x + nodeItem.geometry.width / 2 }))
    .sort((left, right) => left.centerX - right.centerX)
  const widthMedian = medianValue(nodes.map((nodeItem) => nodeItem.geometry.width))
  const threshold = Math.max(42, Math.min(76, widthMedian * 0.72))
  const columns: Array<{ centerX: number; nodes: NormalizedNode[] }> = []
  for (const item of sorted) {
    const column = columns.find((candidate) => Math.abs(candidate.centerX - item.centerX) <= threshold)
    if (column) {
      column.nodes.push(item.node)
      column.centerX = column.nodes.reduce((sum, nodeItem) => sum + nodeItem.geometry.x + nodeItem.geometry.width / 2, 0) / column.nodes.length
    } else {
      columns.push({ centerX: item.centerX, nodes: [item.node] })
    }
  }
  return columns
}

function medianValue(values: number[]) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right)
  if (!sorted.length) return 40
  return sorted[Math.floor(sorted.length / 2)] ?? 40
}

function countLegendOverlaps(legend: NormalizedContainer, nodes: NormalizedNode[], containers: NormalizedContainer[]) {
  let count = 0
  for (const nodeItem of nodes) {
    if (intersectionArea(legend.geometry, nodeItem.geometry) > 80) count += 1
  }
  for (const container of containers) {
    if (container.id === legend.id) continue
    if (intersectionArea(legend.geometry, container.geometry) > 120) count += 1
  }
  return count
}

function countUnnecessaryBends(nodes: NormalizedNode[], containers: NormalizedContainer[], edges: NormalizedEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let count = 0
  for (const edgeItem of edges) {
    if (edgeItem.presentationMode !== "line" || !edgeItem.source || !edgeItem.target) continue
    const source = byId.get(edgeItem.source)
    const target = byId.get(edgeItem.target)
    if (!source || !target) continue
    const sourceCenter = center(source.geometry)
    const targetCenter = center(target.geometry)
    const vertical = Math.abs(sourceCenter.x - targetCenter.x) <= 24
    const horizontal = Math.abs(sourceCenter.y - targetCenter.y) <= 24
    if (!vertical && !horizontal) continue
    const axisPoint = { x: (sourceCenter.x + targetCenter.x) / 2, y: (sourceCenter.y + targetCenter.y) / 2 }
    const directRoute = edgeRoutePoints(source.geometry, target.geometry, [axisPoint])
    if (routeIntersectsObstacle(directRoute, nodes, containers, edgeItem.source, edgeItem.target, source, target)) continue
    const fullRoute = edgeRoutePoints(source.geometry, target.geometry, edgeItem.points.map(finitePoint).filter((point): point is { x: number; y: number } => Boolean(point)))
    if (fullRoute.some((point) => vertical ? Math.abs(point.x - axisPoint.x) > 18 : Math.abs(point.y - axisPoint.y) > 18)) count += 1
  }
  return count
}

function countShortJogs(nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let count = 0
  for (const edgeItem of edges) {
    if (!edgeItem.source || !edgeItem.target) continue
    const source = byId.get(edgeItem.source)
    const target = byId.get(edgeItem.target)
    if (!source || !target) continue
    const innerPoints = edgeItem.points.map(finitePoint).filter((point): point is { x: number; y: number } => Boolean(point))
    const points = edgeRoutePoints(source.geometry, target.geometry, innerPoints)
    for (let index = 1; index < points.length - 2; index += 1) {
      const a = points[index - 1]
      const b = points[index]
      const c = points[index + 1]
      const d = points[index + 2]
      if (!a || !b || !c || !d) continue
      const middle = Math.abs(c.x - b.x) + Math.abs(c.y - b.y)
      if (middle <= 0 || middle > 24) continue
      const beforeHorizontal = Math.abs(a.y - b.y) <= 1 && Math.abs(a.x - b.x) > 48
      const afterHorizontal = Math.abs(c.y - d.y) <= 1 && Math.abs(c.x - d.x) > 48
      const beforeVertical = Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) > 48
      const afterVertical = Math.abs(c.x - d.x) <= 1 && Math.abs(c.y - d.y) > 48
      if ((beforeHorizontal && afterHorizontal) || (beforeVertical && afterVertical)) count += 1
    }
  }
  return count
}

function routeIntersectsObstacle(
  route: Array<{ x: number; y: number }>,
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
    if (!start || !end) continue
    for (const nodeItem of nodes) {
      if (nodeItem.id === sourceId || nodeItem.id === targetId || isLegendNode(nodeItem)) continue
      if (segmentIntersectsBox(start, end, inflate(nodeItem.geometry, 4))) return true
    }
    for (const container of containers) {
      if (isLegendContainer(container) || edgeEndpointBelongsToContainer(source, container) || edgeEndpointBelongsToContainer(target, container)) continue
      if (segmentIntersectsBox(start, end, inflate(container.geometry, 4))) return true
    }
  }
  return false
}

function countEdgePassThroughs(nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let count = 0
  for (const edgeItem of edges) {
    if (!edgeItem.source || !edgeItem.target) continue
    const source = byId.get(edgeItem.source)
    const target = byId.get(edgeItem.target)
    if (!source || !target) continue
    const innerPoints = edgeItem.points.map(finitePoint).filter((point): point is { x: number; y: number } => Boolean(point))
    const points = edgeRoutePoints(source.geometry, target.geometry, innerPoints)
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index]
      const end = points[index + 1]
      if (!start || !end) continue
      for (const nodeItem of nodes) {
        if (nodeItem.id === edgeItem.source || nodeItem.id === edgeItem.target) continue
        if (segmentIntersectsBox(start, end, inflate(nodeItem.geometry, 4))) count += 1
      }
    }
  }
  return count
}

function countEdgeContainerPassThroughs(nodes: NormalizedNode[], containers: NormalizedContainer[], edges: NormalizedEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  let count = 0
  for (const edgeItem of edges) {
    if (!edgeItem.source || !edgeItem.target) continue
    const source = byId.get(edgeItem.source)
    const target = byId.get(edgeItem.target)
    if (!source || !target) continue
    const innerPoints = edgeItem.points.map(finitePoint).filter((point): point is { x: number; y: number } => Boolean(point))
    const points = edgeRoutePoints(source.geometry, target.geometry, innerPoints)
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index]
      const end = points[index + 1]
      if (!start || !end) continue
      for (const container of containers) {
        if (edgeEndpointBelongsToContainer(source, container) || edgeEndpointBelongsToContainer(target, container)) continue
        if (segmentIntersectsBox(start, end, inflate(container.geometry, 3))) count += 1
      }
    }
  }
  return count
}

function edgeEndpointBelongsToContainer(node: NormalizedNode, container: NormalizedContainer) {
  return node.parent === container.id ||
    node.ownerContainer === container.id ||
    pointInsideBox(center(node.geometry), inflate(container.geometry, 2))
}

function edgeSegments(nodes: NormalizedNode[], edges: NormalizedEdge[]) {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const segments: Array<{ edgeId: string; source: string; target: string; start: { x: number; y: number }; end: { x: number; y: number } }> = []
  for (const edgeItem of edges) {
    if (!edgeItem.source || !edgeItem.target) continue
    const source = byId.get(edgeItem.source)
    const target = byId.get(edgeItem.target)
    if (!source || !target) continue
    const innerPoints = edgeItem.points.map(finitePoint).filter((point): point is { x: number; y: number } => Boolean(point))
    const points = edgeRoutePoints(source.geometry, target.geometry, innerPoints)
    for (let index = 0; index < points.length - 1; index += 1) {
      const start = points[index]
      const end = points[index + 1]
      if (!start || !end) continue
      segments.push({ edgeId: edgeItem.id, source: edgeItem.source, target: edgeItem.target, start, end })
    }
  }
  return segments
}

function blankRatio(nodes: NormalizedNode[], bounds: Geometry) {
  const boundsArea = Math.max(1, bounds.width * bounds.height)
  const nodeArea = nodes.reduce((sum, nodeItem) => sum + nodeItem.geometry.width * nodeItem.geometry.height, 0)
  return Math.max(0, Math.min(1, 1 - nodeArea / boundsArea))
}

function centerDistanceRatio(a: Geometry, b: Geometry) {
  if (b.width <= 0 || b.height <= 0) return 0
  const ac = center(a)
  const bc = center(b)
  const diagonal = Math.sqrt(b.width * b.width + b.height * b.height) || 1
  return Math.sqrt((ac.x - bc.x) ** 2 + (ac.y - bc.y) ** 2) / diagonal
}

function boundsForNodes(nodes: NormalizedNode[]): Geometry {
  return boundsForGeometries(nodes.map((node) => node.geometry))
}

function boundsForGeometries(geometries: Geometry[]): Geometry {
  if (!geometries.length) return { x: 0, y: 0, width: 0, height: 0 }
  const minX = Math.min(...geometries.map((geometry) => geometry.x))
  const minY = Math.min(...geometries.map((geometry) => geometry.y))
  const maxX = Math.max(...geometries.map((geometry) => geometry.x + geometry.width))
  const maxY = Math.max(...geometries.map((geometry) => geometry.y + geometry.height))
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function intersectionArea(a: Geometry, b: Geometry) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x))
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
  return width * height
}

function segmentIntersectsBox(start: { x: number; y: number }, end: { x: number; y: number }, box: Geometry) {
  if (pointInsideBox(start, box) || pointInsideBox(end, box)) return true
  const corners = [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
  ]
  return lineSegmentsIntersect(start, end, corners[0], corners[1]) ||
    lineSegmentsIntersect(start, end, corners[1], corners[2]) ||
    lineSegmentsIntersect(start, end, corners[2], corners[3]) ||
    lineSegmentsIntersect(start, end, corners[3], corners[0])
}

function lineSegmentsIntersect(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }) {
  const det = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x)
  if (Math.abs(det) < 1e-6) return false
  const lambda = ((d.y - c.y) * (d.x - a.x) + (c.x - d.x) * (d.y - a.y)) / det
  const gamma = ((a.y - b.y) * (d.x - a.x) + (b.x - a.x) * (d.y - a.y)) / det
  return lambda > 0 && lambda < 1 && gamma > 0 && gamma < 1
}

function pointInsideBox(point: { x: number; y: number }, box: Geometry) {
  return point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height
}

function inflate(geometry: Geometry, amount: number): Geometry {
  return {
    x: geometry.x - amount,
    y: geometry.y - amount,
    width: geometry.width + amount * 2,
    height: geometry.height + amount * 2,
  }
}

function center(geometry: Geometry) {
  return {
    x: geometry.x + geometry.width / 2,
    y: geometry.y + geometry.height / 2,
  }
}

function edgeRoutePoints(source: Geometry, target: Geometry, points: Array<{ x: number; y: number }>) {
  const firstToward = points[0] ?? center(target)
  const lastToward = points[points.length - 1] ?? center(source)
  return [
    boundaryPointToward(source, firstToward),
    ...points,
    boundaryPointToward(target, lastToward),
  ]
}

function boundaryPointToward(box: Geometry, target: { x: number; y: number }) {
  const boxCenter = center(box)
  const dx = target.x - boxCenter.x
  const dy = target.y - boxCenter.y
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return boxCenter
  const scaleX = dx === 0 ? Number.POSITIVE_INFINITY : (box.width / 2) / Math.abs(dx)
  const scaleY = dy === 0 ? Number.POSITIVE_INFINITY : (box.height / 2) / Math.abs(dy)
  const scale = Math.min(scaleX, scaleY)
  return {
    x: boxCenter.x + dx * scale,
    y: boxCenter.y + dy * scale,
  }
}

function finitePoint(point: { x?: number; y?: number } | undefined) {
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return undefined
  return { x: point.x ?? 0, y: point.y ?? 0 }
}

function parsedStyleNumber(style: string, key: string) {
  const match = new RegExp(`(?:^|;)${key}=(-?\\d+(?:\\.\\d+)?)(?:;|$)`).exec(style)
  return match?.[1] ? Number(match[1]) : 0
}

function polylineLength(points: Array<{ x: number; y: number }>) {
  let total = 0
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]
    const end = points[index + 1]
    if (!start || !end) continue
    total += Math.abs(end.x - start.x) + Math.abs(end.y - start.y)
  }
  return total
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

function pngSizeFromBytes(bytes: Uint8Array) {
  if (bytes.length < 24 || !PNG_SIGNATURE.every((value, index) => bytes[index] === value)) return undefined
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    width: view.getUint32(16),
    height: view.getUint32(20),
  }
}

function isLegendNode(node: NormalizedNode) {
  return node.visualRole === "legend-note" || node.id.startsWith("n-visual-plan-legend-") || node.parent === "g-visual-plan-legend"
}

function isVisualJunctionNode(node: NormalizedNode) {
  return node.visualRole === "bus-junction" || String(node.sourceId || "").startsWith("visual-bus:")
}

function isLegendContainer(container: NormalizedContainer) {
  return container.id === "g-visual-plan-legend" || /legend/i.test(container.label)
}

function genericFixesForMetrics(metrics: DrawioVisualMetrics) {
  const fixes: string[] = []
  if (metrics.nodeOverlapCount) fixes.push("Increase generic node spacing or repair overlapping geometry after ELK.")
  if (metrics.containerOverlapCount) fixes.push("Separate partially overlapping containers while preserving explicitly nested regions.")
  if (metrics.textOverflowRiskCount) fixes.push("Improve generic text wrapping/sizing and move low-priority details out of node titles.")
  if (metrics.narrowContainerLabelRiskCount) fixes.push("Render narrow tall SoC sidebars with vertical labels so titles do not collide with nodes or ports.")
  if (metrics.nodeContainerBoundaryViolationCount) fixes.push("Keep SoC nodes inside their owning container with visible padding; expand the container or move the node.")
  if (metrics.nodeUnownedContainerOverlapCount) fixes.push("Move nested SoC containers away from sibling nodes that do not belong to them.")
  if (metrics.socVisibleLowPriorityEdgeLabelCount) fixes.push("Suppress or externalize non-high-priority SoC edge labels so text does not sit directly on routed lines.")
  if (metrics.shortHeavyArrowCount) fixes.push("Reduce stroke weight or increase spacing for short local SoC connectors so arrows keep visual proportion.")
  if (metrics.socContainerHorizontalFillRiskCount) fixes.push("Spread explicitly owned SoC module columns across the available container width without reading business labels.")
  if (metrics.socBusContainerAlignmentRiskCount) fixes.push("Route long cross-container SoC bus edges through container-boundary corridors so the trunk visually attaches to both regions.")
  if (metrics.busFanInAmbiguityCount || metrics.busFanOutAmbiguityCount) fixes.push("Ask the model/skill to group shared visible bus edges into VisualPlan.buses, then render a trunk with short branch lines.")
  if (metrics.pseudoSelfLoopRiskCount) fixes.push("Route non-self bus edges through explicit junctions or separated ports so they cannot look like self-loops.")
  if (metrics.sharedPortOverlapCount) fixes.push("Fan out shared bus ports with explicit junctions or port order instead of stacking multiple thick lines on one side.")
  if (metrics.busTrunkAlignmentRiskCount) fixes.push("Keep bus trunk segments straight and aligned to the junction/port boundary.")
  if (metrics.unexplainedHeavyBusCount) fixes.push("Require visible heavy bus lines to be explained by VisualPlan.buses, routeHints, or port hints.")
  if (metrics.railEdgeCount > metrics.railEdgesWithPoints) fixes.push("Ensure every VisualPlan rail edge receives explicit bend points.")
  if (metrics.visibleEdgesWithPoints < metrics.edgeCount) fixes.push("Generate explicit orthogonal bend points for every visible edge so routes are inspectable and stable.")
  if (metrics.railCollinearOverlapCount || metrics.edgeCollinearOverlapCount) fixes.push("Fan out parallel edge segments by geometry, not by business labels.")
  if (metrics.edgeIntersectionCount) fixes.push("Add generic crossing reduction for visible edge segments before XML export.")
  if (metrics.unnecessaryBendCount) fixes.push("Keep aligned line edges straight when no node or container obstacle blocks the direct route.")
  if (metrics.shortJogCount) fixes.push("Collapse tiny orthogonal jogs between long aligned segments so SoC bus trunks look intentional.")
  if (metrics.edgePassThroughCount) fixes.push("Add generic pass-through detection and orthogonal detours around node bounds.")
  if (metrics.edgeContainerPassThroughCount) fixes.push("Route edges around unrelated containers or attach them to the container boundary explicitly.")
  if (metrics.disconnectedEdgeEndpointCount) fixes.push("Reject or repair edges whose source/target cannot be resolved to rendered nodes.")
  if (metrics.mainGraphOffsetRatio > 0.36) fixes.push("Compute page bounds from primary graph geometry before placing legend/sidebar.")
  if (metrics.legendOverwide) fixes.push("Clamp legend width and wrap explanation text.")
  if (metrics.legendOverlapCount) fixes.push("Place legend/sidebar outside the root graph bounds so it never covers nodes or containers.")
  if (!fixes.length) fixes.push("No generic renderer fix suggested by deterministic metrics.")
  return fixes
}

async function writeJson(path: string, value: unknown) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`)
}

function bounded(value: string) {
  return value.trim().slice(-4000)
}

function escapeHtml(input: string) {
  return input.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  }[char] ?? char))
}

if (import.meta.main) {
  runDrawioVisualEval(parseArgs(process.argv.slice(2)))
    .then(() => process.exit(0))
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      console.error(message)
      process.exit(1)
    })
}
