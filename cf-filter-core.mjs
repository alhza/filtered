const DEFAULT_PORTS = ['443', '8443', '2053', '2083', '2087', '2096'];
const DEFAULT_COUNTRIES = [
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

export function selectFinalNodes(candidates, options) {
	return selectPriorityFill(candidates, {
		targetSize: options.limit,
		maxSize: options.limit,
		minKeepSpeed: options.minKeepSpeed,
		strictMinSpeed: options.strictMinSpeed !== false,
		balanced: options.balanced,
		countries: options.countries,
		compareFn: compareCheckedScore,
	});
}

export function selectPriorityFill(candidates, { targetSize, minKeepSpeed, balanced, countries, compareFn, maxSize = Infinity, strictMinSpeed = false }) {
	const selected = new Map();
	const highSpeed = candidates
		.filter(item => isHighSpeed(item, minKeepSpeed))
		.sort(compareFn);

	for (const item of highSpeed) {
		if (selected.size >= maxSize) break;
		selected.set(candidateKey(item), item);
	}

	if (strictMinSpeed) return [...selected.values()];

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

function compareCheckedScore(a, b) {
	const scoreCompare = scoreChecked(b) - scoreChecked(a);
	if (scoreCompare) return scoreCompare;
	return (a.probeMs || 9999) - (b.probeMs || 9999);
}

function scoreChecked(item) {
	return scoreCandidate(item) - (item.probeMs || 9999) / SCORE_WEIGHTS.probeDivisor;
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

function measuredSpeedMbps(item) {
	if (Number.isFinite(item.localSpeedMbps)) return item.localSpeedMbps;
	if (Number.isFinite(item.speedMbps)) return item.speedMbps;
	return 0;
}
