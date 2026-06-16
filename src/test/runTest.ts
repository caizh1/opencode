import * as path from "node:path"
import { runTests } from "@vscode/test-electron"

async function main() {
  const extensionDevelopmentPath = path.resolve(__dirname, "..", "..")
  const extensionTestsPath = path.resolve(__dirname, "suite", "index")
  const version = process.env.VSCODE_TEST_VERSION?.trim() || undefined

  await runTests({
    extensionDevelopmentPath,
    extensionTestsPath,
    ...(version ? { version } : {}),
    launchArgs: ["--disable-extensions"],
  })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
