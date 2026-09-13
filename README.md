# JARVIS

Daily-use, Windows-first voice AI desktop agent. Electron + React + TypeScript + Vite, Claude for reasoning/tool selection, ElevenLabs for speech, Deepgram/whisper.cpp for speech-to-text, Playwright for browser control, typed platform adapters for native Windows/macOS actions.

See `/Users/weston/.claude/plans/we-are-building-jarvis-fluttering-cookie.md` for the full architecture and milestone plan.

## Setup

```bash
npm install
cp .env.example .env   # then fill in ANTHROPIC_API_KEY, ELEVENLABS_API_KEY, DEEPGRAM_API_KEY
npm run dev
```

## Usage & budget limits

Every metered call (Anthropic tokens by model, Deepgram streaming minutes, ElevenLabs characters) is tracked and, by default, capped — see `src/main/usage/` and Command Center's **Usage & Budget** panel. Soft/hard $ limits (daily and monthly), the master protection switch, and the per-turn token/time safety net are all editable there; `.env.example` documents the env vars that seed their defaults. Protection is on by default and stops nonessential/optional API calls once a hard limit is hit without breaking local desktop-control tools (mute, open app, screenshot, self-test, etc. never call a metered service to begin with).

## Presence / hands-free (wake word)

JARVIS can run quietly in the background and wake on the local keyword "Jarvis" — see `src/main/presence/` and Command Center's **Presence** panel. Wake-word detection runs fully on-device (Picovoice Porcupine); no audio is sent anywhere while idle, and Deepgram/Claude/ElevenLabs are never touched until the wake word actually fires. It's optional: without a free Picovoice AccessKey (`PICOVOICE_ACCESS_KEY`, or paste it into Integrations), Presence just stays off and the Control+Space hotkey keeps working exactly as before. Global hotkeys: `Control+Space` toggles a conversation, `Control+Shift+Space` shows/hides Command Center, `Control+Shift+M` mutes/unmutes the mic (wake word included). Saying "that's all", "go back to sleep", or "end conversation" ends a session without a Claude call.

## Scripts

- `npm run dev` — launch in development
- `npm run build` — typecheck + production build
- `npm run build:mac` / `npm run build:win` — platform packages
- `npm test` — unit tests
