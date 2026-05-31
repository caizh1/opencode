import { describe, expect, test } from "bun:test"
import { parseCFile } from "../src/codegraph-c-parser"
import type { CodeGraphIndex } from "../src/codegraph-types"
import { extractStateMachines, findStatePath, stateMachineToTransitionTable } from "../src/state-machine-extractor"

describe("state-machine extractor v0", () => {
  test("extracts states, transitions, guards, actions, evidence, and diagrams", () => {
    const machines = extractStateMachines(sampleIndex())
    expect(machines.length).toBeGreaterThan(0)

    const machine = machines[0]
    expect(machine.states.map((state) => state.name)).toContain("BOOT_INIT")
    expect(machine.states.map((state) => state.name)).toContain("BOOT_READY")
    expect(machine.transitions.some((transition) => transition.fromState === "BOOT_INIT" && transition.toState === "BOOT_READY")).toBe(true)
    expect(machine.transitions.some((transition) => transition.toState === "BOOT_ERROR" && transition.guard?.includes("error"))).toBe(true)
    expect(machine.transitions.some((transition) => transition.toState === "BOOT_DONE" && transition.action?.includes("returns BOOT_DONE"))).toBe(true)
    expect(machine.transitions.every((transition) => transition.evidence.file && transition.evidence.startLine > 0)).toBe(true)
    expect(machine.transitions.every((transition) => transition.confidence > 0)).toBe(true)
    expect(machine.transitions.some((transition) => transition.action?.includes("calls boot_step"))).toBe(true)
    expect(machine.metrics.map((metric) => metric.phase)).toContain("scanCandidates")
    expect(stateMachineToTransitionTable(machine)[0]).toHaveProperty("evidence")
    expect(machine.mermaid).toContain("stateDiagram-v2")
    expect(machine.dot).toContain("digraph")
  })

  test("finds reachable paths and flags dead or error paths", () => {
    const machine = extractStateMachines(sampleIndex())[0]
    const paths = findStatePath(machine, "BOOT_INIT", "BOOT_DONE")

    expect(paths.length).toBeGreaterThan(0)
    expect(paths[0].transitions.map((transition) => transition.toState)).toContain("BOOT_DONE")
    expect(machine.query.errorPaths.some((path) => path.endState === "BOOT_ERROR")).toBe(true)
    expect(machine.query.deadStates.some((state) => state.name === "BOOT_DONE")).toBe(true)
  })
})

function sampleIndex(): CodeGraphIndex {
  const files = [
    parseCFile({
      path: "boot/flow.c",
      hash: "1",
      size: 1,
      text: `
enum boot_state {
  BOOT_INIT,
  BOOT_READY,
  BOOT_DONE,
  BOOT_ERROR,
};

static enum boot_state state;
int boot_event;

void boot_step(int error)
{
  switch (state) {
  case BOOT_INIT:
    prepare_boot();
    state = BOOT_READY;
    break;
  case BOOT_READY:
    if (error != 0) {
      log_error();
      state = BOOT_ERROR;
    } else {
      start_kernel();
      state = BOOT_DONE;
    }
    break;
  default:
    state = BOOT_ERROR;
  }
}

void boot_handler(int error)
{
  boot_step(error);
}

enum boot_state boot_result(void)
{
  return BOOT_DONE;
}
`,
    }),
  ]
  return {
    version: 1,
    rootPath: "/repo",
    rootName: "repo",
    updatedAt: 1,
    truncated: false,
    files: Object.fromEntries(files.map((file) => [file.path, file])),
  }
}
