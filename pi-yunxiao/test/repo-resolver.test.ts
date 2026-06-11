import { describe, it, expect } from "bun:test";
import { RepoResolver } from "../src/services/repo-resolver.js";

describe("RepoResolver", () => {
  describe("extractWorkItemId", () => {
    const r = new RepoResolver();
    it("extracts from fix/WBGA-4215", () => {
      expect(r.extractWorkItemId("fix/WBGA-4215")).toBe("WBGA-4215");
    });

    it("extracts from feat/WBGA-1234", () => {
      expect(r.extractWorkItemId("feat/WBGA-1234-add-login")).toBe("WBGA-1234");
    });

    it("extracts from chore/MUKJ-63", () => {
      expect(r.extractWorkItemId("chore/MUKJ-63")).toBe("MUKJ-63");
    });

    it("returns null for non-matching branch", () => {
      expect(r.extractWorkItemId("master")).toBeNull();
      expect(r.extractWorkItemId("sprint/20260611")).toBeNull();
      expect(r.extractWorkItemId("feature/no-id")).toBeNull();
    });

    it("is case-sensitive on prefix", () => {
      expect(r.extractWorkItemId("FIX/WBGA-4215")).toBeNull();
    });
  });

  describe("parseRemoteUrl", () => {
    const r = new RepoResolver();
    it("parses SSH url with org and nested path", () => {
      const result = r.parseRemoteUrl("git@codeup.aliyun.com:63e991ce3f24888125dabd43/pos/qipda.git");
      expect(result).toEqual({
        orgId: "63e991ce3f24888125dabd43",
        repositoryId: "63e991ce3f24888125dabd43%2Fpos%2Fqipda",
        repoName: "qipda",
      });
    });

    it("parses SSH url with single-level path", () => {
      const result = r.parseRemoteUrl("git@codeup.aliyun.com:abc123/myrepo.git");
      expect(result).toEqual({
        orgId: "abc123",
        repositoryId: "abc123%2Fmyrepo",
        repoName: "myrepo",
      });
    });

    it("parses HTTPS url", () => {
      const result = r.parseRemoteUrl("https://codeup.aliyun.com/abc123/myrepo.git");
      expect(result).toEqual({
        orgId: "abc123",
        repositoryId: "abc123%2Fmyrepo",
        repoName: "myrepo",
      });
    });

    it("handles url without .git suffix", () => {
      const result = r.parseRemoteUrl("git@codeup.aliyun.com:abc123/myrepo");
      expect(result?.repoName).toBe("myrepo");
    });

    it("returns null for non-codeup url", () => {
      expect(r.parseRemoteUrl("git@github.com:foo/bar.git")).toBeNull();
      expect(r.parseRemoteUrl("https://gitlab.com/foo/bar.git")).toBeNull();
    });

    it("returns null for malformed url", () => {
      expect(r.parseRemoteUrl("not a url")).toBeNull();
    });
  });
});
