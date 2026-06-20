import type Parser from "web-tree-sitter"
type SyntaxNode = Parser.SyntaxNode
type Tree = Parser.Tree

import { getParserForFileWithDiagnostics, type TreeSitterLoadDiagnostic } from "../../util/treeSitter"

export type AstPath = SyntaxNode[]
export type AstLoadStatus = "ready" | "runtime-load-failed" | "ast-parse-failed"

export async function getAst(filepath: string, fileContents: string): Promise<Tree | undefined> {
  return (await getAstWithStatus(filepath, fileContents)).ast
}

export async function getAstWithStatus(
  filepath: string,
  fileContents: string,
): Promise<{ ast: Tree | undefined; status: AstLoadStatus; treeSitterDiagnostic?: TreeSitterLoadDiagnostic }> {
  const { parser, diagnostic } = await getParserForFileWithDiagnostics(filepath)

  if (!parser) {
    return { ast: undefined, status: "runtime-load-failed", treeSitterDiagnostic: diagnostic }
  }

  try {
    const ast = parser.parse(fileContents)
    return ast
      ? { ast, status: "ready", treeSitterDiagnostic: diagnostic }
      : { ast: undefined, status: "ast-parse-failed", treeSitterDiagnostic: diagnostic }
  } catch (err) {
    return {
      ast: undefined,
      status: "ast-parse-failed",
      treeSitterDiagnostic: {
        ...diagnostic,
        stage: "ast-parse-failed",
        errorKind: err instanceof Error ? err.name || "Error" : typeof err,
        errorMessage: err instanceof Error ? err.message.slice(0, 300) : String(err).slice(0, 300),
      },
    }
  }
}

export async function getTreePathAtCursor(ast: Tree, cursorIndex: number): Promise<AstPath> {
  const path = [ast.rootNode]
  while (path[path.length - 1].childCount > 0) {
    let foundChild = false
    for (const child of path[path.length - 1].children) {
      if (child && child.startIndex <= cursorIndex && child.endIndex >= cursorIndex) {
        path.push(child)
        foundChild = true
        break
      }
    }

    if (!foundChild) {
      break
    }
  }

  return path
}
