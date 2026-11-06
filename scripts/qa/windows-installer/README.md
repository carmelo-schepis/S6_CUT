# S6_CUT Windows installer verification

The existing Hermes job `2172e34e98bc` runs `every 4320m`. It dispatches a native
Windows test worker and exits quickly. Dispatch is never application acceptance.
`controller.py` runs under the same launchd supervision pattern used by the macOS
installer automation, watches Windows, resumes after a Mac restart, investigates
reproducible failures with a bounded Hermes agent, and publishes one terminal
result through the existing notifier/outbox. It has no recurring timer.

Windows uses one **on-demand task with no triggers** for each run. Its native
PowerShell host keeps `wsl.exe` and Windows interoperability alive while Python
orchestrates. A detached tmux pilot survived SSH but lost Windows interop when
the launching SSH process closed (`UtilAcceptVsock: accept4 failed 110`). The
on-demand task replaces only that unsupported lifecycle step. All installation,
Compose, Git-in-Docker and native installer harness execution remains native
PowerShell 5.1. Browser work reuses WSL's existing Node/Playwright installation;
media decoding reuses FFmpeg/FFprobe already shipped inside the tested engine.

## Ownership and recovery

Windows control root: `%LOCALAPPDATA%\S6InstallerVerification`.
Mac control root: `~/.hermes/s6-cut-windows-verification`.
Every run has a 32-hex ID, an ownership manifest written before resources, unique
Compose projects, native-probed free loopback ports, and separate profile/install,
configuration and data directories. The published command's default directory is
`<child USERPROFILE>\s6_cut`. Only the child profile changes; Docker connection
settings are retained. `S6_ENGINE_PORT` is numeric because Compose adds loopback.

The native child validates the resolved project, build contexts, data bind and
both loopback mappings before `compose up`. It executes the unchanged published
one-liner. Instrumented `Invoke-RestMethod` returns the exact downloaded text and
records its SHA-256 before `iex`. The worker checks installed Git SHA, branch
movement, health provenance, all running engine Python source hashes, image IDs,
frontend artifact hash and Docker port mappings.

WSL nonblocking locks prevent overlap. A durable active run survives either host
restarting. Recovery refuses to race a live worker and validates ownership again.
Cleanup enumerates Docker resources by this run's exact Compose labels and checks
them again before deletion. It removes only owned tags and data; no global prune,
unrelated process termination or reboot is used. Native Windows removes the owned
payload without weakening Docker-created Unix permission metadata. Reparse points
block cleanup. Compact results are retained for 30 days; failure evidence and logs
are bounded. Cleanup failure overrides test success.

## Live coverage

The desktop Playwright spec reuses existing configuration, workspace semantic
selectors and playback helpers. It imports the repository's small approved local
fixture, creates one Fast clip, plays/downloads it, records project/job/Library IDs
and download hash, refreshes and repeats playback. The engine's real decoder
validates the download. No provider profile or real API credential is seeded.

The worker separately builds a recorded compatible ancestor (`main~3`), seeds
actual application records/media through the UI, and upgrades it using the current
public one-liner. It verifies exact `.env` bytes, checkout advancement, identical
record IDs, playback/download hash and a second idempotent rerun. It also performs
a live custom path containing spaces with Git discovery hidden only in the child,
thereby using real Git-in-Docker without uninstalling host Git. The existing native
stub harness covers controlled missing Docker/daemon, unsupported Compose, invalid
ports, failed clone/fetch, dirty/diverged checkouts and readiness timeout. Stub
results are always reported separately from live evidence.

## SSH scope

The private identity is generated and retained only on mbpro1:
`~/.ssh/s6_windows_verification_ed25519` (0600). Only its public key is installed on
Windows with `restrict`, a mbpro1 Tailscale source restriction, and the fixed
`entry.ps1` command. The entry point accepts only this workflow's probe, dispatch,
status, evidence, recovery and fixed-repository candidate validation actions.
Arbitrary commands and forwarding must fail before the alias is switched. The
earlier session-added broad key was removed after successful scoped authentication.
Provisioning preserves authorized keys and unrelated SSH configuration with backups.

## Notifications

Only a valid protected dispatch receipt for this exact job defers its source
collector summary. Other jobs retain their original behavior. Terminal results
use the `windows_installer_terminal` outbox kind, excluded from the general sender.
The controller reuses the existing deterministic notifier with the immutable target
`slack:D0C6DSHG2LE` / user `U0BJSCGSBKJ`, verifies that identity before every attempt,
and requires exact readback acknowledgement. It never uses origin/general fallback.
The event key is the durable run ID. Definitive failures retry with backoff;
uncertain sends are reconciled by the existing exact-message reconciler and are
never blindly resent. Worker status and Slack delivery status are separate fields.

## Deployment and operation

Read `DO-NOT-CHANGE/AGENTS.md` first. From the trusted planning checkout:

1. `python3 scripts/qa/windows-installer/stage.py` stages credential-free code and
   installs the Mac controller and existing job **paused**. A running Windows
   worker blocks package replacement. No new Hermes job is created.
2. `python3 scripts/qa/windows-installer/provision-access.py` provisions and tests
   the dedicated key through existing approved access. Private key contents never
   leave mbpro1.
3. On mbpro1, use the protected package's controller `dispatch`, `status ID` and
   `monitor`. The production job has no test-case selector.
4. Complete the live pilot plus overlap, SSH closure, process-timeout and interrupted
   cleanup tests. Verify a terminal summary acknowledged in the owner's DM.
5. Resume the **existing** job through Hermes `cron.jobs.resume_job`, then read back
   its interval, script, local delivery, enabled state and actual next execution.

For fault verification, the fixed entry point accepts `s6win dispatch ID timeout`,
`crash`, or `crash-after-fresh`; these are worker diagnostics, not installer PASS.
For candidate PR validation: `s6win candidate ID BRANCH` validates a branch in this
same repository under native PowerShell, with fresh install, media smoke, rerun and
cleanup. Candidate results explicitly state that they are not the published command
test. Product failure requires original-SHA reproduction, fingerprint PR deduplication
and native readback before a fix can be claimed. Draft PRs must contain meaningful
executable regression coverage and explicitly unresolved evidence. No auto merge.

Run lifecycle regressions on mbpro1:

`python3 -m unittest discover -s tests/qa -p test_windows_installer_automation.py -v`

Also run the existing notifier collector regressions after deploying its narrow
source-deferral hook. No application UI, API, schema or publication invariant changes
are part of this automation.
