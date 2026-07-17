// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";

import {
  ascend,
  canAscend,
  canDescend,
  createRefineState,
  descend,
} from "./refine";

describe("refine", () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main id="main">
        <section id="section">
          <article id="article">
            <button id="button">Go</button>
          </article>
        </section>
      </main>
    `;
  });

  function el(id: string): Element {
    const found = document.getElementById(id);
    if (!found) throw new Error(`missing #${id}`);
    return found;
  }

  it("ascends to the parent and remembers the trail", () => {
    let state = createRefineState(el("button"));
    state = ascend(state);
    expect(state.current).toBe(el("article"));
    state = ascend(state);
    expect(state.current).toBe(el("section"));
    expect(state.descendTrail).toEqual([el("button"), el("article")]);
  });

  it("descends back along the exact trail the user came up", () => {
    let state = createRefineState(el("button"));
    state = ascend(state);
    state = ascend(state);
    state = descend(state);
    expect(state.current).toBe(el("article"));
    state = descend(state);
    expect(state.current).toBe(el("button"));
    expect(state.descendTrail).toEqual([]);
  });

  it("falls back to the first element child without a trail", () => {
    let state = createRefineState(el("main"));
    expect(canDescend(state)).toBe(true);
    state = descend(state);
    expect(state.current).toBe(el("section"));
  });

  it("stops ascending at body", () => {
    let state = createRefineState(el("main"));
    expect(canAscend(state)).toBe(true);
    state = ascend(state);
    expect(state.current).toBe(document.body);
    expect(canAscend(state)).toBe(false);
    expect(ascend(state)).toBe(state);
  });

  it("cannot descend into a leaf", () => {
    const state = createRefineState(el("button"));
    expect(canDescend(state)).toBe(false);
    expect(descend(state)).toBe(state);
  });

  it("a new tap resets the trail", () => {
    let state = createRefineState(el("button"));
    state = ascend(state);
    state = createRefineState(el("section"));
    expect(state.descendTrail).toEqual([]);
  });

  it("skips the overlay host when descending", () => {
    const hostParent = document.createElement("div");
    const host = document.createElement("div");
    host.setAttribute("data-dispatch-feedback-host", "");
    hostParent.append(host);
    document.body.append(hostParent);

    const state = createRefineState(hostParent);
    expect(canDescend(state)).toBe(false);
    expect(descend(state)).toBe(state);
  });
});
