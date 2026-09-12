/**
 * Full-screen login gate. When the deck requires OMP_DECK_ACCESS_TOKEN and
 * the browser has no session cookie (any API call 401s → store flag), the
 * app body is replaced by this gate: paste the access token once, verify
 * against POST /api/auth/login, and continue. The token is exchanged for an
 * HttpOnly session cookie server-side and never stored in JS-accessible
 * storage.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { KeyRound, Lock } from "lucide-react";

import { useStore } from "@/lib/store";
import { Button } from "@/components/ui/Button";

export function AuthGate({ children }: { children: React.ReactNode }) {
	const { t } = useTranslation();
	const unauthorized = useStore((s) => s.unauthorized);
	const login = useStore((s) => s.login);
	const [token, setToken] = useState("");
	const [remember, setRemember] = useState(true);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | undefined>();

	if (!unauthorized) return <>{children}</>;

	async function submit(): Promise<void> {
		const value = token.trim();
		if (!value || busy) return;
		setBusy(true);
		setError(undefined);
		const ok = await login(value, remember);
		setBusy(false);
		if (!ok) {
			setError(t("Login failed — check the token against OMP_DECK_ACCESS_TOKEN on the server."));
		}
	}

	return (
		<div className="flex h-full min-h-screen items-center justify-center bg-paper px-4">
			<div className="w-full max-w-md">
				<div className="rounded-xl border border-line bg-paper-2 p-8 shadow-[0_12px_40px_-12px_rgba(26,24,20,0.25)]">
					<div className="flex items-center gap-3">
						<div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent-soft text-accent">
							<Lock className="h-5 w-5" />
						</div>
						<div>
							<div className="text-lg font-semibold tracking-tight text-ink">omp·deck</div>
							<div className="text-xs text-ink-3">{t("Sign in to continue")}</div>
						</div>
					</div>

					<p className="mt-5 text-sm text-ink-3">
						{t(
							"This deck requires an access token. Enter the server's OMP_DECK_ACCESS_TOKEN — it is exchanged for a secure session cookie and never stored in this browser.",
						)}
					</p>

					<form
						className="mt-4 space-y-3"
						onSubmit={(e) => {
							e.preventDefault();
							void submit();
						}}
					>
						<label className="block">
							<div className="meta mb-1">{t("Access token")}</div>
							<div className="relative">
								<KeyRound className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-4" />
								<input
									className="field h-10 w-full pl-9 pr-2 font-mono text-sm"
									type="password"
									value={token}
									onChange={(e) => {
										setToken(e.target.value);
										setError(undefined);
									}}
									placeholder={t("Paste OMP_DECK_ACCESS_TOKEN")}
									autoComplete="off"
									autoFocus
									spellCheck={false}
								/>
							</div>
						</label>

						<label className="flex cursor-pointer items-center gap-2 text-xs text-ink-3">
							<input
								type="checkbox"
								checked={remember}
								onChange={(e) => setRemember(e.target.checked)}
								className="h-3.5 w-3.5"
							/>
							{t("Remember me (30 days) — skip login on this browser")}
						</label>

						{error ? (
							<div className="rounded-md border border-danger/30 bg-danger/10 px-3 py-2 font-mono text-xs text-danger">
								{error}
							</div>
						) : null}

						<Button type="submit" className="h-10 w-full text-sm" disabled={busy || !token.trim()}>
							{busy ? t("Signing in…") : t("Sign in")}
						</Button>
					</form>
				</div>
				<p className="mt-4 text-center font-mono text-2xs text-ink-4">
					{t("The token lives only on the server; this browser holds a session cookie.")}
				</p>
			</div>
		</div>
	);
}
