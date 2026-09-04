## What's Changed
* Custom patch release: `dsh` (DeepSeek Harness) as a stream-native agent type driven over the Agent Client Protocol. Opt-in via Settings → Agent types; needs `DISPATCH_DSH_BIN` (absolute path) and a provider key (`DEEPSEEK_API_KEY` or `OPENAI_API_KEY`) in the server `.env`. Assistant text and tool calls render in the Chat tab; status and token usage come from the stream; prompts, messages, and personas reach the agent through the same path as other types.
* Adds the `agent_stream_events` table (additive), the `@agentclientprotocol/sdk` dependency, and an update-migrations manifest. Running dsh agents are resumed after a service restart on their stored session ids.


**Full Changelog**: https://github.com/selfcontained/dispatch/compare/v0.38.6...v0.38.7-dsh.1
