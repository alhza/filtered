import test from 'node:test';
import assert from 'node:assert/strict';

import {
	aggregateProbeAttempts,
	aggregateSpeedAttempts,
	calculateLocalSpeedMbps,
	selectFinalNodes,
	selectPriorityFill,
	validateCloudflareTraceResponse,
	validateWebSocketUpgradeResponse,
} from './cf-filter-core.mjs';

const VALID_TRACE_RESPONSE = [
	'HTTP/1.1 200 OK',
	'content-type: text/plain',
	'',
	'fl=29f82',
	'h=speed.cloudflare.com',
	'ip=203.0.113.10',
	'visit_scheme=https',
	'colo=HKG',
	'tls=TLSv1.3',
].join('\r\n');

test('validateCloudflareTraceResponse accepts a verified Cloudflare trace', () => {
	const result = validateCloudflareTraceResponse(VALID_TRACE_RESPONSE, 'speed.cloudflare.com');

	assert.equal(result.ok, true);
	assert.equal(result.fields.colo, 'HKG');
	assert.equal(result.fields.ip, '203.0.113.10');
});

test('validateCloudflareTraceResponse rejects a forged host or invalid status', () => {
	const forgedHost = VALID_TRACE_RESPONSE.replace('h=speed.cloudflare.com', 'h=fake.example.com');
	const failedStatus = VALID_TRACE_RESPONSE.replace('HTTP/1.1 200 OK', 'HTTP/1.1 503 Service Unavailable');

	assert.equal(validateCloudflareTraceResponse(forgedHost, 'speed.cloudflare.com').error, 'trace-host-mismatch');
	assert.equal(validateCloudflareTraceResponse(failedStatus, 'speed.cloudflare.com').error, 'http-status-503');
});

test('validateWebSocketUpgradeResponse verifies the RFC websocket accept value', () => {
	const key = 'dGhlIHNhbXBsZSBub25jZQ==';
	const response = [
		'HTTP/1.1 101 Switching Protocols',
		'Upgrade: websocket',
		'Connection: Upgrade',
		'Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=',
		'',
		'',
	].join('\r\n');

	assert.equal(validateWebSocketUpgradeResponse(response, key).ok, true);
	assert.equal(validateWebSocketUpgradeResponse(response.replace('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=', 'invalid'), key).error, 'websocket-accept-mismatch');
});

test('aggregateProbeAttempts requires repeated success and uses median latency', () => {
	const attempts = [
		{ ok: true, probeMs: 30, cfColo: 'HKG', cfIp: '203.0.113.10' },
		{ ok: false, probeMs: 50, error: 'timeout' },
		{ ok: true, probeMs: 10, cfColo: 'HKG', cfIp: '203.0.113.10' },
	];

	const accepted = aggregateProbeAttempts(attempts, 2);
	const rejected = aggregateProbeAttempts(attempts, 3);

	assert.equal(accepted.ok, true);
	assert.equal(accepted.probeSuccesses, 2);
	assert.equal(accepted.probeMs, 20);
	assert.equal(rejected.ok, false);
});

test('aggregateSpeedAttempts uses median speed and records the weakest successful sample', () => {
	const result = aggregateSpeedAttempts([
		{ speedOk: true, localSpeedMbps: 12, speedMs: 900, speedBytes: 4_194_304 },
		{ speedOk: false, speedError: 'timeout' },
		{ speedOk: true, localSpeedMbps: 8, speedMs: 1200, speedBytes: 4_194_304 },
		{ speedOk: true, localSpeedMbps: 20, speedMs: 700, speedBytes: 4_194_304 },
	], 2);

	assert.equal(result.speedOk, true);
	assert.equal(result.speedSuccesses, 3);
	assert.equal(result.localSpeedMbps, 12);
	assert.equal(result.localSpeedMinMbps, 8);
});

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

test('selectFinalNodes rejects unstable nodes whose weakest sample is below fallback', () => {
	const stable = { ...node('stable', 'US', 20, 20), localSpeedMinMbps: 6 };
	const unstable = { ...node('unstable', 'JP', 25, 10), localSpeedMinMbps: 2 };

	const selected = selectFinalNodes([unstable, stable], {
		limit: 2,
		minKeepSpeed: 10,
		fallbackMinSpeed: 5,
		balanced: false,
		countries: ['US', 'JP'],
	});

	assert.deepEqual(selected.map(item => item.host), ['stable']);
});

test('selectPriorityFill keeps unmeasured candidates in preflight queues', () => {
	const nodes = [
		node('fast', 'US', 20, 20),
		node('unmeasured', 'JP', null, 10),
	];

	const selected = selectPriorityFill(nodes, {
		targetSize: 2,
		minKeepSpeed: 10,
		balanced: false,
		countries: ['US', 'JP'],
		compareFn: () => 0,
	});

	assert.deepEqual(selected.map(item => item.host), ['fast', 'unmeasured']);
});

test('selectPriorityFill caps preflight queues when all candidates are fast', () => {
	const nodes = [
		node('fast-1', 'US', 30, 30),
		node('fast-2', 'JP', 20, 20),
		node('fast-3', 'SG', 15, 10),
	];

	const selected = selectPriorityFill(nodes, {
		targetSize: 2,
		maxSize: 2,
		minKeepSpeed: 10,
		balanced: false,
		countries: ['US', 'JP', 'SG'],
		compareFn: (a, b) => b.localSpeedMbps - a.localSpeedMbps,
	});

	assert.deepEqual(selected.map(item => item.host), ['fast-1', 'fast-2']);
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
