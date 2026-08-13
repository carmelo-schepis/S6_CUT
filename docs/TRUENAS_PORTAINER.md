# TrueNAS SCALE and Portainer deployment

S6_cut uses the same `compose.yaml` on ordinary Docker hosts, in a Portainer Stack, and in a TrueNAS SCALE Custom App. There is no appliance-specific fork.

## Dataset layout

Create two datasets so application source and persistent media/state have separate lifecycles:

```text
/mnt/tank/apps/s6-cut/source
/mnt/tank/apps/s6-cut/data
```

Copy or clone this repository into `source`. Give the container UID/GID `10001:10001` read/write access to `data`. Set:

```dotenv
S6_DATA_PATH=/mnt/tank/apps/s6-cut/data
S6_PORT=8080
S6_JOB_WORKERS=1
S6_WHISPER_MODEL=small
```

Start with one worker. Transcription and H.264 composition consume substantial CPU, RAM, and I/O. No GPU is required.

## TrueNAS SCALE Custom App

1. Choose the Apps pool and create the source/data datasets above.
2. Put the repository and `.env` in the source dataset.
3. In Apps, choose **Discover Apps → Custom App → Install via YAML** (wording varies by SCALE release).
4. Use Compose YAML with an `include` pointing at the repository `compose.yaml`, or paste the resolved Compose definition.
5. Confirm only the `web` service maps `${S6_PORT}:8080`; the engine has no host port.
6. Confirm the absolute data dataset maps to `/app/data`.
7. Install, wait through the two-minute model/runtime health start period, and open the web portal.
8. Create a small permitted test project before importing large media.

TrueNAS Custom App UI fields and YAML support can change by release. `docker compose config` in the source dataset is the authoritative validation of this repository's Compose model.

## Portainer Stack

1. Create a Stack from the repository or upload `compose.yaml`.
2. Add the variables from `.env.example`; use an absolute `S6_DATA_PATH` on the Docker host.
3. Deploy the Stack and wait for both health checks.
4. Open `http://host:S6_PORT` only from a trusted LAN/VPN.

## Update

1. Snapshot/backup the data dataset.
2. Pull or replace only the source repository.
3. Run `docker compose build --pull` followed by `docker compose up -d`.
4. Confirm `/api/health`, existing projects, Library assets, and one completed clip.
5. Keep the previous image/source revision until the smoke check passes.

## Backup and restore

For the cleanest portable backup, stop the Stack, snapshot/copy the complete data dataset, then restart. The database uses WAL, so a live filesystem snapshot must be crash-consistent and include `s6-cut.sqlite3`, `-wal`, and `-shm` together.

Restore the entire dataset—including `secrets/`—to the configured path, restore owner/permissions, and redeploy. Never cherry-pick only output files while expecting job/profile records to remain consistent.

## Uninstall

- Keep data: remove the Custom App/Stack and images; retain the data dataset.
- Remove everything: remove the App/Stack first, verify the exact data dataset path, snapshot it if recovery may be needed, then remove that dataset explicitly.

Compose does not define a deletable named data volume. Removing the Stack does not remove the host dataset.

## Remote access

The application has no built-in multi-user authentication. Do not forward `S6_PORT` directly from the public internet. Use a VPN or authenticated HTTPS reverse proxy, restrict the portal to intended users, and preserve the same-origin `/api` route.
