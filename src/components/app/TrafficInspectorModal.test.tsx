import { describe, it, expect } from "vitest";
import { toCurl, textToHeaders } from "./TrafficInspectorModal";
import type { AccessLogEntry } from "../../lib/commands";

function entry(over: Partial<AccessLogEntry> = {}): AccessLogEntry {
  return {
    ts: 1_700_000_000,
    method: "POST",
    host: "api.demo.test",
    uri: "/webhooks/stripe?retry=1",
    status: 200,
    duration_ms: 12,
    remote_ip: "1.2.3.4",
    req_headers: {},
    resp_headers: {},
    req_body: null,
    resp_size_bytes: 0,
    ...over,
  };
}

describe("textToHeaders", () => {
  it("splits on the first colon so URLs in values survive", () => {
    expect(textToHeaders("Referer: https://demo.test/a:b")).toEqual({
      Referer: ["https://demo.test/a:b"],
    });
  });

  it("keeps repeated headers as separate values", () => {
    expect(textToHeaders("Set-Cookie: a=1\nSet-Cookie: b=2")).toEqual({
      "Set-Cookie": ["a=1", "b=2"],
    });
  });

  it("ignores blank and colon-less lines rather than sending junk", () => {
    expect(textToHeaders("\n  \nAccept: */*\ngarbage\n: novalue")).toEqual({
      Accept: ["*/*"],
    });
  });
});

describe("toCurl", () => {
  it("drops the headers curl computes for itself", () => {
    const cmd = toCurl(
      entry({
        req_headers: {
          Host: ["api.demo.test"],
          "Content-Length": ["42"],
          Authorization: ["Bearer sk_test_123"],
        },
      })
    );
    expect(cmd).not.toContain("Host:");
    expect(cmd).not.toContain("Content-Length:");
    expect(cmd).toContain("-H 'Authorization: Bearer sk_test_123'");
  });

  it("targets the captured host over https", () => {
    expect(toCurl(entry())).toContain("'https://api.demo.test/webhooks/stripe?retry=1'");
  });

  it("escapes single quotes so a JSON body stays one shell argument", () => {
    const cmd = toCurl(entry({ req_body: `{"note":"it's fine"}` }));
    expect(cmd).toContain(`--data-raw '{"note":"it'\\''s fine"}'`);
  });

  it("omits the body flag when nothing was captured", () => {
    expect(toCurl(entry({ req_body: null }))).not.toContain("--data-raw");
  });

  it("falls back to / for an empty URI", () => {
    expect(toCurl(entry({ uri: "" }))).toContain("'https://api.demo.test/'");
  });
});
