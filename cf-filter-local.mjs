import fs from 'node:fs/promises';
import tls from 'node:tls';
import {
	calculateLocalSpeedMbps,
	dedupeBySubnet,
	selectFinalNodes as selectFinalNodesStrict,
	selectionThresholds,
} from './cf-filter-core.mjs';

const SOURCES = [
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
	'https://addressesapi.090227.xyz/CloudFlareYes',
	'https://addressesapi.090227.xyz/cmcc-ipv6',
	'https://cf.090227.xyz/ct?ips=6',
	'https://cf.090227.xyz/cu',
	{
		url: 'https://www.wetest.vip/api/cf2dns/get_cloudflare_ip?key=o1zrmHAF&type=v4',
		parser: 'wetest',
	},
	{
		url: 'https://www.wetest.vip/api/cf2dns/get_cloudflare_ip?key=o1zrmHAF&type=v6',
		parser: 'wetest',
	},
	{
		url: 'https://api.hostmonit.com/get_optimization_ip',
		parser: 'hostmonit',
		method: 'POST',
		body: { key: 'iDetkOys' },
	},
	{
		url: 'https://api.hostmonit.com/get_optimization_ip',
		parser: 'hostmonit',
		method: 'POST',
		body: { key: 'iDetkOys', type: 'v6' },
	},
	'https://ipdb.api.030101.xyz/?type=bestcf&country=true',
	'https://addressesapi.090227.xyz/ct',
	'https://cdn.jsdelivr.net/gh/HandsomeMJZ/cfip@main/best_ips.txt',
	'https://cdn.jsdelivr.net/gh/HandsomeMJZ/cfip@main/full_ips.txt',
	{
		url: 'https://ip.164746.xyz/ipTop10.html',
		parser: 'iplist',
	},
	{
		url: 'https://cdn.jsdelivr.net/gh/ZhiXuanWang/cf-speed-dns@main/ipTop10.html',
		parser: 'iplist',
	},
];

const DEFAULT_PORTS = ['443', '8443', '2053', '2083', '2087', '2096'];
const FINE_COUNTRY_RESERVE = 5;
const SCORE_WEIGHTS = {
	speed: 120,
	metrics: 320,
	countryBase: 240,
	countryStep: 6,
	portBase: 120,
	portStep: 8,
	sourceBase: 90,
	sourceStep: 12,
	latencyDivisor: 8,
	probeDivisor: 4,
};

const COLO_COUNTRY = {
	HKG: 'HK', NRT: 'JP', KIX: 'JP', FUK: 'JP', SIN: 'SG', TPE: 'TW', ICN: 'KR',
	SJC: 'US', LAX: 'US', SEA: 'US', DFW: 'US', IAD: 'US', EWR: 'US', ORD: 'US', MIA: 'US', ATL: 'US', DEN: 'US',
	FRA: 'DE', MUC: 'DE', HAM: 'DE', AMS: 'NL', LHR: 'GB', MAN: 'GB', CDG: 'FR', MRS: 'FR',
	HEL: 'FI', ARN: 'SE', ZRH: 'CH', GVA: 'CH', WAW: 'PL', RIX: 'LV',
	YYZ: 'CA', YVR: 'CA', YUL: 'CA', SYD: 'AU', MEL: 'AU', BNE: 'AU', PER: 'AU',
	DME: 'RU', SVO: 'RU', LED: 'RU', BKK: 'TH', KUL: 'MY', SGN: 'VN', HAN: 'VN',
	BLR: 'IN', BOM: 'IN', DEL: 'IN', MAA: 'IN', CCU: 'IN', HYD: 'IN',
};

const COUNTRY_LABELS = {
	HK: '香港',
	JP: '日本',
	SG: '新加坡',
	TW: '台湾',
	US: '美国',
	KR: '韩国',
	DE: '德国',
	NL: '荷兰',
	GB: '英国',
	FR: '法国',
	FI: '芬兰',
	SE: '瑞典',
	CH: '瑞士',
	PL: '波兰',
	LV: '拉脱维亚',
	CA: '加拿大',
	AU: '澳大利亚',
	RU: '俄罗斯',
	TH: '泰国',
	MY: '马来西亚',
	VN: '越南',
	IN: '印度',
};
const DEFAULT_COUNTRIES = Object.keys(COUNTRY_LABELS);

const args = parseArgs(process.argv.slice(2));
const minKeepSpeed = numberArg(args.minSpeed ?? args['min-speed'], 10);
const rankBySource = (args.rankBySource ?? args['rank-by-source']) === '1';
const options = {
	limit: numberArg(args.limit, 150),
	scan: numberArg(args.scan, 4000),
	connectTimeout: numberArg(args.timeout, 2500),
	maxProbe: numberArg(args.maxProbe ?? args['max-probe'] ?? args.maxTcp ?? args['max-tcp'], 1800),
	minKeepSpeed,
	fallbackMinSpeed: numberArg(args.fallbackMinSpeed ?? args['fallback-min-speed'], Math.min(5, minKeepSpeed)),
	minSourceSpeed: numberArg(args.minSourceSpeed ?? args['min-source-speed'], minKeepSpeed),
	fallbackMinSourceSpeed: numberArg(args.fallbackMinSourceSpeed ?? args['fallback-min-source-speed'], Math.min(5, minKeepSpeed)),
	probeHost: args.probeHost || args['probe-host'] || 'speed.cloudflare.com',
	rankBySource,
	speedTest: !rankBySource && args.speedTest !== '0' && args['speed-test'] !== '0',
	speedScan: numberArg(args.speedScan ?? args['speed-scan'], 300),
	speedBytes: numberArg(args.speedBytes ?? args['speed-bytes'], 4 * 1024 * 1024),
	speedSamples: numberArg(args.speedSamples ?? args['speed-samples'], 2),
	speedTimeout: numberArg(args.speedTimeout ?? args['speed-timeout'], 8000),
	coarseScan: numberArg(args.coarseScan ?? args['coarse-scan'], 0),
	coarseBytes: numberArg(args.coarseBytes ?? args['coarse-bytes'], 128 * 1024),
	coarseTimeout: numberArg(args.coarseTimeout ?? args['coarse-timeout'], 3000),
	coarseConcurrency: numberArg(args.coarseConcurrency ?? args['coarse-concurrency'], 12),
	coarseMinSpeed: numberArg(args.coarseMinSpeed ?? args['coarse-min-speed'], 1),
	subnetLimit: numberArg(args.subnetLimit ?? args['subnet-limit'], 1),
	minSpeedMs: numberArg(args.minSpeedMs ?? args['min-speed-ms'], 50),
	concurrency: numberArg(args.concurrency, 120),
	speedConcurrency: numberArg(args.speedConcurrency ?? args['speed-concurrency'], 4),
	countries: listArg(args.countries, DEFAULT_COUNTRIES, true),
	ports: listArg(args.ports, DEFAULT_PORTS, false),
	balanced: args.balanced !== '0',
	strictMinSpeed: args.strictMinSpeed !== '0' && args['strict-min-speed'] !== '0',
	out: args.out || 'filtered-best-nodes.txt',
	json: args.json || 'filtered-best-nodes.json',
};

await run();

async function run() {
	const startedAt = Date.now();
	const progress = message => console.error(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${message}`);
	const stageProgress = (stage, step = 250) => (completed, total) => {
		if (completed % step === 0 || completed === total) progress(`${stage} ${completed}/${total}`);
	};
	const fetched = await fetchSources(SOURCES);
	progress(`sources ok=${fetched.filter(item => item.ok).length}/${fetched.length}`);
	const parsed = dedupeCandidates(fetched.flatMap(source => parseSource(source)));
	const scoped = applyStaticFilters(parsed, options);
	const queue = selectCheckQueue(scoped, options);
	progress(`parsed=${parsed.length} scoped=${scoped.length} traceQueue=${queue.length}`);
	const checked = await checkCandidates(queue, options, stageProgress('trace'));
	const usable = filterUsableChecked(checked, options);
	const subnetPool = dedupeBySubnet(usable, { limit: options.subnetLimit, compareFn: compareProbeMs });
	progress(`usable=${usable.length} subnetPool=${subnetPool.length}`);
	const coarseQueue = options.speedTest ? selectCoarseQueue(subnetPool, options) : [];
	const coarseTested = options.speedTest ? await coarseTestCandidates(coarseQueue, options, stageProgress('coarse')) : [];
	const coarsePassed = coarseTested.filter(item => Number.isFinite(item.coarseSpeedMbps) && item.coarseSpeedMbps >= options.coarseMinSpeed);
	if (options.speedTest) progress(`coarsePassed=${coarsePassed.length}/${coarseQueue.length}`);
	const speedQueue = options.speedTest ? selectFineQueue(coarsePassed, options) : subnetPool;
	if (options.speedTest) progress(`fineQueue=${speedQueue.length}`);
	const measured = options.speedTest ? await speedTestCandidates(speedQueue, options, stageProgress('fine', 25)) : subnetPool;
	const speedUsable = options.speedTest ? measured.filter(item => Number.isFinite(item.localSpeedMbps)) : measured;
	const selected = selectFinalNodes(speedUsable, options);
	const context = { startedAt, fetched, parsed, scoped, queue, checked, usable, subnetPool, coarseQueue, coarsePassed, speedQueue, measured, speedUsable, selected, options };

	await writeOutputs(context);
	printSummary(context);
}

async function writeOutputs(context) {
	await fs.writeFile(context.options.out, formatNodeLines(context.selected).join('\n') + (context.selected.length ? '\n' : ''), 'utf8');
	await fs.writeFile(context.options.json, JSON.stringify(buildReport(context), null, 2), 'utf8');
}

function buildReport({ startedAt, fetched, parsed, scoped, queue, checked, usable, subnetPool, coarseQueue, coarsePassed, speedQueue, measured, speedUsable, selected, options }) {
	return {
		generatedAt: new Date().toISOString(),
		elapsedMs: Date.now() - startedAt,
		sources: fetched.map(formatSourceSummary),
		options,
		stats: buildStats({ parsed, scoped, queue, checked, usable, subnetPool, coarseQueue, coarsePassed, speedQueue, measured, speedUsable, selected, options }),
		nodes: selected,
	};
}

function buildStats({ parsed, scoped, queue, checked, usable, subnetPool, coarseQueue, coarsePassed, speedQueue, measured, speedUsable, selected, options }) {
	const thresholds = selectionThresholds(options);
	return {
		parsed: parsed.length,
		scoped: scoped.length,
		queued: queue.length,
		checked: checked.length,
		usable: usable.length,
		subnetPool: subnetPool.length,
		coarseQueued: coarseQueue.length,
		coarsePassed: coarsePassed.length,
		speedQueued: speedQueue.length,
		speedTested: measured.length,
		speedUsable: speedUsable.length,
		selected: selected.length,
		highSpeedUsable: speedUsable.filter(item => isHighSpeed(item, thresholds.minKeepSpeed)).length,
		highSpeedSelected: selected.filter(item => isHighSpeed(item, thresholds.minKeepSpeed)).length,
		fallbackSpeedSelected: selected.filter(item => !isHighSpeed(item, thresholds.minKeepSpeed) && isHighSpeed(item, thresholds.fallbackMinSpeed)).length,
		countryDistribution: countBy(selected, 'country'),
		portDistribution: countBy(selected, 'port'),
	};
}

function formatSourceSummary(item) {
	return {
		url: item.url,
		parser: item.parser,
		method: item.method,
		ok: item.ok,
		status: item.status,
		bytes: item.text?.length || 0,
		error: item.error || null,
	};
}

function printSummary({ parsed, scoped, queue, checked, usable, subnetPool, coarseQueue, coarsePassed, speedQueue, speedUsable, selected, options }) {
	const thresholds = selectionThresholds(options);
	console.log(`parsed=${parsed.length} scoped=${scoped.length} queued=${queue.length} checked=${checked.length} usable=${usable.length}`);
	console.log(`subnetPool=${subnetPool.length} coarseQueued=${coarseQueue.length} coarsePassed>=${options.coarseMinSpeed}Mbps=${coarsePassed.length} fineQueued=${speedQueue.length} speedUsable=${speedUsable.length} selected=${selected.length}`);
	console.log(`highSpeed>${thresholds.minKeepSpeed}Mbps usable=${speedUsable.filter(item => isHighSpeed(item, thresholds.minKeepSpeed)).length} selected=${selected.filter(item => isHighSpeed(item, thresholds.minKeepSpeed)).length}`);
	console.log(`fallback>=${thresholds.fallbackMinSpeed}Mbps selected=${selected.filter(item => !isHighSpeed(item, thresholds.minKeepSpeed) && isHighSpeed(item, thresholds.fallbackMinSpeed)).length}`);
	console.log(`countries=${JSON.stringify(countBy(selected, 'country'))}`);
	console.log(`ports=${JSON.stringify(countBy(selected, 'port'))}`);
	console.log(`wrote ${options.out}`);
	console.log(`wrote ${options.json}`);
	console.log(formatNodeLines(selected.slice(0, 12)).join('\n'));
}

async function fetchSources(urls) {
	return mapConcurrent(urls, 8, (source, sourceIndex) => fetchSource(source, sourceIndex));
}

async function mapConcurrent(items, concurrency, mapper, onProgress) {
	const results = new Array(items.length);
	let index = 0;
	let completed = 0;
	const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
		while (index < items.length) {
			const current = index++;
			results[current] = await mapper(items[current], current);
			completed++;
			if (onProgress) onProgress(completed, items.length);
		}
	});
	await Promise.all(workers);
	return results;
}

async function fetchSource(url, sourceIndex) {
	const source = normalizeSource(url);
	for (let attempt = 1; attempt <= 2; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 15000);
		try {
			const response = await fetch(source.url, {
				method: source.method,
				signal: controller.signal,
				headers: source.headers,
				body: source.body ? JSON.stringify(source.body) : undefined,
			});
			const text = response.ok ? await response.text() : '';
			return { ...source, sourceIndex, ok: response.ok, status: response.status, text };
		} catch (error) {
			if (attempt === 2) {
				return {
					...source,
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

function normalizeSource(source) {
	if (typeof source === 'string') {
		return {
			url: source,
			parser: 'text',
			method: 'GET',
			headers: { 'User-Agent': 'filtered-cf-nodes/1.0' },
		};
	}
	const method = source.method || 'GET';
	return {
		...source,
		parser: source.parser || 'text',
		method,
		headers: {
			'User-Agent': 'filtered-cf-nodes/1.0',
			...(source.body ? { 'Content-Type': 'application/json' } : {}),
			...(source.headers || {}),
		},
	};
}

function parseSource(source) {
	if (!source.ok) return [];
	if (source.parser === 'wetest') return parseWeTestSource(source);
	if (source.parser === 'hostmonit') return parseHostMonitSource(source);
	if (source.parser === 'iplist') return parseIpListSource(source);
	return parseTextSource(source);
}

function parseIpListSource({ text, url, sourceIndex }) {
	const rows = [];
	for (const token of String(text || '').split(/[\s,;]+/)) {
		const row = parseLine(token, url, sourceIndex);
		if (row) rows.push(row);
	}
	return rows;
}

function parseTextSource({ text, url, sourceIndex }) {
	const rows = [];
	for (const rawLine of String(text || '').split(/\r?\n/)) {
		const row = parseLine(rawLine, url, sourceIndex);
		if (row) rows.push(row);
	}
	return rows;
}

function parseWeTestSource({ text, url, sourceIndex }) {
	const data = parseJson(text);
	const groups = data?.info && typeof data.info === 'object' ? Object.entries(data.info) : [];
	return groups.flatMap(([group, items]) => Array.isArray(items)
		? items.map(item => makeStructuredCandidate({
			host: item.ip,
			country: COLO_COUNTRY[item.colo] || '',
			remark: `${item.line_name || group}-${item.colo || 'CF'}`,
			sourceUrl: url,
			sourceIndex,
			latencyMs: numberOrNull(item.rtt_avg),
			speedMbps: numberOrNull(item.bandwidth) ?? speedToMbps(numberOrNull(item.speed), 'KB/S'),
			meta: {
				sourceType: 'wetest',
				line: item.line,
				lineName: item.line_name,
				cfColo: item.colo,
				lossRate: numberOrNull(item.loss_rate),
				updatedAt: item.updated_at || null,
			},
		})).filter(Boolean)
		: []);
}

function parseHostMonitSource({ text, url, sourceIndex }) {
	const data = parseJson(text);
	const items = Array.isArray(data?.info) ? data.info : [];
	return items.map(item => makeStructuredCandidate({
		host: item.ip,
		country: COLO_COUNTRY[item.colo] || '',
		remark: `${item.line || 'CF'}-${item.colo || item.node || 'Default'}`,
		sourceUrl: url,
		sourceIndex,
		latencyMs: numberOrNull(item.latency),
		speedMbps: speedToMbps(numberOrNull(item.speed), 'KB/S'),
		meta: {
			sourceType: 'hostmonit',
			line: item.line,
			node: item.node,
			cfColo: item.colo,
			lossRate: numberOrNull(item.loss),
			updatedAt: item.time || null,
		},
	})).filter(Boolean);
}

function makeStructuredCandidate({ host, country, remark, sourceUrl, sourceIndex, latencyMs, speedMbps, meta }) {
	if (!host) return null;
	const port = '443';
	const cleanHost = String(host).replace(/^\[|\]$/g, '').trim();
	return {
		host: cleanHost,
		port,
		country,
		remark,
		sourceUrl,
		sourceIndex,
		latencyMs,
		speedMbps,
		line: `${formatEndpoint({ host: cleanHost, port })}#${remark || country || sourceHost(sourceUrl)}`,
		...meta,
	};
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
		line: `${formatEndpoint({ host, port })}#${remark || country || sourceHost(sourceUrl)}`,
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

async function checkCandidates(candidates, { concurrency, connectTimeout, probeHost, rankBySource }, onProgress) {
	return mapConcurrent(candidates, concurrency, item => checkCloudflareTrace(item, connectTimeout, probeHost, rankBySource), onProgress);
}

function checkCloudflareTrace(candidate, timeoutMs, probeHost, preserveCountry = false) {
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
			clearTimeout(hardTimer);
			socket.destroy();
			const cfColo = extractTraceField(responseText, 'colo');
			resolve({
				...candidate,
				ok,
				probeMs: Date.now() - start,
				country: preserveCountry && candidate.country ? candidate.country : (COLO_COUNTRY[cfColo] || candidate.country || ''),
				cfColo,
				cfIp: extractTraceField(responseText, 'ip'),
				error,
			});
		};
		const hardTimer = setTimeout(() => done(false, 'hard-timeout'), timeoutMs * 2);
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
	return selectPriorityFill(candidates, {
		targetSize: Math.max(options.scan, options.limit),
		minKeepSpeed: options.minKeepSpeed,
		balanced: options.balanced,
		countries: options.countries,
		compareFn: compareCandidateScore,
	});
}

function filterUsableChecked(items, { countries, maxProbe }) {
	const countrySet = new Set(countries);
	return items.filter(item => {
		const countryOk = countrySet.size === 0 || countrySet.has(item.country);
		return item.ok && item.probeMs <= maxProbe && countryOk;
	});
}

function selectFinalNodes(candidates, options) {
	return selectFinalNodesStrict(candidates, options);
}

function selectCoarseQueue(candidates, options) {
	const sorted = [...candidates].sort(compareProbeMs);
	return options.coarseScan > 0 ? sorted.slice(0, options.coarseScan) : sorted;
}

function selectFineQueue(candidates, options) {
	const sorted = [...candidates].sort((a, b) => (b.coarseSpeedMbps || 0) - (a.coarseSpeedMbps || 0));
	const queue = new Map();
	for (const item of sorted.slice(0, Math.max(options.speedScan, options.limit))) {
		queue.set(candidateKey(item), item);
	}
	if (options.balanced) {
		const reserved = new Map();
		for (const item of sorted) {
			const count = reserved.get(item.country) || 0;
			if (count >= FINE_COUNTRY_RESERVE) continue;
			reserved.set(item.country, count + 1);
			queue.set(candidateKey(item), item);
		}
	}
	return [...queue.values()];
}

function compareProbeMs(a, b) {
	return (a.probeMs || 9999) - (b.probeMs || 9999);
}

async function coarseTestCandidates(candidates, { coarseConcurrency, coarseTimeout, coarseBytes, probeHost }, onProgress) {
	const tested = await mapConcurrent(candidates, coarseConcurrency, item => testDownloadSpeed(item, coarseTimeout, coarseBytes, probeHost, 0), onProgress);
	return tested.map(({ localSpeedMbps, speedOk, speedMs, speedBytes, speedError, ...rest }) => ({
		...rest,
		coarseSpeedMbps: localSpeedMbps,
		coarseMs: speedMs,
		coarseError: speedError,
	}));
}

async function speedTestCandidates(candidates, options, onProgress) {
	return mapConcurrent(candidates, options.speedConcurrency, item => testDownloadSpeedBest(item, options), onProgress);
}

async function testDownloadSpeedBest(candidate, { speedSamples, speedTimeout, speedBytes, probeHost, minSpeedMs }) {
	let best = null;
	for (let sample = 0; sample < Math.max(1, speedSamples); sample++) {
		const result = await testDownloadSpeed(candidate, speedTimeout, speedBytes, probeHost, minSpeedMs);
		if (!best || (result.localSpeedMbps ?? -1) > (best.localSpeedMbps ?? -1)) best = result;
		if (!result.speedBytes) break;
	}
	return best;
}

function selectPriorityFill(candidates, { targetSize, minKeepSpeed, balanced, countries, compareFn, maxSize = Infinity }) {
	const selected = new Map();
	const highSpeed = candidates
		.filter(item => isHighSpeed(item, minKeepSpeed))
		.sort(compareFn);
	for (const item of highSpeed) {
		if (selected.size >= maxSize) break;
		selected.set(candidateKey(item), item);
	}

	const rest = candidates.filter(item => !selected.has(candidateKey(item)));
	const fillLimit = Math.max(0, Math.min(targetSize, maxSize) - selected.size);
	const fill = balanced
		? balancedTake(groupAndSort(rest, compareFn), fillLimit, countries)
		: rest.sort(compareFn).slice(0, fillLimit);
	for (const item of fill) {
		if (selected.size >= maxSize) break;
		selected.set(candidateKey(item), item);
	}
	return [...selected.values()];
}

function testDownloadSpeed(candidate, timeoutMs, bytes, probeHost, minSpeedMs) {
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
			clearTimeout(hardTimer);
			socket.destroy();
			const elapsedMs = Math.max(1, Date.now() - (bodyStartAt || start));
			const localSpeedMbps = ok ? calculateLocalSpeedMbps({ bodyBytes, elapsedMs, minElapsedMs: minSpeedMs }) : null;
			const speedOk = ok && Number.isFinite(localSpeedMbps);
			resolve({
				...candidate,
				speedOk,
				speedMs: elapsedMs,
				speedBytes: bodyBytes,
				localSpeedMbps,
				speedError: speedOk ? error : (error || 'speed-sample-too-short'),
			});
		};
		const hardTimer = setTimeout(() => done(bodyBytes > 0, bodyBytes > 0 ? null : 'hard-timeout'), timeoutMs * 2);
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
	return measuredSpeedMbps(item) >= threshold;
}

function candidateKey(item) {
	return `${item.host}:${item.port}`;
}

function compareCandidateScore(a, b) {
	return scoreCandidate(b) - scoreCandidate(a);
}

function scoreCandidate(item) {
	const speed = measuredSpeedMbps(item);
	const latency = Number.isFinite(item.latencyMs) ? item.latencyMs : 9999;
	const countryBonus = orderedBonus(item.country, DEFAULT_COUNTRIES, SCORE_WEIGHTS.countryBase, SCORE_WEIGHTS.countryStep);
	const portBonus = orderedBonus(item.port, DEFAULT_PORTS, SCORE_WEIGHTS.portBase, SCORE_WEIGHTS.portStep);
	const sourceBonus = Math.max(0, SCORE_WEIGHTS.sourceBase - item.sourceIndex * SCORE_WEIGHTS.sourceStep);
	const metricsBonus = Number.isFinite(item.speedMbps) || Number.isFinite(item.latencyMs) ? SCORE_WEIGHTS.metrics : 0;
	return speed * SCORE_WEIGHTS.speed + metricsBonus + countryBonus + portBonus + sourceBonus - latency / SCORE_WEIGHTS.latencyDivisor;
}

function orderedBonus(value, orderedValues, base, step) {
	const index = orderedValues.indexOf(value);
	return index === -1 ? 0 : Math.max(0, base - index * step);
}

function formatNodeLines(items) {
	return items.map(item => `${formatEndpoint(item)}#${formatNodeLabel(item)}`);
}

function formatNodeLabel(item) {
	const country = COUNTRY_LABELS[item.country] || item.country || '未知';
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

function formatEndpoint({ host, port }) {
	const formattedHost = String(host).includes(':') ? `[${host}]` : host;
	return `${formattedHost}:${port}`;
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

function parseJson(text) {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function numberOrNull(value) {
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
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
