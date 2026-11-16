# TrueNAS SCALE and Portainer deployment

S6_cut uses the same `compose.yaml` on ordinary Docker hosts, in a Portainer Stack, and in a TrueNAS SCALE Custom App. There is no appliance-specific fork.

## TrueNAS SCALE: scripted install (recommended)

Needs TrueNAS SCALE 24.10 or newer (Docker-based Apps; 25.04+ recommended) with a pool chosen under **Apps → Configuration**. In **System → Shell**, or over SSH:

```bash
curl -fsSL https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/main/install-truenas.sh | sudo bash
```

`install-truenas.sh` does the following:

1. Checks that it runs as root on TrueNAS SCALE. On other hosts it stops and points you to `install.sh`.
2. Finds the Apps pool (`midclt call docker.config`) and creates these datasets through the middleware, so they appear under **Datasets**. Datasets that already exist are reused.

   ```text
   <pool>/apps/s6-cut            parent; also holds truenas-app.yaml
   <pool>/apps/s6-cut/source     git checkout and .env
   <pool>/apps/s6-cut/data       projects, Library, media, models, secrets
   ```

3. Clones the repository into `source`, using the host's `git` or, without it, Git in a container.
4. Creates `source/.env` from `.env.example` on the first run only. It sets `S6_DATA_PATH` to the data dataset and `S6_PORT` to 30180, or the next port that no listening socket and no other app, running or stopped, uses. If the engine's loopback debug port 8001 is taken, it also picks a free `S6_ENGINE_PORT`.
5. Gives UID/GID 10001 (the engine user) ownership of the data dataset.
6. Renders `compose.yaml` + `.env` with `docker compose config` into `<pool>/apps/s6-cut/truenas-app.yaml` (mode 600, because it contains `.env` values such as `OPENROUTER_API_KEY`).
7. Builds the images on the NAS with TrueNAS's project name (`docker compose -p ix-s6-cut build`), so the app's deploy step does not rebuild. TrueNAS gives a deploy 20 minutes.
8. Creates the Custom App with `app.create` (`custom_app: true`, `custom_compose_config_string`), or on a re-run updates it with `app.update`. That redeploys a running app. A stopped app is started with `app.redeploy`.
9. Waits up to 10 minutes for the `web` container to report healthy, then prints the LAN URL, the dataset paths, and how to update.

The app then appears under **Apps → Installed** as `s6-cut`, and Start, Stop, Edit and Delete work there as for any Custom App.

**Why a resolved file instead of `include:`.** TrueNAS keeps a Custom App's compose file under `/mnt/.ix-apps/app_configs/<app>/` and runs it from there. That breaks relative paths, and an `include:` would make TrueNAS depend on `.env` lookups it does not show. The resolved file has absolute build contexts and data paths. `docker compose` checks it on the NAS before it is submitted, and **Edit** shows exactly what runs.

### Update

Run the same command again. It runs `git fetch` and `git reset --hard origin/<branch>` (`main` by default) in `source`, rebuilds the images, and updates the app. `.env` and the data dataset are never overwritten. Snapshot the data dataset first if you want a rollback point.

Use the installer, not the Apps **Update** button, to update the scripted app: its images are built on the NAS and are not in a registry.

### Change settings

Edit `<pool>/apps/s6-cut/source/.env`, then re-run the install command to render and apply it. Changes made only in the app's **Edit** screen are replaced by the next re-run.

### Environment overrides

`sudo` drops your environment, so put overrides after `sudo`:

```bash
curl -fsSL https://raw.githubusercontent.com/carmelo-schepis/S6_CUT/main/install-truenas.sh | sudo S6_PORT=30200 bash
```

| Variable | Default | Meaning |
|---|---|---|
| `S6_POOL` | the Apps pool | Pool for the `apps/<app>` datasets |
| `S6_PORT` | 30180, or the next free port | Web port on the LAN. Saved to `.env`; an explicit value also changes an existing install |
| `S6_APP_NAME` | `s6-cut` | TrueNAS app name, also used in the dataset path |
| `S6_BRANCH` | `main` | Branch to install and track |
| `S6_REPO_URL` | this repository | Repository to clone |
| `S6_START_TIMEOUT` | 600 | Seconds to wait for the web service to become healthy |

### Uninstall

```bash
sudo bash /mnt/<pool>/apps/s6-cut/source/uninstall-truenas.sh
```

This deletes the app with `app.delete` and keeps every dataset, so re-running the installer brings S6_cut back with its data. Options:

- `--remove-images` also removes the app's images.
- `--purge` also destroys `<pool>/apps/s6-cut` with its `source` and `data` children. It lists the datasets and their paths, then asks you to type the dataset name. Add `--yes` to skip that prompt, for example when piping the script from curl: `curl -fsSL …/uninstall-truenas.sh | sudo bash -s -- --purge --yes`. ZFS cannot destroy a dataset while something uses it, so `--purge` first lists any process whose working directory or open files are inside these folders (for example a shell you `cd`'d into them) and stops without destroying anything until they are gone.

`S6_POOL` and `S6_APP_NAME` work as for the installer.

## TrueNAS SCALE: Install via YAML (no shell)

[`truenas/s6-cut.yaml`](../truenas/s6-cut.yaml) is a self-contained Custom App that runs the prebuilt multi-arch images `ghcr.io/carmelo-schepis/s6-cut-engine` and `ghcr.io/carmelo-schepis/s6-cut-web`, published by `.github/workflows/images.yml` on every push to `main`.

Both images are public, so TrueNAS pulls them without registry credentials. Besides `latest`, each push to `main` also tags the `package.json` version and `sha-<commit>`. To pin a release, use one of those in place of `latest`.

1. Create a dataset for the data, for example `tank/apps/s6-cut/data` (preset Generic).
2. In **Apps → Discover Apps → ⋮ → Install via YAML**, name the app `s6-cut` and paste the file.
3. Replace both `/mnt/tank/apps/s6-cut/data` paths with your dataset's path. Change `30180` if that port is taken.
4. Save, wait about two minutes for the engine, and open `http://<NAS-IP>:30180`.

The `data-init` service gives UID 10001 ownership of the data dataset on every start. To update, click **Update** when TrueNAS offers one, or run `midclt call -j app.pull_images s6-cut '{"redeploy": true}'`. Settings are the `environment:` values in the YAML. Edit them in the app's **Edit** screen.

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
S6_WHISPER_MODEL=base
```

Start with one worker. Transcription and H.264 composition consume substantial CPU, RAM, and I/O. No GPU is required.

## TrueNAS SCALE Custom App (manual fallback)

Use these steps if neither route above fits, for example on a TrueNAS release whose middleware API differs.

1. Choose the Apps pool and create the source/data datasets above.
2. Put the repository and `.env` in the source dataset.
3. In Apps, choose **Discover Apps → Custom App → Install via YAML** (wording varies by SCALE release).
4. Paste the resolved Compose definition from `docker compose -p ix-s6-cut config`, run in the source dataset.
5. Confirm `web` maps `${S6_PORT}:8080` and `engine` maps `127.0.0.1:${S6_ENGINE_PORT:-8001}:8001`. The engine port is published on the host loopback interface only; it is not exposed on the network.
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
