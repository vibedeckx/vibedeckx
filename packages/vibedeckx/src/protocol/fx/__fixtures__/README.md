# fx ACP recordings — 0.0.16 / 0.0.17

Recorded on 2026-11-13, Linux x86_64, fx revision `481104fdbc24`.
Binary SHA-256: `b8670dcc121b4289e2bdcd2a3e226fd64e3def53c976c42b42de72ee69f66cae`.
The installed binary was copied to an isolated directory; every child uses
`FX_AUTO_UPGRADE=0`. Main model: `spacexai/grok-4.7`; model override probe:
`openai/gpt-5.4-mini`. These are real binary/model exchanges, not generated fixtures.

ACP JSONL rows wrap wire messages in `{direction: "stdin" | "stdout" | "stderr",
message: ...}`. `http-mcp-server.jsonl` instead records HTTP path, a boolean
`authorizationMatched`, and the actual MCP request. It never records auth headers.
`<WORKSPACE>` / `<PROBE_ROOT>` replace disposable absolute paths. Message IDs,
model catalog, token counts, errors and timestamps are preserved. The fixed
`LOCAL-ONLY-PROBE` token is exclusively for the local synthetic MCP service.
Client and server RPC ID sequences overlap: match direction as well as ID.

| Recording | Evidence / scope |
| --- | --- |
| unauthenticated | Credential-free initialize fails -32600; new fails Not initialized |
| initialize-session | Successful initialize/new, first text response and usage |
| session-tools-permissions | Parameter errors, ask file/shell approval, auto file/shell, two-turn memory, cancel and subsequent successful prompt |
| restart-load | New process, same native ID, history replay, correct remembered marker |
| restart-resume | New process, same native ID, no history replay, correct remembered marker |
| auto-explicit-ask | Auto mode plus explicit bash ask rule still requires a permission response; allow_once succeeds |
| http-mcp-session | Both server names call probe_echo, kind other approval, canonical tool metadata, restores original default mode on exit |
| http-mcp-server | Both actual tools/call requests carry matching Authorization |
| session-parameters-model | Omitted parameters, invalid shapes, model override and functional systemPrompt, set_config_option |
| model-load / model-resume | CLI --model overrides saved model in returned configOptions; no model completion in these two recordings |
| restore-default-mode | Restores original auto mode after the initial experiments |

Every name above has suffix `.jsonl`. The main recording includes an unsuccessful
MCP attempt: the first synthetic server returned an obsolete protocol version.
It is retained as a real observed failure, not counted as the successful MCP
probe. Dedicated HTTP recordings use the corrected server. They prove HTTP
transport/auth/tool naming, not actual hub business logic.

The first attempts to install explicit permission rules used settings permissions
fx rejected; they did not establish auto approval behavior. The committed
`auto-explicit-ask` is the successful rerun with directory 0700 / settings 0600.
No failed-run assertion is presented as passing evidence.

## Recording procedure

Use a pinned fx 0.0.16 binary with `FX_AUTO_UPGRADE=0`, an authenticated
provider, and a disposable workspace. Send newline-delimited ACP JSON-RPC
messages following the recorded client/server order. Approval replies must use
the server's request ID and an offered option ID. Only approve the synthetic
file, printf/sleep and local MCP echo actions requested for the probe.

For the HTTP scenario, provide both named local HTTP MCP endpoints, require a
test Authorization header, and expose `probe_echo` returning `MCP_OK:<marker>`.
Reply to MCP initialize with the requested supported protocol version; unsupported
methods return -32601. Verify the actual authenticated tools/call requests.

For auto-mode approval, use a disposable HOME with a `.fx` directory of mode 0700
and settings of mode 0600 containing `permission.bash["*"] = "ask"`. Keep any
necessary local credential copy private and delete it afterwards. For the
unauthenticated scenario, use a separate empty HOME and remove credential
environment variables. Do not change the user's login to produce error samples.

fx `session/set_mode` persists its default: restore the original mode on exit.
For restart experiments, reuse the same disposable workspace and native session
ID in a new process, and compare history replay before sending the next prompt.
Validate both directions of RPC IDs, tool states, marker recall, cancellation,
HTTP auth/calls and model configuration, then redact private paths and credentials
before saving recordings.

The one-off Python probes have been retired after their retained checks moved
into the committed test suite. No test or reproduction command requires `.dev`:

- `schema.test.ts`: ACP envelopes and response/update contracts for every ACP transcript.
- `recordings.test.ts`: historical turn memory, cancellation, direction-aware permission replies,
  native load/resume evidence, model overrides, system prompt, invalid parameters,
  unauthenticated errors and HTTP authentication/calls (using the separate HTTP log format).
- `providers/fx-provider.recordings.test.ts`: product behavior when replaying real traffic.
- `../live/fx.live.test.ts`: current full-access lifecycle with a real CLI/model.
- `../live/fx-hub.live.test.ts`: opt-in real hub MCP calls.

The older ask/auto and native load/resume fixtures are historical evidence, not
current product promises. Keep them unchanged; current tests do not copy OAuth
credentials, change HOME, or call persistent `session/set_mode`.

See [the parity matrix and decisions](../../../../../../docs/fx-agent-parity.md)
for mapping details, downgrade boundaries and remaining implementation tasks.

## Task 5 — fx 0.0.17 (2026-11-16)

The `task5-*.jsonl` recordings use installed fx 0.0.17, SHA-256
`2cf4be240b42826d01c055913638bb879d1bb48afd80b7f3a3f21b15b2701296`,
with `FX_AUTO_UPGRADE=0`, `fx acp --permission-mode auto --model …`, the original
HOME/login and disposable workspaces. No credentials were copied, no set_mode
was sent, and no settings file was written by the probes. Workspace paths are
replaced with `<WORKSPACE>`. These are real exchanges, not synthetic tests.

| Recording | Model | Evidence |
| --- | --- | --- |
| task5-tools-lifecycle | spacexai/grok-4.7 | ACP question fallback, subagent message + wait + late final report, yielded shell run/interact |
| task5-shell-cancel-failure | openai/gpt-5.4-mini | Cancel after shell PID file exists; subsequent prompt; shell exit 7; child report before prompt response even without wait |
| task5-subagent-cancel-shell-stop | openai/gpt-5.4-mini | Cancel after child's shell PID file exists; subsequent prompt; shell stop; run without interact |
| task5-tool-cards | openai/gpt-5.4-mini | write/read/edit/glob/grep/web_search/web_fetch fields and outputs |

Reproduce by starting the pinned CLI above in a disposable directory and sending
the recorded stdin initialize/new/prompt messages, substituting your directory
and the returned sessionId. Wait for each matching response before the next
request. Keep the original authentication environment. For cancellation, poll
`cancel.pid` in that workspace, then send the recorded cancel notification about
300 ms after it exists (not on the pending tool event). Record both directions.
Do not approve unexpected permission requests. After each cancel, send the next
recorded prompt to verify the same session remains usable.

The shell cancel probe observed its PID still alive before cleanup, with no
`cancelled-marker`; it explicitly terminated that probe shell before exiting.
The child cancellation probe observed its PID absent and marker absent at the
end. These filesystem checks are observations outside the ACP transcript and
must not be inferred merely from `stopReason: cancelled`. Always clean up probe
processes; the shell commands are also bounded by sleep 30. shell stop was sent
by the model as `action: stop`, `session_id: shell-2`, `force: true`.

The first two files retain complete scenario turns and omit later unrelated
schema-discovery prompts; no wire messages within the retained turns were
altered except workspace redaction. Native web_search emitted empty rawInput in
the OpenAI-model sample; do not invent a query. Native content snippets can be
truncated by fx itself (including web_fetch); recordings preserve them as sent.

`providers/fx-provider.recordings.test.ts` replays these through the real provider;
`agent-session-manager.fx.test.ts` separately verifies persisted state and
turn-end outcomes with a simulated ACP process. UI card and question submission
tests are in `agent-message.fx-tools.test.tsx`. None substitutes for a browser
end-to-end test or guarantees that cancelling a prompt kills every child process.


## Task 7 — current full-access lifecycle (2026-11-16)

`task7-fx-lifecycle-1.jsonl` and `task7-fx-lifecycle-2.jsonl` were captured by the
committed `fx.live.test.ts` using fx 0.0.17 on Linux x86_64, the original login,
and process-local `--permission-mode full-access`. The adjacent metadata file
records the version, platform and models. The first transcript covers queued
turns, thinking, cancel-then-continue and a completed shell tool. The second
starts a new native session with a different model and replays a conversation
marker. No handshake mode is rewritten for these recordings. User settings
remained byte-identical. Workspace/home paths are redacted; stderr is not recorded.

Run from the repository root:

```bash
pnpm --filter vibedeckx exec vitest run src/protocol/fx src/providers/fx-provider.recordings.test.ts
pnpm --filter vibedeckx test:compat src/protocol/live/fx.live.test.ts --retry 0
FX_LOCAL_HUB_SMOKE=1 pnpm --filter vibedeckx test:compat src/protocol/live/fx-hub.live.test.ts --retry 0
```

Live runs write new local transcripts to the ignored `protocol/live/recordings/`
directory. Review and redact a recording before promoting it here; fixtures are
not product runtime data. See [live probe setup](../../live/README.md) for CI
credentials and missing-binary behavior. These tests do not replace remote-worker
acceptance of every product entry point.

## Task 8 — fx ask 0.0.17 (2026-11-16)

`task8-ask.json` records real `fx ask` argv, stdout, stderr, exit status and wall
time in a disposable workspace with original login and `FX_AUTO_UPGRADE=0`.
The auto text request succeeds; the ask-mode shell request cannot obtain
approval with stdin closed and exits 1 promptly. No credentials/settings were
copied or edited. Reproduce each recorded argv with stdin redirected from
`/dev/null`. These are ask protocol observations, not ACP observations, and do
not establish that auto bypasses explicit ask rules. Product cron/stop checks
live in `src/protocol/live/fx-executor.live.test.ts`; enable `FX_EXECUTOR_LIVE=1`.

`task8-auto-explicit-ask.json` instead uses a real fx executable with a synthetic
local OpenAI-compatible model response requesting shell execution, isolated
FX_HOME settings and no credentials. It proves auto still honors explicit ask
rules and exits 1 without interaction. The live test reproduces the local
provider setup; it is not evidence about an external model's decisions.


## Task 11 product lifecycle evidence (2026-11-17)

`task11-product-results.json` contains assistant responses, completion outcomes,
and native-ID counts captured from real manager sessions (fx 0.0.17, Codex
0.159.2, Claude Code 2.1.325). This is a product result excerpt, **not an ACP
wire recording**, and is not fed to the ACP schema replay tests. The final
6-test live run passed without retries, including independent branch IDs,
inclusive history cutoff, four switch directions, instruction-file controls,
and retention leaving fx's native log unchanged after deleting product rows.

Reproduce with all three CLIs installed and signed in:

```sh
FX_PARITY_RECORD_FILE=/tmp/fx11-new-results.jsonl pnpm --filter vibedeckx exec vitest run --config vitest.live.config.ts src/protocol/live/fx-parity.live.test.ts --retry 0
```

The optional result file is append-only; use a fresh path for each run.
`task11-browser-results.json` is a database excerpt from the isolated browser
acceptance run, with inline image bytes replaced by their length and temporary
attachment paths normalized. It records ordinary file, inline PNG, >5 MiB PNG
file fallback, cross-agent branch/send-back, favorite and model-reset results.
UI observations and repeatable browser steps are in `docs/fx-agent-parity.md`
under Task 11. Neither excerpt claims lossless history restoration, native-file
cleanup, or real AI title generation without a configured title API key.
