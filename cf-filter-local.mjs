import fs from 'node:fs/promises';
import tls from 'node:tls';

const MASTER_APIS = [
	'https://ips.gaoji.uk/best_ips.txt',
	'https://raw.githubusercontent.com/svip-s/cloudflare_ip/refs/heads/main/best_ips.txt',
	'https://raw.githubusercontent.com/love-ztm/cfip/refs/heads/main/best_ips.txt',
	'https://raw.githubusercontent.com/gshtwy/CF-DNS-Clone/main/wetest-cloudflare-v4.txt',
	'https://raw.githubusercontent.com/yuanxiawan/cfipv4db/main/cfip.txt',
	'https://raw.githubusercontent.com/joname1/BestCFip/main/ipv4.txt',
	'https://raw.githubusercontent.com/Senflare/Senflare-IP/main/IPlist-Pro.txt',
	'https://raw.githubusercontent.com/einsitang/my-fast-cf-ip/master/fastips.txt',
	'https://raw.githubusercontent.com/hubbylei/bestcf/main/bestcf.txt',
	'https://raw.githubusercontent.com/ymyuuu/IPDB/main/BestCF/bestcfv4.txt',
	'https://raw.githubusercontent.com/HandsomeMJZ/cfip/main/best_ips.txt',
	'https://raw.githubusercontent.com/HandsomeMJZ/cfip/main/full_ips.txt',
	'https://raw.githubusercontent.com/lu-lingyun/CloudflareST/main/TLS.txt',
	'https://raw.githubusercontent.com/lu-lingyun/CloudflareST/main/open_ips.txt',
	'https://bestcf.pages.dev/uouin/all.txt',
	'https://zip.cm.edu.kg/all.txt',
];

const DEFAULT_COUNTRIES = [
	'HK', 'JP', 'SG', 'TW', 'US', 'KR', 'DE', 'NL', 'GB', 'FR', 'FI', 'SE',
	'CH', 'PL', 'LV', 'CA', 'AU', 'RU', 'TH', 'MY', 'VN', 'IN',
];
const DEFAULT_PORTS = ['443', '8443', '2053', '2083', '2087', '2096'];

const COLO_COUNTRY = {
	HKG: 'HK', NRT: 'JP', KIX: 'JP', FUK: 'JP', SIN: 'SG', TPE: 'TW', ICN: 'KR',
	SJC: 'US', LAX: 'US', SEA: 'US', DFW: 'US', IAD: 'US', EWR: 'US', ORD: 'US', MIA: 'US', ATL: 'US', DEN: 'US',
	FRA: 'DE', MUC: 'DE', HAM: 'DE', AMS: 'NL', LHR: 'GB', MAN: 'GB', CDG: 'FR', MRS: 'FR',
	HEL: 'FI', ARN: 'SE', ZRH: 'CH', GVA: 'CH', WAW: 'PL', RIX: 'LV',
	YYZ: 'CA', YVR: 'CA', YUL: 'CA', SYD: 'AU', MEL: 'AU', BNE: 'AU', PER: 'AU',
	DME: 'RU', SVO: 'RU', LED: 'RU', BKK: 'TH', KUL: 'MY', SGN: 'VN', HAN: 'VN',
	BLR: 'IN', BOM: 'IN', DEL: 'IN', MAA: 'IN', CCU: 'IN', HYD: 'IN',
};

const args = parseArgs(process.argv.slice(2));
const options = {
	limit: numberArg(args.limit, 150),
	scan: numberArg(args.scan, 4000),
	connectTimeout: numberArg(args.timeout, 1600),
	maxProbe: numberArg(args.maxProbe ?? args['max-probe'] ?? args.maxTcp ?? args['max-tcp'], 1200),
	minKeepSpeed: numberArg(args.minSpeed ?? args['min-speed'], 10),
	probeHost: args.probeHost || args['probe-host'] || 'speed.cloudflare.com',
	speedTest: args.speedTest !== '0' && args['speed-test'] !== '0',
	speedScan: numberArg(args.speedScan ?? args['speed-scan'], 200),
	speedBytes: numberArg(args.speedBytes ?? args['speed-bytes'], 1024 * 1024),
	speedTimeout: numberArg(args.speedTimeout ?? args['speed-timeout'], 6000),
	concurrency: numberArg(args.concurrency, 120),
	speedConcurrency: numberArg(args.speedConcurrency ?? args['speed-concurrency'], 8),
	countries: listArg(args.countries, DEFAULT_COUNTRIES, true),
	ports: listArg(args.ports, DEFAULT_PORTS, false),
	balanced: args.balanced !== '0',
	out: args.out || 'filtered-best-nodes.txt',
	json: args.json || 'filtered-best-nodes.json',
};

const startedAt = Date.now();
const fetched = await fetchSources(MASTER_APIS);
const parsed = dedupeCandidates(fetched.flatMap(({ url, text, sourceIndex }) => parseSource(text, url, sourceIndex)));
const scoped = applyStaticFilters(parsed, options);
const queue = selectCheckQueue(scoped, options);
const checked = await checkCandidates(queue, options);
const usable = checked.filter(item => {
	const countrySet = new Set(options.countries);
	const countryOk = countrySet.size === 0 || countrySet.has(item.country);
	return item.ok && item.probeMs <= options.maxProbe && countryOk;
});
const speedQueue = options.speedTest ? selectSpeedQueue(usable, options) : usable;
const measured = options.speedTest ? await speedTestCandidates(speedQueue, options) : usable;
const speedUsable = options.speedTest ? measured.filter(item => Number.isFinite(item.localSpeedMbps)) : measured;
const selected = selectFinalNodes(speedUsable, options);

await fs.writeFile(options.out, formatNodeLines(selected).join('\n') + (selected.length ? '\n' : ''), 'utf8');
await fs.writeFile(options.json, JSON.stringify({
	generatedAt: new Date().toISOString(),
	elapsedMs: Date.now() - startedAt,
	sources: fetched.map(item => ({
		url: item.url,
		ok: item.ok,
		status: item.status,
		bytes: item.text?.length || 0,
		error: item.error || null,
	})),
	options,
	stats: {
		parsed: parsed.length,
		scoped: scoped.length,
		queued: queue.length,
		checked: checked.length,
		usable: usable.length,
		speedQueued: speedQueue.length,
		speedTested: measured.length,
		speedUsable: speedUsable.length,
		selected: selected.length,
		highSpeedQueued: queue.filter(item => isHighSpeed(item, options.minKeepSpeed)).length,
		highSpeedUsable: speedUsable.filter(item => isHighSpeed(item, options.minKeepSpeed)).length,
		highSpeedSelected: selected.filter(item => isHighSpeed(item, options.minKeepSpeed)).length,
		countryDistribution: countBy(selected, 'country'),
		portDistribution: countBy(selected, 'port'),
	},
	nodes: selected,
}, null, 2), 'utf8');

console.log(`parsed=${parsed.length} scoped=${scoped.length} queued=${queue.length} checked=${checked.length} usable=${usable.length} speedQueued=${speedQueue.length} speedUsable=${speedUsable.length} selected=${selected.length}`);
console.log(`highSpeed>${options.minKeepSpeed}Mbps queued=${queue.filter(item => isHighSpeed(item, options.minKeepSpeed)).length} usable=${speedUsable.filter(item => isHighSpeed(item, options.minKeepSpeed)).length} selected=${selected.filter(item => isHighSpeed(item, options.minKeepSpeed)).length}`);
console.log(`countries=${JSON.stringify(countBy(selected, 'country'))}`);
console.log(`ports=${JSON.stringify(countBy(selected, 'port'))}`);
console.log(`wrote ${options.out}`);
console.log(`wrote ${options.json}`);
console.log(formatNodeLines(selected.slice(0, 12)).join('\n'));

async function fetchSources(urls) {
	const results = new Array(urls.length);
	let index = 0;
	const workers = Array.from({ length: 4 }, async () => {
		while (index < urls.length) {
			const sourceIndex = index++;
			results[sourceIndex] = await fetchSource(urls[sourceIndex], sourceIndex);
		}
	});
	await Promise.all(workers);
	return results;
}

async function fetchSource(url, sourceIndex) {
	for (let attempt = 1; attempt <= 3; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 45000);
		try {
			const response = await fetch(url, {
				signal: controller.signal,
				headers: { 'User-Agent': 'filtered-cf-nodes/1.0' },
			});
			const text = response.ok ? await response.text() : '';
			return { url, sourceIndex, ok: response.ok, status: response.status, text };
		} catch (error) {
			if (attempt === 3) {
				return {
					url,
					sourceIndex,
					ok: false,
					status: 0,
					text: '',
					error: error?.message || String(error),
				};
			}
		} finally {
			clearTimeout(timer);
		}
	}
}

function parseSource(text, sourceUrl, sourceIndex) {
	const rows = [];
	for (const rawLine of String(text || '').split(/\r?\n/)) {
		const row = parseLine(rawLine, sourceUrl, sourceIndex);
		if (row) rows.push(row);
	}
	return rows;
}

function parseLine(rawLine, sourceUrl, sourceIndex) {
	const line = String(rawLine || '').trim();
	if (!line || line.startsWith('#') || line.startsWith('//')) return null;

	const match = line.match(/^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{2,5})(?:#(.+))?/);
	const ipOnlyMatch = match ? null : line.match(/^((?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-fA-F:]+\]|[0-9a-fA-F:]{6,})(?:#(.+))?$/);
	if (!match && !ipOnlyMatch) return null;

	const host = (match ? match[1] : ipOnlyMatch[1]).replace(/^\[|\]$/g, '');
	const port = match ? match[2] : '443';
	const remark = safeDecode((match ? match[3] : ipOnlyMatch[2]) || '');
	const country = extractCountry(remark);
	const metrics = extractMetrics(remark);

	return {
		host,
		port,
		country,
		remark,
		sourceUrl,
		sourceIndex,
		latencyMs: metrics.latencyMs,
		speedMbps: metrics.speedMbps,
		line: `${host}:${port}#${remark || country || sourceHost(sourceUrl)}`,
	};
}

function dedupeCandidates(candidates) {
	const best = new Map();
	for (const item of candidates) {
		const key = `${item.host}:${item.port}`;
		const old = best.get(key);
		if (!old || compareCandidateScore(item, old) < 0) best.set(key, item);
	}
	return [...best.values()];
}

function applyStaticFilters(candidates, { countries, ports }) {
	const countrySet = new Set(countries);
	const portSet = new Set(ports.map(String));
	return candidates.filter(item => {
		const countryOk = countrySet.size === 0 || !item.country || countrySet.has(item.country);
		const portOk = portSet.size === 0 || portSet.has(item.port);
		return countryOk && portOk;
	});
}

async function checkCandidates(candidates, { concurrency, connectTimeout, probeHost }) {
	const results = [];
	let index = 0;
	const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
		while (index < candidates.length) {
			const item = candidates[index++];
			results.push(await checkCloudflareTrace(item, connectTimeout, probeHost));
		}
	});
	await Promise.all(workers);
	return results;
}

function checkCloudflareTrace(candidate, timeoutMs, probeHost) {
	return new Promise(resolve => {
		const start = Date.now();
		const socket = tls.connect({
			host: candidate.host,
			port: Number(candidate.port),
			servername: probeHost,
			rejectUnauthorized: false,
			ALPNProtocols: ['http/1.1'],
		});
		let responseText = '';
		let finished = false;
		const done = (ok, error = null) => {
			if (finished) return;
			finished = true;
			socket.destroy();
			const cfColo = extractTraceField(responseText, 'colo');
			resolve({
				...candidate,
				ok,
				probeMs: Date.now() - start,
				country: COLO_COUNTRY[cfColo] || candidate.country || '',
				cfColo,
				cfIp: extractTraceField(responseText, 'ip'),
				error,
			});
		};
		socket.setTimeout(timeoutMs);
		socket.once('secureConnect', () => {
			socket.write(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${probeHost}\r\nUser-Agent: filtered-cf-nodes/1.0\r\nConnection: close\r\n\r\n`);
		});
		socket.on('data', chunk => {
			responseText += chunk.toString('utf8');
			if (responseText.includes('\ncolo=') && responseText.includes('\nip=')) done(true);
			else if (responseText.length > 8192) done(false, 'invalid-trace');
		});
		socket.once('end', () => {
			const ok = responseText.includes('\ncolo=') && responseText.includes('\nip=');
			done(ok, ok ? null : 'no-cloudflare-trace');
		});
		socket.once('timeout', () => done(false, 'timeout'));
		socket.once('error', error => done(false, error.code || error.message));
	});
}

function selectCheckQueue(candidates, options) {
	const targetSize = Math.max(options.scan, options.limit);
	const selected = new Map();
	const highSpeed = candidates
		.filter(item => isHighSpeed(item, options.minKeepSpeed))
		.sort(compareCandidateScore);
	for (const item of highSpeed) selected.set(candidateKey(item), item);

	const rest = candidates.filter(item => !selected.has(candidateKey(item)));
	const fillLimit = Math.max(0, targetSize - selected.size);
	const fill = options.balanced
		? balancedTake(groupAndSort(rest, compareCandidateScore), fillLimit, options.countries)
		: rest.sort(compareCandidateScore).slice(0, fillLimit);
	for (const item of fill) selected.set(candidateKey(item), item);
	return [...selected.values()];
}

function selectFinalNodes(candidates, options) {
	const selected = new Map();
	const highSpeed = candidates
		.filter(item => isHighSpeed(item, options.minKeepSpeed))
		.sort(compareCheckedScore);
	for (const item of highSpeed) selected.set(candidateKey(item), item);

	const rest = candidates.filter(item => !selected.has(candidateKey(item)));
	const fillLimit = Math.max(0, options.limit - selected.size);
	const fill = options.balanced
		? balancedTake(groupAndSort(rest, compareCheckedScore), fillLimit, options.countries)
		: rest.sort(compareCheckedScore).slice(0, fillLimit);
	for (const item of fill) selected.set(candidateKey(item), item);
	return [...selected.values()];
}

function selectSpeedQueue(candidates, options) {
	const targetSize = Math.max(options.speedScan, options.limit);
	const selected = new Map();
	const highSpeed = candidates
		.filter(item => isHighSpeed(item, options.minKeepSpeed))
		.sort(compareCheckedScore);
	for (const item of highSpeed) selected.set(candidateKey(item), item);

	const rest = candidates.filter(item => !selected.has(candidateKey(item)));
	const fillLimit = Math.max(0, targetSize - selected.size);
	const fill = options.balanced
		? balancedTake(groupAndSort(rest, compareCheckedScore), fillLimit, options.countries)
		: rest.sort(compareCheckedScore).slice(0, fillLimit);
	for (const item of fill) selected.set(candidateKey(item), item);
	return [...selected.values()];
}

async function speedTestCandidates(candidates, { speedConcurrency, speedTimeout, speedBytes, probeHost }) {
	const results = [];
	let index = 0;
	const workers = Array.from({ length: Math.max(1, speedConcurrency) }, async () => {
		while (index < candidates.length) {
			const item = candidates[index++];
			results.push(await testDownloadSpeed(item, speedTimeout, speedBytes, probeHost));
		}
	});
	await Promise.all(workers);
	return results;
}

function testDownloadSpeed(candidate, timeoutMs, bytes, probeHost) {
	return new Promise(resolve => {
		const start = Date.now();
		const socket = tls.connect({
			host: candidate.host,
			port: Number(candidate.port),
			servername: probeHost,
			rejectUnauthorized: false,
			ALPNProtocols: ['http/1.1'],
		});
		let bodyBytes = 0;
		let bodyStartAt = 0;
		let headerDone = false;
		let buffer = Buffer.alloc(0);
		let finished = false;
		const done = (ok, error = null) => {
			if (finished) return;
			finished = true;
			socket.destroy();
			const elapsedMs = Math.max(1, Date.now() - (bodyStartAt || start));
			const localSpeedMbps = ok ? (bodyBytes * 8) / elapsedMs / 1000 : null;
			resolve({
				...candidate,
				speedOk: ok,
				speedMs: elapsedMs,
				speedBytes: bodyBytes,
				localSpeedMbps,
				speedError: error,
			});
		};
		socket.setTimeout(timeoutMs);
		socket.once('secureConnect', () => {
			socket.write(`GET /__down?bytes=${bytes} HTTP/1.1\r\nHost: ${probeHost}\r\nUser-Agent: filtered-cf-nodes/1.0\r\nConnection: close\r\n\r\n`);
		});
		socket.on('data', chunk => {
			if (headerDone) {
				if (!bodyStartAt) bodyStartAt = Date.now();
				bodyBytes += chunk.length;
			} else {
				buffer = Buffer.concat([buffer, chunk]);
				const headerEnd = buffer.indexOf('\r\n\r\n');
				if (headerEnd !== -1) {
					headerDone = true;
					bodyStartAt = Date.now();
					bodyBytes += buffer.length - headerEnd - 4;
					buffer = null;
				}
			}
			if (bodyBytes >= bytes) done(true);
		});
		socket.once('end', () => done(bodyBytes > 0, bodyBytes > 0 ? null : 'no-download-body'));
		socket.once('timeout', () => done(bodyBytes > 0, bodyBytes > 0 ? null : 'speed-timeout'));
		socket.once('error', error => done(false, error.code || error.message));
	});
}

function groupAndSort(items, compareFn) {
	const groups = new Map();
	for (const item of items) {
		const key = item.country || 'ZZ';
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key).push(item);
	}
	for (const list of groups.values()) list.sort(compareFn);
	return groups;
}

function balancedTake(groups, limit, preferredCountries) {
	const order = [
		...preferredCountries.filter(country => groups.has(country)),
		...Array.from(groups.keys()).filter(country => !preferredCountries.includes(country)).sort(),
	];
	const result = [];
	let cursor = 0;
	while (result.length < limit && order.length > 0) {
		const country = order[cursor % order.length];
		const list = groups.get(country);
		if (!list || list.length === 0) {
			order.splice(cursor % order.length, 1);
			cursor = 0;
			continue;
		}
		result.push(list.shift());
		cursor++;
	}
	return result;
}

function isHighSpeed(item, threshold) {
	return measuredSpeedMbps(item) > threshold;
}

function candidateKey(item) {
	return `${item.host}:${item.port}`;
}

function compareCandidateScore(a, b) {
	return scoreCandidate(b) - scoreCandidate(a);
}

function compareCheckedScore(a, b) {
	const scoreCompare = scoreChecked(b) - scoreChecked(a);
	if (scoreCompare) return scoreCompare;
	return (a.probeMs || 9999) - (b.probeMs || 9999);
}

function scoreChecked(item) {
	return scoreCandidate(item) - (item.probeMs || 9999) / 4;
}

function scoreCandidate(item) {
	const speed = measuredSpeedMbps(item);
	const latency = Number.isFinite(item.latencyMs) ? item.latencyMs : 9999;
	const countryBonus = DEFAULT_COUNTRIES.includes(item.country) ? 240 - DEFAULT_COUNTRIES.indexOf(item.country) * 6 : 0;
	const portBonus = DEFAULT_PORTS.includes(item.port) ? 120 - DEFAULT_PORTS.indexOf(item.port) * 8 : 0;
	const sourceBonus = Math.max(0, 90 - item.sourceIndex * 12);
	const metricsBonus = Number.isFinite(item.speedMbps) || Number.isFinite(item.latencyMs) ? 320 : 0;
	return speed * 120 + metricsBonus + countryBonus + portBonus + sourceBonus - latency / 8;
}

function formatNodeLines(items) {
	const baseLabels = items.map(formatNodeLabel);
	const totals = countValues(baseLabels);
	const seen = new Map();
	return items.map((item, index) => {
		const base = baseLabels[index];
		const next = (seen.get(base) || 0) + 1;
		seen.set(base, next);
		const label = totals[base] > 1 ? `${base}-${String(next).padStart(2, '0')}` : base;
		return `${item.host}:${item.port}#${label}`;
	});
}

function formatNodeLabel(item) {
	const country = item.country || 'ZZ';
	const speed = Number.isFinite(item.localSpeedMbps) ? formatSpeed(item.localSpeedMbps) : (Number.isFinite(item.speedMbps) ? formatSpeed(item.speedMbps) : 'NA');
	return `${country}-${speed}`;
}

function measuredSpeedMbps(item) {
	if (Number.isFinite(item.localSpeedMbps)) return item.localSpeedMbps;
	if (Number.isFinite(item.speedMbps)) return item.speedMbps;
	return 0;
}

function formatSpeed(value) {
	if (!Number.isFinite(value)) return 'NA';
	if (value >= 10) return `${Math.round(value)}M`;
	return `${Math.max(0.1, Math.round(value * 10) / 10)}M`;
}

function extractTraceField(text, field) {
	const match = String(text || '').match(new RegExp(`(?:^|\\n)${field}=([^\\r\\n]+)`));
	return match ? match[1] : '';
}

function extractCountry(text) {
	const normalized = String(text || '').toUpperCase();
	const match = normalized.match(/(?:^|[^A-Z])([A-Z]{2})(?:[_\s\]-]|$)/);
	return match ? match[1] : '';
}

function extractMetrics(text) {
	const raw = safeDecode(text);
	const latencyMatch = raw.match(/(\d+(?:\.\d+)?)\s*ms/i) || raw.match(/延迟[^\d]*(\d+(?:\.\d+)?)/i);
	const speedMatch = raw.match(/(\d+(?:\.\d+)?)\s*(GB\/S|G\/S|MB\/S|M\/S|KB\/S|K\/S|GBPS|MBPS|KBPS)/i);
	return {
		latencyMs: latencyMatch ? Number.parseFloat(latencyMatch[1]) : null,
		speedMbps: speedMatch ? speedToMbps(Number.parseFloat(speedMatch[1]), speedMatch[2]) : null,
	};
}

function speedToMbps(value, unit) {
	if (!Number.isFinite(value)) return null;
	const normalized = String(unit || 'Mbps').toUpperCase();
	if (normalized === 'GB/S' || normalized === 'G/S') return value * 8192;
	if (normalized === 'MB/S' || normalized === 'M/S') return value * 8;
	if (normalized === 'KB/S' || normalized === 'K/S') return value / 128;
	if (normalized === 'GBPS') return value * 1000;
	if (normalized === 'KBPS') return value / 1000;
	return value;
}

function countBy(items, field) {
	return items.reduce((acc, item) => {
		const key = item[field] || 'UNKNOWN';
		acc[key] = (acc[key] || 0) + 1;
		return acc;
	}, {});
}

function countValues(items) {
	return items.reduce((acc, item) => {
		acc[item] = (acc[item] || 0) + 1;
		return acc;
	}, {});
}

function sourceHost(url) {
	try {
		return new URL(url).hostname;
	} catch {
		return 'source';
	}
}

function safeDecode(value) {
	try {
		return decodeURIComponent(String(value || '').replace(/\+/g, '%20'));
	} catch {
		return String(value || '');
	}
}

function parseArgs(argv) {
	const result = {};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (!arg.startsWith('--')) continue;
		const key = arg.slice(2);
		const next = argv[i + 1];
		if (next && !next.startsWith('--')) {
			result[key] = next;
			i++;
		} else {
			result[key] = '1';
		}
	}
	return result;
}

function listArg(value, fallback, upper) {
	if (!value) return fallback;
	const list = String(value)
		.split(/[,\s|;，、_-]+/)
		.map(item => item.trim())
		.filter(Boolean)
		.map(item => upper ? item.toUpperCase() : item);
	return list.length ? list : fallback;
}

function numberArg(value, fallback) {
	const num = Number.parseInt(value, 10);
	return Number.isFinite(num) && num >= 0 ? num : fallback;
}
