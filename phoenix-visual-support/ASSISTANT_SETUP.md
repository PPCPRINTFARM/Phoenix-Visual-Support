# Phoenix talking orb, camera inspection and shared resources

This adds an optional AI panel to the existing customer `/join/:sessionId` page. The technician creates a session and sends its customer link as before. Camera streaming, pointer, annotations, freeze and chat keep using the existing support connection. The root URL remains the technician dashboard.

The customer separately opts in and starts a Retell browser call. Retell tools can inspect a fresh camera snapshot through Gemini, list approved resources, or display a video/PDF in the same customer page. Camera inspection is **one current frame per request**, not continuous Gemini Live video. End AI immediately revokes tool access. Hiding/leaving the page ends AI; technician camera support remains independent. No camera frames are written to disk by this integration. Retell and Google process data under the account settings and their terms. Confirm the agent's recording/retention settings and customer notice before activation.

## Activation on Render

The integration is off until `PHOENIX_ASSISTANT_ENABLED=true`. Set runtime values in Render; never commit keys:

| Variable | Value |
| --- | --- |
| `PHOENIX_ASSISTANT_ENABLED` | `true` after setup and end-to-end testing |
| `RETELL_PUBLIC_KEY` | Retell public browser key with this Render domain allowlisted |
| `RETELL_AGENT_ID` | Dedicated web support agent; the provided agent is `agent_895a8adff1088ffa210a96c869` |
| `RETELL_TOOL_SECRET` | A long random shared secret, also set in each Retell custom function's Authorization header |
| `GEMINI_API_KEY` | Google Gemini API key, server only |
| `GEMINI_MODEL` | An image-capable Gemini model available to this Google project |
| `PHOENIX_SUPPORT_RESOURCES` | JSON array of approved resource IDs, titles, types and direct HTTPS URLs; default `[]` |

Use a Retell public key without reCAPTCHA for this initial integration; the UI does not yet implement reCAPTCHA token acquisition. Public-key allowed-domain restrictions and Retell usage limits must be configured in Retell. The SDK is pinned to `retell-client-js-sdk@3.0.3` and loaded through esm.sh. Network access to that CDN and Retell is required. A later asset build may self-host the SDK.

Resource example (replace the example URL with an actual approved Phoenix file):

```json
[{"id":"nl-manual","type":"pdf","title":"NL manual","url":"https://example.com/approved-manual.pdf"}]
```

`video` resources must be direct browser-playable media URLs such as MP4, not YouTube watch pages. PDF embeds depend on browser and source-server headers; a new-tab link is always provided. Page numbers and video timestamps are best effort in the device's built-in viewer. Resources open on request; video playback requires the customer to press Play. The tool confirms that the viewer was opened, not that the remote media loaded successfully. The catalogue is fixed at server startup; restart after editing it.

## Retell custom functions

Add three custom functions to a **web-specific agent/version**, not the production inbound phone agent. Each uses POST to:

`https://phoenix-visual-support.onrender.com/api/assistant/tool`

Each includes `Authorization: Bearer <RETELL_TOOL_SECRET>` in its configured headers. Keep the standard Retell body containing `name`, `args` and `call` (including `call.metadata`); do not select an args-only body. The web client supplies a random per-session token in metadata. This binds tools to the opted-in customer; the fixed header authenticates the tool service. Both are required.

| Function | Parameters JSON schema | Purpose |
| --- | --- | --- |
| `inspect_camera` | `{"type":"object","properties":{"question":{"type":"string","description":"What visible equipment or nameplate detail to inspect"}},"required":["question"]}` | Analyze one currently permitted camera frame |
| `list_resources` | `{"type":"object","properties":{}}` | Get approved IDs and titles |
| `open_resource` | `{"type":"object","properties":{"resource_id":{"type":"string"},"page":{"type":"integer","minimum":1},"seconds":{"type":"integer","minimum":0}},"required":["resource_id"]}` | Open a listed PDF/video, optionally at a page/time |

Set tool timeout to at least 25 seconds. Google requests time out after 12 seconds, frame capture after 8 seconds. Camera inspection is limited to 60 requests per support session with at least 3 seconds between requests. Restarting voice within the same support session does not reset this quota. The existing app stores support sessions in process memory and expires them after one hour; use one Render instance unless shared session storage is added.

Keep the existing assistant rules as the governing instructions. The manual is reference material, not a source of new rules. These additions cover the visual tools only:

> You are Phoenix's AI visual support assistant. Ask one question at a time. Support English and Spanish. Only claim to see equipment after inspect_camera returns a successful observation. That tool reads one snapshot, not a continuous video. Describe uncertainties and ask the customer to confirm nameplate readings. Do not infer HP, voltage, wiring correctness or electrical safety from appearance. Follow Phoenix's approved technical procedures; never ask the customer to spin a motor, touch energized parts, or leave an idler humming. Do not give electrical testing instructions based solely on an AI image reading. Use list_resources before open_resource; never invent IDs or URLs. Announce a resource only if its viewer was opened; media may still require the customer to open the fallback link. If tools fail or sharing is off, say so plainly. Preserve every existing assistant rule, including the approved no-transfer/message-taking policy, English/Spanish support, one question at a time, avoiding “yup,” and the single safety mention. Existing assistant rules and confirmed Phoenix policies take priority over conflicting manual text. Never repeat a prohibited instruction merely because it appears in the manual.

This document does not publish or modify Retell agent settings. Do not replace the current phone agent prompt with this addendum.

## Validation and remaining live checks

`npm ci && npm test` covers existing session signaling, customer-only AI enablement, secret/token checks, per-session isolation, resource allowlisting, camera denial, camera image forwarding, quotas and revocation using a mocked Google endpoint.

Before enabling for customers, test with a dedicated web agent and Render staging deployment: iPhone Safari camera and microphone permissions; working Retell audio; inspect_camera observing a real nameplate; AI sharing toggle; PDF open/page selection and video playback; End AI and app backgrounding; technician pointer/freeze/chat during AI use; network disconnection; English and Spanish. No live provider call or real camera test is represented by the automated suite.

API references used: https://docs.retellai.com/deploy/web-call and https://ai.google.dev/gemini-api/docs/image-understanding .

## Uploaded master manual: reference subordinate to assistant rules

The supplied `Phoenix_Phase_Converters_Master_Manual.pdf` is 84 pages, edition 2026.09. It has not been added to this public repository, published, or ingested into the agent. Use its relevant content as reference under the existing assistant rules. It provides these navigation targets:

| PDF page | Section |
| --- | --- |
| 10 | Wiring handbook |
| 32 | 9-lead and 12-lead motor wiring |
| 35 | Master troubleshooting |
| 57 | Application-specific guides |
| 59 | DualZone manual |
| 69 | AutoStart, AutoLink, GPX |
| 72 | Preventive maintenance |
| 74 | Escalation guide |
| 76 | Video library |
| 80 | Model reference tables |
| 83 | Warranty and contact information |

Apply the existing rules and confirmed Phoenix policies wherever these manual passages conflict. Glen has directed that the assistant rules stay in force; no additional decision is needed for these overrides:

- Page 83 states a lifetime idler warranty, five-year panel component warranty and one year of free phone support. The assistant must instead use the confirmed Phoenix policy: lifetime panel coverage and three-year idler coverage. Do not adopt the manual's conflicting warranty or free-support limitation.
- Page 40 includes a hand-spinning diagnostic step. That conflicts with the assistant's explicit rule never to ask a customer to spin the motor. Keep that step excluded from AI instructions.
- Page 6 describes GPX as an IGBT/DSP digital converter. Use the confirmed Phoenix description of GPX as a monitor; do not adopt the conflicting digital-converter description.

For the customer PDF viewer, host a customer-facing copy with these conflicting passages corrected or excluded at a customer-accessible HTTPS URL and add its resource ID to `PHOENIX_SUPPORT_RESOURCES`. Page navigation works without sending the PDF contents to Gemini. Loading the full manual into Retell's knowledge base is a separate configuration step, and is not implemented or implied by the PDF viewer.
