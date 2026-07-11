import test from 'node:test';
import assert from 'node:assert/strict';
import {
	dedupeProxyCandidates,
	extractProxyCandidates,
	parseProxyLink,
} from './proxy-filter-core.mjs';

const VLESS_A = 'vless://11111111-1111-4111-8111-111111111111@edge.example.com:443?security=tls&type=ws&sni=edge.example.com&host=edge.example.com&path=%2Fws#节点A';
const VLESS_B = 'vless://11111111-1111-4111-8111-111111111111@edge.example.com:443?security=tls&type=ws&sni=edge.example.com&host=edge.example.com&path=%2Fws#节点B';

test('extractProxyCandidates decodes a base64 subscription and ignores front addresses', () => {
	const subscription = Buffer.from([
		VLESS_A,
		'trojan://secret@trojan.example.com:443?security=tls&sni=trojan.example.com#Trojan',
		'104.16.0.1:443#CF前置',
	].join('\n')).toString('base64');

	const candidates = extractProxyCandidates(subscription, {
		sourceUrl: 'https://example.com/sub',
		sourceIndex: 2,
	});

	assert.deepEqual(candidates.map(item => item.protocol), ['vless', 'trojan']);
	assert.deepEqual(candidates.map(item => `${item.host}:${item.port}`), [
		'edge.example.com:443',
		'trojan.example.com:443',
	]);
	assert.equal(candidates[0].sourceIndex, 2);
});

test('parseProxyLink extracts vmess endpoint metadata', () => {
	const payload = Buffer.from(JSON.stringify({
		v: '2', ps: 'VMess', add: 'vmess.example.com', port: '8443',
		id: '22222222-2222-4222-8222-222222222222', net: 'ws', tls: 'tls',
		host: 'origin.example.com', path: '/socket', sni: 'origin.example.com',
	})).toString('base64');

	const candidate = parseProxyLink(`vmess://${payload}`, { sourceUrl: 'vmess-source', sourceIndex: 0 });

	assert.equal(candidate.protocol, 'vmess');
	assert.equal(candidate.host, 'vmess.example.com');
	assert.equal(candidate.port, 8443);
	assert.equal(candidate.sni, 'origin.example.com');
	assert.equal(candidate.transport, 'ws');
});

test('parseProxyLink rejects malformed or unsupported links', () => {
	assert.equal(parseProxyLink('https://example.com/sub'), null);
	assert.equal(parseProxyLink('vless://missing-port@example.com'), null);
	assert.equal(parseProxyLink('vmess://not-base64'), null);
});

test('dedupeProxyCandidates ignores display-name-only differences', () => {
	const first = parseProxyLink(VLESS_A, { sourceUrl: 'primary', sourceIndex: 0 });
	const second = parseProxyLink(VLESS_B, { sourceUrl: 'backup', sourceIndex: 1 });

	const result = dedupeProxyCandidates([second, first]);

	assert.equal(result.length, 1);
	assert.equal(result[0].sourceUrl, 'primary');
});
