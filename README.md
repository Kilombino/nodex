# Nodex

Lightning explorer for the BLAKE2b Bitcoin network: https://nodex.kilombino.com

- Node pages: capacity, channels, peers, centrality, addresses, uptime, operator card
- Fees in both directions (what a node charges to route out, and what its peers charge to route in)
- Rankings (capacity, channels, centrality, cheapest and most expensive fees), map and live feed of fee changes
- Operator directory shared with mempool.kilombino.com (operators sign their card with their node key)
- English and Spanish, no external requests, works over Tor

## How it works

| Part | What it does |
| --- | --- |
| `indexer/` | Every 10 min reads the Lightning API of a [mempool](https://github.com/mempool/mempool) backend and writes `data/graph.json` (snapshot, rankings, betweenness) and `data/history.json` (policy changes, which the backend does not keep) |
| `prober/` | Every 10 min tries a TCP connection to the addresses each node announces (`.onion` through a local Tor SOCKS port) and writes `data/uptime.json`. Private and loopback addresses are never probed |
| `web/` | Static single-page app built with esbuild (`./build.sh`) |
| `nginx/` | Serves the app and the data files, and proxies the mempool Lightning API (GET only) |

## Running

Needs a mempool backend with Lightning enabled on a Docker network named `mempool-deploy_default` (change it in `docker-compose.yml`), and Tor on `127.0.0.1:9050` for the prober.

```sh
./build.sh
docker compose up -d
node prober/uptime.mjs   # run it from a timer every 10 min
```

`test/shots.py` is a Playwright smoke test: `python3 test/shots.py http://127.0.0.1:3230 /tmp/shots`.

## License

Apache-2.0
