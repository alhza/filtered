import { randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import tls from 'node:tls';
import {
	aggregateProbeAttempts,
	aggregateSpeedAttempts,
	calculateLocalSpeedMbps,
	compareCandidateScore,
	compareCheckedScore,
	DEFAULT_COUNTRIES,
	DEFAULT_PORTS,
	isHighSpeed,
	measuredSpeedMbps,
	selectFinalNodes,
	selectPriorityFill,
	validateCloudflareTraceResponse,
	validateWebSocketUpgradeResponse,
} from './cf-filter-core.mjs';

const SOURCES = [
	'https://ips.gaoji.uk/best_ips.txt',
	'https://raw.githubusercontent.com/love-ztm/cfip/refs/heads/main/best_ips.txt',
	'https://raw.githubusercontent.com/HandsomeMJZ/cfip/main/full_ips.txt',
	'https://zip.cm.edu.kg/all.txt',
];

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
const args = parseArgs(process.argv.slice(2));
const minKeepSpeed = numberArg(args.minSpeed ?? args['min-speed'], 10);
const edgeHost = firstText(args.edgeHost, args['edge-host'], process.env.EDGETUNNEL_HOST);
const edgePath = normalizePath(firstText(args.edgePath, args['edge-path'], process.env.EDGETUNNEL_PATH));
const options = {
	limit: numberArg(args.limit, 150),
	scan: numberArg(args.scan, 4000),
	connectTimeout: numberArg(args.timeout, 1600),
	maxProbe: numberArg(args.maxProbe ?? args['max-probe'] ?? args.maxTcp ?? args['max-tcp'], 1200),
	probeAttempts: positiveNumberArg(args.probeAttempts ?? args['probe-attempts'], 3),
	minProbeSuccesses: positiveNumberArg(args.minProbeSuccesses ?? args['min-probe-successes'], 2),
	minKeepSpeed,
	fallbackMinSpeed: numberArg(args.fallbackMinSpeed ?? args['fallback-min-speed'], minKeepSpeed),
	traceHost: firstText(args.traceHost, args['trace-host'], edgeHost, process.env.CF_TRACE_HOST, args.probeHost, args['probe-host']) || 'speed.cloudflare.com',
	speedHost: firstText(args.speedHost, args['speed-host'], process.env.CF_SPEED_HOST) || 'speed.cloudflare.com',
	edgeHost,
	edgePath,
	edgeAttempts: positiveNumberArg(args.edgeAttempts ?? args['edge-attempts'], 3),
	minEdgeSuccesses: positiveNumberArg(args.minEdgeSuccesses ?? args['min-edge-successes'], 2),
	speedTest: args.speedTest !== '0' && args['speed-test'] !== '0',
	speedScan: numberArg(args.speedScan ?? args['speed-scan'], 200),
	speedBytes: numberArg(args.speedBytes ?? args['speed-bytes'], 1024 * 1024),
	speedTimeout: numberArg(args.speedTimeout ?? args['speed-timeout'], 6000),
	speedAttempts: positiveNumberArg(args.speedAttempts ?? args['speed-attempts'], 3),
	minSpeedSuccesses: positiveNumberArg(args.minSpeedSuccesses ?? args['min-speed-successes'], 2),
	minSpeedMs: numberArg(args.minSpeedMs ?? args['min-speed-ms'], 50),
	concurrency: numberArg(args.concurrency, 120),
	speedConcurrency: numberArg(args.speedConcurrency ?? args['speed-concurrency'], 8),
	edgeConcurrency: numberArg(args.edgeConcurrency ?? args['edge-concurrency'], 16),
	minSourceSuccesses: positiveNumberArg(args.minSourceSuccesses ?? args['min-source-successes'], 2),
	minOutput: numberArg(args.minOutput ?? args['min-output'], 1),
	countries: listArg(args.countries, DEFAULT_COUNTRIES, true),
	ports: listArg(args.ports, DEFAULT_PORTS, false),
	balanced: args.balanced !== '0',
	strictMinSpeed: args.strictMinSpeed !== '0' && args['strict-min-speed'] !== '0',
	out: args.out || 'filtered-best-nodes.txt',
	json: args.json || 'filtered-best-nodes.json',
};

validateOptions(options);
await run();

async function run() {
	const startedAt = Date.now();
	const fetched = await fetchSources(SOURCES);
	const sourceSuccesses = fetched.filter(source => source.ok).length;
	if (sourceSuccesses < options.minSourceSuccesses) {
		throw new Error(`Only ${sourceSuccesses}/${SOURCES.length} upstream sources succeeded; refusing to replace published nodes.`);
	}
	const parsed = dedupeCandidates(fetched.flatMap(source => source.ok ? parseTextSource(source) : []));
	const scoped = applyStaticFilters(parsed, options);
	const queue = selectCheckQueue(scoped, options);
	const checked = await checkCandidates(queue, options);
	const usable = filterUsableChecked(checked, options);
	const edgeEnabled = Boolean(options.edgeHost && options.edgePath);
	const speedQueue = options.speedTest || edgeEnabled ? selectSpeedQueue(usable, options) : usable;
	const edgeChecked = edgeEnabled ? await checkEdgeCandidates(speedQueue, options) : [];
	const edgeUsable = edgeEnabled ? edgeChecked.filter(item => item.edgeOk) : speedQueue;
	const measured = options.speedTest ? await speedTestCandidates(edgeUsable, options) : edgeUsable;
	const speedUsable = options.speedTest ? measured.filter(item => item.speedOk) : measured;
	const selected = selectFinalNodes(speedUsable, options);
	if (selected.length < options.minOutput) {
		throw new Error(`Only ${selected.length} nodes passed; minimum output is ${options.minOutput}. Previous published results remain unchanged.`);
	}
	const context = { startedAt, fetched, parsed, scoped, queue, checked, usable, speedQueue, edgeEnabled, edgeChecked, edgeUsable, measured, speedUsable, selected, options };

	await writeOutputs(context);
	printSummary(context);
}

async function writeOutputs(context) {
	await fs.writeFile(context.options.out, formatNodeLines(context.selected).join('\n') + (context.selected.length ? '\n' : ''), 'utf8');
	await fs.writeFile(context.options.json, JSON.stringify(buildReport(context), null, 2), 'utf8');
}

function buildReport({ startedAt, fetched, parsed, scoped, queue, checked, usable, speedQueue, edgeEnabled, edgeChecked, edgeUsable, measured, speedUsable, selected, options }) {
	return {
		generatedAt: new Date().toISOString(),
		elapsedMs: Date.now() - startedAt,
		sources: fetched.map(formatSourceSummary),
		options: publicOptions(options),
		stats: buildStats({ parsed, scoped, queue, checked, usable, speedQueue, edgeEnabled, edgeChecked, edgeUsable, measured, speedUsable, selected, options }),
		nodes: selected,
	};
}

function buildStats({ parsed, scoped, queue, checked, usable, speedQueue, edgeEnabled, edgeChecked, edgeUsable, measured, speedUsable, selected, options }) {
	return {
		parsed: parsed.length,
		scoped: scoped.length,
		queued: queue.length,
		checked: checked.length,
		usable: usable.length,
		edgeEnabled,
		edgeQueued: edgeEnabled ? speedQueue.length : 0,
		edgeChecked: edgeChecked.length,
		edgeUsable: edgeEnabled ? edgeUsable.length : 0,
		speedQueued: edgeUsable.length,
		speedTested: measured.length,
		speedUsable: speedUsable.length,
		selected: selected.length,
		highSpeedQueued: queue.filter(item => isHighSpeed(item, options.minKeepSpeed)).length,
		highSpeedUsable: speedUsable.filter(item => isHighSpeed(item, options.minKeepSpeed)).length,
		highSpeedSelected: selected.filter(item => isHighSpeed(item, options.minKeepSpeed)).length,
		fallbackSpeedSelected: selected.filter(item => !isHighSpeed(item, options.minKeepSpeed) && isHighSpeed(item, options.fallbackMinSpeed)).length,
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

function printSummary({ parsed, scoped, queue, checked, usable, edgeEnabled, edgeUsable, speedUsable, selected, options }) {
	console.log(`parsed=${parsed.length} scoped=${scoped.length} queued=${queue.length} checked=${checked.length} usable=${usable.length} edge=${edgeEnabled ? edgeUsable.length : 'disabled'} speedQueued=${edgeUsable.length} speedUsable=${speedUsable.length} selected=${selected.length}`);
	console.log(`highSpeed>${options.minKeepSpeed}Mbps queued=${queue.filter(item => isHighSpeed(item, options.minKeepSpeed)).length} usable=${speedUsable.filter(item => isHighSpeed(item, options.minKeepSpeed)).length} selected=${selected.filter(item => isHighSpeed(item, options.minKeepSpeed)).length}`);
	console.log(`fallback>=${options.fallbackMinSpeed}Mbps selected=${selected.filter(item => !isHighSpeed(item, options.minKeepSpeed) && isHighSpeed(item, options.fallbackMinSpeed)).length}`);
	console.log(`countries=${JSON.stringify(countBy(selected, 'country'))}`);
	console.log(`ports=${JSON.stringify(countBy(selected, 'port'))}`);
	console.log(`wrote ${options.out}`);
	console.log(`wrote ${options.json}`);
	console.log(formatNodeLines(selected.slice(0, 12)).join('\n'));
}

async function fetchSources(urls) {
	return mapConcurrent(urls, 4, (source, sourceIndex) => fetchSource(source, sourceIndex));
}

async function mapConcurrent(items, concurrency, mapper) {
	const results = new Array(items.length);
	let index = 0;
	const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
		while (index < items.length) {
			const current = index++;
			results[current] = await mapper(items[current], current);
		}
	});
	await Promise.all(workers);
	return results;
}

async function fetchSource(url, sourceIndex) {
	const source = {
		url,
		parser: 'text',
		method: 'GET',
		headers: { 'User-Agent': 'filtered-cf-nodes/1.0' },
	};
	for (let attempt = 1; attempt <= 3; attempt++) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 45000);
		try {
			const response = await fetch(source.url, {
				signal: controller.signal,
				headers: source.headers,
			});
			const text = response.ok ? await response.text() : '';
			return { ...source, sourceIndex, ok: response.ok, status: response.status, text };
		} catch (error) {
			if (attempt === 3) {
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

function parseTextSource({ text, url, sourceIndex }) {
	const rows = [];
	for (const rawLine of String(text || '').split(/\r?\n/)) {
		const row = parseLine(rawLine, url, sourceIndex);
		if (row) rows.push(row);
	}
	return rows;
}

function parseLine(rawLine, sourceUrl, sourceIndex) {
	const line = String(rawLine || '').trim();
	if (!line || line.startsWith('#') || line.startsWith('//')) return null;

	const ipOnlyMatch = line.match(/^((?:\d{1,3}\.){3}\d{1,3}|\[[0-9a-fA-F:]+\]|[0-9a-fA-F:]{6,})(?:#(.+))?$/);
	const match = ipOnlyMatch ? null : line.match(/^(\[[0-9a-fA-F:]+\]|[A-Za-z0-9.-]+):(\d{2,5})(?:#(.+))?/);
	if (!match && !ipOnlyMatch) return null;

	const host = (ipOnlyMatch ? ipOnlyMatch[1] : match[1]).replace(/^\[|\]$/g, '');
	const port = ipOnlyMatch ? '443' : match[2];
	const remark = safeDecode((ipOnlyMatch ? ipOnlyMatch[2] : match[3]) || '');
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

async function checkCandidates(candidates, options) {
	return mapConcurrent(candidates, options.concurrency, item => checkCloudflareTrace(item, options));
}

async function checkCloudflareTrace(candidate, options) {
	const attempts = [];
	for (let attempt = 0; attempt < options.probeAttempts; attempt++) {
		attempts.push(await probeCloudflareTraceOnce(candidate, options.connectTimeout, options.traceHost));
	}
	const summary = aggregateProbeAttempts(attempts, options.minProbeSuccesses);
	return {
		...candidate,
		...summary,
		country: COLO_COUNTRY[summary.cfColo] || candidate.country || '',
	};
}

function publicOptions(options) {
	const { edgePath, ...safeOptions } = options;
	return {
		...safeOptions,
		edgePathConfigured: Boolean(edgePath),
	};
}

function probeCloudflareTraceOnce(candidate, timeoutMs, traceHost) {
	return new Promise(resolve => {
		const start = Date.now();
		const socket = tls.connect({
			host: candidate.host,
			port: Number(candidate.port),
			servername: traceHost,
			rejectUnauthorized: true,
			minVersion: 'TLSv1.2',
			ALPNProtocols: ['http/1.1'],
		});
		let responseText = '';
		let finished = false;
		const done = result => {
			if (finished) return;
			finished = true;
			socket.destroy();
			resolve({ probeMs: Date.now() - start, ...result });
		};
		const finishResponse = () => {
			const validation = validateCloudflareTraceResponse(responseText, traceHost);
			done(validation.ok
				? { ok: true, cfColo: validation.fields.colo, cfIp: validation.fields.ip, error: null }
				: { ok: false, cfColo: '', cfIp: '', error: validation.error });
		};
		socket.setTimeout(timeoutMs);
		socket.once('secureConnect', () => {
			socket.write(`GET /cdn-cgi/trace HTTP/1.1\r\nHost: ${traceHost}\r\nUser-Agent: filtered-cf-nodes/1.0\r\nAccept: text/plain\r\nConnection: close\r\n\r\n`);
		});
		socket.on('data', chunk => {
			responseText += chunk.toString('utf8');
			const validation = validateCloudflareTraceResponse(responseText, traceHost);
			if (validation.ok) finishResponse();
			else if (responseText.length > 32768) done({ ok: false, cfColo: '', cfIp: '', error: 'trace-response-too-large' });
		});
		socket.once('end', finishResponse);
		socket.once('timeout', () => done({ ok: false, cfColo: '', cfIp: '', error: 'timeout' }));
		socket.once('error', error => done({ ok: false, cfColo: '', cfIp: '', error: error.code || error.message }));
	});
}

function selectCheckQueue(candidates, options) {
	const queueSize = Math.max(options.scan, options.limit);
	return selectPriorityFill(candidates, {
		targetSize: queueSize,
		maxSize: queueSize,
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

function selectSpeedQueue(candidates, options) {
	const queueSize = Math.max(options.speedScan, options.limit);
	return selectPriorityFill(candidates, {
		targetSize: queueSize,
		maxSize: queueSize,
		minKeepSpeed: options.minKeepSpeed,
		balanced: options.balanced,
		countries: options.countries,
		compareFn: compareCheckedScore,
	});
}
async function checkEdgeCandidates(candidates, options) {
	return mapConcurrent(candidates, options.edgeConcurrency, item => checkEdgeTunnel(item, options));
}

async function checkEdgeTunnel(candidate, options) {
	const attempts = [];
	for (let attempt = 0; attempt < options.edgeAttempts; attempt++) {
		attempts.push(await probeWebSocketUpgradeOnce(candidate, options));
	}
	const summary = aggregateProbeAttempts(attempts, options.minEdgeSuccesses);
	return {
		...candidate,
		edgeOk: summary.ok,
		edgeAttempts: summary.probeAttempts,
		edgeSuccesses: summary.probeSuccesses,
		edgeMs: summary.probeMs,
		edgeMsSamples: summary.probeMsSamples,
		edgeError: summary.error,
	};
}

function probeWebSocketUpgradeOnce(candidate, options) {
	return new Promise(resolve => {
		const start = Date.now();
		const socket = tls.connect({
			host: candidate.host,
			port: Number(candidate.port),
			servername: options.edgeHost,
			rejectUnauthorized: true,
			minVersion: 'TLSv1.2',
			ALPNProtocols: ['http/1.1'],
		});
		const key = randomBytes(16).toString('base64');
		let responseText = '';
		let finished = false;
		const done = (ok, error = null) => {
			if (finished) return;
			finished = true;
			socket.destroy();
			resolve({ ok, probeMs: Date.now() - start, error });
		};
		socket.setTimeout(options.connectTimeout);
		socket.once('secureConnect', () => {
			socket.write([
				`GET ${options.edgePath} HTTP/1.1`,
				`Host: ${options.edgeHost}`,
				`Origin: https://${options.edgeHost}`,
				'Upgrade: websocket',
				'Connection: Upgrade',
				`Sec-WebSocket-Key: ${key}`,
				'Sec-WebSocket-Version: 13',
				'User-Agent: filtered-cf-nodes/1.0',
				'',
				'',
			].join('\r\n'));
		});
		socket.on('data', chunk => {
			responseText += chunk.toString('utf8');
			if (!responseText.includes('\r\n\r\n')) {
				if (responseText.length > 32768) done(false, 'websocket-response-too-large');
				return;
			}
			const validation = validateWebSocketUpgradeResponse(responseText, key);
			done(validation.ok, validation.ok ? null : validation.error);
		});
		socket.once('end', () => done(false, 'websocket-closed-before-upgrade'));
		socket.once('timeout', () => done(false, 'timeout'));
		socket.once('error', error => done(false, error.code || error.message));
	});
}

async function speedTestCandidates(candidates, options) {
	return mapConcurrent(candidates, options.speedConcurrency, item => testDownloadSpeed(item, options));
}

async function testDownloadSpeed(candidate, options) {
	const attempts = [];
	for (let attempt = 0; attempt < options.speedAttempts; attempt++) {
		attempts.push(await testDownloadSpeedOnce(candidate, options));
	}
	return {
		...candidate,
		...aggregateSpeedAttempts(attempts, options.minSpeedSuccesses),
	};
}

function testDownloadSpeedOnce(candidate, options) {
	return new Promise(resolve => {
		const start = Date.now();
		const socket = tls.connect({
			host: candidate.host,
			port: Number(candidate.port),
			servername: options.speedHost,
			rejectUnauthorized: true,
			minVersion: 'TLSv1.2',
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
			const localSpeedMbps = ok ? calculateLocalSpeedMbps({ bodyBytes, elapsedMs, minElapsedMs: options.minSpeedMs }) : null;
			const speedOk = ok && Number.isFinite(localSpeedMbps);
			resolve({
				speedOk,
				speedMs: elapsedMs,
				speedBytes: bodyBytes,
				localSpeedMbps,
				speedError: speedOk ? null : (error || 'speed-sample-too-short'),
			});
		};
		socket.setTimeout(options.speedTimeout);
		socket.once('secureConnect', () => {
			socket.write(`GET /__down?bytes=${options.speedBytes}&nonce=${randomUUID()} HTTP/1.1\r\nHost: ${options.speedHost}\r\nUser-Agent: filtered-cf-nodes/1.0\r\nAccept: application/octet-stream\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n`);
		});
		socket.on('data', chunk => {
			if (headerDone) {
				bodyBytes += chunk.length;
			} else {
				buffer = Buffer.concat([buffer, chunk]);
				const headerEnd = buffer.indexOf('\r\n\r\n');
				if (headerEnd !== -1) {
					const statusCode = parseHttpStatusCode(buffer.subarray(0, headerEnd).toString('utf8'));
					if (statusCode !== 200) {
						done(false, statusCode ? `http-status-${statusCode}` : 'invalid-http-response');
						return;
					}
					headerDone = true;
					bodyStartAt = Date.now();
					bodyBytes += buffer.length - headerEnd - 4;
					buffer = null;
				} else if (buffer.length > 65536) {
					done(false, 'download-headers-too-large');
					return;
				}
			}
			if (bodyBytes >= options.speedBytes) done(true);
		});
		socket.once('end', () => done(false, `incomplete-download:${bodyBytes}/${options.speedBytes}`));
		socket.once('timeout', () => done(false, 'speed-timeout'));
		socket.once('error', error => done(false, error.code || error.message));
	});
}

function formatNodeLines(items) {
	return items.map(item => `${formatEndpoint(item)}#${formatNodeLabel(item)}`);
}

function formatNodeLabel(item) {
	const country = COUNTRY_LABELS[item.country] || item.country || '未知';
	const speed = Number.isFinite(item.localSpeedMbps) ? formatSpeed(item.localSpeedMbps) : (Number.isFinite(item.speedMbps) ? formatSpeed(item.speedMbps) : 'NA');
	return `${country}-${speed}`;
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

function parseHttpStatusCode(responseHead) {
	const match = String(responseHead || '').match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i);
	return match ? Number.parseInt(match[1], 10) : null;
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

function validateOptions(config) {
	for (const [required, attempts, label] of [
		[config.minProbeSuccesses, config.probeAttempts, 'probe'],
		[config.minEdgeSuccesses, config.edgeAttempts, 'edge'],
		[config.minSpeedSuccesses, config.speedAttempts, 'speed'],
	]) {
		if (required > attempts) throw new Error(`${label} success requirement cannot exceed attempt count.`);
	}
	if (config.minSourceSuccesses > SOURCES.length) throw new Error('Minimum source successes exceed the configured source count.');
	if (config.minOutput > config.limit) throw new Error('Minimum output cannot exceed the output limit.');
	if (config.edgePath && !config.edgeHost) throw new Error('EDGETUNNEL_PATH requires EDGETUNNEL_HOST.');
	for (const [host, label] of [[config.traceHost, 'trace host'], [config.speedHost, 'speed host'], [config.edgeHost, 'EdgeTunnel host']]) {
		if (host && !/^[A-Za-z0-9.-]+$/.test(host)) throw new Error(`Invalid ${label}. Use a hostname without scheme, port, or path.`);
	}
	if (config.edgePath && /[\u0000-\u0020\u007f]/.test(config.edgePath)) throw new Error('Invalid EdgeTunnel path. Encode spaces and control characters.');
	if (config.speedBytes <= 0 || config.connectTimeout <= 0 || config.speedTimeout <= 0) throw new Error('Timeouts and speed sample size must be positive.');
}

function firstText(...values) {
	for (const value of values) {
		const text = textArg(value);
		if (text) return text;
	}
	return '';
}

function textArg(value) {
	return value == null ? '' : String(value).trim();
}

function normalizePath(value) {
	if (!value) return '';
	return value.startsWith('/') ? value : `/${value}`;
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

function positiveNumberArg(value, fallback) {
	const num = numberArg(value, fallback);
	return num > 0 ? num : fallback;
}
