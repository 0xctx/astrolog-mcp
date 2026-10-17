import { describe, expect, it, vi } from "vitest";
import { cutList } from "./output.js";

describe("cutList", () => {
  it("lists the first limit items, shaped, with the total and the cut", () => {
    const shape = vi.fn((n: number) => `item ${n}`);
    expect(cutList([1, 2, 3, 4], 2, shape)).toEqual({ items: ["item 1", "item 2"], total: 4, truncated: true });
  });

  it("never shapes an item past the limit", () => {
    const shape = vi.fn((n: number) => n);
    cutList([1, 2, 3, 4], 2, shape);
    expect(shape).toHaveBeenCalledTimes(2);
  });

  it("lists every item when the limit is 0, and is not truncated", () => {
    expect(cutList([1, 2, 3], 0, (n) => n * 10)).toEqual({ items: [10, 20, 30], total: 3, truncated: false });
  });

  it("is not truncated when the list is exactly the limit", () => {
    expect(cutList([1, 2], 2, (n) => n)).toEqual({ items: [1, 2], total: 2, truncated: false });
  });

  it("gives an empty list with a total of 0 for no items", () => {
    expect(cutList([], 5, (n: number) => n)).toEqual({ items: [], total: 0, truncated: false });
  });
});
