## What's Changed
* Retry a turn that failed on a passing error by @selfcontained in https://github.com/selfcontained/dispatch/pull/1094
* Sidebar: derived agent activity and the stream's avatar by @selfcontained in https://github.com/selfcontained/dispatch/pull/1095
* fix(stream): serve a post's file from the agent that owns it by @selfcontained in https://github.com/selfcontained/dispatch/pull/1096
* Fold sent-to posts to one line; delivery state from DeliveryMeta by @selfcontained in https://github.com/selfcontained/dispatch/pull/1097
* feat(drawer): resize the right drawer from its left edge, one width for the client by @selfcontained in https://github.com/selfcontained/dispatch/pull/1098
* feat(runtime): posts queued behind a turn reach the agent as one prompt by @selfcontained in https://github.com/selfcontained/dispatch/pull/1100
* fix(models): an open picker hears when an engine teaches a new model list by @selfcontained in https://github.com/selfcontained/dispatch/pull/1102
* fix(engines): drive the CLI a person installed, and say which one by @selfcontained in https://github.com/selfcontained/dispatch/pull/1103
* perf(web): stop re-rendering what a stream update does not change by @selfcontained in https://github.com/selfcontained/dispatch/pull/1104
* feat(stream): the workspace shows its steps, and a dev stack can replay it by @selfcontained in https://github.com/selfcontained/dispatch/pull/1105
* fix(stream): an archived agent keeps its name; a turn cut by archiving reads as stopped by @selfcontained in https://github.com/selfcontained/dispatch/pull/1101
* feat(stream): a turn with nothing to say yet is a status line, not a post by @selfcontained in https://github.com/selfcontained/dispatch/pull/1106
* refactor(web): the step list is StepList, the sidebar tab is Inbox by @selfcontained in https://github.com/selfcontained/dispatch/pull/1107
* feat(sidebar): a working agent's row leads to its running turn by @selfcontained in https://github.com/selfcontained/dispatch/pull/1108
* feat(drawer): resize to all but an edge gutter, and slide shut on close by @selfcontained in https://github.com/selfcontained/dispatch/pull/1109
* Surface ACP slash commands in chat composer by @selfcontained in https://github.com/selfcontained/dispatch/pull/1111
* Use ACP turn activity in sidebar and retire legacy agent events by @selfcontained in https://github.com/selfcontained/dispatch/pull/1112
* Type files from their bytes; lay out a post's images as a gallery by @selfcontained in https://github.com/selfcontained/dispatch/pull/1113
* Place launched agent live activity below card content by @selfcontained in https://github.com/selfcontained/dispatch/pull/1114
* Clarify asynchronous reviewer handoff after launch by @selfcontained in https://github.com/selfcontained/dispatch/pull/1115
* fix(web): sidebar turn activity matches the running turn by @selfcontained in https://github.com/selfcontained/dispatch/pull/1116
* fix(acp): recover when an agent host journal is recreated by @selfcontained in https://github.com/selfcontained/dispatch/pull/1117
* Render internal prompts as ordinary agent turns by @selfcontained in https://github.com/selfcontained/dispatch/pull/1118
* Fix stream flash and idle scrollbar movement by @selfcontained in https://github.com/selfcontained/dispatch/pull/1119
* Add Delete and Send now controls for queued ACP messages by @selfcontained in https://github.com/selfcontained/dispatch/pull/1120
* Drop the chat empty prompt from agent streams by @selfcontained in https://github.com/selfcontained/dispatch/pull/1121
* Show model display name in the sidebar; nestle the diff badge by @selfcontained in https://github.com/selfcontained/dispatch/pull/1122
* Mute a turn's in-progress text so the final reply stands out by @selfcontained in https://github.com/selfcontained/dispatch/pull/1123
* Open the mobile sidebar when no agent is selected by @selfcontained in https://github.com/selfcontained/dispatch/pull/1124
* Fix Create Agent preferences, directory picker, and icon recall by @selfcontained in https://github.com/selfcontained/dispatch/pull/1125
* Reduce agent-switch latency from oversized settled turn activity by @selfcontained in https://github.com/selfcontained/dispatch/pull/1126
* Show attachments an agent posts mid-turn inside the turn by @selfcontained in https://github.com/selfcontained/dispatch/pull/1127
* Show late ACP turn text in the answer and Copy message by @selfcontained in https://github.com/selfcontained/dispatch/pull/1128
* feat(acp): switch a running agent's model, record usage, show plan limits by @selfcontained in https://github.com/selfcontained/dispatch/pull/1129
* fix(web): center diff count in badge by @selfcontained in https://github.com/selfcontained/dispatch/pull/1130
* Fix stream shifting while typing in the composer by @selfcontained in https://github.com/selfcontained/dispatch/pull/1131
* Restore ACP launch guidance and reliable naming requests by @selfcontained in https://github.com/selfcontained/dispatch/pull/1132
* Unify composer actions in a Slack-style toolbar by @selfcontained in https://github.com/selfcontained/dispatch/pull/1133
* Use full-width stream content and restore composer focus shortcut by @selfcontained in https://github.com/selfcontained/dispatch/pull/1134
* Expose remaining provider usage through agent MCP by @selfcontained in https://github.com/selfcontained/dispatch/pull/1135
* Preserve agent hosts across update recovery paths by @selfcontained in https://github.com/selfcontained/dispatch/pull/1136
* Support restricted ACP agents with permission approvals by @selfcontained in https://github.com/selfcontained/dispatch/pull/1137
* Improve resource metrics, artifact storage, and system memory visibility by @selfcontained in https://github.com/selfcontained/dispatch/pull/1138
* Fix browser feedback delivery for the ACP runtime by @selfcontained in https://github.com/selfcontained/dispatch/pull/1139
* Clean up settings and add customizable user avatars by @selfcontained in https://github.com/selfcontained/dispatch/pull/1140
* Fix Claude sign-in detection under Bun on macOS by @selfcontained in https://github.com/selfcontained/dispatch/pull/1141
* Use a unique migration number for launch guidance cleanup by @selfcontained in https://github.com/selfcontained/dispatch/pull/1143
* Render Markdown in user posts and thread replies by @selfcontained in https://github.com/selfcontained/dispatch/pull/1142
* Deliver messages into active agent turns by default by @selfcontained in https://github.com/selfcontained/dispatch/pull/1144
* Add colored @mention badges to chat and composer by @selfcontained in https://github.com/selfcontained/dispatch/pull/1146
* Fix upgrade from the old launch guidance migration name by @selfcontained in https://github.com/selfcontained/dispatch/pull/1147
* Show quiet, correlated message pickup receipts by @selfcontained in https://github.com/selfcontained/dispatch/pull/1145
* Keep stream placement separate from agent recipients by @selfcontained in https://github.com/selfcontained/dispatch/pull/1148
* Improve live agent replies and sidebar activity by @selfcontained in https://github.com/selfcontained/dispatch/pull/1149
* Place sidebar project icon after its name by @selfcontained in https://github.com/selfcontained/dispatch/pull/1150
* Fix mention badge sizing, spacing, and contrast by @selfcontained in https://github.com/selfcontained/dispatch/pull/1151
* Compact composer footer on mobile by @selfcontained in https://github.com/selfcontained/dispatch/pull/1153
* Restore OpenCode agents through native ACP by @selfcontained in https://github.com/selfcontained/dispatch/pull/1154
* Make agent replies discoverable with conversation-aware delivery and interruption by @selfcontained in https://github.com/selfcontained/dispatch/pull/1156
* Make composer Stop target active agent turns by @selfcontained in https://github.com/selfcontained/dispatch/pull/1155
* Fix review notifications and add on-demand review retrieval by @selfcontained in https://github.com/selfcontained/dispatch/pull/1157
* Compact the mobile stream composer and heading by @selfcontained in https://github.com/selfcontained/dispatch/pull/1158
* Keep chat messages full width and improve delivery receipts by @selfcontained in https://github.com/selfcontained/dispatch/pull/1159
* Move the activity quiet clock off the summary line by @selfcontained in https://github.com/selfcontained/dispatch/pull/1160
* Let Send now interrupt the turn a queued message is waiting behind by @selfcontained in https://github.com/selfcontained/dispatch/pull/1161
* Render task list item text as Markdown by @selfcontained in https://github.com/selfcontained/dispatch/pull/1162
* Guide agents to share long plans as markdown files by @selfcontained in https://github.com/selfcontained/dispatch/pull/1163
* Tell agents plainly when a user dismisses their question or form by @selfcontained in https://github.com/selfcontained/dispatch/pull/1164
* Let agents move their workspace mid-session by @selfcontained in https://github.com/selfcontained/dispatch/pull/1165
* Bump ACP adapters: claude-agent-acp 0.84.0, codex-acp 2.0.1 by @selfcontained in https://github.com/selfcontained/dispatch/pull/1166
* Show ACP session notices and context compactions in the turn trace by @selfcontained in https://github.com/selfcontained/dispatch/pull/1167
* Route reviews to code owner personas by @selfcontained in https://github.com/selfcontained/dispatch/pull/1168
* Add macOS menu app with managed database and automatic updates by @selfcontained in https://github.com/selfcontained/dispatch/pull/1152
* Clarify Mac app update instructions by @selfcontained in https://github.com/selfcontained/dispatch/pull/1169
* macOS app: release identity, post-update notification, named processes by @selfcontained in https://github.com/selfcontained/dispatch/pull/1171
* Tell each recipient of a fanned-out post who else got it by @selfcontained in https://github.com/selfcontained/dispatch/pull/1170
* Offer code owner reviews from the launch review dialog by @selfcontained in https://github.com/selfcontained/dispatch/pull/1173
* Release Mac and Linux from one tag with preview and stable channels by @selfcontained in https://github.com/selfcontained/dispatch/pull/1172
* Reserve the sidebar card's status line so turns don't shift layout by @selfcontained in https://github.com/selfcontained/dispatch/pull/1175
* Add managed HTTPS and in-app device trust setup for Mac Dispatch by @selfcontained in https://github.com/selfcontained/dispatch/pull/1174
* Load historical thread activity details on demand by @selfcontained in https://github.com/selfcontained/dispatch/pull/1176
* Remove the ambient tips bar under the composer by @selfcontained in https://github.com/selfcontained/dispatch/pull/1177
* Allow unified preview releases from acp-runtime by @selfcontained in https://github.com/selfcontained/dispatch/pull/1178


**Full Changelog**: https://github.com/selfcontained/dispatch/compare/v0.38.16...v1.0.0
