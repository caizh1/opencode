import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { generateDrawioDiagram, type DrawioGeneratedDiagram, type NormalizedContainer, type NormalizedEdge, type NormalizedNode } from "../src/drawio-diagram-generator"
import { validateDiagramIr } from "../src/diagram-ir"
import { computeDrawioVisualMetrics, drawioSocVisualEvalCases, drawioVisualEvalCases, findChrome, renderDrawioXmlToPngDataUri } from "../scripts/drawio-visual-eval"

describe("draw.io visual evaluation workflow", () => {
  test("defines five public cases plus at least two canary variants with VisualPlan", () => {
    const cases = drawioVisualEvalCases()
    expect(cases.filter((item) => item.public)).toHaveLength(5)
    expect(cases.filter((item) => !item.public).length).toBeGreaterThanOrEqual(2)
    for (const item of cases) {
      expect(item.diagramIr.visualPlan?.mainBackbone?.nodes?.length).toBeGreaterThan(1)
      expect(Object.keys(item.diagramIr.visualPlan?.edgePresentation ?? {}).length).toBeGreaterThan(0)
      const validation = validateDiagramIr({ diagramIr: item.diagramIr })
      expect(validation.issues.filter((issue) => issue.severity === "blocking")).toEqual([])
    }
  })

  test("public cases match the density of the problematic SSD diagrams", () => {
    const publicCases = drawioVisualEvalCases().filter((item) => item.public)
    const minimums = new Map([
      ["ssd-business-flow-medium", { nodes: 20, edges: 24 }],
      ["embedded-fsm-business-flow", { nodes: 23, edges: 30 }],
      ["state-machine", { nodes: 18, edges: 25 }],
      ["soc-architecture-block", { nodes: 32, edges: 32 }],
      ["mixed-code-flow", { nodes: 31, edges: 42 }],
    ])
    expect(publicCases.map((item) => item.id).sort()).toEqual(Array.from(minimums.keys()).sort())
    for (const evalCase of publicCases) {
      const expected = minimums.get(evalCase.id)
      expect(expected).toBeTruthy()
      expect(evalCase.diagramIr.nodes?.length ?? 0).toBeGreaterThanOrEqual(expected?.nodes ?? 0)
      expect(evalCase.diagramIr.edges?.length ?? 0).toBeGreaterThanOrEqual(expected?.edges ?? 0)
    }
  })

  test("SoC suite contains non-trivial chip-level block diagrams", () => {
    const cases = drawioSocVisualEvalCases()
    const minimums = new Map([
      ["soc-cortex-a53-cluster", { regions: 6, nodes: 18, edges: 20 }],
      ["soc-cortex-r8-reference", { regions: 7, nodes: 21, edges: 26 }],
      ["soc-cpu-core-backend", { regions: 7, nodes: 31, edges: 27 }],
      ["soc-gpu-slice-reference", { regions: 8, nodes: 32, edges: 30 }],
      ["soc-ssd-controller-fabric", { regions: 8, nodes: 30, edges: 31 }],
    ])
    expect(cases.map((item) => item.id).sort()).toEqual(Array.from(minimums.keys()).sort())
    for (const evalCase of cases) {
      const expected = minimums.get(evalCase.id)
      expect(expected).toBeTruthy()
      expect(evalCase.category).toBe("soc-suite")
      expect(evalCase.diagramIr.diagramType).toBe("soc-block")
      expect(evalCase.diagramIr.regions?.length ?? 0).toBeGreaterThanOrEqual(expected?.regions ?? 0)
      expect(evalCase.diagramIr.nodes?.length ?? 0).toBeGreaterThanOrEqual(expected?.nodes ?? 0)
      expect(evalCase.diagramIr.edges?.length ?? 0).toBeGreaterThanOrEqual(expected?.edges ?? 0)
      expect(evalCase.diagramIr.visualPlan?.mainBackbone?.direction).toBe("right")
      expect(Object.keys(evalCase.diagramIr.visualPlan?.edgePresentation ?? {}).length).toBe(evalCase.diagramIr.edges?.length ?? 0)
    }
  })

  test("SoC suite renders without deterministic geometry failures", async () => {
    const minimumRenderedNodes = new Map([
      ["soc-cortex-a53-cluster", 18],
      ["soc-cortex-r8-reference", 21],
    ])
    for (const evalCase of drawioSocVisualEvalCases()) {
      const generated = await generateDrawioDiagram({ diagramIr: evalCase.diagramIr })
      const metrics = computeDrawioVisualMetrics(generated)
      expect({
        id: evalCase.id,
        fatalCount: metrics.fatalCount,
        warnings: metrics.warnings,
      }).toEqual({
        id: evalCase.id,
        fatalCount: 0,
        warnings: [],
      })
      expect(metrics.nodeCount).toBeGreaterThanOrEqual(minimumRenderedNodes.get(evalCase.id) ?? 28)
      expect(metrics.containerCount).toBeGreaterThanOrEqual(evalCase.id === "soc-cortex-a53-cluster" ? 6 : 7)
      expect(metrics.visibleEdgesWithPoints).toBe(metrics.edgeCount)
      expect(metrics.socVisibleLowPriorityEdgeLabelCount).toBe(0)
      expect(metrics.shortHeavyArrowCount).toBe(0)
      expect(metrics.nodeUnownedContainerOverlapCount).toBe(0)
      expect(metrics.socContainerHorizontalFillRiskCount).toBe(0)
      expect(metrics.socBusContainerAlignmentRiskCount).toBe(0)
    }
  })

  test("public and canary variants keep renderer behavior driven by VisualPlan structure", async () => {
    const cases = drawioVisualEvalCases()
    const base = cases.find((item) => item.id === "embedded-fsm-business-flow")
    const canary = cases.find((item) => item.id === "canary-neutral-fsm")
    expect(base).toBeTruthy()
    expect(canary).toBeTruthy()
    const baseResult = await generateDrawioDiagram({ diagramIr: base?.diagramIr })
    const canaryResult = await generateDrawioDiagram({ diagramIr: canary?.diagramIr })
    expect(baseResult.normalizedSpec.visualPlan?.profile).toBe(canaryResult.normalizedSpec.visualPlan?.profile)
    expect(baseResult.normalizedSpec.edges.filter((edge) => edge.presentationMode === "rail").length).toBe(
      canaryResult.normalizedSpec.edges.filter((edge) => edge.presentationMode === "rail").length,
    )
    expect(baseResult.normalizedSpec.visualPlan?.legend?.items.length).toBe(canaryResult.normalizedSpec.visualPlan?.legend?.items.length)
  })

  test("deterministic metrics detect common visual failures", () => {
    const generated = generatedFixture({
      nodes: [
        node("n-a", "A", { x: 10, y: 10, width: 160, height: 70 }),
        node("n-b", "VeryLongUnbrokenIdentifierThatWillNotFitInsideTheNodeBox", { x: 40, y: 30, width: 120, height: 40 }),
        node("n-c", "C", { x: 260, y: 10, width: 160, height: 70 }),
        node("n-d", "D", { x: 620, y: 320, width: 160, height: 70 }),
        node("n-e", "E", { x: 620, y: 460, width: 160, height: 70 }),
        node("n-fill-a", "Fill A", { x: 16, y: 34, width: 58, height: 32 }, "g-fill-risk"),
        node("n-fill-b", "Fill B", { x: 98, y: 34, width: 58, height: 32 }, "g-fill-risk"),
        node("n-fill-c", "Fill C", { x: 180, y: 34, width: 58, height: 32 }, "g-fill-risk"),
        node("n-fill-d", "Fill D", { x: 16, y: 86, width: 58, height: 32 }, "g-fill-risk"),
        node("n-fill-e", "Fill E", { x: 98, y: 86, width: 58, height: 32 }, "g-fill-risk"),
        node("n-fill-f", "Fill F", { x: 180, y: 86, width: 58, height: 32 }, "g-fill-risk"),
        node("n-bus-a", "Bus A", { x: 20, y: 70, width: 70, height: 42 }, "g-bus-a"),
        node("n-bus-b", "Bus B", { x: 20, y: 180, width: 70, height: 42 }, "g-bus-b"),
        node("n-jog-a", "Jog A", { x: 3160, y: 90, width: 80, height: 44 }),
        node("n-jog-b", "Jog B", { x: 3540, y: 90, width: 80, height: 44 }),
      ],
      edges: [
        edge("e-rail", "n-a", "n-c", [], "rail"),
        edge("e-pass", "n-a", "n-c", [{ x: 90, y: 45 }, { x: 360, y: 45 }], "line"),
        edge("e-bent", "n-d", "n-e", [{ x: 860, y: 355 }, { x: 860, y: 495 }], "line"),
        edge("e-short-heavy", "n-d", "n-e", [], "line", { style: "strokeWidth=5;" }),
        edge("e-bus-unaligned", "n-bus-a", "n-bus-b", [{ x: 880, y: 70 }, { x: 880, y: 260 }, { x: 1220, y: 260 }], "line", { edgeKind: "bus", pathRole: "bus" }),
        edge("e-short-jog", "n-jog-a", "n-jog-b", [{ x: 3300, y: 112 }, { x: 3300, y: 126 }, { x: 3480, y: 126 }], "line"),
      ],
      containers: [
        container("g-visual-plan-legend", "Legend / Evidence", { x: 20, y: 20, width: 900, height: 220 }),
        container("g-side", "Tall Side Bar", { x: 980, y: 20, width: 90, height: 320 }),
        container("g-node-overlap", "Node Overlap", { x: 250, y: 5, width: 190, height: 90 }),
        container("g-overlap-a", "Overlap A", { x: 1120, y: 20, width: 220, height: 160 }),
        container("g-overlap-b", "Overlap B", { x: 1240, y: 80, width: 220, height: 160 }),
        container("g-fill-risk", "Fill Risk", { x: 1500, y: 20, width: 520, height: 220 }),
        container("g-bus-a", "Bus Region A", { x: 2100, y: 20, width: 260, height: 220 }),
        container("g-bus-b", "Bus Region B", { x: 2740, y: 20, width: 260, height: 320 }),
      ],
      profile: "soc-block",
    })
    const metrics = computeDrawioVisualMetrics(generated)
    expect(metrics.nodeOverlapCount).toBeGreaterThan(0)
    expect(metrics.containerOverlapCount).toBeGreaterThan(0)
    expect(metrics.textOverflowRiskCount).toBeGreaterThan(0)
    expect(metrics.narrowContainerLabelRiskCount).toBeGreaterThan(0)
    expect(metrics.nodeUnownedContainerOverlapCount).toBeGreaterThan(0)
    expect(metrics.socVisibleLowPriorityEdgeLabelCount).toBeGreaterThan(0)
    expect(metrics.shortHeavyArrowCount).toBeGreaterThan(0)
    expect(metrics.socContainerHorizontalFillRiskCount).toBeGreaterThan(0)
    expect(metrics.socBusContainerAlignmentRiskCount).toBeGreaterThan(0)
    expect(metrics.shortJogCount).toBeGreaterThan(0)
    expect(metrics.railEdgeCount).toBe(1)
    expect(metrics.railEdgesWithPoints).toBe(0)
    expect(metrics.unnecessaryBendCount).toBeGreaterThan(0)
    expect(metrics.legendOverlapCount).toBeGreaterThan(0)
    expect(metrics.fatalCount).toBeGreaterThan(0)
    expect(metrics.classification).toBe("renderer-execution")
  })

  test("complex dense DiagramIR without VisualPlan is blocked before visual review", () => {
    const validation = validateDiagramIr({
      diagramIr: {
        title: "Dense missing plan",
        diagramType: "business-flow",
        lanes: [
          { id: "l1", label: "L1", evidenceRefs: ["ref:l1"] },
          { id: "l2", label: "L2", evidenceRefs: ["ref:l2"] },
        ],
        nodes: [
          { id: "a", label: "A", parent: "l1", visualRole: "state", evidenceRefs: ["ref:a"] },
          { id: "b", label: "B", parent: "l1", visualRole: "state", evidenceRefs: ["ref:b"] },
          { id: "c", label: "C", parent: "l2", visualRole: "state", evidenceRefs: ["ref:c"] },
          { id: "d", label: "D", parent: "l2", visualRole: "state", evidenceRefs: ["ref:d"] },
          { id: "e", label: "E", parent: "l2", visualRole: "state", evidenceRefs: ["ref:e"] },
        ],
        edges: [
          { id: "ab", source: "a", target: "b", edgeKind: "transition", evidenceRefs: ["ref:ab"] },
          { id: "bc", source: "b", target: "c", edgeKind: "transition", evidenceRefs: ["ref:bc"] },
          { id: "cd", source: "c", target: "d", edgeKind: "transition", evidenceRefs: ["ref:cd"] },
          { id: "de", source: "d", target: "e", edgeKind: "transition", evidenceRefs: ["ref:de"] },
          { id: "ea", source: "e", target: "a", edgeKind: "transition", evidenceRefs: ["ref:ea"] },
        ],
      },
    })
    expect(validation.issues.some((issue) => issue.code === "diagram.visualPlan.missing" && issue.severity === "blocking")).toBe(true)
  })

  test("production draw.io renderer does not hardcode fixture business tokens", () => {
    const forbidden = [
      "USP_FOLD",
      "MP_GC",
      "SSD MP",
      "ftl_mp_",
      "FDS",
    ]
    const hits: string[] = []
    for (const file of sourceFiles(join(import.meta.dir, "..", "src"))) {
      if (!/\/(?:drawio|diagram)[^/]*\.ts$/.test(file)) continue
      const text = readFileSync(file, "utf8")
      for (const token of forbidden) {
        if (text.includes(token)) hits.push(`${file}: ${token}`)
      }
    }
    expect(hits).toEqual([])
  })

  test("renders a representative case to PNG when Chrome is available", async () => {
    if (!findChrome()) return
    const evalCase = drawioVisualEvalCases().find((item) => item.id === "ssd-business-flow-medium")
    expect(evalCase).toBeTruthy()
    const generated = await generateDrawioDiagram({ diagramIr: evalCase?.diagramIr })
    const dataUri = await renderDrawioXmlToPngDataUri({ xml: generated.mxGraphModelXml })
    expect(dataUri).toStartWith("data:image/png;base64,iVBORw0KGgo")
  }, 60000)
})

function generatedFixture(input: {
  nodes: NormalizedNode[]
  edges: NormalizedEdge[]
  containers: NormalizedContainer[]
  profile?: "business-flow" | "soc-block"
}): DrawioGeneratedDiagram {
  const profile = input.profile ?? "business-flow"
  return {
    kind: "drawio",
    diagramId: "drawio-test",
    title: "fixture",
    mxGraphModelXml: "<mxGraphModel><root/></mxGraphModel>",
    warnings: [],
    normalizedSpec: {
      title: "fixture",
      diagramType: profile,
      layout: "flow",
      layoutEngine: "elk",
      theme: "default",
      nodes: input.nodes,
      edges: input.edges,
      containers: input.containers,
      visualPlan: {
        compilerVersion: "diagram-design-compiler/v1",
        profile,
        mainBackbone: { nodes: input.nodes.map((item) => item.sourceId ?? item.id), edges: input.edges.map((item) => item.sourceId ?? item.id) },
        nodes: [],
        edges: [],
        qualityGate: {
          textOverflowRepairs: 0,
          edgeLabelRepairs: 0,
          legendItems: 0,
          labelSanitizationRepairs: 0,
          edgeVisibilityRepairs: 0,
          visibleEdges: input.edges.length,
          calloutEdges: 0,
          legendEdges: 0,
          edgeOverlapRepairs: 0,
          edgePassThroughRepairs: 0,
          repairPasses: 0,
          warnings: [],
        },
      },
    },
  }
}

function node(id: string, label: string, geometry: { x: number; y: number; width: number; height: number }, parent = "1"): NormalizedNode {
  return {
    id,
    sourceId: id.replace(/^n-/, ""),
    label,
    shape: "roundedrect",
    parent,
    geometry,
    style: "",
    explicitGeometry: true,
    visualRole: "action",
    importance: 0.5,
  }
}

function edge(
  id: string,
  source: string,
  target: string,
  points: Array<{ x: number; y: number }>,
  mode: "line" | "rail",
  overrides: Partial<NormalizedEdge> = {},
): NormalizedEdge {
  return {
    id,
    label: id,
    sourceId: id,
    source,
    target,
    parent: "1",
    style: "",
    points,
    presentationMode: mode,
    rail: mode === "rail" ? "right" : undefined,
    ...overrides,
  }
}

function container(id: string, label: string, geometry: { x: number; y: number; width: number; height: number }): NormalizedContainer {
  return {
    id,
    label,
    kind: "container",
    parent: "1",
    layoutMode: "weak-band",
    explicitLayoutMode: true,
    allowEmpty: true,
    geometry,
    style: "",
  }
}

function sourceFiles(root: string): string[] {
  const result: string[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      result.push(...sourceFiles(path))
    } else if (/\.tsx?$/.test(path)) {
      result.push(path)
    }
  }
  return result
}
