import { chipmateIcons } from "./chipmate-icons"
import { chipmateScript } from "./chipmate-script"
import { chipmateStyles } from "./chipmate-styles"
import { createNonce } from "./nonce"

export function createChipMateViewHtml(cspSource: string, nonce = createNonce()) {
  const iconsJson = JSON.stringify(chipmateIcons)
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ChipMate</title>
  <style>${chipmateStyles}</style>
</head>
<body>
  <div class="appShell">
    <section class="glassFrame" aria-label="ChipMate control surface">
      <header class="brandBar">
        <div class="brandMark" aria-hidden="true"><span class="brandMarkText">C</span></div>
        <div class="brandCopy">
          <div class="brandName">ChipMate</div>
          <button class="modelPill" id="modelPill" data-module="models" title="Open model settings">
            <span class="statusDot" id="modelStatusDot"></span>
            <span class="modelText" id="modelPillText">Model required</span>
            <span data-icon="more"></span>
          </button>
        </div>
        <div class="headerActions">
          <button class="iconButton" id="openDiagnostics" title="Open diagnostics logs" data-icon="diagnostics"></button>
          <button class="iconButton" id="openSettings" title="Open settings" data-icon="settings"></button>
        </div>
      </header>

      <nav class="moduleDock" aria-label="ChipMate modules">
        <button class="dockButton active" data-module="chat" title="Chat">
          <span class="dockIcon" data-icon="chat"></span>
          <span class="dockLabel">Chat</span>
        </button>
        <button class="dockButton" data-module="models" title="Models">
          <span class="dockIcon" data-icon="agent"></span>
          <span class="dockLabel">Model</span>
        </button>
        <button class="dockButton" data-module="knowledge" title="Knowledge">
          <span class="dockIcon" data-icon="database"></span>
          <span class="dockLabel">Know</span>
        </button>
        <button class="dockButton" data-module="skills" title="Skills">
          <span class="dockIcon" data-icon="beaker"></span>
          <span class="dockLabel">Skills</span>
        </button>
        <button class="dockButton" data-module="mcp" title="MCP">
          <span class="dockIcon" data-icon="references"></span>
          <span class="dockLabel">MCP</span>
        </button>
      </nav>

      <section class="statusStrip" id="statusStrip" aria-label="ChipMate status"></section>
    </section>

    <main class="mainSurface" id="mainSurface" aria-live="polite"></main>

    <footer class="composer" id="chatComposer" aria-label="ChipMate chat composer">
      <div class="contextChipList" id="mentionChips"></div>
      <div class="mentionBox" id="mentionBox"></div>
      <div class="composerInputRow">
        <textarea id="composerInput" placeholder="Ask anything..."></textarea>
        <button class="sendButton" id="sendButton" title="Send" data-icon="send"></button>
      </div>
      <div class="footerStatus">
        <span class="miniPill" id="onlineStatus"><span class="statusDot"></span><span>Online</span></span>
        <div class="composerActions">
          <button class="permissionChip" id="permissionShortcut" data-module="settings" title="Default permission profile">
            <span data-icon="shield"></span>
            <span id="permissionShortcutText">Ask</span>
          </button>
          <button class="iconButton" id="attachContext" title="Attach current file" data-icon="attach"></button>
          <button class="iconButton" id="clearContextButton" title="Clear context" data-icon="discard"></button>
        </div>
      </div>
    </footer>
  </div>
  <script nonce="${nonce}">${chipmateScript(iconsJson)}</script>
</body>
</html>`
}
