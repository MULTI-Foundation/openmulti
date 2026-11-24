// Controle des dependances de production : echoue sur toute faille haute ou
// critique qui n'est pas une exception nommee dans audit-exceptions.json.
// Une exception porte une raison et une date limite : passee cette date, elle
// ne vaut plus et le controle echoue, pour forcer a la reexaminer.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const exceptions = JSON.parse(
  readFileSync(new URL('../audit-exceptions.json', import.meta.url), 'utf8'),
)
const today = new Date().toISOString().slice(0, 10)

let raw
try {
  raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
} catch (err) {
  // npm audit sort en erreur des qu'il trouve une faille : le rapport est sur stdout.
  raw = err.stdout
}
const report = JSON.parse(raw)
if (!report.vulnerabilities) {
  console.error('Rapport npm audit illisible :', JSON.stringify(report).slice(0, 300))
  process.exit(2)
}

// Seules les entrees objet de `via` sont des avis ; les chaines sont des
// paquets qui heritent de la faille d'un autre, deja comptee a sa source.
const advisories = new Map()
for (const [name, vuln] of Object.entries(report.vulnerabilities)) {
  for (const via of vuln.via) {
    if (typeof via !== 'object') continue
    if (via.severity !== 'high' && via.severity !== 'critical') continue
    const id = via.url.split('/').pop()
    advisories.set(id, { id, name, severity: via.severity, title: via.title, range: via.range })
  }
}

const blocking = []
for (const adv of advisories.values()) {
  const exc = exceptions[adv.id]
  if (!exc) {
    blocking.push(`${adv.id} ${adv.name} ${adv.range} (${adv.severity}) : ${adv.title}`)
  } else if (exc.expire < today) {
    blocking.push(`${adv.id} ${adv.name} : exception expiree le ${exc.expire}, a reexaminer`)
  } else {
    console.log(`exception ${adv.id} ${adv.name} jusqu'au ${exc.expire} : ${exc.raison}`)
  }
}
for (const id of Object.keys(exceptions)) {
  if (!advisories.has(id)) console.log(`exception ${id} devenue inutile : la retirer`)
}

if (blocking.length > 0) {
  console.error('Failles hautes ou critiques non couvertes :')
  for (const line of blocking) console.error('  ' + line)
  process.exit(1)
}
console.log('Aucune faille haute ou critique non couverte.')
