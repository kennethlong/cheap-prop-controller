$ErrorActionPreference = 'Stop'
$repoPath = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$artifactPath = Join-Path $repoPath 'artifacts\firmware-tests'
New-Item -ItemType Directory -Force -Path $artifactPath | Out-Null
$vswherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
if (!(Test-Path -LiteralPath $vswherePath)) { throw 'Install Visual Studio C++ Build Tools to run native firmware tests.' }
$vsPath = (& $vswherePath -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath | Select-Object -First 1)
if (!$vsPath) { throw 'Visual Studio C++ compiler was not found.' }
$setupPath = Join-Path $vsPath 'VC\Auxiliary\Build\vcvarsall.bat'
$batchPath = Join-Path $artifactPath 'run-tests.cmd'
$commands = @(
  '@echo off',
  ('call "{0}" x64 >nul' -f $setupPath),
  'if not "%errorlevel%"=="0" exit /b %errorlevel%',
  ('cl /nologo /EHsc /W4 /I "{0}\firmware\include" "{0}\tests\firmware\core_test.cpp" /Fe:"{1}\core_test.exe" /Fo:"{1}\core_test.obj"' -f $repoPath, $artifactPath),
  'if not "%errorlevel%"=="0" exit /b %errorlevel%',
  ('"{0}\core_test.exe" "{1}\tests\core\default-scene.bin"' -f $artifactPath, $repoPath),
  'if not "%errorlevel%"=="0" exit /b %errorlevel%',
  ('"{0}\core_test.exe" "{1}\tests\core\mega-audio-scene.bin"' -f $artifactPath, $repoPath),
  'if not "%errorlevel%"=="0" exit /b %errorlevel%',
  ('"{0}\core_test.exe" "{1}\tests\core\single-player-fade-scene.bin"' -f $artifactPath, $repoPath),
  'if not "%errorlevel%"=="0" exit /b %errorlevel%',
  ('"{0}\core_test.exe" "{1}\tests\core\ambient-mix-scene.bin"' -f $artifactPath, $repoPath),
  'if not "%errorlevel%"=="0" exit /b %errorlevel%',
  ('cl /nologo /EHsc /W4 /I "{0}\tests\firmware\fakes" /I "{0}\firmware\include" "{0}\tests\firmware\audio_test.cpp" /Fe:"{1}\audio_test.exe" /Fo:"{1}\audio_test.obj"' -f $repoPath, $artifactPath),
  'if not "%errorlevel%"=="0" exit /b %errorlevel%',
  ('"{0}\audio_test.exe"' -f $artifactPath),
  'if not "%errorlevel%"=="0" exit /b %errorlevel%',
  ('cl /nologo /EHsc /W4 /I "{0}\tests\firmware\fakes" /I "{0}\firmware\include" "{0}\tests\firmware\timer_uart_test.cpp" /Fe:"{1}\timer_uart_test.exe" /Fo:"{1}\timer_uart_test.obj"' -f $repoPath, $artifactPath),
  'if not "%errorlevel%"=="0" exit /b %errorlevel%',
  ('"{0}\timer_uart_test.exe"' -f $artifactPath),
  'exit /b %errorlevel%'
)
Set-Content -LiteralPath $batchPath -Value $commands -Encoding ASCII
& $env:COMSPEC /d /c $batchPath
exit $LASTEXITCODE
