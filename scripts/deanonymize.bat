@echo off
REM Usage: deanonymize.bat "C:\chemin\anonymized.docx" "C:\chemin\pii.txt"
setlocal
if "%~2"=="" (
  echo Usage: %~nx0 ^<document_anonymise.docx^|.txt^> ^<pii_report.txt^>
  exit /b 1
)

set "DOC=%~1"
set "PII=%~2"
set "DIR=%~dp1"
set "NAME=%~n1"
set "EXT=%~x1"

set "MIME=application/octet-stream"
if /i "%EXT%"==".docx" set "MIME=application/vnd.openxmlformats-officedocument.wordprocessingml.document"
if /i "%EXT%"==".txt"  set "MIME=text/plain"

set "OUT=%DIR%%NAME%-deanonymized%EXT%"

curl -sS -X POST http://localhost:3000/api/document/deanonymize ^
  -F "file=@%DOC%;type=%MIME%" ^
  -F "piiReport=@%PII%;type=text/plain" ^
  -o "%OUT%"

if errorlevel 1 (
  echo Echec de la requete.
  exit /b 1
)

echo Sortie: %OUT%
endlocal
