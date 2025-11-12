import { countTokens } from 'gpt-tokenizer';
import type { AssistantRequestItem } from '../../common/ai/assistant-client.ts';

export const CONTEXT_WINDOW_TOKENS = 190_000;

const stringify = (value: unknown): string | null => {
    if (value === null || value === undefined) {
        return null;
    }

    if (typeof value === 'string') {
        return value;
    }

    if (typeof value === 'number' || typeof value === 'boolean') {
        return String(value);
    }

    try {
        return JSON.stringify(value);
    } catch (error) {
        console.warn('Unable to serialize value for token counting', error);
        return null;
    }
};

const extractSegments = (item: AssistantRequestItem): string[] => {
    if (!item) {
        return [];
    }

    const segments: string[] = [];

    if (typeof (item as { content?: unknown }).content === 'string') {
        segments.push((item as { content: string }).content);
        return segments;
    }

    const maybeContent = (item as { content?: unknown }).content;
    if (Array.isArray(maybeContent)) {
        for (const entry of maybeContent) {
            if (!entry) {
                continue;
            }
            if (typeof entry === 'string') {
                segments.push(entry);
            } else if (typeof entry.text === 'string') {
                segments.push(entry.text);
            }
        }
    }

    if (typeof (item as { output?: unknown }).output === 'string') {
        segments.push((item as { output: string }).output);
    }

    if (typeof (item as { arguments?: unknown }).arguments === 'string') {
        const callName = typeof (item as { name?: unknown }).name === 'string' ? `${(item as { name: string }).name}\n` : '';
        segments.push(`${callName}${(item as { arguments: string }).arguments}`);
    }

    if (Array.isArray((item as { summary?: Array<{ text?: string }> }).summary)) {
        for (const summary of (item as { summary: Array<{ text?: string }> }).summary) {
            if (summary?.text) {
                segments.push(summary.text);
            }
        }
    }

    if (!segments.length) {
        const serialized = stringify(item);
        if (serialized) {
            segments.push(serialized);
        }
    }

    return segments;
};

const countTokensForItem = (item: AssistantRequestItem): number => {
    const segments = extractSegments(item);
    if (!segments.length) {
        return 0;
    }

    let total = 0;
    for (const segment of segments) {
        if (!segment) {
            continue;
        }
        total += countTokens(segment);
    }
    return total;
};

export const calculateContextTokenUsage = (history: AssistantRequestItem[]): {
    tokens: number;
    limit: number;
    percent: number;
} => {
    const tokens = history.reduce((sum, item) => sum + countTokensForItem(item), 0);
    const limit = CONTEXT_WINDOW_TOKENS;
    const percent = limit === 0 ? 0 : Math.min(100, (tokens / limit) * 100);
    return {
        tokens,
        limit,
        percent
    };
};
