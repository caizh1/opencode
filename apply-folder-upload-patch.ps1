# opencode 文件夹上传增强功能 - 补丁应用脚本
# 使用方法: 下载新的 opencode 版本解压后，在此脚本所在目录运行:
#   powershell -File apply-folder-upload-patch.ps1 <新版本解压目录>
#
# 例如: powershell -File apply-folder-upload-patch.ps1 D:\opencode-1.16.0
#
# 重要: 重新编译二进制时，务必设置 $env:OPENCODE_CHANNEL="latest"
# 否则数据库文件路径会变成 opencode-dev.db 而非 opencode.db，导致历史记录丢失!

param(
  [Parameter(Mandatory=$true)]
  [string]$TargetDir
)

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path

# ============================================================
# 要复制的修改文件列表
# ============================================================
$files = @(
  # --- 后端: 新增 POST /file/write API 端点 ---
  @{Source = "packages/opencode/src/server/routes/instance/httpapi/groups/file.ts"; RelPath = "packages/opencode/src/server/routes/instance/httpapi/groups/file.ts"}
  @{Source = "packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts"; RelPath = "packages/opencode/src/server/routes/instance/httpapi/handlers/file.ts"}

  # --- SDK: file.write() 方法及类型 ---
  @{Source = "packages/sdk/js/src/v2/gen/types.gen.ts"; RelPath = "packages/sdk/js/src/v2/gen/types.gen.ts"}
  @{Source = "packages/sdk/js/src/v2/gen/sdk.gen.ts"; RelPath = "packages/sdk/js/src/v2/gen/sdk.gen.ts"}

  # --- 前端: 文件夹上传对话框 ---
  @{Source = "packages/app/src/utils/folder-traversal.ts"; RelPath = "packages/app/src/utils/folder-traversal.ts"}
  @{Source = "packages/app/src/components/dialog-upload-folder.tsx"; RelPath = "packages/app/src/components/dialog-upload-folder.tsx"}
  @{Source = "packages/app/src/pages/session/session-side-panel.tsx"; RelPath = "packages/app/src/pages/session/session-side-panel.tsx"}

  # --- 前端: 提示词输入框拖放上传（历史补丁） ---
  @{Source = "packages/app/src/components/prompt-input/attachments.ts"; RelPath = "packages/app/src/components/prompt-input/attachments.ts"}
  @{Source = "packages/app/src/components/prompt-input.tsx"; RelPath = "packages/app/src/components/prompt-input.tsx"}
  @{Source = "packages/app/src/components/prompt-input/drag-overlay.tsx"; RelPath = "packages/app/src/components/prompt-input/drag-overlay.tsx"}
)

# ============================================================
# i18n: 需要在 en.ts 中新增的 key（从当前版本读取并插入）
# ============================================================
$i18nNewKeys = @(
  "dialog.uploadFolder.title"
  "dialog.uploadFolder.dropHint"
  "dialog.uploadFolder.target.label"
  "dialog.uploadFolder.target.placeholder"
  "dialog.uploadFolder.action.upload"
  "dialog.uploadFolder.action.cancel"
  "dialog.uploadFolder.action.another"
  "dialog.uploadFolder.fileCount"
  "dialog.uploadFolder.moreFiles"
  "dialog.uploadFolder.empty"
  "dialog.uploadFolder.progress"
  "dialog.uploadFolder.success"
  "dialog.uploadFolder.partialError"
  "dialog.uploadFolder.allFailed"
  "session.files.uploadFolder"
  "prompt.action.attachFolder"
)

Write-Host "========================================" -ForegroundColor Green
Write-Host "  opencode 文件夹上传补丁" -ForegroundColor Green
Write-Host "  目标: $TargetDir" -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""

# ============================================================
# 步骤 1: 复制修改的文件
# ============================================================
Write-Host "[1/3] 复制修改的文件..." -ForegroundColor Yellow
foreach ($f in $files) {
  $src = Join-Path $ScriptDir $f.Source
  $dst = Join-Path $TargetDir $f.RelPath

  if (-not (Test-Path $src)) {
    Write-Host "  [跳过] 源文件不存在: $($f.Source)" -ForegroundColor DarkYellow
    continue
  }

  $dstDir = Split-Path -Parent $dst
  if (-not (Test-Path $dstDir)) { New-Item -ItemType Directory -Path $dstDir -Force | Out-Null }

  Copy-Item -LiteralPath $src -Destination $dst -Force
  Write-Host "  [复制] $($f.RelPath)" -ForegroundColor Green
}

# ============================================================
# 步骤 2: 更新 i18n - 从源 en.ts 提取新增 key 并写入目标
# ============================================================
Write-Host ""
Write-Host "[2/3] 更新 i18n..." -ForegroundColor Yellow

$srcEn = Join-Path $ScriptDir "packages/app/src/i18n/en.ts"
$dstEn = Join-Path $TargetDir "packages/app/src/i18n/en.ts"

if (Test-Path $srcEn) {
  $srcContent = Get-Content -LiteralPath $srcEn -Raw

  # 提取源文件中每个新 key 对应的整行
  $newLines = @()
  foreach ($key in $i18nNewKeys) {
    $escapedKey = [regex]::Escape($key)
    $match = [regex]::Match($srcContent, "`"$escapedKey`":\s*`".*?`"", [System.Text.RegularExpressions.RegexOptions]::Singleline)
    if ($match.Success) {
      $newLines += $match.Value
    }
  }

  if (Test-Path $dstEn) {
    $dstContent = Get-Content -LiteralPath $dstEn -Raw

    # 检查哪些 key 已存在
    $missing = @()
    foreach ($key in $i18nNewKeys) {
      $escapedKey = [regex]::Escape($key)
      if ($dstContent -notmatch "`"$escapedKey`"") {
        $missing += $key
      }
    }

    if ($missing.Count -gt 0) {
      # 在文件最后一个 } 之前插入
      $insertBlock = "`n" + ($newLines -join ",`n") + ",`n"
      $lastBracePos = $dstContent.LastIndexOf("}")
      if ($lastBracePos -gt 0) {
        $dstContent = $dstContent.Substring(0, $lastBracePos) + $insertBlock + $dstContent.Substring($lastBracePos)
        Set-Content -LiteralPath $dstEn -Value $dstContent -NoNewline
        Write-Host "  [i18n] en.ts 新增 $($missing.Count) 个 key" -ForegroundColor Green
        foreach ($k in $missing) {
          Write-Host "    + $k" -ForegroundColor Cyan
        }
      }
    } else {
      Write-Host "  [i18n] en.ts 所有 key 已存在，跳过" -ForegroundColor Gray
    }
  } else {
    # en.ts 不存在则直接复制
    Copy-Item -LiteralPath $srcEn -Destination $dstEn -Force
    Write-Host "  [i18n] en.ts 直接复制" -ForegroundColor Green
  }
} else {
  Write-Host "  [i18n] 源 en.ts 不存在，跳过" -ForegroundColor DarkYellow
}

# 其他 locale 文件：以 en.ts 为基准，缺失的 key 自动 fallback 到英文
Write-Host "  [i18n] 其他语言文件缺失的 key 会自动 fallback 到 en.ts" -ForegroundColor Gray

# ============================================================
# 步骤 3: 编译提醒
# ============================================================
Write-Host ""
Write-Host "[3/3] 补丁应用完成!" -ForegroundColor Green
Write-Host ""
Write-Host "下一步: 重新编译 Linux 二进制" -ForegroundColor Yellow
Write-Host "  1. cd packages\opencode" -ForegroundColor White
Write-Host '  2. $env:OPENCODE_CHANNEL="latest"' -ForegroundColor White
Write-Host "  3. bun run build --single  (当前平台) 或修改 script/build.ts 的 targets 编译 Linux" -ForegroundColor White
Write-Host ""
Write-Host "注意: 如果新版 opencode 中这些文件有较大改动，可能需要手动合并冲突。" -ForegroundColor Yellow
Write-Host "       建议用 git diff 对比修改前后的差异。" -ForegroundColor Yellow
