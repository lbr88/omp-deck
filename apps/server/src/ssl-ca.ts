/**
 * Resolve a system CA bundle and inject GIT_SSL_CAINFO / NODE_EXTRA_CA_CERTS
 * so outbound git (GitHub clone, worktrees) does not fail on hosts whose
 * default CA path is missing. Idempotent; honors GIT_SSL_NO_VERIFY=true.
 */
import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import * as path from "node:path";

import { logger } from "./log.ts";

const log = logger("ssl-ca");

let sslFixApplied = false;
let sslFixBundle: string | undefined;

function resolveCABundle(): string | undefined {
	const env = process.env.GIT_SSL_CAINFO ?? process.env.SSL_CERT_FILE;
	if (env && existsSync(env)) return env;
	const candidates: string[] = [];
	if (process.platform === "win32") {
		candidates.push(
			"C:\\Program Files\\Git\\mingw64\\etc\\ssl\\certs\\ca-bundle.crt",
			"C:\\Program Files\\Git\\usr\\ssl\\certs\\ca-bundle.crt",
		);
	} else if (process.platform === "darwin") {
		candidates.push(
			"/etc/ssl/cert.pem",
			"/usr/local/etc/openssl/cert.pem",
			"/opt/homebrew/etc/openssl@3/cert.pem",
		);
	} else {
		candidates.push(
			"/etc/ssl/certs/ca-certificates.crt",
			"/etc/pki/tls/certs/ca-bundle.crt",
			"/etc/ssl/cert.pem",
		);
	}
	for (const c of candidates) if (existsSync(c)) return c;
	try {
		const out = execFileSync("openssl", ["version", "-d"], { encoding: "utf-8" });
		const m = /OPENSSLDIR\s*:\s*"?([^"\s]+)"?/.exec(out);
		if (m) {
			const dir = m[1]!.trim();
			const probe = path.join(dir, "cert.pem");
			if (existsSync(probe)) return probe;
		}
	} catch {
		// openssl absent
	}
	return undefined;
}

export function applySslFix(): { applied: boolean; bundle?: string; note?: string } {
	if (sslFixApplied) return { applied: true, bundle: sslFixBundle };
	if (process.env.GIT_SSL_NO_VERIFY === "true") {
		sslFixApplied = true;
		return { applied: true, note: "user opted out via GIT_SSL_NO_VERIFY" };
	}
	const bundle = resolveCABundle();
	if (!bundle) {
		sslFixApplied = true;
		return { applied: true, note: "no system CA bundle located" };
	}
	process.env.GIT_SSL_CAINFO = bundle;
	if (!process.env.NODE_EXTRA_CA_CERTS) {
		process.env.NODE_EXTRA_CA_CERTS = bundle;
	}
	sslFixApplied = true;
	sslFixBundle = bundle;
	log.info(`SSL CA bundle wired: ${bundle}`);
	return { applied: true, bundle };
}
