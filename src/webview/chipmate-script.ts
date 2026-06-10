export function chipmateScript(iconsJson: string) {
  return `
const vscode = acquireVsCodeApi()
const icons = ${iconsJson}
let state = undefined
let activeModule = "chat"
let mentionRequestId = 0
let mentionResults = []
let selectedMentionFiles = []
let activeMentionQuery = ""

const byId = (id) => document.getElementById(id)

document.querySelectorAll("[data-icon]").forEach((node) => {
  node.innerHTML = icon(node.dataset.icon)
})

window.addEventListener("message", (event) => {
  if (event.data?.type === "state") {
    state = event.data.state
    render()
  }
  if (event.data?.type === "mentionResults" && event.data.requestId === mentionRequestId) {
    mentionResults = event.data.files || []
    renderMentionResults(event.data.error || "")
  }
})

document.addEventListener("click", (event) => {
  const moduleButton = event.target.closest("[data-module]")
  if (moduleButton) {
    activeModule = moduleButton.dataset.module
    render()
    return
  }

  const knowledgeButton = event.target.closest("[data-knowledge-action]")
  if (knowledgeButton) {
    const action = knowledgeButton.dataset.knowledgeAction
    if (confirmKnowledgeAction(action)) vscode.postMessage({ type: "knowledgeAction", action })
    return
  }

  const install = event.target.closest("[data-install]")
  if (install) {
    vscode.postMessage({ type: "installPackage", id: install.dataset.id, packageType: install.dataset.type, version: install.dataset.version })
    return
  }

  const rollback = event.target.closest("[data-rollback]")
  if (rollback) {
    vscode.postMessage({ type: "rollbackPackage", id: rollback.dataset.id, packageType: rollback.dataset.type })
    return
  }

  const probe = event.target.closest("[data-probe-mcp]")
  if (probe) {
    vscode.postMessage({ type: "probeMcpPackage", id: probe.dataset.id })
    return
  }

  const removeMention = event.target.closest("[data-remove-mention]")
  if (removeMention) {
    selectedMentionFiles.splice(Number(removeMention.dataset.removeMention), 1)
    renderSelectedMentions()
    return
  }

  const mention = event.target.closest("[data-mention-index]")
  if (mention) {
    selectMention(Number(mention.dataset.mentionIndex))
    return
  }

  const id = event.target.closest("button")?.id
  if (id === "openDiagnostics") vscode.postMessage({ type: "openOutput" })
  if (id === "openSettings") {
    activeModule = "settings"
    render()
  }
  if (id === "saveModelSettings") saveModelSettings()
  if (id === "saveKnowledgeSettings") saveKnowledgeSettings()
  if (id === "saveGlobalSettings") saveGlobalSettings()
  if (id === "refreshCatalog") vscode.postMessage({ type: "refreshCatalog" })
  if (id === "setKey") vscode.postMessage({ type: "setApiKey" })
  if (id === "setRagKey") vscode.postMessage({ type: "setRagApiKey" })
  if (id === "newSession") vscode.postMessage({ type: "newSession" })
  if (id === "addContextInline") vscode.postMessage({ type: "addFile" })
  if (id === "clearContextInline") vscode.postMessage({ type: "clearContext" })
})

document.addEventListener("change", (event) => {
  if (event.target.id === "sessionSelect") {
    const sessionId = event.target.value
    if (sessionId) vscode.postMessage({ type: "selectSession", sessionId })
  }
})

byId("sendButton").addEventListener("click", () => {
  if (state?.sending) {
    vscode.postMessage({ type: "cancelSend" })
    return
  }
  send()
})
byId("composerInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) send()
})
byId("composerInput").addEventListener("input", updateMentionSearch)
byId("attachContext").addEventListener("click", () => vscode.postMessage({ type: "addFile" }))
byId("clearContextButton").addEventListener("click", () => vscode.postMessage({ type: "clearContext" }))

vscode.postMessage({ type: "ready" })

function render() {
  if (!state) return
  renderChrome()
  renderStatusStrip()
  renderMain()
  toggleComposer()
  renderSelectedMentions()
}

function renderChrome() {
  byId("modelPillText").textContent = state.configured ? state.model : "Model required"
  byId("modelStatusDot").className = "statusDot" + (state.configured ? "" : " warn")
  byId("permissionShortcutText").textContent = readableProfileShort(state.permissionProfile)
  document.querySelectorAll(".dockButton").forEach((button) => {
    button.classList.toggle("active", button.dataset.module === activeModule)
  })
  byId("sendButton").classList.toggle("stop", Boolean(state.sending))
  byId("sendButton").innerHTML = icon(state.sending ? "stop" : "send")
  byId("sendButton").title = state.sending ? "Stop" : "Send"
}

function renderStatusStrip() {
  const graph = state.codeGraphStatus
  const rag = state.ragStatus || graph?.rag
  const contextCount = (state.contextSummary || []).length + (state.contextLabels || []).length
  const graphTotal = graph?.progress?.total || 0
  const graphDone = graph?.progress?.completed || 0
  const graphPct = graphTotal > 0 ? Math.round((graphDone / graphTotal) * 100) : graph?.state === "ready" ? 100 : graph?.indexedFiles ? 74 : 0
  const ragChunks = Number(rag?.chunks || 0)
  const ragEmbedded = Number(rag?.embeddedChunks || 0)
  const ragPct = ragChunks > 0 ? Math.round((ragEmbedded / ragChunks) * 100) : rag?.availability === "ready" ? 100 : 0
  const skillsReady = (state.skillSummaries || []).filter((skill) => skill.state === "Ready").length
  const skillTotal = Math.max((state.installedPackages || []).filter((pkg) => pkg.type === "skill").length, skillsReady)
  const mcpPackages = (state.installedPackages || []).filter((pkg) => pkg.type === "mcp")
  const probedMcp = mcpPackages.filter((pkg) => state.mcpProbeResults?.[pkg.id]?.state === "ready").length
  byId("statusStrip").innerHTML = [
    ringHtml("database", "Context", contextCount ? String(contextCount) : "0", contextStatusTitle(), contextCount ? 100 : 0, "var(--cm-accent-2)"),
    ringHtml("references", "Graph", graphPct ? graphPct + "%" : "off", "CodeGraph - " + graphDetail(graph), graphPct, graphStateColor(graph?.state)),
    ringHtml("sync", "RAG", ragPct ? ragPct + "%" : readableRagAvailability(rag), "Vector RAG - " + ragDetail(rag), ragPct, ragStateColor(rag?.availability)),
    ringHtml("beaker", "Rerank", rag?.rerankEnabled ? "on" : "off", rag?.rerankProvider || rag?.rerankLastError || "Rerank provider", rag?.rerankEnabled ? 100 : 0, rag?.rerankEnabled ? "var(--cm-ready)" : "var(--cm-warn)"),
    ringHtml("sparkle", "Skills", skillTotal ? skillsReady + "/" + skillTotal : "0", "Installed skill readiness", skillTotal ? Math.round((skillsReady / skillTotal) * 100) : 0, "var(--cm-accent)"),
    ringHtml("server", "MCP", mcpPackages.length ? probedMcp + "/" + mcpPackages.length : "0", "MCP servers probed with tools/list", mcpPackages.length ? Math.round((probedMcp / mcpPackages.length) * 100) : 0, "var(--cm-accent)")
  ].join("")
}

function renderMain() {
  const main = byId("mainSurface")
  if (activeModule === "chat") main.innerHTML = renderChatModule()
  if (activeModule === "models") main.innerHTML = renderModelsModule()
  if (activeModule === "knowledge") main.innerHTML = renderKnowledgeModule()
  if (activeModule === "skills") main.innerHTML = renderSkillsModule()
  if (activeModule === "mcp") main.innerHTML = renderMcpModule()
  if (activeModule === "settings") main.innerHTML = renderSettingsModule()
}

function toggleComposer() {
  byId("chatComposer").style.display = activeModule === "chat" ? "grid" : "none"
}

function renderChatModule() {
  return [
    '<section class="modulePanel">',
    '<div class="sessionBar">',
    '<label class="selectShell" title="Select chat session"><span>' + icon("chat") + '</span><select id="sessionSelect" aria-label="Select chat session">' + sessionOptionsHtml() + '</select></label>',
    '<button class="glassButton primary" id="newSession">' + icon("add") + '<span>New</span></button>',
    '</div>',
    '<div class="contextChipList">' + contextChipsHtml() + '</div>',
    noticesHtml(),
    '<div class="messages">' + messagesHtml() + '</div>',
    '</section>'
  ].join("")
}

function renderModelsModule() {
  const chat = state.chatSettings || {}
  const completion = state.completionSettings || {}
  return [
    '<section class="modulePanel">',
    moduleHeader("agent", "Models", "Connection and completion profiles", '<button class="glassButton" id="setKey">' + icon("key") + '<span>API Key</span></button>'),
    noticeLine(state.settingsNotice),
    '<section class="fieldPanel">',
    '<div class="fieldGrid">',
    fieldInput("apiBaseUrl", "API base URL", chat.apiBaseUrl || state.apiBaseUrl || "", "http://localhost:8000/v1", "wide"),
    fieldInput("model", "Chat model", chat.model || state.model || "", "deepseek-v4-flash", ""),
    fieldNumber("chatMaxTokens", "Max tokens", chat.maxTokens || 4096, 1, 32768, ""),
    fieldNumber("chatTemperature", "Temperature", chat.temperature ?? 0.2, 0, 2, ""),
    fieldNumber("chatTopP", "Top P", chat.topP ?? 1, 0, 1, ""),
    '<label class="toggleRow field wide"><span><span class="fieldLabel">Streaming</span><span class="rowMeta">Use provider streaming when available.</span></span><input id="chatStreaming" type="checkbox" ' + checked(chat.streaming !== false) + '></label>',
    '</div>',
    '<details>',
    '<summary>Advanced completion</summary>',
    '<div class="fieldGrid">',
    '<label class="toggleRow field wide"><span><span class="fieldLabel">Inline completion</span><span class="rowMeta">' + escapeHtml(completionSummary(completion)) + '</span></span><input id="completionEnabled" type="checkbox" ' + checked(Boolean(completion.enabled)) + '></label>',
    fieldInput("completionApiBaseUrl", "Completion base URL", completion.apiBaseUrl || "", "Inherit chat URL", "wide"),
    fieldInput("completionModel", "Completion model", completion.model || "", "Inherit chat model", ""),
    fieldSelect("completionProfile", "Completion profile", completion.profile || "generic-chat", [["generic-chat", "Generic Chat"], ["qwen-coder-fim", "Qwen Coder FIM"]], ""),
    fieldNumber("completionDebounceMs", "Debounce ms", completion.debounceMs ?? 350, 0, 5000, ""),
    fieldNumber("completionMaxTokens", "Max tokens", completion.maxTokens ?? 128, 1, 4096, ""),
    fieldNumber("completionTemperature", "Temperature", completion.temperature ?? 0, 0, 2, ""),
    fieldNumber("completionTopP", "Top P", completion.topP ?? 1, 0, 1, ""),
    fieldSelect("completionLogLevel", "Log level", completion.logLevel || "info", [["off", "Off"], ["info", "Info"], ["debug", "Debug"]], ""),
    '</div>',
    '</details>',
    '<div class="inlineActions"><button class="glassButton primary" id="saveModelSettings">' + icon("save") + '<span>Save Models</span></button></div>',
    '</section>',
    '</section>'
  ].join("")
}

function renderKnowledgeModule() {
  const graph = state.codeGraphStatus || {}
  const rag = state.ragStatus || graph.rag || {}
  const ragSettings = state.ragSettings || { embedding: {}, rerank: {}, allowedHosts: [] }
  const graphPct = graph.progress?.total ? Math.round((graph.progress.completed / graph.progress.total) * 100) : graph.state === "ready" ? 100 : 0
  const ragPct = rag.chunks ? Math.round((Number(rag.embeddedChunks || 0) / Number(rag.chunks || 1)) * 100) : 0
  return [
    '<section class="modulePanel">',
    moduleHeader("database", "Knowledge", "CodeGraph, RAG, graph/vector/rerank health", '<button class="glassButton" data-knowledge-action="check">' + icon("retry") + '<span>Check</span></button>'),
    noticeLine(state.knowledgeNotice),
    '<section class="settingsBand">',
    glassRow("references", "CodeGraph", graphDetail(graph), statusPill(graph.state || "disabled", graphStateClass(graph.state))),
    progressBar(graphPct),
    '<div class="fieldGrid">',
    metricRow("Files", graph.indexedFiles || 0),
    metricRow("Functions", graph.indexedFunctions || 0),
    metricRow("Macros", graph.indexedMacros || 0),
    metricRow("Queue", graph.queue?.pendingJobs ?? graph.queueLength ?? 0),
    '</div>',
    '</section>',
    '<section class="settingsBand">',
    glassRow("sync", "Vector RAG", ragDetail(rag), statusPill(readableRagAvailability(rag), ragStateClass(rag.availability))),
    progressBar(ragPct),
    '<div class="fieldGrid">',
    metricRow("Chunks", Number(rag.chunks || 0)),
    metricRow("Embedded", Number(rag.embeddedChunks || 0)),
    metricRow("Pending", Number(rag.pendingChunkCount || 0)),
    metricRow("Shards", Number(rag.vectorShards || 0)),
    '</div>',
    '</section>',
    '<section class="capabilityGrid">',
    capability("references", "Graph", graph.enabled !== false, graph.state || "disabled"),
    capability("database", "Vector", Boolean(rag.embeddingEnabled || rag.vectorShards), readableRagAvailability(rag)),
    capability("beaker", "Rerank", Boolean(rag.rerankEnabled), rag.rerankProvider || "optional"),
    '</section>',
    '<section class="settingsBand">',
    '<div class="inlineActions">',
    '<button class="toolButton" data-knowledge-action="check">' + icon("retry") + '<span>Check</span></button>',
    '<button class="toolButton primary" data-knowledge-action="apply">' + icon("apply") + '<span>Apply</span></button>',
    '<button class="toolButton danger" data-knowledge-action="rebuild">' + icon("sync") + '<span>Rebuild</span></button>',
    '<button class="toolButton" data-knowledge-action="pause">' + icon("pause") + '<span>Pause</span></button>',
    '<button class="toolButton" data-knowledge-action="resume">' + icon("play") + '<span>Resume</span></button>',
    '<button class="toolButton danger" data-knowledge-action="cancel">' + icon("stop") + '<span>Cancel</span></button>',
    '</div>',
    '<details>',
    '<summary>Advanced retrieval settings</summary>',
    '<div class="fieldGrid">',
    fieldInput("ragEmbeddingEndpoint", "Embedding endpoint", ragSettings.embedding?.endpoint || "", "http://localhost:8000/v1/embeddings", "wide"),
    fieldInput("ragEmbeddingModel", "Embedding model", ragSettings.embedding?.model || "", "bge-m3", ""),
    fieldNumber("ragEmbeddingBatchSize", "Batch size", ragSettings.embedding?.batchSize || 128, 1, 512, ""),
    fieldNumber("ragEmbeddingMaxTokensPerRequest", "Max tokens/request", ragSettings.embedding?.maxTokensPerRequest || 65536, 1, 1000000, ""),
    fieldNumber("ragEmbeddingConcurrentRequests", "Concurrent requests", ragSettings.embedding?.concurrentRequests || 3, 1, 8, ""),
    fieldNumber("ragEmbeddingMaxInFlightTokens", "Max in-flight tokens", ragSettings.embedding?.maxInFlightTokens || 360000, 32768, 1000000, ""),
    fieldSelect("ragEmbeddingEncodingFormat", "Encoding", ragSettings.embedding?.encodingFormat || "auto", [["auto", "Auto"], ["float", "Float"], ["base64", "Base64"]], ""),
    fieldSelect("ragEmbeddingCheckpointMode", "Checkpoint", ragSettings.embedding?.checkpointMode || "interval", [["off", "Off"], ["interval", "Interval"], ["safe", "Safe"]], ""),
    fieldNumber("ragEmbeddingCheckpointChunkInterval", "Checkpoint chunks", ragSettings.embedding?.checkpointChunkInterval || 8192, 0, 1000000, ""),
    fieldNumber("ragEmbeddingCheckpointIntervalMs", "Checkpoint ms", ragSettings.embedding?.checkpointIntervalMs || 120000, 0, 3600000, ""),
    fieldNumber("ragEmbeddingRequestDelayMs", "Request delay ms", ragSettings.embedding?.requestDelayMs || 0, 0, 60000, ""),
    fieldNumber("ragEmbeddingMaxRequestsPerRun", "Max requests/run", ragSettings.embedding?.maxRequestsPerRun ?? 100, 0, 100000, ""),
    fieldNumber("ragEmbeddingMaxRetries", "Max retries", ragSettings.embedding?.maxRetries ?? 3, 0, 10, ""),
    fieldNumber("ragEmbeddingRetryBackoffMs", "Retry backoff ms", ragSettings.embedding?.retryBackoffMs ?? 2000, 0, 120000, ""),
    '<label class="toggleRow field wide"><span><span class="fieldLabel">Auto resume</span><span class="rowMeta">Resume paused RAG embedding runs.</span></span><input id="ragEmbeddingResumeAutomatically" type="checkbox" ' + checked(ragSettings.embedding?.resumeAutomatically !== false) + '></label>',
    fieldNumber("ragEmbeddingResumeDelayMs", "Resume delay ms", ragSettings.embedding?.resumeDelayMs || 60000, 0, 3600000, ""),
    fieldInput("ragRerankEndpoint", "Rerank endpoint", ragSettings.rerank?.endpoint || "", "http://localhost:8000/rerank", "wide"),
    fieldInput("ragRerankModel", "Rerank model", ragSettings.rerank?.model || "", "bge-reranker", ""),
    fieldNumber("ragVectorTopK", "Vector top K", ragSettings.vectorTopK || 24, 0, 200, ""),
    fieldNumber("ragRerankTopK", "Rerank top K", ragSettings.rerankTopK || 16, 0, 200, ""),
    '<label class="field wide"><span class="fieldLabel">Allowed hosts</span><textarea id="ragAllowedHosts" placeholder="one host per line">' + escapeHtml((ragSettings.allowedHosts || []).join("\\n")) + '</textarea></label>',
    '</div>',
    '<div class="inlineActions"><button class="glassButton" id="setRagKey">' + icon("key") + '<span>RAG Key</span></button><button class="glassButton primary" id="saveKnowledgeSettings">' + icon("save") + '<span>Save Knowledge</span></button></div>',
    '</details>',
    '</section>',
    '</section>'
  ].join("")
}

function renderSkillsModule() {
  const available = (state.catalogPackages || []).filter((pkg) => pkg.type === "skill")
  const installed = state.skillSummaries || []
  return [
    '<section class="modulePanel">',
    moduleHeader("beaker", "Skills", "Agent Skills catalog and installed capabilities", '<button class="glassButton" id="refreshCatalog">' + icon("refresh") + '<span>Refresh</span></button>'),
    catalogNoticeHtml(),
    noticeLine(state.settingsNotice),
    '<section class="fieldPanel">' + fieldInput("skillsCatalogUrl", "Catalog URL", state.catalogUrl || "", "http://offline.local/catalog.json", "wide") + '<div class="inlineActions"><button class="glassButton primary" id="saveGlobalSettings">' + icon("save") + '<span>Save Catalog</span></button></div></section>',
    sectionTitle("Available Skills"),
    '<div class="packageList">' + (available.length ? available.map((pkg) => packageRow(pkg, false)).join("") : emptyHtml("No skill catalog loaded.")) + '</div>',
    sectionTitle("Installed Skills"),
    '<div class="packageList">' + (installed.length ? installed.map(skillRow).join("") : emptyHtml("No skills installed.")) + '</div>',
    '</section>'
  ].join("")
}

function renderMcpModule() {
  const available = (state.catalogPackages || []).filter((pkg) => pkg.type === "mcp")
  const installed = (state.installedPackages || []).filter((pkg) => pkg.type === "mcp")
  return [
    '<section class="modulePanel">',
    moduleHeader("references", "MCP", "Server packages, stdio probe status, and tool visibility", '<button class="glassButton" id="refreshCatalog">' + icon("refresh") + '<span>Refresh</span></button>'),
    catalogNoticeHtml(),
    noticeLine(state.settingsNotice),
    '<section class="fieldPanel">' + fieldInput("mcpCatalogUrl", "Catalog URL", state.catalogUrl || "", "http://offline.local/catalog.json", "wide") + '<div class="inlineActions"><button class="glassButton primary" id="saveGlobalSettings">' + icon("save") + '<span>Save Catalog</span></button><button class="glassButton" data-probe-mcp>' + icon("sync") + '<span>Probe All</span></button></div></section>',
    sectionTitle("Available MCP Packages"),
    '<div class="packageList">' + (available.length ? available.map((pkg) => packageRow(pkg, false)).join("") : emptyHtml("No MCP catalog loaded.")) + '</div>',
    sectionTitle("Installed MCP Servers"),
    '<div class="packageList">' + (installed.length ? installed.map(mcpRow).join("") : emptyHtml("No MCP servers installed.")) + '</div>',
    '</section>'
  ].join("")
}

function renderSettingsModule() {
  return [
    '<section class="modulePanel">',
    moduleHeader("settings", "Settings", "Cross-module defaults, diagnostics, and UI preferences", '<button class="glassButton" id="openDiagnostics">' + icon("diagnostics") + '<span>Logs</span></button>'),
    noticeLine(state.settingsNotice),
    '<section class="fieldPanel">',
    '<div class="fieldGrid">',
    fieldSelect("globalPermissionProfile", "Default permission profile", state.permissionProfile || "askApproval", [["readOnly", "Read"], ["askApproval", "Ask"], ["trustedWorkspace", "Trusted"], ["fullAccess", "Full"]], ""),
    fieldSelect("uiDensity", "UI density", "auto", [["auto", "Auto"], ["compact", "Compact"], ["roomy", "Roomy"]], ""),
    fieldInput("catalogUrl", "Shared catalog URL", state.catalogUrl || "", "http://offline.local/catalog.json", "wide"),
    '</div>',
    '<div class="inlineActions"><button class="glassButton" id="openDiagnostics">' + icon("diagnostics") + '<span>Open diagnostics logs</span></button><button class="glassButton primary" id="saveGlobalSettings">' + icon("save") + '<span>Save Settings</span></button></div>',
    '</section>',
    '<section class="settingsBand">',
    glassRow("shield", "Permissions", "Composer chip shortcuts the global chipmate.permissions.profile setting.", statusPill(readableProfileShort(state.permissionProfile), "ready")),
    glassRow("diagnostics", "Diagnostics", "The diagnostics icon opens the ChipMate Output channel; it is not chat history.", statusPill("logs", "ready")),
    '</section>',
    '</section>'
  ].join("")
}

function send() {
  const input = byId("composerInput")
  const text = input.value.trim()
  if ((!text && selectedMentionFiles.length === 0) || state?.sending) return
  input.value = ""
  const mentionedFiles = selectedMentionFiles.slice()
  selectedMentionFiles = []
  mentionResults = []
  renderSelectedMentions()
  renderMentionResults("")
  vscode.postMessage({ type: "sendMessage", text, mentionedFiles })
}

function updateMentionSearch() {
  const input = byId("composerInput")
  const beforeCursor = input.value.slice(0, input.selectionStart || input.value.length)
  const match = /(^|\\s)@([^\\s@]*)$/.exec(beforeCursor)
  if (!match) {
    activeMentionQuery = ""
    mentionResults = []
    renderMentionResults("")
    return
  }
  activeMentionQuery = match[2] || ""
  const requestId = ++mentionRequestId
  vscode.postMessage({ type: "searchFilesForMention", query: activeMentionQuery, requestId })
}

function selectMention(index) {
  const item = mentionResults[index]
  if (!item) return
  if (item.type === "folder") {
    replaceActiveMention(item.insertText)
    updateMentionSearch()
    return
  }
  if (item.uri && !selectedMentionFiles.some((file) => file.uri === item.uri)) {
    selectedMentionFiles.push({ uri: item.uri, label: item.label })
  }
  replaceActiveMention(item.insertText)
  mentionResults = []
  renderSelectedMentions()
  renderMentionResults("")
  byId("composerInput").focus()
}

function replaceActiveMention(insertText) {
  const input = byId("composerInput")
  const cursor = input.selectionStart || input.value.length
  const beforeCursor = input.value.slice(0, cursor)
  const afterCursor = input.value.slice(cursor)
  const replaced = beforeCursor.replace(/(^|\\s)@([^\\s@]*)$/, (full, prefix) => prefix + "@" + insertText + " ")
  input.value = replaced + afterCursor
  input.selectionStart = input.selectionEnd = replaced.length
}

function renderSelectedMentions() {
  byId("mentionChips").innerHTML = selectedMentionFiles.map((file, index) =>
    '<button class="contextChip" data-remove-mention="' + index + '">@' + escapeHtml(file.label || file.uri) + '</button>'
  ).join("")
}

function renderMentionResults(error) {
  const box = byId("mentionBox")
  const rows = error
    ? '<div class="notice error">' + escapeHtml(error) + '</div>'
    : mentionResults.map((item, index) =>
      '<button class="mentionItem" data-mention-index="' + index + '"><span class="rowTitle">' +
      escapeHtml(item.insertText || item.label) + '</span><span class="rowMeta">' + escapeHtml(item.type) + '</span></button>'
    ).join("")
  box.innerHTML = rows
  box.classList.toggle("active", Boolean(rows))
}

function saveModelSettings() {
  vscode.postMessage({
    type: "saveModelSettings",
    chatApiBaseUrl: value("apiBaseUrl"),
    chatModel: value("model"),
    chatStreaming: checkedValue("chatStreaming"),
    chatMaxTokens: numberValue("chatMaxTokens", 4096),
    chatTemperature: numberValue("chatTemperature", 0.2),
    chatTopP: numberValue("chatTopP", 1),
    completionEnabled: checkedValue("completionEnabled"),
    completionApiBaseUrl: value("completionApiBaseUrl"),
    completionModel: value("completionModel"),
    completionProfile: value("completionProfile") || "generic-chat",
    completionDebounceMs: numberValue("completionDebounceMs", 350),
    completionMaxTokens: numberValue("completionMaxTokens", 128),
    completionTemperature: numberValue("completionTemperature", 0),
    completionTopP: numberValue("completionTopP", 1),
    completionLogLevel: value("completionLogLevel") || "info"
  })
}

function saveKnowledgeSettings() {
  vscode.postMessage({
    type: "saveKnowledgeSettings",
    rag: {
      embeddingEndpoint: value("ragEmbeddingEndpoint"),
      embeddingModel: value("ragEmbeddingModel"),
      embeddingBatchSize: numberValue("ragEmbeddingBatchSize", 128),
      embeddingMaxTokensPerRequest: numberValue("ragEmbeddingMaxTokensPerRequest", 65536),
      embeddingConcurrentRequests: numberValue("ragEmbeddingConcurrentRequests", 3),
      embeddingMaxInFlightTokens: numberValue("ragEmbeddingMaxInFlightTokens", 360000),
      embeddingEncodingFormat: value("ragEmbeddingEncodingFormat") || "auto",
      embeddingCheckpointMode: value("ragEmbeddingCheckpointMode") || "interval",
      embeddingCheckpointChunkInterval: numberValue("ragEmbeddingCheckpointChunkInterval", 8192),
      embeddingCheckpointIntervalMs: numberValue("ragEmbeddingCheckpointIntervalMs", 120000),
      embeddingRequestDelayMs: numberValue("ragEmbeddingRequestDelayMs", 0),
      embeddingMaxRequestsPerRun: numberValue("ragEmbeddingMaxRequestsPerRun", 100),
      embeddingMaxRetries: numberValue("ragEmbeddingMaxRetries", 3),
      embeddingRetryBackoffMs: numberValue("ragEmbeddingRetryBackoffMs", 2000),
      embeddingResumeAutomatically: checkedValue("ragEmbeddingResumeAutomatically"),
      embeddingResumeDelayMs: numberValue("ragEmbeddingResumeDelayMs", 60000),
      rerankEndpoint: value("ragRerankEndpoint"),
      rerankModel: value("ragRerankModel"),
      allowedHosts: value("ragAllowedHosts").split(/[\\n,]/).map((item) => item.trim()).filter(Boolean),
      vectorTopK: numberValue("ragVectorTopK", 24),
      rerankTopK: numberValue("ragRerankTopK", 16)
    }
  })
}

function saveGlobalSettings() {
  const catalog = value("catalogUrl") || value("skillsCatalogUrl") || value("mcpCatalogUrl")
  vscode.postMessage({
    type: "saveGlobalSettings",
    catalogUrl: catalog,
    permissionProfile: value("globalPermissionProfile") || state.permissionProfile || "askApproval"
  })
}

function confirmKnowledgeAction(action) {
  if (action === "rebuild") return confirm("Rebuild local knowledge indexes?")
  if (action === "cancel") return confirm("Cancel active knowledge indexing?")
  return true
}

function sessionOptionsHtml() {
  const sessions = state.sessions || []
  if (!sessions.length) return '<option value="">New chat</option>'
  return sessions.map((session) =>
    '<option value="' + escapeAttr(session.id) + '" ' + (session.id === state.activeSessionId ? "selected" : "") + '>' +
    escapeHtml(displaySessionTitle(session, sessions)) + '</option>'
  ).join("")
}

function displaySessionTitle(session, sessions) {
  const base = normalizedSessionTitle(session.title)
  const same = sessions.filter((item) => normalizedSessionTitle(item.title) === base)
  if (same.length <= 1) return base
  return base + " " + (same.findIndex((item) => item.id === session.id) + 1)
}

function normalizedSessionTitle(title) {
  const clean = String(title || "").trim().replace(/^ChipMate\\s+/i, "")
  return clean || "Chat"
}

function contextChipsHtml() {
  const labels = state.contextLabels || []
  const summary = state.contextSummary || []
  const chips = []
  for (const item of summary.slice(0, 4)) chips.push('<span class="contextChip" title="' + escapeAttr(contextSummaryTitle(item)) + '">' + contextIcon(item) + '<span>' + escapeHtml(contextSummaryLabel(item)) + '</span></span>')
  for (const label of labels.slice(0, 4)) chips.push('<span class="contextChip">' + icon("file") + '<span>' + escapeHtml(label) + '</span></span>')
  chips.push('<button class="contextChip" id="addContextInline">' + icon("attach") + '<span>Add current file</span></button>')
  if (labels.length || summary.length) chips.push('<button class="contextChip" id="clearContextInline">' + icon("discard") + '<span>Clear</span></button>')
  return chips.join("")
}

function messagesHtml() {
  const messages = (state.messages || []).concat(state.streamingText ? [{ id: "streaming", role: "assistant", text: state.streamingText, createdAt: Date.now() }] : [])
  if (!messages.length) return emptyHtml("Start with a question, attach context, or ask ChipMate to inspect the current file.")
  return messages.map((message) => {
    const role = message.role === "user" ? "user" : "assistant"
    return '<article class="messageWrap ' + escapeAttr(role) + '"><div class="messageBubble"><div class="messageMeta">' +
      '<span class="avatar" aria-hidden="true"><span class="avatarText">' + (role === "user" ? "U" : "C") + '</span></span>' +
      '<span class="messageAuthor">' + (role === "user" ? "You" : "ChipMate") + '</span><span>' + formatTime(message.createdAt) + '</span></div>' +
      '<div class="messageText">' + escapeHtml(message.text) + '</div></div></article>'
  }).join("")
}

function packageRow(pkg) {
  return '<article class="glassRow"><span class="rowIcon">' + icon(pkg.type === "mcp" ? "server" : "beaker") + '</span><span class="rowBody"><span class="rowTitle">' +
    escapeHtml(pkg.name) + '</span><span class="rowMeta">' + escapeHtml(pkg.id + "@" + pkg.version) + " - " + escapeHtml(pkg.description || "") + '</span></span>' +
    '<span class="rowActions"><button class="glassButton primary" data-install data-id="' + escapeAttr(pkg.id) + '" data-type="' + escapeAttr(pkg.type) + '" data-version="' + escapeAttr(pkg.version) + '">Install</button></span></article>'
}

function skillRow(skill) {
  const detail = [
    skill.version ? "v" + skill.version : "",
    skill.allowedTools?.length ? "tools: " + skill.allowedTools.slice(0, 3).join(", ") : "no allowed-tools declared",
    skill.compatibility?.length ? "compat: " + skill.compatibility.join(", ") : "compatibility not declared"
  ].filter(Boolean).join(" - ")
  return '<article class="glassRow"><span class="rowIcon">' + icon("beaker") + '</span><span class="rowBody"><span class="rowTitle">' +
    escapeHtml(skill.name || skill.id) + '</span><span class="rowMeta" title="' + escapeAttr(skill.error || detail) + '">' + escapeHtml(skill.description || detail) + '</span><span class="rowMeta">' + escapeHtml(detail) + '</span></span>' +
    '<span class="rowActions">' + statusPill(skill.state, skill.state === "Ready" ? "ready" : "warn") + '<button class="glassButton" data-rollback data-id="' + escapeAttr(skill.id) + '" data-type="skill">Rollback</button></span></article>'
}

function mcpRow(pkg) {
  const probe = state.mcpProbeResults?.[pkg.id] || { state: "unprobed", tools: [], manifestValid: false }
  const toolRows = probe.tools?.length
    ? '<div class="toolList">' + probe.tools.map((tool) => glassRow("settings", tool.name, (tool.description || tool.schemaSummary || "MCP tool"), statusPill(tool.availability || "Ready", tool.availability === "Ready" ? "ready" : "warn"))).join("") + '</div>'
    : '<div class="rowMeta">' + escapeHtml(probe.error || "Probe tools/list to inspect tools without executing them.") + '</div>'
  return '<article class="settingsBand"><div class="glassRow"><span class="rowIcon">' + icon("server") + '</span><span class="rowBody"><span class="rowTitle">' +
    escapeHtml(pkg.name) + '</span><span class="rowMeta">' + escapeHtml(pkg.id + "@" + pkg.version + " - " + (pkg.description || "")) + '</span></span>' +
    '<span class="rowActions">' + statusPill(probe.state, probe.state === "ready" ? "ready" : probe.state === "error" ? "danger" : "warn") +
    '<button class="glassButton" data-probe-mcp data-id="' + escapeAttr(pkg.id) + '">' + icon("sync") + '<span>Probe</span></button>' +
    '<button class="glassButton" data-rollback data-id="' + escapeAttr(pkg.id) + '" data-type="mcp">Rollback</button></span></div>' + toolRows + '</article>'
}

function noticesHtml() {
  return [
    state.error ? '<div class="notice error">' + escapeHtml(state.error) + '</div>' : "",
    state.toolStatus ? '<div class="notice">' + escapeHtml(state.toolStatus) + '</div>' : "",
    !state.configured ? '<div class="notice">Configure an OpenAI-compatible model before sending.</div>' : ""
  ].join("")
}

function catalogNoticeHtml() {
  return state.catalogError ? '<div class="notice">' + escapeHtml(state.catalogError) + '</div>' : ""
}

function moduleHeader(iconName, title, subtitle, actions) {
  return '<header class="moduleHeader"><span class="moduleTitle"><strong>' + escapeHtml(title) + '</strong><span>' + escapeHtml(subtitle) + '</span></span><span class="inlineActions">' + (actions || "") + '</span></header>'
}

function ringHtml(iconName, label, value, title, progress, color) {
  return '<article class="statusRing" title="' + escapeAttr(title || "") + '"><span class="ringGraphic" style="--progress: ' + clampProgress(progress) + '%; --ring-color: ' + escapeAttr(color || "var(--cm-accent)") + '"><span class="ringCore">' + icon(iconName) + '</span></span><span class="ringLabel">' + escapeHtml(label) + '</span><span class="ringValue">' + escapeHtml(value) + '</span></article>'
}

function progressBar(progress) {
  return '<div class="progressBar"><div class="progressFill" style="--progress: ' + clampProgress(progress) + '%"></div></div>'
}

function capability(iconName, label, ready, detail) {
  return '<article class="capability">' + '<span class="ringCore">' + icon(iconName) + '</span><strong>' + escapeHtml(label) + '</strong>' + statusPill(ready ? "Ready" : "Degraded", ready ? "ready" : "warn") + '<span class="ringValue">' + escapeHtml(detail || "") + '</span></article>'
}

function glassRow(iconName, title, meta, trailing) {
  return '<div class="glassRow"><span class="rowIcon">' + icon(iconName) + '</span><span class="rowBody"><span class="rowTitle">' + escapeHtml(title) + '</span><span class="rowMeta">' + escapeHtml(meta || "") + '</span></span><span class="rowActions">' + (trailing || "") + '</span></div>'
}

function metricRow(label, value) {
  return '<div class="glassRow"><span class="rowIcon">' + icon("database") + '</span><span class="rowBody"><span class="rowMeta">' + escapeHtml(label) + '</span><span class="rowTitle">' + escapeHtml(formatNumber(value)) + '</span></span><span></span></div>'
}

function statusPill(text, tone) {
  const dot = tone === "danger" ? " danger" : tone === "warn" ? " warn" : ""
  return '<span class="miniPill"><span class="statusDot' + dot + '"></span><span>' + escapeHtml(text || "unknown") + '</span></span>'
}

function sectionTitle(text) {
  return '<div class="rowMeta">' + escapeHtml(text) + '</div>'
}

function fieldInput(id, label, currentValue, placeholder, extraClass) {
  return '<label class="field ' + escapeAttr(extraClass || "") + '"><span class="fieldLabel">' + escapeHtml(label) + '</span><input id="' + escapeAttr(id) + '" value="' + escapeAttr(currentValue || "") + '" placeholder="' + escapeAttr(placeholder || "") + '"></label>'
}

function fieldNumber(id, label, currentValue, min, max, extraClass) {
  return '<label class="field ' + escapeAttr(extraClass || "") + '"><span class="fieldLabel">' + escapeHtml(label) + '</span><input id="' + escapeAttr(id) + '" type="number" min="' + escapeAttr(min) + '" max="' + escapeAttr(max) + '" step="any" value="' + escapeAttr(currentValue) + '"></label>'
}

function fieldSelect(id, label, currentValue, options, extraClass) {
  return '<label class="field ' + escapeAttr(extraClass || "") + '"><span class="fieldLabel">' + escapeHtml(label) + '</span><select id="' + escapeAttr(id) + '">' +
    options.map((option) => '<option value="' + escapeAttr(option[0]) + '" ' + (option[0] === currentValue ? "selected" : "") + '>' + escapeHtml(option[1]) + '</option>').join("") +
    '</select></label>'
}

function noticeLine(text) {
  return text ? '<div class="notice">' + escapeHtml(text) + '</div>' : ""
}

function emptyHtml(text) {
  return '<div class="empty">' + escapeHtml(text) + '</div>'
}

function value(id) {
  return byId(id)?.value?.trim?.() || ""
}

function numberValue(id, fallback) {
  const parsed = Number(value(id))
  return Number.isFinite(parsed) ? parsed : fallback
}

function checkedValue(id) {
  return Boolean(byId(id)?.checked)
}

function checked(value) {
  return value ? "checked" : ""
}

function icon(name) {
  return icons[name] || ""
}

function readableProfileShort(profile) {
  if (profile === "readOnly") return "Read"
  if (profile === "trustedWorkspace") return "Trusted"
  if (profile === "fullAccess") return "Full"
  return "Ask"
}

function completionSummary(completion) {
  if (!completion?.enabled) return "Disabled"
  return (completion.profile || "generic-chat") + " - " + (completion.model || "inherits chat model")
}

function contextIcon(item) {
  if (item.kind === "diagnostics") return icon("diagnostics")
  if (item.kind === "git-diff") return icon("diff")
  if (item.kind === "selection") return icon("selection")
  return icon("file")
}

function contextSummaryLabel(item) {
  return item.label || item.path || item.kind || "context"
}

function contextSummaryTitle(item) {
  return [item.kind, item.path, item.skipped ? "skipped" : "active", item.reason].filter(Boolean).join(" - ")
}

function contextStatusTitle() {
  const items = state.contextSummary || []
  if (!items.length) return "No context summary captured yet."
  return items.map(contextSummaryTitle).join("\\n")
}

function graphDetail(graph) {
  if (!graph) return "CodeGraph provider unavailable"
  return [graph.detail || graph.state, graph.indexedFiles ? formatNumber(graph.indexedFiles) + " files" : "", graph.indexedFunctions ? formatNumber(graph.indexedFunctions) + " functions" : "", graph.queue?.activeJobKind ? "active: " + graph.queue.activeJobKind : ""].filter(Boolean).join(" - ")
}

function ragDetail(rag) {
  if (!rag) return "RAG unavailable"
  return [readableRagAvailability(rag), rag.embeddingProvider || "", rag.chunks ? formatNumber(rag.embeddedChunks || 0) + "/" + formatNumber(rag.chunks) + " chunks" : "", rag.workerStatus ? "workers " + rag.workerStatus.activeWorkers + "/" + rag.workerStatus.maxWorkers : "", rag.fallbackReason || ""].filter(Boolean).join(" - ")
}

function readableRagAvailability(rag) {
  if (!rag) return "off"
  return rag.availability || (rag.enabled ? "checking" : "off")
}

function graphStateColor(stateValue) {
  if (stateValue === "ready") return "var(--cm-ready)"
  if (stateValue === "error") return "var(--cm-danger)"
  return "var(--cm-accent)"
}

function ragStateColor(availability) {
  if (availability === "ready") return "var(--cm-ready)"
  if (availability === "unavailable") return "var(--cm-danger)"
  if (availability === "paused" || availability === "partial") return "var(--cm-warn)"
  return "var(--cm-accent)"
}

function graphStateClass(stateValue) {
  if (stateValue === "ready") return "ready"
  if (stateValue === "error") return "danger"
  return "warn"
}

function ragStateClass(availability) {
  if (availability === "ready") return "ready"
  if (availability === "unavailable") return "danger"
  return "warn"
}

function clampProgress(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return 0
  return Math.max(0, Math.min(100, Math.round(number)))
}

function formatNumber(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return "0"
  if (number >= 1000000) return (number / 1000000).toFixed(1) + "M"
  if (number >= 1000) return (number / 1000).toFixed(1) + "k"
  return String(number)
}

function formatTime(value) {
  const date = new Date(value || Date.now())
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]))
}

function escapeAttr(value) {
  return escapeHtml(value)
}
`
}
