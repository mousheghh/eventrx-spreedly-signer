# EventRx Spreedly signer (Railway)

A tiny service with no dependencies, built on Node's own modules. It signs Spreedly's secured payment-form sessions.
EventRx's Bubble backend calls it each time an exhibitor opens **Pay now**. The browser never calls it.

| Route | What it does |
|---|---|
| `GET /health` | Returns `{"ok":true}` for Railway health checks |
| `POST /sign` | Requires `Authorization: Bearer <SIGNER_API_KEY>`. Returns `{ nonce, timestamp, certificate_token, signature }`. |

Signature = Base64( RSA-SHA256( `nonce + timestamp + certificate_token` ) ) with the private key. Timestamp is Unix seconds. Spreedly accepts the values for 30 minutes.

---

## Step 1: Create the key pair and certificate (once, on your computer)

Run these on a Mac/Linux terminal (or Git Bash on Windows) **in an empty folder outside the repo**:

```bash
# 1. Private key (SECRET: never commit, email, or paste into Bubble)
openssl genrsa -out private_key.pem 3072

# 2. Self-signed certificate, valid 3 years.
#    Spreedly's docs omit -days, and OpenSSL then defaults to 30 days.
#    Always include -days 1095.
openssl req -new -x509 -key private_key.pem -out cert.pem -days 1095 \
  -subj "/C=US/O=EventRx/CN=eventrx.com"

# 3. Check the expiry date (put a reminder in your calendar ~1 month before)
openssl x509 -in cert.pem -noout -enddate

# 4. One-line version of the private key for Railway
base64 < private_key.pem | tr -d '\n' > private_key.b64
```

## Step 2: Upload the certificate to Spreedly (once)

One **organization-level** certificate works for both your Test and Live Spreedly environments:

```bash
curl https://core.spreedly.com/v1/certificates.json \
  -u "<ENVIRONMENT_KEY>:<ACCESS_SECRET>" \
  -H "Content-Type: application/json" \
  -d "{\"certificate\":{\"pem\":$(jq -Rs . < cert.pem),\"level\":\"organization\"}}"
```

From the response, copy `certificate.token`. That's your **SPREEDLY_CERTIFICATE_TOKEN**.
*(Easier: `cert.pem` is a public certificate, not a secret. You can paste its contents into the chat and Buildprint will upload it and give you the token.)*

Then, in **app.spreedly.com → each environment (Test and Live) → Settings**, turn on **Enhanced Security** for iFrame/Checkout SDK tokenization.
Do this **after** the payment form is live in Bubble. Until then, any existing unsigned forms in that environment would stop working.

## Step 3: Create the API key Bubble will use

```bash
openssl rand -hex 32
```
That's your **SIGNER_API_KEY**. Never paste it in the chat. You'll put it in Railway (Step 4) and in Bubble's API Connector yourself (Step 6).

## Step 4: Deploy on Railway

1. Put this folder (`server.js`, `package.json`, `.gitignore`, `README.md`) in a **private GitHub repo**.
   *(Or skip GitHub: install the Railway CLI, `cd` into this folder, run `railway login`, `railway init`, `railway up`.)*
2. **railway.com → New Project → Deploy from GitHub repo** → pick the repo. Railway detects Node and runs `npm start`.
3. Service → **Variables** → add:

   | Variable | Value |
   |---|---|
   | `SPREEDLY_PRIVATE_KEY_BASE64` | contents of `private_key.b64` (one long line) |
   | `SPREEDLY_CERTIFICATE_TOKEN` | the token from Step 2 |
   | `SIGNER_API_KEY` | the value from Step 3 |

   Don't set `PORT`. Railway provides it.
4. Service → **Settings → Networking → Generate Domain**. You'll get something like `https://eventrx-spreedly-signer-production.up.railway.app`.
5. Service → **Settings → Deploy → Healthcheck Path** = `/health`.
6. Redeploy. The logs should show `EventRx Spreedly signer listening on …`.
   If a variable is missing or the key can't be read, the service stops at startup and logs which variable is the problem.

## Step 5: Test it

```bash
URL=https://<your-domain>.up.railway.app
curl -s $URL/health                                   # {"ok":true}
curl -s -o /dev/null -w "%{http_code}\n" -X POST $URL/sign   # 401 (no key)
curl -s -X POST -H "Authorization: Bearer <SIGNER_API_KEY>" $URL/sign
# {"nonce":"…","timestamp":"…","certificate_token":"…","signature":"…"}
```

Optional: prove the signature matches your certificate (run in the folder with `cert.pem`):
```bash
R=$(curl -s -X POST -H "Authorization: Bearer <SIGNER_API_KEY>" $URL/sign)
N=$(echo "$R" | jq -r .nonce); T=$(echo "$R" | jq -r .timestamp); C=$(echo "$R" | jq -r .certificate_token)
echo "$R" | jq -r .signature | base64 -d > sig.bin
openssl x509 -in cert.pem -pubkey -noout > pub.pem
printf '%s' "$N$T$C" | openssl dgst -sha256 -verify pub.pem -signature sig.bin   # Verified OK
```

## Step 6: Connect Bubble
- Send the Railway URL in the chat (it isn't a secret).
- Once the **EventRx Signer** API is added to the API Connector, open it in the Bubble editor and paste `Bearer <SIGNER_API_KEY>` into its private key field, in both the development and live boxes.

**After deploying,** delete `private_key.b64`. Store `private_key.pem` in your password manager, or delete it too: if lost, you just make a new pair and repeat Steps 1–2 and 4.

---

## Security notes
- The private key exists only in Railway's encrypted variables. Bubble never sees it.
- `/sign` rejects any call without the API key (constant-time comparison). Responses are `no-store`.
- The returned values are safe for the browser: they're single-use and expire in 30 minutes.
- Bubble only calls `/sign` after checking that the user is the request's payer and the request is payable.
- **Rotation** (every ≤3 years, or if a key leaks):
  1. Repeat Steps 1–2 (new pair, new certificate token).
  2. Update the two Railway variables.
  3. Redeploy.

  No Bubble changes are needed. To rotate the API key, update `SIGNER_API_KEY` in Railway and in Bubble's API Connector together.
- If the signer is down, exhibitors can't open the payment form. Payments already made aren't affected. Railway's health check restarts it automatically.
