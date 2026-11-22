# Automatic launch names

New launches without an explicit name can receive a topic title asynchronously.
The normal fallback remains usable immediately. Historical sessions and ongoing
turns are never submitted. Explicit template, task and caller names are preserved.

The existing Dispatch AI master switch and saved routing API key apply. Routing,
steering and merge-risk feature switches are independent of the Session naming
checkbox. Session naming must be enabled; existing installations with no saved
choice start off. First API-key setup enables it alongside the other features.
Turning Dispatch AI off or removing the key suspends naming while retaining its
saved preference.
With AI disabled or no saved key there is no request. Each eligible launch has
at most one Responses request, with no retries, using gpt-6-luna, store:false,
no tools, low reasoning effort and at most 128 output tokens. This is a separately
billed API call, not CLI subscription usage; cost depends on input and returned
tokens and the provider's current model rates. No provider response or launch
context is logged by the naming client.

Only supplied plain text reaches OpenAI: user launch prompt, supplied URLs stripped
of credentials/query/fragment, and text-upload excerpts already available in
memory. URLs embedded in text get the same stripping. No URL is fetched, no
binary extraction runs, and filenames, local paths, agent settings and credentials
are not added. User-provided text may itself contain private material: the
existing AI master switch controls this disclosure. The context is explicitly
identified as untrusted data in separate system instructions.

Limits are in JavaScript string characters: prompt first, up to 4,000; supplied
links next in launch order, up to 500 each; plain-text documents last in upload
order, up to 2,000 each. The aggregate content budget is 10,000 characters,
plus two newline separators between retained pieces. Document decoding examines
at most 8,000 UTF-8 bytes per document. Later pieces are truncated or omitted
when the budget runs out. The current launch contract supplies raw URL strings;
link labels and fetched preview/title metadata are not available on that path.

The database records a request claim before network I/O. Duplicate invocations
cannot generate a second request. Every normal rename increments a title
revision, even when the name is unchanged. Generated titles write only at
revision zero, so a user edit or rename_session wins against a late response.
Normal and automatic naming share title persistence; generated names publish
through the existing agent event bus. Errors, timeouts, disabled configuration
and invalid/empty output leave the fallback untouched. There is no background
retry or recovery on restart.

Names use strict JSON Schema structured output: only a required `title` string,
3–5 words separated by single spaces, at most 40 Unicode characters including
spaces. The prompt aims for 32 characters or fewer. Application validation
independently enforces that shape, word count and character cap; overlong or
malformed results leave the fallback unchanged instead of being truncated.
The 128-token API output budget includes reasoning and JSON, not just title text.
