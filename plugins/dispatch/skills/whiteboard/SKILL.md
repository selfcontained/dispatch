---
name: whiteboard
description: Draw on or read the shared whiteboard the user sketches on. Use when the user mentions the whiteboard, board, or drawing, or when a diagram would explain something better than more prose.
---

# The shared whiteboard

Every Dispatch agent has a whiteboard: a live Excalidraw canvas the user can see
and draw on at the same time you can. Your edits appear immediately; so do
theirs.

Two directions of use, and both matter:

- **Reading** — the user sketched something and is referring to it. Anytime they
  say "the whiteboard", "the board", "the diagram", or "what I drew", call
  `whiteboard_get` before answering.
- **Drawing** — you have an architecture, a flow, or a set of relationships that
  a picture explains faster than text.

## Tools

```
whiteboard_get     — current elements plus snapshotPath, a PNG of the board
whiteboard_howto   — this reference, available at runtime
whiteboard_update  — add or replace elements (merged by id); deleteIds removes
whiteboard_clear   — wipe the board
```

`whiteboard_get` returns a simplified element list _and_ a `snapshotPath`. **Read
that PNG with a file/image tool** — freehand strokes are close to unreadable from
element JSON, and a user's rough sketch is usually freehand. If the response says
the snapshot is stale, trust the element list over the image until the board is
re-exported.

`whiteboard_update` merges by `id`: an element whose id already exists is replaced
entirely, anything else is added. That makes iteration cheap — resend one box to
move it, rather than rebuilding the board.

## Drawing workflow

**Workflow:** Call `whiteboard_get` first to see current elements, their ids, and where free space is. Then construct your elements and send them to `whiteboard_update`. Give elements readable ids (e.g. 'api-box', 'db-node') so you can reference them in arrow bindings.

**Labels:** To put text inside a shape, create BOTH a shape element (with a `boundElements` back-reference to the text) AND a text element (with `containerId` pointing to the shape).

**Arrows:** Use `startBinding`/`endBinding` with `elementId` and `fixedPoint` to connect arrows to shapes. Add back-references in each target shape's `boundElements` array. Set `elbowed: true` for right-angle routing.

**Layout:** Typical box w=160, h=70 with ~80px gaps. Keep labels short (2–5 words).

## Excalidraw Element Format Reference

Every element is a JSON object. Fields marked (required) must be present; all others have sensible defaults the editor will apply if omitted.

### Common fields (all element types)

| Field           | Type         | Required | Default       | Notes                                                                          |
| --------------- | ------------ | -------- | ------------- | ------------------------------------------------------------------------------ |
| id              | string       | YES      | —             | Unique id. Use readable slugs like "api-box", "db-node".                       |
| type            | string       | YES      | —             | One of: rectangle, ellipse, diamond, text, arrow, line, frame, freedraw, image |
| x               | number       | YES      | —             | Left edge, canvas pixels                                                       |
| y               | number       | YES      | —             | Top edge, canvas pixels                                                        |
| width           | number       | YES      | —             | Element width (use 0 for arrows/lines)                                         |
| height          | number       | YES      | —             | Element height (use 0 for arrows/lines)                                        |
| angle           | number       | no       | 0             | Rotation in radians                                                            |
| strokeColor     | string       | no       | "#1e1e1e"     | Stroke/outline color (hex)                                                     |
| backgroundColor | string       | no       | "transparent" | Fill color (hex or "transparent")                                              |
| fillStyle       | string       | no       | "solid"       | One of: solid, hachure, cross-hatch                                            |
| strokeWidth     | number       | no       | 2             | Stroke thickness in px                                                         |
| strokeStyle     | string       | no       | "solid"       | One of: solid, dashed, dotted                                                  |
| roughness       | number       | no       | 1             | 0=smooth, 1=normal, 2=rough (hand-drawn look)                                  |
| opacity         | number       | no       | 100           | 0–100                                                                          |
| groupIds        | string[]     | no       | []            | Group membership                                                               |
| frameId         | string\|null | no       | null          | Parent frame id                                                                |
| roundness       | object\|null | no       | null          | { type: 3 } for rounded corners on rectangles                                  |
| seed            | number       | no       | random        | Random seed for roughness rendering                                            |
| version         | number       | no       | 1             | Bump on each edit                                                              |
| versionNonce    | number       | no       | random        | Random nonce, changes with version                                             |
| isDeleted       | boolean      | no       | false         | Soft-delete flag                                                               |
| boundElements   | array\|null  | no       | null          | Back-references: [{ id, type }]                                                |
| updated         | number       | no       | Date.now()    | Timestamp ms                                                                   |
| link            | string\|null | no       | null          | URL link                                                                       |
| locked          | boolean      | no       | false         | Prevent editing                                                                |

### Shape elements: rectangle, ellipse, diamond

```json
{
  "id": "api-box",
  "type": "rectangle",
  "x": 100,
  "y": 100,
  "width": 160,
  "height": 70,
  "strokeColor": "#1e1e1e",
  "backgroundColor": "#a5d8ff",
  "fillStyle": "solid",
  "roundness": { "type": 3 }
}
```

Ellipse and diamond use the same fields, just change `type`.

### Text elements

```json
{
  "id": "title-text",
  "type": "text",
  "x": 100,
  "y": 50,
  "width": 200,
  "height": 25,
  "text": "API Server",
  "fontSize": 20,
  "fontFamily": 5,
  "textAlign": "center",
  "verticalAlign": "middle",
  "originalText": "API Server"
}
```

**Bound text (label inside a shape):** Create a text element with `containerId` pointing to the shape, and add a back-reference in the shape's `boundElements`:

```json
[
  {
    "id": "box1",
    "type": "rectangle",
    "x": 100,
    "y": 100,
    "width": 160,
    "height": 70,
    "boundElements": [{ "id": "box1-label", "type": "text" }]
  },
  {
    "id": "box1-label",
    "type": "text",
    "x": 110,
    "y": 120,
    "width": 140,
    "height": 25,
    "text": "API",
    "originalText": "API",
    "fontSize": 20,
    "fontFamily": 5,
    "textAlign": "center",
    "verticalAlign": "middle",
    "containerId": "box1"
  }
]
```

Text font families: 1=Virgil (handwritten), 3=Cascadia (monospace), 5=Excalifont (default).

### Arrow and line elements

```json
{
  "id": "flow-arrow",
  "type": "arrow",
  "x": 260,
  "y": 135,
  "width": 140,
  "height": 0,
  "points": [
    [0, 0],
    [140, 0]
  ],
  "startArrowhead": null,
  "endArrowhead": "arrow",
  "startBinding": {
    "elementId": "api-box",
    "focus": 0,
    "gap": 1,
    "fixedPoint": [1, 0.5]
  },
  "endBinding": {
    "elementId": "db-node",
    "focus": 0,
    "gap": 1,
    "fixedPoint": [0, 0.5]
  },
  "elbowed": false
}
```

**Points:** Array of [x, y] offsets relative to the element's x, y. First point is always [0, 0]. Add intermediate points for bends.

**Arrowheads:** `startArrowhead` and `endArrowhead` can be: null, "arrow", "bar", "dot", "triangle", "diamond".

**Bindings:** Connect arrows to shapes. `fixedPoint` is [proportionX, proportionY] on the target shape (0-1 range): [0.5, 0] = top center, [1, 0.5] = right center, [0.5, 1] = bottom center, [0, 0.5] = left center.

When binding an arrow, also add a back-reference in the target shape's `boundElements`:

```json
{ "id": "flow-arrow", "type": "arrow" }
```

**Elbow routing:** Set `elbowed: true` for right-angle connector routing (auto-computed path). The `points` array will be overridden by the editor.

**Lines** use the same format but `type: "line"` and no arrowheads.

### Frame elements

```json
{
  "id": "frame1",
  "type": "frame",
  "x": 50,
  "y": 50,
  "width": 400,
  "height": 300,
  "name": "Backend Services"
}
```

Children are assigned to frames by setting their `frameId` to the frame's id.

### Color reference

**Stroke colors:** #1e1e1e (black/default), #e03131 (red), #2f9e44 (green), #1971c2 (blue), #f08c00 (orange), #6741d9 (violet), #0c8599 (cyan), #e8590c (dark orange), #868e96 (gray)

**Pastel fills (good for shape backgrounds):** #a5d8ff (light blue), #b2f2bb (light green), #ffd8a8 (light orange), #d0bfff (light purple), #ffc9c9 (light red), #fff3bf (light yellow), #c3fae8 (light teal), #eebefa (light pink), #e5dbff (light violet)

### Layout tips

- Typical box: width 160, height 70
- Leave ~80px gaps between shapes
- Center labels inside shapes using `containerId` + `boundElements` binding
- Keep labels short (2–5 words) — text wraps to shape width
- For arrows: set x, y to the start point, compute width/height from the last point offset
- Arrow width = last point's x offset, height = last point's y offset (can be negative)

### Important notes

- The editor auto-heals many issues (null fields, missing indices). Don't over-validate.
- Always provide `id`, `type`, `x`, `y` at minimum. Width and height default to 0 if omitted.
- Use readable, descriptive ids — you'll reference them in bindings and future updates.
- Elements are merged by id: sending an element with an existing id replaces it entirely.
