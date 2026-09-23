# Starts KobraMorda (hidden, no console) when you log in to Windows.
# Run again with -Remove to undo.
param([switch]$Remove)

$startup = [Environment]::GetFolderPath("Startup")
$link = Join-Path $startup "KobraMorda.lnk"

if ($Remove) {
    Remove-Item $link -ErrorAction SilentlyContinue
    Write-Host "Autostart removed"
    exit
}

$vbs = Join-Path $PSScriptRoot "KobraMorda-hidden.vbs"
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($link)
$shortcut.TargetPath = "wscript.exe"
$shortcut.Arguments = "`"$vbs`""
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.Save()
Write-Host "Autostart installed: $link"
