# Proving this isn't faked

An examiner's default assumption should be that a live demo could be
staged. Don't ask them to trust you — hand them tools that let them
check for themselves. Every step below uses something that isn't yours
to fake: the browser's own inspector, a second independent log file, or
a cryptographic hash they can recompute.

## 1. Let them type the sensitive data, not you

Pull up `http://localhost:8000/index.html` and have the examiner type
their own name, email, and phone into the fields — not the pre-loaded
canary values on `privacy-test.html`. If they chose the input, "you
rigged the demo" isn't a credible objection anymore.

## 2. Chrome's own Network tab, not your console.log

DevTools (F12) → **Network** tab → click the `POST /reason` request →
**Payload**. That's the browser's built-in inspector rendering the
literal bytes sent over the wire. You would have to tamper with Chrome
itself, live, to fake this.

## 3. The payload hash, shown two independent places

Every outbound request now gets a SHA-256 hash computed **client-side**
(in the extension, via the browser's own `crypto.subtle` API) and shown
right in the popup under "Proof — outbound payload hash." The **server**
independently computes the same hash over what it actually received
(`server/app/middleware.py`) and writes it to
`server/logs/reason_requests.jsonl`.

Open that log file in a text editor, side by side with the popup. After
one interaction:
- The hash in the popup and the hash in the newest log line should be
  **identical** — proof the bytes weren't altered or substituted between
  browser and server.
- The `parsed_body` in that same log line should contain **zero** of
  whatever the examiner just typed — have them read it themselves.

## 4. Turn off WiFi right before the reasoning step

This is the strongest single proof available. If reasoning were secretly
happening via a cloud API dressed up to look local, killing the network
connection would break it immediately. It won't — disconnect WiFi, then
trigger the pipeline again, and it still completes. `ollama serve` and
this entire loop run on this machine, offline.

## 5. Show the model is actually here

```bash
ollama list      # shows qwen2.5:7b-instruct really is downloaded, with its size
ollama ps        # shows it loaded into this GPU's VRAM right now
```

## 6. Run the canary check on their exact input

`scripts/canary_check.py` ships with 5 known test values, but for a live
demo it also accepts the examiner's own typed values directly:

```bash
python scripts/canary_check.py --value "whatever.they.typed@example.com" --value "their real name"
```

Run it in front of them, on a value they just chose. `PASS` means those
exact strings were checked against the real request log and found zero
times — not a pre-arranged result.

## What NOT to rely on

- Your own narration of what happened — always point to the tool that
  proves it instead.
- A screenshot prepared beforehand — everything above should run live,
  on their input, in the room.
- `console.log` alone — it's your code; the Network tab and the
  server-side log file are independent of what the extension claims
  about itself.
