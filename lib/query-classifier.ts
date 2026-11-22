/** Query/prompt classifier predicates used by Sherpa retrieval planning and curation. */

export function isCodePrompt(focus: string) {
  return /\b(fix|bug|implement|refactor|test|typecheck|lint|compile|failing|error|exception|stack|function|class|api|route|service|schema|repository|component|hook|module|typescript|javascript|python|sql)\b/i.test(focus);
}

export function isSourceLookupPrompt(focus: string) {
  return /\b(where|which file|what file|implemented|implementation|tested|test covers|exact files?|function names?|code generates|served|stored|configured|connects|downloads|display)\b/i.test(focus);
}

export function isTraceLogMetricsPrompt(focus: string): boolean {
  return /\b(logs?|trace|traces|tracing|metrics?|perf(?:ormance)?|dspy|bundle|bundles|persist(?:ed|ence)?|stored|storage)\b/i.test(focus);
}

export function isPiSherpaMetaDebugPrompt(focus: string): boolean {
  return /\b(?:pi[-\s]?sherpa|sherpa_request_context|sherpa_memory_search|sherpa_session_search|sherpa)\b/i.test(focus)
    && /\b(?:performance|health|trace|traces|tracing|retrieval|evaluation|evaluations|quality|logs?|metrics?|debug|diagnose|review|context|curation|persist(?:ed|ence)?|stored|storage|implementation|implemented|source|file|files)\b/i.test(focus);
}

export function allowsRepeatedMetaDebugContext(focus: string): boolean {
  return isPiSherpaMetaDebugPrompt(focus) || (isTraceLogMetricsPrompt(focus) && /\bsherpa\b/i.test(focus));
}
