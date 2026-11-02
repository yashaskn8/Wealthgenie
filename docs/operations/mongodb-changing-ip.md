# MongoDB connections when a developer IP changes

## Choose the right architecture

WealthGenie's **existing** `docker-compose.yml` starts an isolated local MongoDB
7 replica set and keeps the MongoDB host port bound to `127.0.0.1`.
For local work with **disposable development data**, prefer that setup instead
of connecting every laptop directly to a production Atlas cluster:

```powershell
docker compose up -d --build
docker compose ps
```

The backend, worker, and ML service inside this Compose stack use
`mongodb://mongodb:27017/wealthgenie?replicaSet=rs0`. That hostname resolves
inside Docker; it is **not** your Wi-Fi, mobile-data or public IP.

**Do not switch an existing account database or copy production credentials into
a demo configuration.** Persistent login records belong to the original
database. The backend pins `MONGODB_EXPECTED_DATABASE` and should fail closed
if connected to the wrong database. For local Windows demonstration with
synthetic data, `scripts/start_local_demo.ps1 -UseDurableMongoStorage` uses a
different isolated demo DB; it is not an Atlas account migration.

## Temporary IP access for a developer using Atlas

If you **need** direct Atlas access from your laptop and its public IP rotates:

1. Install MongoDB Atlas CLI and authenticate in your own terminal with
   `atlas auth login`. Use an authorized project account with IP access-list
   management permission. Do not paste credentials into chat, scripts, or Git.
2. In Atlas, locate the relevant **project ID**, not the cluster password.
3. From this repository root, first inspect the dry run:

```powershell
.\scripts\allow_atlas_current_ip.ps1 -ProjectId "<your-24-character-project-id>"
```

4. If the project and UTC expiry are correct, explicitly approve the change:

```powershell
.\scripts\allow_atlas_current_ip.ps1 -ProjectId "<your-24-character-project-id>" -Hours 8 -Apply
```

The helper invokes `atlas accessLists create --currentIp` with `--deleteAfter`.
It creates only a *temporary single-address* entry, does not grant
`0.0.0.0/0`, and never runs automatically at backend startup. You may need
to repeat it on a new network, or sign in again if the CLI session expires.
Atlas may reject duplicate entries, insufficient permissions or project network
policies. **Review and remove obsolete manually added entries**; the helper
does not delete unrelated access-list records or broaden access on failure.

A different command, `atlas organizations apiKeys accessLists`, controls
access to the **Atlas administration API key**, not access from your backend
to the database. Do not confuse these two network rules.

## Permanent production solution

Avoid treating a developer laptop as an application server. Deploy your backend,
worker and ML service in a controlled network with **fixed egress public IP**,
allowlist that narrow IP in Atlas, and keep the database connection string only
in server-side secrets. For eligible dedicated Atlas tiers, prefer **private
endpoints** or VPC/VNet peering to avoid public access paths altogether.
Use normal TLS authentication and a least-privileged database user. Keep
`MONGODB_EXPECTED_DATABASE` pinned and retain transaction-capable replica sets.

Do not add `0.0.0.0/0` (allow from anywhere) to stop a changing IP problem.
Do not implement an always-on job that changes production allowlists whenever
a home IP changes, and never commit Atlas CLI tokens or MongoDB passwords.

## Diagnose correctly

- `serverSelectionTimeoutMS`, DNS errors or a timeout: check outbound network,
  DNS, Atlas project access list, cluster availability and firewalls.
- Authentication error: check username, password encoding and database-user
  roles separately from the IP access list.
- `MONGODB_DATABASE_IDENTITY_MISMATCH`: stop and check the intended database.
  Do **not** erase or recreate the account database to bypass this check.
- `MONGODB_TRANSACTIONS_REQUIRED`: check the replica set before attempting
  saved cases or financial transactions.

Official references:
- https://www.mongodb.com/docs/atlas/security/ip-access-list/
- https://www.mongodb.com/docs/atlas/architecture/current/network-security/
- https://www.mongodb.com/docs/atlas/cli/current/command/atlas-accesslists-create/
