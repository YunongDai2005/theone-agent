# Deploy

Running The One with your own WeChat, worker, and model accounts. Back to the [README](../README.md).

## Prerequisites

- Linux; systemd user services for the supplied service and helper workflows.
- Node.js 22+ and a configured DSH CLI with a `headless` profile.
- OpenClaw with its WeChat plugin and your own iLink account.
- Your own model credentials and provider configuration.
- Python 3 and `zstdcat` for the optional session-history tools.

The complete supporting scripts use this example layout:

```text
/home/aibox/wx-router/      Repository checkout
/home/aibox/bin/            Scripts installed from this repository's bin/
/home/aibox/dsh-work/       Worker workspace
/home/aibox/.dsh/           Your DSH profiles and credentials
/home/aibox/.openclaw/      Your OpenClaw installation and WeChat plugin
/home/aibox/.aibox/         Generated local state
```

1. Place the repository at `/home/aibox/wx-router`. Inspect `~/bin` for name conflicts before copying the supplied `bin/` scripts there, and create `~/dsh-work`.
2. Copy `config.example.json` to `config.json`. Set `accountFile`, `pluginDir`, `dshBin`, `dshCwd`, provider/model settings, and `realBase` for your installation.
3. **Set `realBase` to the original iLink upstream.** Configure the OpenClaw WeChat channel to use the local proxy at `http://127.0.0.1:8787`. Using that proxy address as the upstream would create a loop.
4. Configure the DSH `headless` profile and its fallback patch yourself. Manager model calls read `OPENCODE_GO_API_KEY` and `DEEPSEEK_API_KEY` (and, if you run a local WorkBuddy gateway, `WORKBUDDY_GATEWAY_API_KEY`) from `~/.dsh/.credentials.yaml`. Adjust provider endpoints and model names to your available services.
5. Run `npm start` in the foreground. Check `/healthz` and `http://127.0.0.1:8788/api/v2/status`, then verify the real messaging path. Only then install `ops/wx-router.service`, adjusting its Node executable path.

The v2 core supports `AIBOX_HOME`, `AIBOX_ROOT`, and `AIBOX_CONFIG`. Legacy v1 and some `bin/` and `ops/` scripts still assume `/home/aibox`; a different layout requires corresponding edits. The WeChat adapter imports plugin internals, so verify the module layout against your installation.

The example configuration disables helper workers, local-model routing, and automated review. Configure their dependencies before enabling them. Two hardware- or privacy-sensitive plugins are off by default: `transcript` (keeps a local copy of incoming message text) and `sdr` (controls a local radio receiver service).

The dashboard frontend is `web/index.html`: serve it with any static web server and proxy `/api/v2/*` to `127.0.0.1:8788`. To preview it with fake data, run `node test/dev-dashboard.mjs` and open `http://127.0.0.1:8933/`. Machine-status cards read an optional `systemStatusUrl`; without one they show as unavailable. MCP control services, third-party frameworks, and model weights are not bundled.

## Privacy and access

The proxy and status API default to loopback. The status API does not provide a complete public-facing authentication layer. Keep it private, and choose worker permissions appropriate to your machine.

The published repository excludes account files, credentials, private conversations, personal knowledge, runtime state, and the original Git history. Runtime logs and handoffs can still contain private content: inspect them before sharing. See [security notes](../SECURITY.md) (Chinese).
