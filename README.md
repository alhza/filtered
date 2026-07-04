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

## Local Run

```powershell
node .\cf-filter-local.mjs --limit 150 --scan 5000 --concurrency 120 --timeout 2500 --max-probe 1800 --min-speed 10
```

Useful options:

```text
--limit 150
--scan 5000
--countries HK,JP,SG,TW,US,KR,DE,NL,GB,FR
--ports 443,8443,2053,2083,2087,2096
--balanced 1
--max-probe 1800
--min-speed 10
```

## Upstreams

```text
https://ips.gaoji.uk/best_ips.txt
https://raw.githubusercontent.com/svip-s/cloudflare_ip/refs/heads/main/best_ips.txt
https://raw.githubusercontent.com/love-ztm/cfip/refs/heads/main/best_ips.txt
https://bestcf.pages.dev/uouin/all.txt
https://zip.cm.edu.kg/all.txt
```
