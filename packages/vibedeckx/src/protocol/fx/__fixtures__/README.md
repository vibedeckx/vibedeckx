# fx ACP recordings — 0.0.16

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

The original one-off Python probes remain locally in ignored `.dev/scripts/`.
They are not committed or required to consume these fixtures. Provider unit and
live contract tests should take over the relevant checks during integration.
These probes create fx histories for disposable workspaces; they do not delete
user sessions.

See [the parity matrix and decisions](../../../../../../docs/fx-agent-parity.md)
for mapping details, downgrade boundaries and remaining implementation tasks.
