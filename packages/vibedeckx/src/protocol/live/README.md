# Live protocol compatibility probes

Run through `pnpm --filter vibedeckx test:compat`, with a file argument to select
an agent. Offline Vitest excludes these tests. They use real CLIs and paid model
calls; generated transcripts live in the ignored `recordings/` directory.

## fx

Install fx using its [official installer](https://fx.sh/docs/getting-started/installation)
and sign in as the current user. Run:

```bash
pnpm --filter vibedeckx test:compat src/protocol/live/fx.live.test.ts --retry 0
```

Without an fx binary the lifecycle test skips, like the Claude/Codex probes.
`VIBEDECKX_COMPAT_REQUIRED=1` makes a missing binary a failure (used in CI).
An installed binary with invalid credentials fails rather than silently skipping.

The probe uses production spawn/Provider code, checks incoming `FX-*` contracts,
and exercises queued turns, text/thinking, tools, cancellation, new-session replay
and a model change. Defaults are `spacexai/grok-4.7` and `openai/gpt-5.4-mini`;
`FX_COMPAT_MODEL` and `FX_COMPAT_REPLAY_MODEL` can override them. Use a first model
that emits thinking. The second model should differ to exercise a model change.

The probe keeps HOME, credentials and their refresh locks in place. It uses
process-local full-access and `FX_AUTO_UPGRADE=0`, does not call `set_mode`, and
checks that user settings are unchanged. Transcripts contain ACP stdin/stdout,
with the disposable workspace and home paths replaced; they omit stderr. The
metadata file records CLI version, platform and models. Review for secrets and
private data before sharing or committing new recordings. Curated transcripts
live in `../fx/__fixtures__/`; no `.dev` scripts are required.

### CI

The existing `protocol-compat` workflow has pinned/latest fx cells. Versions come
from `.github/agent-versions.json` or the official release feed, and the official
installer receives the resolved version explicitly. This pins CI only, not user
installations. The workflow remains manually triggered; no schedule is enabled.

Configure the repository secret `AI_GATEWAY_API_KEY`. On the fresh CI runner,
`fx provider gateway` selects Gateway and fx reads the key from the environment
([fx authentication documentation](https://fx.sh/docs/getting-started/authentication)).
No personal OAuth file is copied into CI. Missing credentials fail the job with
an explicit message. Live recordings are local job diagnostics, not automatically
published artifacts.

### Real hub smoke test

```bash
FX_LOCAL_HUB_SMOKE=1 pnpm --filter vibedeckx test:compat src/protocol/live/fx-hub.live.test.ts --retry 0
```

This creates a local server and isolated database, and calls the real hub tools
using temporary signed tokens. It does not verify an authorized remote worker.
To test an existing hub, supply `FX_HUB_SMOKE_URL`,
`VIBEDECKX_CROSS_REMOTE_MCP_TOKEN` and `VIBEDECKX_SESSION_MCP_TOKEN` in the
environment and run the same test. Never commit or print those tokens. The test
proposes a temporary task; it does not accept or create one. Remote product
acceptance of sessions, executors, schedules, Reviewer, Loop and Commander is
separate from this protocol smoke test.
