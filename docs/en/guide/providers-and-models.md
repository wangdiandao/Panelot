# Providers and models

Panelot connects directly to model services you configure. It does not proxy requests, supply shared keys, or make availability, pricing, or privacy commitments for those services.

## API types

Panelot supports two connection types:

- **OpenAI-compatible**: compatible streaming Chat Completions and tool-call formats.
- **Anthropic**: compatible streaming Messages and tool-call formats.

Names such as Gemini, DeepSeek, and Ollama are not separate API types. If a service provides an OpenAI-compatible layer, follow its documentation and create that connection type. Verification and real request results determine whether it works.

## Add and verify a connection

Select Add connection under Settings > Models and enter:

- **API type**: match the endpoint's actual protocol.
- **Name**: optional. The endpoint host is used when this is blank.
- **Base URL**: remote addresses require HTTPS, while loopback addresses can use HTTP. OpenAI-compatible endpoints often contain `/v1`, but proxies and cloud services may use another path.
- **API keys**: one per line. Panelot continues with the current usable key and tries later keys after authentication or rate-limit errors. It does not rotate for every request.
- **Model list**: when the endpoint cannot return models, enter exact model IDs manually, one per line.

Verify connection checks reachability, authentication, streaming, tool-call structure, and the model list. The browser may request access to the endpoint origin first.

After saving and enabling the connection, select a default model. Removing a connection leaves existing conversation text intact, but its models cannot be used for new requests.

## Compatibility options

OpenAI-compatible endpoints differ in details. Change a compatibility option only when service documentation or an error requires it. Options can omit the streaming usage field, read reasoning from `<think>` tags, allow one tool call at a time, omit the `system` role, or use `max_completion_tokens`.

Run verification again after a change and send a real request. Panelot stops on incomplete streams, unknown finish reasons, or tool calls it cannot parse. It does not present a partial response as complete.

Advanced settings support custom headers and JSON model metadata for capabilities and pricing. These fields are intended for users who understand the upstream API. Incorrect metadata can cause Panelot to send images, tools, or parameters the model does not support. Sensitive custom-header values are encrypted locally.

## Select a model

The global default applies to conversations configured to use the default model. You can choose another connection and model from the header or composer for upcoming tasks. Panelot remembers the recent choice for the next time that conversation opens. Historical messages retain the model that produced them.

When evaluating a model for browser work, check whether it can produce stable structured tool calls, accept required image input, hold the needed conversation and page context, and return a correct streaming finish signal.

A successful connection check does not prove that one model will handle a long task reliably. Test a small page before using it for important work.

## Model presets

Settings > Presets combines a connection and model with a system prompt, generation parameters, allowed tool scope, default permission mode, and default Skills.

Presets can separate pure chat, page research, and remote-tool scenarios. Removing a preset does not remove existing conversations, but it cannot be selected for a new task. A Plugin preset is read-only and must be copied before editing.

The background-task model is used for low-cost work such as titles. When blank, it follows the default model. It is not a separate chat model, and not every auxiliary feature necessarily uses it.

## Common errors

- **Invalid or unauthorized API key**: confirm the key can use the selected API and model.
- **Model not found**: select an ID the endpoint actually provides or enter it manually.
- **Network error**: check the network, proxy, base URL, and browser access for the endpoint origin.
- **Protocol mismatch**: verify the connection type and compatibility options instead of relying on a vendor's compatibility label.
- **Context too long**: remove references, reduce history, or create a conversation. Panelot does not silently delete history.

See [Providers](../development/providers.md) for implementation contracts.
