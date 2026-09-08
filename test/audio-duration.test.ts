// Durée lue dans le conteneur audio (brique du devis audio) : fixtures générées par
// ffmpeg (test/fixtures/audio, sinus 440 Hz), durées de référence ffprobe. Verrouille :
// wav/ogg-opus/ogg-vorbis/flac/mp3 (CBR + VBR + ID3), format non pris en charge
// (m4a) = null, fichier tronqué/inconnu = null, jamais une durée inventée.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { audioDurationSeconds } from '../src/audio-duration.ts'

const fx = (name: string) => readFileSync(new URL(`./fixtures/audio/${name}`, import.meta.url))

const close = (actual: number | null, expected: number, tol = 0.05) => {
  assert.ok(actual !== null, 'durée null')
  assert.ok(Math.abs(actual - expected) <= tol, `attendu ~${expected}s, lu ${actual}s`)
}

test('wav : data / byteRate', () => close(audioDurationSeconds(fx('tone.wav'), 'wav'), 1.5))
test('ogg opus : granule 48 kHz de la dernière page', () => close(audioDurationSeconds(fx('tone.ogg'), 'ogg'), 1.5065))
test('ogg vorbis : granule / fréquence du flux', () => close(audioDurationSeconds(fx('tone-vorbis.ogg'), 'ogg'), 1.5))
test('flac : STREAMINFO', () => close(audioDurationSeconds(fx('tone.flac'), 'flac'), 1.5))
test('mp3 CBR : somme des trames', () => close(audioDurationSeconds(fx('tone.mp3'), 'mp3'), 1.584))
test('mp3 VBR stéréo 44.1 kHz (avec en-tête Xing) : somme des trames', () => close(audioDurationSeconds(fx('tone-vbr.mp3'), 'mp3'), 2.0376, 0.06))

test('format non pris en charge (m4a/aac/aiff) : null, pas de devis', () => {
  assert.equal(audioDurationSeconds(fx('tone.m4a'), 'm4a'), null)
  assert.equal(audioDurationSeconds(fx('tone.m4a'), 'aac'), null)
})

test('contenu qui ne correspond pas au format annoncé ou tronqué : null', () => {
  assert.equal(audioDurationSeconds(fx('tone.wav'), 'ogg'), null)
  assert.equal(audioDurationSeconds(fx('tone.ogg'), 'wav'), null)
  assert.equal(audioDurationSeconds(fx('tone.flac'), 'mp3'), null) // aucune trame valide
  assert.equal(audioDurationSeconds(new Uint8Array(8), 'wav'), null)
  assert.equal(audioDurationSeconds(new Uint8Array(0), 'mp3'), null)
})

test('format insensible à la casse', () => close(audioDurationSeconds(fx('tone.wav'), 'WAV'), 1.5))
