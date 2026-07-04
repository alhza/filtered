import fs from 'node:fs/promises';
import net from 'node:net';

const MASTER_APIS = [
	'https://ips.gaoji.uk/best_ips.txt',
	'https://raw.githubusercontent.com/svip-s/cloudflare_ip/refs/heads/main/best_ips.txt',
	'https://raw.githubusercontent.com/love-ztm/cfip/refs/heads/main/best_ips.txt',
	'https://bestcf.pages.dev/uouin/all.txt',
	'https://zip.cm.edu.kg/all.txt',
];

const DEFAULT_COUNTRIES = [
	'HK', 'JP', 'SG', 'TW', 'US', 'KR', 'DE', 'NL', 'GB', 'FR', 'FI', 'SE',
	'CH', 'PL', 'LV', 'CA', 'AU', 'RU', 'TH', 'MY', 'VN', 'IN',
];
const DEFAULT_PORTS = ['443', '8443', '2053', '2083', '2087', '2096'];

const args = parseArgs(process.argv.slice(2));
const options = {
	limit: numberArg(args.limit, 150),
	scan: numberArg(args.scan, 4000),
	connectTimeout: numberArg(args.timeout, 1600),
	maxTcp: numberArg(args.maxTcp ?? args['max-tcp'], 800),
	minKeepSpeed: numberArg(args.minSpeed ?? args['min-speed'], 10),
	concurrency: numberArg(args.concurrency, 120),
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
const usable = checked.filter(item => item.ok && item.checkMs <= options.maxTcp);
const selected = selectFinalNodes(usable, options);

await fs.writeFile(options.out, selected.map(formatNodeLine).join('\n') + (selected.length ? '\n' : ''), 'utf8');
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
		selected: selected.length,
		highSpeedQueued: queue.filter(item => isHighSpeed(item, options.minKeepSpeed)).length,
		highSpeedUsable: usable.filter(item => isHighSpeed(item, options.minKeepSpeed)).length,
		highSpeedSelected: selected.filter(item => isHighSpeed(item, options.minKeepSpeed)).length,
		countryDistribution: countBy(selected, 'country'),
		portDistribution: countBy(selected, 'port'),
	},
	nodes: selected,
}, null, 2), 'utf8');

console.log(`parsed=${parsed.length} scoped=${scoped.length} queued=${queue.length} checked=${checked.length} usable=${usable.length} selected=${selected.length}`);
console.log(`highSpeed>${options.minKeepSpeed}Mbps queued=${queue.filter(item => isHighSpeed(item, options.minKeepSpeed)).length} usable=${usable.filter(item => isHighSpeed(item, options.minKeepSpeed)).length} selected=${selected.filter(item => isHighSpeed(item, options.minKeepSpeed)).length}`);
console.log(`countries=${JSON.stringify(countBy(selected, 'country'))}`);
console.log(`ports=${JSON.stringify(countBy(selected, 'port'))}`);
console.log(`wrote ${options.out}`);
console.log(`wrote ${options.json}`);
console.log(selected.slice(0, 12).map(formatNodeLine).join('\n'));

async function fetchSources(urls) {
	const results = await Promise.allSettled(urls.map(async (url, sourceIndex) => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 20000);
		try {
			const response = await fetch(url, {
				signal: controller.signal,
				headers: { 'User-Agent': 'filtered-cf-nodes/1.0' },
			});
			const text = response.ok ? await response.text() : '';
			return { url, sourceIndex, ok: response.ok, status: response.status, text };
		} finally {
			clearTimeout(timer);
		}
	}));

	return results.map((result, sourceIndex) => {
		if (result.status === 'fulfilled') return result.value;
		return {
			url: urls[sourceIndex],
			sourceIndex,
			ok: false,
			status: 0,
			text: '',
			error: result.reason?.message || String(result.reason),
		};
	});
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
	if (!match) return null;

	const host = match[1].replace(/^\[|\]$/g, '');
	const port = match[2];
	const remark = safeDecode(match[3] || '');
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
		const countryOk = countrySet.size === 0 || countrySet.has(item.country);
		const portOk = portSet.size === 0 || portSet.has(item.port);
		return countryOk && portOk;
	});
}

async function checkCandidates(candidates, { concurrency, connectTimeout }) {
	const results = [];
	let index = 0;
	const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
		while (index < candidates.length) {
			const item = candidates[index++];
			results.push(await checkTcp(item, connectTimeout));
		}
	});
	await Promise.all(workers);
	return results;
}

function checkTcp(candidate, timeoutMs) {
	return new Promise(resolve => {
		const start = Date.now();
		const socket = net.createConnection({ host: candidate.host, port: Number(candidate.port) });
		let finished = false;
		const done = (ok, error = null) => {
			if (finished) return;
			finished = true;
			socket.destroy();
			resolve({
				...candidate,
				ok,
				checkMs: Date.now() - start,
				error,
			});
		};
		socket.setTimeout(timeoutMs);
		socket.once('connect', () => done(true));
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
	return Number.isFinite(item.speedMbps) && item.speedMbps > threshold;
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
	return (a.checkMs || 9999) - (b.checkMs || 9999);
}

function scoreChecked(item) {
	return scoreCandidate(item) - (item.checkMs || 9999) / 4;
}

function scoreCandidate(item) {
	const speed = Number.isFinite(item.speedMbps) ? item.speedMbps : 0;
	const latency = Number.isFinite(item.latencyMs) ? item.latencyMs : 9999;
	const countryBonus = DEFAULT_COUNTRIES.includes(item.country) ? 240 - DEFAULT_COUNTRIES.indexOf(item.country) * 6 : 0;
	const portBonus = DEFAULT_PORTS.includes(item.port) ? 120 - DEFAULT_PORTS.indexOf(item.port) * 8 : 0;
	const sourceBonus = Math.max(0, 90 - item.sourceIndex * 12);
	const metricsBonus = Number.isFinite(item.speedMbps) || Number.isFinite(item.latencyMs) ? 320 : 0;
	return speed * 120 + metricsBonus + countryBonus + portBonus + sourceBonus - latency / 8;
}

function formatNodeLine(item) {
	const tags = [];
	if (item.country) tags.push(item.country);
	if (Number.isFinite(item.latencyMs)) tags.push(`${Math.round(item.latencyMs)}ms`);
	if (Number.isFinite(item.speedMbps)) tags.push(`${Math.round(item.speedMbps)}Mbps`);
	tags.push(`tcp${item.checkMs}ms`);
	return `${item.host}:${item.port}#${tags.join(' ')}`;
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
