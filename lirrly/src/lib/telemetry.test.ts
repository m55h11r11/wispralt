import { describe, expect, it } from "vitest";
import { sanitizeReport } from "./telemetry";

/* The privacy policy states that diagnostics never carry transcripts,
   clipboard text or API keys. Provider errors arrive as raw HTTP bodies, so
   without this boundary that statement is an assumption rather than a fact. */
describe("sanitizeReport", () => {
  it("keeps the provider's error code and drops the response body", () => {
    const body = JSON.stringify({
      error: { code: "model_decommissioned", message: "the model was removed" },
    });
    expect(sanitizeReport(`Groq API 400 Bad Request: ${body}`)).toBe(
      "Groq API 400 (model_decommissioned)"
    );
  });

  it("drops a provider body that echoes what the user dictated", () => {
    const echoed = JSON.stringify({
      error: { type: "invalid_request_error", message: "input: my bank pin is 4417" },
    });
    const out = sanitizeReport(`Groq API 400 Bad Request: ${echoed}`);
    expect(out).not.toContain("4417");
    expect(out).toContain("invalid_request_error");
  });

  it("keeps the status when the body is not JSON, without the body itself", () => {
    const out = sanitizeReport("Groq API 502 Bad Gateway: <html>cloudflare ray 9f2</html>");
    expect(out).toBe("Groq API 502");
  });

  it("redacts an API key that leaked into any error text", () => {
    const out = sanitizeReport("request failed with gsk_AbCdEf0123456789 in header");
    expect(out).not.toContain("gsk_AbCdEf0123456789");
    expect(out).toContain("[key]");
  });

  it("redacts a bearer credential", () => {
    expect(sanitizeReport("Authorization: Bearer abcdef0123456789")).toContain("Bearer [key]");
  });

  it("redacts an email address a user may have dictated", () => {
    const out = sanitizeReport("could not parse person@example.com");
    expect(out).not.toContain("person@example.com");
    expect(out).toContain("[email]");
  });

  it("truncates so a long message cannot smuggle content through", () => {
    expect(sanitizeReport("x".repeat(5000)).length).toBe(300);
  });

  it("passes an ordinary local error through unchanged", () => {
    expect(sanitizeReport("TypeError: undefined is not a function")).toBe(
      "TypeError: undefined is not a function"
    );
  });
});
