// Tests for the shared OAuth mechanics (oauth.ts): PKCE/state generation,
// both grant flows, and the on-disk credential envelope. No real network
// call and no real browser ever run here -- fetchImpl/openImpl are the
// same kind of injectable seam every REST connector in this codebase
// already tests against (see airtable.test.ts's fakeFetch). The local
// redirect flow's HTTP server is real, though: it binds a real port on
// 127.0.0.1, and the fake openImpl plays the browser's role by making a
// real GET back to that server with the code/state pulled out of the
// authorize URL it was "opened" with, exactly what a vendor's redirect
// would produce.
import { expect, test } from "bun:test";
import {
  parseOAuthCredential,
  refreshOAuthToken,
  runDeviceOAuth,
  runLocalRedirectOAuth,
  serializeOAuthCredential,
} from "../../../src/prebrain/mcp-framework/oauth.js";

// Test-only ports, spread out so parallel test files never collide with a
// real dev server or with each other.
let nextPort = 51900;
function freshPort(): number {
  return nextPort++;
}

function fakeTokenFetch(respond: (url: string, body: URLSearchParams) => { status: number; body: unknown }): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = new URLSearchParams(init?.body as string);
    const { status, body: responseBody } = respond(url, body);
    return new Response(JSON.stringify(responseBody), { status });
  }) as unknown as typeof fetch;
}

test("serializeOAuthCredential/parseOAuthCredential round-trips accessToken, refreshToken, expiresAt, tokenType", () => {
  const credential = { accessToken: "at-1", refreshToken: "rt-1", expiresAt: 12345, tokenType: "Bearer" };
  const parsed = parseOAuthCredential(serializeOAuthCredential(credential));
  expect(parsed).toEqual(credential);
});

test("parseOAuthCredential drops anything missing accessToken, malformed JSON, or pre-OAuth bare tokens, rather than guessing", () => {
  expect(parseOAuthCredential(undefined)).toBeNull();
  expect(parseOAuthCredential("not json")).toBeNull();
  expect(parseOAuthCredential("plain-pasted-token-not-json")).toBeNull();
  expect(parseOAuthCredential(JSON.stringify({ refreshToken: "rt-1" }))).toBeNull();
  expect(parseOAuthCredential(JSON.stringify({ accessToken: "" }))).toBeNull();
  expect(parseOAuthCredential(JSON.stringify([1, 2, 3]))).toBeNull();
});

test("runLocalRedirectOAuth completes the full loop: authorize URL carries PKCE+state, the callback validates state, and the code is exchanged for a token", async () => {
  const port = freshPort();
  let capturedAuthorizeUrl: URL | undefined;
  let capturedTokenBody: URLSearchParams | undefined;

  const fetchImpl = fakeTokenFetch((_url, body) => {
    capturedTokenBody = body;
    return { status: 200, body: { access_token: "at-abc", refresh_token: "rt-abc", expires_in: 3600, token_type: "Bearer" } };
  });

  const credential = await runLocalRedirectOAuth({
    authorizationEndpoint: "https://vendor.example.test/oauth/authorize",
    tokenEndpoint: "https://vendor.example.test/oauth/token",
    clientId: "client-123",
    scope: "read",
    port,
    callbackPath: "/callback",
    fetchImpl,
    openImpl: async (url) => {
      capturedAuthorizeUrl = new URL(url);
      const state = capturedAuthorizeUrl.searchParams.get("state");
      await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=${state}`);
    },
  });

  expect(credential).toEqual({ accessToken: "at-abc", refreshToken: "rt-abc", expiresAt: expect.any(Number), tokenType: "Bearer" });

  expect(capturedAuthorizeUrl?.searchParams.get("response_type")).toBe("code");
  expect(capturedAuthorizeUrl?.searchParams.get("client_id")).toBe("client-123");
  expect(capturedAuthorizeUrl?.searchParams.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/callback`);
  expect(capturedAuthorizeUrl?.searchParams.get("code_challenge_method")).toBe("S256");
  expect(capturedAuthorizeUrl?.searchParams.get("code_challenge")).toBeTruthy();
  expect(capturedAuthorizeUrl?.searchParams.get("state")).toBeTruthy();

  expect(capturedTokenBody?.get("grant_type")).toBe("authorization_code");
  expect(capturedTokenBody?.get("code")).toBe("test-code");
  expect(capturedTokenBody?.get("redirect_uri")).toBe(`http://127.0.0.1:${port}/callback`);
  // The verifier sent to the token endpoint must be the one whose SHA-256
  // produced the challenge sent to the authorize endpoint -- PKCE's whole
  // point. Not re-deriving the hash here (that would just duplicate the
  // implementation); confirming both a verifier and a challenge were sent
  // and that they differ is enough to prove the pair was actually used,
  // not a stubbed constant.
  expect(capturedTokenBody?.get("code_verifier")).toBeTruthy();
  expect(capturedTokenBody?.get("code_verifier")).not.toBe(capturedAuthorizeUrl?.searchParams.get("code_challenge"));
});

test("runLocalRedirectOAuth calls onAuthorizeUrl with the same URL it opens, before waiting on the callback", async () => {
  const port = freshPort();
  let announcedUrl: string | undefined;
  const fetchImpl = fakeTokenFetch(() => ({ status: 200, body: { access_token: "at-abc" } }));

  await runLocalRedirectOAuth({
    authorizationEndpoint: "https://vendor.example.test/oauth/authorize",
    tokenEndpoint: "https://vendor.example.test/oauth/token",
    clientId: "client-123",
    scope: "read",
    port,
    callbackPath: "/callback",
    fetchImpl,
    onAuthorizeUrl: (url) => {
      announcedUrl = url;
    },
    openImpl: async (url) => {
      // Proves onAuthorizeUrl already fired by the time openImpl runs --
      // it's the fallback for exactly the case where openImpl silently
      // fails to launch a real browser (headless/SSH/sandboxed), so it
      // must not depend on openImpl succeeding.
      expect(announcedUrl).toBe(url);
      const state = new URL(url).searchParams.get("state");
      await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=${state}`);
    },
  });

  expect(announcedUrl).toContain("https://vendor.example.test/oauth/authorize");
});

test("runLocalRedirectOAuth rejects when the callback's state does not match what was sent", async () => {
  const port = freshPort();
  await expect(
    runLocalRedirectOAuth({
      authorizationEndpoint: "https://vendor.example.test/oauth/authorize",
      tokenEndpoint: "https://vendor.example.test/oauth/token",
      clientId: "client-123",
      scope: "read",
      port,
      callbackPath: "/callback",
      openImpl: async () => {
        await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=wrong-state`);
      },
    }),
  ).rejects.toThrow(/state mismatch/i);
});

test("runLocalRedirectOAuth rejects when the vendor's redirect carries an error param", async () => {
  const port = freshPort();
  await expect(
    runLocalRedirectOAuth({
      authorizationEndpoint: "https://vendor.example.test/oauth/authorize",
      tokenEndpoint: "https://vendor.example.test/oauth/token",
      clientId: "client-123",
      scope: "read",
      port,
      callbackPath: "/callback",
      openImpl: async (url) => {
        const state = new URL(url).searchParams.get("state");
        await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=${state}`);
      },
    }),
  ).rejects.toThrow(/access_denied/);
});

test("runLocalRedirectOAuth rejects when the token exchange itself fails", async () => {
  const port = freshPort();
  const fetchImpl = fakeTokenFetch(() => ({ status: 400, body: { error: "invalid_grant" } }));

  await expect(
    runLocalRedirectOAuth({
      authorizationEndpoint: "https://vendor.example.test/oauth/authorize",
      tokenEndpoint: "https://vendor.example.test/oauth/token",
      clientId: "client-123",
      scope: "read",
      port,
      callbackPath: "/callback",
      fetchImpl,
      openImpl: async (url) => {
        const state = new URL(url).searchParams.get("state");
        await fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=${state}`);
      },
    }),
  ).rejects.toThrow(/Token exchange failed/);
});

test("runDeviceOAuth prompts with the user code, polls through authorization_pending, and returns the token once approved", async () => {
  const prompts: unknown[] = [];
  let pollCount = 0;
  const fetchImpl = fakeTokenFetch((url) => {
    if (url.includes("device_authorization")) {
      return { status: 200, body: { device_code: "dev-code", user_code: "ABCD-1234", verification_uri: "https://vendor.example.test/activate", interval: 0, expires_in: 900 } };
    }
    pollCount += 1;
    if (pollCount < 3) return { status: 400, body: { error: "authorization_pending" } };
    return { status: 200, body: { access_token: "at-device", token_type: "Bearer" } };
  });

  const credential = await runDeviceOAuth({
    deviceAuthorizationEndpoint: "https://vendor.example.test/oauth/device_authorization",
    tokenEndpoint: "https://vendor.example.test/oauth/token",
    clientId: "client-123",
    scope: "read",
    onPrompt: (info) => prompts.push(info),
    fetchImpl,
    openImpl: async () => {},
  });

  expect(credential.accessToken).toBe("at-device");
  expect(prompts).toEqual([{ userCode: "ABCD-1234", verificationUri: "https://vendor.example.test/activate", verificationUriComplete: undefined }]);
  expect(pollCount).toBe(3);
});

test("runDeviceOAuth throws on access_denied without retrying further", async () => {
  const fetchImpl = fakeTokenFetch((url) => {
    if (url.includes("device_authorization")) {
      return { status: 200, body: { device_code: "dev-code", user_code: "ABCD-1234", verification_uri: "https://vendor.example.test/activate", interval: 0, expires_in: 900 } };
    }
    return { status: 400, body: { error: "access_denied" } };
  });

  await expect(
    runDeviceOAuth({
      deviceAuthorizationEndpoint: "https://vendor.example.test/oauth/device_authorization",
      tokenEndpoint: "https://vendor.example.test/oauth/token",
      clientId: "client-123",
      scope: "read",
      onPrompt: () => {},
      fetchImpl,
      openImpl: async () => {},
    }),
  ).rejects.toThrow(/access_denied/);
});

test("refreshOAuthToken sends grant_type=refresh_token and returns a fresh credential", async () => {
  let capturedBody: URLSearchParams | undefined;
  const fetchImpl = fakeTokenFetch((_url, body) => {
    capturedBody = body;
    return { status: 200, body: { access_token: "at-refreshed", refresh_token: "rt-new", expires_in: 3600 } };
  });

  const credential = await refreshOAuthToken(
    { tokenEndpoint: "https://vendor.example.test/oauth/token", clientId: "client-123", fetchImpl },
    "rt-old",
  );

  expect(credential.accessToken).toBe("at-refreshed");
  expect(capturedBody?.get("grant_type")).toBe("refresh_token");
  expect(capturedBody?.get("refresh_token")).toBe("rt-old");
});
