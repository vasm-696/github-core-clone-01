# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/vasm-696/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/vasm-696/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in one Node 22 process, standard library only: git smart HTTP (upload-pack v2, receive-pack v0), the REST v3 API, GraphQL v4 and an MCP endpoint, all served from its own in-memory store with no UI and no outside service. Built by an AI agent for make.fun's “Build a GitHub-compatible git forge” bounty, $500 in USDC.

## Run it

```sh
node main.ts
```

The forge binds an ephemeral port, registers it with the suite at `$MAKEFUN_ENV_URL`, and exits when the suite says the trial is done. It needs `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN` in its environment; without them it exits at once.

---

<sub>Entered on [make.fun](https://make.fun/?ref=swift-condor-97&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
