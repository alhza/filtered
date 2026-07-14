import { createHash } from 'node:crypto';
import { isIP } from 'node:net';

export const DEFAULT_PORTS = ['443', '8443', '2053', '2083', '2087', '2096'];
export const DEFAULT_COUNTRIES = [
	'HK', 'JP', 'SG', 'TW', 'US', 'KR', 'DE', 'NL', 'GB', 'FR', 'FI', 'SE',
	'CH', 'PL', 'LV', 'CA', 'AU', 'RU', 'TH', 'MY', 'VN', 'IN',
];

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

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export function validateCloudflareTraceResponse(responseText, expectedHost) {
	const response = parseHttpResponse(responseText);
	if (!response) return { ok: false, error: 'invalid-http-response' };
	if (response.statusCode !== 200) return { ok: false, error: `http-status-${response.statusCode}` };

	const fields = Object.fromEntries(String(response.body || '')
		.split(/\r?\n/)
		.map(line => {
			const separator = line.indexOf('=');
			return separator > 0 ? [line.slice(0, separator), line.slice(separator + 1)] : null;
		})
		.filter(Boolean));
	const normalizedHost = String(expectedHost || '').trim().toLowerCase();
	if (!normalizedHost) return { ok: false, error: 'trace-host-required' };
	if (String(fields.h || '').toLowerCase() !== normalizedHost) return { ok: false, error: 'trace-host-mismatch' };
	if (fields.visit_scheme !== 'https') return { ok: false, error: 'trace-not-https' };
	if (isIP(fields.ip || '') === 0) return { ok: false, error: 'trace-invalid-ip' };
	if (!/^[A-Z]{3}$/.test(fields.colo || '')) return { ok: false, error: 'trace-invalid-colo' };
	if (!/^TLSv1\.[23]$/.test(fields.tls || '')) return { ok: false, error: 'trace-invalid-tls' };
	return { ok: true, statusCode: response.statusCode, fields };
}

export function validateWebSocketUpgradeResponse(responseText, key) {
	const response = parseHttpResponse(responseText);
	if (!response) return { ok: false, error: 'invalid-http-response' };
	if (response.statusCode !== 101) return { ok: false, error: `http-status-${response.statusCode}` };
	if (String(response.headers.upgrade || '').toLowerCase() !== 'websocket') return { ok: false, error: 'websocket-upgrade-missing' };
	if (!String(response.headers.connection || '').toLowerCase().split(/\s*,\s*/).includes('upgrade')) {
		return { ok: false, error: 'websocket-connection-missing' };
	}
	const expectedAccept = createHash('sha1').update(`${key}${WEBSOCKET_GUID}`).digest('base64');
	if (response.headers['sec-websocket-accept'] !== expectedAccept) return { ok: false, error: 'websocket-accept-mismatch' };
	return { ok: true, statusCode: response.statusCode };
}

export function aggregateProbeAttempts(attempts, requiredSuccesses = 1) {
	const successful = attempts.filter(item => item.ok && Number.isFinite(item.probeMs));
	const required = Math.max(1, Math.trunc(requiredSuccesses) || 1);
	const probeMsSamples = successful.map(item => item.probeMs);
	const ok = successful.length >= required;
	return {
		ok,
		probeAttempts: attempts.length,
		probeSuccesses: successful.length,
		probeMs: median(probeMsSamples),
		probeMsSamples,
		cfColo: mostFrequent(successful.map(item => item.cfColo).filter(Boolean)),
		cfIp: successful.findLast(item => item.cfIp)?.cfIp || '',
		error: ok ? null : (attempts.findLast(item => item.error)?.error || `insufficient-probe-successes:${successful.length}/${required}`),
	};
}

export function aggregateSpeedAttempts(attempts, requiredSuccesses = 1) {
	const successful = attempts.filter(item => item.speedOk && Number.isFinite(item.localSpeedMbps));
	const required = Math.max(1, Math.trunc(requiredSuccesses) || 1);
	const speedSamplesMbps = successful.map(item => item.localSpeedMbps);
	const ok = successful.length >= required;
	return {
		speedOk: ok,
		speedAttempts: attempts.length,
		speedSuccesses: successful.length,
		speedSamplesMbps,
		localSpeedMbps: median(speedSamplesMbps),
		localSpeedMinMbps: speedSamplesMbps.length ? Math.min(...speedSamplesMbps) : null,
		speedMs: median(successful.map(item => item.speedMs)),
		speedBytes: successful.length ? Math.min(...successful.map(item => item.speedBytes)) : 0,
		speedError: ok ? null : (attempts.findLast(item => item.speedError)?.speedError || `insufficient-speed-successes:${successful.length}/${required}`),
	};
}

export function classifyAvailability(item, {
	verificationLevel = 'cloudflare-trace',
	speedVerificationConfigured = true,
} = {}) {
	const cloudflareReachable = item.ok === true;
	const targetVerificationConfigured = verificationLevel === 'edge-websocket';
	const targetVerified = targetVerificationConfigured ? item.edgeOk === true : null;
	const speedVerified = speedVerificationConfigured ? item.speedOk === true : null;
	const configuredChecksPassed = cloudflareReachable
		&& (!targetVerificationConfigured || targetVerified)
		&& (!speedVerificationConfigured || speedVerified);
	const status = !configuredChecksPassed
		? 'unavailable'
		: (targetVerificationConfigured ? 'available' : 'unverified');

	return {
		status,
		verificationLevel,
		cloudflareReachable,
		targetVerified,
		speedVerified,
	};
}

function parseHttpResponse(responseText) {
	const text = String(responseText || '');
	const separator = text.indexOf('\r\n\r\n');
	if (separator === -1) return null;
	const lines = text.slice(0, separator).split('\r\n');
	const status = lines.shift()?.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\b/i);
	if (!status) return null;
	const headers = {};
	for (const line of lines) {
		const colon = line.indexOf(':');
		if (colon <= 0) continue;
		const name = line.slice(0, colon).trim().toLowerCase();
		const value = line.slice(colon + 1).trim();
		headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
	}
	return {
		statusCode: Number.parseInt(status[1], 10),
		headers,
		body: text.slice(separator + 4),
	};
}

function median(values) {
	const finite = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (finite.length === 0) return null;
	const middle = Math.floor(finite.length / 2);
	return finite.length % 2 ? finite[middle] : (finite[middle - 1] + finite[middle]) / 2;
}

function mostFrequent(values) {
	const counts = new Map();
	for (const value of values) counts.set(value, (counts.get(value) || 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || '';
}

export function selectFinalNodes(candidates, options) {
	const fallbackMinSpeed = options.fallbackMinSpeed ?? options.minKeepSpeed;
	const stableCandidates = candidates.filter(item => !Number.isFinite(item.localSpeedMinMbps) || item.localSpeedMinMbps >= fallbackMinSpeed);
	return selectPriorityFill(stableCandidates, {
		targetSize: options.limit,
		maxSize: options.limit,
		minKeepSpeed: options.minKeepSpeed,
		fallbackMinSpeed,
		strictMinSpeed: options.strictMinSpeed !== false,
		balanced: options.balanced,
		countries: options.countries,
		compareFn: compareCheckedScore,
	});
}

export function selectPriorityFill(candidates, { targetSize, minKeepSpeed, fallbackMinSpeed = minKeepSpeed, balanced, countries, compareFn, maxSize = Infinity, strictMinSpeed = false }) {
	const selected = new Map();
	const highSpeed = candidates
		.filter(item => isHighSpeed(item, minKeepSpeed))
		.sort(compareFn);
	const highSpeedLimit = Math.min(highSpeed.length, maxSize);
	const prioritizedHighSpeed = balanced
		? balancedTake(groupAndSort(highSpeed, compareFn), highSpeedLimit, countries).sort(compareFn)
		: highSpeed.slice(0, highSpeedLimit);

	for (const item of prioritizedHighSpeed) {
		if (selected.size >= maxSize) break;
		selected.set(candidateKey(item), item);
	}

	const fillThreshold = strictMinSpeed ? Math.max(0, fallbackMinSpeed) : 0;
	if (selected.size >= Math.min(targetSize, maxSize)) return [...selected.values()];

	const rest = candidates.filter(item => !selected.has(candidateKey(item)) && isHighSpeed(item, fillThreshold));
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

export function selectSearchQueue(candidates, {
	queueSize,
	explorationRatio = 0.25,
	seed = '',
	minKeepSpeed,
	balanced,
	countries,
	compareFn,
}) {
	const size = Math.max(0, Math.min(Math.trunc(queueSize) || 0, candidates.length));
	if (size === 0) return [];
	const ratio = Number.isFinite(explorationRatio)
		? Math.min(1, Math.max(0, explorationRatio))
		: 0.25;
	const explorationSize = Math.min(size, Math.floor(size * ratio));
	const rankedSize = size - explorationSize;
	const selected = new Map();
	const ranked = selectPriorityFill(candidates, {
		targetSize: rankedSize,
		maxSize: rankedSize,
		minKeepSpeed,
		balanced,
		countries,
		compareFn,
	});
	for (const item of ranked) selected.set(candidateKey(item), { ...item, searchLane: 'ranked' });

	const remaining = candidates.filter(item => !selected.has(candidateKey(item)));
	const explorationRanks = new Map(remaining.map(item => [
		candidateKey(item),
		createHash('sha256').update(`${seed}\0${candidateKey(item)}`).digest('hex'),
	]));
	const compareExploration = (a, b) => {
		const evidenceCompare = upstreamEvidenceCount(a) - upstreamEvidenceCount(b);
		if (evidenceCompare) return evidenceCompare;
		return explorationRanks.get(candidateKey(a)).localeCompare(explorationRanks.get(candidateKey(b)));
	};
	const explorationCandidates = balanced
		? balancedTake(groupAndSort(remaining, compareExploration), explorationSize, countries)
		: remaining.sort(compareExploration).slice(0, explorationSize);
	for (const item of explorationCandidates) selected.set(candidateKey(item), { ...item, searchLane: 'exploration' });

	if (selected.size < size) {
		const fill = candidates
			.filter(item => !selected.has(candidateKey(item)))
			.sort(compareFn)
			.slice(0, size - selected.size);
		for (const item of fill) selected.set(candidateKey(item), { ...item, searchLane: 'ranked' });
	}
	return [...selected.values()];
}

export function calculateLocalSpeedMbps({ bodyBytes, elapsedMs, minElapsedMs = 50 }) {
	if (!Number.isFinite(bodyBytes) || bodyBytes <= 0) return null;
	if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
	if (elapsedMs < minElapsedMs) return null;
	return (bodyBytes * 8) / elapsedMs / 1000;
}

export function isHighSpeed(item, threshold) {
	return measuredSpeedMbps(item) >= threshold;
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

function candidateKey(item) {
	return `${item.host}:${item.port}`;
}

function upstreamEvidenceCount(item) {
	return Number(Number.isFinite(item.speedMbps)) + Number(Number.isFinite(item.latencyMs));
}

export function compareCandidateScore(a, b) {
	return scoreCandidate(b) - scoreCandidate(a);
}

export function compareCheckedScore(a, b) {
	const scoreCompare = scoreChecked(b) - scoreChecked(a);
	if (scoreCompare) return scoreCompare;
	return (a.probeMs || 9999) - (b.probeMs || 9999);
}

function scoreChecked(item) {
	const speed = Number.isFinite(item.localSpeedMbps) ? item.localSpeedMbps : 0;
	const countryBonus = orderedBonus(item.country, DEFAULT_COUNTRIES, SCORE_WEIGHTS.countryBase, SCORE_WEIGHTS.countryStep);
	const portBonus = orderedBonus(item.port, DEFAULT_PORTS, SCORE_WEIGHTS.portBase, SCORE_WEIGHTS.portStep);
	const sourceBonus = Math.max(0, SCORE_WEIGHTS.sourceBase - item.sourceIndex * SCORE_WEIGHTS.sourceStep);
	const metricsBonus = Number.isFinite(item.localSpeedMbps) ? SCORE_WEIGHTS.metrics : 0;
	const probeMs = Number.isFinite(item.probeMs) ? item.probeMs : 9999;
	return speed * SCORE_WEIGHTS.speed + metricsBonus + countryBonus + portBonus + sourceBonus - probeMs / SCORE_WEIGHTS.probeDivisor;
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

export function measuredSpeedMbps(item) {
	if (Number.isFinite(item.localSpeedMbps)) return item.localSpeedMbps;
	if (Number.isFinite(item.speedMbps)) return item.speedMbps;
	return 0;
}
