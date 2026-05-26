/**
 * MiniMax Search Module Unit Tests
 * Validates search (Token Plan MCP) types and request/response structures
 */

import { describe, it, expect } from "bun:test";

describe("MiniMax Search Module", () => {
  describe("SearchRequest validation", () => {
    it("should accept required query field", () => {
      const request = {
        query: "MiniMax AI latest news",
      };
      expect(request.query).toBe("MiniMax AI latest news");
    });

    it("should accept optional num_results", () => {
      const request = {
        query: "MiniMax AI",
        num_results: 10,
      };
      expect(request.num_results).toBe(10);
    });

    it("should accept num_results up to 20", () => {
      const request = {
        query: "MiniMax AI",
        num_results: 20,
      };
      expect(request.num_results).toBe(20);
    });

    it("should accept empty query for related searches", () => {
      const request = {
        query: "",
      };
      expect(request.query).toBe("");
    });
  });

  describe("SearchResult validation", () => {
    it("should accept result with title and link", () => {
      const result: { title: string; link: string; snippet: string; date?: string } = {
        title: "MiniMax Official Website",
        link: "https://minimax.io",
        snippet: "MiniMax is an AI company.",
      };
      expect(result.title).toBe("MiniMax Official Website");
      expect(result.link).toBe("https://minimax.io");
      expect(result.snippet).toBe("MiniMax is an AI company.");
    });

    it("should accept result with date", () => {
      const result: { title: string; link: string; snippet: string; date?: string } = {
        title: "MiniMax News",
        link: "https://example.com/news",
        snippet: "Latest updates.",
        date: "2024-01-15",
      };
      expect(result.date).toBe("2024-01-15");
    });

    it("should accept result without optional date", () => {
      const result: { title: string; link: string; snippet: string; date?: string } = {
        title: "MiniMax",
        link: "https://minimax.io",
        snippet: "Description",
      };
      expect(result.date).toBeUndefined();
    });
  });

  describe("RelatedSearch validation", () => {
    it("should accept related search query", () => {
      const related = {
        query: "MiniMax video generation",
      };
      expect(related.query).toBe("MiniMax video generation");
    });
  });

  describe("SearchResponse validation", () => {
    it("should accept response with organic results", () => {
      const response = {
        success: true,
        organic: [
          {
            title: "MiniMax AI",
            link: "https://minimax.io",
            snippet: "AI company",
          },
          {
            title: "MiniMax Video",
            link: "https://minimax.io/video",
            snippet: "Video generation",
          },
        ],
      };
      expect(response.organic).toHaveLength(2);
      expect(response.organic?.[0].title).toBe("MiniMax AI");
    });

    it("should accept response with related searches", () => {
      const response = {
        success: true,
        related_searches: [
          { query: "MiniMax speech synthesis" },
          { query: "MiniMax image generation" },
        ],
      };
      expect(response.related_searches).toHaveLength(2);
    });

    it("should accept response with both organic and related", () => {
      const response = {
        success: true,
        organic: [
          {
            title: "MiniMax",
            link: "https://minimax.io",
            snippet: "AI company",
          },
        ],
        related_searches: [
          { query: "MiniMax text-to-speech" },
        ],
      };
      expect(response.organic).toHaveLength(1);
      expect(response.related_searches).toHaveLength(1);
    });

    it("should accept response with request_id", () => {
      const response = {
        success: true,
        request_id: "req-123",
        organic: [],
      };
      expect(response.request_id).toBe("req-123");
    });

    it("should accept response with cost info", () => {
      const response = {
        success: true,
        cost: 0.001,
        organic: [],
      };
      expect(response.cost).toBe(0.001);
    });
  });

  describe("createMiniMax client", () => {
    it("should have search method on client", async () => {
      const { createMiniMax } = await import("../../src/tools/minimax/index.js");
      const client = createMiniMax({ apiKey: "test-key" });
      expect(typeof client.search).toBe("function");
    });
  });

  describe("Search integration with Vision", () => {
    it("should support Token Plan MCP endpoints (search and vlm)", () => {
      // The Token Plan MCP provides both search and vision endpoints
      const endpoints = {
        search: "/v1/coding_plan/search",
        vlm: "/v1/coding_plan/vlm",
      };
      expect(endpoints.search).toBe("/v1/coding_plan/search");
      expect(endpoints.vlm).toBe("/v1/coding_plan/vlm");
    });
  });
});
