#!/usr/bin/env node
/**
 * Standalone integration test for the three external voice services —
 * Deepgram STT, Claude, ElevenLabs TTS — independent of Electron. Useful
 * for verifying credentials/streaming without needing a real microphone
 * or the full app running (mic access + OS permissions are the one thing
 * this script does NOT exercise).
 *
 * Usage: node scripts/test-voice-pipeline.mjs [path/to/16kHz-mono-s16le.pcm] ["spoken text"]
 * If a PCM file is given, it's streamed to Deepgram to produce the prompt.
 * Otherwise the text argument (or a default prompt) is used directly,
 * skipping STT.
 */
import 'dotenv/config'
import WebSocket from 'ws'
import Anthropic from '@anthropic-ai/sdk'
import { writeFileSync } from 'fs'

const DEEPGRAM_API_KEY = process.env.DEEPGRAM_API_KEY
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY
const ELEVENLABS_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '2eG0V12z6Hg7luZwRG2V'
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

const pcmPath = process.argv[2]
const textArg = process.argv.slice(3).join(' ')

const t0 = performance.now()
const mark = (label) => console.log(`[${(performance.now() - t0).toFixed(0)}ms] ${label}`)

async function transcribeFile(path) {
  const pcm = await import('fs').then((fs) => fs.readFileSync(path))
  const sampleRate = 16000
  const params = new URLSearchParams({
    model: 'nova-3',
    language: 'en',
    punctuate: 'true',
    smart_format: 'true',
    interim_results: 'true',
    endpointing: '300',
    encoding: 'linear16',
    sample_rate: String(sampleRate),
    channels: '1'
  })

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
      headers: { Authorization: `Token ${DEEPGRAM_API_KEY}` }
    })
    let finalText = ''
    let firstInterimAt = null

    ws.on('open', async () => {
      mark('Deepgram WS open — streaming audio')
      const chunkSize = 4096 * 2 // bytes, matches renderer's 4096-sample chunks
      const realtimeMsPerChunk = (4096 / sampleRate) * 1000
      for (let i = 0; i < pcm.length; i += chunkSize) {
        ws.send(pcm.subarray(i, i + chunkSize))
        await new Promise((r) => setTimeout(r, realtimeMsPerChunk))
      }
      mark('finished streaming audio, sending CloseStream')
      ws.send(JSON.stringify({ type: 'CloseStream' }))
    })

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type !== 'Results') return
      const alt = msg.channel?.alternatives?.[0]
      const text = alt?.transcript ?? ''
      if (!text) return
      if (!firstInterimAt) {
        firstInterimAt = performance.now()
        mark(`first interim transcript: "${text}"`)
      }
      if (msg.is_final) {
        finalText = `${finalText} ${text}`.trim()
        mark(`final segment: "${text}"`)
      }
    })

    ws.on('close', () => {
      mark(`Deepgram closed — full transcript: "${finalText}"`)
      resolve(finalText)
    })
    ws.on('error', reject)
  })
}

async function askClaude(userText) {
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY })
  const stream = client.messages.stream({
    model: 'claude-haiku-4-5',
    max_tokens: 1024,
    system:
      'You are JARVIS, a polished British operating assistant. Reply in one short spoken sentence, no markdown, no lists.',
    messages: [{ role: 'user', content: userText }]
  })
  let fullText = ''
  let firstTokenAt = null
  stream.on('text', (delta) => {
    if (!firstTokenAt) {
      firstTokenAt = performance.now()
      mark(`Claude first token`)
    }
    fullText += delta
  })
  await stream.finalMessage()
  mark(`Claude done: "${fullText}"`)
  return fullText
}

async function speak(text, outPath) {
  const params = new URLSearchParams({ model_id: 'eleven_flash_v2_5', output_format: 'pcm_16000' })
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `wss://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}/stream-input?${params}`,
      { headers: { 'xi-api-key': ELEVENLABS_API_KEY } }
    )
    const chunks = []
    let firstAudioAt = null

    ws.on('open', () => {
      mark('ElevenLabs WS open')
      ws.send(
        JSON.stringify({
          text: ' ',
          voice_settings: { stability: 0.5, similarity_boost: 0.8 },
          generation_config: { chunk_length_schedule: [50, 90, 120, 150] }
        })
      )
      ws.send(JSON.stringify({ text: `${text} ` }))
      ws.send(JSON.stringify({ text: '' }))
    })

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.audio) {
        if (!firstAudioAt) {
          firstAudioAt = performance.now()
          mark('ElevenLabs first audio chunk')
        }
        chunks.push(Buffer.from(msg.audio, 'base64'))
      }
      if (msg.isFinal) {
        mark('ElevenLabs isFinal received')
        ws.close()
      }
    })
    ws.on('close', () => {
      const pcm = Buffer.concat(chunks)
      mark(`ElevenLabs closed — ${pcm.length} bytes of PCM audio received`)
      // Wrap raw PCM16/16kHz mono in a minimal WAV header so it's playable.
      const wavHeader = Buffer.alloc(44)
      wavHeader.write('RIFF', 0)
      wavHeader.writeUInt32LE(36 + pcm.length, 4)
      wavHeader.write('WAVE', 8)
      wavHeader.write('fmt ', 12)
      wavHeader.writeUInt32LE(16, 16)
      wavHeader.writeUInt16LE(1, 20)
      wavHeader.writeUInt16LE(1, 22)
      wavHeader.writeUInt32LE(16000, 24)
      wavHeader.writeUInt32LE(32000, 28)
      wavHeader.writeUInt16LE(2, 32)
      wavHeader.writeUInt16LE(16, 34)
      wavHeader.write('data', 36)
      wavHeader.writeUInt32LE(pcm.length, 40)
      writeFileSync(outPath, Buffer.concat([wavHeader, pcm]))
      resolve(outPath)
    })
    ws.on('error', reject)
  })
}

async function main() {
  if (!DEEPGRAM_API_KEY || !ANTHROPIC_API_KEY || !ELEVENLABS_API_KEY) {
    console.error('Missing one or more of DEEPGRAM_API_KEY / ANTHROPIC_API_KEY / ELEVENLABS_API_KEY in .env')
    process.exit(1)
  }

  let userText = textArg
  if (pcmPath) {
    mark(`Transcribing ${pcmPath} via Deepgram`)
    userText = await transcribeFile(pcmPath)
    if (!userText) {
      console.error('Deepgram returned no transcript.')
      process.exit(1)
    }
  }
  if (!userText) userText = 'What is the capital of France?'

  const replyText = await askClaude(userText)
  const outPath = pcmPath ? pcmPath.replace(/\.pcm$/, '.reply.wav') : '/tmp/jarvis-reply.wav'
  await speak(replyText, outPath)
  mark(`Done. Reply audio saved to ${outPath}`)
}

main().catch((err) => {
  console.error('Pipeline test failed:', err)
  process.exit(1)
})
