import * as path from "node:path"
import { runTests } from "@vscode/test-electron"

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..")
  const extensionTestsPath = path.resolve(__dirname, "suite", "index")

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    launchArgs: ["--disable-extensions"],
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
