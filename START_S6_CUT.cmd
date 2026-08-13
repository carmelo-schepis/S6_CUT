@echo off
setlocal
cd /d "%~dp0"
where docker >nul 2>nul
if errorlevel 1 (
  echo Docker is required. Install Docker Desktop or run the documented local development setup.
  pause
  exit /b 1
)
docker compose up -d --build
if errorlevel 1 (
  echo S6_cut did not start. Run: docker compose logs
  pause
  exit /b 1
)
echo S6_cut is starting at http://localhost:8080
start "" "http://localhost:8080"
