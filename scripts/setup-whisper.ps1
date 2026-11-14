# Downloads whisper.cpp (CUDA build, Windows x64) and the large-v3-turbo q5_0 model.
# Model is ~570 MB, fits comfortably in 6 GB VRAM.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$bin = Join-Path $root 'bin\whisper'
$models = Join-Path $root 'models'
New-Item -ItemType Directory -Force $bin, $models | Out-Null

Write-Host 'Finding latest whisper.cpp CUDA release...'
# Tagged releases (v1.x) often have no binaries; the bNNNN releases do. Take the newest release
# that has a CUDA 12.4 x64 build (works on RTX 30/40-series). Naming varies between releases.
$releases = Invoke-RestMethod 'https://api.github.com/repos/ggml-org/whisper.cpp/releases?per_page=30' -Headers @{ 'User-Agent' = 'whisper-drop' }
$asset = $null
foreach ($rel in $releases) {
  $asset = $rel.assets | Where-Object { $_.name -match '(cublas|cuda)-12\.4\.0.*x64\.zip$' -and $_.name -notmatch 'arm64' } | Select-Object -First 1
  if ($asset) { Write-Host "Using release $($rel.tag_name)"; break }
}
if (-not $asset) { throw 'No CUDA 12.4 x64 build found in the last 30 releases. Download one manually into bin\whisper.' }
Write-Host "Downloading $($asset.name) ($([math]::Round($asset.size/1MB)) MB)"
$zip = Join-Path $env:TEMP $asset.name
Invoke-WebRequest $asset.browser_download_url -OutFile $zip
$tmp = Join-Path $env:TEMP 'whisper-cpp-extract'
Remove-Item $tmp -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive $zip $tmp -Force
$exe = Get-ChildItem $tmp -Recurse -Filter 'whisper-server.exe' | Select-Object -First 1
if (-not $exe) { throw 'whisper-server.exe not in archive' }
Copy-Item (Join-Path $exe.DirectoryName '*') $bin -Recurse -Force
Remove-Item $zip, $tmp -Recurse -Force

$model = Join-Path $models 'ggml-large-v3-turbo-q5_0.bin'
if (-not (Test-Path $model)) {
  Write-Host 'Downloading model...'
  Invoke-WebRequest 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin' -OutFile $model
}
Write-Host 'Done.'
