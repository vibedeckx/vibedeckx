"use client";

import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Logo } from "@/components/brand/logo";

const INSTALL_COMMAND = "npm install -g vibedeckx";

export function LandingPage({ onSignIn }: { onSignIn: () => void }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(INSTALL_COMMAND);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="vdx-lp">
      <style>{vdxStyles}</style>

      {/* ───── Nav ───── */}
      <header className="nav">
        <div className="wrap nav-inner">
          <a href="#" className="brand" onClick={(e) => e.preventDefault()}>
            <Logo size={24} />
            <span>vibedeckx</span>
          </a>
          <nav className="nav-links">
            <a href="#commander">Commander</a>
            <a href="#features">Features</a>
            <a href="#how">How it works</a>
            {/* TODO: re-enable once Pricing section is live */}
            {/* <a href="#pricing">Pricing</a> */}
            <a
              href="https://github.com/vibedeckx-dev/vibedeckx"
              target="_blank"
              rel="noopener noreferrer"
            >
              Source
            </a>
            <a
              href="https://github.com/vibedeckx-dev/vibedeckx/releases"
              target="_blank"
              rel="noopener noreferrer"
            >
              Changelog
            </a>
          </nav>
          <div className="nav-right">
            <button onClick={onSignIn} className="btn btn-ghost">
              Sign in
            </button>
            <button onClick={onSignIn} className="btn btn-primary">
              Open cockpit
              <span className="kbd">⏎</span>
            </button>
          </div>
        </div>
      </header>

      {/* ───── Hero ───── */}
      <section className="hero">
        <div className="wrap hero-inner">
          <span className="eyebrow">
            <span className="dot" />
            v0.1.6 · now cloud-hosted · mobile app coming
          </span>
          <h1>
            Mission control for your <em>coding&nbsp;agents.</em>
          </h1>
          <p className="lede">
            Stop guessing which of a dozen terminal windows is doing what. Every agent
            gets a named workspace, live status at a glance, and a ping when it&rsquo;s
            done — run them in parallel, across any environment, from any device.
          </p>
          <div className="hero-cta">
            <button onClick={onSignIn} className="btn btn-primary btn-lg">
              Enter the cockpit
            </button>
            <a href="#how" className="btn btn-lg">
              See it in action
            </a>
          </div>
          <div className="install">
            <span className="dollar">$</span>
            <span>{INSTALL_COMMAND}</span>
            <button className="copy" aria-label="Copy" onClick={handleCopy}>
              {copied ? (
                <Check width={13} height={13} />
              ) : (
                <Copy width={13} height={13} />
              )}
            </button>
          </div>
        </div>

        {/* Product preview */}
        <div className="wrap preview-wrap">
          <div className="preview-frame">
            <div className="preview-chrome">
              <div className="traffic">
                <span /> <span /> <span />
              </div>
              <div className="preview-url">
                <svg
                  className="lock"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                >
                  <rect x="3.5" y="7.5" width="9" height="6" rx="1" />
                  <path d="M5.5 7.5V5a2.5 2.5 0 0 1 5 0v2.5" />
                </svg>
                vibedeckx.local
              </div>
              <div style={{ width: 36 }} />
            </div>

            <div className="mini-app">
              <div className="mini-topbar">
                <span className="brand">
                  <Logo size={20} live={false} stripes="off" />
                </span>
                <span className="crumb">
                  <b>orchestrator-core</b> ·{" "}
                  <span
                    className="mono"
                    style={{ color: "var(--vdx-accent)" }}
                  >
                    feat/parallel-streams
                  </span>
                </span>
                <div className="right">
                  <div className="mini-search">
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                    >
                      <circle cx="7" cy="7" r="4.5" />
                      <path d="m13 13-2.5-2.5" />
                    </svg>
                    <span>Search…</span>
                    <span className="kbd">⌘K</span>
                  </div>
                </div>
              </div>

              <div className="mini-sidebar">
                <div className="mini-section-label">Workspace</div>
                <div className="mini-nav-item active">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <rect x="2" y="2" width="5" height="5" rx="1" />
                    <rect x="9" y="2" width="5" height="5" rx="1" />
                    <rect x="2" y="9" width="5" height="5" rx="1" />
                    <rect x="9" y="9" width="5" height="5" rx="1" />
                  </svg>
                  Sessions <span className="count">6</span>
                </div>
                <div className="mini-nav-item">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <path d="M2 4h12M2 8h12M2 12h8" />
                  </svg>
                  Tasks <span className="count">11</span>
                </div>
                <div className="mini-nav-item">
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.5"
                  >
                    <rect x="2" y="3" width="12" height="10" rx="1.5" />
                    <path d="M2 6h12" />
                  </svg>
                  Files
                </div>

                <div className="mini-section-label" style={{ marginTop: 10 }}>
                  Branches
                </div>
                <div className="tree-project">▾ orchestrator-core</div>
                <div className="branch-row active">
                  <span className="bdot green" />
                  feat/parallel-streams
                </div>
                <div className="branch-row">
                  <span className="bdot" />
                  chore/upgrade-vercel-ai-sdk
                </div>
                <div className="tree-project">▾ web-ui</div>
                <div className="branch-row">
                  <span className="bdot amber" />
                  fix/diff-virtualization
                </div>
                <div className="branch-row">
                  <span className="bdot" />
                  feat/command-palette
                </div>
                <div className="tree-project">▾ edge-runner</div>
                <div className="branch-row">
                  <span className="bdot green" />
                  main
                </div>
              </div>

              <div className="mini-main">
                <div className="mini-page-head">
                  <h2>
                    Sessions <span className="count">6 active</span>
                  </h2>
                  <button
                    className="btn"
                    style={{ padding: "4px 10px", fontSize: "11.5px" }}
                  >
                    + New session
                  </button>
                </div>
                <div className="mini-filter">
                  <span className="mini-chip active">
                    All <span className="count">6</span>
                  </span>
                  <span className="mini-chip">
                    Working <span className="count">2</span>
                  </span>
                  <span className="mini-chip">
                    Review <span className="count">1</span>
                  </span>
                  <span className="mini-chip">
                    Done <span className="count">1</span>
                  </span>
                  <span className="mini-chip">
                    Failed <span className="count">1</span>
                  </span>
                </div>
                <div className="mini-grid">
                  <div className="mini-card working">
                    <div className="mini-card-head">
                      <span className="bdot green" />
                      <div className="meta">
                        <span className="project">orchestrator-core</span>
                        <span className="branch">feat/parallel-streams</span>
                      </div>
                      <span className="mini-host">local</span>
                    </div>
                    <div className="mini-card-body">
                      <div className="mini-task">
                        Refactor session multiplexer — per-stream write locks to stop
                        torn JSON.
                      </div>
                      <div className="mini-tools">
                        <span className="mini-tool">edit multiplex.ts</span>
                        <span className="mini-tool">pnpm test</span>
                      </div>
                    </div>
                    <div className="mini-card-foot">
                      <span>
                        <span className="add">+124</span>{" "}
                        <span className="del">−37</span>
                      </span>
                      <span className="grow" />
                      <span>12m 04s</span>
                    </div>
                  </div>

                  <div className="mini-card review">
                    <div className="mini-card-head">
                      <span className="bdot amber" />
                      <div className="meta">
                        <span className="project">web-ui</span>
                        <span className="branch">fix/diff-virtualization</span>
                      </div>
                      <span className="mini-host">local</span>
                    </div>
                    <div className="mini-card-body">
                      <div className="mini-task">
                        Virtualize diff rows so scroll anchors on the line under the
                        cursor.
                      </div>
                      <div className="mini-tools">
                        <span className="mini-tool">edit useDiffRows.ts</span>
                        <span className="mini-tool">rm -rf …</span>
                      </div>
                    </div>
                    <div className="mini-card-foot">
                      <span>
                        <span className="add">+88</span>{" "}
                        <span className="del">−14</span>
                      </span>
                      <span className="grow" />
                      <span>Approval ↑</span>
                    </div>
                  </div>

                  <div className="mini-card working">
                    <div className="mini-card-head">
                      <span className="bdot green" />
                      <div className="meta">
                        <span className="project">edge-runner</span>
                        <span className="branch">main</span>
                      </div>
                      <span className="mini-host">gpu-01</span>
                    </div>
                    <div className="mini-card-body">
                      <div className="mini-task">
                        Reproduce CUDA OOM at batch=16 and downshift to batch=8 instead
                        of crashing.
                      </div>
                      <div className="mini-tools">
                        <span className="mini-tool">bash bench.long_ctx</span>
                      </div>
                    </div>
                    <div className="mini-card-foot">
                      <span>
                        <span className="add">+0</span>{" "}
                        <span className="del">−0</span>
                      </span>
                      <span className="grow" />
                      <span>38m 12s</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Floating annotations */}
          <div className="annot a1">
            <span className="badge">01</span> Live status at a glance
          </div>
          <div className="annot a2">
            <span className="badge">02</span> Live tool calls, streamed
          </div>
          <div className="annot a3">
            <span className="badge">03</span> Diff-first review · approve to merge
          </div>
        </div>
      </section>

      {/* ───── The commander ───── */}
      <section id="commander" className="commander">
        <div className="wrap">
          <div className="section-head">
            <span className="kicker">The commander</span>
            <h2>
              Set the goal. Approve the plan.
              <br />
              <em>It runs the rest.</em>
            </h2>
            <p>
              Main Chat isn&rsquo;t just another agent — it&rsquo;s the commander. Hand
              it a goal and it breaks the work into a plan you approve, then dispatches
              and drives a fleet of agents to carry it out — looping you in only when a
              call is yours to make.
            </p>
          </div>

          {/* Commander deck */}
          <div className="cmd-deck">
            <div className="cmd-deck-head">
              <Logo size={16} live={false} stripes="off" />
              <span>
                main chat · <span className="star">commander</span>
              </span>
              <span className="right">
                <span className="bdot green" /> plan approved · running
              </span>
            </div>

            <div className="cmd-body">
              <div className="cmd-goal">
                <span className="who">YOU</span>
                <span className="msg">
                  Ship <b>dark mode</b> across the web app — theme tokens, every
                  component, and a settings toggle that persists.
                </span>
              </div>

              <div className="cmd-plan">
                <div className="cmd-plan-head">
                  <span>Mission plan</span>
                  <span className="count">5 steps · 3 agents</span>
                </div>

                <div className="cmd-step done">
                  <span className="ck">✓</span>
                  <span className="txt">Audit styles &amp; extract theme tokens</span>
                  <span className="who-pill">done</span>
                </div>
                <div className="cmd-step work">
                  <span className="ck" />
                  <span className="txt">Refactor 18 components onto tokens</span>
                  <span className="who-pill green">web-ui · sonnet-4.5</span>
                </div>
                <div className="cmd-step work">
                  <span className="ck" />
                  <span className="txt">Wire the settings toggle + persistence</span>
                  <span className="who-pill green">web-ui · codex-1</span>
                </div>
                <div className="cmd-step ask">
                  <span className="ck">!</span>
                  <div className="txt">
                    Drop legacy <code>theme.css</code>{" "}
                    <span className="del">−420</span>
                    <div className="ask-row">
                      <span className="ask-label">Destructive — your call</span>
                      <button className="btn cmd-approve">Approve</button>
                      <button className="btn cmd-deny">Deny</button>
                    </div>
                  </div>
                </div>
                <div className="cmd-step queued">
                  <span className="ck" />
                  <span className="txt">Visual-regression sweep across breakpoints</span>
                  <span className="who-pill">queued</span>
                </div>
              </div>
            </div>
          </div>

          {/* Three promises */}
          <div className="cmd-promises">
            <div className="cmd-promise">
              <span className="n">01</span>
              <h4>Set the goal. Approve the plan.</h4>
              <p>
                Describe the outcome. The commander decomposes it into a plan you can
                see and sign off on — never a black box.
              </p>
            </div>
            <div className="cmd-promise">
              <span className="n">02</span>
              <h4>From one agent to a whole team.</h4>
              <p>
                It dispatches and drives a fleet of agents in parallel — each in its own
                workspace — and keeps them on track.
              </p>
            </div>
            <div className="cmd-promise">
              <span className="n">03</span>
              <h4>It only interrupts you when it matters.</h4>
              <p>
                It runs on its own and surfaces just the decisions that are yours — an
                approval, a failure, a fork in the road.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ───── Features ───── */}
      <section id="features" className="features">
        <div className="wrap">
          <div className="section-head">
            <span className="kicker">Built for the way agents actually work</span>
            <h2>Mission control for a fleet of agents.</h2>
            <p>
              Stop tab-juggling a dozen terminal windows. Vibedeckx gives every agent a
              named workspace, its own model, and one dashboard to see, steer, and ship
              them all.
            </p>
          </div>

          <div className="feature-grid">
            <div className="feature f-wide">
              <span className="kicker">At a glance</span>
              <h3>Know what every agent is doing — at a glance.</h3>
              <p>
                Every agent runs in its own named workspace with a live status you can
                read in a second: working, waiting on you, done, or failed. No more
                squinting at four cramped windows trying to remember which is which.
              </p>
              <div className="branch-graph">
                <div className="bg-row">
                  <span className="gutter">●</span>
                  <span className="label">main</span>
                  <span className="pill">protected</span>
                </div>
                <div className="bg-row">
                  <span className="gutter">├╴●</span>
                  <span className="label">feat/parallel-streams</span>
                  <span className="pill green">working · sonnet-4.5</span>
                </div>
                <div className="bg-row">
                  <span className="gutter">├╴●</span>
                  <span className="label">fix/diff-virtualization</span>
                  <span className="pill amber">review · codex-1</span>
                </div>
                <div className="bg-row">
                  <span className="gutter">├╴●</span>
                  <span className="label">feat/command-palette</span>
                  <span className="pill">idle · sonnet-4.5</span>
                </div>
                <div className="bg-row">
                  <span className="gutter">└╴●</span>
                  <span className="label">chore/upgrade-vercel-ai-sdk</span>
                  <span className="pill accent">pushed</span>
                </div>
              </div>
            </div>

            <div className="feature f-third">
              <span className="kicker">Live</span>
              <h3>Stream every tool call.</h3>
              <p>
                Tail an agent's terminal, reads, writes, and grep results without
                leaving the dashboard.
              </p>
              <div className="term">
                <div>
                  <span className="p">~/orchestrator-core</span>{" "}
                  <span className="o">(feat/parallel-streams)</span>
                </div>
                <div>
                  <span className="o">$ pnpm test multiplex</span>
                </div>
                <div className="ok">✓ interleaves two streams (124ms)</div>
                <div className="ok">✓ holds per-stream order (88ms)</div>
                <div className="o">Tests: 24 passed</div>
                <div>
                  <span className="p">$</span>{" "}
                  <span className="cursor">▌</span>
                </div>
              </div>
            </div>

            <div className="feature f-half">
              <span className="kicker">Diff-first review</span>
              <h3>Approve at the line, not the PR.</h3>
              <p>
                Inspect every hunk in a real diff viewer with syntax highlighting and
                line-by-line accept/reject. Merge only what you trust.
              </p>
              <div className="diff">
                <div className="diff-head">
                  <span>multiplex.ts</span>
                  <span className="add">+12</span>
                  <span className="del">−4</span>
                </div>
                <div className="diff-row">
                  <span className="ln">88</span>
                  <span className="code">{"  write(streamId, chunk) {"}</span>
                </div>
                <div className="diff-row del">
                  <span className="ln">89</span>
                  <span className="code">    const lock = WriteLock.shared()</span>
                </div>
                <div className="diff-row add">
                  <span className="ln">89</span>
                  <span className="code">    // Per-stream lock prevents torn JSON</span>
                </div>
                <div className="diff-row add">
                  <span className="ln">90</span>
                  <span className="code">    const lock = WriteLock.perStream(id)</span>
                </div>
                <div className="diff-row">
                  <span className="ln">91</span>
                  <span className="code">    lock.acquire()</span>
                </div>
              </div>
            </div>

            <div className="feature f-half">
              <span className="kicker">Human-in-the-loop</span>
              <h3>Approval gates for the scary stuff.</h3>
              <p>
                Mark commands as <span className="mono">requires-approval</span> per
                project. The agent pauses, surfaces what it wants to run, and waits
                for your tap.
              </p>
              <div className="approval">
                <div className="h">
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.6"
                  >
                    <path d="M8 1.5 14.5 13.5h-13z" />
                    <path d="M8 6v3.5" />
                    <circle cx="8" cy="11.5" r="0.6" fill="currentColor" />
                  </svg>
                  Approval required
                </div>
                web-ui · codex-1 wants to run{" "}
                <code>rm -rf node_modules/.cache</code>
                <div className="acts">
                  <button
                    className="btn"
                    style={{
                      padding: "4px 10px",
                      fontSize: "11.5px",
                      background: "var(--vdx-fg)",
                      color: "var(--vdx-bg)",
                      borderColor: "var(--vdx-fg)",
                    }}
                  >
                    Approve
                  </button>
                  <button className="btn btn-deny">Deny</button>
                </div>
              </div>
            </div>

            <div className="feature f-third">
              <span className="kicker">Model agnostic</span>
              <h3>Use the right model per branch.</h3>
              <p>
                Claude for refactors, Codex for tight loops, your own model over
                OpenAI-compat.
              </p>
              <div className="models">
                <div className="model-row active">
                  <span className="mark">CL</span>
                  <span className="name">claude-sonnet-4.5</span>
                  <span className="desc">200K · $3/M</span>
                </div>
                <div className="model-row">
                  <span className="mark">CX</span>
                  <span className="name">codex-1</span>
                  <span className="desc">128K · $2/M</span>
                </div>
                <div className="model-row">
                  <span className="mark">LL</span>
                  <span className="name">llama-3.3-70b</span>
                  <span className="desc">local · ollama</span>
                </div>
              </div>
            </div>

            <div className="feature f-third">
              <span className="kicker">Cross-environment</span>
              <h3>Edit here, test there.</h3>
              <p>
                Wire up as many run environments as you like and route work between
                them — build on one, run the suite on your GPU box, deploy from a third.
              </p>
              <div className="branch-graph">
                <div className="bg-row">
                  <span className="gutter">▣</span>
                  <span className="label">local</span>
                  <span className="pill green">4 sessions</span>
                </div>
                <div className="bg-row">
                  <span className="gutter">▣</span>
                  <span className="label">gpu-01</span>
                  <span className="pill green">1 session</span>
                </div>
                <div className="bg-row">
                  <span className="gutter">▣</span>
                  <span className="label">vps-fr-3</span>
                  <span className="pill">idle</span>
                </div>
              </div>
            </div>

            <div className="feature f-third">
              <span className="kicker">Alerts</span>
              <h3>Get pinged when it&rsquo;s done.</h3>
              <p>
                Stop babysitting the dashboard. Vibedeckx notifies you the moment an
                agent finishes, needs approval, or fails — on the web now, your phone
                soon.
              </p>
              <div className="branch-graph">
                <div className="bg-row">
                  <span className="gutter">✓</span>
                  <span className="label">feat/parallel-streams</span>
                  <span className="pill green">done</span>
                </div>
                <div className="bg-row">
                  <span className="gutter">!</span>
                  <span className="label">fix/diff-virtualization</span>
                  <span className="pill amber">needs approval</span>
                </div>
                <div className="bg-row">
                  <span className="gutter">✕</span>
                  <span className="label">edge-runner/main</span>
                  <span className="pill rose">failed</span>
                </div>
                <div
                  className="bg-row"
                  style={{
                    borderTop: "1px dashed var(--vdx-line)",
                    paddingTop: 6,
                    marginTop: 4,
                  }}
                >
                  <span className="gutter">♪</span>
                  <span className="label">today</span>
                  <span className="pill accent">3 alerts</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───── How it works ───── */}
      <section id="how" className="steps">
        <div className="wrap">
          <div className="section-head">
            <span className="kicker">How it works</span>
            <h2>Sign in. Spin up a fleet. Stay on top.</h2>
          </div>
          <div className="steps-grid">
            <div className="step">
              <div className="num">STEP 01</div>
              <h4>Connect your repos.</h4>
              <p>
                Sign in from any device and point Vibedeckx at your repos and run
                environments — local, a GPU box, a remote VPS. Each agent works in its
                own isolated worktree.
              </p>
              <div className="stub">
                <span className="dollar">$</span> vibedeckx add
                ~/code/orchestrator-core
              </div>
            </div>
            <div className="step">
              <div className="num">STEP 02</div>
              <h4>Spawn a fleet.</h4>
              <p>
                Open a workspace per task, pick a model, and hit go. Agents run in
                parallel and in isolation — install dependencies, run tests, mutate the
                lockfile freely.
              </p>
              <div className="stub">
                <span className="dollar">$</span> vibedeckx run
                feat/parallel-streams --model sonnet-4.5
              </div>
            </div>
            <div className="step">
              <div className="num">STEP 03</div>
              <h4>Stay on top &amp; ship.</h4>
              <p>
                Watch live status, get pinged the moment an agent finishes, then review
                the diff, approve, and push. Rejected hunks roll back without a stash.
              </p>
              <div className="stub">
                <span className="dollar">$</span> vibedeckx review ·{" "}
                <span style={{ color: "var(--vdx-green)" }}>accept</span> 12 hunks ·
                push
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ───── Pricing ───── */}
      {/* TODO: re-enable Pricing once billing plans are finalized
      <section id="pricing" className="pricing">
        <div className="wrap">
          <div className="section-head">
            <span className="kicker">Pricing</span>
            <h2>Bring your own keys. Pay for the surface.</h2>
            <p>
              Cloud-hosted, or self-host for free. Vibedeckx never marks up model usage
              — you pay Anthropic and OpenAI directly and we just charge for the
              control surface.
            </p>
          </div>
          <div className="price-grid">
            <div className="price">
              <h4>Solo</h4>
              <div className="amount">
                <span className="num">$0</span>
                <span className="per">/ forever</span>
              </div>
              <p className="blurb">
                Self-host or run locally. For solo devs and weekend hackers.
              </p>
              <ul>
                <li>Unlimited self-hosted sessions</li>
                <li>Up to 4 parallel agents</li>
                <li>Bring your own API keys</li>
                <li>Community support</li>
              </ul>
              <button onClick={onSignIn} className="btn cta">
                Self-host free
              </button>
            </div>
            <div className="price featured">
              <h4>Pro</h4>
              <div className="amount">
                <span className="num">$20</span>
                <span className="per">/ user / mo</span>
              </div>
              <p className="blurb">
                Cloud-hosted. For builders driving a fleet across environments.
              </p>
              <ul>
                <li>Everything in Solo</li>
                <li>Unlimited parallel agents</li>
                <li>Cloud access from any device</li>
                <li>Multi-environment runs &amp; alerts</li>
                <li>Approval policies &amp; cost analytics</li>
              </ul>
              <button onClick={onSignIn} className="btn cta">
                Start 14-day trial
              </button>
            </div>
            <div className="price">
              <h4>Team</h4>
              <div className="amount">
                <span className="num">$60</span>
                <span className="per">/ seat / mo</span>
              </div>
              <p className="blurb">
                Shared review queues, audit logs, and SSO for teams &gt; 3.
              </p>
              <ul>
                <li>Everything in Pro</li>
                <li>Shared session queue</li>
                <li>SSO (SAML, OIDC)</li>
                <li>Audit log &amp; SOC 2</li>
                <li>Priority support</li>
              </ul>
              <a href="mailto:hello@vibedeckx.dev" className="btn cta">
                Talk to sales
              </a>
            </div>
          </div>
        </div>
      </section>
      */}

      {/* ───── FAQ ───── */}
      <section className="faq">
        <div className="wrap">
          <div className="section-head">
            <span className="kicker">FAQ</span>
            <h2>The honest answers.</h2>
          </div>
          <div className="faq-list">
            <details className="faq-item" open>
              <summary>Cloud-hosted or self-hosted?</summary>
              <div className="body">
                Both. Vibedeckx runs as a hosted service so you can sign in and command
                your agents from any device — or self-host it on your own machines if
                you'd rather keep everything in-house. Either way, model traffic goes
                straight to your chosen provider with your own keys.
              </div>
            </details>
            <details className="faq-item">
              <summary>Which models are supported?</summary>
              <div className="body">
                Anthropic (Claude 3.5/4/4.5), OpenAI (Codex, GPT-4 family), any
                OpenAI-compatible endpoint, and local <code>llama.cpp</code> /{" "}
                <code>ollama</code>. Switch per session.
              </div>
            </details>
            <details className="faq-item">
              <summary>How are worktrees isolated?</summary>
              <div className="body">
                We use git's native worktree feature to check each branch out into{" "}
                <code>~/.vibedeckx/work/&lt;project&gt;/&lt;branch&gt;</code>. Agents
                only see their own copy — their <code>node_modules</code>, their
                venv, their build artifacts. Nothing leaks back to your editor's
                checkout.
              </div>
            </details>
            <details className="faq-item">
              <summary>What about approval policies?</summary>
              <div className="body">
                Per-project rules in <code>.vibedeckx/policy.yaml</code>. Match
                commands by regex, declare what auto-approves, what asks, what's
                banned. Defaults block <code>rm -rf</code>, force pushes, and
                anything outside the worktree.
              </div>
            </details>
            <details className="faq-item">
              <summary>Linux? Windows? Mobile?</summary>
              <div className="body">
                Use the hosted app from any modern browser. To self-host, macOS and
                Linux today via <code>npm install -g vibedeckx</code>; Windows via WSL
                works but isn't officially supported yet. A native mobile app is on the
                way.
              </div>
            </details>
          </div>
        </div>
      </section>

      {/* ───── CTA banner ───── */}
      <section className="wrap">
        <div className="cta-banner">
          <h2>
            Stop juggling tabs. <em>Take&nbsp;command.</em>
          </h2>
          <div className="row">
            <button onClick={onSignIn} className="btn btn-lg btn-light">
              Enter the cockpit
            </button>
            <a
              href="https://github.com/vibedeckx-dev/vibedeckx"
              target="_blank"
              rel="noopener noreferrer"
              className="btn btn-lg btn-dark"
            >
              Read the docs
            </a>
          </div>
        </div>
      </section>

      {/* ───── Footer ───── */}
      <footer>
        <div className="wrap">
          <div className="foot-grid">
            <div>
              <a
                href="#"
                className="brand"
                onClick={(e) => e.preventDefault()}
                style={{ marginBottom: 12 }}
              >
                <Logo size={24} />
                <span>vibedeckx</span>
              </a>
              <div className="foot-brand" style={{ marginTop: 10 }}>
                Mission control for your coding agents.
              </div>
            </div>
            <div className="foot-col">
              <h5>Product</h5>
              <ul>
                <li>
                  <button onClick={onSignIn}>Download</button>
                </li>
                <li>
                  <a
                    href="https://github.com/vibedeckx-dev/vibedeckx/releases"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Changelog
                  </a>
                </li>
                <li>
                  <a href="#features">Features</a>
                </li>
                {/* TODO: re-enable once Pricing section is live
                <li>
                  <a href="#pricing">Pricing</a>
                </li>
                */}
              </ul>
            </div>
            <div className="foot-col">
              <h5>Developers</h5>
              <ul>
                <li>
                  <a
                    href="https://github.com/vibedeckx-dev/vibedeckx"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Source
                  </a>
                </li>
                <li>
                  <a
                    href="https://github.com/vibedeckx-dev/vibedeckx#readme"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Docs
                  </a>
                </li>
                <li>
                  <a href="#how">CLI reference</a>
                </li>
                <li>
                  <a href="#features">Policy DSL</a>
                </li>
              </ul>
            </div>
            <div className="foot-col">
              <h5>Company</h5>
              <ul>
                <li>
                  <a href="#">About</a>
                </li>
                <li>
                  <a href="#">Blog</a>
                </li>
                <li>
                  <a href="mailto:hello@vibedeckx.dev">Contact</a>
                </li>
              </ul>
            </div>
            <div className="foot-col">
              <h5>Legal</h5>
              <ul>
                <li>
                  <a href="#">Privacy</a>
                </li>
                <li>
                  <a href="#">Terms</a>
                </li>
                <li>
                  <a href="#">Security</a>
                </li>
              </ul>
            </div>
          </div>
          <div className="foot-bottom">
            <span>© 2026 vibedeckx</span>
            <span className="status">
              <span className="sdot" />
              All systems normal · v0.1.6
            </span>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Styles — Stripe/Vercel-minimal, light, indigo accent                       */
/* Adapted from Claude Design handoff: Inter + JetBrains Mono, oklch palette  */
/* -------------------------------------------------------------------------- */

const vdxStyles = `
  .vdx-lp {
    /* Scoped design tokens — avoid clashing with the app shell */
    --vdx-bg: oklch(0.99 0.003 250);
    --vdx-bg-2: oklch(0.975 0.004 250);
    --vdx-surface: oklch(1 0 0);
    --vdx-surface-2: oklch(0.985 0.003 250);
    --vdx-surface-hover: oklch(0.97 0.004 250);

    --vdx-fg: oklch(0.18 0.014 260);
    --vdx-fg-2: oklch(0.32 0.012 260);
    --vdx-fg-muted: oklch(0.52 0.012 260);
    --vdx-fg-subtle: oklch(0.66 0.010 260);

    --vdx-line: oklch(0.92 0.005 260);
    --vdx-line-2: oklch(0.945 0.004 260);
    --vdx-line-strong: oklch(0.86 0.006 260);

    --vdx-accent: oklch(0.52 0.18 268);
    --vdx-accent-hover: oklch(0.46 0.19 268);
    --vdx-accent-tint: oklch(0.96 0.025 268);
    --vdx-accent-tint-2: oklch(0.93 0.04 268);

    --vdx-green: oklch(0.62 0.14 152);
    --vdx-green-tint: oklch(0.95 0.04 152);
    --vdx-amber: oklch(0.72 0.14 75);
    --vdx-amber-tint: oklch(0.96 0.05 80);
    --vdx-rose: oklch(0.6 0.19 22);
    --vdx-rose-tint: oklch(0.96 0.04 22);

    --vdx-shadow-sm: 0 1px 2px oklch(0.2 0.02 260 / 0.04), 0 0 0 1px oklch(0.2 0.02 260 / 0.04);
    --vdx-shadow-md: 0 4px 12px oklch(0.2 0.02 260 / 0.06), 0 1px 2px oklch(0.2 0.02 260 / 0.04);
    --vdx-shadow-xl: 0 40px 80px -20px oklch(0.2 0.04 260 / 0.20), 0 12px 24px -8px oklch(0.2 0.02 260 / 0.08);

    font-family: var(--font-inter), ui-sans-serif, system-ui, sans-serif;
    font-feature-settings: 'cv11', 'ss01', 'ss03';
    background: var(--vdx-bg);
    color: var(--vdx-fg);
    -webkit-font-smoothing: antialiased;
    -moz-osx-font-smoothing: grayscale;
    font-size: 14px;
    line-height: 1.5;
    letter-spacing: -0.005em;
    min-height: 100vh;
  }
  .vdx-lp *, .vdx-lp *::before, .vdx-lp *::after { box-sizing: border-box; }
  .vdx-lp a { color: inherit; text-decoration: none; }
  .vdx-lp button {
    font-family: inherit; cursor: pointer; border: none; background: none;
    padding: 0; color: inherit;
  }
  .vdx-lp .mono {
    font-family: var(--font-jetbrains-mono), ui-monospace, monospace;
    font-feature-settings: 'ss01', 'cv02';
  }

  /* Layout */
  .vdx-lp .wrap { max-width: 1200px; margin: 0 auto; padding: 0 28px; }
  .vdx-lp section { position: relative; }

  /* Nav */
  .vdx-lp .nav {
    position: sticky; top: 0; z-index: 50;
    background: oklch(0.99 0.003 250 / 0.85);
    backdrop-filter: saturate(160%) blur(10px);
    -webkit-backdrop-filter: saturate(160%) blur(10px);
    border-bottom: 1px solid var(--vdx-line);
  }
  .vdx-lp .nav-inner {
    display: flex; align-items: center; gap: 28px;
    height: 56px;
  }
  .vdx-lp .brand {
    display: inline-flex; align-items: center; gap: 9px;
    font-weight: 600; font-size: 14px; letter-spacing: -0.01em;
    color: var(--vdx-fg);
  }
  .vdx-lp .brand-mark {
    width: 24px; height: 24px;
    border-radius: 6px;
    background: var(--vdx-fg);
    color: var(--vdx-bg);
    display: grid; place-items: center;
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11px;
    font-weight: 700;
    flex-shrink: 0;
  }
  .vdx-lp .brand-x { color: var(--vdx-accent); }
  .vdx-lp .nav-links { display: flex; align-items: center; gap: 22px; margin-left: 12px; }
  .vdx-lp .nav-links a {
    font-size: 13px; color: var(--vdx-fg-2); font-weight: 450;
    transition: color 0.15s;
  }
  .vdx-lp .nav-links a:hover { color: var(--vdx-fg); }
  .vdx-lp .nav-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }

  .vdx-lp .btn {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 6px 12px;
    border: 1px solid var(--vdx-line);
    border-radius: 7px;
    background: var(--vdx-surface);
    color: var(--vdx-fg-2);
    font-size: 13px; font-weight: 500;
    line-height: 1.4;
    font-family: inherit;
    transition: background 0.15s, border-color 0.15s, color 0.15s;
  }
  .vdx-lp .btn:hover { background: var(--vdx-surface-hover); border-color: var(--vdx-line-strong); color: var(--vdx-fg); }
  .vdx-lp .btn-ghost { border-color: transparent; background: transparent; }
  .vdx-lp .btn-ghost:hover { background: var(--vdx-surface-hover); border-color: transparent; }
  .vdx-lp .btn-primary {
    background: var(--vdx-fg); border-color: var(--vdx-fg); color: var(--vdx-bg);
  }
  .vdx-lp .btn-primary:hover {
    background: oklch(0.28 0.014 260); border-color: oklch(0.28 0.014 260); color: var(--vdx-bg);
  }
  .vdx-lp .btn-lg { padding: 9px 16px; font-size: 13.5px; border-radius: 8px; }
  .vdx-lp .btn .kbd { font-family: var(--font-jetbrains-mono), monospace; font-size: 10.5px; opacity: 0.7; }

  .vdx-lp .kbd {
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 10.5px;
    color: var(--vdx-fg-muted);
    padding: 1px 5px;
    border: 1px solid var(--vdx-line);
    border-bottom-width: 2px;
    border-radius: 4px;
    background: var(--vdx-surface-2);
    line-height: 1.4;
  }

  /* Eyebrow pill */
  .vdx-lp .eyebrow {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 3px 9px 3px 7px;
    border: 1px solid var(--vdx-line);
    border-radius: 999px;
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11px;
    color: var(--vdx-fg-2);
    background: var(--vdx-surface);
    box-shadow: var(--vdx-shadow-sm);
  }
  .vdx-lp .eyebrow .dot {
    width: 6px; height: 6px; border-radius: 999px;
    background: var(--vdx-green); position: relative;
  }
  .vdx-lp .eyebrow .dot::after {
    content: ''; position: absolute; inset: -2px;
    border-radius: 999px; background: var(--vdx-green); opacity: 0.45;
    animation: vdx-pulse 1.8s ease-out infinite;
  }
  @keyframes vdx-pulse {
    0% { transform: scale(1); opacity: 0.45; }
    100% { transform: scale(2.4); opacity: 0; }
  }

  /* Hero */
  .vdx-lp .hero { padding: 80px 0 28px; position: relative; overflow: hidden; }
  .vdx-lp .hero::before {
    content: '';
    position: absolute; inset: 0;
    background-image:
      linear-gradient(to right, oklch(0.18 0.014 260 / 0.04) 1px, transparent 1px),
      linear-gradient(to bottom, oklch(0.18 0.014 260 / 0.04) 1px, transparent 1px);
    background-size: 56px 56px;
    mask-image: radial-gradient(ellipse 80% 60% at 50% 0%, black 30%, transparent 75%);
    -webkit-mask-image: radial-gradient(ellipse 80% 60% at 50% 0%, black 30%, transparent 75%);
    pointer-events: none;
  }
  .vdx-lp .hero-inner { position: relative; text-align: center; }
  .vdx-lp .hero h1 {
    font-size: clamp(40px, 6vw, 68px);
    line-height: 1.02;
    letter-spacing: -0.035em;
    font-weight: 600;
    margin: 18px auto 0;
    max-width: 880px;
    color: var(--vdx-fg);
    text-wrap: balance;
  }
  .vdx-lp .hero h1 em {
    font-style: normal;
    font-family: var(--font-jetbrains-mono), monospace;
    font-weight: 500;
    font-size: 0.82em;
    color: var(--vdx-accent);
    letter-spacing: -0.02em;
    background: var(--vdx-accent-tint);
    padding: 0.05em 0.18em;
    border-radius: 8px;
    vertical-align: 0.04em;
  }
  .vdx-lp .hero p.lede {
    font-size: 17px;
    color: var(--vdx-fg-muted);
    max-width: 600px;
    margin: 20px auto 0;
    text-wrap: pretty;
    line-height: 1.55;
  }
  .vdx-lp .hero-cta { display: flex; justify-content: center; gap: 10px; margin-top: 28px; flex-wrap: wrap; }

  .vdx-lp .install {
    margin: 18px auto 0;
    display: inline-flex; align-items: center; gap: 10px;
    padding: 6px 10px 6px 12px;
    border: 1px solid var(--vdx-line);
    border-radius: 8px;
    background: var(--vdx-surface);
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 12px;
    color: var(--vdx-fg-2);
    box-shadow: var(--vdx-shadow-sm);
  }
  .vdx-lp .install .dollar { color: var(--vdx-fg-subtle); }
  .vdx-lp .install .copy {
    width: 22px; height: 22px; border-radius: 5px;
    display: grid; place-items: center;
    color: var(--vdx-fg-muted);
    transition: background 0.15s, color 0.15s;
  }
  .vdx-lp .install .copy:hover { background: var(--vdx-surface-hover); color: var(--vdx-fg); }

  /* Product preview */
  .vdx-lp .preview-wrap { margin-top: 56px; padding: 0 0 4px; position: relative; }
  .vdx-lp .preview-frame {
    max-width: 1180px;
    margin: 0 auto;
    border: 1px solid var(--vdx-line-strong);
    border-radius: 14px;
    background: var(--vdx-bg);
    overflow: hidden;
    box-shadow: var(--vdx-shadow-xl);
    position: relative;
  }
  .vdx-lp .preview-chrome {
    display: flex; align-items: center; gap: 10px;
    padding: 9px 14px;
    border-bottom: 1px solid var(--vdx-line);
    background: var(--vdx-surface-2);
  }
  .vdx-lp .traffic { display: flex; gap: 6px; }
  .vdx-lp .traffic span {
    width: 10px; height: 10px; border-radius: 999px;
    background: var(--vdx-line-strong);
  }
  .vdx-lp .preview-url {
    flex: 1;
    display: flex; align-items: center; gap: 8px;
    justify-content: center;
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11.5px;
    color: var(--vdx-fg-muted);
  }
  .vdx-lp .preview-url .lock { width: 11px; height: 11px; }

  .vdx-lp .mini-app {
    display: grid;
    grid-template-columns: 180px 1fr;
    grid-template-rows: 38px 1fr;
    height: 540px;
    background: var(--vdx-bg);
  }
  .vdx-lp .mini-topbar {
    grid-column: 1 / -1;
    display: flex; align-items: center; gap: 14px;
    padding: 0 14px 0 12px;
    border-bottom: 1px solid var(--vdx-line);
    background: var(--vdx-surface);
    font-size: 12px;
  }
  .vdx-lp .mini-topbar .crumb {
    font-family: var(--font-jetbrains-mono), monospace;
    color: var(--vdx-fg-muted);
    font-size: 11.5px;
  }
  .vdx-lp .mini-topbar .crumb b { color: var(--vdx-fg); font-weight: 500; }
  .vdx-lp .mini-topbar .right { margin-left: auto; display: flex; gap: 6px; align-items: center; }
  .vdx-lp .mini-search {
    display: flex; align-items: center; gap: 8px;
    padding: 3px 8px 3px 10px;
    border: 1px solid var(--vdx-line);
    border-radius: 7px;
    background: var(--vdx-surface-2);
    color: var(--vdx-fg-muted);
    font-size: 11.5px;
    min-width: 180px;
  }
  .vdx-lp .mini-search .kbd { margin-left: auto; }

  .vdx-lp .mini-sidebar {
    background: var(--vdx-bg-2);
    border-right: 1px solid var(--vdx-line);
    padding: 12px 8px;
    overflow: hidden;
    font-size: 12px;
  }
  .vdx-lp .mini-section-label {
    padding: 4px 8px;
    font-size: 9.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vdx-fg-subtle);
  }
  .vdx-lp .mini-nav-item {
    display: flex; align-items: center; gap: 8px;
    padding: 5px 8px;
    border-radius: 6px;
    color: var(--vdx-fg-2);
    font-size: 12px;
  }
  .vdx-lp .mini-nav-item.active {
    background: var(--vdx-surface);
    box-shadow: var(--vdx-shadow-sm);
    color: var(--vdx-fg);
    font-weight: 500;
    position: relative;
  }
  .vdx-lp .mini-nav-item.active::before {
    content: ''; position: absolute; left: -8px; top: 6px; bottom: 6px;
    width: 2px; background: var(--vdx-accent); border-radius: 999px;
  }
  .vdx-lp .mini-nav-item .count { margin-left: auto; font-family: var(--font-jetbrains-mono), monospace; font-size: 10px; color: var(--vdx-fg-subtle); }
  .vdx-lp .branch-row {
    display: flex; align-items: center; gap: 7px;
    padding: 3px 8px 3px 22px;
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11px;
    color: var(--vdx-fg-2);
    border-radius: 5px;
  }
  .vdx-lp .branch-row.active { background: var(--vdx-accent-tint); color: var(--vdx-accent); }
  .vdx-lp .bdot { width: 6px; height: 6px; border-radius: 999px; background: var(--vdx-fg-subtle); flex-shrink: 0; }
  .vdx-lp .bdot.green { background: var(--vdx-green); }
  .vdx-lp .bdot.amber { background: var(--vdx-amber); }
  .vdx-lp .bdot.rose  { background: var(--vdx-rose); }
  .vdx-lp .tree-project {
    display: flex; align-items: center; gap: 6px;
    padding: 6px 8px 2px;
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 10.5px;
    color: var(--vdx-fg-muted);
  }

  .vdx-lp .mini-main { overflow: hidden; display: flex; flex-direction: column; }
  .vdx-lp .mini-page-head {
    display: flex; align-items: center; justify-content: space-between;
    padding: 12px 16px 10px;
    border-bottom: 1px solid var(--vdx-line);
  }
  .vdx-lp .mini-page-head h2 {
    margin: 0; font-size: 15px; font-weight: 600;
    letter-spacing: -0.015em;
    display: flex; align-items: baseline; gap: 8px;
  }
  .vdx-lp .mini-page-head h2 .count {
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11px; color: var(--vdx-fg-subtle); font-weight: 500;
  }
  .vdx-lp .mini-filter {
    display: flex; gap: 4px; padding: 7px 16px;
    border-bottom: 1px solid var(--vdx-line);
    font-size: 11.5px;
  }
  .vdx-lp .mini-chip {
    padding: 2px 8px; border-radius: 999px;
    color: var(--vdx-fg-muted);
    border: 1px solid transparent;
  }
  .vdx-lp .mini-chip.active {
    background: var(--vdx-surface);
    border-color: var(--vdx-line);
    color: var(--vdx-fg);
    font-weight: 500;
    box-shadow: var(--vdx-shadow-sm);
  }
  .vdx-lp .mini-chip .count { font-family: var(--font-jetbrains-mono), monospace; font-size: 10px; color: var(--vdx-fg-subtle); margin-left: 3px; }

  .vdx-lp .mini-grid {
    flex: 1;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 12px;
    padding: 14px 16px;
    overflow: hidden;
  }
  .vdx-lp .mini-card {
    background: var(--vdx-surface);
    border: 1px solid var(--vdx-line);
    border-radius: 9px;
    display: flex; flex-direction: column;
    overflow: hidden;
  }
  .vdx-lp .mini-card.working { border-color: oklch(from var(--vdx-green) l c h / 0.4); }
  .vdx-lp .mini-card.review { border-color: oklch(from var(--vdx-amber) l c h / 0.45); }
  .vdx-lp .mini-card-head {
    padding: 9px 11px 7px;
    border-bottom: 1px solid var(--vdx-line-2);
    display: flex; align-items: center; gap: 7px;
  }
  .vdx-lp .mini-card-head .meta { display: flex; flex-direction: column; gap: 1px; min-width: 0; flex: 1; }
  .vdx-lp .mini-card-head .project { font-family: var(--font-jetbrains-mono), monospace; font-size: 10px; color: var(--vdx-fg-muted); }
  .vdx-lp .mini-card-head .branch { font-family: var(--font-jetbrains-mono), monospace; font-size: 11px; color: var(--vdx-fg); font-weight: 500; }
  .vdx-lp .mini-host {
    font-family: var(--font-jetbrains-mono), monospace; font-size: 9.5px; color: var(--vdx-fg-subtle);
    padding: 1px 5px; background: var(--vdx-surface-2); border-radius: 4px;
  }
  .vdx-lp .mini-card-body {
    padding: 9px 11px; flex: 1;
    display: flex; flex-direction: column; gap: 8px;
  }
  .vdx-lp .mini-task {
    font-size: 11.5px;
    color: var(--vdx-fg-2);
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .vdx-lp .mini-tools { display: flex; gap: 3px; flex-wrap: wrap; }
  .vdx-lp .mini-tool {
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 9.5px;
    padding: 1px 5px;
    background: var(--vdx-surface-2);
    border: 1px solid var(--vdx-line);
    border-radius: 4px;
    color: var(--vdx-fg-2);
  }
  .vdx-lp .mini-card-foot {
    padding: 7px 11px;
    border-top: 1px solid var(--vdx-line-2);
    background: var(--vdx-surface-2);
    display: flex; align-items: center; gap: 10px;
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 9.5px;
    color: var(--vdx-fg-muted);
  }
  .vdx-lp .mini-card-foot .add { color: var(--vdx-green); }
  .vdx-lp .mini-card-foot .del { color: var(--vdx-rose); }
  .vdx-lp .mini-card-foot .grow { flex: 1; }

  /* Floating annotations */
  .vdx-lp .annot {
    position: absolute;
    display: flex; align-items: center; gap: 8px;
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11px;
    color: var(--vdx-fg);
    background: var(--vdx-surface);
    border: 1px solid var(--vdx-line);
    padding: 5px 9px 5px 8px;
    border-radius: 7px;
    box-shadow: var(--vdx-shadow-md);
    white-space: nowrap;
  }
  .vdx-lp .annot .badge {
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 10px;
    color: var(--vdx-accent);
    background: var(--vdx-accent-tint);
    padding: 1px 5px;
    border-radius: 4px;
    font-weight: 600;
  }
  .vdx-lp .annot.a1 { top: 88px; left: -10px; }
  .vdx-lp .annot.a2 { top: 220px; right: -8px; }
  .vdx-lp .annot.a3 { bottom: 56px; left: 100px; }

  /* Logos */
  .vdx-lp .logos { padding: 60px 0 20px; text-align: center; }
  .vdx-lp .logos-label {
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11.5px;
    color: var(--vdx-fg-muted);
    letter-spacing: 0.04em;
  }
  .vdx-lp .logos-row {
    margin-top: 22px;
    display: flex; flex-wrap: wrap; align-items: center; justify-content: center;
    gap: 36px 56px;
    opacity: 0.78;
  }
  .vdx-lp .logo-mark {
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 14px;
    letter-spacing: -0.02em;
    font-weight: 600;
    color: var(--vdx-fg-2);
    display: inline-flex; align-items: center; gap: 7px;
  }
  .vdx-lp .logo-mark .glyph {
    width: 14px; height: 14px;
    border: 1.5px solid var(--vdx-fg-2);
    border-radius: 3px;
  }
  .vdx-lp .logo-mark .glyph.round { border-radius: 999px; }
  .vdx-lp .logo-mark .glyph.solid { background: var(--vdx-fg-2); border-color: var(--vdx-fg-2); }
  .vdx-lp .logo-mark .glyph.tri {
    width: 0; height: 0; border: none;
    border-left: 7px solid transparent;
    border-right: 7px solid transparent;
    border-bottom: 12px solid var(--vdx-fg-2);
    border-radius: 0;
  }

  /* Section head */
  .vdx-lp .section-head {
    display: flex; flex-direction: column; gap: 14px;
    max-width: 720px;
    margin: 0 auto 48px;
    text-align: center;
    align-items: center;
  }
  .vdx-lp .section-head h2 {
    margin: 0;
    font-size: clamp(28px, 3.6vw, 42px);
    letter-spacing: -0.028em;
    font-weight: 600;
    line-height: 1.08;
    text-wrap: balance;
    color: var(--vdx-fg);
  }
  .vdx-lp .section-head p {
    margin: 0;
    color: var(--vdx-fg-muted);
    font-size: 15.5px;
    line-height: 1.55;
    text-wrap: pretty;
    max-width: 560px;
  }
  .vdx-lp .kicker {
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11.5px;
    color: var(--vdx-accent);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }

  /* The commander */
  .vdx-lp .commander { padding: 96px 0 24px; position: relative; }
  .vdx-lp .commander .section-head { margin-bottom: 42px; }
  .vdx-lp .commander .section-head h2 em {
    font-style: normal;
    font-family: var(--font-jetbrains-mono), monospace;
    font-weight: 500;
    font-size: 0.86em;
    color: var(--vdx-accent);
    letter-spacing: -0.02em;
  }

  .vdx-lp .cmd-deck {
    max-width: 720px;
    margin: 0 auto;
    border: 1px solid var(--vdx-line-strong);
    border-radius: 14px;
    background: var(--vdx-surface);
    box-shadow: var(--vdx-shadow-xl);
    overflow: hidden;
  }
  .vdx-lp .cmd-deck-head {
    display: flex; align-items: center; gap: 9px;
    padding: 10px 14px;
    border-bottom: 1px solid var(--vdx-line);
    background: var(--vdx-surface-2);
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11.5px;
    color: var(--vdx-fg-muted);
  }
  .vdx-lp .cmd-deck-head .star { color: var(--vdx-accent); font-weight: 600; }
  .vdx-lp .cmd-deck-head .right {
    margin-left: auto; display: inline-flex; align-items: center; gap: 6px;
    color: var(--vdx-green); font-size: 11px;
  }

  .vdx-lp .cmd-body { padding: 16px; display: flex; flex-direction: column; gap: 14px; }

  /* goal bubble */
  .vdx-lp .cmd-goal { display: flex; gap: 10px; align-items: flex-start; }
  .vdx-lp .cmd-goal .who {
    flex-shrink: 0;
    width: 26px; height: 26px; border-radius: 7px;
    background: var(--vdx-fg); color: var(--vdx-bg);
    display: grid; place-items: center;
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 8.5px; font-weight: 700; letter-spacing: 0.02em;
  }
  .vdx-lp .cmd-goal .msg {
    background: var(--vdx-bg-2);
    border: 1px solid var(--vdx-line);
    border-radius: 9px;
    padding: 9px 12px;
    font-size: 13.5px;
    color: var(--vdx-fg);
    line-height: 1.5;
  }
  .vdx-lp .cmd-goal .msg b { font-weight: 600; }

  /* plan */
  .vdx-lp .cmd-plan {
    border: 1px solid var(--vdx-line);
    border-radius: 10px;
    overflow: hidden;
    background: var(--vdx-surface);
  }
  .vdx-lp .cmd-plan-head {
    display: flex; align-items: center; gap: 8px;
    padding: 9px 12px;
    border-bottom: 1px solid var(--vdx-line-2);
    background: var(--vdx-bg-2);
    font-size: 10.5px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--vdx-fg-muted);
  }
  .vdx-lp .cmd-plan-head .count {
    margin-left: auto;
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 10px; letter-spacing: 0; text-transform: none;
    color: var(--vdx-fg-subtle);
  }
  .vdx-lp .cmd-step {
    display: flex; align-items: center; gap: 11px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--vdx-line-2);
    font-size: 12.5px;
    color: var(--vdx-fg-2);
  }
  .vdx-lp .cmd-step:last-child { border-bottom: none; }
  .vdx-lp .cmd-step .ck {
    width: 16px; height: 16px; border-radius: 999px; flex-shrink: 0;
    border: 1.5px solid var(--vdx-line-strong);
    display: grid; place-items: center;
    font-size: 9px; line-height: 1; color: transparent;
    align-self: flex-start; margin-top: 1px;
  }
  .vdx-lp .cmd-step .txt { flex: 1; line-height: 1.45; }
  .vdx-lp .cmd-step .txt code {
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11px; background: var(--vdx-surface-2);
    padding: 0 4px; border-radius: 4px; border: 1px solid var(--vdx-line-2);
  }
  .vdx-lp .cmd-step .txt .del { color: var(--vdx-rose); font-family: var(--font-jetbrains-mono), monospace; font-size: 10.5px; margin-left: 4px; }
  .vdx-lp .cmd-step .who-pill {
    flex-shrink: 0;
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 9.5px;
    padding: 2px 6px; border-radius: 5px;
    background: var(--vdx-surface-2);
    border: 1px solid var(--vdx-line);
    color: var(--vdx-fg-muted);
  }
  .vdx-lp .cmd-step .who-pill.green { background: var(--vdx-green-tint); border-color: transparent; color: var(--vdx-green); }

  .vdx-lp .cmd-step.done .ck { background: var(--vdx-green); border-color: var(--vdx-green); color: #fff; }
  .vdx-lp .cmd-step.done .txt { color: var(--vdx-fg-muted); text-decoration: line-through; text-decoration-color: var(--vdx-line-strong); }
  .vdx-lp .cmd-step.work .ck { border-color: var(--vdx-green); position: relative; }
  .vdx-lp .cmd-step.work .ck::after {
    content: ''; position: absolute; inset: 2.5px; border-radius: 999px;
    background: var(--vdx-green); animation: vdx-blink 1.3s steps(1) infinite;
  }
  .vdx-lp .cmd-step.ask {
    background: var(--vdx-amber-tint);
    border-color: transparent;
  }
  .vdx-lp .cmd-step.ask .ck {
    background: var(--vdx-amber); border-color: var(--vdx-amber);
    color: oklch(0.25 0.04 75); font-weight: 700;
  }
  .vdx-lp .cmd-step.ask .txt { color: var(--vdx-fg); }
  .vdx-lp .cmd-step .ask-row {
    display: flex; align-items: center; gap: 7px; margin-top: 8px;
  }
  .vdx-lp .cmd-step .ask-label {
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
    color: oklch(from var(--vdx-amber) 0.42 c h);
    margin-right: auto;
  }
  .vdx-lp .cmd-step .btn.cmd-approve {
    padding: 3px 10px; font-size: 11px;
    background: var(--vdx-fg); border-color: var(--vdx-fg); color: var(--vdx-bg);
  }
  .vdx-lp .cmd-step .btn.cmd-deny {
    padding: 3px 10px; font-size: 11px;
    background: transparent; border-color: transparent;
    color: oklch(from var(--vdx-amber) 0.42 c h);
  }
  .vdx-lp .cmd-step.queued .txt { color: var(--vdx-fg-muted); }

  /* three promises */
  .vdx-lp .cmd-promises {
    max-width: 720px; margin: 26px auto 0;
    display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px;
  }
  .vdx-lp .cmd-promise {
    border: 1px solid var(--vdx-line);
    border-radius: 11px;
    background: var(--vdx-surface);
    padding: 18px 16px 16px;
  }
  .vdx-lp .cmd-promise .n {
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11px; font-weight: 600;
    color: var(--vdx-accent);
    background: var(--vdx-accent-tint);
    padding: 2px 6px; border-radius: 5px;
  }
  .vdx-lp .cmd-promise h4 {
    margin: 12px 0 6px;
    font-size: 14.5px; font-weight: 600;
    letter-spacing: -0.012em; line-height: 1.25;
    color: var(--vdx-fg);
  }
  .vdx-lp .cmd-promise p {
    margin: 0; font-size: 12.5px; line-height: 1.5;
    color: var(--vdx-fg-muted); text-wrap: pretty;
  }
  @media (max-width: 760px) {
    .vdx-lp .cmd-promises { grid-template-columns: 1fr; }
  }

  /* Feature grid */
  .vdx-lp .features { padding: 100px 0 40px; }
  .vdx-lp .feature-grid {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 14px;
  }
  .vdx-lp .feature {
    border: 1px solid var(--vdx-line);
    border-radius: 12px;
    background: var(--vdx-surface);
    padding: 22px 22px 0;
    display: flex; flex-direction: column;
    gap: 8px;
    overflow: hidden;
    position: relative;
    min-height: 320px;
  }
  .vdx-lp .feature.f-wide { grid-column: span 4; }
  .vdx-lp .feature.f-half { grid-column: span 3; }
  .vdx-lp .feature.f-third { grid-column: span 2; }
  .vdx-lp .feature h3 {
    margin: 0;
    font-size: 17px;
    font-weight: 600;
    letter-spacing: -0.015em;
    color: var(--vdx-fg);
  }
  .vdx-lp .feature p {
    margin: 0;
    color: var(--vdx-fg-muted);
    font-size: 13.5px;
    line-height: 1.55;
    max-width: 460px;
    text-wrap: pretty;
  }

  /* Visual: branch graph */
  .vdx-lp .branch-graph {
    margin: 18px -22px -1px;
    padding: 18px 22px 22px;
    border-top: 1px solid var(--vdx-line-2);
    background: var(--vdx-bg-2);
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11.5px;
    color: var(--vdx-fg-2);
    display: flex; flex-direction: column; gap: 6px;
  }
  .vdx-lp .bg-row { display: flex; align-items: center; gap: 8px; }
  .vdx-lp .bg-row .gutter { width: 22px; display: inline-flex; justify-content: center; color: var(--vdx-fg-subtle); }
  .vdx-lp .bg-row .label { color: var(--vdx-fg); }
  .vdx-lp .bg-row .pill {
    font-size: 9.5px;
    padding: 1px 5px;
    border-radius: 4px;
    background: var(--vdx-surface);
    border: 1px solid var(--vdx-line);
    color: var(--vdx-fg-muted);
    margin-left: auto;
  }
  .vdx-lp .bg-row .pill.green { background: var(--vdx-green-tint); border-color: transparent; color: var(--vdx-green); }
  .vdx-lp .bg-row .pill.amber { background: var(--vdx-amber-tint); border-color: transparent; color: oklch(from var(--vdx-amber) 0.42 c h); }
  .vdx-lp .bg-row .pill.accent { background: var(--vdx-accent-tint); border-color: transparent; color: var(--vdx-accent); }
  .vdx-lp .bg-row .pill.rose { background: var(--vdx-rose-tint); border-color: transparent; color: var(--vdx-rose); }

  /* Visual: terminal */
  .vdx-lp .term {
    margin: 18px -22px -1px;
    padding: 14px 18px 16px;
    border-top: 1px solid var(--vdx-line-2);
    background: oklch(0.16 0.012 260);
    color: oklch(0.88 0.005 260);
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11.5px;
    line-height: 1.6;
  }
  .vdx-lp .term .p { color: oklch(0.72 0.14 268); }
  .vdx-lp .term .o { color: oklch(0.7 0.008 260); }
  .vdx-lp .term .ok { color: oklch(0.72 0.14 152); }
  .vdx-lp .term .er { color: oklch(0.72 0.18 22); }
  .vdx-lp .term .cursor {
    background: oklch(0.88 0.005 260);
    color: oklch(0.16 0.012 260);
    padding: 0 2px;
    animation: vdx-blink 1.1s steps(1) infinite;
  }
  @keyframes vdx-blink {
    50% { opacity: 0; }
  }

  /* Visual: diff */
  .vdx-lp .diff {
    margin: 18px -22px -1px;
    border-top: 1px solid var(--vdx-line-2);
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11px;
    line-height: 1.6;
    background: var(--vdx-surface);
  }
  .vdx-lp .diff .diff-head {
    display: flex; gap: 8px;
    padding: 7px 14px;
    background: var(--vdx-bg-2);
    border-bottom: 1px solid var(--vdx-line-2);
    color: var(--vdx-fg-2);
  }
  .vdx-lp .diff .diff-head .add { color: var(--vdx-green); }
  .vdx-lp .diff .diff-head .del { color: var(--vdx-rose); }
  .vdx-lp .diff .diff-row {
    display: grid; grid-template-columns: 28px 1fr;
    align-items: stretch;
  }
  .vdx-lp .diff .diff-row .ln { text-align: right; padding: 0 6px; color: var(--vdx-fg-subtle); font-size: 10px; background: var(--vdx-surface-2); border-right: 1px solid var(--vdx-line-2); }
  .vdx-lp .diff .diff-row .code { padding: 0 10px; white-space: pre; overflow: hidden; color: var(--vdx-fg-2); }
  .vdx-lp .diff .diff-row.add .code { background: oklch(from var(--vdx-green) l c h / 0.07); color: var(--vdx-fg); }
  .vdx-lp .diff .diff-row.add .ln   { background: oklch(from var(--vdx-green) l c h / 0.10); color: var(--vdx-green); }
  .vdx-lp .diff .diff-row.del .code { background: oklch(from var(--vdx-rose) l c h / 0.07); color: var(--vdx-fg); }
  .vdx-lp .diff .diff-row.del .ln   { background: oklch(from var(--vdx-rose) l c h / 0.10); color: var(--vdx-rose); }

  /* Visual: approval */
  .vdx-lp .approval {
    margin: 18px 0 22px;
    border: 1px solid var(--vdx-amber);
    background: var(--vdx-amber-tint);
    border-radius: 8px;
    padding: 11px 12px;
    font-size: 12px;
    color: var(--vdx-fg-2);
  }
  .vdx-lp .approval .h {
    font-weight: 600;
    color: oklch(from var(--vdx-amber) 0.4 c h);
    font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em;
    margin-bottom: 5px;
    display: flex; align-items: center; gap: 6px;
  }
  .vdx-lp .approval code {
    font-family: var(--font-jetbrains-mono), monospace;
    background: oklch(1 0 0 / 0.6);
    padding: 1px 5px;
    border-radius: 4px;
    font-size: 11px;
  }
  .vdx-lp .approval .acts { display: flex; gap: 6px; margin-top: 9px; }
  .vdx-lp .approval .acts .btn { padding: 4px 9px; font-size: 11.5px; }
  .vdx-lp .approval .acts .btn-deny { background: transparent; border-color: transparent; color: oklch(from var(--vdx-amber) 0.4 c h); }

  /* Visual: model picker */
  .vdx-lp .models { margin: 18px 0 22px; display: flex; flex-direction: column; gap: 6px; }
  .vdx-lp .model-row {
    display: flex; align-items: center; gap: 10px;
    padding: 8px 10px;
    border: 1px solid var(--vdx-line);
    border-radius: 8px;
    background: var(--vdx-surface);
    font-size: 12px;
  }
  .vdx-lp .model-row.active { border-color: var(--vdx-accent); box-shadow: 0 0 0 2px var(--vdx-accent-tint); }
  .vdx-lp .model-row .mark {
    width: 22px; height: 22px; border-radius: 5px;
    background: var(--vdx-surface-2); border: 1px solid var(--vdx-line);
    display: grid; place-items: center;
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 9.5px; font-weight: 600;
    color: var(--vdx-fg-2);
  }
  .vdx-lp .model-row .name { font-weight: 500; color: var(--vdx-fg); }
  .vdx-lp .model-row .desc { font-size: 10.5px; color: var(--vdx-fg-muted); font-family: var(--font-jetbrains-mono), monospace; margin-left: auto; }

  /* How it works */
  .vdx-lp .steps { padding: 80px 0; }
  .vdx-lp .steps-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
    margin-top: 8px;
  }
  .vdx-lp .step {
    padding: 26px 24px;
    border: 1px solid var(--vdx-line);
    border-radius: 12px;
    background: var(--vdx-surface);
    position: relative;
  }
  .vdx-lp .step .num {
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11px;
    color: var(--vdx-accent);
    letter-spacing: 0.04em;
    margin-bottom: 12px;
  }
  .vdx-lp .step h4 {
    margin: 0 0 6px;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: -0.012em;
    color: var(--vdx-fg);
  }
  .vdx-lp .step p {
    margin: 0;
    color: var(--vdx-fg-muted);
    font-size: 13.5px;
    line-height: 1.55;
    text-wrap: pretty;
  }
  .vdx-lp .step .stub {
    margin-top: 16px;
    padding: 9px 11px;
    border: 1px solid var(--vdx-line);
    border-radius: 7px;
    background: var(--vdx-bg-2);
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11.5px;
    color: var(--vdx-fg-2);
    display: flex; align-items: center; gap: 8px;
  }
  .vdx-lp .step .stub .dollar { color: var(--vdx-fg-subtle); }

  /* Pricing */
  .vdx-lp .pricing { padding: 80px 0; }
  .vdx-lp .price-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 14px;
  }
  .vdx-lp .price {
    padding: 26px 26px 22px;
    border: 1px solid var(--vdx-line);
    border-radius: 12px;
    background: var(--vdx-surface);
    display: flex; flex-direction: column;
  }
  .vdx-lp .price.featured {
    border-color: var(--vdx-fg);
    box-shadow: var(--vdx-shadow-md);
    position: relative;
  }
  .vdx-lp .price.featured::before {
    content: 'Recommended';
    position: absolute;
    top: -10px; left: 24px;
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    font-weight: 600;
    background: var(--vdx-fg); color: var(--vdx-bg);
    padding: 3px 8px;
    border-radius: 999px;
  }
  .vdx-lp .price h4 {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
    letter-spacing: -0.005em;
    color: var(--vdx-fg);
    font-family: var(--font-jetbrains-mono), monospace;
    text-transform: uppercase;
  }
  .vdx-lp .price .amount { margin-top: 12px; display: flex; align-items: baseline; gap: 5px; }
  .vdx-lp .price .amount .num {
    font-size: 38px;
    font-weight: 600;
    letter-spacing: -0.03em;
    line-height: 1;
    color: var(--vdx-fg);
  }
  .vdx-lp .price .amount .per { font-size: 13px; color: var(--vdx-fg-muted); }
  .vdx-lp .price .blurb {
    margin: 8px 0 18px;
    color: var(--vdx-fg-muted);
    font-size: 13px;
    line-height: 1.5;
    min-height: 38px;
  }
  .vdx-lp .price ul {
    list-style: none; padding: 0; margin: 0 0 22px;
    display: flex; flex-direction: column; gap: 7px;
    font-size: 13px;
    color: var(--vdx-fg-2);
  }
  .vdx-lp .price ul li {
    display: flex; gap: 9px; align-items: flex-start;
    line-height: 1.45;
  }
  .vdx-lp .price ul li::before {
    content: '';
    width: 14px; height: 14px;
    flex-shrink: 0;
    margin-top: 2px;
    background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='%23606b7a' stroke-width='1.6' stroke-linecap='round' stroke-linejoin='round'><polyline points='3.5,8.5 6.5,11.5 12.5,4.5'/></svg>");
    background-size: contain; background-repeat: no-repeat;
  }
  .vdx-lp .price .cta { margin-top: auto; justify-content: center; }
  .vdx-lp .price.featured .cta {
    background: var(--vdx-fg); color: var(--vdx-bg); border-color: var(--vdx-fg);
  }
  .vdx-lp .price.featured .cta:hover {
    background: oklch(0.28 0.014 260); border-color: oklch(0.28 0.014 260); color: var(--vdx-bg);
  }

  /* FAQ */
  .vdx-lp .faq { padding: 80px 0; }
  .vdx-lp .faq-list {
    max-width: 760px; margin: 0 auto;
    border-top: 1px solid var(--vdx-line);
  }
  .vdx-lp details.faq-item {
    border-bottom: 1px solid var(--vdx-line);
    padding: 16px 4px;
  }
  .vdx-lp details.faq-item summary {
    cursor: pointer;
    list-style: none;
    display: flex; align-items: center; justify-content: space-between;
    gap: 16px;
    font-size: 15px;
    font-weight: 500;
    letter-spacing: -0.012em;
    color: var(--vdx-fg);
  }
  .vdx-lp details.faq-item summary::-webkit-details-marker { display: none; }
  .vdx-lp details.faq-item summary::after {
    content: '+';
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 18px;
    color: var(--vdx-fg-muted);
    transition: transform 0.18s;
  }
  .vdx-lp details.faq-item[open] summary::after { content: '−'; }
  .vdx-lp details.faq-item .body {
    margin-top: 10px;
    color: var(--vdx-fg-muted);
    font-size: 13.5px;
    line-height: 1.6;
    max-width: 640px;
    text-wrap: pretty;
  }
  .vdx-lp details.faq-item .body code {
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 12px; background: var(--vdx-surface-2);
    padding: 0 5px; border-radius: 4px; border: 1px solid var(--vdx-line-2);
  }

  /* CTA banner */
  .vdx-lp .cta-banner {
    margin: 60px 0;
    padding: 60px 48px;
    background: var(--vdx-fg);
    color: var(--vdx-bg);
    border-radius: 16px;
    position: relative; overflow: hidden;
    display: flex; flex-direction: column; align-items: center;
    text-align: center;
    gap: 22px;
  }
  .vdx-lp .cta-banner::before {
    content: '';
    position: absolute; inset: 0;
    background-image:
      linear-gradient(to right, oklch(1 0 0 / 0.04) 1px, transparent 1px),
      linear-gradient(to bottom, oklch(1 0 0 / 0.04) 1px, transparent 1px);
    background-size: 40px 40px;
    mask-image: radial-gradient(ellipse 70% 80% at 50% 50%, black 30%, transparent 80%);
    -webkit-mask-image: radial-gradient(ellipse 70% 80% at 50% 50%, black 30%, transparent 80%);
    pointer-events: none;
  }
  .vdx-lp .cta-banner h2 {
    margin: 0;
    font-size: clamp(28px, 3.6vw, 40px);
    letter-spacing: -0.028em;
    font-weight: 600;
    line-height: 1.08;
    max-width: 620px;
    position: relative;
    text-wrap: balance;
  }
  .vdx-lp .cta-banner h2 em {
    font-style: normal;
    font-family: var(--font-jetbrains-mono), monospace;
    font-weight: 500;
    font-size: 0.86em;
    color: oklch(0.72 0.14 268);
  }
  .vdx-lp .cta-banner .row { display: flex; gap: 10px; position: relative; flex-wrap: wrap; justify-content: center; }
  .vdx-lp .cta-banner .btn-light {
    background: var(--vdx-bg); color: var(--vdx-fg); border-color: var(--vdx-bg);
  }
  .vdx-lp .cta-banner .btn-light:hover {
    background: oklch(0.96 0.003 250); border-color: oklch(0.96 0.003 250); color: var(--vdx-fg);
  }
  .vdx-lp .cta-banner .btn-dark {
    background: transparent; color: var(--vdx-bg); border-color: oklch(1 0 0 / 0.25);
  }
  .vdx-lp .cta-banner .btn-dark:hover {
    background: oklch(1 0 0 / 0.08); border-color: oklch(1 0 0 / 0.4); color: var(--vdx-bg);
  }

  /* Footer */
  .vdx-lp footer {
    border-top: 1px solid var(--vdx-line);
    padding: 44px 0 32px;
    color: var(--vdx-fg-muted);
    font-size: 12.5px;
  }
  .vdx-lp .foot-grid {
    display: grid;
    grid-template-columns: 1.4fr repeat(4, 1fr);
    gap: 28px;
  }
  .vdx-lp .foot-brand { font-size: 13px; color: var(--vdx-fg-2); line-height: 1.5; max-width: 280px; }
  .vdx-lp .foot-col h5 {
    margin: 0 0 12px;
    font-size: 10.5px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--vdx-fg-subtle);
  }
  .vdx-lp .foot-col ul { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 8px; }
  .vdx-lp .foot-col ul a,
  .vdx-lp .foot-col ul button {
    color: var(--vdx-fg-2);
    font-size: 12.5px;
    text-align: left;
    font-family: inherit;
  }
  .vdx-lp .foot-col ul a:hover,
  .vdx-lp .foot-col ul button:hover { color: var(--vdx-fg); }
  .vdx-lp .foot-bottom {
    margin-top: 36px;
    padding-top: 18px;
    border-top: 1px solid var(--vdx-line-2);
    display: flex; justify-content: space-between; align-items: center;
    font-family: var(--font-jetbrains-mono), monospace;
    font-size: 11px;
    color: var(--vdx-fg-subtle);
    gap: 12px;
    flex-wrap: wrap;
  }
  .vdx-lp .foot-bottom .status { display: inline-flex; align-items: center; gap: 7px; }
  .vdx-lp .foot-bottom .status .sdot { width: 6px; height: 6px; border-radius: 999px; background: var(--vdx-green); }

  /* Responsive */
  @media (max-width: 980px) {
    .vdx-lp .feature-grid { grid-template-columns: repeat(2, 1fr); }
    .vdx-lp .feature.f-wide, .vdx-lp .feature.f-half, .vdx-lp .feature.f-third { grid-column: span 2; }
    .vdx-lp .price-grid, .vdx-lp .steps-grid { grid-template-columns: 1fr; }
    .vdx-lp .foot-grid { grid-template-columns: 1fr 1fr; }
    .vdx-lp .annot { display: none; }
    .vdx-lp .nav-links { display: none; }
    .vdx-lp .mini-app { grid-template-columns: 1fr; grid-template-rows: 38px 1fr; }
    .vdx-lp .mini-sidebar { display: none; }
    .vdx-lp .mini-grid { grid-template-columns: 1fr; }
  }
`;
