# filtered

Cloudflare IP upstream filter.

This repository aggregates several public upstream lists, verifies candidates
from the current probe, and publishes a balanced high-speed result list.

## Output

```text
filtered-best-nodes.txt
filtered-best-nodes.json
```

EdgeTunnel front-address source:

```text
https://raw.githubusercontent.com/alhza/filtered/main/filtered-best-nodes.txt
```

Add this URL in the EdgeTunnel settings page. The list is used to generate
EdgeTunnel nodes with the deployment's UUID, SNI, and path.

Line format:

```text
IP:PORT#中文国家-LOCAL_DOWNLOAD_Mbps
```

## Availability semantics

The JSON report deliberately separates generic Cloudflare reachability from
deployment availability:

```text
available   = the configured EdgeTunnel WebSocket target passed through the candidate
unverified  = TLS, Cloudflare trace, and optional speed checks passed, but no full target was configured
unavailable = one or more checks required by the configured verification level failed
```

Without both `EDGETUNNEL_HOST` and `EDGETUNNEL_PATH`, the text output is a
candidate source rather than a claim that every address is globally available.
The report records `probe.scope`, `probe.region`, and `probe.regionVerified` so
the probe perspective cannot be mistaken for a regional result. The
`stats.searchQueue` counts and each selected node's `searchLane` make the ranked
and exploration paths auditable. The legacy `stats.usable` field is retained,
but now counts only `available` nodes; use `stats.cloudflareReachable` for the
generic trace result.

Selection priority:

```text
1. Use 75% of the scan budget for ranked candidates and 25% for rotating candidates with weak or missing upstream evidence.
2. Require a valid TLS certificate and an authentic Cloudflare trace response.
3. Require at least 2 successful trace checks out of 3 attempts.
4. When configured, require at least 2 valid EdgeTunnel WebSocket upgrades out of 3.
5. Require at least 2 complete 4MiB downloads out of 3 and rank only by current-run measurements.
6. Require the weakest successful sample >= 5Mbps and prefer median speed >= 10Mbps.
7. Apply country balancing before capped ranked selections.
8. Refuse to overwrite published output when fewer than 20 nodes pass.
```

## Local Run

```powershell
node .\cf-filter-local.mjs `
  --limit 150 `
  --scan 3000 `
  --exploration-ratio 0.25 `
  --concurrency 120 `
  --timeout 2500 `
  --max-probe 1200 `
  --probe-attempts 3 `
  --min-probe-successes 2 `
  --speed-scan 180 `
  --speed-bytes 4194304 `
  --speed-concurrency 8 `
  --speed-timeout 12000 `
  --speed-attempts 3 `
  --min-speed-successes 2 `
  --min-speed-ms 100 `
  --min-speed 10 `
  --fallback-min-speed 5 `
  --strict-min-speed 1 `
  --min-source-successes 2 `
  --min-output 20
```

Useful options:

```text
--limit 150
--scan 5000
--exploration-ratio 0.25
--countries HK,JP,SG,TW,US,KR,DE,NL,GB,FR
--ports 443,8443,2053,2083,2087,2096
--balanced 1
--max-probe 1200
--probe-attempts 3
--min-probe-successes 2
--speed-scan 180
--speed-bytes 4194304
--speed-concurrency 8
--speed-timeout 12000
--speed-attempts 3
--min-speed-successes 2
--min-speed-ms 100
--min-speed 10
--fallback-min-speed 5
--strict-min-speed 1
--min-source-successes 2
--min-output 20
```

Notes:

```text
--limit is a maximum, not a target that must be filled.
--exploration-ratio reserves part of each scan for candidates ignored by stale or missing upstream scores.
--strict-min-speed 1 prevents nodes below --fallback-min-speed from filling empty slots.
--fallback-min-speed keeps enough measured candidates when too few reach --min-speed.
Every TLS connection verifies the certificate for the configured hostname.
Trace responses must return HTTP 200 and valid h, ip, colo, visit_scheme, and tls fields.
Every speed sample must return HTTP 200 and the complete requested byte count.
The reported localSpeedMbps is the median of successful samples.
```

## GitHub Actions verification

The scheduled workflow performs all filtering on a single GitHub-hosted runner
so speed samples remain comparable within that run. No deployment configuration
is required for generic Cloudflare reachability checks against
`speed.cloudflare.com`; those results remain `unverified` for EdgeTunnel use.

For deployment-specific checks, configure these under
`Settings > Secrets and variables > Actions`:

```text
Variable: EDGETUNNEL_HOST = your deployment hostname, without https://
Secret:   EDGETUNNEL_PATH = the WebSocket path, beginning with /
```

With only `EDGETUNNEL_HOST`, the TLS certificate and Cloudflare trace are checked
against that deployment hostname. With both values, each finalist must also
complete a cryptographically validated WebSocket upgrade through the candidate
IP. The secret path is never written to the JSON report or logs.

Alternatively, set the `CF_TRACE_HOST` repository variable when only a custom
Cloudflare hostname should be used for trace verification.

GitHub-hosted speed represents connectivity from the assigned Actions runner,
not a specific home or mobile network. GitHub does not provide a supported way
to place `ubuntu-latest` in Shanghai, so this workflow records the region as
unverified and must not label the result as Shanghai availability.

## Upstreams

```text
https://ips.gaoji.uk/best_ips.txt
https://raw.githubusercontent.com/love-ztm/cfip/refs/heads/main/best_ips.txt
https://raw.githubusercontent.com/HandsomeMJZ/cfip/main/full_ips.txt
https://zip.cm.edu.kg/all.txt
```
