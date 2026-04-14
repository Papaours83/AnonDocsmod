@echo off
REM Usage: anonymize.bat "C:\chemin\vers\document.docx"
setlocal
if "%~1"=="" (
  echo Usage: %~nx0 ^<fichier.docx^|.pdf^|.txt^>
  exit /b 1
)

set "SRC=%~1"
set "DIR=%~dp1"
set "NAME=%~n1"
set "EXT=%~x1"

set "MIME=application/octet-stream"
if /i "%EXT%"==".docx" set "MIME=application/vnd.openxmlformats-officedocument.wordprocessingml.document"
if /i "%EXT%"==".pdf"  set "MIME=application/pdf"
if /i "%EXT%"==".txt"  set "MIME=text/plain"

set "OUT=%DIR%%NAME%-anonymized.zip"

curl -sS -X POST http://localhost:3000/api/document ^
  -F "file=@%SRC%;type=%MIME%" ^
  -o "%OUT%"

if errorlevel 1 (
  echo Echec de la requete.
  exit /b 1
)

powershell -NoProfile -Command "Expand-Archive -LiteralPath '%OUT%' -DestinationPath '%DIR%' -Force"
if errorlevel 1 (
  echo Echec de l'extraction.
  exit /b 1
)

del "%OUT%"
echo Fichiers deposes dans: %DIR%
endlocal
