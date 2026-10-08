# cortese-voice

AI phone assistant for Cortese Digital — makes and takes calls, pitches the
Busy-Line Recovery Engine honestly and briefly, and books demos.

## v0.1 (this build) — Twilio-native speech

- Outbound: `POST /call {to}` → Twilio dials, greets with a spoken pitch
- Conversation: `<Gather speech>` transcripts → OpenRouter LLM (bounded pitch
  script + objection handling) → spoken reply
- Every call ends with an `outcome` line appended to `outcomes.jsonl`
  (transcript + one-line result) — that file is your CRM feed
- Polite by design: discloses it's automated in sentence one, one objection
  answer max, always offers the free demo link before hanging up

### The automation layer (`dialer.js`)

`node dialer.js` reads `call-queue.csv` and fires calls at a civilized pace
(default: 6 per run, 90s apart — change with `MAX_CALLS` / `CALL_GAP_SEC`).
The queue builder (`build-queue.js`) exports phone-only leads straight from
your prospects.csv:

```bash
node build-queue.js /path/to/prospects.csv
node dialer.js
```

Combo it with cron for a daily calling block: it skips numbers already
logged with any outcome in `outcomes.jsonl` (never double-dials).

### Run it

```bash
cp .env.example .env   # fill in keys
npm install
node server.js         # in one terminal
ngrok http 8080        # tunnel; put the URL in PUBLIC_URL
node build-queue.js ... && node dialer.js
```

### What you need (2 keys, ~10 min)

1. **Twilio** — trial works for dev ($15 free credit). Buy a voice number.
2. **OpenRouter** — you know this one. `claude-3.5-haiku` default; cheap+fast.

Per-call cost ≈ $0.015/min telephony + ~$0.002 LLM. A 3-minute call ≈ 5 cents.

## v0.2 roadmap — natural voice upgrade

Media Streams websocket → Deepgram STT (streaming, barge-in) → LLM →
ElevenLabs TTS → Twilio. Latency ~1.2s, sounds human, handles noisy kitchens.
Same brain (`SYSTEM_PROMPT` in server.js), better ears and mouth.

## ⚖️ Use responsibly

- The bot discloses it's automated — keep it that way (legally and because
  honesty converts better with owners).
- B2B landlines with honest ID + callback number: generally fine. Cold
  AI-voice to cell phones: TCPA-restricted — get consent or don't.
- Log every outcome; honor STOP immediately.

Built by Cloudclaw for Steve · Cortese Digital
