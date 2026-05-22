#!/usr/bin/env bun
import path from "path"
import { fileURLToPath } from "url"
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dir = path.resolve(__dirname, "..")
const dist = path.join(dir, "../app/dist")
const files = (await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: dist })))
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => !f.endsWith(".map"))
  .sort()
const imports = files.map((f, i) => {
  const rel = path.relative(dir, path.join(dist, f)).replaceAll("\\", "/")
  return `import file_${i} from ${JSON.stringify(rel.startsWith(".") ? rel : `./${rel}`)} with { type: "file" };`
})
const entries = files.map((f, i) => `  ${JSON.stringify(f)}: file_${i},`)
await Bun.write(path.join(dir, "opencode-web-ui.gen.ts"),
  "// Import all files as file_$i with type: \"file\"\n" +
  imports.join("\n") + "\n" +
  "// Export with original mappings\n" +
  "export default {\n" +
  entries.join("\n") + "\n" +
  "}\n")
console.log(`Generated opencode-web-ui.gen.ts with ${files.length} files`)
