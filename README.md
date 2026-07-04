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
IP:PORT#COUNTRY-COLO-LOCAL_DOWNLOAD_Mbps-CF_TRACE_MS
```

## Local Run

```powershell
node .\cf-filter-local.mjs --limit 150 --scan 5000 --concurrency 120 --timeout 2500 --max-probe 1800 --speed-scan 200 --speed-bytes 1048576 --speed-concurrency 8 --speed-timeout 8000 --min-speed 10
```

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
--min-speed 10
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
```
