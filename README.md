# JARVIS

Daily-use, Windows-first voice AI desktop agent. Electron + React + TypeScript + Vite, Claude for reasoning/tool selection, ElevenLabs for speech, Deepgram/whisper.cpp for speech-to-text, Playwright for browser control, typed platform adapters for native Windows/macOS actions.

See `/Users/weston/.claude/plans/we-are-building-jarvis-fluttering-cookie.md` for the full architecture and milestone plan.

## Setup

```bash
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, DEEPGRAM_API_KEY
npm run dev
```

## Scripts

- `npm run dev` — launch in development
- `npm run build` — typecheck + production build
- `npm run build:mac` / `npm run build:win` — platform packages
- `npm test` — unit tests
