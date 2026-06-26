import { afterEach, describe, expect, test } from "bun:test"
import { generateDrawioDiagram } from "../src/drawio-diagram-generator"
import { setDrawioElkLayoutRunnerForTest } from "../src/drawio-layout-engine"

describe("draw.io diagram generator", () => {
  afterEach(() => {
    setDrawioElkLayoutRunnerForTest(undefined)
  })

  test("generates a valid minimal mxGraphModel flowchart with ELK layout", async () => {
    const result = await generateDrawioDiagram({
      title: "Build flow",
      diagramType: "flowchart",
      nodes: [
        { id: "start", label: "Start", shape: "process" },
        { id: "done", label: "Done", shape: "process" },
      ],
      edges: [
        { id: "start-done", source: "start", target: "done", label: "next" },
      ],
      layout: "layered",
    })

    expect(result.kind).toBe("drawio")
    expect(result.mxGraphModelXml).toStartWith("<mxGraphModel")
    expect(result.mxGraphModelXml).toContain('<mxCell id="n-start"')
    expect(result.mxGraphModelXml).toContain('source="n-start"')
    expect(result.mxGraphModelXml).toContain('target="n-done"')
    expect(result.mxGraphModelXml).toContain('edge="1"')
    expect(result.normalizedSpec.nodes).toHaveLength(2)
    expect(result.normalizedSpec.layoutEngine).toBe("elk")
    expect(result.normalizedSpec.nodes[0]?.geometry.y).not.toBe(result.normalizedSpec.nodes[1]?.geometry.y)
  })

  test("generates architecture containers, swimlanes, and sequence messages", async () => {
    const architecture = await generateDrawioDiagram({
      title: "Offline renderer",
      diagramType: "architecture",
      containers: [{ id: "extension", label: "VS Code Extension" }],
      nodes: [
        { id: "tool", label: "Tool", parent: "extension" },
        { id: "runtime", label: "Bundled Runtime", parent: "extension", shape: "database" },
      ],
      edges: [{ source: "tool", target: "runtime", label: "load/export" }],
      layout: "architecture",
    })
    expect(architecture.mxGraphModelXml).toContain("VS Code Extension")
    expect(architecture.mxGraphModelXml).toContain('parent="g-extension"')
    expect(architecture.normalizedSpec.layoutEngine).toBe("elk")

    const swimlane = await generateDrawioDiagram({
      title: "Review lanes",
      diagramType: "swimlane",
      swimlanes: [{ id: "ai", label: "AI" }, { id: "plugin", label: "Plugin" }],
      nodes: [{ id: "spec", label: "Spec", lane: "ai" }, { id: "xml", label: "XML", lane: "plugin" }],
      edges: [{ source: "spec", target: "xml" }],
      layout: "swimlane",
    })
    expect(swimlane.mxGraphModelXml).toContain("swimlane")
    expect(swimlane.mxGraphModelXml).toContain('parent="lane-ai"')
    expect(swimlane.normalizedSpec.layoutEngine).toBe("elk")

    const sequence = await generateDrawioDiagram({
      title: "Tool call sequence",
      diagramType: "sequence",
      sequence: {
        participants: [{ id: "model", label: "Model" }, { id: "tool", label: "Tool" }],
        messages: [{ from: "model", to: "tool", label: "spec" }, { from: "tool", to: "model", label: "xml" }],
      },
      layout: "sequence",
    })
    expect(sequence.normalizedSpec.nodes.map((node) => node.sourceId)).toEqual(["model", "tool"])
    expect(sequence.normalizedSpec.edges).toHaveLength(2)
    expect(sequence.normalizedSpec.layoutEngine).toBe("elk")
  })

  test("recovers from duplicate ids, unknown shapes, broken edges, and unsafe style", async () => {
    const result = await generateDrawioDiagram({
      title: "Unsafe style",
      nodes: [
        { id: "dup", label: "A", shape: "spaceship", drawioStyle: { fillColor: "#fff", image: "https://example.invalid/a.png" } },
        { id: "dup", label: "B", drawioStyle: "strokeColor=#123456;link=javascript:alert(1)" },
      ],
      edges: [{ source: "missing", target: "dup", drawioStyle: "fontColor=<b>bad</b>" }],
    })

    expect(result.mxGraphModelXml).toContain('id="n-dup"')
    expect(result.mxGraphModelXml).toContain('id="n-dup-2"')
    expect(result.mxGraphModelXml).not.toContain("https://example.invalid")
    expect(result.mxGraphModelXml).not.toContain("javascript:")
    expect(result.mxGraphModelXml).not.toContain("<b>bad</b>")
    expect(result.warnings.join("\n")).toContain("Unknown shape")
    expect(result.warnings.join("\n")).toContain("Duplicate id")
    expect(result.warnings.join("\n")).toContain("unknown source")
    expect(result.warnings.join("\n")).toContain("Dropped")
  })

  test("accepts common flowchart terminal shape aliases without warning", async () => {
    const result = await generateDrawioDiagram({
      title: "Start and end",
      nodes: [
        { id: "start", label: "Start", shape: "start" },
        { id: "done", label: "Done", shape: "terminator" },
      ],
      edges: [{ id: "e", source: "start", target: "done" }],
    })

    expect(result.mxGraphModelXml).toContain('id="n-start"')
    expect(result.mxGraphModelXml).toContain('id="n-done"')
    expect(result.warnings.join("\n")).not.toContain('Unknown shape "start"')
    expect(result.warnings.join("\n")).not.toContain('Unknown shape "terminator"')
  })

  test("escapes XML labels including Chinese and special characters", async () => {
    const result = await generateDrawioDiagram({
      title: "转义",
      nodes: [{ id: "escape", label: "中文 & <tag> \"quote\" 'apostrophe'\nnext" }],
    })

    expect(result.mxGraphModelXml).toContain("中文")
    expect(result.mxGraphModelXml).toContain("&amp;")
    expect(result.mxGraphModelXml).toContain("&lt;tag&gt;")
    expect(result.mxGraphModelXml).toContain("&quot;quote&quot;")
    expect(result.mxGraphModelXml).toContain("&apos;apostrophe&apos;")
    expect(result.mxGraphModelXml).not.toContain("<tag>")
  })

  test("accepts DiagramIR with SoC regions, arrays, ports, buses, and evidence metadata", async () => {
    const result = await generateDrawioDiagram({
      diagramIr: {
        version: "diagram-ir/v1",
        title: "GPU slice",
        diagramType: "soc-block",
        composition: { mode: "single", reason: "User requested one SoC block diagram." },
        scope: "gpu",
        regions: [
          { id: "slice", label: "Slice", evidenceRefs: ["ref:slice"] },
          { id: "unslice", label: "Unslice", evidenceRefs: ["ref:unslice"] },
        ],
        arrays: [
          { id: "eu-array", label: "EU Array", parent: "slice", rows: 2, columns: 3, itemLabel: "EU", evidenceRefs: ["ref:eu"] },
        ],
        ports: [
          { id: "ddi", label: "DDI", parent: "slice", evidenceRefs: ["ref:ddi"] },
        ],
        nodes: [
          { id: "cmd", label: "Command Streamer", parent: "unslice", evidenceRefs: ["ref:cmd"] },
        ],
        buses: [
          { id: "bus", label: "GTI", source: "ddi", target: "cmd", evidenceRefs: ["ref:gti"] },
        ],
        layoutHints: { kind: "soc-block" },
        styleHints: { theme: "light" },
        referenceDiagrams: [{ kind: "user-image", id: "reference-1" }],
      },
    })

    expect(result.normalizedSpec.diagramType).toBe("soc-block")
    expect(result.normalizedSpec.composition?.mode).toBe("single")
    expect(result.normalizedSpec.layoutEngine).toBe("elk")
    expect(result.coverageReport?.coverage).toBe("complete")
    expect(result.mxGraphModelXml).toContain("EU Array")
    expect(result.mxGraphModelXml).toContain("Command Streamer")
    expect(result.mxGraphModelXml).toContain("strokeWidth=4")
    expect(result.mxGraphModelXml).toContain('parent="g-slice"')
  })

  test("defaults DiagramIR composition to one diagram and does not auto-split subdiagrams", async () => {
    const result = await generateDrawioDiagram({
      diagramIr: {
        title: "Dense module flow",
        diagramType: "code-flow",
        nodes: [
          { id: "entry", label: "entry", evidenceRefs: ["ref:entry"] },
          { id: "exit", label: "exit", evidenceRefs: ["ref:exit"] },
        ],
        edges: [{ source: "entry", target: "exit", evidenceRefs: ["ref:e"] }],
        subdiagrams: [{ id: "detail", title: "detail" }],
      },
    })

    expect(result.normalizedSpec.composition?.mode).toBe("single")
    expect(result.normalizedSpec.diagramIr?.composition?.mode).toBe("single")
    expect(result.warnings.join("\n")).toContain("composition.mode is single")
    expect(result.mxGraphModelXml).toContain("entry")
    expect(result.mxGraphModelXml).toContain("exit")
  })

  test("renders explicit multi composition subdiagrams as additional draw.io payloads", async () => {
    const result = await generateDrawioDiagram({
      diagramIr: {
        title: "Overview",
        diagramType: "code-flow",
        composition: { mode: "multi", reason: "User explicitly requested overview and detail diagrams." },
        nodes: [
          { id: "overview-entry", label: "overview entry", evidenceRefs: ["ref:overview"] },
          { id: "overview-exit", label: "overview exit", evidenceRefs: ["ref:overview"] },
        ],
        edges: [{ source: "overview-entry", target: "overview-exit", evidenceRefs: ["ref:overview"] }],
        subdiagrams: [{
          title: "Detail branch",
          diagramType: "code-flow",
          nodes: [
            { id: "branch", label: "branch", evidenceRefs: ["ref:branch"] },
            { id: "done", label: "done", evidenceRefs: ["ref:done"] },
          ],
          edges: [{ source: "branch", target: "done", evidenceRefs: ["ref:edge"] }],
        }],
      },
    })

    expect(result.normalizedSpec.composition?.mode).toBe("multi")
    expect(result.normalizedSpec.layoutEngine).toBe("elk")
    expect(result.additionalDiagrams).toHaveLength(1)
    expect(result.additionalDiagrams?.[0]?.title).toBe("Detail branch")
    expect(result.additionalDiagrams?.[0]?.mxGraphModelXml).toContain("branch")
  })

  test("auto-sizes long mixed labels and adds orthogonal routing metadata", async () => {
    const result = await generateDrawioDiagram({
      title: "Readable flow",
      diagramType: "code-flow",
      nodes: [
        { id: "entry", label: "入口函数 handleRequest() 接收中文英文混合参数并进行权限校验", evidenceRefs: ["ref:entry"] },
        { id: "branch", label: "根据 featureFlag / 用户状态 / cache 命中情况选择详细分支", shape: "decision", evidenceRefs: ["ref:branch"] },
        { id: "done", label: "结束", evidenceRefs: ["ref:done"] },
      ],
      edges: [
        { id: "e1", source: "entry", target: "branch", label: "validated", evidenceRefs: ["ref:e1"] },
        { id: "e2", source: "branch", target: "done", label: "success", evidenceRefs: ["ref:e2"] },
      ],
      layout: "flow",
    })

    const entry = result.normalizedSpec.nodes.find((node) => node.sourceId === "entry")
    expect(result.normalizedSpec.visualPlan?.compilerVersion).toBe("diagram-design-compiler/v1")
    expect(result.normalizedSpec.visualPlan?.profile).toBe("code-flow")
    expect(entry?.geometry.width).toBeGreaterThan(168)
    expect(entry?.geometry.height).toBeGreaterThanOrEqual(64)
    expect(result.mxGraphModelXml).toContain("&#xa;")
    expect(result.mxGraphModelXml).toContain("edgeStyle=orthogonalEdgeStyle")
    expect(result.mxGraphModelXml).toContain('as="offset"')
    expect(result.normalizedSpec.layoutEngine).toBe("elk")
  })

  test("design compiler moves noisy labels into visual notes and shortens edge labels", async () => {
    const result = await generateDrawioDiagram({
      title: "Detailed code flow",
      diagramType: "code-flow",
      nodes: [
        {
          id: "entry",
          label: "ftl_mp_folding_fsm() 在 ftl_mp_folding.c:707-712 根据 queue depth / parity / runtime state 选择下一阶段并更新上下文",
          evidenceRefs: ["ref:entry"],
          sourceKind: "function",
        },
        {
          id: "complete",
          label: "COMPLETE",
          evidenceRefs: ["ref:complete"],
        },
      ],
      edges: [{
        id: "long-edge",
        source: "entry",
        target: "complete",
        label: "IDLE -> WAIT_NODEQ -> PARITY_DONE -> COMPLETE when flush queue drains and all parity operations complete",
        evidenceRefs: ["ref:edge"],
        pathRole: "primary",
      }],
      layout: "flow",
    })

    expect(result.normalizedSpec.visualPlan?.profile).toBe("code-flow")
    expect(result.normalizedSpec.visualPlan?.qualityGate.textOverflowRepairs).toBeGreaterThan(0)
    expect(result.normalizedSpec.visualPlan?.qualityGate.edgeLabelRepairs).toBeGreaterThan(0)
    expect(result.normalizedSpec.containers.some((container) => container.id.includes("visual-notes") || container.label === "Legend / Details")).toBe(true)
    expect(result.normalizedSpec.edges[0]?.label).toMatch(/^\[E1\]$/)
    expect(result.mxGraphModelXml).toContain("Legend / Details")
    expect(result.mxGraphModelXml).toContain("[N1]")
    expect(result.mxGraphModelXml).toContain("[E1]")
  })

  test("DiagramIR visual hints survive validation and guide the design compiler", async () => {
    const result = await generateDrawioDiagram({
      diagramIr: {
        title: "FSM detail",
        diagramType: "state-machine",
        nodes: [
          { id: "idle", label: "IDLE", visualRole: "state", importance: 0.9, evidenceRefs: ["ref:idle"] },
          { id: "dispatch", textParts: { title: "DISPATCH", subtitle: "ftl_mp_scan_fsm()", meta: "function" }, visualRole: "state", evidenceRefs: ["ref:dispatch"] },
        ],
        edges: [{
          id: "to-dispatch",
          source: "idle",
          target: "dispatch",
          label: "queue has work",
          edgeKind: "event",
          pathRole: "primary",
          labelPriority: "high",
          evidenceRefs: ["ref:edge"],
        }],
      },
    })

    expect(result.normalizedSpec.visualPlan?.profile).toBe("state-machine")
    expect(result.normalizedSpec.nodes.find((node) => node.sourceId === "dispatch")?.label).toContain("ftl_mp_scan_fsm")
    expect(result.normalizedSpec.nodes.find((node) => node.sourceId === "dispatch")?.visualRole).toBe("state")
    expect(result.normalizedSpec.edges[0]?.edgeKind).toBe("event")
    expect(result.normalizedSpec.edges[0]?.pathRole).toBe("primary")
    expect(result.normalizedSpec.edges[0]?.labelPriority).toBe("high")
  })

  test("keeps business-flow intent while using embedded-fsm-flow for SSD module FSM processes", async () => {
    const result = await generateDrawioDiagram({
      diagramIr: {
        title: "SSD MP GC business process",
        diagramType: "business-flow",
        scope: "ftl_mp_gc",
        semanticHints: {
          domain: "embedded-ssd",
          primaryPerspective: "business-process",
          containsStateMachines: true,
          stateMachineCount: 2,
          processPhases: ["init", "runtime", "reclaim", "complete"],
        },
        lanes: [
          { id: "main", label: "主入口层 Main Entry", evidenceRefs: ["ref:main"] },
          { id: "gc", label: "MP GC 子模块", evidenceRefs: ["ref:gc"] },
          { id: "runtime", label: "运行时 FSM", evidenceRefs: ["ref:runtime"] },
        ],
        nodes: [
          { id: "entry", label: "ftl_mp_gc_init()", parent: "main", visualRole: "action", evidenceRefs: ["ref:entry"] },
          { id: "gc-dispatch", label: "GC DISPATCH", parent: "gc", visualRole: "state", evidenceRefs: ["ref:dispatch"] },
          { id: "gc-reclaim", label: "GC RECLAIM", parent: "gc", visualRole: "state", evidenceRefs: ["ref:reclaim"] },
          { id: "runtime-idle", label: "IDLE", parent: "runtime", visualRole: "state", evidenceRefs: ["ref:idle"] },
          { id: "runtime-complete", label: "COMPLETE", parent: "runtime", visualRole: "state", evidenceRefs: ["ref:complete"] },
        ],
        edges: [
          { id: "start", source: "entry", target: "gc-dispatch", label: "启动 GC 流程", pathRole: "primary", edgeKind: "control", evidenceRefs: ["ref:e-start"] },
          { id: "dispatch-reclaim", source: "gc-dispatch", target: "gc-reclaim", label: "touch_cnt > 0 且 source block 可回收时进入 reclaim", pathRole: "local-transition", edgeKind: "transition", evidenceRefs: ["ref:e1"] },
          { id: "runtime-event", source: "gc-reclaim", target: "runtime-idle", label: "[E6] runtime fsm waits for node queue and parity completion", pathRole: "cross-module", edgeKind: "event", evidenceRefs: ["ref:e6"] },
          { id: "complete", source: "runtime-idle", target: "runtime-complete", label: "all reclaim steps done", pathRole: "local-transition", edgeKind: "transition", evidenceRefs: ["ref:e-complete"] },
          { id: "feedback", source: "runtime-complete", target: "gc-dispatch", label: "feedback to dispatch next GC window", pathRole: "feedback", edgeKind: "event", evidenceRefs: ["ref:e-feedback"] },
        ],
      },
    })

    expect(result.normalizedSpec.diagramType).toBe("business-flow")
    expect(result.normalizedSpec.layout).toBe("embedded-fsm-flow")
    expect(result.normalizedSpec.visualPlan?.profile).toBe("embedded-fsm-flow")
    expect(result.normalizedSpec.diagramIr?.semanticHints?.primaryPerspective).toBe("business-process")
    expect(result.normalizedSpec.visualPlan?.qualityGate.edgeLabelRepairs).toBeGreaterThan(0)
    expect(result.normalizedSpec.edges.some((edge) => edge.pathRole === "local-transition" && edge.style.includes("strokeColor=#059669"))).toBe(true)
    expect(result.normalizedSpec.edges.some((edge) => edge.pathRole === "cross-module" && edge.style.includes("strokeColor=#92400e"))).toBe(true)
    const gcLane = result.normalizedSpec.containers.find((container) => container.kind === "swimlane" && container.label.includes("MP GC"))
    expect(gcLane?.layoutMode).toBe("weak-band")
    expect(result.normalizedSpec.nodes.find((node) => node.sourceId === "gc-dispatch")?.parent).toBe("1")
    expect(result.normalizedSpec.nodes.find((node) => node.sourceId === "gc-dispatch")?.ownerContainer).toBe(gcLane?.id)
    expect(result.warnings.join("\n")).toContain("selected embedded-fsm-flow")
    expect(result.mxGraphModelXml).toContain("Legend / Details")
    expect(result.mxGraphModelXml).toContain("[E1]")
  })

  test("converts unused embedded FSM partition containers to non-rendered layout-only scaffolds", async () => {
    const result = await generateDrawioDiagram({
      diagramIr: {
        title: "SSD MP GC process with unused partitions",
        diagramType: "business-flow",
        semanticHints: {
          containsStateMachines: true,
          stateMachineCount: 1,
          processPhases: ["trigger", "proc", "core"],
        },
        containers: [
          { id: "trigger_layer", label: "触发层 (5个入口)", evidenceRefs: ["ref:trigger"] },
          { id: "proc_layer", label: "Proc FSM 处理层", evidenceRefs: ["ref:proc"] },
          { id: "core_layer", label: "Core FSM 核心状态机", evidenceRefs: ["ref:core"] },
        ],
        nodes: [
          { id: "entry", label: "ftl_mp_gc_sys_idle()", visualRole: "action", evidenceRefs: ["ref:entry"] },
          { id: "proc-run", label: "PROC_RUN", visualRole: "state", evidenceRefs: ["ref:run"] },
          { id: "core-idle", label: "MP_GC_STATE_IDLE", visualRole: "state", evidenceRefs: ["ref:idle"] },
        ],
        edges: [
          { id: "start", source: "entry", target: "proc-run", edgeKind: "transition", evidenceRefs: ["ref:e1"] },
          { id: "next", source: "proc-run", target: "core-idle", edgeKind: "transition", evidenceRefs: ["ref:e2"] },
        ],
      },
    })

    expect(result.normalizedSpec.layout).toBe("embedded-fsm-flow")
    expect(result.normalizedSpec.containers.map((container) => container.label)).not.toContain("触发层 (5个入口)")
    expect(result.normalizedSpec.containers.map((container) => container.label)).not.toContain("Proc FSM 处理层")
    expect(result.normalizedSpec.containers.map((container) => container.label)).not.toContain("Core FSM 核心状态机")
    expect(result.mxGraphModelXml).not.toContain("触发层")
    expect(result.mxGraphModelXml).not.toContain("Proc FSM 处理层")
    expect(result.mxGraphModelXml).not.toContain("Core FSM 核心状态机")
    expect(result.warnings.join("\n")).toContain("Converted empty container")
    expect(result.warnings.join("\n")).toContain("layout-only scaffold")
    expect(result.warnings.join("\n")).toContain("has no assigned nodes")
  })

  test("renders embedded FSM partition ownership as weak background bands", async () => {
    const result = await generateDrawioDiagram({
      diagramIr: {
        title: "Owned SSD MP GC process",
        diagramType: "business-flow",
        semanticHints: { containsStateMachines: true, stateMachineCount: 1 },
        containers: [
          { id: "proc_layer", label: "Proc FSM 处理层", evidenceRefs: ["ref:proc"] },
          { id: "core_layer", label: "Core FSM 核心状态机", evidenceRefs: ["ref:core"] },
        ],
        nodes: [
          { id: "proc-run", label: "PROC_RUN", parent: "proc_layer", visualRole: "state", evidenceRefs: ["ref:run"] },
          { id: "proc-wait", label: "PROC_WAIT", parent: "proc_layer", visualRole: "state", evidenceRefs: ["ref:wait"] },
          { id: "core-idle", label: "MP_GC_STATE_IDLE", parent: "core_layer", visualRole: "state", evidenceRefs: ["ref:idle"] },
          { id: "core-run", label: "MP_GC_STATE_RUN", parent: "core_layer", visualRole: "state", evidenceRefs: ["ref:run-core"] },
        ],
        edges: [
          { id: "proc-local", source: "proc-run", target: "proc-wait", edgeKind: "transition", evidenceRefs: ["ref:e-local"] },
          { id: "handoff", source: "proc-wait", target: "core-idle", edgeKind: "transition", evidenceRefs: ["ref:e1"] },
          { id: "core-local", source: "core-idle", target: "core-run", edgeKind: "transition", evidenceRefs: ["ref:e-core"] },
        ],
      },
    })

    expect(result.normalizedSpec.layout).toBe("embedded-fsm-flow")
    const procLayer = result.normalizedSpec.containers.find((container) => container.label === "Proc FSM 处理层")
    const coreLayer = result.normalizedSpec.containers.find((container) => container.label === "Core FSM 核心状态机")
    const procNode = result.normalizedSpec.nodes.find((node) => node.sourceId === "proc-run")
    const coreNode = result.normalizedSpec.nodes.find((node) => node.sourceId === "core-idle")
    expect(procLayer?.layoutMode).toBe("weak-band")
    expect(coreLayer?.layoutMode).toBe("weak-band")
    expect(procNode?.parent).toBe("1")
    expect(coreNode?.parent).toBe("1")
    expect(procNode?.ownerContainer).toBe(procLayer?.id)
    expect(coreNode?.ownerContainer).toBe(coreLayer?.id)
    expect(result.mxGraphModelXml).toContain('id="g-proc_layer"')
    expect(result.mxGraphModelXml).toContain('id="g-core_layer"')
    expect(result.mxGraphModelXml).toContain('fillOpacity=14')
    expect(result.mxGraphModelXml).not.toContain('parent="g-proc_layer" vertex="1"')
    expect(result.mxGraphModelXml).not.toContain('parent="g-core_layer" vertex="1"')
    expect(result.warnings.join("\n")).not.toContain("Converted empty container")
  })

  test("keeps explicit strong embedded FSM containers as compound parents", async () => {
    const result = await generateDrawioDiagram({
      diagramIr: {
        title: "Strong SSD MP GC process",
        diagramType: "business-flow",
        semanticHints: { containsStateMachines: true, stateMachineCount: 1 },
        containers: [
          { id: "proc_layer", label: "Proc FSM 处理层", containerMode: "strong", evidenceRefs: ["ref:proc"] },
        ],
        nodes: [
          { id: "proc-run", label: "PROC_RUN", parent: "proc_layer", visualRole: "state", evidenceRefs: ["ref:run"] },
          { id: "proc-wait", label: "PROC_WAIT", parent: "proc_layer", visualRole: "state", evidenceRefs: ["ref:wait"] },
        ],
        edges: [
          { id: "handoff", source: "proc-run", target: "proc-wait", edgeKind: "transition", evidenceRefs: ["ref:e1"] },
        ],
      },
    })

    const procLayer = result.normalizedSpec.containers.find((container) => container.label === "Proc FSM 处理层")
    expect(procLayer?.layoutMode).toBe("strong-container")
    expect(result.normalizedSpec.nodes.every((node) => node.parent === procLayer?.id)).toBe(true)
    expect(result.mxGraphModelXml).toContain('parent="g-proc_layer" vertex="1"')
  })

  test("keeps connected collapsed external containers in embedded FSM flows", async () => {
    const result = await generateDrawioDiagram({
      diagramIr: {
        title: "External FSM call",
        diagramType: "business-flow",
        semanticHints: { containsStateMachines: true, stateMachineCount: 1 },
        containers: [
          { id: "external_fsm", label: "[外部] ftl_mp_folding_fsm", evidenceRefs: ["ref:external"] },
        ],
        nodes: [
          { id: "proc-run", label: "PROC_RUN", visualRole: "state", evidenceRefs: ["ref:run"] },
          { id: "complete", label: "COMPLETE", visualRole: "state", evidenceRefs: ["ref:complete"] },
        ],
        edges: [
          { id: "call", source: "proc-run", target: "external_fsm", edgeKind: "event", pathRole: "cross-module", evidenceRefs: ["ref:call"] },
          { id: "done", source: "external_fsm", target: "complete", edgeKind: "transition", evidenceRefs: ["ref:done"] },
        ],
      },
    })

    expect(result.normalizedSpec.layout).toBe("embedded-fsm-flow")
    expect(result.normalizedSpec.containers.some((container) => container.label.includes("ftl_mp_folding_fsm"))).toBe(true)
    expect(result.mxGraphModelXml).toContain('id="g-external_fsm"')
    expect(result.mxGraphModelXml).toContain('target="g-external_fsm"')
    expect(result.mxGraphModelXml).toContain('source="g-external_fsm"')
  })

  test("keeps explicitly allowed empty embedded FSM containers", async () => {
    const result = await generateDrawioDiagram({
      diagramIr: {
        title: "Reserved partition",
        diagramType: "business-flow",
        semanticHints: { containsStateMachines: true, stateMachineCount: 1 },
        containers: [
          { id: "reserved", label: "预留扩展层", allowEmpty: true, evidenceRefs: ["ref:reserved"] },
        ],
        nodes: [
          { id: "idle", label: "IDLE", visualRole: "state", evidenceRefs: ["ref:idle"] },
          { id: "run", label: "RUN", visualRole: "state", evidenceRefs: ["ref:run"] },
        ],
        edges: [
          { id: "start", source: "idle", target: "run", edgeKind: "transition", evidenceRefs: ["ref:start"] },
        ],
      },
    })

    expect(result.normalizedSpec.layout).toBe("embedded-fsm-flow")
    expect(result.normalizedSpec.containers.some((container) => container.label === "预留扩展层")).toBe(true)
    expect(result.mxGraphModelXml).toContain("预留扩展层")
    expect(result.warnings.join("\n")).toContain("Allowed empty container")
    expect(result.warnings.join("\n")).not.toContain("Converted empty container")
  })

  test("repairs embedded FSM HTML break labels, singleton bands, and overlapping vertical rails", async () => {
    setDrawioElkLayoutRunnerForTest(async (graph) => {
      const positions: Record<string, { x: number; y: number }> = {
        "n-non-gc-check": { x: 80, y: 40 },
        "n-wait-flush": { x: 80, y: 260 },
        "n-gc-idle": { x: 360, y: 260 },
        "n-config": { x: 80, y: 520 },
        "n-init": { x: 360, y: 520 },
      }
      return {
        ...graph,
        x: 0,
        y: 0,
        width: 720,
        height: 760,
        children: graph.children?.map((child) => ({
          ...child,
          x: positions[child.id]?.x ?? 40,
          y: positions[child.id]?.y ?? 40,
          width: child.width ?? 180,
          height: child.height ?? 70,
        })),
        edges: graph.edges?.map((edge) => ({
          ...edge,
          sections: [{
            id: `${edge.id}-section`,
            startPoint: { x: 300, y: 80 },
            endPoint: { x: 300, y: 620 },
            bendPoints: [{ x: 300, y: 120 }, { x: 300, y: 580 }],
          }],
        })),
      }
    })
    const result = await generateDrawioDiagram({
      diagramIr: {
        title: "SSD MP GC rail regression",
        diagramType: "business-flow",
        semanticHints: { containsStateMachines: true, stateMachineCount: 1, processPhases: ["dispatch", "wait", "run"] },
        containers: [
          { id: "non_gc", label: "Non GC 判断区", evidenceRefs: ["ref:non-gc"] },
          { id: "proc", label: "Proc FSM 处理层", evidenceRefs: ["ref:proc"] },
        ],
        nodes: [
          { id: "non-gc-check", label: "ftl_non_gc_fc<br>[N12]", parent: "non_gc", visualRole: "action", evidenceRefs: ["ref:check"] },
          { id: "wait-flush", label: "等待MP Flush?<br/>[N12]", parent: "proc", visualRole: "decision", evidenceRefs: ["ref:wait"] },
          { id: "gc-idle", label: "GC_PROC_&lt;br&gt;STATE_IDLE&lt;br/&gt;MP_GC_PROC_STATE_IDLE", visualRole: "state", evidenceRefs: ["ref:idle"] },
          { id: "config", label: "ftl_mp_flush_config<br/>[N12]", visualRole: "action", evidenceRefs: ["ref:config"] },
          { id: "init", label: "ftl_non_gc_fc_init<br/>[N10]", visualRole: "action", evidenceRefs: ["ref:init"] },
        ],
        edges: [
          { id: "csu", source: "non-gc-check", target: "gc-idle", label: "CSU调度", pathRole: "cross-module", edgeKind: "event", evidenceRefs: ["ref:e1"] },
          { id: "wait", source: "non-gc-check", target: "wait-flush", label: "等待触发", pathRole: "local-transition", edgeKind: "transition", evidenceRefs: ["ref:e2"] },
          { id: "config", source: "wait-flush", target: "config", label: "配置完成", pathRole: "primary", edgeKind: "control", evidenceRefs: ["ref:e3"] },
          { id: "run", source: "gc-idle", target: "init", label: "进入RUN", pathRole: "primary", edgeKind: "control", evidenceRefs: ["ref:e4"] },
          { id: "feedback", source: "init", target: "wait-flush", label: "轮询回到等待", pathRole: "feedback", edgeKind: "event", evidenceRefs: ["ref:e5"] },
        ],
      },
    })

    expect(result.mxGraphModelXml).not.toContain("&lt;br")
    expect(result.mxGraphModelXml).not.toContain("<br")
    expect(result.normalizedSpec.nodes.every((node) => !/[<>]br|&lt;br/i.test(node.label))).toBe(true)
    expect(result.normalizedSpec.edges.filter((edge) => edge.points.some((point) => Number.isFinite(point.x))).length).toBeGreaterThan(2)
    expect(result.normalizedSpec.visualPlan?.qualityGate.labelSanitizationRepairs).toBeGreaterThan(0)
    expect(result.normalizedSpec.visualPlan?.qualityGate.edgeOverlapRepairs).toBeGreaterThan(0)
    expect(result.normalizedSpec.containers.some((container) => container.label === "Non GC 判断区")).toBe(false)
    expect(result.warnings.join("\n")).toContain("Skipped singleton weak-band")
  })

  test("does not use embedded-fsm-flow for ordinary business flows", async () => {
    const result = await generateDrawioDiagram({
      diagramIr: {
        title: "Approval process",
        diagramType: "business-flow",
        nodes: [
          { id: "submit", label: "提交申请", visualRole: "action", evidenceRefs: ["ref:submit"] },
          { id: "approve", label: "经理审批", visualRole: "decision", evidenceRefs: ["ref:approve"] },
          { id: "done", label: "归档完成", visualRole: "action", evidenceRefs: ["ref:done"] },
        ],
        edges: [
          { source: "submit", target: "approve", label: "next", edgeKind: "control", evidenceRefs: ["ref:e1"] },
          { source: "approve", target: "done", label: "approved", edgeKind: "control", evidenceRefs: ["ref:e2"] },
        ],
      },
    })

    expect(result.normalizedSpec.diagramType).toBe("business-flow")
    expect(result.normalizedSpec.visualPlan?.profile).toBe("business-flow")
    expect(result.normalizedSpec.layout).toBe("flow")
  })

  test("keeps pure state-machine diagrams on the state-machine profile", async () => {
    const result = await generateDrawioDiagram({
      diagramIr: {
        title: "GC FSM",
        diagramType: "state-machine",
        nodes: [
          { id: "idle", label: "IDLE", visualRole: "state", evidenceRefs: ["ref:idle"] },
          { id: "dispatch", label: "DISPATCH", visualRole: "state", evidenceRefs: ["ref:dispatch"] },
          { id: "complete", label: "COMPLETE", visualRole: "state", evidenceRefs: ["ref:complete"] },
        ],
        edges: [
          { source: "idle", target: "dispatch", label: "queue ready", edgeKind: "transition", pathRole: "local-transition", evidenceRefs: ["ref:e1"] },
          { source: "dispatch", target: "complete", label: "done", edgeKind: "transition", pathRole: "local-transition", evidenceRefs: ["ref:e2"] },
        ],
      },
    })

    expect(result.normalizedSpec.diagramType).toBe("state-machine")
    expect(result.normalizedSpec.visualPlan?.profile).toBe("state-machine")
  })

  test("routes cross-container edges through ELK and roots edge cells", async () => {
    const result = await generateDrawioDiagram({
      title: "Container routing",
      diagramType: "architecture",
      containers: [
        { id: "left", label: "Left", x: 100, y: 100, width: 240, height: 160 },
        { id: "right", label: "Right", x: 600, y: 100, width: 240, height: 160 },
      ],
      nodes: [
        { id: "a", label: "A", parent: "left", x: 20, y: 50, width: 100, height: 50 },
        { id: "b", label: "B", parent: "right", x: 20, y: 50, width: 100, height: 50 },
      ],
      edges: [{ source: "a", target: "b", label: "call" }],
      layout: "architecture",
    })

    const edge = result.normalizedSpec.edges[0]
    expect(result.normalizedSpec.layoutEngine).toBe("elk")
    expect(edge?.parent).toBe("1")
    expect(result.mxGraphModelXml).toContain('parent="1" source="n-a" target="n-b" edge="1"')
    expect(result.mxGraphModelXml).not.toContain('<mxPoint x="420" y="175"/>')
  })

  test("fails instead of falling back when ELK layout throws", async () => {
    setDrawioElkLayoutRunnerForTest(async () => {
      throw new Error("mock elk boom")
    })

    await expect(generateDrawioDiagram({
      title: "ELK failure",
      nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }],
      edges: [{ source: "a", target: "b" }],
    })).rejects.toThrow(/stage=elk\.layout.*mock elk boom/)
  })

  test("fails instead of falling back when ELK output lacks coordinates", async () => {
    setDrawioElkLayoutRunnerForTest(async (graph) => ({
      ...graph,
      children: graph.children?.map((child) => ({ ...child, x: undefined, y: undefined })),
    }))

    await expect(generateDrawioDiagram({
      title: "Bad ELK output",
      nodes: [{ id: "a", label: "A" }],
    })).rejects.toThrow(/stage=elk\.output.*missing coordinates/)
  })
})
