# Rebuilds KobraMorda.exe from Launcher.cs and drops it in the project root.
# Uses the C# compiler that ships with every Windows install (.NET Framework
# reference assemblies) - no SDK/download needed.
$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { $csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe" }
if (-not (Test-Path $csc)) {
    Write-Error "csc.exe not found - this needs .NET Framework 4.x, which ships with Windows by default."
    exit 1
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$out = Join-Path $here "KobraMorda.exe"
& $csc /nologo /target:winexe /platform:x64 /out:$out (Join-Path $here "Launcher.cs")
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Copy-Item $out (Join-Path $here "..\KobraMorda.exe") -Force
Write-Host "Built $out and copied to project root."
