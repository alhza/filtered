import test from 'node:test';
import assert from 'node:assert/strict';

import {
	calculateLocalSpeedMbps,
	dedupeBySubnet,
	selectFinalNodes,
	subnetKey,
} from './cf-filter-core.mjs';

test('selectFinalNodes keeps only nodes at or above the minimum speed', () => {
	const nodes = [
		node('fast-us', 'US', 25, 30),
		node('exact-jp', 'JP', 10, 40),
		node('slow-hk', 'HK', 9.99, 20),
		node('slow-sg', 'SG', 5, 10),
	];

	const selected = selectFinalNodes(nodes, {
		limit: 10,
		minKeepSpeed: 10,
		balanced: true,
		countries: ['HK', 'JP', 'US', 'SG'],
	});

	assert.deepEqual(selected.map(item => item.host), ['fast-us', 'exact-jp']);
});

test('selectFinalNodes caps the result without filling from slow nodes', () => {
	const nodes = [
		node('fast-1', 'US', 30, 30),
		node('fast-2', 'JP', 20, 20),
		node('fast-3', 'SG', 15, 10),
		node('slow-1', 'HK', 9, 5),
	];

	const selected = selectFinalNodes(nodes, {
		limit: 2,
		minKeepSpeed: 10,
		balanced: true,
		countries: ['US', 'JP', 'SG', 'HK'],
	});

	assert.deepEqual(selected.map(item => item.host), ['fast-1', 'fast-2']);
});

test('selectFinalNodes fills from fallback speed tier without using very slow nodes', () => {
	const nodes = [
		node('fast-1', 'US', 30, 30),
		node('fallback-1', 'HK', 8, 20),
		node('fallback-2', 'JP', 5, 15),
		node('too-slow', 'SG', 4.99, 10),
	];

	const selected = selectFinalNodes(nodes, {
		limit: 4,
		minKeepSpeed: 10,
		fallbackMinSpeed: 5,
		balanced: true,
		countries: ['US', 'HK', 'JP', 'SG'],
	});

	assert.deepEqual(selected.map(item => item.host), ['fast-1', 'fallback-1', 'fallback-2']);
});

test('selectFinalNodes uses source thresholds in rank-by-source mode', () => {
	const nodes = [
		sourceNode('source-fast', 'JP', 9, 30),
		sourceNode('source-fallback', 'HK', 5, 20),
		sourceNode('source-too-slow', 'SG', 4.9, 10),
	];

	const selected = selectFinalNodes(nodes, {
		limit: 10,
		minKeepSpeed: 10,
		fallbackMinSpeed: 0,
		minSourceSpeed: 8,
		fallbackMinSourceSpeed: 5,
		rankBySource: true,
		balanced: true,
		countries: ['JP', 'HK', 'SG'],
	});

	assert.deepEqual(selected.map(item => item.host), ['source-fast', 'source-fallback']);
});

test('calculateLocalSpeedMbps rejects burst samples that finish too quickly', () => {
	const speed = calculateLocalSpeedMbps({
		bodyBytes: 1_048_680,
		elapsedMs: 8,
		minElapsedMs: 50,
	});

	assert.equal(speed, null);
});

test('calculateLocalSpeedMbps accepts samples with enough duration', () => {
	const speed = calculateLocalSpeedMbps({
		bodyBytes: 1_048_680,
		elapsedMs: 100,
		minElapsedMs: 50,
	});

	assert.ok(Math.abs(speed - 83.8944) < 0.000001);
});

test('selectFinalNodes ranks by local measurement and ignores claimed metrics', () => {
	const measuredOnly = { ...node('measured-only', 'US', 20, 30) };
	const claimedBoost = {
		...node('claimed-boost', 'US', 18, 30),
		speedMbps: 100,
		latencyMs: 5,
	};

	const selected = selectFinalNodes([claimedBoost, measuredOnly], {
		limit: 2,
		minKeepSpeed: 10,
		balanced: true,
		countries: ['US'],
	});

	assert.deepEqual(selected.map(item => item.host), ['measured-only', 'claimed-boost']);
});

test('subnetKey groups IPv4 by /24, IPv6 by /48 and keeps hostnames intact', () => {
	assert.equal(subnetKey('172.64.52.169'), '172.64.52');
	assert.equal(subnetKey('172.64.53.169'), '172.64.53');
	assert.equal(subnetKey('2606:4700::6810:84e5'), '2606:4700:0000');
	assert.equal(subnetKey('2606:4700:0:0:0:0:6810:84e5'), '2606:4700:0000');
	assert.equal(subnetKey('Example.COM'), 'example.com');
});

test('dedupeBySubnet keeps the best node per subnet up to the limit', () => {
	const nodes = [
		{ host: '172.64.52.1', probeMs: 300 },
		{ host: '172.64.52.2', probeMs: 100 },
		{ host: '172.64.52.3', probeMs: 200 },
		{ host: '172.64.53.1', probeMs: 400 },
	];

	const byProbe = (a, b) => (a.probeMs || 9999) - (b.probeMs || 9999);
	const deduped = dedupeBySubnet(nodes, { limit: 1, compareFn: byProbe });
	assert.deepEqual(deduped.map(item => item.host), ['172.64.52.2', '172.64.53.1']);

	const dedupedTwo = dedupeBySubnet(nodes, { limit: 2, compareFn: byProbe });
	assert.deepEqual(dedupedTwo.map(item => item.host), ['172.64.52.2', '172.64.52.3', '172.64.53.1']);

	const disabled = dedupeBySubnet(nodes, { limit: 0, compareFn: byProbe });
	assert.equal(disabled.length, 4);
});

function node(host, country, localSpeedMbps, probeMs) {
	return {
		host,
		port: '443',
		country,
		localSpeedMbps,
		probeMs,
		sourceIndex: 0,
	};
}

function sourceNode(host, country, speedMbps, probeMs) {
	return {
		host,
		port: '443',
		country,
		speedMbps,
		probeMs,
		sourceIndex: 0,
	};
}
