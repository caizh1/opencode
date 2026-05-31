import { formatCodeGraphBenchmarkReport, runCodeGraphSyntheticBenchmark } from "../src/codegraph-benchmark"

const files = readNumberArg("--files", 1000)
const targets = readStringArg("--targets")
  ?.split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value >= 0)

const report = runCodeGraphSyntheticBenchmark({
  files,
  queryTargets: targets && targets.length > 0 ? targets : undefined,
})

console.log(formatCodeGraphBenchmarkReport(report))

function readStringArg(name: string) {
  const inline = process.argv.find((arg) => arg.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const index = process.argv.indexOf(name)
  if (index >= 0) return process.argv[index + 1]
  return undefined
}

function readNumberArg(name: string, fallback: number) {
  const value = Number(readStringArg(name))
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback
}
