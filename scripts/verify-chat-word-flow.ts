import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runTests } from "@vscode/test-electron"

async function main() {
  const repoRoot = join(import.meta.dir, "..")
  const tempRoot = mkdtempSync(join(tmpdir(), "chipmate-chat-word-smoke-"))
  const workspaceRoot = join(tempRoot, "workspace")
  const testPath = join(tempRoot, "index.js")
  mkdirSync(workspaceRoot, { recursive: true })
  writeFileSync(join(workspaceRoot, "README.md"), "# ChipMate Chat Word smoke\n")
  if (!existsSync(join(workspaceRoot, ".agents", "skills", "documents", "SKILL.md"))) {
    cpSync(join(repoRoot, ".agents", "skills", "documents"), join(workspaceRoot, ".agents", "skills", "documents"), { recursive: true })
  }
  writeFileSync(testPath, extensionTestSource())
  process.env.CHIPMATE_ENABLE_SMOKE_COMMANDS = "1"
  try {
    await runTests({
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: testPath,
      launchArgs: ["--disable-extensions", "--disable-gpu", workspaceRoot],
      version: vscodeTestVersion(),
    })
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
}

function extensionTestSource() {
  return `
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const vscode = require("vscode");

const TOOL_ARGS = {
  filename: "chat-word-smoke.docx",
  spec: {
    metadata: {
      title: "Chat Word Smoke",
      documentType: "chat-word-smoke",
      language: "zh-CN",
      generatedAt: "2026-06-28T00:00:00.000Z",
      author: "ChipMate Chat Smoke",
    },
    layout: {
      preset: "standard_business_brief",
      navigation: { mode: "static-toc" },
    },
    cover: {
      title: "Chat Word Smoke",
      subtitle: "ChatView to documents skill to create_word_document",
      preparedBy: "ChipMate",
    },
    sections: [{
      id: "overview",
      level: 1,
      title: "经营概览",
      paragraphs: ["这是一份由 ChatView 普通 Word 请求触发的本地 Word 文档。"],
      lists: [{ kind: "bullet", items: [{ text: "通过 documents skill 路由" }, { text: "调用 create_word_document" }] }],
      tables: [{
        headers: ["路径", "证据"],
        rows: [["ChatView", "sendQuickQuestion"], ["Tool", "create_word_document"]],
        columnWidthRatios: [35, 65],
      }],
    }],
    references: [],
    qualityChecklist: {
      assumptions: ["本测试使用本地 fake OpenAI-compatible provider。"],
      limitations: ["该 smoke 验证 Chat 普通 Word 生成主路径，不验证所有 v2 OOXML 边角。"],
      missingInputs: [],
      risks: [],
    },
  },
};

async function run() {
  const chatBodies = [];
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "chat-model" }] }));
        return;
      }
      if (request.url !== "/v1/chat/completions") {
        response.writeHead(404).end("not found");
        return;
      }
      const body = await collectJson(request);
      chatBodies.push(body);
      const hasToolResult = Array.isArray(body.messages) && body.messages.some((message) => message && message.role === "tool");
      const hasCreateWordTool = JSON.stringify(body.tools || []).includes("create_word_document");
      if (body.stream === true && hasToolResult) {
        writeSse(response, [
          { choices: [{ delta: { content: "已生成 Chat Word Smoke：.chipmate/docs/chat-word-smoke.docx" } }] },
        ]);
        return;
      }
      if (body.stream === true && hasCreateWordTool) {
        writeSse(response, [
          { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_chat_word_smoke", function: { name: "create_word_document", arguments: JSON.stringify(TOOL_ARGS) } }] } }] },
        ]);
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "Chat Word Smoke" } }] }));
    } catch (error) {
      response.writeHead(500).end(String(error && error.stack || error));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const baseUrl = "http://127.0.0.1:" + address.port + "/v1";

  try {
    const config = vscode.workspace.getConfiguration("chipmate");
    const target = vscode.ConfigurationTarget.Workspace;
    await config.update("provider.apiBaseUrl", baseUrl, target);
    await config.update("provider.chatModel", "chat-model", target);
    await config.update("provider.temperature", 0, target);
    await config.update("provider.topP", 1, target);
    await config.update("tools.enabled", true, target);
    await config.update("permissions.mode", "full-access", target);
    await config.update("skills.enabled", ["documents"], target);
    await config.update("skills.scanUserSkills", false, target);
    await config.update("skills.scanClaudeSkills", false, target);
    await config.update("context.localOnlyMode", false, target);
    await config.update("context.maxHistoryTurns", 0, target);
    await config.update("context.memorySummary.enabled", false, target);
    await config.update("codeGraph.enabled", false, target);
    await config.update("codeGraph.promptOnWorkspaceOpen", false, target);
    await config.update("documentRag.enabled", false, target);
    await config.update("completion.enabled", false, target);

    const extension = vscode.extensions.getExtension("local.chipmate");
    assert.ok(extension, "local.chipmate extension should be available");
    await extension.activate();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("chipmate.internal.chatWordSmoke"), "internal Chat Word smoke command should be registered in smoke mode");

    let result;
    try {
      result = await vscode.commands.executeCommand("chipmate.internal.chatWordSmoke", {
        text: "请生成一份年度经营分析 Word，包含目录、表格和结论。",
        timeoutMs: 60000,
      });
    } catch (error) {
      console.error("CHAT_WORD_SMOKE_DEBUG " + JSON.stringify({ error: String(error && error.stack || error), requests: summarizeRequests(chatBodies) }));
      throw error;
    }
    await waitFor(() => chatBodies.some((body) => Array.isArray(body.messages) && body.messages.some((message) => message && message.role === "tool")), 20000);

    assert.equal(result.ok, true, JSON.stringify(result));
    assert.match(result.path, /^\\.chipmate\\/docs\\/chat-word-smoke-\\d{8}-\\d{6}\\.docx$/);
    assert.ok(result.bytes > 1000, JSON.stringify(result));
    const bytes = fs.readFileSync(result.absolutePath);
    assert.equal(bytes.subarray(0, 2).toString("utf8"), "PK");

    const toolRequest = chatBodies.find((body) => JSON.stringify(body.tools || []).includes("create_word_document"));
    assert.ok(toolRequest, "expected first Chat request to expose create_word_document");
    const systemContent = (toolRequest.messages || []).find((message) => message.role === "system")?.content || "";
    assert.ok(systemContent.includes('<skill name="documents"'), "documents skill should be loaded in the ChatView request");
    assert.ok(systemContent.includes("Invocation: implicit"), "documents skill should be implicit for ordinary Word generation");
    assert.ok(systemContent.includes("tasks/create_edit_v1.md"), "documents skill resources should be advertised");

    const toolResultRequest = chatBodies.find((body) => Array.isArray(body.messages) && body.messages.some((message) => message && message.role === "tool"));
    assert.ok(toolResultRequest, "expected Chat to send the create_word_document result back to the provider");
    console.log("CHAT_WORD_SMOKE_RESULT " + JSON.stringify({ result, requestCount: chatBodies.length }));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function collectJson(request) {
  let raw = "";
  for await (const chunk of request) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}

function writeSse(response, chunks) {
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunks.map((chunk) => "data: " + JSON.stringify(chunk) + "\\n\\n").join("") + "data: [DONE]\\n\\n");
}

function summarizeRequests(bodies) {
  return bodies.map((body, index) => {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = messages.find((message) => message && message.role === "system")?.content || "";
    const user = [...messages].reverse().find((message) => message && message.role === "user")?.content || "";
    return {
      index,
      stream: body.stream,
      toolNames: Array.isArray(body.tools) ? body.tools.map((tool) => tool && tool.function && tool.function.name).filter(Boolean).slice(0, 12) : [],
      roles: messages.map((message) => message && message.role).filter(Boolean),
      toolContentPreview: messages.filter((message) => message && message.role === "tool").map((message) => String(message.content || "").slice(0, 500)),
      assistantToolNames: messages
        .filter((message) => message && message.role === "assistant")
        .flatMap((message) => Array.isArray(message.tool_calls) ? message.tool_calls.map((call) => call && call.function && call.function.name).filter(Boolean) : []),
      hasDocumentsSkill: system.includes('<skill name="documents"'),
      hasCreateWordInstruction: system.includes("create_word_document"),
      userPreview: String(user).slice(0, 160),
    };
  });
}

async function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out waiting for Chat Word smoke condition.");
}

exports.run = run;
`
}

function vscodeTestVersion() {
  const explicit = process.env.VSCODE_TEST_VERSION?.trim()
  if (explicit) return explicit
  const result = spawnSync("code", ["--version"], { encoding: "utf8" })
  if (result.status === 0) {
    const version = result.stdout.split(/\r?\n/)[0]?.trim()
    if (/^\d+\.\d+\.\d+/.test(version)) return version
  }
  return undefined
}

if (import.meta.main) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(message)
    process.exit(1)
  })
}
