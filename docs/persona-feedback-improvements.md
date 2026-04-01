# Persona Feedback UX Improvements

Collected 2026-04-01. Items to be filed as Linear tickets.

## Layout / Styling Fixes

### Fix filename overflow in sidebar feedback
The feedback filename gets clipped on the right and bleeds outside its container in the sidebar. Should truncate from the left (ellipsis on the left side) so the end of the filename is always visible, matching how branch and worktree names are already handled in the sidebar agent details.

### Sticky header/footer in feedback sheet
When feedback content is long (e.g. large code suggestions), the footer with action buttons gets pushed off screen. The header and footer should be sticky/fixed, with only the content area scrolling on overflow.

## Sidebar Simplification

### Remove suggestion from sidebar feedback view
The sidebar feedback view shows too much info. Remove the suggestion field from that view — it can be seen in the full sheet view instead.

## Sheet View Enhancements

### Auto-advance to next item on fix/dismiss
When marking a feedback item as fixed or dismissed in the sheet view, it should automatically slide out the current item and slide in the next one. This matches the existing sidebar behavior where resolving an item auto-opens the next.

### Show agent attribution with persona color
The feedback sheet view should display which persona agent submitted the feedback, using the same color associated with that persona in the launch persona dropdown for visual consistency.

### Render markdown in feedback sheet
Agents submit feedback in markdown format but it's displayed as raw text. Render the markdown (description and suggestion fields) in the feedback sheet view for better readability.

### Add next/prev navigation buttons
Add next and previous buttons to the feedback sheet so you can scan through feedback items without having to resolve or close the current one first.

## Organization / Attribution

### Group feedback by subagent
When multiple persona subagents submit feedback, the items all blend into one flat list with no attribution. They should be segmented/grouped by the subagent that provided them so you have context about which persona the feedback came from.

## New Feature

### Add feedback tab to agent history page
Include feedback items and their resolutions (fixed/dismissed) in the agent history page as a new tab after the existing media tab.
