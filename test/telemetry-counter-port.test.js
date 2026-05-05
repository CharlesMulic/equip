"use strict";

// Tests for Counter port + noop default + name/label constants.
//
// Boundary discipline check: equip lib owns the contract (counter names +
// valid label keys + valid label values). Storage and emission live
// elsewhere. These tests assert only the contract.

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  noopCounter,
  COUNTER_NAMES,
  COUNTER_LABELS,
} = require("../dist/lib/telemetry");

describe("Counter port contract", () => {
  it("noopCounter accepts (name) and (name, labels) without throwing", () => {
    assert.doesNotThrow(() => noopCounter("any_name"));
    assert.doesNotThrow(() => noopCounter("any_name", { result: "success" }));
    assert.doesNotThrow(() => noopCounter("equip_broker_refresh_total", {}));
  });

  it("noopCounter returns undefined (fire-and-forget)", () => {
    const ret = noopCounter("equip_broker_refresh_total", { result: "success" });
    assert.equal(ret, undefined);
  });
});

describe("Counter name constants", () => {
  it("declares the broker/install counters wired across equip and equip-app", () => {
    assert.equal(COUNTER_NAMES.BROKER_REFRESH_TOTAL, "equip_broker_refresh_total");
    assert.equal(COUNTER_NAMES.BROKER_REQUEST_TOTAL, "equip_broker_request_total");
    assert.equal(COUNTER_NAMES.BROKER_PROXY_TOTAL, "equip_broker_proxy_total");
    assert.equal(COUNTER_NAMES.BROKER_PROXY_FAILURE_TOTAL, "equip_broker_proxy_failure_total");
    assert.equal(COUNTER_NAMES.BROKER_PROXY_LATENCY_BUCKET_TOTAL, "equip_broker_proxy_latency_bucket_total");
    assert.equal(COUNTER_NAMES.BROKER_PREWARM_TOTAL, "equip_broker_prewarm_total");
    assert.equal(COUNTER_NAMES.INSTALL_MODE_TOTAL, "equip_install_mode_total");
  });

  it("counter names follow Prometheus naming convention (snake_case + _total suffix on counters)", () => {
    for (const name of Object.values(COUNTER_NAMES)) {
      assert.match(name, /^[a-z][a-z0-9_]*$/, `${name} must be snake_case`);
      assert.ok(name.endsWith("_total"), `${name} is a counter and must end with _total`);
    }
  });
});

describe("Closed-set label values", () => {
  it("BROKER_REFRESH_TOTAL has result label with closed enum", () => {
    const labels = COUNTER_LABELS[COUNTER_NAMES.BROKER_REFRESH_TOTAL];
    assert.deepEqual(labels.result, ["success", "failed", "invalid_grant"]);
  });

  it("BROKER_REQUEST_TOTAL has path label matching IPC method names", () => {
    const labels = COUNTER_LABELS[COUNTER_NAMES.BROKER_REQUEST_TOTAL];
    // These four are the closed-set discriminated union of IPC methods.
    // If a method is added to ipc-protocol.ts, this test trips and the
    // contract owner has to choose: extend the label enum, or exclude
    // the new method from request_total.
    assert.deepEqual(labels.path, [
      "getStatus",
      "getCredential",
      "triggerRefresh",
      "listManagedAugments",
    ]);
  });

  it("INSTALL_MODE_TOTAL has mode label with closed enum and no platform enum", () => {
    const labels = COUNTER_LABELS[COUNTER_NAMES.INSTALL_MODE_TOTAL];
    assert.deepEqual(labels.mode, ["direct", "broker"]);
    assert.equal(labels.platform, undefined);
  });

  it("BROKER_PROXY_FAILURE_TOTAL has reason label with closed enum", () => {
    const labels = COUNTER_LABELS[COUNTER_NAMES.BROKER_PROXY_FAILURE_TOTAL];
    assert.ok(labels.reason.includes("http_upstream_url_disallowed"));
    assert.ok(labels.reason.includes("bridge_disconnected"));
    assert.ok(labels.reason.includes("unknown"));
  });

  it("BROKER_PROXY_LATENCY_BUCKET_TOTAL has result and bucket labels", () => {
    const labels = COUNTER_LABELS[COUNTER_NAMES.BROKER_PROXY_LATENCY_BUCKET_TOTAL];
    assert.deepEqual(labels.result, ["success", "failed"]);
    assert.deepEqual(labels.bucket, ["le_100_ms", "le_500_ms", "le_1000_ms", "le_5000_ms", "gt_5000_ms"]);
  });

  it("BROKER_PREWARM_TOTAL has kind and result labels", () => {
    const labels = COUNTER_LABELS[COUNTER_NAMES.BROKER_PREWARM_TOTAL];
    assert.deepEqual(labels.kind, ["token_refresh", "dns"]);
    assert.deepEqual(labels.result, ["success", "failed", "skipped"]);
  });
});
