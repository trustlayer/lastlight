import { afterEach, describe, it, expect } from "vitest";
import { installProviderOverrides, resetProviderRegistry } from "#src/config/provider-registry.js";
import {
  ALLOW_ALL_SENTINEL,
  defaultAllowlist,
  GITHUB_HOSTS,
  PACKAGE_REGISTRY_HOSTS,
  providerHosts,
  mergeAllowlist,
  normalizeAllowlistHost,
} from "#src/sandbox/egress-allowlist.js";

describe("egress-allowlist source of truth", () => {
  it("groups are non-empty and disjoint", () => {
    for (const group of [GITHUB_HOSTS, providerHosts(), PACKAGE_REGISTRY_HOSTS]) {
      expect(group.length).toBeGreaterThan(0);
    }
    const all = [...GITHUB_HOSTS, ...providerHosts(), ...PACKAGE_REGISTRY_HOSTS];
    expect(new Set(all).size).toBe(all.length);
  });

  it("defaultAllowlist() is the union of the three groups in declaration order", () => {
    const expected = [...GITHUB_HOSTS, ...providerHosts(), ...PACKAGE_REGISTRY_HOSTS];
    expect([...defaultAllowlist()]).toEqual(expected);
  });

  it("covers the critical host categories the runtime depends on", () => {
    // GitHub apex covers api.github.com, codeload.github.com, raw.…
    expect(GITHUB_HOSTS).toContain("github.com");
    // Provider hosts — the docker backend dials these from inside the
    // sandbox container.
    expect(providerHosts()).toContain("openai.com");
    expect(providerHosts()).toContain("anthropic.com");
    // OAuth (subscription-login) providers contribute their own hosts: the
    // Codex model call goes to chatgpt.com, Copilot's to api.githubcopilot.com.
    expect(providerHosts()).toContain("chatgpt.com");
    expect(providerHosts()).toContain("githubcopilot.com");
    // OAuth token refresh hosts, declared by the OAuth providers themselves.
    expect(providerHosts()).toContain("auth.openai.com");
    expect(providerHosts()).toContain("platform.claude.com");
    // npm — covers registry.npmjs.org, auth.npmjs.org, www.npmjs.org.
    expect(PACKAGE_REGISTRY_HOSTS).toContain("npmjs.org");
  });

  it("entries are bare hostnames (no leading dot, no wildcard prefix)", () => {
    // Convention is "every entry matches apex+subdomains" — see file
    // docstring. The config generator emits the right syntax for each
    // backend. If someone tries to write `.github.com` or `*.github.com`
    // here, fail fast.
    for (const host of defaultAllowlist()) {
      expect(host).toMatch(/^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$/);
      expect(host.startsWith(".")).toBe(false);
      expect(host.includes("*")).toBe(false);
    }
  });

  it("ALLOW_ALL_SENTINEL is the wildcard string the gondolin matcher honours", () => {
    expect(ALLOW_ALL_SENTINEL).toBe("*");
  });

  it("normalizes and merges extra allowlist hosts", () => {
    expect(normalizeAllowlistHost("https://Collector.Example.com:4318/v1/traces")).toBe("collector.example.com");
    expect(normalizeAllowlistHost("169.254.169.254")).toBeNull();
    expect(mergeAllowlist(["github.com"], ["GitHub.com", "otel.example.com"])).toEqual([
      "github.com",
      "otel.example.com",
    ]);
  });

  it("rejects private and internal collector endpoints", () => {
    for (const host of [
      "0.0.0.0",
      "127.0.0.1",
      "10.0.0.4",
      "172.16.0.1",
      "192.168.1.10",
      "http://[::1]:4318",
      "http://[fe80::1]:4318",
      "http://[fd00::1]:4318",
      "http://[::ffff:127.0.0.1]:4318",
      "metadata.google.internal",
      "localhost",
    ]) {
      expect(normalizeAllowlistHost(host), host).toBeNull();
    }
  });
});

// A `providers:` override replaces the host of the API-key entry with the
// hostname of its `baseUrl` (issue #373). The OAuth refresh hosts must not
// depend on that entry, or an override removes them from the allowlist.
describe("egress-allowlist with a providers: override", () => {
  afterEach(() => resetProviderRegistry());

  it("keeps the Codex token refresh host when providers.openai.baseUrl moves the openai host", () => {
    // The standard OpenAI URL is sufficient: the override narrows openai.com to
    // api.openai.com, which does not match auth.openai.com.
    installProviderOverrides({ openai: { baseUrl: "https://api.openai.com/v1" } });
    const hosts = providerHosts();
    expect(hosts).not.toContain("openai.com");
    expect(hosts).toContain("api.openai.com");
    expect(hosts).toContain("chatgpt.com");
    expect(hosts).toContain("auth.openai.com");
  });

  it("keeps the Anthropic token refresh host when providers.anthropic.baseUrl points to a gateway", () => {
    installProviderOverrides({ anthropic: { baseUrl: "https://llm-gateway.example.com/anthropic" } });
    const hosts = providerHosts();
    expect(hosts).not.toContain("anthropic.com");
    expect(hosts).toContain("llm-gateway.example.com");
    expect(hosts).toContain("platform.claude.com");
  });

  it("puts the OAuth refresh hosts in the generated allowlist", () => {
    installProviderOverrides({ openai: { baseUrl: "https://api.openai.com/v1" } });
    const allowlist = mergeAllowlist(defaultAllowlist());
    expect(allowlist).toContain("auth.openai.com");
    expect(allowlist).toContain("platform.claude.com");
  });
});
