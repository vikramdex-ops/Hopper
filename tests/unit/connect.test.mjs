// Dexterity Connect notices (src/lan/connect.ts): sent to the hub's Bot API over TLS pinned by
// certificate fingerprint; a different certificate is refused; nothing is sent when unconfigured.
import './pubshare-hooks.mjs'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import https from 'node:https'
import { X509Certificate } from 'node:crypto'

const { postConnect, connectEnabled } = await import('../../src/lan/connect.ts')

// test-only self-signed certificate (never used outside this file)
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDYDzi77cXFameZ
JWd2AAosIgwLc7hbFq5053QaeFXO/4w0CT45/vIGJEysCEK9Wrng+pnm47HAnZMO
H1QA1dMPPXW/g7Kptt1XQN92MpN6hdE1FfQo8Xr5003Op3TYn29cdn+GmBKJ7Dv+
KkN/Kn2HvJx5/9GR7qalNhrRIDvJxGR4kfcJAYast9AkqjpG/ucrJ8STDVKsVgHB
Z6JlK1yxYVC7aJeRdn0ed+mCwsnfdf75k8C/m8w+6weXqMk19dv96SKXlh9xhbic
KAGdGhKt4hTF1d9yRaLs5kvog+Hb6I1G85fYYIne0sBDB8ivzU2YUmUSmIbE67X0
KJXlU0GHAgMBAAECggEAUh5u9NapnaAUohuaWDopo56JL20bO9vCEQLLmSf1jUiJ
tFlzAj4JJRZ04cn9+9RY48674grWy5vYgbycg/jBUICOmWzn4iNzuy8X/+e3MBFe
c6vVch5eHEgYwZvaCF+Ixv7u92wjV7KnFrJflxzCO24PlzsJH0syoYaP6L40mznL
4/MlwaQCk8J4MAkvdc/oxLCyxKQ1ff+F55VuKTsbxWZRPS38vyW0yN4sb6YGIrDs
ZvYUx3IEHEjYr0Kk/nnQWChtqYfgCsyhhvbyUxPki1d0O1aCC+2rwn2WaMZuIdZS
hiQcB+KhMIa6hrTyWyZ6fy3A0sfi4MXya0xfxpve2QKBgQD33LubxLWYy/xnyNGg
GFrYI80h6CsxU9gnwBAtspxNjolxbRB2ew1ddRxTiW61UYt+IKZ4qtOl9WUDqzGY
q8sclYSMphMfhg1qPSrA2a/9zApyfaFcsMVAOuNseO+7v7wenRjZf5IgdNM6m7hj
r1NpVyagU3wF7Oco8zvyZQfiEwKBgQDfJzA3BUHizRoK5q4HNHmBF27y+2LyKPK6
L26vd5rWRriFBi8qDE2kgF8zSsWtwJqGB0ND2gxtTQ8y0YPMINCy6SaQOsYa8+aZ
ldW+X6OZDBphOmpe513Lg1PhX+MCJYq5SxR4URImP+R2DEfkMa+ixTutjiHXPT3l
kmH2/rhxPQKBgQDdjAR5WBuFpxdGYR7WPc69kUqi+xXYcnwsE6WiYxsIy9YYd4cW
kCjDF5GpLZeyJGBN7bs+8lpZ5f1TiSq8rxnOw+qFmVBQhg7pniDf3fRMI5xW9+pK
ooq9PaXYaETIiboJlxwGFNw1fJbttRDcsXMaHlcdSWH7HeUFGlzD7gBc1wKBgQCW
ZSn4mwF5orOfjzLQxkvxdeKfvk9EV9anJtqZRanEKmuns7BLzXjymlYPEqDB5qH+
HJz3+NgRPjM1E8GY7LDbM4l7ATGM7r6G2lXw9TIkLuUEjEMubQ5o37zDk0VCqByj
nvdP04vA3aTS7pnxMI9nyzfaU4V5M9woggymU6vpHQKBgQCn699yBqs6AenTN0ik
llrlVsD8X//niIYG1wUlzG6ou+r6NLVDv2D2WUz349lh/Ph09Z3Stp46M6QDXmNY
Xw8y992gEURCF9X+ftTrez2BxTkzIAsWSJV1yF5ErscBcrSCF4X+i+QobVkzZceL
H46AqDg+NuI80brBfB3YViAr+Q==
-----END PRIVATE KEY-----`
const CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUMQVI6kQe9UUvLlpA7YAXnvsPZkwwDQYJKoZIhvcNAQEL
BQAwEzERMA8GA1UEAwwIVGVzdCBIdWIwIBcNMjYxMTE0MTUwOTI5WhgPMjEyNjEw
MjExNTA5MjlaMBMxETAPBgNVBAMMCFRlc3QgSHViMIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEA2A84u+3FxWpnmSVndgAKLCIMC3O4WxaudOd0GnhVzv+M
NAk+Of7yBiRMrAhCvVq54PqZ5uOxwJ2TDh9UANXTDz11v4OyqbbdV0DfdjKTeoXR
NRX0KPF6+dNNzqd02J9vXHZ/hpgSiew7/ipDfyp9h7ycef/Rke6mpTYa0SA7ycRk
eJH3CQGGrLfQJKo6Rv7nKyfEkw1SrFYBwWeiZStcsWFQu2iXkXZ9HnfpgsLJ33X+
+ZPAv5vMPusHl6jJNfXb/ekil5YfcYW4nCgBnRoSreIUxdXfckWi7OZL6IPh2+iN
RvOX2GCJ3tLAQwfIr81NmFJlEpiGxOu19CiV5VNBhwIDAQABo1MwUTAdBgNVHQ4E
FgQUAMtpgBusssog7RjQFSfGoQnAWCAwHwYDVR0jBBgwFoAUAMtpgBusssog7RjQ
FSfGoQnAWCAwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEABece
UHne6VxcTapw7tneiF+otuQ0WFrjtailAAz3iDL2vPcC3zGWqbRDkenrguJDAOBt
G3ScUi8kHICCgUtPM/yfQ6sZFxKMlZnO2Rd1D26a7RmgAutWFiCG9PBkcAKV8fDd
nF+GZeobQgZpkDTylBD3BwyP0W7ob2a0DOt18NEk32hgmopC0wmNOrQJt229b1tk
jofaB7uo7KNkJxcJYowVIIaSutjdvTLVaAGwK6Rsqdgyo/CE0qGTd3i6it7hvT7z
QM0O2gb2nVupRuEmU1HKVgvsTC7tXTpkG4kcSYTrhyxBJGu/rEqzRxwgpHX2JFn/
jv1//F6Ns9adyZnx1A==
-----END CERTIFICATE-----`
const FP = new X509Certificate(CERT).fingerprint256

async function fakeHub(handler) {
  const seen = []
  const server = https.createServer({ key: KEY, cert: CERT }, (req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => { seen.push({ path: req.url, auth: req.headers.authorization, body: JSON.parse(body) }); handler(req, res) })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return { seen, hub: `127.0.0.1:${server.address().port}`, close: () => server.close() }
}

test('notices reach the hub with the token, pinned by fingerprint', async () => {
  const hub = await fakeHub((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, delivered: ['dex\\priya'] })) })
  try {
    const cfg = { enabled: true, hub: hub.hub, fingerprint: FP, token: 'dxc_test' }
    assert.equal(connectEnabled(cfg), true)
    const r = await postConnect(cfg, ['priya', 'priya'], 'Vikram sent you 3 files', { title: 'Saved to your Hopper Inbox' })
    assert.equal(r.ok, true)
    assert.deepEqual(r.delivered, ['dex\\priya'])
    assert.equal(hub.seen[0].path, '/api/bot/message')
    assert.equal(hub.seen[0].auth, 'Bearer dxc_test')
    assert.deepEqual(hub.seen[0].body, { text: 'Vikram sent you 3 files', to: ['priya'], card: { title: 'Saved to your Hopper Inbox' } })
  } finally { hub.close() }
})

test('a hub with a different certificate gets nothing', async () => {
  const hub = await fakeHub((req, res) => { res.writeHead(200); res.end('{"ok":true}') })
  try {
    const wrong = Array.from({ length: 32 }, () => 'AA').join(':')
    const r = await postConnect({ enabled: true, hub: hub.hub, fingerprint: wrong, token: 'dxc_test' }, ['priya'], 'secret')
    assert.equal(r.ok, false)
    assert.match(r.error, /different certificate/)
    assert.equal(hub.seen.length, 0)
  } finally { hub.close() }
})

test('unconfigured or unknown recipients report clearly and never throw', async () => {
  assert.equal(connectEnabled(undefined), false)
  assert.equal(connectEnabled({ enabled: true, hub: 'x', fingerprint: 'nope', token: 't' }), false)
  assert.match((await postConnect(undefined, ['a'], 'x')).error, /not configured/)
  const hub = await fakeHub((req, res) => { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, delivered: [], unknown: ['ghost'] })) })
  try {
    const r = await postConnect({ enabled: true, hub: hub.hub, fingerprint: FP, token: 't' }, ['ghost'], 'x')
    assert.equal(r.status, 404)
    assert.match(r.error, /ghost/)
  } finally { hub.close() }
})
