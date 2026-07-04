import test from 'node:test';
import assert from 'node:assert/strict';

import {
	calculateLocalSpeedMbps,
	selectFinalNodes,
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
