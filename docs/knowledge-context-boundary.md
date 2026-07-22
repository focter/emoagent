# Knowledge Context Boundary

This project has two separate safety and knowledge paths:

1. Existing runtime safety routing in `server/safety.js`.
2. Read-only knowledge context diagnostics from `src/knowledge`.

The existing runtime safety routing remains authoritative for formal replies. Knowledge context must not replace it.

## Default Behavior

All new knowledge context behavior is disabled unless explicitly enabled with environment variables.

```env
KNOWLEDGE_CONTEXT_ENABLED=false
KNOWLEDGE_CONTEXT_DEBUG=false
KNOWLEDGE_CONTEXT_PROMPT_ENABLED=false
```

When disabled, `/api/chat` and `/api/chat-stream` must not compute the new knowledge context and must not add debug output.

## Debug Behavior

When `KNOWLEDGE_CONTEXT_ENABLED=true` and `KNOWLEDGE_CONTEXT_DEBUG=true`, API responses may include:

```json
{
  "debug": {
    "knowledgeContextEnabled": true,
    "knowledgeContextDebug": true,
    "knowledgeContextPromptEnabled": false,
    "knowledgeContextPromptInjected": false,
    "knowledgeContextBoundary": "context_ready_ordinary_allowed",
    "knowledgeContextSummary": {},
    "knowledgeContext": {}
  }
}
```

Context errors are reported only as short debug strings. They must not fail the chat response.

## Prompt Injection Behavior

`KNOWLEDGE_CONTEXT_PROMPT_ENABLED=true` is a separate opt-in gate. Prompt injection requires all of:

- `KNOWLEDGE_CONTEXT_ENABLED=true`
- `KNOWLEDGE_CONTEXT_PROMPT_ENABLED=true`
- context exists
- `generation_constraints.ordinary_interventions_allowed=true`

High or critical knowledge context never injects ordinary context into the model prompt.

## High-Risk Boundary

If existing runtime safety routing detects risk, safety response generation remains authoritative.

If read-only knowledge context detects `high` or `critical`, the context may appear in debug output, but it must not:

- replace the reply
- override existing safety routing
- enable ordinary interventions
- inject ordinary context into the prompt

This boundary is enforced by integration evals.

## Prompt Boundary Evals

Prompt injection behavior is verified by:

```bash
npm run eval:knowledge:prompt-boundary
```

The eval checks that:

- default-disabled mode does not return prompt injection debug state
- debug-only mode may return context but does not inject prompt context
- low or medium risk context may inject only when `KNOWLEDGE_CONTEXT_PROMPT_ENABLED=true`
- high or critical context never injects prompt context
- formal safety routing is not replaced by knowledge context

## Why High / Critical Context Is Not Injected

High and critical contexts are safety-sensitive. Injecting ordinary issue, mechanism, or intervention context into the model prompt can make the model mix crisis handling with self-help advice. The system therefore treats high and critical context as diagnostic-only. Existing `server/safety.js` routing remains the formal reply authority.

## Debug Panel Boundary

The frontend Knowledge debug panel is a development diagnostic surface only. It is shown only when the backend returns debug fields. It is not intended for ordinary users and must not persist debug data to `sessionStorage` or include it in later chat requests.

## Authority Boundary

Knowledge context is not safety routing authority. It can summarize matcher output, show risk signals, and support controlled low-risk prompt experiments. It must not:

- override `server/safety.js`
- authorize ordinary interventions for high or critical context
- replace crisis routing
- act as a clinical diagnosis
