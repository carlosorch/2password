# Run only through Auth's private capture. Windows counterpart of keychain.jxa.js:
# the token is encrypted with DPAPI (CurrentUser scope) into a file under %LOCALAPPDATA%.
# The token crosses stdin and stdout only, never argv.
param([string]$Action, [string]$Service, [string]$Account)
$ErrorActionPreference = 'Stop'
if (-not $Service -or -not $Account -or @('get', 'exists', 'add', 'remove') -notcontains $Action) {
  throw 'Invalid credential operation'
}
Add-Type -AssemblyName System.Security
$dir = Join-Path $env:LOCALAPPDATA $Service
$file = Join-Path $dir ($Account + '.dpapi')
$entropy = [Text.Encoding]::UTF8.GetBytes($Service + '/' + $Account)
$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
switch ($Action) {
  'exists' { if (Test-Path -LiteralPath $file) { 'found' } else { 'missing' } }
  'remove' {
    if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Force }
    # Leave nothing behind: drop the service folder once it is empty.
    if ((Test-Path -LiteralPath $dir) -and -not (Get-ChildItem -LiteralPath $dir -Force)) { Remove-Item -LiteralPath $dir -Force }
    'removed'
  }
  'add' {
    if (Test-Path -LiteralPath $file) { throw 'Credential already exists' }
    $stdin = [Console]::OpenStandardInput()
    $buffer = New-Object IO.MemoryStream
    $stdin.CopyTo($buffer)
    $data = $buffer.ToArray()
    if ($data.Length -eq 0) { throw 'Empty credential input' }
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $protected = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope)
    [IO.File]::WriteAllBytes($file, $protected)
    'added'
  }
  'get' {
    $plain = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file), $entropy, $scope)
    $out = [Console]::OpenStandardOutput()
    $out.Write($plain, 0, $plain.Length)
    $out.Flush()
  }
}
