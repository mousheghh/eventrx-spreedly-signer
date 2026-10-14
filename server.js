// EventRx Spreedly signer
// Returns the nonce / timestamp / certificate token / signature that Spreedly's
// secured iFrame and Checkout SDK require. Only EventRx's Bubble backend calls it.

"use strict";

const http = require("node:http");
const crypto = require("node:crypto");

const PORT = Number(process.env.PORT) || 3000;
const MAX_BODY_BYTES = 1024;

function required(name) {
	const value = (process.env[name] || "").trim();
	if (!value) {
		console.error(`Missing required environment variable ${name}`);
		process.exit(1);
	}
	return value;
}

const apiKeyHash = crypto.createHash("sha256").update(required("SIGNER_API_KEY")).digest();
const certificateToken = required("SPREEDLY_CERTIFICATE_TOKEN");
const privateKey = crypto.createPrivateKey(Buffer.from(required("SPREEDLY_PRIVATE_KEY_BASE64"), "base64").toString("utf8"));

function isAuthorized(req) {
	const header = req.headers["authorization"] || "";
	const presented = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
	if (!presented) return false;
	const presentedHash = crypto.createHash("sha256").update(presented).digest();
	return crypto.timingSafeEqual(presentedHash, apiKeyHash);
}

function sign() {
	const nonce = crypto.randomUUID();
	const timestamp = Math.floor(Date.now() / 1000).toString();
	const signature = crypto.sign("sha256", Buffer.from(nonce + timestamp + certificateToken), privateKey).toString("base64");
	return { nonce, timestamp, certificate_token: certificateToken, signature };
}

function send(res, status, body) {
	res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
	res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
	const path = (req.url || "").split("?")[0];

	if (req.method === "GET" && path === "/health") return send(res, 200, { ok: true });

	if (req.method === "POST" && path === "/sign") {
		if (!isAuthorized(req)) return send(res, 401, { error: "unauthorized" });
		// The body is not used; drain it (bounded) so the connection closes cleanly.
		let size = 0;
		req.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) req.destroy();
		});
		req.on("end", () => {
			try {
				send(res, 200, sign());
			} catch (err) {
				console.error("Signing failed:", err.message);
				send(res, 500, { error: "signing_failed" });
			}
		});
		return;
	}

	send(res, 404, { error: "not_found" });
});

server.listen(PORT, "::", () => console.log(`EventRx Spreedly signer listening on ${PORT}`));

process.on("SIGTERM", () => server.close(() => process.exit(0)));
