// Durée d'un audio en ENTRÉE (content part `input_audio`), lue dans le conteneur —
// la brique du devis audio (plan.ts) : les providers facturent l'audio à la SECONDE
// (Voxtral via OpenRouter) ou au token par seconde (Gemini : 32 tokens/s), jamais à
// l'octet. Une borne par octets ne tient pas (l'opus encode le silence en quelques
// octets), donc on lit la durée déclarée par le conteneur ; format illisible ou
// inconnu = null = pas de devis (jamais une borne mensongère, même posture que le
// reste de plan.ts). Fonctions pures, sans dépendance, verrouillées par
// test/audio-duration.test.ts sur des fixtures générées par ffmpeg.
//
// Limite assumée : la durée est celle DÉCLARÉE (granule ogg, en-têtes wav/flac,
// trames mp3). Un conteneur trafiqué peut la sous-déclarer ; l'exposition est bornée
// par la taille de corps (OPENMULTI_MAX_BODY_BYTES) et reste un risque x402 accepté.

export type AudioFormat = 'wav' | 'ogg' | 'flac' | 'mp3'

/** Durée en secondes, ou null si le format n'est pas pris en charge / le fichier est
 * illisible. `format` = valeur du champ `input_audio.format` (minuscules). */
export function audioDurationSeconds(bytes: Uint8Array, format: string): number | null {
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  switch (format.toLowerCase()) {
    case 'wav': return wavDuration(buf)
    case 'ogg': return oggDuration(buf)
    case 'flac': return flacDuration(buf)
    case 'mp3': return mp3Duration(buf)
    default: return null
  }
}

function finitePositive(v: number): number | null {
  return Number.isFinite(v) && v > 0 ? v : null
}

// ── WAV (RIFF) : fmt.byteRate + taille du chunk data ────────────────────────────

function wavDuration(b: Buffer): number | null {
  if (b.length < 12 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WAVE') return null
  let byteRate: number | null = null
  let dataSize: number | null = null
  let off = 12
  while (off + 8 <= b.length) {
    const id = b.toString('latin1', off, off + 4)
    const size = b.readUInt32LE(off + 4)
    if (id === 'fmt ' && off + 8 + 16 <= b.length) byteRate = b.readUInt32LE(off + 16)
    if (id === 'data') {
      // Taille déclarée, écrêtée à ce qui est réellement présent (un en-tête menteur ne
      // gonfle pas la durée facturable... ni ne la réduit : le décodeur lit ce qu'il y a).
      dataSize = Math.min(size, b.length - off - 8)
      break
    }
    off += 8 + size + (size & 1)
  }
  if (byteRate === null || dataSize === null) return null
  return finitePositive(dataSize / byteRate)
}

// ── OGG (Opus / Vorbis) : granule de la dernière page / fréquence du flux ───────

function oggDuration(b: Buffer): number | null {
  if (b.length < 28 || b.toString('latin1', 0, 4) !== 'OggS') return null
  // Fréquence : en-tête d'identification dans la 1re page. Opus : granule TOUJOURS
  // à 48 kHz (RFC 7845 §4) quelle que soit la fréquence d'entrée. Vorbis : uint32 LE
  // à l'offset 12 du paquet d'identification (0x01 'vorbis' version(4) channels(1)).
  const segs = b[26]!
  const payload = 27 + segs
  if (payload + 16 > b.length) return null
  let rate: number
  if (b.toString('latin1', payload, payload + 8) === 'OpusHead') rate = 48000
  else if (b.toString('latin1', payload + 1, payload + 7) === 'vorbis') rate = b.readUInt32LE(payload + 12) // version(4) + channels(1) après le tag
  else return null
  const last = b.lastIndexOf('OggS', b.length - 1, 'latin1')
  if (last < 0 || last + 14 > b.length) return null
  const granule = Number(b.readBigInt64LE(last + 6))
  return finitePositive(granule / rate)
}

// ── FLAC : STREAMINFO (fréquence 20 bits, total d'échantillons 36 bits) ─────────

function flacDuration(b: Buffer): number | null {
  if (b.length < 4 + 4 + 34 || b.toString('latin1', 0, 4) !== 'fLaC') return null
  // 1er bloc de métadonnées = STREAMINFO obligatoirement (type 0), 34 octets.
  if ((b[4]! & 0x7f) !== 0) return null
  const s = 8
  const rate = (b[s + 10]! << 12) | (b[s + 11]! << 4) | (b[s + 12]! >> 4)
  const total = (b[s + 13]! & 0x0f) * 2 ** 32 + b.readUInt32BE(s + 14)
  if (rate === 0 || total === 0) return null // total 0 = inconnu par le conteneur
  return finitePositive(total / rate)
}

// ── MP3 : somme des trames (ID3v2 sauté, resynchro sur bruit) ───────────────────

const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000], // MPEG 1
  2: [22050, 24000, 16000], // MPEG 2
  0: [11025, 12000, 8000], // MPEG 2.5
}

function mp3Duration(b: Buffer): number | null {
  let off = 0
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'ID3') {
    const size = ((b[6]! & 0x7f) << 21) | ((b[7]! & 0x7f) << 14) | ((b[8]! & 0x7f) << 7) | (b[9]! & 0x7f)
    off = 10 + size
  }
  let seconds = 0
  let frames = 0
  while (off + 4 <= b.length) {
    const h = b.readUInt32BE(off)
    const sync = (h >>> 21) === 0x7ff
    const version = (h >>> 19) & 3 // 3 = MPEG1, 2 = MPEG2, 0 = MPEG2.5, 1 = réservé
    const layer = (h >>> 17) & 3 // 1 = Layer III
    const bitrateIdx = (h >>> 12) & 15
    const rateIdx = (h >>> 10) & 3
    const padding = (h >>> 9) & 1
    const rates = SAMPLE_RATES[version]
    if (!sync || layer !== 1 || bitrateIdx === 0 || bitrateIdx === 15 || rateIdx === 3 || !rates) {
      off += 1 // bruit / tag ID3v1 / trame inconnue : resynchro octet par octet
      continue
    }
    const sampleRate = rates[rateIdx]!
    const mpeg1 = version === 3
    const bitrate = (mpeg1 ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIdx]! * 1000
    const samples = mpeg1 ? 1152 : 576
    const frameLen = Math.floor((samples / 8) * bitrate / sampleRate) + padding
    if (frameLen <= 4) return null
    seconds += samples / sampleRate
    frames++
    off += frameLen
  }
  return frames > 0 ? finitePositive(seconds) : null
}
