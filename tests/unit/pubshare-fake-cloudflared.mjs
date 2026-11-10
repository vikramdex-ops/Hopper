// Stand-in for cloudflared in the supervisor tests: prints the same lines the real program prints
// and then behaves as the script file says. Nothing here touches the network.
//   FAKE_CF_DIR/script.json = [{ url, liveMs?, exit? } | { fail: true }, ...]  one entry per launch
import fs from 'node:fs'
import path from 'node:path'

const dir = process.env.FAKE_CF_DIR
const args = process.argv.slice(2)
if (args.includes('--version')) {
  console.log('cloudflared version 2026.1.0 (built 2026-01-01-0000 UTC) [stand-in]')
  process.exit(0)
}
const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')
const say = (level, msg) => process.stderr.write(`${stamp()} ${level} ${msg}\n`)

const countFile = path.join(dir, 'launches.txt')
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0
fs.writeFileSync(countFile, String(n + 1))
fs.appendFileSync(path.join(dir, 'launch-log.jsonl'), JSON.stringify({ n, pid: process.pid, args, hasToken: !!process.env.TUNNEL_TOKEN, token: process.env.TUNNEL_TOKEN ?? null }) + '\n')
const script = JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8'))
const step = script[Math.min(n, script.length - 1)]

if (args.includes('run')) {
  // named tunnel
  if (!process.env.TUNNEL_TOKEN) {
    say('ERR', 'Provided Tunnel token is not valid.')
    process.exit(1)
  }
  say('INF', 'Starting tunnel tunnelID=00000000-0000-0000-0000-000000000000')
  say('INF', 'Registered tunnel connection connIndex=0 connection=11111111 event=0 ip=198.41.200.13 location=bom12 protocol=quic')
} else if (step.fail) {
  say('INF', 'Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out.')
  say('INF', 'Requesting new quick Tunnel on trycloudflare.com...')
  process.stderr.write('failed to request quick Tunnel: Post "https://api.trycloudflare.com/tunnel": context deadline exceeded\n')
  process.exit(1)
} else {
  say('INF', 'Thank you for trying Cloudflare Tunnel. Doing so, without a Cloudflare account, is a quick way to experiment and try it out. However, be aware that these account-less Tunnels have no uptime guarantee, are subject to the Cloudflare Online Services Terms of Use (https://www.cloudflare.com/website-terms/), and Cloudflare reserves the right to investigate your use of Tunnels for violations of such terms.')
  say('INF', 'Requesting new quick Tunnel on trycloudflare.com...')
  say('INF', '+--------------------------------------------------------------------------------------------+')
  say('INF', '|  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |')
  say('INF', `|  ${step.url}${' '.repeat(Math.max(1, 90 - step.url.length))}|`)
  say('INF', '+--------------------------------------------------------------------------------------------+')
  say('INF', 'Version 2026.1.0 (Checksum 0000)')
  say('INF', 'Registered tunnel connection connIndex=0 connection=22222222 event=0 ip=198.41.192.57 location=maa01 protocol=quic')
}
if (step.liveMs) setTimeout(() => process.exit(step.exit ?? 1), step.liveMs)
else setInterval(() => {}, 1 << 30)
