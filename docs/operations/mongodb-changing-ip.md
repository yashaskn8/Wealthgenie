# MongoDB Atlas access when a Windows developer IP changes

This workflow uses the existing Atlas database. It never copies accounts,
changes a database, or edits the Atlas access list during application startup.
Changing Wi-Fi or a VPN can still change a laptop's Atlas egress IP; a temporary
access entry must then be approved for the new IP. A fixed server egress or
private endpoint is the separate production solution.

## Configure the existing database once

Set `MONGODB_URI` in `server/.env` to the **existing** Atlas connection string
and `MONGODB_EXPECTED_DATABASE` to the database holding the existing accounts.
Do not paste either value into terminal logs, Git, or a browser URL. The server
currently gives these two values in `server/.env` precedence over inherited
Windows variables during development; a shell-only override will not change
the effective target. The backend refuses a mismatched database and requires
a transaction-capable replica set. The ML service also checks its optional
`MONGODB_EXPECTED_DATABASE` pin when set.

If `server/.env` points to loopback, Atlas access cannot be established until
the operator selects the existing Atlas URI and matching database pin. No
configuration secret is changed by these scripts.

## Read-only preflight and startup (Windows PowerShell 5.1)

From the repository root:

```powershell
powershell.exe -NoProfile -File .\scripts\check_atlas_connection.ps1
# Add -ProjectId <24-character Atlas project ID> for an optional access-list check.
powershell.exe -NoProfile -File .\scripts\start_backend_atlas.ps1 -ProjectId <project-id>
```

The preflight uses the backend's effective configuration and performs only
MongoDB connection, replica-set identity, and ping checks. It reports DNS,
authentication, TLS, server selection, database identity, and transaction
failures with safe codes. Each diagnostic process has a 15-second deadline;
`MONGODB_PREFLIGHT_TIMEOUT` means the read-only check stalled and does not
identify the Atlas IP list as the cause. A timeout alone **cannot prove** an
Atlas IP block.
With an authenticated Atlas CLI and `-ProjectId`, it compares the observed
public IPv4 with active Atlas access entries; VPN or split routing can make
that comparison indicative rather than conclusive. Neither preflight nor
backend startup modifies Atlas networking.

If the preflight succeeds, `start_backend_atlas.ps1` starts the backend in the
foreground. Start the frontend in another PowerShell window:

```powershell
npm run dev --prefix reactapp -- --host 127.0.0.1
```

The optional Python service must use the same existing Atlas URI and expected
database pin when its MongoDB state backend is enabled. Its normal command is:

```powershell
Set-Location ml-service
python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

## Temporary developer access, only when explicitly approved

The helper defaults to a dry run and creates **only** a temporary IPv4 `/32`
entry when both approval switches are supplied:

```powershell
powershell.exe -NoProfile -File .\scripts\allow_atlas_current_ip.ps1 -ProjectId <project-id>
powershell.exe -NoProfile -File .\scripts\allow_atlas_current_ip.ps1 -ProjectId <project-id> -Hours 8 -Apply -ConfirmDevelopmentProject
powershell.exe -NoProfile -File .\scripts\check_atlas_connection.ps1 -ProjectId <project-id>
```

The write operation requires an already authenticated Atlas CLI with project
network-access permission. Database usernames and passwords **cannot** grant
Atlas administration rights. If the CLI is unavailable, review the current
IPv4 and add a temporary `/32` entry in the Atlas UI instead. The helper
detects an existing active entry, does not widen or remove entries, and
verifies that an expiring exact `/32` exists after creation. It does not run
automatically on Wi-Fi change or service restart. If the public IP changes
during the request, repeat the read-only preflight before connecting.

Never use `0.0.0.0/0`. Never disable TLS or database authentication to work
around an IP or certificate failure.

## Production network boundary

If a production deployment uses Atlas, the backend, worker, and ML service
should share a controlled network with a fixed outbound IP allowlisted in
Atlas, or use an Atlas private endpoint where supported. The current
`deploy/production` overlay selects DocumentDB, so it is not evidence of a
working production Atlas network. Store the selected database URI in the
existing secret store, pin the database name, and verify TLS, replica-set
transactions, and readiness from
the deployed network. The laptop's public IP must not be the production
application egress identity. No paid network resource or live Atlas rule is
created by this repository change; production connectivity requires a
deployment-specific network review and a live verification.

Official references: [Atlas IP access lists](https://www.mongodb.com/docs/atlas/security/ip-access-list/),
[Atlas CLI temporary access](https://www.mongodb.com/docs/atlas/cli/current/command/atlas-accesslists-create/).
