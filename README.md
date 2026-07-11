# filtered

Cloudflare IP upstream filter.

This repository aggregates several public upstream lists, keeps reachable nodes,
and publishes a balanced high-speed result list.

## Output

```text
filtered-best-nodes.txt
filtered-best-nodes.json
filtered-proxy-links.txt
filtered-proxy-links.json
```

EdgeTunnel front-address source:

```text
https://raw.githubusercontent.com/alhza/filtered/main/filtered-best-nodes.txt
```

EdgeTunnel full proxy-link source:

```text
https://raw.githubusercontent.com/alhza/filtered/main/filtered-proxy-links.txt
```

Add the two URLs separately in the EdgeTunnel settings page. The first list is
used to generate EdgeTunnel nodes with the deployment's UUID, SNI, and path;
the second list contains complete VLESS, VMess, Trojan, and Shadowsocks links
that EdgeTunnel merges into the final subscription unchanged.

Line format:

```text
IP:PORT#中文国家-LOCAL_DOWNLOAD_Mbps
```

Selection priority:

```text
1. Every final node must pass Cloudflare trace and local download test.
2. Prefer nodes with trusted local download speed >= 10Mbps.
3. If the primary tier is too small, fill with tested backup nodes >= 5Mbps.
4. Ignore speed samples that finish too quickly to avoid burst-only scores.
5. Publish up to 150 nodes; never fill with nodes below the backup threshold.
```

## Local Run

```powershell
node .\cf-filter-local.mjs --limit 150 --scan 5000 --concurrency 120 --timeout 2500 --max-probe 1800 --speed-scan 200 --speed-bytes 1048576 --speed-concurrency 8 --speed-timeout 8000 --min-speed-ms 50 --min-speed 10 --fallback-min-speed 5
```

Filter complete public proxy links separately:

```powershell
node .\proxy-filter-local.mjs --limit 500 --scan 1200 --concurrency 100 --timeout 2500
```

The proxy-link filter validates syntax, deduplicates configurations while
ignoring display-name-only differences, and performs one TCP reachability test
per unique server endpoint. It does not treat full proxy links as Cloudflare
front addresses.

Useful options:

```text
--limit 150
--scan 5000
--countries HK,JP,SG,TW,US,KR,DE,NL,GB,FR
--ports 443,8443,2053,2083,2087,2096
--balanced 1
--max-probe 1800
--speed-scan 200
--speed-bytes 1048576
--speed-concurrency 8
--speed-timeout 8000
--min-speed-ms 50
--min-speed 10
--fallback-min-speed 5
--strict-min-speed 1
```

Notes:

```text
--limit is a maximum, not a target that must be filled.
--strict-min-speed 1 prevents nodes below --fallback-min-speed from filling empty slots.
--fallback-min-speed keeps the list usable when too few nodes reach --min-speed.
--min-speed-ms discards very short download samples such as 1MiB in 8ms.
The workflow uses a single download test per candidate to avoid repeated probing.
```

## Upstreams

```text
https://raw.githubusercontent.com/weduolijia/-CF-IP/main/top10.txt
https://raw.githubusercontent.com/vipmc838/cf_best_ip/main/cloudflare_bestip.txt
https://raw.githubusercontent.com/gslege/CloudflareIP/main/All.txt
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
https://addressesapi.090227.xyz/ct
https://addressesapi.090227.xyz/cmcc
https://cf.090227.xyz/ct
https://cdn.jsdelivr.net/gh/HandsomeMJZ/cfip@main/best_ips.txt
https://cdn.jsdelivr.net/gh/HandsomeMJZ/cfip@main/full_ips.txt
https://cdn.jsdelivr.net/gh/ymyuuu/IPDB@main/BestCF/bestcfv6.txt
https://ip.164746.xyz/ipTop10.html
```

## Proxy-link Upstreams

```text
https://github.com/Au1rxx/free-vpn-subscriptions
https://github.com/0xRadikal/Free-v2ray-Configs
https://github.com/Pawdroid/Free-servers
https://github.com/chengaopan/AutoMergePublicNodes
https://github.com/roosterkid/openproxylist
https://github.com/mahdibland/V2RayAggregator
https://github.com/ebrasha/free-v2ray-public-list
https://github.com/mfuu/v2ray
https://github.com/shaoyouvip/free
```
