Grade the response on whether it recognizes that structured comparison plus
user input belongs in an agent-authored surface.

**Pass criteria:**

1. It calls `dispatch_surface_create`, rather than only describing a possible
   surface.
2. The surface includes a compact comparison of the two rollout plans using a
   table or similarly structured blocks.
3. It provides a durable form that combines a required rollout choice with an
   optional text/textarea explanation. An action labeled "Add explanation"
   without an input field does not satisfy this criterion.
4. IDs and action intents are stable, descriptive strings rather than generated
   prose.
5. It does not create a kanban/board abstraction or reduce the whole interaction
   to shortcut pins.

**Do not penalize:** also pinning the resulting tab or summarizing it briefly in
chat. A pin may complement the surface; it must not be the only interaction.

Score 1.0 when all five criteria hold, 0.5 when it creates a surface but omits
either structured comparison or durable input, and 0.0 when it only uses chat or
pins.
