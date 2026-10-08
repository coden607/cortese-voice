const express = require('express');
const twilio = require('twilio');
const OpenAI = require('openai');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// Boot-time sanity: warn (never crash) on missing/placeholder config.
const REQUIRED_ENV = ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_PHONE', 'PUBLIC_URL', 'OPENROUTER_KEY'];
for (const key of REQUIRED_ENV) {
  const val = process.env[key];
  if (!val || /xxxx|your-|example/i.test(val)) {
    console.warn(`[cortese-voice] WARNING: ${key} is missing or looks like a placeholder — live calls/LLM will fail until .env is filled in.`);
  }
}

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

// Lazy LLM client: the OpenAI SDK throws at construction if apiKey is unset,
// which would crash the whole server before Twilio webhooks can even answer.
let _llm = null;
function getLLM() {
  if (!_llm) {
    if (!process.env.OPENROUTER_KEY) return null;
    _llm = new OpenAI({ baseURL: 'https://openrouter.ai/api/v1', apiKey: process.env.OPENROUTER_KEY });
  }
  return _llm;
}

const VOICE = process.env.TWILIO_VOICE || 'Polly.Joanna';
const FROM = process.env.TWILIO_PHONE;

// ---------------------------------------------------------------
// The brain: bounded pitch script + objection handling.
// Goal of every call: permission to send the demo link / book 15-min demo.
// ---------------------------------------------------------------
const SYSTEM_PROMPT = `You are a brief, warm, honest phone assistant for Cortese Digital, calling independent pizzerias and takeout restaurants on behalf of Stephen Blanford (a real one-man operator in Binghamton, NY).

RULES:
- You MUST disclose you are an automated assistant in your first sentence.
- Keep every reply under 3 sentences. This is a busy kitchen; brevity wins.
- The offer: when the shop's line is busy, our system texts the missed caller back instantly ("sorry we missed you — text your order?") and lands it on a counter tablet. $0 upfront. We bill 15% of recovered orders only. No new number, no app, no training.
- If interested OR even curious: your ONLY goal is to get permission to text/email the 30-second demo link, or book a 15-minute live demo. Ask which they prefer.
- Objections:
  * "how much / costs" -> "$0 to start, $0 equipment. We only bill 15% of orders we actually recover. No recovery, no charge, ever."
  * "not interested" -> one short graceful close: offer the free demo link anyway, thank them, end.
  * "send info / email me" -> confirm the best address or number, thank them, end.
  * "call back later" -> ask what day/time works, log it, thank them, end.
  * "is this a robot / spam" -> "Yes, an automated assistant — Stephen built me to reach shops fairly. He'll personally handle anything you want to discuss."
- NEVER argue. One objection answer max, then pivot to the demo-link ask or close.
- If asked anything outside this scope: "Great question for Stephen — I'll flag it. Can I send the 30-second demo so you can see it?"
- When the conversation reaches an end state, output exactly: [[END: <one-line outcome summary>]]`;

const calls = new Map(); // callSid -> { history: [], outcome }

function twimlSay(text) {
  const t = new twilio.twiml.VoiceResponse();
  t.say({ voice: VOICE }, text);
  return t;
}

// Outbound trigger: POST /call {to: "+1570..."}
app.post('/call', async (req, res) => {
  const { to } = req.body;
  if (!to) return res.status(400).json({ error: 'need {to: E.164 number}' });
  if (!FROM || !process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
    return res.status(503).json({ error: 'Twilio not configured — fill .env (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE)' });
  }
  try {
    const call = await client.calls.create({
      to, from: FROM,
      url: `${process.env.PUBLIC_URL}/voice`,
      statusCallback: `${process.env.PUBLIC_URL}/status`,
      statusCallbackEvent: ['completed'],
      machineDetection: 'Enable', // skip voicemail boxes politely
    });
    calls.set(call.sid, { history: [], outcome: null, to });
    res.json({ sid: call.sid, to });
  } catch (e) {
    // Twilio rejects (401 bad creds, 21612 invalid number, etc.) become clean JSON, never an HTML stack trace
    console.error('Twilio call error:', e.message);
    res.status(502).json({ error: `twilio: ${e.message}` });
  }
});

// First contact
app.post('/voice', (req, res) => {
  const sid = req.body.CallSid;
  if (!calls.has(sid)) calls.set(sid, { history: [], outcome: null, to: req.body.To });
  const opening = "Hi! Quick one — I'm an automated assistant calling for Stephen at Cortese Digital. We fix busy phone lines for pizzerias: when your line's busy, we text the caller back instantly so you don't lose the order. Worth thirty seconds?";
  replyWithGather(res, sid, opening);
});

// Every caller turn lands here (Twilio transcribes the speech)
app.post('/handle', async (req, res) => {
  const sid = req.body.CallSid;
  const speech = (req.body.SpeechResult || '').trim();
  const state = calls.get(sid) || { history: [] };

  if (speech) {
    state.history.push({ role: 'user', content: speech });
    const aiText = await getAgentReply(state);
    if (aiText.includes('[[END:')) {
      state.outcome = aiText.split('[[END:')[1].split(']]')[0].trim();
      logOutcome(sid, state);
      const closing = aiText.split('[[END:')[0].trim() || "Thanks for your time — have a great dinner rush!";
      const t = twimlSay(closing);
      t.hangup();
      return res.type('text/xml').send(t.toString());
    }
    return replyWithGather(res, sid, aiText);
  }
  // No speech: one retry, then graceful close
  const t = new twilio.twiml.VoiceResponse();
  t.say({ voice: VOICE }, "I'll take the silence as a no — I'll text the free demo link anyway, zero obligation. Have a great service!");
  t.hangup();
  logOutcome(sid, { ...state, outcome: 'no-response' });
  res.type('text/xml').send(t.toString());
});

async function replyWithGather(res, sid, text) {
  const state = calls.get(sid);
  if (text) state.history.push({ role: 'assistant', content: text });
  const t = new twilio.twiml.VoiceResponse();
  t.say({ voice: VOICE }, text);
  t.gather({ input: 'speech', timeout: 6, speechTimeout: 'auto', action: '/handle', method: 'POST' });
  // if gather times out entirely, /handle gets no SpeechResult
  res.type('text/xml').send(t.toString());
}

async function getAgentReply(state) {
  const llm = getLLM();
  if (!llm) {
    return "Stephen will follow up personally — I'll have him call you back. Thanks for your time! [[END: llm-not-configured, manual follow-up]]";
  }
  try {
    const r = await llm.chat.completions.create({
      model: process.env.LLM_MODEL || 'anthropic/claude-3.5-haiku',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...state.history.slice(-12)],
      max_tokens: 220, temperature: 0.3,
    });
    return r.choices[0].message.content.trim();
  } catch (e) {
    console.error('LLM error:', e.message);
    return "Stephen will follow up personally — I'll have him call you back. Thanks for your time! [[END: llm-error, manual follow-up]]";
  }
}

function logOutcome(sid, state) {
  const line = JSON.stringify({ sid, to: state.to, at: new Date().toISOString(), outcome: state.outcome, transcript: state.history.map(m => `${m.role}: ${m.content}`).join(' | ') }) + '\n';
  require('fs').appendFileSync('./outcomes.jsonl', line);
  console.log('OUTCOME', state.outcome);
}

app.post('/status', (req, res) => {
  console.log('call ended:', req.body.CallSid, req.body.CallStatus);
  res.sendStatus(200);
});

app.get('/health', (_req, res) => res.json({ ok: true, active: calls.size }));

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`cortese-voice v0.1 on :${PORT}`));
