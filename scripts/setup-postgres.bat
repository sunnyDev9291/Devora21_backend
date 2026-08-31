@echo off
set PGROOT=C:\pgsql
set PGDATA=C:\pgsql\data
set PATH=%PGROOT%\bin;%PATH%

if not exist "%PGROOT%\bin\pg_ctl.exe" (
  echo PostgreSQL binaries not found at %PGROOT%
  exit /b 1
)

if not exist "%PGDATA%" (
  echo Initializing PostgreSQL data directory...
  "%PGROOT%\bin\initdb.exe" -D "%PGDATA%" -U postgres -A trust -E UTF8
)

echo Starting PostgreSQL...
"%PGROOT%\bin\pg_ctl.exe" -D "%PGDATA%" -l "%PGROOT%\log.txt" start

timeout /t 3 /nobreak >nul

echo Creating devora21 role and database...
"%PGROOT%\bin\psql.exe" -U postgres -c "DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'devora21') THEN CREATE ROLE devora21 WITH LOGIN PASSWORD 'devora21'; END IF; END $$;"
"%PGROOT%\bin\psql.exe" -U postgres -c "SELECT 1 FROM pg_database WHERE datname = 'devora21'" | findstr /C:"1" >nul || "%PGROOT%\bin\createdb.exe" -U postgres -O devora21 devora21
"%PGROOT%\bin\psql.exe" -U postgres -c "GRANT ALL PRIVILEGES ON DATABASE devora21 TO devora21;"

echo PostgreSQL ready.
