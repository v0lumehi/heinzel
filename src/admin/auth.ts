import * as oidc from "openid-client";
import type { AdminRole } from "./types.js";

/** Maps the role/group claim of an ID token to an admin role. Admin wins over viewer; no match = no access. */
export function roleFromClaims(claims: Record<string, unknown>, claim: string, adminValues: string[], viewerValues: string[]): AdminRole | null {
  const raw = claims[claim];
  const values = Array.isArray(raw) ? raw.map(String) : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  if (values.some((v) => adminValues.includes(v))) return "admin";
  if (values.some((v) => viewerValues.includes(v))) return "viewer";
  return null;
}

export function splitList(s: string): string[] {
  return s.split(",").map((v) => v.trim()).filter(Boolean);
}

/** Login state kept in a short-lived cookie between the redirect to the provider and the callback. */
export interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
}

export interface OidcIdentity {
  subject: string;
  name: string | null;
  email: string | null;
  claims: Record<string, unknown>;
}

/** Authorization code flow with PKCE against any OpenID Connect provider (Entra ID, Keycloak, Okta, ...). */
export class OidcLogin {
  private constructor(
    private readonly config: oidc.Configuration,
    private readonly redirectUri: string,
  ) {}

  static async discover(o: { issuer: string; clientId: string; clientSecret: string; redirectUri: string }): Promise<OidcLogin> {
    const config = await oidc.discovery(new URL(o.issuer), o.clientId, o.clientSecret);
    return new OidcLogin(config, o.redirectUri);
  }

  async start(): Promise<{ url: string; pending: PendingLogin }> {
    const pending = { state: oidc.randomState(), nonce: oidc.randomNonce(), verifier: oidc.randomPKCECodeVerifier() };
    const url = oidc.buildAuthorizationUrl(this.config, {
      redirect_uri: this.redirectUri,
      scope: "openid profile email",
      response_type: "code",
      state: pending.state,
      nonce: pending.nonce,
      code_challenge: await oidc.calculatePKCECodeChallenge(pending.verifier),
      code_challenge_method: "S256",
    });
    return { url: url.href, pending };
  }

  /** Validates the callback (state, nonce, PKCE, ID token signature) and returns who signed in. */
  async finish(callbackUrl: URL, pending: PendingLogin): Promise<OidcIdentity> {
    const tokens = await oidc.authorizationCodeGrant(this.config, callbackUrl, {
      expectedState: pending.state,
      expectedNonce: pending.nonce,
      pkceCodeVerifier: pending.verifier,
      idTokenExpected: true,
    });
    const claims = tokens.claims() as Record<string, unknown> | undefined;
    if (!claims) throw new Error("The identity provider returned no ID token");
    const str = (v: unknown) => (typeof v === "string" && v ? v : null);
    return {
      subject: String(claims.sub),
      name: str(claims.name) ?? str(claims.preferred_username),
      email: str(claims.email) ?? str(claims.preferred_username),
      claims,
    };
  }
}
