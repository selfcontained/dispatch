import { describe, expect, it } from "vitest";

import {
  parseTailscaleStatus,
  parseTailscaleWhois,
  pickTailnetIPv4,
} from "../src/peers/tailscale.js";

describe("parseTailscaleStatus", () => {
  const running = {
    BackendState: "Running",
    Self: {
      ID: "n7q7tzN4dQ11CNTRL",
      DNSName: "laptop.tailnet.ts.net.",
      TailscaleIPs: ["100.64.1.2", "fd7a:115c:a1e0::1"],
      Online: true,
    },
  };

  it("extracts the durable identity and strips the trailing DNS dot", () => {
    const self = parseTailscaleStatus(JSON.stringify(running));
    expect(self).toEqual({
      stableId: "n7q7tzN4dQ11CNTRL",
      dnsName: "laptop.tailnet.ts.net",
      ips: ["100.64.1.2", "fd7a:115c:a1e0::1"],
      online: true,
    });
  });

  it("returns null when the backend is not running", () => {
    expect(
      parseTailscaleStatus(
        JSON.stringify({ ...running, BackendState: "NeedsLogin" })
      )
    ).toBeNull();
  });

  it("returns null when Self.ID is missing", () => {
    expect(
      parseTailscaleStatus(
        JSON.stringify({ BackendState: "Running", Self: { DNSName: "x." } })
      )
    ).toBeNull();
  });

  it("returns null on garbage output", () => {
    expect(parseTailscaleStatus("not json")).toBeNull();
    expect(parseTailscaleStatus("null")).toBeNull();
  });

  it("tolerates missing optional fields", () => {
    const self = parseTailscaleStatus(
      JSON.stringify({ BackendState: "Running", Self: { ID: "nABC" } })
    );
    expect(self).toEqual({
      stableId: "nABC",
      dnsName: "",
      ips: [],
      online: false,
    });
  });
});

describe("parseTailscaleWhois", () => {
  it("extracts node identity, tags, sharer, and login name", () => {
    const whois = parseTailscaleWhois(
      JSON.stringify({
        Node: {
          StableID: "nXYZCNTRL",
          Name: "cloud-vm.tailnet.ts.net.",
          Tags: ["tag:ci"],
          Sharer: "userid:123",
        },
        UserProfile: { LoginName: "luke@example.com" },
      })
    );
    expect(whois).toEqual({
      stableId: "nXYZCNTRL",
      nodeName: "cloud-vm.tailnet.ts.net",
      tags: ["tag:ci"],
      sharer: "userid:123",
      loginName: "luke@example.com",
    });
  });

  it("returns null when Node.StableID is absent — hard deny, no fallback", () => {
    expect(
      parseTailscaleWhois(
        JSON.stringify({ Node: { Name: "x." }, UserProfile: {} })
      )
    ).toBeNull();
    expect(parseTailscaleWhois("{}")).toBeNull();
    expect(parseTailscaleWhois("not json")).toBeNull();
  });

  it("normalizes an empty sharer to null", () => {
    const whois = parseTailscaleWhois(
      JSON.stringify({ Node: { StableID: "nA", Sharer: "" } })
    );
    expect(whois?.sharer).toBeNull();
  });
});

describe("pickTailnetIPv4", () => {
  it("prefers the 100.x IPv4 address", () => {
    expect(pickTailnetIPv4(["fd7a:115c::1", "100.64.9.9"])).toBe("100.64.9.9");
  });

  it("returns null when only IPv6 is present", () => {
    expect(pickTailnetIPv4(["fd7a:115c::1"])).toBeNull();
    expect(pickTailnetIPv4([])).toBeNull();
  });
});
