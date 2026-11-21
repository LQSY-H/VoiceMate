#requires -Version 5.1
<#
.SYNOPSIS
  下载 VoiceMate 需要的程序（Breeze-TTS-2.cpp）和模型（GGUF）。

.DESCRIPTION
  只做三件事：
    1. 检查 Python / 目录
    2. 从上游 GitHub Releases 取 Windows x64 Vulkan 包，把 exe/dll 放进 app\bin
    3. 从 Hugging Face（或镜像）下载 GGUF 到 app\models

.PARAMETER SkipBin
  跳过程序下载。

.PARAMETER SkipModel
  跳过模型下载。

.PARAMETER Mirror
  模型走 hf-mirror.com（国内网络）。

.PARAMETER Check
  只检查网络和文件状态，不下载。

.PARAMETER ModelVariant
  q8_0（默认，3.32 GB）/ q6_k / q4_k / f16 等。

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
  powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Mirror
  powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1 -Check
#>
param(
    [switch]$SkipBin,
    [switch]$SkipModel,
    [switch]$Mirror,
    [switch]$Check,
    [string]$ModelVariant = "q8_0"
)

$ErrorActionPreference = "Stop"
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch { }

$Root = Split-Path -Parent $PSScriptRoot
$App = Join-Path $Root "app"
$Bin = Join-Path $App "bin"
$Models = Join-Path $App "models"

$ReleaseRepo = "HoppouAI/Breeze-TTS-2.cpp"
$FallbackRelease = "v0.1.7"
$FallbackAsset = "breeze-tts-2-v0.1.7-windows-x64-vulkan.zip"

function Write-Step($msg) { Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg) { Write-Host "    [OK] $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    [!] $msg" -ForegroundColor Yellow }

function Test-Command($name) {
    return [bool](Get-Command $name -ErrorAction SilentlyContinue)
}

function Get-Curl {
    if (Test-Command "curl.exe") { return "curl.exe" }
    return $null
}

function Invoke-Download($url, $dest) {
    $curl = Get-Curl
    if ($curl) {
        # curl 的进度条走 stderr，$ErrorActionPreference=Stop 时会把它当成错误，这里临时放宽
        $prev = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        & $curl -L -C - --retry 3 --retry-delay 3 -o $dest $url
        $code = $LASTEXITCODE
        $ErrorActionPreference = $prev
        if ($code -ne 0) { throw "下载失败（curl exit $code）：$url" }
    } else {
        Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
    }
}

function Get-RemoteSize($url) {
    # GitHub 的 HEAD 用 Invoke-WebRequest 最稳；镜像站可能 308，失败就返回 0
    try {
        $r = Invoke-WebRequest -Uri $url -Method Head -UseBasicParsing -MaximumRedirection 5 -TimeoutSec 25
        $len = [int64]$r.Headers["Content-Length"]
        if ($len -gt 0) { return $len }
    } catch { }
    try {
        $head = (& curl.exe -sIL --max-time 25 $url) | Out-String
        $ms = [regex]::Matches($head, "(?im)^content-length:\s*(\d+)")
        if ($ms.Count -gt 0) { return [int64]$ms[$ms.Count - 1].Groups[1].Value }
    } catch { }
    return 0
}

function Test-FastUrl($url) {
    # 只取 1 KB，确认这个源在当前网络下能连上
    try {
        & curl.exe -sL --max-time 20 -r 0-1023 -o NUL $url 2>$null
        return ($LASTEXITCODE -eq 0)
    } catch { return $false }
}

Write-Host "VoiceMate setup" -ForegroundColor White
Write-Host "  仓库目录：$Root"
Write-Host "  Check=$Check  SkipBin=$SkipBin  SkipModel=$SkipModel  Mirror=$Mirror  Model=$ModelVariant"

# ---------------------------------------------------------------- 0. 环境
Write-Step "检查环境"
$py = Get-Command python -ErrorAction SilentlyContinue
if ($py) { Write-Ok "python: $($py.Source)" } else { Write-Warn "没找到 python，运行前请装 Python 3.9+（或用发布包里的 runtime\python.exe）" }
if (-not (Test-Path $App)) { throw "找不到 $App，请在仓库根目录运行本脚本" }
New-Item -ItemType Directory -Force -Path $Bin, $Models | Out-Null
$vulkan = (Get-CimInstance Win32_VideoController -ErrorAction SilentlyContinue | Where-Object { $_.Name } | Select-Object -First 1).Name
if ($vulkan) { Write-Ok "显卡：$vulkan" }

# ---------------------------------------------------------------- 1. 程序
$binExe = Join-Path $Bin "breeze-server.exe"
if ($SkipBin) {
    Write-Step "跳过程序下载"
} elseif (Test-Path $binExe) {
    Write-Step "程序已存在，跳过"
    Write-Ok $binExe
} else {
    Write-Step "准备下载 Breeze-TTS-2.cpp 程序"
    $assetUrl = $null
    try {
        $rel = Invoke-RestMethod -Uri "https://api.github.com/repos/$ReleaseRepo/releases/latest" `
            -Headers @{ "User-Agent" = "VoiceMate-setup" } -TimeoutSec 20
        $asset = $rel.assets | Where-Object { $_.name -like "*windows*x64*vulkan*.zip" } | Select-Object -First 1
        if ($asset) {
            $assetUrl = $asset.browser_download_url
            Write-Ok "最新版本 $($rel.tag_name)：$($asset.name)（$([math]::Round($asset.size/1MB,1)) MB）"
        }
    } catch {
        Write-Warn "查 GitHub API 失败，改用固定版本 $FallbackRelease"
    }
    if (-not $assetUrl) {
        $assetUrl = "https://github.com/$ReleaseRepo/releases/download/$FallbackRelease/$FallbackAsset"
        $assetName = $FallbackAsset
    } else {
        $assetName = Split-Path -Leaf $assetUrl
    }

    if ($Check) {
        $size = Get-RemoteSize $assetUrl
        Write-Ok "将下载：$assetUrl（$(if($size){[math]::Round($size/1MB,1)}else{'大小未知'}) MB）"
    } else {
        $zip = Join-Path $env:TEMP $assetName
        Write-Host "    下载到 $zip"
        Invoke-Download $assetUrl $zip
        $tmp = Join-Path $env:TEMP ("vm_bin_" + [guid]::NewGuid().ToString("N").Substring(0, 8))
        Expand-Archive -Path $zip -DestinationPath $tmp -Force
        $found = Get-ChildItem -Path $tmp -Recurse -Filter "breeze-server.exe" | Select-Object -First 1
        if (-not $found) { throw "压缩包里没找到 breeze-server.exe" }
        $srcDir = $found.Directory.FullName
        Get-ChildItem -Path $srcDir -File | Where-Object { $_.Extension -in @(".exe", ".dll") } |
            Copy-Item -Destination $Bin -Force
        Write-Ok ("已放入 app\bin： " + ((Get-ChildItem $Bin -File | Select-Object -ExpandProperty Name) -join ", "))
        Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item $zip -Force -ErrorAction SilentlyContinue
    }
}

# ---------------------------------------------------------------- 2. 模型
$modelName = "breeze-tts-2-$ModelVariant.gguf"
$modelPath = Join-Path $Models $modelName
$hosts = if ($Mirror) { @("hf-mirror.com", "huggingface.co") } else { @("huggingface.co", "hf-mirror.com") }
$modelUrl = $null
foreach ($h in $hosts) {
    $u = "https://$h/HoppouAI/Breeze-TTS-2.cpp/resolve/main/$modelName"
    if (Test-FastUrl $u) { $modelUrl = $u; Write-Ok "模型源：$h"; break }
    Write-Warn "$h 连不上，换下一个源"
}
if (-not $modelUrl) {
    $modelUrl = "https://$($hosts[0])/HoppouAI/Breeze-TTS-2.cpp/resolve/main/$modelName"
    Write-Warn "两个源都没探测通，仍然尝试 $($hosts[0])"
}

if ($SkipModel) {
    Write-Step "跳过模型下载"
} elseif (Test-Path $modelPath) {
    $mb = [math]::Round((Get-Item $modelPath).Length / 1MB, 0)
    Write-Step "模型已存在：$modelName（$mb MB）"
    Write-Ok $modelPath
} else {
    Write-Step "准备下载模型 $modelName"
    if ($Check) {
        $size = Get-RemoteSize $modelUrl
        if (-not $size) {
            $known = @{ "q8_0" = 3.32; "q6_k" = 2.86; "q4_k" = 2.36; "f16" = 5.85 }
            if ($known.ContainsKey($ModelVariant)) { $size = [int64]($known[$ModelVariant] * 1GB) }
        }
        Write-Ok "将下载：$modelUrl（$(if($size){[math]::Round($size/1GB,2)}else{'大小未知'}) GB）"
    } else {
        Write-Warn "文件约 3.3 GB，支持断点续传；中断了重新跑一遍就会接着下"
        Invoke-Download $modelUrl $modelPath
        $gb = [math]::Round((Get-Item $modelPath).Length / 1GB, 2)
        Write-Ok "已下载 $modelName（$gb GB）"
    }
}

if ($ModelVariant -ne "q8_0") {
    Write-Warn "注意：server.py 里写死的是 breeze-tts-2-q8_0.gguf。换型号后请改 app\server.py 的 MODEL 常量，或把文件改名。"
}

# ---------------------------------------------------------------- 3. 结果
Write-Step "完成情况"
$ok = $true
if (-not (Test-Path (Join-Path $Bin "breeze-server.exe"))) { Write-Warn "缺少 app\bin\breeze-server.exe"; $ok = $false } else { Write-Ok "app\bin\breeze-server.exe" }
if (-not (Test-Path (Join-Path $Models "breeze-tts-2-q8_0.gguf"))) { Write-Warn "缺少 app\models\breeze-tts-2-q8_0.gguf"; $ok = $false } else { Write-Ok "app\models\breeze-tts-2-q8_0.gguf" }

if ($ok -and -not $Check) {
    Write-Host "`n可以启动了：双击 启动.bat，或运行 python app\server.py" -ForegroundColor Green
} elseif ($Check) {
    Write-Host "`n检查完成（没有下载任何东西）" -ForegroundColor Green
} else {
    Write-Host "`n还差文件，处理完再跑一次本脚本" -ForegroundColor Yellow
}
