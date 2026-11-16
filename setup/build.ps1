# Builds setup\out\ReChestSetup.exe: the app published self-contained (no .NET install needed), zipped and appended
# to the installer exe as [zip][zip length: 8 bytes][magic "RCPAYLD1"]. Version comes from ChestCounter.csproj.
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
$ver = (([xml](Get-Content "$root\ChestCounter.csproj")).Project.PropertyGroup | Where-Object Version | Select-Object -First 1).Version
$out = Join-Path $PSScriptRoot 'out'
if (Test-Path $out) { Remove-Item $out -Recurse -Force }

dotnet publish "$root\ChestCounter.csproj" -c Release -r win-x64 --self-contained true -o "$out\app" -p:DebugType=none -p:GenerateDocumentationFile=false
if ($LASTEXITCODE) { throw 'publish failed' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
[IO.Compression.ZipFile]::CreateFromDirectory("$out\app", "$out\payload.zip", [IO.Compression.CompressionLevel]::Optimal, $false)

dotnet build "$PSScriptRoot\ReChestSetup.csproj" -c Release "-p:Version=$ver" -o "$out\stub"
if ($LASTEXITCODE) { throw 'setup build failed' }

$exe = "$out\ReChestSetup.exe"
$dst = [IO.File]::Create($exe)
try {
  foreach ($f in "$out\stub\ReChestSetup.exe", "$out\payload.zip") { $src = [IO.File]::OpenRead($f); $src.CopyTo($dst); $src.Dispose() }
  $len = [BitConverter]::GetBytes([long](Get-Item "$out\payload.zip").Length)
  $dst.Write($len, 0, 8)
  $magic = [Text.Encoding]::ASCII.GetBytes('RCPAYLD1')
  $dst.Write($magic, 0, 8)
} finally { $dst.Dispose() }
"ReChestSetup.exe $ver : {0:N1} MB" -f ((Get-Item $exe).Length / 1MB)
