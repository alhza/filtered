const SUPPORTED_PROTOCOLS = new Set([
	'vless', 'vmess', 'trojan', 'ss', 'ssr',
	'hysteria', 'hysteria2', 'hy2', 'tuic', 'anytls',
	'juicity', 'socks', 'socks5',
]);

export function extractProxyCandidates(text, { sourceUrl = '', sourceIndex = 0 } = {}) {
	const input = decodeSubscription(String(text || ''));
	const pattern = /(?:^|\s)((?:vless|vmess|trojan|ssr?|hysteria2?|hy2|tuic|anytls|juicity|socks5?):\/\/[^\s<>"'`]+)/gim;
	const candidates = [];
	for (const match of input.replaceAll('&amp;', '&').matchAll(pattern)) {
		const link = trimLink(match[1]);
		const candidate = parseProxyLink(link, { sourceUrl, sourceIndex });
		if (candidate) candidates.push(candidate);
	}
	return candidates;
}

export function parseProxyLink(rawLink, { sourceUrl = '', sourceIndex = 0 } = {}) {
	const link = trimLink(String(rawLink || '').trim());
	const protocol = link.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
	if (!SUPPORTED_PROTOCOLS.has(protocol)) return null;

	try {
		if (protocol === 'vmess') return parseVmess(link, sourceUrl, sourceIndex);
		if (protocol === 'ssr') return parseSsr(link, sourceUrl, sourceIndex);
		if (protocol === 'ss') return parseShadowsocks(link, sourceUrl, sourceIndex);
		return parseUrlProtocol(link, protocol, sourceUrl, sourceIndex);
	} catch {
		return null;
	}
}

export function dedupeProxyCandidates(candidates) {
	const result = new Map();
	for (const item of [...candidates].filter(Boolean).sort((a, b) => a.sourceIndex - b.sourceIndex)) {
		if (!result.has(item.key)) result.set(item.key, item);
	}
	return [...result.values()];
}

function parseVmess(link, sourceUrl, sourceIndex) {
	const payload = link.slice('vmess://'.length).split('#')[0];
	const data = JSON.parse(decodeBase64(payload));
	const host = cleanHost(data.add);
	const port = validPort(data.port);
	if (!host || !port || !data.id) return null;
	const name = String(data.ps || host);
	const sni = String(data.sni || data.host || '');
	const transport = String(data.net || 'tcp').toLowerCase();
	const key = stableKey('vmess', {
		host, port, id: data.id, aid: data.aid || '0', security: data.scy || data.security || 'auto',
		transport, tls: data.tls || '', sni, path: data.path || '', headerHost: data.host || '',
	});
	return makeCandidate({ link, protocol: 'vmess', host, port, name, sni, transport, tls: Boolean(data.tls), key, sourceUrl, sourceIndex });
}

function parseSsr(link, sourceUrl, sourceIndex) {
	const decoded = decodeBase64(link.slice('ssr://'.length).split('#')[0]);
	const base = decoded.split('/?')[0];
	const match = base.match(/^(.+):(\d+):([^:]+):([^:]+):([^:]+):(.+)$/);
	if (!match) return null;
	const host = cleanHost(match[1]);
	const port = validPort(match[2]);
	if (!host || !port) return null;
	const key = stableKey('ssr', { host, port, protocol: match[3], method: match[4], obfs: match[5], password: match[6] });
	return makeCandidate({ link, protocol: 'ssr', host, port, name: host, sni: '', transport: 'tcp', tls: false, key, sourceUrl, sourceIndex });
}

function parseShadowsocks(link, sourceUrl, sourceIndex) {
	const withoutFragment = link.split('#')[0];
	let host = '';
	let port = 0;
	let credential = '';
	try {
		const url = new URL(withoutFragment);
		host = cleanHost(url.hostname);
		port = validPort(url.port);
		credential = `${url.username}:${url.password}`;
	} catch { }
	if (!host || !port) {
		const decoded = decodeBase64(withoutFragment.slice('ss://'.length).split('?')[0]);
		const match = decoded.match(/^(.+)@([^:]+):(\d+)$/);
		if (!match) return null;
		credential = match[1];
		host = cleanHost(match[2]);
		port = validPort(match[3]);
	}
	const key = stableKey('ss', { host, port, credential, query: safeUrl(withoutFragment)?.search || '' });
	return makeCandidate({ link, protocol: 'ss', host, port, name: linkName(link, host), sni: '', transport: 'tcp', tls: false, key, sourceUrl, sourceIndex });
}

function parseUrlProtocol(link, protocol, sourceUrl, sourceIndex) {
	const url = new URL(link);
	const host = cleanHost(url.hostname);
	const port = validPort(url.port);
	if (!host || !port || !url.username) return null;
	const sni = url.searchParams.get('sni') || url.searchParams.get('peer') || url.searchParams.get('host') || '';
	const transport = (url.searchParams.get('type') || url.searchParams.get('net') || 'tcp').toLowerCase();
	const security = (url.searchParams.get('security') || url.searchParams.get('tls') || '').toLowerCase();
	const key = canonicalUrlKey(url, protocol);
	return makeCandidate({
		link,
		protocol,
		host,
		port,
		name: linkName(link, host),
		sni,
		transport,
		tls: ['tls', 'reality', 'true', '1'].includes(security),
		key,
		sourceUrl,
		sourceIndex,
	});
}

function makeCandidate({ link, protocol, host, port, name, sni, transport, tls, key, sourceUrl, sourceIndex }) {
	return { link, protocol, host, port, name, sni, transport, tls, key, sourceUrl, sourceIndex };
}

function decodeSubscription(text) {
	const trimmed = text.trim();
	const compact = trimmed.replace(/\s/g, '');
	if (compact.length < 16 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(compact)) return text;
	try {
		const decoded = decodeBase64(compact);
		return decoded.includes('://') ? decoded : text;
	} catch {
		return text;
	}
}

function decodeBase64(value) {
	const normalized = String(value).replace(/-/g, '+').replace(/_/g, '/').replace(/\s/g, '');
	const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4);
	const decoded = Buffer.from(padded, 'base64').toString('utf8');
	if (!decoded || decoded.includes('\uFFFD')) throw new Error('invalid-base64');
	return decoded;
}

function canonicalUrlKey(url, protocol) {
	const params = [...url.searchParams.entries()]
		.filter(([key]) => !['name', 'remark', 'remarks'].includes(key.toLowerCase()))
		.sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
	return stableKey(protocol, {
		username: decodeURIComponent(url.username),
		password: decodeURIComponent(url.password),
		host: cleanHost(url.hostname),
		port: Number(url.port),
		pathname: url.pathname,
		params,
	});
}

function stableKey(protocol, data) {
	return `${protocol}:${JSON.stringify(data)}`;
}

function safeUrl(value) {
	try { return new URL(value); } catch { return null; }
}

function validPort(value) {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : 0;
}

function cleanHost(value) {
	return String(value || '').trim().replace(/^\[|\]$/g, '').toLowerCase();
}

function linkName(link, fallback) {
	const fragment = link.includes('#') ? link.slice(link.indexOf('#') + 1) : '';
	try { return decodeURIComponent(fragment) || fallback; } catch { return fragment || fallback; }
}

function trimLink(link) {
	return link.trim().replace(/[)\]}>,'".;]+$/g, '');
}
