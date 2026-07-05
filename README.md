# filtered

Cloudflare IP upstream filter.

This repository aggregates several public upstream lists, keeps reachable nodes,
and publishes a balanced high-speed result list.

## Output

```text
filtered-best-nodes.txt
filtered-best-nodes.json
```

Raw subscription source:

```text
https://raw.githubusercontent.com/alhza/filtered/main/filtered-best-nodes.txt
```

Line format:

```text
IP:PORT#中文国家-SPEED_Mbps
```

`SPEED_Mbps` is local download speed in normal local runs. In GitHub Actions
`--rank-by-source` mode, it is the upstream China-side measured speed because
GitHub-hosted runners are not located on an Asia/China user network.

Selection priority:

```text
1. Every final node must pass Cloudflare trace and local download test.
2. Deduplicate by subnet (/24 for IPv4, /48 for IPv6) before speed testing.
3. Coarse-test the whole reachable pool with a small sample, ranked by local TLS probe time.
4. Fine-test the fastest coarse survivors with a large sample, multiple rounds, best result kept.
5. Prefer nodes with trusted local download speed >= 10Mbps.
6. If the primary tier is too small, fill with tested backup nodes >= 5Mbps.
7. Ignore speed samples that finish too quickly to avoid burst-only scores.
8. Publish up to 150 nodes; never fill with nodes below the backup threshold.
```

## Local Run

Defaults are tuned already; a bare run is the recommended local usage:

```powershell
node .\cf-filter-local.mjs
```

Equivalent to:

```powershell
node .\cf-filter-local.mjs --limit 150 --scan 4000 --concurrency 120 --timeout 2500 --max-probe 1800 --subnet-limit 1 --coarse-bytes 131072 --coarse-timeout 3000 --coarse-concurrency 12 --coarse-min-speed 1 --speed-scan 300 --speed-bytes 4194304 --speed-samples 2 --speed-concurrency 4 --speed-timeout 8000 --min-speed-ms 50 --min-speed 10 --fallback-min-speed 5
```

Useful options:

```text
--limit 150
--scan 5000
--countries HK,JP,SG,TW,US,KR,DE,NL,GB,FR
--ports 443,8443,2053,2083,2087,2096
--balanced 1
--max-probe 1800
--subnet-limit 1
--coarse-scan 0
--coarse-bytes 131072
--coarse-timeout 3000
--coarse-concurrency 12
--coarse-min-speed 1
--speed-scan 300
--speed-bytes 4194304
--speed-samples 2
--speed-concurrency 4
--speed-timeout 8000
--min-speed-ms 50
--min-speed 10
--fallback-min-speed 5
--min-source-speed 10
--fallback-min-source-speed 5
--strict-min-speed 1
--rank-by-source 0
```

Notes:

```text
--limit is a maximum, not a target that must be filled.
Speed-test concurrency is deliberately low (coarse 12, fine 4): higher values make
parallel downloads compete for your own uplink and understate every node's speed.
--rank-by-source 1 skips local speed tests, keeps upstream country labels, and ranks
by the speeds measured by China-side sources (wetest, hostmonit, 090227, HandsomeMJZ).
This mode is optional and may produce a much smaller list because many upstreams do
not publish parseable speed fields. The GitHub workflow uses download speed testing
by default to keep a full generic list.
Running locally WITHOUT this flag is the gold standard: real speeds from your own line.
--subnet-limit keeps at most N nodes per subnet before speed testing; 0 disables the dedupe.
--coarse-scan 0 coarse-tests every reachable node after subnet dedupe; ordering uses local probe time only.
--coarse-min-speed drops nodes whose coarse sample cannot reach the floor, so fine slots go to real candidates.
--speed-scan is the fine-test slot count; candidates are ranked by their measured coarse speed.
--speed-samples runs several fine downloads per node and keeps the best one to absorb TCP slow start.
--strict-min-speed 1 prevents nodes below --fallback-min-speed from filling empty slots.
--fallback-min-speed keeps the list usable when too few nodes reach --min-speed.
--min-speed-ms discards very short download samples such as 1MiB in 8ms.
Upstream-claimed speed and latency are only used before any local measurement exists;
once a node has a local download result, ranking trusts the local numbers alone.
```

## Upstreams

```text
https://ips.gaoji.uk/best_ips.txt
https://raw.githubusercontent.com/svip-s/cloudflare_ip/refs/heads/main/best_ips.txt
https://raw.githubusercontent.com/love-ztm/cfip/refs/heads/main/best_ips.txt
https://raw.githubusercontent.com/gshtwy/CF-DNS-Clone/main/wetest-cloudflare-v4.txt
https://raw.githubusercontent.com/yuanxiawan/cfipv4db/main/cfip.txt
https://raw.githubusercontent.com/joname1/BestCFip/main/ipv4.txt
https://raw.githubusercontent.com/Senflare/Senflare-IP/main/IPlist-Pro.txt
https://raw.githubusercontent.com/einsitang/my-fast-cf-ip/master/fastips.txt
https://raw.githubusercontent.com/hubbylei/bestcf/main/bestcf.txt
https://raw.githubusercontent.com/ymyuuu/IPDB/main/BestCF/bestcfv4.txt
https://raw.githubusercontent.com/HandsomeMJZ/cfip/main/best_ips.txt
https://raw.githubusercontent.com/HandsomeMJZ/cfip/main/full_ips.txt
https://raw.githubusercontent.com/lu-lingyun/CloudflareST/main/TLS.txt
https://raw.githubusercontent.com/lu-lingyun/CloudflareST/main/open_ips.txt
https://bestcf.pages.dev/uouin/all.txt
https://zip.cm.edu.kg/all.txt
https://addressesapi.090227.xyz/CloudFlareYes
https://addressesapi.090227.xyz/cmcc-ipv6
https://cf.090227.xyz/ct?ips=6
https://cf.090227.xyz/cu
https://www.wetest.vip/api/cf2dns/get_cloudflare_ip?key=o1zrmHAF&type=v4
https://www.wetest.vip/api/cf2dns/get_cloudflare_ip?key=o1zrmHAF&type=v6
https://api.hostmonit.com/get_optimization_ip
https://ipdb.api.030101.xyz/?type=bestcf&country=true
https://addressesapi.090227.xyz/ct
https://cdn.jsdelivr.net/gh/HandsomeMJZ/cfip@main/best_ips.txt
https://cdn.jsdelivr.net/gh/HandsomeMJZ/cfip@main/full_ips.txt
https://ip.164746.xyz/ipTop10.html
https://cdn.jsdelivr.net/gh/ZhiXuanWang/cf-speed-dns@main/ipTop10.html
```
