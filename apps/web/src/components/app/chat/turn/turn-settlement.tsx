import { Component, createRef, type ReactNode } from "react";

type Props = { settled: boolean; children: ReactNode };

/** Hold the outgoing activity row's space as its shorter final answer fades in. */
export class TurnSettlement extends Component<Props> {
  private row = createRef<HTMLDivElement>();

  private content = createRef<HTMLDivElement>();

  getSnapshotBeforeUpdate(previous: Props): number | null {
    const row = this.row.current;
    if (
      previous.settled ||
      !this.props.settled ||
      !row?.animate ||
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    )
      return null;
    // WebKit can clamp scrollTop during the first layout of the shorter
    // answer. Reserve the old height before React replaces the activity.
    const height = row.getBoundingClientRect().height;
    row.style.minHeight = height + "px";
    return height;
  }

  componentDidUpdate(_previous: Props, _state: unknown, before: number | null) {
    const row = this.row.current;
    if (before === null || !row) return;
    const after =
      this.content.current?.getBoundingClientRect().height ?? before;
    if (before - after > 1) {
      row.animate([{ minHeight: before + "px" }, { minHeight: after + "px" }], {
        duration: 420,
        easing: "ease-in-out",
      });
    }
    row.style.minHeight = "";
  }

  render() {
    return (
      <div ref={this.row}>
        <div ref={this.content} className="flow-root">
          {this.props.children}
        </div>
      </div>
    );
  }
}
