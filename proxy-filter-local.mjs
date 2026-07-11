import fs from 'node:fs/promises';
import net from 'node:net';
import {
	dedupeProxyCandidates,
	extractProxyCandidates,
} from './proxy-filter-core.mjs';

const SOURCES = [
	source('Au1rxx', 'Au1rxx/free-vpn-subscriptions', 'main', 'output/v2ray-base64.txt'),
	source('0xRadikal', '0xRadikal/Free-v2ray-Configs', 'main', 'light/configs.txt'),
	source('Pawdroid', 'Pawdroid/Free-servers', 'main', 'sub'),
	source('AutoMergePublicNodes', 'chengaopan/AutoMergePublicNodes', 'master', 'list_raw.txt'),
	source('openproxylist', 'roosterkid/openproxylist', 'main', 'V2RAY_RAW.txt'),
	source('V2RayAggregator', 'mahdibland/V2RayAggregator', 'master', 'Eternity.txt'),
	source('EbraSha', 'ebrasha/free-v2ray-public-list', 'main', 'V2Ray-Config-By-EbraSha.txt'),
	source('mfuu', 'mfuu/v2ray', 'master', 'v2ray'),
	source('shaoyouvip', 'shaoyouvip/free', 'main', 'base64.txt'),
];

const args = parseArgs(process.argv.slice(2));
const options = {
	limit: numberArg(args.limit, 500),
	scan: numberArg(args.scan, 1200),
	concurrency: numberArg(args.concurrency, 100),
	connectTimeout: numberArg(args.timeout, 2500),
	fetchTimeout: numberArg(args.fetchTimeout ?? args['fetch-timeout'], 25000),
	maxSourceBytes: numberArg(args.maxSourceBytes ?? args['max-source-bytes'], 8 * 1024 * 1024),
	out: args.out || 'filtered-proxy-links.txt',
	json: args.json || 'filtered-proxy-links.json',
};

await run();

async function run() {
	const startedAt = Date.now();
	const fetched = await mapConcurrent(SOURCES, 4, (item, sourceIndex) => fetchSource(item, sourceIndex, options));
	const parsed = fetched.flatMap(item => item.ok
		? extractProxyCandidates(item.text, { sourceUrl: item.url, sourceIndex: item.sourceIndex })
		: []);
	const deduped = dedupeProxyCandidates(parsed);
	const endpointQueue = selectEndpointQueue(deduped, options.scan);
	const checkedEndpoints = await mapConcurrent(endpointQueue, options.concurrency, item => checkEndpoint(item, options.connectTimeout));
	const health = new Map(checkedEndpoints.map(item => [endpointKey(item), item]));
	const reachable = deduped
		.filter(item => health.get(endpointKey(item))?.ok)
		.map(item => ({ ...item, connectMs: health.get(endpointKey(item)).connectMs }));
	const selected = selectBalanced(reachable, options.limit);
	const report = buildReport({ startedAt, fetched, parsed, deduped, endpointQueue, checkedEndpoints, reachable, selected, options });

	await fs.writeFile(options.out, selected.map(item => item.link).join('\n') + (selected.length ? '\n' : ''), 'utf8');
	await fs.writeFile(options.json, JSON.stringify(report, null, 2), 'utf8');
	printSummary(report);
}

function source(name, repo, branch, path) {
	return {
		name,
		urls: [
			`https://raw.githubusercontent.com/${repo}/${branch}/${path}`,
			`https://cdn.jsdelivr.net/gh/${repo}@${branch}/${path}`,
		],
	};
}

async function fetchSource(item, sourceIndex, { fetchTimeout, maxSourceBytes }) {
	let lastError = null;
	for (const url of item.urls) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), fetchTimeout);
		try {
			const response = await fetch(url, {
				signal: controller.signal,
				headers: { 'User-Agent': 'filtered-edgetunnel-nodes/1.0' },
			});
			if (!response.ok) throw new Error(`HTTP ${response.status}`);
			const declaredSize = Number(response.headers.get('content-length'));
			if (Number.isFinite(declaredSize) && declaredSize > maxSourceBytes) throw new Error(`source-too-large:${declaredSize}`);
			const text = await response.text();
			if (Buffer.byteLength(text) > maxSourceBytes) throw new Error(`source-too-large:${Buffer.byteLength(text)}`);
			return { ...item, sourceIndex, url, ok: true, status: response.status, bytes: Buffer.byteLength(text), text, error: null };
		} catch (error) {
			lastError = error?.message || String(error);
		} finally {
			clearTimeout(timer);
		}
	}
	return { ...item, sourceIndex, url: item.urls[0], ok: false, status: 0, bytes: 0, text: '', error: lastError };
}

function selectEndpointQueue(candidates, limit) {
	const endpoints = new Map();
	for (const item of candidates) {
		const key = endpointKey(item);
		if (!endpoints.has(key)) endpoints.set(key, { host: item.host, port: item.port });
		if (endpoints.size >= limit) break;
	}
	return [...endpoints.values()];
}

function checkEndpoint(endpoint, timeoutMs) {
	return new Promise(resolve => {
		const startedAt = Date.now();
		const socket = net.connect({ host: endpoint.host, port: endpoint.port });
		let finished = false;
		const done = (ok, error = null) => {
			if (finished) return;
			finished = true;
			socket.destroy();
			resolve({ ...endpoint, ok, connectMs: Date.now() - startedAt, error });
		};
		const timer = setTimeout(() => done(false, 'timeout'), timeoutMs);
		socket.once('connect', () => {
			clearTimeout(timer);
			done(true);
		});
		socket.once('error', error => {
			clearTimeout(timer);
			done(false, error.code || error.message);
		});
	});
}

function selectBalanced(candidates, limit) {
	const protocolOrder = ['vless', 'trojan', 'ss', 'vmess', 'hysteria2', 'hy2', 'tuic', 'hysteria', 'ssr', 'anytls', 'juicity', 'socks', 'socks5'];
	const groups = new Map();
	for (const item of candidates) {
		if (!groups.has(item.protocol)) groups.set(item.protocol, []);
		groups.get(item.protocol).push(item);
	}
	const ordered = [...protocolOrder.filter(key => groups.has(key)), ...[...groups.keys()].filter(key => !protocolOrder.includes(key))];
	const selected = [];
	let cursor = 0;
	while (selected.length < limit && ordered.length) {
		let added = false;
		for (const protocol of ordered) {
			const item = groups.get(protocol)[cursor];
			if (!item) continue;
			selected.push(item);
			added = true;
			if (selected.length >= limit) break;
		}
		if (!added) break;
		cursor++;
	}
	return selected;
}

function buildReport({ startedAt, fetched, parsed, deduped, endpointQueue, checkedEndpoints, reachable, selected, options }) {
	return {
		generatedAt: new Date().toISOString(),
		elapsedMs: Date.now() - startedAt,
		sources: fetched.map(item => ({
			name: item.name, url: item.url, ok: item.ok, status: item.status,
			bytes: item.bytes, error: item.error,
		})),
		options,
		stats: {
			parsed: parsed.length,
			deduped: deduped.length,
			endpointsQueued: endpointQueue.length,
			endpointsReachable: checkedEndpoints.filter(item => item.ok).length,
			reachable: reachable.length,
			selected: selected.length,
			protocols: countBy(selected, 'protocol'),
			sources: countBy(selected, 'sourceUrl'),
		},
		nodes: selected.map(item => ({
			protocol: item.protocol,
			host: item.host,
			port: item.port,
			name: item.name,
			transport: item.transport,
			tls: item.tls,
			sni: item.sni,
			connectMs: item.connectMs,
			sourceUrl: item.sourceUrl,
			link: item.link,
		})),
	};
}

function printSummary(report) {
	console.log(`sources=${report.sources.filter(item => item.ok).length}/${report.sources.length} parsed=${report.stats.parsed} deduped=${report.stats.deduped}`);
	console.log(`endpoints=${report.stats.endpointsReachable}/${report.stats.endpointsQueued} reachable=${report.stats.reachable} selected=${report.stats.selected}`);
	console.log(`protocols=${JSON.stringify(report.stats.protocols)}`);
	console.log(`wrote ${options.out}`);
	console.log(`wrote ${options.json}`);
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

function endpointKey(item) {
	return `${item.host}:${item.port}`;
}

function countBy(items, key) {
	return items.reduce((result, item) => {
		const value = item[key] || 'unknown';
		result[value] = (result[value] || 0) + 1;
		return result;
	}, {});
}

function parseArgs(values) {
	const result = {};
	for (let index = 0; index < values.length; index++) {
		const key = values[index];
		if (!key.startsWith('--')) continue;
		result[key.slice(2)] = values[index + 1] && !values[index + 1].startsWith('--') ? values[++index] : '1';
	}
	return result;
}

function numberArg(value, fallback) {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : fallback;
}
